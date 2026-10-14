import { z } from "zod";
import {
  AnswerFormatError,
  applyWrites,
  type Correction,
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
  type Replaced,
  runTextStage,
  type TextStage,
  textPrompt,
} from "../text-model/index.js";
import {
  groupedFile,
  type ImportDestination,
  type ImportPaths,
  importPaths,
  type RunPaths,
  type Workspace,
  workspacePath,
} from "../workspace.js";
import { readImport, relink, type StoredImport } from "./material.js";
import {
  answerSchema,
  buildPrompt,
  GROUPING_FORMAT,
  type GroupingAnswer,
  PROMPT_VERSION,
} from "./prompt.js";
import { type Grouping, validateGrouping } from "./validate.js";

/**
 * Internal to the import module: the one paid step of an import.
 *
 * The order of operations is `lib/text-model`'s, as it is every text stage's:
 * nothing is written in `--dry-run`, `submitted` lands before the POST, a saved
 * answer is published again for free, nothing retries on its own. What stays
 * here is what is about a grouping: the verdict, and the files under
 * `grouped/`, each one sections of `material.md` copied in document order.
 *
 * Nobody approves a grouping. It is a proposal `/prepare-project` reads with a
 * person, and stage 0 is where anything in it becomes a decision.
 */

/** The record this step owns inside `grouped/import.stage.json`. */
const KEY = "grouping";

interface GroupInput {
  readonly apiKey: string | null;
  readonly fetch: typeof fetch;
  readonly importId: string;
  /** A note correcting the published grouping; only with `regenerate`. */
  readonly instruction?: string | null;
  readonly maxOutputTokens: number;
  readonly mode: WriteMode;
  readonly model: string | null;
  readonly regenerate: boolean;
  /** Publish the archived answer again, sending nothing. */
  readonly republish: boolean;
  readonly workspace: Workspace;
}

/** One file under `grouped/`, and the sections it holds, in document order. */
interface GroupedFile {
  /** `series`, `style`, `other`, `character:miko` or `episode:01-pola`. */
  readonly destination: string;
  /** Workspace-relative. */
  readonly path: string;
  readonly sections: readonly string[];
}

interface GroupReport {
  /** The note this attempt corrects by, and where it came from; `null` for a new grouping. */
  readonly correction: Correction | null;
  readonly created: readonly string[];
  /** What was written, or empty before anything was. */
  readonly files: readonly GroupedFile[];
  readonly importId: string;
  readonly nextStep: string;
  /** The bill, in text calls: one, or zero when something blocks it. */
  readonly paidCalls: number;
  readonly problems: readonly string[];
  /** `--dry-run` only: the exact text a paid call would send. */
  readonly prompt: string | null;
  readonly ready: boolean;
  readonly runId: string | null;
}

class GroupBlockedError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `grupowanie importu nie może wykonać płatnego wywołania:\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "GroupBlockedError";
    this.problems = problems;
  }
}

export async function groupImport(input: GroupInput): Promise<Result<GroupReport>> {
  const paths = importPaths(input.workspace, input.importId);

  if (!paths.ok) {
    return paths;
  }

  const stored = await readImport(input.workspace, paths.data, input.importId);

  if (!stored.ok) {
    return stored;
  }

  const previous = await previousOutputs(paths.data.groupedStage);
  const edited = input.republish ? await handEdited(input.workspace, previous) : [];
  const problems = [
    ...blockers(input, paths.data, stored.data),
    ...(edited.length === 0
      ? []
      : [
          `--republish opublikowałby zapisaną odpowiedź na pliki poprawione ręcznie i nadpisał tę pracę: ${edited.join(", ")}; nowy podział kupuje --regenerate`,
        ]),
  ];
  const task = stage(input, paths.data, stored.data, previous);

  if (input.mode === "dry-run") {
    const sent = await textPrompt(task, {
      instruction: input.instruction ?? null,
      regenerate: input.regenerate,
    });
    const blocked = [...problems, ...sent.problems];

    return ok({
      correction: sent.correction,
      created: [],
      files: [],
      importId: input.importId,
      nextStep:
        blocked.length === 0
          ? `aimator import group ${input.importId}`
          : "usuń powyższe przeszkody przed płatnym wywołaniem",
      paidCalls: blocked.length === 0 ? 1 : 0,
      problems: blocked,
      prompt: sent.prompt,
      ready: blocked.length === 0,
      runId: null,
    });
  }

  if (problems.length > 0) {
    return err(new GroupBlockedError(problems));
  }

  const attempt = await runTextStage(
    {
      apiKey: input.apiKey ?? "",
      episode: paths.data,
      fetch: input.fetch,
      format: GROUPING_FORMAT,
      instruction: input.instruction ?? null,
      maxOutputTokens: input.maxOutputTokens,
      model: input.model ?? "",
      regenerate: input.regenerate,
      republish: input.republish,
      workspace: input.workspace,
    },
    task
  );

  if (!attempt.ok) {
    return attempt;
  }

  return ok({
    correction: attempt.data.correction,
    created: attempt.data.created,
    files: attempt.data.value,
    importId: input.importId,
    nextStep: `przeczytaj ${toWorkspacePath(input.workspace.root, paths.data.grouped)}; projekt z tego materiału zakłada skill /prepare-project`,
    paidCalls: 1,
    problems: [],
    prompt: null,
    ready: true,
    runId: attempt.data.runId,
  });
}

/**
 * Why a paid call may not happen. Empty means it may. A dry run never reads
 * the key, so it does not claim the key is missing.
 */
function blockers(input: GroupInput, paths: ImportPaths, stored: StoredImport): string[] {
  const problems: string[] = [];

  if (stored.sections.length === 0) {
    problems.push(
      `${toWorkspacePath(input.workspace.root, paths.material)} jest pusty, nie ma czego podzielić`
    );
  }

  // A republication sends nothing, so it needs neither a model nor a key.
  if (input.republish) {
    return problems;
  }

  if (input.model === null || input.model === "") {
    problems.push("brak modelu tekstowego, wskaż go przez --model <id> albo AIMATOR_IMPORT_MODEL");
  }

  if (input.mode !== "dry-run" && (input.apiKey === null || input.apiKey === "")) {
    problems.push("brak OPENAI_API_KEY w środowisku lub .env");
  }

  return problems;
}

/** The half of the attempt that is about a grouping rather than about paying. */
function stage(
  input: GroupInput,
  paths: ImportPaths,
  stored: StoredImport,
  previous: readonly RecordedFile[]
): TextStage<readonly GroupedFile[]> {
  return {
    artifact: "import",
    blocked: (problems) => new GroupBlockedError(problems),
    inputs: [
      {
        path: toWorkspacePath(input.workspace.root, paths.material),
        sha256: stored.material.sha256,
      },
    ],
    key: KEY,
    lock: paths.lock,
    prompt: buildPrompt(stored.sections),
    promptVersion: PROMPT_VERSION,
    publish: (publication) => publish(input, paths, stored, publication, previous),
    replaced: () => replaced(input.workspace, paths, previous),
    result: paths.grouped,
    stagePath: paths.groupedStage,
    what: "podział materiału",
  };
}

/** What the previous record says this step published, as recorded paths. */
async function previousOutputs(stagePath: string): Promise<readonly RecordedFile[]> {
  const file = await readJson(stagePath, stageFileSchema);

  return file.ok ? (file.data.artifacts[KEY]?.outputs ?? []) : [];
}

/** Published files whose bytes are no longer what was published: somebody's work. */
async function handEdited(
  workspace: Workspace,
  previous: readonly RecordedFile[]
): Promise<readonly string[]> {
  const edited: string[] = [];

  for (const output of previous) {
    // biome-ignore lint/performance/noAwaitInLoops: a handful of small files
    const bytes = await readDigest(workspacePath(workspace, output.path));

    if (bytes.ok && bytes.data.sha256 !== output.sha256) {
      edited.push(output.path);
    }
  }

  return edited;
}

/** Every file a regeneration replaces, named relative to the import. */
async function replaced(
  workspace: Workspace,
  paths: ImportPaths,
  previous: readonly RecordedFile[]
): Promise<readonly Replaced[]> {
  const prefix = `${toWorkspacePath(workspace.root, paths.root)}/`;
  const files: Replaced[] = [];

  for (const output of previous) {
    const name = output.path.startsWith(prefix) ? output.path.slice(prefix.length) : null;

    // biome-ignore lint/performance/noAwaitInLoops: a handful of small files
    const bytes = await readDigest(workspacePath(workspace, output.path));

    if (name !== null && bytes.ok) {
      files.push({ name, text: bytes.data.bytes.toString("utf8") });
    }
  }

  return files;
}

async function publish(
  input: GroupInput,
  paths: ImportPaths,
  stored: StoredImport,
  publication: Publication,
  previous: readonly RecordedFile[]
): Promise<Result<Published<readonly GroupedFile[]>>> {
  const { archive } = publication;
  const answer = readAnswer(publication.text);

  if (!answer.ok) {
    return await refuse(input.workspace, archive, answer.error);
  }

  const verdict = validateGrouping(answer.data, stored.sections);

  if (!verdict.ok) {
    return await refuse(input.workspace, archive, verdict.error.message);
  }

  const rendered = render(input.workspace, paths, stored, verdict.data);

  if (!rendered.ok) {
    return rendered;
  }

  await writeNew(
    archive.validation,
    serialize({
      characters: verdict.data.characters.length,
      checkedAt: nowIso(),
      episodes: verdict.data.episodes.length,
      files: rendered.data.files.length,
      promptVersion: PROMPT_VERSION,
      structuralValidation: "passed",
    })
  );

  const written = await applyWrites(rendered.data.writes, "apply");

  if (!written.ok) {
    return written;
  }

  await sweep(input.workspace, previous, rendered.data.outputs);

  return ok({
    created: rendered.data.files.map(({ path }) => path),
    outputs: rendered.data.outputs,
    value: rendered.data.files,
  });
}

/** The answer, or why it is not one, said as the refusal will say it. */
function readAnswer(text: string): Result<GroupingAnswer, string> {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return err("odpowiedź modelu nie jest poprawnym JSON-em");
  }

  const parsed = answerSchema.safeParse(value);

  return parsed.success
    ? ok(parsed.data)
    : err(`odpowiedź modelu ma niepoprawny kształt:\n${z.prettifyError(parsed.error)}`);
}

interface Rendered {
  readonly files: readonly GroupedFile[];
  readonly outputs: readonly RecordedFile[];
  readonly writes: readonly WriteOp[];
}

/**
 * The files under `grouped/`: series, style, each character as declared, each
 * episode by number, then the rest. Each holds its sections in document
 * order, copied with only their image links re-pointed, and a destination no
 * section went to gets no file.
 */
function render(
  workspace: Workspace,
  paths: ImportPaths,
  stored: StoredImport,
  grouping: Grouping
): Result<Rendered> {
  const destinations: ImportDestination[] = [
    { kind: "series" },
    { kind: "style" },
    ...grouping.characters.map(({ id }) => ({ id, kind: "character" as const })),
    ...grouping.episodes.map((id) => ({ id, kind: "episode" as const })),
    { kind: "other" },
  ];
  const files: GroupedFile[] = [];
  const outputs: RecordedFile[] = [];
  const writes: WriteOp[] = [];

  for (const destination of destinations) {
    const label = labelOf(destination);
    const own = stored.sections.filter((section) =>
      (grouping.routes.get(section.id) ?? []).some((route) => labelOf(route) === label)
    );

    if (own.length === 0) {
      continue;
    }

    const path = groupedFile(paths, destination);

    if (!path.ok) {
      return path;
    }

    const text = `${own
      .map((section) => relink(workspace, paths, stored.file, section.text, path.data).trimEnd())
      .join("\n\n")}\n`;
    const recorded = toWorkspacePath(workspace.root, path.data);

    files.push({ destination: label, path: recorded, sections: own.map(({ id }) => id) });
    outputs.push({ path: recorded, sha256: sha256Of(Buffer.from(text)) });
    writes.push({ kind: "text", text, to: path.data });
  }

  return ok({ files, outputs, writes });
}

function labelOf(destination: ImportDestination): string {
  return "id" in destination ? `${destination.kind}:${destination.id}` : destination.kind;
}

/**
 * Removes files the previous grouping published and this one does not, so
 * `grouped/` never lists a character the material no longer has. Only files
 * this step itself recorded are ever removed.
 */
async function sweep(
  workspace: Workspace,
  previous: readonly RecordedFile[],
  outputs: readonly RecordedFile[]
): Promise<void> {
  const kept = new Set(outputs.map(({ path }) => path));

  for (const stale of previous) {
    if (!kept.has(stale.path)) {
      // biome-ignore lint/performance/noAwaitInLoops: a handful of files at most
      await removeFile(workspacePath(workspace, stale.path));
    }
  }
}

/**
 * An answer that cannot be published, archived with its reason. It is bought
 * and saved, so a verdict on it can be drawn again for nothing.
 */
async function refuse(
  workspace: Workspace,
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

  return err(new AnswerFormatError(reason, toWorkspacePath(workspace.root, archive.response)));
}
