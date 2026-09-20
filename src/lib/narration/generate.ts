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
import { err, ok, type Result } from "../result.js";
import { checkShotList } from "../shot-list/index.js";
import {
  type Publication,
  type Published,
  runTextStage,
  type TextStage,
} from "../text-model/index.js";
import { contextCharacters, runVoiceStage, type SpeechContext } from "../voice-model/index.js";
import { narrationAudio, previousFile, type RunPaths, type Workspace } from "../workspace.js";
import { readDirection } from "./delivery.js";
import {
  missingSound,
  readStage9Inputs,
  SCRIPT,
  STAGE,
  Stage9BlockedError,
  type Stage9Inputs,
} from "./plan.js";
import { PROMPT_VERSION } from "./prompt.js";
import { type NarrationLine, type NarrationScript, validateNarration } from "./validate.js";

/**
 * Internal to the narration module: the command that buys the words.
 *
 * It has two halves and does the next one the gates allow, which is the shape
 * stage 2 has and for the same reason: the gates leave exactly one of them
 * executable. First the script, in one paid text call. Then the lines, one paid
 * speech call each, and only once a human has accepted the script — because
 * accepting the script is what authorises buying every sentence in it.
 *
 * The number this prints before it spends is **two numbers**. Every stage above
 * prints how many paid calls it is about to make, and for an image or a clip
 * that is the bill. Here it is not: this provider charges per character of the
 * text it is handed, so a count of calls says nothing about what an episode
 * costs. Both are printed, per line and in total, and neither is a price —
 * prices are the account holder's business and this tool has never guessed one.
 */

export interface LineOutcome {
  /** What this line costs, in the unit the provider actually charges. */
  readonly characters: number;
  /** What the neighbouring lines carry as context. Reported beside the bill, never in it. */
  readonly contextCharacters: number;
  readonly id: string;
  readonly note: string;
  /** How long the bought recording runs, once there is one. */
  readonly seconds: number | null;
  readonly state: "blocked" | "planned" | "published" | "resumed" | "skipped";
}

export interface NarrationReport {
  /** Whether a human has accepted the script, which is what opens the buying. */
  readonly approved: boolean;
  /** How many paid speech calls this run would make. */
  readonly calls: number;
  /** What those calls would be billed for. The count of calls is not the bill. */
  readonly characters: number;
  /**
   * What the continuity parameters carry, beside the bill rather than in it.
   *
   * The provider documents `previous_text` and `next_text` but does not say
   * whether they are charged for. Neither is rendered, so on any ordinary
   * reading of "billed per character converted to audio" they are free — but
   * this tool does not guess with somebody else's account, so the figure is on
   * screen and labelled as the one to add if that reading turns out wrong.
   */
  readonly contextCharacters: number;
  readonly created: readonly string[];
  readonly lines: readonly LineOutcome[];
  readonly nextStep: string;
  readonly problems: readonly string[];
  /** `--dry-run` only: the exact text the script call would send. */
  readonly prompt: string | null;
  readonly ready: boolean;
  readonly runId: string | null;
  /** What happened to the script itself. */
  readonly script: { note: string; state: LineOutcome["state"] };
}

interface GenerateInput {
  /** Narrows the buying to named utterances. Never narrows the script. */
  readonly artifacts: readonly string[];
  readonly episodeId: string;
  readonly fetch: typeof fetch;
  readonly maxOutputTokens: number;
  readonly mode: WriteMode;
  /** The text model that lifts the script. */
  readonly model: string | null;
  readonly openAiKey: string | null;
  readonly projectId: string;
  readonly regenerate: boolean;
  /** The speech model that reads it. */
  readonly voiceKey: string | null;
  readonly voiceModel: string | null;
  readonly workspace: Workspace;
}

/**
 * Why a paid call may not happen. Empty means it may.
 *
 * A dry run never reads a key, so it must not claim one is missing — it says
 * what it did not check instead. Claiming to have found an absence you never
 * looked for is the same lie as claiming a success you never had.
 */
function blockers(input: GenerateInput, stage9: Stage9Inputs): readonly string[] {
  const problems = [...stage9.gate];

  if (input.model === null || input.model === "") {
    problems.push(
      "brak modelu tekstowego — wskaż go przez --model <id> albo AIMATOR_NARRATION_MODEL"
    );
  }

  if (input.voiceModel === null || input.voiceModel === "") {
    problems.push("brak modelu mowy — wskaż go przez --voice-model <id> albo AIMATOR_VOICE_MODEL");
  }

  if (input.mode !== "dry-run") {
    if (input.openAiKey === null || input.openAiKey === "") {
      problems.push("brak OPENAI_API_KEY w środowisku lub .env");
    }

    if (input.voiceKey === null || input.voiceKey === "") {
      problems.push("brak ELEVENLABS_API_KEY w środowisku lub .env");
    }
  }

  return problems;
}

export async function generateNarration(input: GenerateInput): Promise<Result<NarrationReport>> {
  const stage9 = await readStage9Inputs(input);

  if (!stage9.ok) {
    return stage9;
  }

  const problems = blockers(input, stage9.data);
  const record = stage9.data.stage.artifacts[SCRIPT];
  const approved = record?.review.status === "approved";
  const script = await readScript(input, stage9.data);

  // `--regenerate` needs an addressee, exactly as it does in stages 2, 5 and 7:
  // a new attempt is a new charge and it has to be one somebody wrote down.
  if (input.regenerate && input.artifacts.length === 0 && record !== undefined) {
    return err(
      new Stage9BlockedError([
        "--regenerate wymaga jawnego --artifact: script albo N01[,N02]",
        "nowa płatna próba musi mieć adresata",
      ])
    );
  }

  const planned = outcomes(input, stage9.data, script, approved);

  if (input.mode === "dry-run") {
    return ok(preview(input, stage9.data, planned, problems, record !== undefined, approved));
  }

  if (problems.length > 0) {
    return err(new Stage9BlockedError(problems));
  }

  // The script first, because nothing can be bought until it exists and a human
  // has read it. Regenerating it is the only thing that re-runs a finished one.
  if (record === undefined || (input.regenerate && input.artifacts.includes(SCRIPT))) {
    return await lift(input, stage9.data);
  }

  if (!approved) {
    return ok(waiting(input, stage9.data, planned));
  }

  return await buy(input, stage9.data, planned);
}

/** The approved script as data, or null when there is none to read yet. */
async function readScript(
  input: GenerateInput,
  stage9: Stage9Inputs
): Promise<NarrationScript | null> {
  const text = await readDigest(stage9.paths.episode.narrationScript);
  const plan = await checkShotList(input);

  if (!(text.ok && plan.ok) || plan.data.verdict === null) {
    return null;
  }

  const verdict = validateNarration({
    shotList: plan.data.verdict,
    text: text.data.bytes.toString("utf8"),
  });

  return verdict.ok ? verdict.data : null;
}

/**
 * What the narrator says either side of a line, taken from the script itself.
 *
 * Derived, never stored — rule 7's mirror. The neighbouring lines *are* the
 * neighbouring lines, so writing them down anywhere would be a second copy of
 * the script that drifts the first time somebody re-lifts it. The provider uses
 * them so a sentence bought on its own is read as part of a paragraph rather
 * than as an isolated announcement, which is the other half of why the first
 * take sounded flat: every line was bought as if it were the only one.
 */
function contextOf(lines: readonly NarrationLine[], index: number): SpeechContext {
  return { next: lines[index + 1]?.text ?? null, previous: lines[index - 1]?.text ?? null };
}

/** What each line's state is before anything is bought, and what that would cost. */
function outcomes(
  input: GenerateInput,
  stage9: Stage9Inputs,
  script: NarrationScript | null,
  approved: boolean
): readonly LineOutcome[] {
  if (script === null) {
    return [];
  }

  const named = input.artifacts.filter((id) => id !== SCRIPT);

  return script.lines.map((line, index) => {
    const record = stage9.stage.artifacts[line.id];
    const wanted = named.length === 0 || named.includes(line.id);
    const base = {
      characters: line.characters,
      contextCharacters: contextCharacters(contextOf(script.lines, index)),
      id: line.id,
      seconds: null,
    };

    if (record?.status === "completed" && !(input.regenerate && named.includes(line.id))) {
      return { ...base, note: "kupione i gotowe", state: "skipped" as const };
    }

    if (!(approved && wanted)) {
      return {
        ...base,
        note: approved ? "poza --artifact" : "skrypt czeka na ocenę człowieka",
        state: approved ? ("skipped" as const) : ("blocked" as const),
      };
    }

    return { ...base, note: "gotowe do kupienia", state: "planned" as const };
  });
}

function preview(
  input: GenerateInput,
  stage9: Stage9Inputs,
  lines: readonly LineOutcome[],
  problems: readonly string[],
  exists: boolean,
  approved: boolean
): NarrationReport {
  const buying = lines.filter((line) => line.state === "planned");
  const blocked = problems.length > 0;
  const lifting = !exists || (input.regenerate && input.artifacts.includes(SCRIPT));

  return {
    approved,
    calls: buying.length,
    characters: buying.reduce((total, line) => total + line.characters, 0),
    contextCharacters: buying.reduce((total, line) => total + line.contextCharacters, 0),
    created: [],
    lines,
    nextStep: blocked
      ? "usuń powyższe przeszkody przed płatnym wywołaniem"
      : `aimator narration generate ${input.projectId} ${input.episodeId}`,
    problems: [...problems, ...missingSound(stage9.settings)],
    prompt: stage9.prompt,
    ready: !blocked,
    runId: null,
    script: lifting
      ? { note: "jedno płatne wywołanie tekstowe", state: blocked ? "blocked" : "planned" }
      : { note: approved ? "przyjęty" : "czeka na ocenę człowieka", state: "skipped" },
  };
}

/** The script exists and nobody has accepted it, so nothing may be bought. */
function waiting(
  input: GenerateInput,
  stage9: Stage9Inputs,
  lines: readonly LineOutcome[]
): NarrationReport {
  return {
    approved: false,
    calls: 0,
    characters: 0,
    contextCharacters: 0,
    created: [],
    lines,
    nextStep: `przeczytaj skrypt i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --artifact ${SCRIPT}`,
    problems: missingSound(stage9.settings),
    prompt: null,
    ready: false,
    runId: null,
    script: { note: "czeka na ocenę człowieka", state: "skipped" },
  };
}

/** The paid text call: the model reads the plan and says which prose is speech. */
async function lift(input: GenerateInput, stage9: Stage9Inputs): Promise<Result<NarrationReport>> {
  const { prompt, shotList } = stage9;

  if (prompt === null || shotList === null) {
    return err(new Stage9BlockedError(stage9.gate));
  }

  const attempt = await runTextStage(
    {
      apiKey: input.openAiKey ?? "",
      episode: stage9.paths.episode,
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
    textStage(input, stage9, prompt)
  );

  if (!attempt.ok) {
    return attempt;
  }

  return ok({
    approved: false,
    calls: 0,
    characters: 0,
    contextCharacters: 0,
    created: attempt.data.created,
    lines: attempt.data.value.lines.map((line, index) => ({
      characters: line.characters,
      contextCharacters: contextCharacters(contextOf(attempt.data.value.lines, index)),
      id: line.id,
      note: `${line.shot}, ${line.atSeconds}s planu`,
      seconds: null,
      state: "blocked" as const,
    })),
    nextStep: `przeczytaj skrypt i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --artifact ${SCRIPT}`,
    problems: missingSound(stage9.settings),
    prompt: null,
    ready: true,
    runId: attempt.data.runId,
    script: {
      note: `${attempt.data.value.lines.length} kwestii, ${attempt.data.value.totalCharacters} znaków do kupienia`,
      state: "published",
    },
  });
}

/** The half of the text attempt that is about a script rather than about paying. */
function textStage(
  input: GenerateInput,
  stage9: Stage9Inputs,
  prompt: string
): TextStage<NarrationScript> {
  const { episode } = stage9.paths;

  return {
    artifact: STAGE,
    blocked: (problems) => new Stage9BlockedError(problems),
    inputs: stage9.inputs,
    // The stage writes `soundtrack.stage.json`; the record inside it is the
    // script, beside one per bought utterance. Stage 9 is the first text stage
    // where those are two different words.
    key: SCRIPT,
    lock: episode.narrationLock,
    preserve: (archive) => preserve(episode.narrationScript, archive),
    prompt,
    promptVersion: PROMPT_VERSION,
    publish: (publication) => publishScript(input, stage9, publication),
    result: episode.narrationScript,
    stagePath: episode.soundtrackStage,
    what: "skrypt narracji",
  };
}

async function preserve(from: string, archive: RunPaths): Promise<void> {
  const previous = await readDigest(from);
  const to = previousFile(archive, "narration.md");

  if (previous.ok && to.ok) {
    await writeNew(to.data, previous.data.bytes.toString("utf8"));
  }
}

async function publishScript(
  input: GenerateInput,
  stage9: Stage9Inputs,
  publication: Publication
): Promise<Result<Published<NarrationScript>>> {
  const { archive, text } = publication;
  const { episode } = stage9.paths;
  const plan = await checkShotList(input);

  if (!plan.ok) {
    return plan;
  }

  if (plan.data.verdict === null) {
    return err(new Stage9BlockedError(["lista ujęć nie przechodzi walidacji"]));
  }

  const verdict = validateNarration({ shotList: plan.data.verdict, text });

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
      checkedAt: nowIso(),
      lines: verdict.data.lines.length,
      promptVersion: PROMPT_VERSION,
      structuralValidation: "passed",
      totalCharacters: verdict.data.totalCharacters,
    })
  );

  const outputs: RecordedFile[] = [
    {
      path: toWorkspacePath(input.workspace.root, episode.narrationScript),
      sha256: sha256Of(Buffer.from(text)),
    },
  ];
  const written = await applyWrites([{ kind: "text", text, to: episode.narrationScript }], "apply");

  return written.ok
    ? ok({
        created: [toWorkspacePath(input.workspace.root, episode.narrationScript)],
        outputs,
        value: verdict.data,
      })
    : written;
}

/**
 * The paid speech calls: one per utterance, in the script's order.
 *
 * The series stops at the first failure and keeps what came before it, exactly
 * as stages 5 and 7 do. Each line has its own record and its own `submitted`,
 * so an interrupted run leaves a mark against the one sentence it may have been
 * billed for rather than against the script.
 */
async function buy(
  input: GenerateInput,
  stage9: Stage9Inputs,
  planned: readonly LineOutcome[]
): Promise<Result<NarrationReport>> {
  const script = await readScript(input, stage9);

  if (script === null) {
    return err(
      new Stage9BlockedError(["skrypt narracji nie przechodzi walidacji wobec bieżącej listy ujęć"])
    );
  }

  const wanted = new Set(planned.filter((one) => one.state === "planned").map((one) => one.id));
  const bought: LineOutcome[] = [];
  const created: string[] = [];
  // The script is a recorded input of every line bought from it: a recording
  // published against a script somebody has since rewritten would put words in
  // the film that the approved document does not contain.
  const digest = await readDigest(stage9.paths.episode.narrationScript);

  if (!digest.ok) {
    return digest;
  }

  // How the narrator reads is the other half of what produced these bytes, so
  // it is recorded beside the script. That is also what keeps the decision
  // cheap to revisit: it lapses the recordings it made and nothing above them.
  const direction = await readDirection(input);

  if (!direction.ok) {
    return direction;
  }

  const inputs: readonly RecordedFile[] = [
    ...stage9.inputs,
    {
      path: toWorkspacePath(input.workspace.root, stage9.paths.episode.narrationScript),
      sha256: digest.data.sha256,
    },
    ...(direction.data.input === null ? [] : [direction.data.input]),
  ];

  for (const [index, line] of script.lines.entries()) {
    const already = planned.find((one) => one.id === line.id);

    if (!wanted.has(line.id)) {
      bought.push(already ?? { ...blank(line.id, line.characters), state: "skipped" });
      continue;
    }

    const target = narrationAudio(stage9.paths.episode, line.id);

    if (!target.ok) {
      return target;
    }

    // biome-ignore lint/performance/noAwaitInLoops: one paid call at a time, in the script's order
    const attempt = await runVoiceStage(
      {
        apiKey: input.voiceKey ?? "",
        delivery: direction.data.delivery,
        fetch: input.fetch,
        model: input.voiceModel ?? "",
        regenerate: input.regenerate,
        runs: stage9.paths.episode.runs,
        voiceId: stage9.narratorVoiceId ?? "",
        workspace: input.workspace,
      },
      {
        blocked: (problems) => new Stage9BlockedError(problems),
        context: contextOf(script.lines, index),
        inputs,
        key: line.id,
        stage: STAGE,
        stagePath: stage9.paths.episode.soundtrackStage,
        target: target.data,
        text: line.text,
      }
    );

    if (!attempt.ok) {
      return attempt;
    }

    created.push(...attempt.data.created);
    bought.push({
      characters: attempt.data.characters,
      contextCharacters: contextCharacters(contextOf(script.lines, index)),
      id: line.id,
      note: attempt.data.note,
      seconds: attempt.data.verdict.seconds,
      state: attempt.data.state,
    });
  }

  const paid = bought.filter((one) => one.state !== "skipped" && one.state !== "blocked");
  const pending = bought.some((one) => one.state === "planned" || one.state === "blocked");

  return ok({
    approved: true,
    calls: paid.length,
    characters: paid.reduce((total, one) => total + one.characters, 0),
    contextCharacters: paid.reduce((total, one) => total + one.contextCharacters, 0),
    created,
    lines: bought,
    nextStep: pending
      ? `aimator narration generate ${input.projectId} ${input.episodeId}`
      : `odsłuchaj kwestie i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --artifact ${bought.map((one) => one.id).join(",")}`,
    problems: missingSound(stage9.settings),
    prompt: null,
    ready: true,
    runId: null,
    script: { note: "przyjęty", state: "skipped" },
  });
}

function blank(id: string, characters: number): Omit<LineOutcome, "state"> {
  return { characters, contextCharacters: 0, id, note: "", seconds: null };
}
