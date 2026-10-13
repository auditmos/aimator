import {
  applyWrites,
  type Correction,
  nowIso,
  type RecordedFile,
  readDigest,
  serialize,
  sha256Of,
  toWorkspacePath,
  type WriteMode,
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
import type { Workspace } from "../workspace.js";
import { readStage3Inputs, type Stage3Inputs } from "./plan.js";
import { PROMPT_VERSION } from "./prompt.js";
import { type ShotList, validateShotList } from "./validate.js";

/**
 * Internal to the shot-list module: the one command that spends money.
 *
 * The order of operations is the contract, and it lives in `lib/text-model`
 * rather than here: nothing is written in `--dry-run`, the stage file records
 * `submitted` before the POST, and nothing retries on its own. What stays here
 * is what is about a shot list, the gate, the structural verdict, and the one
 * file this stage publishes.
 */

const ARTIFACT = "shot-list";

export interface ShotListReport {
  /** Whether the screenplay this plan is drawn from carries an approval. */
  readonly approved: boolean;
  /** The note this attempt corrects by, and where it came from; `null` for a new plan. */
  readonly correction: Correction | null;
  readonly created: readonly string[];
  readonly nextStep: string;
  /**
   * The bill, in the unit this stage is billed in: text calls.
   *
   * Only ever one or zero, which is exactly why it is worth reporting rather
   * than assuming: the question a person asks before clicking is whether this
   * command is about to buy a shot list or tell them it cannot.
   */
  readonly paidCalls: number;
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
  /** A note correcting the published version; only with `regenerate`. */
  readonly instruction?: string | null;
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

/**
 * Why a paid call may not happen. Empty means it may.
 *
 * A dry run never reads the key, so it must not claim the key is missing, it
 * says what it did not check instead. Claiming to have found an absence you
 * never looked for is the same lie as claiming a success you never had.
 */
function blockers(input: GenerateInput, stage3: Stage3Inputs): readonly string[] {
  const problems = [...stage3.gate];

  if (input.model === null || input.model === "") {
    problems.push(
      "brak modelu tekstowego, wskaż go przez --model <id> albo AIMATOR_SHOTLIST_MODEL"
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
    const { prompt } = stage3.data;
    const sent =
      prompt === null
        ? { correction: null, problems: [], prompt: null }
        : await textPrompt(stage(input, stage3.data, prompt), {
            instruction: input.instruction ?? null,
            regenerate: input.regenerate,
          });
    const blocked = [...problems, ...sent.problems];

    return ok({
      approved: stage3.data.gate.length === 0,
      correction: sent.correction,
      created: [],
      nextStep:
        blocked.length === 0
          ? `aimator shot-list generate ${input.projectId} ${input.episodeId}`
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
    return err(new Stage3BlockedError(problems));
  }

  // The gate already refused a null prompt, so these are decided by now.
  const { prompt, screenplay, settings } = stage3.data;

  if (prompt === null || screenplay === null || settings === null) {
    return err(new Stage3BlockedError(stage3.data.gate));
  }

  const attempt = await runTextStage(
    {
      apiKey: input.apiKey ?? "",
      episode: stage3.data.paths.episode,
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
    stage(input, stage3.data, prompt)
  );

  if (!attempt.ok) {
    return attempt;
  }

  return ok({
    approved: false,
    correction: attempt.data.correction,
    created: attempt.data.created,
    nextStep: `oceń listę ujęć, a potem: aimator approve ${input.projectId} ${input.episodeId} --stage shot-list`,
    // One, including a resumed attempt: its answer was already on disk and
    // already paid for, so a count of nothing would make a bill disappear.
    paidCalls: 1,
    problems: [],
    prompt: null,
    ready: true,
    runId: attempt.data.runId,
    verdict: attempt.data.value,
  });
}

/** The half of the attempt that is about a shot list rather than about paying. */
function stage(input: GenerateInput, stage3: Stage3Inputs, prompt: string): TextStage<ShotList> {
  const { episode } = stage3.paths;

  return {
    artifact: ARTIFACT,
    blocked: (problems) => new Stage3BlockedError(problems),
    inputs: stage3.inputs,
    lock: episode.shotListLock,
    prompt,
    promptVersion: PROMPT_VERSION,
    publish: (publication) => publish(input, stage3, publication),
    replaced: () => replaced(episode.shotList),
    result: episode.shotList,
    stagePath: episode.shotListStage,
    what: "lista ujęć",
  };
}

/** The shot list a regeneration is about to replace. */
async function replaced(from: string): Promise<readonly Replaced[]> {
  const previous = await readDigest(from);

  return previous.ok ? [{ name: "shot-list.md", text: previous.data.bytes.toString("utf8") }] : [];
}

async function publish(
  input: GenerateInput,
  stage3: Stage3Inputs,
  publication: Publication
): Promise<Result<Published<ShotList>>> {
  const { archive, text } = publication;
  const { episode } = stage3.paths;

  if (stage3.screenplay === null || stage3.settings === null) {
    return err(new Stage3BlockedError(stage3.gate));
  }

  const verdict = validateShotList({
    cast: stage3.cast,
    screenplay: stage3.screenplay,
    settings: stage3.settings,
    text,
  });

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

  const outputs: RecordedFile[] = [
    {
      path: toWorkspacePath(input.workspace.root, episode.shotList),
      sha256: sha256Of(Buffer.from(text)),
    },
  ];
  const written = await applyWrites([{ kind: "text", text, to: episode.shotList }], "apply");

  return written.ok
    ? ok({
        created: [toWorkspacePath(input.workspace.root, episode.shotList)],
        outputs,
        value: verdict.data,
      })
    : written;
}
