import {
  applyWrites,
  approveArtifacts,
  driftableInputs,
  listEntries,
  readDigest,
  serialize,
  type WriteMode,
} from "../artifact/index.js";
import { showProject } from "../project/index.js";
import { err, ok, type Result } from "../result.js";
import { validateSpeech } from "../voice-model/index.js";
import { characterPaths, projectPaths, type Workspace, workspacePath } from "../workspace.js";
import {
  readVoiceInputs,
  SAMPLE,
  type VoiceInputs,
  type VoiceScope,
  VoiceStateError,
} from "./plan.js";

/**
 * Internal to the character-voice module: verification, and the approval that
 * sits on top of it but is never implied by it.
 *
 * An approval here answers "this is the voice", so it is bound to two things:
 * the sample's bytes, and the voice they were read in. A sample whose voice was
 * changed since is not stale in the way a drawing is, where looking again is
 * the whole remedy: it is a recording of somebody else, and accepting it would
 * accept a voice nobody heard. So that case is refused, and the remedy is a new
 * sample.
 */

export interface SampleState {
  readonly approved: boolean;
  readonly note: string;
  /** The length of the recording, read from its own header; null without one. */
  readonly seconds: number | null;
  readonly state: "absent" | "completed" | "submitted";
  /** True when the voice was changed after this sample was read in it. */
  readonly voiceChanged: boolean;
}

export interface VoiceStatus {
  /** True once the sample carries an approval its bytes and its voice still match. */
  readonly approved: boolean;
  readonly characterId: string;
  readonly language: string;
  readonly nextStep: string;
  readonly problems: readonly string[];
  readonly sample: SampleState;
  /** The voice as chosen now; null while nobody chose one. */
  readonly voiceId: string | null;
}

type ApproveScope = VoiceScope & {
  readonly mode: WriteMode;
  readonly note: string | null;
  readonly reviewer: string;
};

interface Inspection {
  /** What an approval may not write over: a broken, missing or unfinished sample. */
  readonly blocking: readonly string[];
  readonly inputs: VoiceInputs;
  readonly status: VoiceStatus;
}

/** The commands, built once, so a refusal and a next step cannot disagree. */
function steps(input: VoiceScope): Record<"approve" | "regenerate" | "sample" | "voice", string> {
  const scope = `${input.projectId} ${input.characterId} --language ${input.language}`;

  return {
    approve: `posłuchaj i zatwierdź: aimator approve ${input.projectId} ${input.characterId} --stage voice --language ${input.language}`,
    regenerate: `aimator character sample ${scope} --text "<zdanie>" --regenerate`,
    sample: `aimator character sample ${scope} --text "<zdanie>" --dry-run`,
    voice: `aimator character voice ${scope} --voice-id <id głosu>`,
  };
}

/** Whether any input the sample recorded no longer matches the bytes on disk. */
async function inputsChanged(input: VoiceScope, inputs: VoiceInputs): Promise<boolean> {
  const record = inputs.stage.artifacts[SAMPLE];

  if (record === undefined) {
    return false;
  }

  const digests = await Promise.all(
    driftableInputs(record).map(async (entry) => {
      const digest = await readDigest(workspacePath(input.workspace, entry.path));

      return digest.ok && digest.data.sha256 === entry.sha256;
    })
  );

  return digests.some((same) => !same);
}

/** The sample's bytes against its record: present, unchanged, and speech. */
async function verifySample(
  inputs: VoiceInputs
): Promise<{ blocking: readonly string[]; seconds: number | null }> {
  const record = inputs.stage.artifacts[SAMPLE];
  const [output] = record?.outputs ?? [];

  if (output === undefined) {
    return {
      blocking: ["sample: rekord ukończony, ale nie wskazuje żadnego pliku"],
      seconds: null,
    };
  }

  const digest = await readDigest(inputs.paths.sample);

  if (!digest.ok) {
    return { blocking: [`sample: brakuje ${output.path}`], seconds: null };
  }

  if (digest.data.sha256 !== output.sha256) {
    return {
      blocking: [
        `sample: ${output.path} nie zgadza się z zapisanym hashem, wynik został zmieniony poza narzędziem`,
      ],
      seconds: null,
    };
  }

  const verdict = validateSpeech(digest.data.bytes);

  return verdict.ok
    ? { blocking: [], seconds: verdict.data.seconds }
    : { blocking: [`sample: ${verdict.error.message}`], seconds: null };
}

async function inspect(input: VoiceScope): Promise<Result<Inspection>> {
  const inputs = await readVoiceInputs(input);

  if (!inputs.ok) {
    return inputs;
  }

  const step = steps(input);
  const { stage, voice } = inputs.data;
  const record = stage.artifacts[SAMPLE];
  const problems: string[] = [];
  const base = {
    characterId: input.characterId,
    language: input.language,
    voiceId: voice?.voiceId ?? null,
  };

  if (voice === null) {
    problems.push(
      `postać "${input.characterId}" nie ma głosu w języku ${input.language}: ${step.voice}`
    );
  }

  if (record === undefined) {
    return ok({
      blocking: [],
      inputs: inputs.data,
      status: {
        ...base,
        approved: false,
        nextStep: voice === null ? step.voice : step.sample,
        problems,
        sample: {
          approved: false,
          note: "jeszcze nie kupiona",
          seconds: null,
          state: "absent",
          voiceChanged: false,
        },
      },
    });
  }

  if (record.status === "submitted") {
    const blocking = [
      `sample: próba ${record.runId} zapisała status "submitted" i nigdy nie dobiegła końca, mogła zostać rozliczona; powtórz polecenie z tym samym --text, żeby dokończyć ją z zapisanej odpowiedzi, albo użyj --regenerate`,
    ];

    return ok({
      blocking,
      inputs: inputs.data,
      status: {
        ...base,
        approved: false,
        nextStep: step.regenerate,
        problems: [...problems, ...blocking],
        sample: {
          approved: false,
          note: `próba ${record.runId} nieukończona`,
          seconds: null,
          state: "submitted",
          voiceChanged: false,
        },
      },
    });
  }

  const verified = await verifySample(inputs.data);
  const voiceChanged = await inputsChanged(input, inputs.data);
  const approved =
    record.review.status === "approved" && verified.blocking.length === 0 && !voiceChanged;

  problems.push(...verified.blocking);

  if (voiceChanged) {
    problems.push(
      `voice.json: głos zmienił się od czasu próbki, to nagranie czyta kogoś innego; kup nową: ${step.regenerate}`
    );
  }

  let nextStep = step.approve;

  if (approved) {
    nextStep = `głos postaci "${input.characterId}" (${input.language}) jest obsadzony i wysłuchany`;
  } else if (voiceChanged) {
    nextStep = step.regenerate;
  }

  return ok({
    blocking: verified.blocking,
    inputs: inputs.data,
    status: {
      ...base,
      approved,
      nextStep,
      problems,
      sample: {
        approved,
        note:
          verified.seconds === null ? "nie udało się odczytać nagrania" : `${verified.seconds}s`,
        seconds: verified.seconds,
        state: "completed",
        voiceChanged,
      },
    },
  });
}

/** Reads and reports. Writes nothing; that is what makes it safe to run. */
export async function checkVoice(input: VoiceScope): Promise<Result<VoiceStatus>> {
  const inspection = await inspect(input);

  return inspection.ok ? ok(inspection.data.status) : inspection;
}

/**
 * Records that a human heard the sample and accepted the voice, bound to the
 * sample's bytes. It refuses a sample that does not verify, and a sample read
 * in a voice that is no longer the chosen one.
 */
export async function approveVoice(input: ApproveScope): Promise<Result<VoiceStatus>> {
  const inspection = await inspect(input);

  if (!inspection.ok) {
    return inspection;
  }

  const { blocking, inputs, status } = inspection.data;
  const problems = [...blocking];

  if (status.sample.state !== "completed") {
    problems.push(`sample: nie ma czego zatwierdzić (${status.sample.state})`);
  }

  if (status.sample.voiceChanged) {
    problems.push(
      `sample: czyta głos sprzed zmiany voice.json, a zgoda dotyczy głosu, który wybrano teraz; kup nową: ${steps(input).regenerate}`
    );
  }

  if (problems.length > 0) {
    return err(
      new VoiceStateError("nie akceptuje się tego, co nie przechodzi walidacji", problems)
    );
  }

  const approved = approveArtifacts(inputs.stage, [SAMPLE], {
    note: input.note,
    reviewer: input.reviewer,
  });
  const written = await applyWrites(
    [{ kind: "text", text: serialize(approved), to: inputs.paths.stage }],
    input.mode
  );

  if (!written.ok) {
    return written;
  }

  return ok({
    ...status,
    approved: true,
    nextStep: `głos postaci "${input.characterId}" (${input.language}) jest obsadzony i wysłuchany`,
    sample: { ...status.sample, approved: true },
  });
}

/** One character's voice in one language, described for a person deciding what to buy. */
export interface CastVoice {
  /** Whether the sample carries an approval its bytes and its voice still match. */
  readonly approved: boolean;
  readonly characterId: string;
  readonly language: string;
  readonly sample: SampleState["state"];
  /** Null when a sample exists for a language whose `voice.json` is gone. */
  readonly voiceId: string | null;
}

/**
 * Every voice of every cast member, in roster order and then by language.
 *
 * It answers through `checkVoice`, so a voice reads as approved here exactly
 * when the check would say so: one verdict asked twice, never two verdicts.
 */
export async function voicesOf(input: {
  readonly projectId: string;
  readonly workspace: Workspace;
}): Promise<Result<readonly CastVoice[]>> {
  const project = projectPaths(input.workspace, input.projectId);
  const shown = await showProject(input);

  if (!project.ok) {
    return project;
  }
  if (!shown.ok) {
    return shown;
  }

  const voices: CastVoice[] = [];

  for (const member of shown.data.cast) {
    const character = characterPaths(project.data, member.id);

    if (!character.ok) {
      return character;
    }

    // biome-ignore lint/performance/noAwaitInLoops: one cast member at a time, in roster order
    const languages = (await listEntries(character.data.voices))
      .filter((name) => !name.startsWith("."))
      .sort();

    for (const language of languages) {
      // biome-ignore lint/performance/noAwaitInLoops: each voice checked once, in order
      const status = await checkVoice({ ...input, characterId: member.id, language });

      if (!status.ok) {
        return status;
      }

      voices.push({
        approved: status.data.approved,
        characterId: member.id,
        language,
        sample: status.data.sample.state,
        voiceId: status.data.voiceId,
      });
    }
  }

  return ok(voices);
}
