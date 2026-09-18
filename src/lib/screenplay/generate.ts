import { z } from "zod";
import {
  applyWrites,
  emptyStage,
  modelProducer,
  newRecord,
  newRunId,
  nowIso,
  readDigest,
  readJson,
  removeFile,
  type StageFile,
  serialize,
  sha256Of,
  stageFileSchema,
  toWorkspacePath,
  type WriteMode,
  writeNew,
} from "../artifact/index.js";
import { readStage0Inputs, type Stage0Inputs } from "../project/index.js";
import { err, ok, type Result } from "../result.js";
import {
  type EpisodePaths,
  episodePaths,
  projectPaths,
  type RunPaths,
  runPaths,
  type Workspace,
} from "../workspace.js";
import {
  buildRequest,
  callModel,
  ENDPOINT,
  httpFailure,
  readScreenplay,
  refusedWithoutCharge,
} from "./client.js";
import { buildPrompt, PROMPT_VERSION } from "./prompt.js";
import { minimumScenes, type ScreenplayVerdict, validateScreenplay } from "./validate.js";

/**
 * Internal to the screenplay module: the one command that spends money.
 *
 * The order of operations is the contract. Nothing is written in `--dry-run`.
 * In a real run the stage file records `submitted` *before* the POST, so an
 * interrupted attempt leaves a trace that says a charge may have happened,
 * rather than looking like it never ran. Nothing retries on its own.
 */

const ARTIFACT = "screenplay";

export interface ScreenplayReport {
  /** Whether stage 0 is approved for this project and episode. */
  readonly approved: boolean;
  readonly created: readonly string[];
  readonly minimumScenes: number;
  readonly nextStep: string;
  readonly problems: readonly string[];
  /** `--dry-run` only: the exact text a paid call would send. */
  readonly prompt: string | null;
  readonly ready: boolean;
  readonly runId: string | null;
  readonly verdict: ScreenplayVerdict | null;
}

interface GenerateInput {
  readonly apiKey: string | null;
  readonly episodeId: string;
  readonly fetch: typeof fetch;
  readonly maxOutputTokens: number;
  readonly mode: WriteMode;
  readonly model: string | null;
  readonly projectId: string;
  readonly regenerate: boolean;
  readonly workspace: Workspace;
}

class Stage1BlockedError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `etap 1 nie może wykonać płatnego wywołania:\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "Stage1BlockedError";
    this.problems = problems;
  }
}

class LockError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(
      `inna próba trzyma blokadę ${path} — po awarii upewnij się, że poprzedni proces nie działa, zanim usuniesz ten plik`
    );
    this.name = "LockError";
    this.path = path;
  }
}

function write(path: string, text: string): Promise<Result<readonly string[]>> {
  return applyWrites([{ kind: "text", text, to: path }], "apply");
}

/**
 * Why a paid call may not happen. Empty means it may.
 *
 * A dry run never reads the key, so it must not claim the key is missing — it
 * says what it did not check instead. Claiming to have found an absence you
 * never looked for is the same lie as claiming a success you never had.
 */
function blockers(input: GenerateInput, stage0: Stage0Inputs): readonly string[] {
  const problems = [...(stage0.approved ? [] : stage0.problems)];

  if (!stage0.approved) {
    problems.push(
      `etap 0 musi mieć review.status = "approved" zanim etap 1 wyda pieniądze: aimator approve ${input.projectId}`
    );
  }

  if (input.model === null || input.model === "") {
    problems.push(
      "brak modelu tekstowego — wskaż go przez --model <id> albo AIMATOR_SCREENPLAY_MODEL"
    );
  }

  if (input.mode !== "dry-run" && (input.apiKey === null || input.apiKey === "")) {
    problems.push("brak OPENAI_API_KEY w środowisku lub .env");
  }

  return problems;
}

function stageFile(record: StageFile["artifacts"][string]): string {
  return serialize({ ...emptyStage(ARTIFACT), artifacts: { [ARTIFACT]: record } });
}

export async function generateScreenplay(input: GenerateInput): Promise<Result<ScreenplayReport>> {
  const project = projectPaths(input.workspace, input.projectId);

  if (!project.ok) {
    return project;
  }

  const paths = episodePaths(project.data, input.episodeId);

  if (!paths.ok) {
    return paths;
  }

  const stage0 = await readStage0Inputs({
    episodeId: input.episodeId,
    projectId: input.projectId,
    workspace: input.workspace,
  });

  if (!stage0.ok) {
    return stage0;
  }

  const prompt = buildPrompt({
    aspectRatio: stage0.data.aspectRatio,
    rules: stage0.data.rules,
    settings: stage0.data.settings,
    source: stage0.data.source,
  });
  const problems = blockers(input, stage0.data);
  const required = minimumScenes(stage0.data.settings.durationSeconds);

  if (input.mode === "dry-run") {
    return ok({
      approved: stage0.data.approved,
      created: [],
      minimumScenes: required,
      nextStep:
        problems.length === 0
          ? `aimator screenplay generate ${input.projectId} ${input.episodeId}`
          : "usuń powyższe przeszkody przed płatnym wywołaniem",
      problems,
      prompt,
      ready: problems.length === 0,
      runId: null,
      verdict: null,
    });
  }

  if (problems.length > 0) {
    return err(new Stage1BlockedError(problems));
  }

  const lock = await writeNew(
    paths.data.screenplayLock,
    serialize({ pid: process.pid, startedAt: nowIso() })
  );

  if (!lock.ok) {
    return err(new LockError(paths.data.screenplayLock));
  }

  try {
    return await attempt(input, paths.data, stage0.data, prompt, required);
  } finally {
    await removeFile(paths.data.screenplayLock);
  }
}

async function attempt(
  input: GenerateInput,
  paths: EpisodePaths,
  stage0: Stage0Inputs,
  prompt: string,
  required: number
): Promise<Result<ScreenplayReport>> {
  const previousStage = await readJson(paths.screenplayStage, stageFileSchema);
  const previous = await readDigest(paths.screenplay);
  const record = previousStage.ok ? previousStage.data.artifacts[ARTIFACT] : undefined;

  if (record !== undefined && !input.regenerate) {
    const resumed = await resume(input, paths, stage0, record, required);

    if (resumed !== null) {
      return resumed;
    }
  }

  const runId = newRunId();
  const run = runPaths(paths, runId);
  const model = input.model ?? "";
  const apiKey = input.apiKey ?? "";
  const request = buildRequest({ maxOutputTokens: input.maxOutputTokens, model, prompt });
  const producer = modelProducer({ endpoint: ENDPOINT, model, promptVersion: PROMPT_VERSION });

  const prepared = await prepare(run, {
    inputs: stage0.inputs,
    maxOutputTokens: input.maxOutputTokens,
    model,
    prompt,
    request: serialize(request),
    runId,
  });

  if (!prepared.ok) {
    return prepared;
  }

  // Submitted lands on disk before the POST. An attempt that dies mid-call is
  // then visibly an attempt that may already have been billed.
  await write(
    paths.screenplayStage,
    stageFile(
      newRecord({ inputs: stage0.inputs, outputs: [], producer, runId, status: "submitted" })
    )
  );

  const transport = await callModel({ apiKey, fetch: input.fetch, request });

  // Nothing reached the provider, so there is nothing to archive.
  if (!transport.ok) {
    return transport;
  }

  // Archived before it is judged. A refusal nobody can read is worse than the
  // refusal itself, and this stage promises the diagnostics are kept.
  await writeNew(run.transport, serialize(transport.data));
  await writeNew(run.response, transport.data.body);

  const refused = httpFailure(transport.data);

  if (refused !== null) {
    return err(refused);
  }

  return await publish(input, paths, run, {
    body: transport.data.body,
    inputs: stage0.inputs,
    minimumScenes: required,
    previous: previous.ok ? previous.data.bytes.toString("utf8") : null,
    producer,
    runId,
    settings: stage0.settings,
  });
}

/** Only the field that decides whether a rejected attempt can have been billed. */
const transportSchema = z.object({ httpStatus: z.number() });

/** The HTTP status an earlier attempt archived, or `null` if it archived none. */
async function archivedStatus(run: RunPaths): Promise<number | null> {
  const saved = await readJson(run.transport, transportSchema);

  return saved.ok ? saved.data.httpStatus : null;
}

/**
 * What to do with an attempt that already exists. `null` means "nothing —
 * go ahead and pay".
 *
 * A `submitted` record whose archive still holds the response is the case this
 * exists for: that answer is bought and paid for, so re-deriving a verdict from
 * it must cost nothing. Otherwise a bug in the validator would be billable, and
 * the first one was. This is not an automatic retry — nothing is sent.
 */
async function resume(
  input: GenerateInput,
  paths: EpisodePaths,
  stage0: Stage0Inputs,
  record: StageFile["artifacts"][string],
  required: number
): Promise<Result<ScreenplayReport> | null> {
  if (record.status === "completed") {
    return err(
      new Stage1BlockedError([
        `scenariusz dla tego odcinka już istnieje (${toWorkspacePath(input.workspace.root, paths.screenplay)})`,
        "zachowano poprzedni wynik; nową płatną próbę zaczyna wyłącznie --regenerate",
      ])
    );
  }

  const run = runPaths(paths, record.runId);
  const status = await archivedStatus(run);

  // The provider declined to do the work, so nothing was charged and there is
  // nothing to finish. Starting over is safe and needs no `--regenerate`:
  // demanding one would make a rejected request look like a paid one.
  if (status !== null && refusedWithoutCharge(status)) {
    return null;
  }

  const saved = await readDigest(run.response);

  // A 429 or a 5xx may have started work that was billed, so those keep the
  // rule that protects against paying twice.
  if (!saved.ok || (status !== null && status >= 400)) {
    return err(
      new Stage1BlockedError([
        `próba ${record.runId} zapisała status "submitted", ale nie ma z niej użytecznej odpowiedzi${status === null ? "" : ` (HTTP ${status})`} — mogła zostać rozliczona`,
        "wywołanie idzie ze store: false, więc nie ma zadania do odpytania; nową płatną próbę zaczyna wyłącznie --regenerate",
      ])
    );
  }

  // The saved answer was written for the inputs recorded beside it. Publishing
  // it against changed inputs would attach a result to a question nobody asked.
  const changed = record.inputs.filter(
    (entry) => !stage0.inputs.some((now) => now.path === entry.path && now.sha256 === entry.sha256)
  );

  if (changed.length > 0) {
    return err(
      new Stage1BlockedError([
        ...changed.map((entry) => `${entry.path}: zmienił się od czasu próby ${record.runId}`),
        "zapisana odpowiedź opisuje inne wejście — nową płatną próbę zaczyna --regenerate",
      ])
    );
  }

  return await publish(input, paths, run, {
    body: saved.data.bytes.toString("utf8"),
    inputs: stage0.inputs,
    minimumScenes: required,
    previous: null,
    producer: record.producer,
    runId: record.runId,
    settings: stage0.settings,
  });
}

async function prepare(
  run: RunPaths,
  data: {
    readonly inputs: Stage0Inputs["inputs"];
    readonly maxOutputTokens: number;
    readonly model: string;
    readonly prompt: string;
    readonly request: string;
    readonly runId: string;
  }
): Promise<Result<true>> {
  const written = await writeNew(run.prompt, data.prompt);

  if (!written.ok) {
    return written;
  }

  const request = await writeNew(run.request, data.request);

  if (!request.ok) {
    return request;
  }

  // The inputs are referenced, never copied: a run archive that duplicated
  // them would double every source file for every attempt.
  return await writeNew(
    run.run,
    serialize({
      endpoint: ENDPOINT,
      inputs: data.inputs,
      maxOutputTokens: data.maxOutputTokens,
      model: data.model,
      promptVersion: PROMPT_VERSION,
      runId: data.runId,
      stage: ARTIFACT,
      startedAt: nowIso(),
      status: "submitted",
    })
  );
}

async function publish(
  input: GenerateInput,
  paths: EpisodePaths,
  run: RunPaths,
  data: {
    readonly body: string;
    readonly inputs: Stage0Inputs["inputs"];
    readonly previous: string | null;
    readonly producer: ReturnType<typeof modelProducer>;
    readonly minimumScenes: number;
    readonly runId: string;
    readonly settings: Stage0Inputs["settings"];
  }
): Promise<Result<ScreenplayReport>> {
  const parsed = readScreenplay(data.body);

  if (!parsed.ok) {
    return parsed;
  }

  const verdict = validateScreenplay(parsed.data.text, data.settings);

  if (!verdict.ok) {
    await writeNew(
      run.validation,
      serialize({
        checkedAt: nowIso(),
        promptVersion: PROMPT_VERSION,
        reason: verdict.error.message,
        structuralValidation: "failed",
      })
    );

    return err(
      new Error(
        `${verdict.error.message}. Odpowiedź zachowano w ${toWorkspacePath(input.workspace.root, run.response)} — to błąd formatu wyniku, nie powód do --regenerate.`
      )
    );
  }

  await writeNew(
    run.validation,
    serialize({
      ...verdict.data,
      checkedAt: nowIso(),
      promptVersion: PROMPT_VERSION,
      structuralValidation: "passed",
    })
  );

  // The previous result is kept only when a regeneration replaces it.
  if (data.previous !== null) {
    await writeNew(run.previousScreenplay, data.previous);
  }

  const { jobId, text } = parsed.data;
  const outputs = [
    {
      path: toWorkspacePath(input.workspace.root, paths.screenplay),
      sha256: sha256Of(Buffer.from(text)),
    },
  ];

  await write(paths.screenplay, text);
  await write(
    paths.screenplayStage,
    stageFile(
      newRecord({
        inputs: data.inputs,
        jobId,
        outputs,
        producer: data.producer,
        runId: data.runId,
        status: "completed",
      })
    )
  );

  return ok({
    approved: false,
    created: [
      toWorkspacePath(input.workspace.root, paths.screenplay),
      toWorkspacePath(input.workspace.root, paths.screenplayStage),
      toWorkspacePath(input.workspace.root, run.root),
    ],
    minimumScenes: data.minimumScenes,
    nextStep: `oceń scenariusz, a potem: aimator approve ${input.projectId} ${input.episodeId} --stage screenplay`,
    problems: [],
    prompt: null,
    ready: true,
    runId: data.runId,
    verdict: verdict.data,
  });
}
