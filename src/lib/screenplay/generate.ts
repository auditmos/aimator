import {
  applyWrites,
  type Correction,
  emptyStage,
  manualProducer,
  newRecord,
  newRunId,
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
  writeNew,
} from "../artifact/index.js";
import { readStage0Inputs, type Stage0Inputs } from "../project/index.js";
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
  type EpisodePaths,
  episodePaths,
  previousFile,
  projectPaths,
  runPaths,
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
 * here is what is about a screenplay, the gate, the prompt, the structural
 * verdict, and the one file this stage publishes.
 */

const ARTIFACT = "screenplay";

export interface ScreenplayReport {
  /** Whether stage 0 is approved for this project and episode. */
  readonly approved: boolean;
  /** The note this attempt corrects by, and where it came from; `null` for a new draft. */
  readonly correction: Correction | null;
  readonly created: readonly string[];
  readonly minimumScenes: number;
  readonly nextStep: string;
  /**
   * What this command costs, in the unit stage 1 is billed in: calls.
   *
   * Always zero or one, which is exactly why it is worth returning. The
   * question a dry run answers is whether the command is about to buy a
   * screenplay or to say it cannot, and the two answers are 1 and 0.
   */
  readonly paidCalls: number;
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
  /** A note correcting the published screenplay; only with `regenerate`. */
  readonly instruction?: string | null;
  readonly maxOutputTokens: number;
  readonly mode: WriteMode;
  readonly model: string | null;
  readonly projectId: string;
  readonly regenerate: boolean;
  /** Publish `source.md` as it is, buying nothing; see `adopt`. */
  readonly verbatim?: boolean;
  readonly workspace: Workspace;
}

class Stage1BlockedError extends Error {
  readonly problems: readonly string[];

  constructor(
    problems: readonly string[],
    headline = "etap 1 nie może wykonać płatnego wywołania"
  ) {
    super(`${headline}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "Stage1BlockedError";
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
function blockers(input: GenerateInput, stage0: Stage0Inputs): readonly string[] {
  const problems = [...(stage0.approved ? [] : stage0.problems)];

  if (!stage0.approved) {
    problems.push(
      `etap 0 musi mieć review.status = "approved" zanim etap 1 wyda pieniądze: aimator approve ${input.projectId}`
    );
  }

  if (input.model === null || input.model === "") {
    problems.push(
      "brak modelu tekstowego, wskaż go przez --model <id> albo AIMATOR_SCREENPLAY_MODEL"
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

  if (input.verbatim === true) {
    return await adopt(input, paths.data, stage0.data);
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
    const sent = await textPrompt(stage(input, paths.data, stage0.data, prompt), {
      instruction: input.instruction ?? null,
      regenerate: input.regenerate,
    });
    const blocked = [...problems, ...sent.problems];

    return ok({
      approved: stage0.data.approved,
      correction: sent.correction,
      created: [],
      minimumScenes: required,
      nextStep:
        blocked.length === 0
          ? `aimator screenplay generate ${input.projectId} ${input.episodeId}`
          : "usuń powyższe przeszkody przed płatnym wywołaniem",
      paidCalls: blocked.length === 0 ? 1 : 0,
      problems: blocked,
      prompt: sent.prompt,
      ready: blocked.length === 0,
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
      instruction: input.instruction ?? null,
      maxOutputTokens: input.maxOutputTokens,
      model: input.model ?? "",
      regenerate: input.regenerate,
      // This stage publishes exactly what the model returned, with no renderer
      // of its own, so there is nothing here a republication could repair.
      republish: false,
      workspace: input.workspace,
    },
    stage(input, paths.data, stage0.data, prompt)
  );

  if (!attempt.ok) {
    return attempt;
  }

  return ok({
    approved: false,
    correction: attempt.data.correction,
    created: attempt.data.created,
    minimumScenes: required,
    nextStep: `oceń scenariusz, a potem: aimator approve ${input.projectId} ${input.episodeId} --stage screenplay`,
    // One screenplay costs one call, whether this invocation made it or
    // finished an attempt whose answer was already on disk and already paid.
    paidCalls: 1,
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
    prompt,
    promptVersion: PROMPT_VERSION,
    publish: (publication) => publish(input, paths, stage0, publication),
    replaced: () => replaced(paths),
    result: paths.screenplay,
    stagePath: paths.screenplayStage,
    what: "scenariusz",
  };
}

/** The screenplay a regeneration is about to replace. */
async function replaced(paths: EpisodePaths): Promise<readonly Replaced[]> {
  const previous = await readDigest(paths.screenplay);

  return previous.ok ? [{ name: "screenplay.md", text: previous.data.bytes.toString("utf8") }] : [];
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
        `${verdict.error.message}. Odpowiedź zachowano w ${toWorkspacePath(input.workspace.root, archive.response)}, to błąd formatu wyniku, nie powód do --regenerate.`
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

/** What stands in the way of `--verbatim`, and what it would replace. */
interface Adoption {
  readonly problems: readonly string[];
  readonly verdict: ScreenplayVerdict | null;
}

/**
 * `--verbatim`: a screenplay stage 0 already holds, published as it is.
 *
 * The gate is generation's, minus the model and the key because nothing is
 * bought, plus the two conditions that make "as it is" honest: the episode
 * says its source is a screenplay, and that source passes the verdict a paid
 * answer would have to. It reads `source.md` alone, stage 0's own copy, so
 * nothing from outside the workspace enters here and stage 0 keeps that
 * monopoly. The record says `manual`, because a person wrote these bytes.
 */
async function adopt(
  input: GenerateInput,
  paths: EpisodePaths,
  stage0: Stage0Inputs
): Promise<Result<ScreenplayReport>> {
  const report = {
    approved: false,
    correction: null,
    minimumScenes: minimumScenes(stage0.settings.durationSeconds),
    paidCalls: 0,
    prompt: null,
  };

  if (input.mode === "dry-run") {
    const { problems, verdict } = await adoption(input, paths, stage0);

    return ok({
      ...report,
      approved: stage0.approved,
      created: [],
      nextStep:
        problems.length === 0
          ? `aimator screenplay generate ${input.projectId} ${input.episodeId} --verbatim${input.regenerate ? " --regenerate" : ""}`
          : "usuń powyższe przeszkody przed przyjęciem scenariusza",
      problems,
      ready: problems.length === 0,
      runId: null,
      verdict,
    });
  }

  const lock = await writeNew(
    paths.screenplayLock,
    serialize({ pid: process.pid, startedAt: nowIso() })
  );

  if (!lock.ok) {
    return err(
      new Stage1BlockedError(
        [
          `inna próba trzyma blokadę ${toWorkspacePath(input.workspace.root, paths.screenplayLock)}`,
        ],
        VERBATIM_BLOCKED
      )
    );
  }

  try {
    const { problems, verdict } = await adoption(input, paths, stage0);

    if (problems.length > 0 || verdict === null) {
      return err(new Stage1BlockedError(problems, VERBATIM_BLOCKED));
    }

    const published = await publishVerbatim(input, paths);

    return published.ok
      ? ok({
          ...report,
          created: published.data.created,
          nextStep: `oceń scenariusz, a potem: aimator approve ${input.projectId} ${input.episodeId} --stage screenplay`,
          problems: [],
          ready: true,
          runId: published.data.runId,
          verdict,
        })
      : published;
  } finally {
    await removeFile(paths.screenplayLock);
  }
}

const VERBATIM_BLOCKED = "etap 1 nie może przyjąć source.md jako scenariusza";

async function adoption(
  input: GenerateInput,
  paths: EpisodePaths,
  stage0: Stage0Inputs
): Promise<Adoption> {
  const problems = stage0.approved
    ? []
    : [
        ...stage0.problems,
        `etap 0 musi mieć review.status = "approved" zanim etap 1 przyjmie scenariusz: aimator approve ${input.projectId}`,
      ];
  const nature = stage0.settings.sourceNature;
  const verdict =
    nature === "screenplay" ? validateScreenplay(stage0.source, stage0.settings) : null;

  if (nature !== "screenplay") {
    problems.push(
      `--verbatim przyjmuje tylko gotowy scenariusz, a odcinek ma sourceNature "${nature}"; zwykłe screenplay generate kupi adaptację`
    );
  } else if (verdict !== null && !verdict.ok) {
    problems.push(
      `source.md: ${verdict.error.message}`,
      "source.md nie przechodzi walidacji scenariusza; popraw źródło w etapie 0 albo zwykłe screenplay generate kupi adaptację"
    );
  }

  const file = await readJson(paths.screenplayStage, stageFileSchema);
  const record = file.ok ? file.data.artifacts[ARTIFACT] : undefined;

  if (record !== undefined && !input.regenerate) {
    problems.push(
      `scenariusz dla tego odcinka już ma próbę ${record.runId} (${record.status}); zastępuje ją wyłącznie --verbatim --regenerate`
    );
  }

  return { problems, verdict: verdict?.ok === true ? verdict.data : null };
}

/**
 * `source.md` copied to `screenplay.md`, and a record whose only input is it.
 *
 * A screenplay this replaces is kept in its own `runs/<runId>/previous/`, the
 * place a paid regeneration keeps one, because a regeneration is what this is.
 */
async function publishVerbatim(
  input: GenerateInput,
  paths: EpisodePaths
): Promise<Result<{ readonly created: readonly string[]; readonly runId: string }>> {
  const source = await readDigest(paths.source);

  if (!source.ok) {
    return source;
  }

  const runId = newRunId();
  const archive = runPaths(paths, runId);
  const previous = input.regenerate ? await replaced(paths) : [];
  const kept: { text: string; to: string }[] = [];

  for (const file of previous) {
    const to = previousFile(archive, file.name);

    if (!to.ok) {
      return to;
    }

    kept.push({ text: file.text, to: to.data });
  }

  const relative = (path: string): string => toWorkspacePath(input.workspace.root, path);
  const record = newRecord({
    inputs: [{ path: relative(paths.source), sha256: source.data.sha256 }],
    outputs: [{ path: relative(paths.screenplay), sha256: source.data.sha256 }],
    producer: manualProducer(),
    runId,
  });
  const written = await applyWrites(
    [
      ...kept.map((file) => ({ kind: "text" as const, ...file })),
      { bytes: source.data.bytes, kind: "bytes", to: paths.screenplay },
      {
        kind: "text",
        text: serialize({ ...emptyStage(ARTIFACT), artifacts: { [ARTIFACT]: record } }),
        to: paths.screenplayStage,
      },
    ],
    "apply"
  );

  return written.ok
    ? ok({
        created: [
          relative(paths.screenplay),
          relative(paths.screenplayStage),
          ...(kept.length > 0 ? [relative(archive.root)] : []),
        ],
        runId,
      })
    : written;
}
