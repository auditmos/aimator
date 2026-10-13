import {
  nowIso,
  removeFile,
  serialize,
  toWorkspacePath,
  type WriteMode,
  writeNew,
} from "../artifact/index.js";
import { err, ok, type Result } from "../result.js";
import {
  billedCharacters,
  DEFAULT_DELIVERY,
  runVoiceStage,
  utteranceLength,
} from "../voice-model/index.js";
import {
  type RecordedVoice,
  readVoiceInputs,
  SAMPLE,
  STAGE,
  type VoiceInputs,
  type VoiceScope,
} from "./plan.js";

/**
 * Internal to the character-voice module: the command that spends money.
 *
 * One call buys one sample. Its bill is said twice before anything is sent,
 * in calls and in characters, because the provider charges for the sentence
 * rather than for the call. The sentence is the person's own and has no
 * default: a sentence nobody chose is a decision the tool would be making.
 */

export interface SampleReport {
  readonly characterId: string;
  /** Billed characters of the sentence this invocation is about; 0 when none is sent. */
  readonly characters: number;
  readonly created: readonly string[];
  readonly language: string;
  readonly nextStep: string;
  readonly note: string;
  /** How many billed speech calls this invocation is about, said before paying. */
  readonly paidCalls: number;
  readonly problems: readonly string[];
  readonly ready: boolean;
  readonly state: "blocked" | "planned" | "published" | "resumed" | "skipped";
  /** The sentence, exactly as it would be or was sent. */
  readonly text: string;
  /** The voice it is read in; null while nobody chose one. */
  readonly voiceId: string | null;
}

type GenerateInput = VoiceScope & {
  readonly apiKey: string | null;
  readonly fetch: typeof fetch;
  readonly mode: WriteMode;
  readonly model: string | null;
  readonly regenerate: boolean;
  readonly text: string;
};

/** Why a paid call may not happen. Its own class: nothing was sent. */
class SampleBlockedError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `próbka głosu nie może wykonać płatnego wywołania:\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "SampleBlockedError";
    this.problems = problems;
  }
}

const KEY_NAME = "ELEVENLABS_API_KEY";
const MODEL_NAME = "AIMATOR_DIALOGUE_VOICE_MODEL";

/** The command a person runs to say which voice this is. */
function voiceStep(input: VoiceScope): string {
  return `aimator character voice ${input.projectId} ${input.characterId} --language ${input.language} --voice-id <id głosu>`;
}

const SKIPPED = "próbka już istnieje; nową płatną próbę zaczyna wyłącznie --regenerate";

/**
 * A sample already bought, which only `--regenerate` buys again. An attempt
 * that never finished is not one: it is finished from its archive, unpaid.
 */
function finished(input: GenerateInput, inputs: VoiceInputs): boolean {
  return inputs.stage.artifacts[SAMPLE]?.status === "completed" && !input.regenerate;
}

/** What to do with a sample that exists: hear it, or pay for another. */
function existingStep(input: VoiceScope): string {
  return `posłuchaj i zatwierdź: aimator approve ${input.projectId} ${input.characterId} --stage voice --language ${input.language}, albo kup nową przez --regenerate`;
}

function nextOf(input: VoiceScope, state: SampleReport["state"], text: string): string {
  if (state === "planned") {
    return `aimator character sample ${input.projectId} ${input.characterId} --language ${input.language} --text "${text}"`;
  }

  return state === "skipped" ? existingStep(input) : "usuń przeszkody przed płatnym wywołaniem";
}

/** Why a paid call may not happen at all. Empty means it may. */
function blockers(input: GenerateInput, inputs: VoiceInputs, text: string): readonly string[] {
  const problems: string[] = [];
  const length = utteranceLength(text);

  if (inputs.voice === null) {
    problems.push(
      `postać "${input.characterId}" nie ma głosu w języku ${input.language}, wybierz go przez: ${voiceStep(input)}`
    );
  }

  if (!length.ok) {
    problems.push(`--text: ${length.error.message}`);
  }

  if (input.model === null || input.model === "") {
    problems.push(`brak modelu mowy, wskaż go przez --model <id> albo ${MODEL_NAME}`);
  }

  if (input.mode !== "dry-run" && (input.apiKey === null || input.apiKey === "")) {
    problems.push(`brak ${KEY_NAME} w środowisku lub .env`);
  }

  return problems;
}

export async function generateSample(input: GenerateInput): Promise<Result<SampleReport>> {
  const inputs = await readVoiceInputs(input);

  if (!inputs.ok) {
    return inputs;
  }

  const text = input.text.trim();
  const problems = blockers(input, inputs.data, text);

  if (input.mode === "dry-run") {
    return ok(preview(input, inputs.data, text, problems));
  }

  const { voice } = inputs.data;

  if (problems.length > 0 || voice === null) {
    return err(new SampleBlockedError(problems));
  }

  if (finished(input, inputs.data)) {
    return ok({
      characterId: input.characterId,
      characters: 0,
      created: [],
      language: input.language,
      nextStep: existingStep(input),
      note: SKIPPED,
      paidCalls: 0,
      problems: [],
      ready: true,
      state: "skipped",
      text,
      voiceId: voice.voiceId,
    });
  }

  const { lock } = inputs.data.paths;
  const held = await writeNew(lock, serialize({ pid: process.pid, startedAt: nowIso() }));

  if (!held.ok) {
    return err(
      new SampleBlockedError([
        `inna próba trzyma blokadę ${toWorkspacePath(input.workspace.root, lock)}, po awarii upewnij się, że poprzedni proces nie działa, zanim usuniesz ten plik`,
      ])
    );
  }

  try {
    return await buy(input, inputs.data, { text, voice });
  } finally {
    await removeFile(lock);
  }
}

async function buy(
  input: GenerateInput,
  inputs: VoiceInputs,
  data: { readonly text: string; readonly voice: RecordedVoice }
): Promise<Result<SampleReport>> {
  const { paths } = inputs;
  const attempt = await runVoiceStage(
    {
      apiKey: input.apiKey ?? "",
      // The provider's own defaults, sent explicitly, so the archive says what
      // produced these bytes. A reading of its own per character is not a
      // decision this tool has a place for yet.
      delivery: DEFAULT_DELIVERY,
      fetch: input.fetch,
      model: input.model ?? "",
      regenerate: input.regenerate,
      runs: paths.runs,
      voiceId: data.voice.voiceId,
      workspace: input.workspace,
    },
    {
      blocked: (problems) => new SampleBlockedError(problems),
      // A sample stands alone: nothing is said before or after it.
      context: { next: null, previous: null },
      inputs: [data.voice.file],
      key: SAMPLE,
      stage: STAGE,
      stagePath: paths.stage,
      target: paths.sample,
      text: data.text,
    }
  );

  if (!attempt.ok) {
    return attempt;
  }

  const published = attempt.data.state === "published";

  return ok({
    characterId: input.characterId,
    characters: published ? attempt.data.characters : 0,
    created: attempt.data.created,
    language: input.language,
    nextStep: `posłuchaj i zatwierdź: aimator approve ${input.projectId} ${input.characterId} --stage voice --language ${input.language}`,
    note: attempt.data.note,
    paidCalls: published ? 1 : 0,
    problems: [],
    ready: true,
    state: attempt.data.state,
    text: data.text,
    voiceId: data.voice.voiceId,
  });
}

/**
 * `--dry-run`: the sentence, the bill in calls and characters, no network, no
 * secret and no write. An obstacle blocks the call, so the bill is zero.
 */
function preview(
  input: GenerateInput,
  inputs: VoiceInputs,
  text: string,
  problems: readonly string[]
): SampleReport {
  let state: SampleReport["state"] = "planned";
  let note = "gotowe do płatnego wywołania";

  if (finished(input, inputs)) {
    state = "skipped";
    note = SKIPPED;
  } else if (problems.length > 0) {
    state = "blocked";
    note = "zablokowana przez przeszkody poniżej";
  }

  const planned = state === "planned";

  return {
    characterId: input.characterId,
    characters: planned ? billedCharacters(text) : 0,
    created: [],
    language: input.language,
    nextStep: nextOf(input, state, text),
    note,
    paidCalls: planned ? 1 : 0,
    problems: [
      ...problems,
      `${KEY_NAME} nie był czytany, próba na sucho nie sięga po sekrety; płatne wywołanie go wymaga`,
    ],
    ready: planned,
    state,
    text,
    voiceId: inputs.voice?.voiceId ?? null,
  };
}
