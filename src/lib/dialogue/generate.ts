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
import { billedCharacters, DEFAULT_DELIVERY, runVoiceStage } from "../voice-model/index.js";
import { dialogueAudio, type Workspace } from "../workspace.js";
import {
  readStage11Inputs,
  readVoices,
  SCRIPT,
  type SpeakerVoice,
  STAGE,
  Stage11BlockedError,
  type Stage11Inputs,
} from "./plan.js";
import { PROMPT_VERSION } from "./prompt.js";
import { checkDialogue } from "./review.js";
import { type DialogueLine, type DialogueScript, validateDialogue } from "./validate.js";

/**
 * Internal to the dialogue module: the command that spends money.
 *
 * It has two halves and does the next one the gates allow, which is stage 9's
 * shape and for stage 9's reason. First the script, in one paid text call,
 * whose order of operations is `lib/text-model`'s. Then the lines, one paid
 * speech call each, and only once a human has accepted the script, because
 * accepting it is what authorises buying every line in it.
 *
 * Each line is read in its speaker's voice in the film's language, and each
 * voice gates its own speaker alone: a character whose sample nobody accepted
 * is held back with the reason, and everybody else is bought. The bill is two
 * numbers, calls and characters, because this provider charges per character.
 */

export interface LineOutcome {
  /** Who speaks it, and so whose voice it is bought in. */
  readonly cast: string;
  /** What this line costs, in the unit the provider actually charges. */
  readonly characters: number;
  readonly id: string;
  readonly note: string;
  /** How long the bought recording runs, once there is one. */
  readonly seconds: number | null;
  readonly state: "blocked" | "planned" | "published" | "resumed" | "skipped";
}

export interface DialogueReport {
  /**
   * What the speech calls of this run are billed for. Printed beside
   * `paidCalls` and never added to it: the count of calls is not the bill.
   */
  readonly characters: number;
  /** The note this attempt corrects by, and where it came from; `null` for none. */
  readonly correction: Correction | null;
  readonly created: readonly string[];
  /** Every line of the accepted script and what this run does with it; empty before one. */
  readonly lines: readonly LineOutcome[];
  readonly nextStep: string;
  /** What the published script says without refusing: a voice from off screen. */
  readonly notices: readonly string[];
  /** How many paid calls this run makes: the script's one text call, or one speech call per line. */
  readonly paidCalls: number;
  readonly problems: readonly string[];
  /** `--dry-run` only: the exact text a paid call would send. */
  readonly prompt: string | null;
  readonly ready: boolean;
  readonly runId: string | null;
  readonly verdict: DialogueScript | null;
}

interface GenerateInput {
  /** The text model's key, which only the script needs. */
  readonly apiKey: string | null;
  /** Narrows the buying to named lines, or names the script to regenerate it. */
  readonly artifacts: readonly string[];
  readonly episodeId: string;
  readonly fetch: typeof fetch;
  /** A note correcting the published version; only with `regenerate`. */
  readonly instruction?: string | null;
  readonly maxOutputTokens: number;
  readonly mode: WriteMode;
  /** The text model that lifts the script. */
  readonly model: string | null;
  readonly projectId: string;
  readonly regenerate: boolean;
  /** The speech provider's key, which only the lines need. */
  readonly voiceKey: string | null;
  /** The speech model that reads them. */
  readonly voiceModel: string | null;
  readonly workspace: Workspace;
}

/**
 * Why the script's paid call may not happen. Empty means it may. A dry run
 * never reads the key, so it never claims one is missing.
 */
function scriptBlockers(input: GenerateInput, stage11: Stage11Inputs): readonly string[] {
  const problems = [...stage11.gate];

  if (input.model === null || input.model === "") {
    problems.push(
      "brak modelu tekstowego, wskaż go przez --model <id> albo AIMATOR_DIALOGUE_MODEL"
    );
  }

  if (input.mode !== "dry-run" && (input.apiKey === null || input.apiKey === "")) {
    problems.push("brak OPENAI_API_KEY w środowisku lub .env");
  }

  return problems;
}

/** Why no line may be bought at all, whoever speaks it. Empty means one may. */
function speechBlockers(input: GenerateInput): readonly string[] {
  const problems: string[] = [];

  if (input.voiceModel === null || input.voiceModel === "") {
    problems.push(
      "brak modelu mowy, wskaż go przez --voice-model <id> albo AIMATOR_DIALOGUE_VOICE_MODEL"
    );
  }

  if (input.mode !== "dry-run" && (input.voiceKey === null || input.voiceKey === "")) {
    problems.push("brak ELEVENLABS_API_KEY w środowisku lub .env");
  }

  return problems;
}

export async function generateDialogue(input: GenerateInput): Promise<Result<DialogueReport>> {
  const stage11 = await readStage11Inputs(input);

  if (!stage11.ok) {
    return stage11;
  }

  const record = stage11.data.stage.artifacts[SCRIPT];

  // `--regenerate` needs an addressee, as in stage 9: a new attempt is a new
  // charge, and once the script exists it has to be one somebody wrote down.
  if (input.regenerate && input.artifacts.length === 0 && record !== undefined) {
    return err(
      new Stage11BlockedError([
        `--regenerate wymaga jawnego --artifact: ${SCRIPT} albo D01[,D02]`,
        "nowa płatna próba musi mieć adresata",
      ])
    );
  }

  // An unfinished script attempt is finished by lifting again, which resumes it
  // from the archive without a second charge.
  const lifting =
    record === undefined ||
    record.status === "submitted" ||
    (input.regenerate && input.artifacts.includes(SCRIPT));

  return lifting ? await lift(input, stage11.data) : await speak(input, stage11.data);
}

/** The first half: the one paid text call that lifts the script. */
async function lift(input: GenerateInput, stage11: Stage11Inputs): Promise<Result<DialogueReport>> {
  const problems = scriptBlockers(input, stage11);
  const { prompt } = stage11;

  if (input.mode === "dry-run") {
    const sent =
      prompt === null
        ? { correction: null, problems: [], prompt: null }
        : await textPrompt(textStage(input, stage11, prompt), {
            instruction: input.instruction ?? null,
            regenerate: input.regenerate,
          });
    const blocked = [...problems, ...sent.problems];

    return ok({
      characters: 0,
      correction: sent.correction,
      created: [],
      lines: [],
      nextStep:
        blocked.length === 0
          ? `aimator dialogue generate ${input.projectId} ${input.episodeId}`
          : "usuń powyższe przeszkody przed płatnym wywołaniem",
      notices: [],
      paidCalls: blocked.length === 0 ? 1 : 0,
      problems: blocked,
      prompt: sent.prompt,
      ready: blocked.length === 0,
      runId: null,
      verdict: null,
    });
  }

  if (problems.length > 0 || prompt === null) {
    return err(new Stage11BlockedError(problems));
  }

  const attempt = await runTextStage(
    {
      apiKey: input.apiKey ?? "",
      episode: stage11.episode,
      fetch: input.fetch,
      format: null,
      instruction: input.instruction ?? null,
      maxOutputTokens: input.maxOutputTokens,
      model: input.model ?? "",
      regenerate: input.regenerate,
      // Published exactly as the model returned it, so nothing to repair.
      republish: false,
      workspace: input.workspace,
    },
    textStage(input, stage11, prompt)
  );

  if (!attempt.ok) {
    return attempt;
  }

  return ok({
    characters: 0,
    correction: attempt.data.correction,
    created: attempt.data.created,
    lines: [],
    nextStep: `przeczytaj skrypt i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --artifact ${SCRIPT}`,
    notices: attempt.data.value.notices,
    // One, including a resumed attempt: its answer was already paid for.
    paidCalls: 1,
    problems: [],
    prompt: null,
    ready: true,
    runId: attempt.data.runId,
    verdict: attempt.data.value,
  });
}

/**
 * The second half: one paid speech call per line, once the script is accepted.
 *
 * The script's acceptance is read through `checkDialogue`, so a script edited
 * by hand after its yes, or one whose plan has since changed, opens nothing:
 * the same verdict the check prints, asked once.
 */
async function speak(
  input: GenerateInput,
  stage11: Stage11Inputs
): Promise<Result<DialogueReport>> {
  const status = await checkDialogue(input);

  if (!status.ok) {
    return status;
  }

  const { approved } = status.data.script;
  const { lines } = status.data;
  const voices = await readVoices(
    input,
    lines.map((line) => line.cast),
    stage11.language
  );

  if (!voices.ok) {
    return voices;
  }

  const planned = outcomes(input, stage11, { approved, lines, voices: voices.data });
  const blocking = approved ? speechBlockers(input) : status.data.problems;
  const held = obstacles(planned, voices.data);

  if (input.mode === "dry-run" || !approved) {
    const buying = blocking.length === 0 ? planned.filter((one) => one.state === "planned") : [];

    return ok({
      characters: buying.reduce((total, one) => total + one.characters, 0),
      correction: null,
      created: [],
      lines: planned,
      nextStep: approved ? nextOf(input, planned, buying.length > 0) : status.data.nextStep,
      notices: status.data.notices,
      paidCalls: buying.length,
      problems: [...blocking, ...held],
      prompt: null,
      ready: buying.length > 0,
      runId: null,
      verdict: null,
    });
  }

  if (blocking.length > 0) {
    return err(new Stage11BlockedError(blocking));
  }

  return await buy(input, stage11, { lines, planned, voices: voices.data });
}

/** Why a line that would otherwise be bought is held back, once per speaker. */
function obstacles(
  planned: readonly LineOutcome[],
  voices: ReadonlyMap<string, SpeakerVoice>
): readonly string[] {
  const held = new Set(
    planned.filter((one) => one.state === "blocked").map((one) => voices.get(one.cast)?.obstacle)
  );

  return [...held].filter((one): one is string => typeof one === "string");
}

/** What each line's state is before anything is bought, and what it would cost. */
function outcomes(
  input: GenerateInput,
  stage11: Stage11Inputs,
  script: {
    readonly approved: boolean;
    readonly lines: readonly DialogueLine[];
    readonly voices: ReadonlyMap<string, SpeakerVoice>;
  }
): readonly LineOutcome[] {
  const named = input.artifacts.filter((id) => id !== SCRIPT);

  return script.lines.map((line) => {
    const record = stage11.stage.artifacts[line.id];
    const obstacle = script.voices.get(line.cast)?.obstacle ?? null;
    const base = {
      cast: line.cast,
      characters: billedCharacters(line.text),
      id: line.id,
      seconds: null,
    };

    if (record?.status === "completed" && !(input.regenerate && named.includes(line.id))) {
      return { ...base, note: "kupiona i gotowa", state: "skipped" as const };
    }

    if (!script.approved) {
      return { ...base, note: "skrypt czeka na ocenę człowieka", state: "blocked" as const };
    }

    if (named.length > 0 && !named.includes(line.id)) {
      return { ...base, note: "poza --artifact", state: "skipped" as const };
    }

    return obstacle === null
      ? { ...base, note: "gotowa do kupienia", state: "planned" as const }
      : { ...base, note: obstacle, state: "blocked" as const };
  });
}

/** What to do next, read off what this run leaves behind. */
function nextOf(input: GenerateInput, lines: readonly LineOutcome[], buying: boolean): string {
  if (buying) {
    return `aimator dialogue generate ${input.projectId} ${input.episodeId}`;
  }

  const fresh = lines.filter((one) => one.state === "published" || one.state === "resumed");
  const blocked = lines.find((one) => one.state === "blocked");

  if (fresh.length > 0) {
    return `odsłuchaj kwestie i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --artifact ${fresh.map((one) => one.id).join(",")}`;
  }

  return blocked === undefined
    ? `aimator check ${input.projectId} ${input.episodeId} --stage ${STAGE}`
    : blocked.note;
}

/**
 * The paid speech calls: one per line, in the script's order.
 *
 * The series stops at the first failure and keeps what came before it, as
 * stage 9's does. Each line has its own record and its own `submitted`, so an
 * interrupted run leaves a mark against the one line it may have been billed
 * for, and repeating the command finishes it from the archive unpaid.
 */
async function buy(
  input: GenerateInput,
  stage11: Stage11Inputs,
  script: {
    readonly lines: readonly DialogueLine[];
    readonly planned: readonly LineOutcome[];
    readonly voices: ReadonlyMap<string, SpeakerVoice>;
  }
): Promise<Result<DialogueReport>> {
  const digest = await readDigest(stage11.episode.dialogueScript);

  if (!digest.ok) {
    return digest;
  }

  // Exactly two inputs, and that is the decision rather than an omission: the
  // words, and the voice reading them. `project.json` is not one, so recasting
  // the narrator lapses no line, and changing one character's voice lapses
  // that character's lines and nobody else's.
  const words: RecordedFile = {
    path: toWorkspacePath(input.workspace.root, stage11.episode.dialogueScript),
    sha256: digest.data.sha256,
  };
  const bought: LineOutcome[] = [];
  const created: string[] = [];

  for (const line of script.lines) {
    const outcome = script.planned.find((one) => one.id === line.id);
    const voice = script.voices.get(line.cast);

    if (outcome === undefined) {
      continue;
    }

    if (
      outcome.state !== "planned" ||
      voice === undefined ||
      voice.file === null ||
      voice.voiceId === null
    ) {
      bought.push(outcome);
      continue;
    }

    const target = dialogueAudio(stage11.episode, stage11.language, line.id);

    if (!target.ok) {
      return target;
    }

    // biome-ignore lint/performance/noAwaitInLoops: one paid call at a time, in the script's order
    const attempt = await runVoiceStage(
      {
        apiKey: input.voiceKey ?? "",
        // The provider's defaults, sent explicitly, because the sample this
        // voice was accepted on was read the same way: a line has to sound like
        // the voice somebody heard.
        delivery: DEFAULT_DELIVERY,
        fetch: input.fetch,
        model: input.voiceModel ?? "",
        regenerate: input.regenerate,
        runs: stage11.episode.runs,
        voiceId: voice.voiceId,
        workspace: input.workspace,
      },
      {
        blocked: (problems) => new Stage11BlockedError(problems),
        // No neighbours: the provider's continuity context is for one voice
        // carrying on a paragraph, and the line before this one is usually
        // somebody else speaking.
        context: { next: null, previous: null },
        inputs: [words, voice.file],
        key: line.id,
        stage: STAGE,
        stagePath: stage11.episode.dialogueStage,
        target: target.data,
        text: line.text,
      }
    );

    if (!attempt.ok) {
      return attempt;
    }

    created.push(...attempt.data.created);
    bought.push({
      ...outcome,
      note: attempt.data.note,
      seconds: attempt.data.verdict.seconds,
      state: attempt.data.state,
    });
  }

  const paid = bought.filter((one) => one.state === "published" || one.state === "resumed");

  return ok({
    characters: paid.reduce((total, one) => total + one.characters, 0),
    correction: null,
    created,
    lines: bought,
    nextStep: nextOf(input, bought, false),
    notices: [],
    // Including a resumed line: its answer was already paid for.
    paidCalls: paid.length,
    problems: obstacles(bought, script.voices),
    prompt: null,
    ready: true,
    runId: null,
    verdict: null,
  });
}

/** The half of the text attempt that is about a script rather than about paying. */
function textStage(
  input: GenerateInput,
  stage11: Stage11Inputs,
  prompt: string
): TextStage<DialogueScript> {
  const { episode } = stage11;

  return {
    artifact: STAGE,
    blocked: (problems) => new Stage11BlockedError(problems),
    inputs: stage11.inputs,
    // The file holds the bought lines beside the script, as stage 9's does.
    key: SCRIPT,
    lock: episode.dialogueLock,
    prompt,
    promptVersion: PROMPT_VERSION,
    publish: (publication) => publish(input, stage11, publication),
    replaced: () => replaced(episode.dialogueScript),
    result: episode.dialogueScript,
    stagePath: episode.dialogueStage,
    what: "skrypt dialogu",
  };
}

async function replaced(from: string): Promise<readonly Replaced[]> {
  const previous = await readDigest(from);

  return previous.ok ? [{ name: "dialogue.md", text: previous.data.bytes.toString("utf8") }] : [];
}

async function publish(
  input: GenerateInput,
  stage11: Stage11Inputs,
  publication: Publication
): Promise<Result<Published<DialogueScript>>> {
  const { archive, text } = publication;
  const { episode, plan } = stage11;

  if (plan === null) {
    return err(new Stage11BlockedError(["lista ujęć nie przechodzi walidacji"]));
  }

  const verdict = validateDialogue({
    cast: stage11.cast.map((member) => member.id),
    shotList: plan,
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
      checkedAt: nowIso(),
      lines: verdict.data.lines.length,
      promptVersion: PROMPT_VERSION,
      structuralValidation: "passed",
    })
  );

  const outputs: RecordedFile[] = [
    {
      path: toWorkspacePath(input.workspace.root, episode.dialogueScript),
      sha256: sha256Of(Buffer.from(text)),
    },
  ];
  const written = await applyWrites([{ kind: "text", text, to: episode.dialogueScript }], "apply");

  return written.ok
    ? ok({
        created: [toWorkspacePath(input.workspace.root, episode.dialogueScript)],
        outputs,
        value: verdict.data,
      })
    : written;
}
