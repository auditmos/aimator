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
import { type AudioKind, runAudioStage } from "../audio-model/index.js";
import { err, ok, type Result } from "../result.js";
import { checkShotList } from "../shot-list/index.js";
import {
  type Publication,
  type Published,
  runTextStage,
  type TextStage,
} from "../text-model/index.js";
import { previousFile, type RunPaths, soundStem, type Workspace } from "../workspace.js";
import {
  CUES,
  missingDialogue,
  readSheet,
  readStage10Inputs,
  STAGE,
  Stage10BlockedError,
  type Stage10Inputs,
} from "./plan.js";
import { PROMPT_VERSION } from "./prompt.js";
import { type SoundDesignSheet, validateSoundDesign } from "./validate.js";

/**
 * Internal to the sound-design module: the command that buys the sound.
 *
 * Two halves, and it does the next one the gates allow, stage 9's shape, and
 * stage 2's before it. First the cue sheet, in one paid text call. Then the
 * stems, one paid audio call each, and only once a human has accepted the
 * sheet, because accepting the sheet is what authorises buying every cue in it.
 *
 * **The number this prints before it spends is two numbers**, and for a
 * different reason than stage 9's. There the count of calls stopped being the
 * bill because the provider charges per character of text; here it stops being
 * the bill because the provider rates **per minute of generated audio**. One
 * call for a ninety-second bed and one call for a half-second click are the
 * same number and nothing like the same money. So calls and seconds are both
 * printed, per cue and in total, and neither is a price, prices are the
 * account holder's business and this tool has never guessed one.
 *
 * The other thing worth saying out loud: this provider charges **at
 * generation**, not at download. A `--regenerate` is a second full charge, not
 * a top-up, and the report says so where somebody will read it.
 */

export interface CueOutcome {
  readonly id: string;
  readonly kind: AudioKind;
  readonly note: string;
  /** What the provider rates this cue on. */
  readonly seconds: number;
  readonly state: "blocked" | "planned" | "published" | "resumed" | "skipped";
}

export interface SoundDesignReport {
  /** Whether a human has accepted the cue sheet, which is what opens the buying. */
  readonly approved: boolean;
  /** How many paid audio calls this run would make. */
  readonly calls: number;
  readonly created: readonly string[];
  readonly cues: readonly CueOutcome[];
  readonly nextStep: string;
  /**
   * What this stage says without refusing: a declaration nothing here can
   * fulfil, a length that drifted, a price worth reading before spending.
   * Reported, never enforced, which is exactly why it is not a problem.
   */
  readonly notices: readonly string[];
  readonly problems: readonly string[];
  /** `--dry-run` only: the exact text the cue-sheet call would send. */
  readonly prompt: string | null;
  readonly ready: boolean;
  readonly runId: string | null;
  /** What those calls would be rated on. The count of calls is not the bill. */
  readonly seconds: number;
  /** What happened to the cue sheet itself. */
  readonly sheet: { note: string; state: CueOutcome["state"] };
}

interface GenerateInput {
  /** Narrows the buying to named cues. Never narrows the sheet. */
  readonly artifacts: readonly string[];
  /** The ElevenLabs key. Both audio call sites use it, as the speech one does. */
  readonly audioKey: string | null;
  /** The model that renders one effect. */
  readonly effectsModel: string | null;
  readonly episodeId: string;
  readonly fetch: typeof fetch;
  readonly maxOutputTokens: number;
  readonly mode: WriteMode;
  /** The text model that writes the cue sheet. */
  readonly model: string | null;
  /** The model that composes a bed. */
  readonly musicModel: string | null;
  readonly openAiKey: string | null;
  readonly projectId: string;
  readonly regenerate: boolean;
  readonly workspace: Workspace;
}

/**
 * Why a paid call may not happen. Empty means it may.
 *
 * A dry run never reads a key, so it must not claim one is missing, it says
 * what it did not check instead. Claiming to have found an absence you never
 * looked for is the same lie as claiming a success you never had.
 */
function blockers(input: GenerateInput, stage10: Stage10Inputs): readonly string[] {
  const problems = [...stage10.gate];

  if (input.model === null || input.model === "") {
    problems.push("brak modelu tekstowego, wskaż go przez --model <id> albo AIMATOR_SOUND_MODEL");
  }

  if (input.musicModel === null || input.musicModel === "") {
    problems.push(
      "brak modelu muzycznego, wskaż go przez --music-model <id> albo AIMATOR_MUSIC_MODEL"
    );
  }

  if (input.effectsModel === null || input.effectsModel === "") {
    problems.push(
      "brak modelu efektów, wskaż go przez --effects-model <id> albo AIMATOR_EFFECTS_MODEL"
    );
  }

  if (input.mode !== "dry-run") {
    if (input.openAiKey === null || input.openAiKey === "") {
      problems.push("brak OPENAI_API_KEY w środowisku lub .env");
    }

    if (input.audioKey === null || input.audioKey === "") {
      problems.push("brak ELEVENLABS_API_KEY w środowisku lub .env");
    }
  }

  return problems;
}

/** The provider's billing, said where somebody will read it before spending. */
const BILLING =
  "ElevenLabs wycenia muzykę i efekty ZA MINUTĘ wygenerowanego dźwięku i nalicza opłatę przy GENERACJI, nie przy pobraniu, więc --regenerate to druga pełna opłata, nie dopłata";

export async function generateSoundDesign(
  input: GenerateInput
): Promise<Result<SoundDesignReport>> {
  const stage10 = await readStage10Inputs(input);

  if (!stage10.ok) {
    return stage10;
  }

  const problems = blockers(input, stage10.data);
  const record = stage10.data.stage.artifacts[CUES];
  const approved = record?.review.status === "approved";
  const sheet = await readSheet(input, stage10.data);
  const parsed = sheet?.ok === true ? sheet.data : null;

  // `--regenerate` needs an addressee, exactly as it does in stages 2, 5, 7
  // and 9: a new attempt is a new charge and it has to be one somebody wrote
  // down. Here that matters more, because the charge is the full price again.
  if (input.regenerate && input.artifacts.length === 0 && record !== undefined) {
    return err(
      new Stage10BlockedError([
        "--regenerate wymaga jawnego --artifact: cues albo M01[,E02]",
        `nowa płatna próba musi mieć adresata; ${BILLING}`,
      ])
    );
  }

  const planned = outcomes(input, stage10.data, parsed, approved);

  if (input.mode === "dry-run") {
    return ok(preview(input, stage10.data, planned, problems, record !== undefined, approved));
  }

  if (problems.length > 0) {
    return err(new Stage10BlockedError(problems));
  }

  // The sheet first, because nothing can be bought until it exists and a human
  // has read it. Regenerating it is the only thing that re-runs a finished one.
  if (record === undefined || (input.regenerate && input.artifacts.includes(CUES))) {
    return await write(input, stage10.data);
  }

  if (!approved) {
    return ok(waiting(input, stage10.data, planned));
  }

  return await buy(input, stage10.data, parsed, planned);
}

/** Every cue of the sheet, flattened into the order they are bought in. */
function cuesOf(sheet: SoundDesignSheet): readonly {
  id: string;
  kind: AudioKind;
  seconds: number;
  text: string;
}[] {
  return [
    ...sheet.music.map((cue) => ({
      id: cue.id,
      kind: "music" as const,
      seconds: cue.seconds,
      text: cue.text,
    })),
    ...sheet.effects.map((cue) => ({
      id: cue.id,
      kind: "effect" as const,
      seconds: cue.seconds,
      text: cue.text,
    })),
  ];
}

/** What each cue's state is before anything is bought, and what it would be rated on. */
function outcomes(
  input: GenerateInput,
  stage10: Stage10Inputs,
  sheet: SoundDesignSheet | null,
  approved: boolean
): readonly CueOutcome[] {
  if (sheet === null) {
    return [];
  }

  const named = input.artifacts.filter((id) => id !== CUES);

  return cuesOf(sheet).map((cue) => {
    const record = stage10.stage.artifacts[cue.id];
    const wanted = named.length === 0 || named.includes(cue.id);
    const base = { id: cue.id, kind: cue.kind, seconds: cue.seconds };

    if (record?.status === "completed" && !(input.regenerate && named.includes(cue.id))) {
      return { ...base, note: "kupione i gotowe", state: "skipped" as const };
    }

    if (!(approved && wanted)) {
      return {
        ...base,
        note: approved ? "poza --artifact" : "arkusz czeka na ocenę człowieka",
        state: approved ? ("skipped" as const) : ("blocked" as const),
      };
    }

    return { ...base, note: "gotowe do kupienia", state: "planned" as const };
  });
}

function preview(
  input: GenerateInput,
  stage10: Stage10Inputs,
  cues: readonly CueOutcome[],
  problems: readonly string[],
  exists: boolean,
  approved: boolean
): SoundDesignReport {
  const buying = cues.filter((cue) => cue.state === "planned");
  const blocked = problems.length > 0;
  const writing = !exists || (input.regenerate && input.artifacts.includes(CUES));

  return {
    approved,
    calls: buying.length,
    created: [],
    cues,
    nextStep: blocked
      ? "usuń powyższe przeszkody przed płatnym wywołaniem"
      : `aimator sound-design generate ${input.projectId} ${input.episodeId}`,
    notices: [...missingDialogue(stage10.settings), BILLING],
    problems,
    prompt: stage10.prompt,
    ready: !blocked,
    runId: null,
    seconds: round(buying.reduce((total, cue) => total + cue.seconds, 0)),
    sheet: writing
      ? { note: "jedno płatne wywołanie tekstowe", state: blocked ? "blocked" : "planned" }
      : { note: approved ? "przyjęty" : "czeka na ocenę człowieka", state: "skipped" },
  };
}

/** The sheet exists and nobody has accepted it, so nothing may be bought. */
function waiting(
  input: GenerateInput,
  stage10: Stage10Inputs,
  cues: readonly CueOutcome[]
): SoundDesignReport {
  return {
    approved: false,
    calls: 0,
    created: [],
    cues,
    nextStep: `przeczytaj arkusz i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --artifact ${CUES}`,
    notices: missingDialogue(stage10.settings),
    problems: [],
    prompt: null,
    ready: false,
    runId: null,
    seconds: 0,
    sheet: { note: "czeka na ocenę człowieka", state: "skipped" },
  };
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/** The paid text call: the model reads the plan and writes the cue sheet. */
async function write(
  input: GenerateInput,
  stage10: Stage10Inputs
): Promise<Result<SoundDesignReport>> {
  const { prompt } = stage10;

  if (prompt === null) {
    return err(new Stage10BlockedError(stage10.gate));
  }

  const attempt = await runTextStage(
    {
      apiKey: input.openAiKey ?? "",
      episode: stage10.paths.episode,
      fetch: input.fetch,
      format: null,
      maxOutputTokens: input.maxOutputTokens,
      model: input.model ?? "",
      regenerate: input.regenerate,
      // This stage publishes exactly what the model returned, with no renderer
      // of its own, so there is nothing a republication could repair.
      republish: false,
      workspace: input.workspace,
    },
    textStage(input, stage10, prompt)
  );

  if (!attempt.ok) {
    return attempt;
  }

  const cues = cuesOf(attempt.data.value);

  return ok({
    approved: false,
    calls: 0,
    created: attempt.data.created,
    cues: cues.map((cue) => ({
      id: cue.id,
      kind: cue.kind,
      note: `${cue.seconds}s`,
      seconds: cue.seconds,
      state: "blocked" as const,
    })),
    nextStep: `przeczytaj arkusz i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --artifact ${CUES}`,
    notices: [...missingDialogue(stage10.settings), BILLING],
    problems: [],
    prompt: null,
    ready: true,
    runId: attempt.data.runId,
    seconds: round(attempt.data.value.totalSeconds),
    sheet: {
      note: `${attempt.data.value.calls} wywołań, ${round(attempt.data.value.totalSeconds)}s dźwięku do kupienia`,
      state: "published",
    },
  });
}

/** The half of the text attempt that is about a cue sheet rather than about paying. */
function textStage(
  input: GenerateInput,
  stage10: Stage10Inputs,
  prompt: string
): TextStage<SoundDesignSheet> {
  const { episode } = stage10.paths;

  return {
    artifact: STAGE,
    blocked: (problems) => new Stage10BlockedError(problems),
    inputs: stage10.inputs,
    key: CUES,
    lock: episode.soundDesignLock,
    preserve: (archive) => preserve(episode.soundDesign, archive),
    prompt,
    promptVersion: PROMPT_VERSION,
    publish: (publication) => publishSheet(input, stage10, publication),
    result: episode.soundDesign,
    stagePath: episode.soundDesignStage,
    what: "arkusz cue",
  };
}

async function preserve(from: string, archive: RunPaths): Promise<void> {
  const previous = await readDigest(from);
  const to = previousFile(archive, "sound-design.md");

  if (previous.ok && to.ok) {
    await writeNew(to.data, previous.data.bytes.toString("utf8"));
  }
}

async function publishSheet(
  input: GenerateInput,
  stage10: Stage10Inputs,
  publication: Publication
): Promise<Result<Published<SoundDesignSheet>>> {
  const { archive, text } = publication;
  const { episode } = stage10.paths;
  const plan = await checkShotList(input);

  if (!plan.ok) {
    return plan;
  }

  if (plan.data.verdict === null) {
    return err(new Stage10BlockedError(["lista ujęć nie przechodzi walidacji"]));
  }

  const verdict = validateSoundDesign({ shotList: plan.data.verdict, text });

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
      calls: verdict.data.calls,
      checkedAt: nowIso(),
      effects: verdict.data.effects.length,
      music: verdict.data.music.length,
      promptVersion: PROMPT_VERSION,
      structuralValidation: "passed",
      totalSeconds: verdict.data.totalSeconds,
    })
  );

  const outputs: RecordedFile[] = [
    {
      path: toWorkspacePath(input.workspace.root, episode.soundDesign),
      sha256: sha256Of(Buffer.from(text)),
    },
  ];
  const written = await applyWrites([{ kind: "text", text, to: episode.soundDesign }], "apply");

  return written.ok
    ? ok({
        created: [toWorkspacePath(input.workspace.root, episode.soundDesign)],
        outputs,
        value: verdict.data,
      })
    : written;
}

/** The paid audio calls: one per cue the approved sheet authorises. */
async function buy(
  input: GenerateInput,
  stage10: Stage10Inputs,
  sheet: SoundDesignSheet | null,
  planned: readonly CueOutcome[]
): Promise<Result<SoundDesignReport>> {
  if (sheet === null) {
    return err(new Stage10BlockedError(["arkusz cue nie przechodzi walidacji"]));
  }

  const wanted = new Set(planned.filter((cue) => cue.state === "planned").map((cue) => cue.id));
  const created: string[] = [];
  const done: CueOutcome[] = [];
  let runId: string | null = null;
  let { stage } = stage10;

  for (const cue of cuesOf(sheet)) {
    const outcome = planned.find((one) => one.id === cue.id);

    if (!wanted.has(cue.id)) {
      done.push(outcome ?? { ...cue, note: "pominięte", state: "skipped" });
      continue;
    }

    const target = soundStem(stage10.paths.episode, cue.id);

    if (!target.ok) {
      return target;
    }

    // biome-ignore lint/performance/noAwaitInLoops: one paid call at a time, in the sheet's order
    const attempt = await runAudioStage(
      {
        apiKey: input.audioKey ?? "",
        fetch: input.fetch,
        regenerate: input.regenerate && input.artifacts.includes(cue.id),
        runs: stage10.paths.episode.runs,
        workspace: input.workspace,
      },
      {
        blocked: (problems) => new Stage10BlockedError(problems),
        inputs: stage10.inputs,
        instrumental: stage10.instrumental,
        key: cue.id,
        kind: cue.kind,
        model: (cue.kind === "music" ? input.musicModel : input.effectsModel) ?? "",
        seconds: cue.seconds,
        stage: STAGE,
        stagePath: stage10.paths.episode.soundDesignStage,
        target: target.data,
        text: cue.text,
      }
    );

    if (!attempt.ok) {
      return attempt;
    }

    const { created: wrote, note, runId: id, seconds, stage: file, state } = attempt.data;

    created.push(...wrote);
    done.push({ id: cue.id, kind: cue.kind, note, seconds, state });
    runId = id;
    stage = file;
  }

  const bought = done.filter((cue) => cue.state === "published" || cue.state === "resumed");
  const pending = done.some((cue) => stage.artifacts[cue.id]?.review.status !== "approved");

  return ok({
    approved: true,
    calls: bought.length,
    created,
    cues: done,
    nextStep: pending
      ? `odsłuchaj i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --artifact ${done.map((cue) => cue.id).join(",")}`
      : `aimator sound-design mix ${input.projectId} ${input.episodeId} --track <tor>`,
    notices: missingDialogue(stage10.settings),
    problems: [],
    prompt: null,
    ready: true,
    runId,
    seconds: round(bought.reduce((total, cue) => total + cue.seconds, 0)),
    sheet: { note: "przyjęty", state: "skipped" },
  });
}
