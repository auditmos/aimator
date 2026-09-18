import {
  applyWrites,
  nowIso,
  type RecordedFile,
  readDigest,
  serialize,
  sha256Of,
  toWorkspacePath,
  type WriteMode,
  writeNew,
} from "../artifact/index.js";
import { readStage0Inputs, type Stage0Inputs } from "../project/index.js";
import { err, ok, type Result } from "../result.js";
import {
  type Publication,
  type Published,
  runTextStage,
  type TextStage,
} from "../text-model/index.js";
import {
  type EpisodePaths,
  episodePaths,
  previousFile,
  projectPaths,
  type RunPaths,
  type Workspace,
} from "../workspace.js";
import { buildPrompt, PROMPT_VERSION } from "./prompt.js";
import { minimumScenes, type ScreenplayVerdict, validateScreenplay } from "./validate.js";

/**
 * Internal to the screenplay module: the one command that spends money.
 *
 * The order of operations is the contract, and it now lives in
 * `lib/text-model`: nothing is written in `--dry-run`, the stage file records
 * `submitted` *before* the POST, and nothing retries on its own. What stays
 * here is what is about a screenplay — the gate, the prompt, the structural
 * verdict, and the one file this stage publishes.
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

  const attempt = await runTextStage(
    {
      apiKey: input.apiKey ?? "",
      episode: paths.data,
      fetch: input.fetch,
      format: null,
      maxOutputTokens: input.maxOutputTokens,
      model: input.model ?? "",
      regenerate: input.regenerate,
      workspace: input.workspace,
    },
    stage(input, paths.data, stage0.data, prompt)
  );

  if (!attempt.ok) {
    return attempt;
  }

  return ok({
    approved: false,
    created: attempt.data.created,
    minimumScenes: required,
    nextStep: `oceń scenariusz, a potem: aimator approve ${input.projectId} ${input.episodeId} --stage screenplay`,
    problems: [],
    prompt: null,
    ready: true,
    runId: attempt.data.runId,
    verdict: attempt.data.value,
  });
}

/** The half of the attempt that is about a screenplay rather than about paying. */
function stage(
  input: GenerateInput,
  paths: EpisodePaths,
  stage0: Stage0Inputs,
  prompt: string
): TextStage<ScreenplayVerdict> {
  return {
    artifact: ARTIFACT,
    blocked: (problems) => new Stage1BlockedError(problems),
    inputs: stage0.inputs,
    lock: paths.screenplayLock,
    preserve: (archive) => preserve(paths, archive),
    prompt,
    promptVersion: PROMPT_VERSION,
    publish: (publication) => publish(input, paths, stage0, publication),
    result: paths.screenplay,
    stagePath: paths.screenplayStage,
    what: "scenariusz",
  };
}

/** Keeps the screenplay a regeneration is about to replace. */
async function preserve(paths: EpisodePaths, archive: RunPaths): Promise<void> {
  const previous = await readDigest(paths.screenplay);
  const to = previousFile(archive, "screenplay.md");

  if (previous.ok && to.ok) {
    await writeNew(to.data, previous.data.bytes.toString("utf8"));
  }
}

async function publish(
  input: GenerateInput,
  paths: EpisodePaths,
  stage0: Stage0Inputs,
  publication: Publication
): Promise<Result<Published<ScreenplayVerdict>>> {
  const { archive, text } = publication;
  const verdict = validateScreenplay(text, stage0.settings);

  if (!verdict.ok) {
    await writeNew(
      archive.validation,
      serialize({
        checkedAt: nowIso(),
        promptVersion: PROMPT_VERSION,
        reason: verdict.error.message,
        structuralValidation: "failed",
      })
    );

    return err(
      new Error(
        `${verdict.error.message}. Odpowiedź zachowano w ${toWorkspacePath(input.workspace.root, archive.response)} — to błąd formatu wyniku, nie powód do --regenerate.`
      )
    );
  }

  await writeNew(
    archive.validation,
    serialize({
      ...verdict.data,
      checkedAt: nowIso(),
      promptVersion: PROMPT_VERSION,
      structuralValidation: "passed",
    })
  );

  const outputs: RecordedFile[] = [
    {
      path: toWorkspacePath(input.workspace.root, paths.screenplay),
      sha256: sha256Of(Buffer.from(text)),
    },
  ];
  const written = await write(paths.screenplay, text);

  return written.ok
    ? ok({
        created: [toWorkspacePath(input.workspace.root, paths.screenplay)],
        outputs,
        value: verdict.data,
      })
    : written;
}

async function write(path: string, text: string): Promise<Result<true>> {
  const done = await applyWrites([{ kind: "text", text, to: path }], "apply");

  return done.ok ? ok(true) : done;
}
