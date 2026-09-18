import { z } from "zod";
import {
  applyWrites,
  emptyStage,
  modelProducer,
  newRecord,
  newRunId,
  nowIso,
  type RecordedFile,
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
import type { CastMember, ShotListSettings } from "../project/index.js";
import { err, ok, type Result } from "../result.js";
import {
  buildRequest,
  callModel,
  ENDPOINT,
  httpFailure,
  readOutputText,
  refusedWithoutCharge,
} from "../text-model.js";
import { type RunPaths, runPaths, type Workspace } from "../workspace.js";
import { readStage3Inputs, type Stage3Inputs, type Stage3Paths } from "./plan.js";
import { PROMPT_VERSION } from "./prompt.js";
import { type ShotList, validateShotList } from "./validate.js";

/**
 * Internal to the shot-list module: the one command that spends money.
 *
 * The order of operations is the contract, and it is stage 1's: nothing is
 * written in `--dry-run`; in a real run the stage file records `submitted`
 * before the POST is sent, so an interrupted attempt leaves a trace saying a
 * charge may have happened rather than looking like it never ran; and nothing
 * retries on its own.
 */

const ARTIFACT = "shot-list";

export interface ShotListReport {
  /** Whether the screenplay this plan is drawn from carries an approval. */
  readonly approved: boolean;
  readonly created: readonly string[];
  readonly nextStep: string;
  readonly problems: readonly string[];
  /** `--dry-run` only: the exact text a paid call would send. */
  readonly prompt: string | null;
  readonly ready: boolean;
  readonly runId: string | null;
  readonly verdict: ShotList | null;
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

class Stage3BlockedError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `etap 3 nie może wykonać płatnego wywołania:\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "Stage3BlockedError";
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

function stageFile(record: StageFile["artifacts"][string]): string {
  return serialize({ ...emptyStage(ARTIFACT), artifacts: { [ARTIFACT]: record } });
}

/**
 * Why a paid call may not happen. Empty means it may.
 *
 * A dry run never reads the key, so it must not claim the key is missing — it
 * says what it did not check instead. Claiming to have found an absence you
 * never looked for is the same lie as claiming a success you never had.
 */
function blockers(input: GenerateInput, stage3: Stage3Inputs): readonly string[] {
  const problems = [...stage3.gate];

  if (input.model === null || input.model === "") {
    problems.push(
      "brak modelu tekstowego — wskaż go przez --model <id> albo AIMATOR_SHOTLIST_MODEL"
    );
  }

  if (input.mode !== "dry-run" && (input.apiKey === null || input.apiKey === "")) {
    problems.push("brak OPENAI_API_KEY w środowisku lub .env");
  }

  return problems;
}

export async function generateShotList(input: GenerateInput): Promise<Result<ShotListReport>> {
  const stage3 = await readStage3Inputs(input);

  if (!stage3.ok) {
    return stage3;
  }

  const problems = blockers(input, stage3.data);

  if (input.mode === "dry-run") {
    return ok({
      approved: stage3.data.gate.length === 0,
      created: [],
      nextStep:
        problems.length === 0
          ? `aimator shot-list generate ${input.projectId} ${input.episodeId}`
          : "usuń powyższe przeszkody przed płatnym wywołaniem",
      problems,
      prompt: stage3.data.prompt,
      ready: problems.length === 0,
      runId: null,
      verdict: null,
    });
  }

  if (problems.length > 0) {
    return err(new Stage3BlockedError(problems));
  }

  const { paths } = stage3.data;
  const lock = await writeNew(
    paths.episode.shotListLock,
    serialize({ pid: process.pid, startedAt: nowIso() })
  );

  if (!lock.ok) {
    return err(new LockError(paths.episode.shotListLock));
  }

  try {
    return await attempt(input, stage3.data);
  } finally {
    await removeFile(paths.episode.shotListLock);
  }
}

/** Everything `publish` needs that is not already in the scope. */
interface Publication {
  readonly body: string;
  readonly cast: readonly CastMember[];
  readonly inputs: readonly RecordedFile[];
  readonly previous: string | null;
  readonly producer: ReturnType<typeof modelProducer>;
  readonly runId: string;
  readonly screenplay: string;
  readonly settings: ShotListSettings;
}

async function attempt(
  input: GenerateInput,
  stage3: Stage3Inputs
): Promise<Result<ShotListReport>> {
  const { paths } = stage3;
  const previousStage = await readJson(paths.episode.shotListStage, stageFileSchema);
  const previous = await readDigest(paths.episode.shotList);
  const record = previousStage.ok ? previousStage.data.artifacts[ARTIFACT] : undefined;

  if (record !== undefined && !input.regenerate) {
    const resumed = await resume(input, stage3, record);

    if (resumed !== null) {
      return resumed;
    }
  }

  // The gate already refused a null prompt, so these are decided by now.
  const { screenplay, settings } = stage3;
  const prompt = stage3.prompt ?? "";

  if (settings === null || screenplay === null) {
    return err(new Stage3BlockedError(stage3.gate));
  }

  const runId = newRunId();
  const run = runPaths(paths.episode, runId);
  const model = input.model ?? "";
  const apiKey = input.apiKey ?? "";
  const request = buildRequest({ maxOutputTokens: input.maxOutputTokens, model, prompt });
  const producer = modelProducer({ endpoint: ENDPOINT, model, promptVersion: PROMPT_VERSION });

  const prepared = await prepare(run, {
    inputs: stage3.inputs,
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
    paths.episode.shotListStage,
    stageFile(
      newRecord({ inputs: stage3.inputs, outputs: [], producer, runId, status: "submitted" })
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
    cast: stage3.cast,
    inputs: stage3.inputs,
    previous: previous.ok ? previous.data.bytes.toString("utf8") : null,
    producer,
    runId,
    screenplay,
    settings,
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
 * it must cost nothing. Otherwise a bug in the validator would be billable.
 * This is not an automatic retry — nothing is sent.
 */
async function resume(
  input: GenerateInput,
  stage3: Stage3Inputs,
  record: StageFile["artifacts"][string]
): Promise<Result<ShotListReport> | null> {
  const { paths } = stage3;

  if (record.status === "completed") {
    return err(
      new Stage3BlockedError([
        `lista ujęć dla tego odcinka już istnieje (${toWorkspacePath(input.workspace.root, paths.episode.shotList)})`,
        "zachowano poprzedni wynik; nową płatną próbę zaczyna wyłącznie --regenerate",
      ])
    );
  }

  const run = runPaths(paths.episode, record.runId);
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
      new Stage3BlockedError([
        `próba ${record.runId} zapisała status "submitted", ale nie ma z niej użytecznej odpowiedzi${status === null ? "" : ` (HTTP ${status})`} — mogła zostać rozliczona`,
        "wywołanie idzie ze store: false, więc nie ma zadania do odpytania; nową płatną próbę zaczyna wyłącznie --regenerate",
      ])
    );
  }

  // The saved answer was written for the inputs recorded beside it. Publishing
  // it against changed inputs would attach a result to a question nobody asked.
  const changed = record.inputs.filter(
    (entry) => !stage3.inputs.some((now) => now.path === entry.path && now.sha256 === entry.sha256)
  );

  if (changed.length > 0) {
    return err(
      new Stage3BlockedError([
        ...changed.map((entry) => `${entry.path}: zmienił się od czasu próby ${record.runId}`),
        "zapisana odpowiedź opisuje inne wejście — nową płatną próbę zaczyna --regenerate",
      ])
    );
  }

  if (stage3.settings === null || stage3.screenplay === null) {
    return err(new Stage3BlockedError(stage3.gate));
  }

  return await publish(input, paths, run, {
    body: saved.data.bytes.toString("utf8"),
    cast: stage3.cast,
    inputs: stage3.inputs,
    previous: null,
    producer: record.producer,
    runId: record.runId,
    screenplay: stage3.screenplay,
    settings: stage3.settings,
  });
}

async function prepare(
  run: RunPaths,
  data: {
    readonly inputs: readonly RecordedFile[];
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

  // The inputs are referenced, never copied: a run archive that duplicated them
  // would keep a second copy of the screenplay for every attempt.
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
  paths: Stage3Paths,
  run: RunPaths,
  data: Publication
): Promise<Result<ShotListReport>> {
  const parsed = readOutputText(data.body, "lista ujęć");

  if (!parsed.ok) {
    return parsed;
  }

  const verdict = validateShotList({
    cast: data.cast,
    screenplay: data.screenplay,
    settings: data.settings,
    text: parsed.data.text,
  });

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
      castSeen: verdict.data.castSeen,
      checkedAt: nowIso(),
      clips: verdict.data.clips.length,
      durationSeconds: verdict.data.durationSeconds,
      longestClipSeconds: verdict.data.longestClipSeconds,
      maxClipSeconds: verdict.data.maxClipSeconds,
      promptVersion: PROMPT_VERSION,
      scenes: verdict.data.scenes.length,
      shots: verdict.data.shots.length,
      structuralValidation: "passed",
    })
  );

  // The previous result is kept only when a regeneration replaces it.
  if (data.previous !== null) {
    await writeNew(run.previousShotList, data.previous);
  }

  const { jobId, text } = parsed.data;
  const outputs = [
    {
      path: toWorkspacePath(input.workspace.root, paths.episode.shotList),
      sha256: sha256Of(Buffer.from(text)),
    },
  ];

  await write(paths.episode.shotList, text);
  await write(
    paths.episode.shotListStage,
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
      toWorkspacePath(input.workspace.root, paths.episode.shotList),
      toWorkspacePath(input.workspace.root, paths.episode.shotListStage),
      toWorkspacePath(input.workspace.root, run.root),
    ],
    nextStep: `oceń listę ujęć, a potem: aimator approve ${input.projectId} ${input.episodeId} --stage shot-list`,
    problems: [],
    prompt: null,
    ready: true,
    runId: data.runId,
    verdict: verdict.data,
  });
}
