import { z } from "zod";
import {
  AnswerFormatError,
  applyWrites,
  type Correction,
  nowIso,
  type RecordedFile,
  readDigest,
  readJson,
  serialize,
  sha256Of,
  stageFileSchema,
  toWorkspacePath,
  type WriteMode,
  writeNew,
} from "../artifact/index.js";
import { showImport } from "../import/index.js";
import { err, ok, type Result } from "../result.js";
import {
  type Publication,
  type Published,
  type Replaced,
  runTextStage,
  type TextStage,
  textPrompt,
} from "../text-model/index.js";
import { type ProjectPaths, type RunPaths, type Workspace, workspacePath } from "../workspace.js";
import {
  answerSchema,
  buildPrompt,
  DRAFT_FORMAT,
  type DraftAnswer,
  type DraftMaterial,
  PROMPT_VERSION,
} from "./draft-prompt.js";
import { leftOpen, PLACEHOLDER, type RuleValues, renderRules } from "./template.js";

/**
 * Internal to the project module: `project.md` drafted from an import.
 *
 * One paid text call through `lib/text-model`, whose order of operations it
 * keeps. The model fills the scaffold's fields from the import's grouping and
 * the code renders the document, so stage 0 reads the same structure it would
 * from a person. It is a proposal and nothing more: stage 0 still blocks on
 * every marker left, and on approval, which no draft can give.
 *
 * Its record lives in `rules.stage.json`, not in `prepare.stage.json`, because
 * stage 0 verifies every output that file names and a draft exists to be
 * edited. For the same reason a draft never overwrites somebody's work: it
 * writes over the untouched scaffold, or over its own untouched draft, only.
 */

export interface RulesDraftInput {
  readonly apiKey: string | null;
  readonly fetch: typeof fetch;
  readonly importId: string;
  /** A note correcting the published draft; only with `regenerate`. */
  readonly instruction?: string | null;
  readonly maxOutputTokens: number;
  readonly mode: WriteMode;
  readonly model: string | null;
  readonly projectId: string;
  readonly regenerate: boolean;
  /** Publish the archived answer again, sending nothing. */
  readonly republish: boolean;
  readonly workspace: Workspace;
}

/** What the module entry already read about the project. */
interface DraftProject {
  /** `project.json`, by digest: the title the draft renders under. */
  readonly file: RecordedFile;
  readonly paths: ProjectPaths;
  readonly title: string;
}

export interface RulesDraftReport {
  /** The note this attempt corrects by, and where it came from; `null` for a new draft. */
  readonly correction: Correction | null;
  readonly created: readonly string[];
  readonly importId: string;
  /** The fields a person still has to answer, by their label, in document order. */
  readonly left: readonly string[];
  readonly nextStep: string;
  /** The bill, in text calls: one, or zero when something blocks it. */
  readonly paidCalls: number;
  readonly problems: readonly string[];
  readonly projectId: string;
  /** `--dry-run` only: the exact text a paid call would send. */
  readonly prompt: string | null;
  readonly ready: boolean;
  /** `project.md`, workspace-relative. */
  readonly rules: string;
  readonly runId: string | null;
}

class DraftBlockedError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `szkic zasad nie może wykonać płatnego wywołania:\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "DraftBlockedError";
    this.problems = problems;
  }
}

/** The grouping's parts a draft reads, and what it records of them. */
interface Material {
  /** Grouped files that exist, before any is read; zero means no grouping. */
  readonly grouped: number;
  readonly inputs: readonly RecordedFile[];
  readonly parts: readonly DraftMaterial[];
}

/** The record this step owns inside `rules.stage.json`. */
const KEY = "rules";

export async function draftFrom(
  input: RulesDraftInput,
  project: DraftProject
): Promise<Result<RulesDraftReport>> {
  const material = await readMaterial(input);

  if (!material.ok) {
    return material;
  }

  const rules = toWorkspacePath(input.workspace.root, project.paths.rules);
  const problems = [
    ...blockers(input, material.data),
    ...(await overwriteProblems(project, rules)),
  ];
  const task = stage(input, project, material.data);
  const report = { importId: input.importId, projectId: input.projectId, rules };

  if (input.mode === "dry-run") {
    const sent = await textPrompt(task, {
      instruction: input.instruction ?? null,
      regenerate: input.regenerate,
    });
    const blocked = [...problems, ...sent.problems];

    return ok({
      ...report,
      correction: sent.correction,
      created: [],
      left: [],
      nextStep:
        blocked.length === 0
          ? `aimator project draft ${input.projectId} --import ${input.importId}`
          : "usuń powyższe przeszkody przed płatnym wywołaniem",
      paidCalls: blocked.length === 0 ? 1 : 0,
      problems: blocked,
      prompt: sent.prompt,
      ready: blocked.length === 0,
      runId: null,
    });
  }

  if (problems.length > 0) {
    return err(new DraftBlockedError(problems));
  }

  const attempt = await runTextStage(
    {
      apiKey: input.apiKey ?? "",
      episode: project.paths,
      fetch: input.fetch,
      format: DRAFT_FORMAT,
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

  const left = attempt.data.value;

  return ok({
    ...report,
    correction: attempt.data.correction,
    created: attempt.data.created,
    left,
    nextStep: `przeczytaj ${rules} i popraw, co szkic oddał źle; zostało do uzupełnienia: ${left.join(", ")}; potem: aimator check ${input.projectId}`,
    paidCalls: 1,
    problems: [],
    prompt: null,
    ready: true,
    runId: attempt.data.runId,
  });
}

/**
 * Every grouped part but the episodes, whose stories stage 1 writes from each
 * episode's own source, read in the grouping's order with their digests.
 */
async function readMaterial(input: RulesDraftInput): Promise<Result<Material>> {
  const shown = await showImport({ importId: input.importId, workspace: input.workspace });

  if (!shown.ok) {
    return shown;
  }

  const inputs: RecordedFile[] = [];
  const parts: DraftMaterial[] = [];

  for (const entry of shown.data.grouped) {
    if (entry.destination.startsWith("episode:")) {
      continue;
    }

    // biome-ignore lint/performance/noAwaitInLoops: a handful of small files, read in order
    const read = await readDigest(workspacePath(input.workspace, entry.path));

    if (!read.ok) {
      return read;
    }

    inputs.push({ path: entry.path, sha256: read.data.sha256 });
    parts.push({ destination: entry.destination, text: read.data.bytes.toString("utf8") });
  }

  return ok({ grouped: shown.data.grouped.length, inputs, parts });
}

/**
 * Why a paid call may not happen. Empty means it may. A dry run never reads
 * the key, so it does not claim the key is missing.
 */
function blockers(input: RulesDraftInput, material: Material): string[] {
  const problems: string[] = [];

  if (material.grouped === 0) {
    problems.push(
      `import "${input.importId}" nie ma podziału, a szkic czyta podział: aimator import group ${input.importId} --dry-run`
    );
  } else if (material.parts.length === 0) {
    problems.push(
      `podział importu "${input.importId}" ma same odcinki, a szkic zasad czyta serię, styl i postacie`
    );
  }

  // A republication sends nothing, so it needs neither a model nor a key.
  if (input.republish) {
    return problems;
  }

  if (input.model === null || input.model === "") {
    problems.push("brak modelu tekstowego, wskaż go przez --model <id> albo AIMATOR_RULES_MODEL");
  }

  if (input.mode !== "dry-run" && (input.apiKey === null || input.apiKey === "")) {
    problems.push("brak OPENAI_API_KEY w środowisku lub .env");
  }

  return problems;
}

/**
 * A draft writes over the scaffold, over its own draft nobody touched since,
 * or where there is no `project.md` at all. Anything else is somebody's work,
 * and a proposal is no reason to lose it.
 */
async function overwriteProblems(project: DraftProject, rules: string): Promise<string[]> {
  const current = await readDigest(project.paths.rules);

  if (!current.ok) {
    return [];
  }

  const scaffold = sha256Of(Buffer.from(renderRules(project.title)));
  const record = await readJson(project.paths.rulesDraft, stageFileSchema);
  const drafted = record.ok
    ? record.data.artifacts[KEY]?.outputs.find(({ path }) => path === rules)?.sha256
    : undefined;

  return current.data.sha256 === scaffold || current.data.sha256 === drafted
    ? []
    : [
        `${rules} poprawiono ręcznie, a szkic nadpisałby tę pracę; poprawiaj go dalej albo, jeśli tej pracy nie potrzebujesz, usuń ${rules}, a szkic zacznie od szkieletu`,
      ];
}

/** The half of the attempt that is about the rules rather than about paying. */
function stage(
  input: RulesDraftInput,
  project: DraftProject,
  material: Material
): TextStage<readonly string[]> {
  return {
    artifact: "rules",
    blocked: (problems) => new DraftBlockedError(problems),
    inputs: [project.file, ...material.inputs],
    key: KEY,
    lock: project.paths.rulesLock,
    prompt: buildPrompt(material.parts),
    promptVersion: PROMPT_VERSION,
    publish: (publication) => publish(input, project, material, publication),
    replaced: () => replaced(project.paths),
    result: project.paths.rules,
    stagePath: project.paths.rulesDraft,
    what: "szkic zasad",
  };
}

/** The rules a regeneration replaces, named relative to the project. */
async function replaced(paths: ProjectPaths): Promise<readonly Replaced[]> {
  const current = await readDigest(paths.rules);

  return current.ok ? [{ name: "project.md", text: current.data.bytes.toString("utf8") }] : [];
}

async function publish(
  input: RulesDraftInput,
  project: DraftProject,
  material: Material,
  publication: Publication
): Promise<Result<Published<readonly string[]>>> {
  const { archive } = publication;
  const answer = readAnswer(publication.text);

  if (!answer.ok) {
    return await refuse(input.workspace, archive, answer.error);
  }

  const verdict = validateDraft(answer.data);

  if (!verdict.ok) {
    return await refuse(input.workspace, archive, verdict.error);
  }

  const values: RuleValues = { ...verdict.data, prepared: provenance(input, material) };
  const text = renderRules(project.title, values);
  const left = leftOpen(values);

  await writeNew(
    archive.validation,
    serialize({
      checkedAt: nowIso(),
      filled: Object.keys(verdict.data).length,
      left: left.length,
      promptVersion: PROMPT_VERSION,
      structuralValidation: "passed",
    })
  );

  const written = await applyWrites([{ kind: "text", text, to: project.paths.rules }], "apply");

  if (!written.ok) {
    return written;
  }

  const recorded = toWorkspacePath(input.workspace.root, project.paths.rules);

  return ok({
    created: [recorded],
    outputs: [{ path: recorded, sha256: sha256Of(Buffer.from(text)) }],
    value: left,
  });
}

/** The answer, or why it is not one, said as the refusal will say it. */
function readAnswer(text: string): Result<DraftAnswer, string> {
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

const HEADING = /^\s*#/m;

/**
 * The fields the answer filled, trimmed, or every reason it cannot fill them.
 *
 * Only what would break the document or pass for a person's answer is
 * refused: a value that is blank, that carries the marker stage 0 counts, or
 * that opens a heading and so a section the template never had. Whether a
 * value is true to the material is for the person who reads it.
 */
function validateDraft(answer: DraftAnswer): Result<RuleValues, string> {
  const values: Record<string, string> = {};
  const problems: string[] = [];

  for (const [key, raw] of Object.entries(answer)) {
    if (raw === null) {
      continue;
    }

    const value = raw.trim();

    if (value === "") {
      problems.push(`pole ${key} jest puste; brak odpowiedzi to null`);
    } else if (value.includes(PLACEHOLDER)) {
      problems.push(`pole ${key} zawiera znacznik ${PLACEHOLDER}; brak odpowiedzi to null`);
    } else if (HEADING.test(value)) {
      problems.push(`pole ${key} zawiera nagłówek, który złamałby strukturę project.md`);
    } else {
      values[key] = value;
    }
  }

  return problems.length === 0 ? ok(values as RuleValues) : err(problems.join("\n"));
}

/** When and from what, said by the code: a model is not asked where its own text came from. */
function provenance(input: RulesDraftInput, material: Material): string {
  const characters = material.parts.filter(({ destination }) =>
    destination.startsWith("character:")
  ).length;
  const parts = [
    ...material.parts
      .map(({ destination }) => destination)
      .filter((destination) => !destination.startsWith("character:")),
    ...(characters === 0 ? [] : [`postacie: ${characters}`]),
  ];
  const model = input.model === null || input.model === "" ? "" : ` ${input.model}`;

  return `${nowIso().slice(0, 10)}, szkic modelu${model} z importu „${input.importId}” (${parts.join(", ")}). Propozycja do przeczytania i poprawy, nie decyzja.`;
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
