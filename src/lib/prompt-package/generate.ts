import {
  applyWrites,
  nowIso,
  type RecordedFile,
  readDigest,
  readJson,
  removeFile,
  serialize,
  sha256Of,
  stageFileSchema,
  toWorkspacePath,
  type WriteMode,
  type WriteOp,
  writeNew,
} from "../artifact/index.js";
import { err, ok, type Result } from "../result.js";
import {
  type Publication,
  type Published,
  runTextStage,
  type TextStage,
} from "../text-model/index.js";
import {
  previousFile,
  promptFile,
  promptPaths,
  type RunPaths,
  type Workspace,
  workspacePath,
} from "../workspace.js";
import { readStage4Inputs, type Stage4Inputs } from "./plan.js";
import { PACKAGE_FORMAT, PROMPT_VERSION } from "./prompt.js";
import { type PromptFile, readPackageAnswer, renderPackage } from "./render.js";
import { type PromptPackage, validatePromptPackage } from "./validate.js";

/**
 * Internal to the prompt-package module: the one command that spends money.
 *
 * The order of operations is the contract and lives in `lib/text-model`:
 * nothing is written in `--dry-run`, the stage file records `submitted` before
 * the POST, and nothing retries on its own. What stays here is what is about a
 * prompt package, the gate, the structural verdict, and the tree of files this
 * stage publishes.
 */

const ARTIFACT = "prompt-package";

export interface PromptPackageReport {
  /** Whether the plan and the faces this package is drawn from are accepted. */
  readonly approved: boolean;
  readonly created: readonly string[];
  readonly nextStep: string;
  readonly problems: readonly string[];
  /** `--dry-run` only: the exact text a paid call would send. */
  readonly prompt: string | null;
  readonly ready: boolean;
  readonly runId: string | null;
  readonly verdict: PromptPackage | null;
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
  /** Publish the archived answer again, sending nothing. */
  readonly republish: boolean;
  readonly workspace: Workspace;
}

class Stage4BlockedError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `etap 4 nie może wykonać płatnego wywołania:\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "Stage4BlockedError";
    this.problems = problems;
  }
}

/**
 * Why a paid call may not happen. Empty means it may.
 *
 * A dry run never reads the key, so it must not claim the key is missing, it
 * says what it did not check instead. Claiming to have found an absence you
 * never looked for is the same lie as claiming a success you never had.
 */
function blockers(input: GenerateInput, stage4: Stage4Inputs): readonly string[] {
  const problems = [...stage4.gate];

  // A republication sends nothing, so it needs neither a model nor a key.
  // Demanding them would make the free path look like the paid one.
  if (input.republish) {
    return problems;
  }

  if (input.model === null || input.model === "") {
    problems.push("brak modelu tekstowego, wskaż go przez --model <id> albo AIMATOR_PROMPTS_MODEL");
  }

  if (input.mode !== "dry-run" && (input.apiKey === null || input.apiKey === "")) {
    problems.push("brak OPENAI_API_KEY w środowisku lub .env");
  }

  return problems;
}

export async function generatePromptPackage(
  input: GenerateInput
): Promise<Result<PromptPackageReport>> {
  const stage4 = await readStage4Inputs(input);

  if (!stage4.ok) {
    return stage4;
  }

  const problems = blockers(input, stage4.data);

  if (input.mode === "dry-run") {
    return ok({
      approved: stage4.data.gate.length === 0,
      created: [],
      nextStep:
        problems.length === 0
          ? `aimator prompt-package generate ${input.projectId} ${input.episodeId}`
          : "usuń powyższe przeszkody przed płatnym wywołaniem",
      problems,
      prompt: stage4.data.prompt,
      ready: problems.length === 0,
      runId: null,
      verdict: null,
    });
  }

  if (problems.length > 0) {
    return err(new Stage4BlockedError(problems));
  }

  // The gate already refused a missing plan, so these are decided by now.
  const { prompt, shotList } = stage4.data;

  if (prompt === null || shotList === null) {
    return err(new Stage4BlockedError(stage4.data.gate));
  }

  // Read before the attempt starts: `submitted` lands on disk before the POST
  // and empties the outputs, so after it there is no record of what this stage
  // published last time, and both preserving and sweeping need exactly that.
  const previous = await previousOutputs(stage4.data.paths.episode.promptPackageStage);
  const attempt = await runTextStage(
    {
      apiKey: input.apiKey ?? "",
      episode: stage4.data.paths.episode,
      fetch: input.fetch,
      format: PACKAGE_FORMAT,
      maxOutputTokens: input.maxOutputTokens,
      model: input.model ?? "",
      regenerate: input.regenerate,
      republish: input.republish,
      workspace: input.workspace,
    },
    stage(input, stage4.data, prompt, previous)
  );

  if (!attempt.ok) {
    return attempt;
  }

  return ok({
    approved: false,
    created: attempt.data.created,
    nextStep: `oceń pakiet, a potem: aimator approve ${input.projectId} ${input.episodeId} --stage prompt-package`,
    problems: [],
    prompt: null,
    ready: true,
    runId: attempt.data.runId,
    verdict: attempt.data.value,
  });
}

/** The half of the attempt that is about a package rather than about paying. */
function stage(
  input: GenerateInput,
  stage4: Stage4Inputs,
  prompt: string,
  previous: readonly RecordedFile[]
): TextStage<PromptPackage> {
  const { episode } = stage4.paths;

  return {
    artifact: ARTIFACT,
    blocked: (problems) => new Stage4BlockedError(problems),
    inputs: stage4.inputs,
    lock: episode.promptPackageLock,
    preserve: (archive) => preserve(input, stage4, archive, previous),
    prompt,
    promptVersion: PROMPT_VERSION,
    publish: (publication) => publish(input, stage4, publication, previous),
    result: episode.promptPackage,
    stagePath: episode.promptPackageStage,
    what: "pakiet promptów",
  };
}

/** What the previous record says this stage published, as recorded paths. */
async function previousOutputs(stagePath: string): Promise<readonly RecordedFile[]> {
  const file = await readJson(stagePath, stageFileSchema);

  return file.ok ? (file.data.artifacts[ARTIFACT]?.outputs ?? []) : [];
}

/**
 * Keeps every file a regeneration is about to replace.
 *
 * What to keep comes from the previous record rather than from a directory
 * walk: the record is this stage's own statement of what it published, so a
 * file it never wrote is never swept into an archive as though it had been.
 */
async function preserve(
  input: GenerateInput,
  stage4: Stage4Inputs,
  archive: RunPaths,
  previous: readonly RecordedFile[]
): Promise<void> {
  const prefix = `${toWorkspacePath(input.workspace.root, stage4.paths.episode.root)}/`;

  for (const output of previous) {
    const name = output.path.startsWith(prefix) ? output.path.slice(prefix.length) : null;
    const to = name === null ? null : previousFile(archive, name);

    // biome-ignore lint/performance/noAwaitInLoops: one small file at a time
    const bytes = await readDigest(workspacePath(input.workspace, output.path));

    if (to?.ok && bytes.ok) {
      await writeNew(to.data, bytes.data.bytes.toString("utf8"));
    }
  }
}

/** Where one rendered prompt file belongs. */
function pathOf(stage4: Stage4Inputs, file: PromptFile): Result<string> {
  const paths = promptPaths(stage4.paths.episode);

  return file.kind === "opening" || file.id === null
    ? ok(paths.openingFrame)
    : promptFile(paths, file.kind, file.id);
}

async function publish(
  input: GenerateInput,
  stage4: Stage4Inputs,
  publication: Publication,
  previous: readonly RecordedFile[]
): Promise<Result<Published<PromptPackage>>> {
  const { archive, text } = publication;
  const { episode } = stage4.paths;
  const answer = readPackageAnswer(text);

  if (!answer.ok) {
    return await refuse(input, archive, answer.error.message);
  }

  const rendered = renderPackage(answer.data);

  if (stage4.shotList === null) {
    return err(new Stage4BlockedError(stage4.gate));
  }

  const verdict = validatePromptPackage({
    cast: stage4.cast,
    shotList: stage4.shotList,
    value: rendered.manifest,
  });

  if (!verdict.ok) {
    return await refuse(input, archive, verdict.error.message);
  }

  await writeNew(
    archive.validation,
    serialize({
      checkedAt: nowIso(),
      clips: verdict.data.clips.length,
      entryFrames: answer.data.entryFrames.length,
      heroes: verdict.data.heroes,
      promptVersion: PROMPT_VERSION,
      references: verdict.data.references.length,
      structuralValidation: "passed",
    })
  );

  const manifest = serialize(rendered.manifest);
  const writes: WriteOp[] = [{ kind: "text", text: manifest, to: episode.promptPackage }];
  const outputs: RecordedFile[] = [
    {
      path: toWorkspacePath(input.workspace.root, episode.promptPackage),
      sha256: sha256Of(Buffer.from(manifest)),
    },
  ];

  for (const file of rendered.files) {
    const path = pathOf(stage4, file);

    if (!path.ok) {
      return path;
    }

    writes.push({ kind: "text", text: file.text, to: path.data });
    outputs.push({
      path: toWorkspacePath(input.workspace.root, path.data),
      sha256: sha256Of(Buffer.from(file.text)),
    });
  }

  const written = await applyWrites(writes, "apply");

  if (!written.ok) {
    return written;
  }

  await sweep(input.workspace, previous, outputs);

  return ok({
    created: [
      toWorkspacePath(input.workspace.root, episode.promptPackage),
      toWorkspacePath(input.workspace.root, episode.prompts),
    ],
    outputs,
    value: verdict.data,
  });
}

/**
 * Removes prompt files the previous package published and this one does not.
 *
 * A regeneration that plans fewer references would otherwise leave `R07.md`
 * behind, describing an image nothing points at any more, and `prompts/` is
 * read as a list of what the episode still needs. Only files this stage itself
 * recorded as outputs are ever removed.
 */
async function sweep(
  workspace: Workspace,
  previous: readonly RecordedFile[],
  outputs: readonly RecordedFile[]
): Promise<void> {
  const kept = new Set(outputs.map((output) => output.path));

  for (const stale of previous) {
    if (!kept.has(stale.path)) {
      // biome-ignore lint/performance/noAwaitInLoops: a handful of files at most
      await removeFile(workspacePath(workspace, stale.path));
    }
  }
}

/**
 * A result that cannot be published, archived with its reason.
 *
 * It is a format failure, not a billing one: the answer is bought and saved, so
 * re-deriving a verdict from it costs nothing and needs no `--regenerate`.
 */
async function refuse(
  input: GenerateInput,
  archive: RunPaths,
  reason: string
): Promise<Result<never>> {
  await writeNew(
    archive.validation,
    serialize({
      checkedAt: nowIso(),
      promptVersion: PROMPT_VERSION,
      reason,
      structuralValidation: "failed",
    })
  );

  return err(
    new Error(
      `${reason}. Odpowiedź zachowano w ${toWorkspacePath(input.workspace.root, archive.response)}, to błąd formatu wyniku, nie powód do --regenerate.`
    )
  );
}
