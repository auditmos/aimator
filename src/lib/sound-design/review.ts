import {
  applyWrites,
  approveArtifacts,
  type RecordedFile,
  readDigest,
  type StageFile,
  serialize,
  type WriteMode,
  withInputs,
} from "../artifact/index.js";
import { validateAudio } from "../audio-model/index.js";
import { err, ok, type Result } from "../result.js";
import { checkShotList } from "../shot-list/index.js";
import { hasSound, validateVideo } from "../video-model/index.js";
import { episodeTrackPaths, type ImageTrack, soundStem, workspacePath } from "../workspace.js";
import { readLevels } from "./levels.js";
import {
  CUES,
  MIXED,
  missingDialogue,
  readAcceptedStems,
  readStage10Inputs,
  readTrackState,
  STAGE,
  type Stage10Inputs,
  type Stage10Scope,
} from "./plan.js";
import { validateSoundDesign } from "./validate.js";

/**
 * Internal to the sound-design module: verification, and the approval on top
 * of it.
 *
 * Two levels, because stage 10 produces at two levels, and the two questions
 * are genuinely different, exactly as they are one row up.
 *
 * The **shared** review is about the sound itself: does this cue sheet
 * describe what the approved plan describes, and does what came back sound
 * like this series. It is answered once, because the answer does not depend on
 * which of the two films the bed will sit under.
 *
 * The **per-track** review is the contract's "ocena odsłuchu", and it cannot
 * be answered anywhere else: does the whole thing play over *this* picture. It
 * is not a repetition of the cue reviews above it, a bed that is beautiful on
 * its own can still fight the narrator, and only this file has both in it at
 * once.
 *
 * `check` reads and reports; it writes nothing. `approve` repeats the whole
 * verification and only then records acceptance, bound to the bytes as they
 * now stand.
 */

export interface CueState {
  readonly approved: boolean;
  readonly id: string;
  /** Recorded inputs whose bytes on disk no longer match what this cue used. */
  readonly inputsChanged: readonly string[];
  readonly note: string;
  readonly seconds: number | null;
  readonly state: "absent" | "completed" | "submitted";
}

export interface SoundDesignStatus {
  /** True once the sheet and every stem carry a still-valid approval. */
  readonly approved: boolean;
  readonly cues: readonly CueState[];
  readonly nextStep: string;
  /**
   * What this stage says without refusing: a declaration nothing here can
   * fulfil, a length that drifted, a price worth reading before spending.
   * Reported, never enforced, which is exactly why it is not a problem.
   */
  readonly notices: readonly string[];
  readonly problems: readonly string[];
  readonly sheet: CueState;
  /** The whole bill, in the unit the provider rates: seconds of audio. */
  readonly totalSeconds: number;
}

export interface MasterStatus {
  readonly approved: boolean;
  readonly artifact: CueState;
  readonly nextStep: string;
  /**
   * What this stage says without refusing: a declaration nothing here can
   * fulfil, a length that drifted, a price worth reading before spending.
   * Reported, never enforced, which is exactly why it is not a problem.
   */
  readonly notices: readonly string[];
  readonly problems: readonly string[];
  readonly track: ImageTrack;
}

type ApproveScope = Stage10Scope & {
  readonly artifacts: readonly string[];
  readonly mode: WriteMode;
  readonly note: string | null;
  readonly reviewer: string;
};

class SoundDesignStateError extends Error {
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[] = []) {
    super(
      problems.length === 0 ? message : `${message}\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "SoundDesignStateError";
    this.problems = problems;
  }
}

const ABSENT = { approved: false, inputsChanged: [], seconds: null } as const;

/** Which recorded inputs no longer match the bytes on disk. */
async function changedInputs(
  input: Stage10Scope,
  recorded: readonly RecordedFile[]
): Promise<readonly string[]> {
  const changed: string[] = [];

  for (const entry of recorded) {
    // biome-ignore lint/performance/noAwaitInLoops: each input read once per check
    const digest = await readDigest(workspacePath(input.workspace, entry.path));

    if (!digest.ok || digest.data.sha256 !== entry.sha256) {
      changed.push(entry.path);
    }
  }

  return changed;
}

interface Inspection {
  /** Problems an approval may not write over. Input drift is not among them. */
  readonly blocking: readonly string[];
  readonly inputs: readonly RecordedFile[];
  readonly stage10: Stage10Inputs;
  readonly status: SoundDesignStatus;
}

async function inspect(input: Stage10Scope): Promise<Result<Inspection>> {
  const stage10 = await readStage10Inputs(input);

  if (!stage10.ok) {
    return stage10;
  }

  const plan = await checkShotList(input);

  if (!plan.ok) {
    return plan;
  }

  const text = await readDigest(stage10.data.paths.episode.soundDesign);
  const record = stage10.data.stage.artifacts[CUES];
  const blocking: string[] = [];

  if (record === undefined || !text.ok || plan.data.verdict === null) {
    return ok({
      blocking: [],
      inputs: stage10.data.inputs,
      stage10: stage10.data,
      status: {
        approved: false,
        cues: [],
        nextStep: `aimator sound-design generate ${input.projectId} ${input.episodeId}`,
        notices: missingDialogue(stage10.data.settings),
        problems: stage10.data.gate,
        sheet: {
          ...ABSENT,
          id: CUES,
          note: stage10.data.gate.length > 0 ? stage10.data.gate.join("; ") : "jeszcze nie powstał",
          state: "absent",
        },
        totalSeconds: 0,
      },
    });
  }

  const [output] = record.outputs;

  if (output === undefined || output.sha256 !== text.data.sha256) {
    blocking.push("sound-design.md: nie zgadza się z zapisanym hashem, plik zmieniono poza próbą");
  }

  // Re-validated against the plan as it stands, exactly as a shot list is
  // re-validated against the screenplay: a plan whose shots changed stops this
  // sheet validating rather than silently disagreeing with it.
  const verdict = validateSoundDesign({
    shotList: plan.data.verdict,
    text: text.data.bytes.toString("utf8"),
  });

  if (!verdict.ok) {
    blocking.push(verdict.error.message);
  }

  const sheetChanged = await changedInputs(input, record.inputs);
  const sheetApproved =
    record.review.status === "approved" && blocking.length === 0 && sheetChanged.length === 0;
  const cues = verdict.ok
    ? await readCueStates(input, stage10.data, [
        ...verdict.data.music.map((cue) => ({ id: cue.id, seconds: cue.seconds })),
        ...verdict.data.effects.map((cue) => ({ id: cue.id, seconds: cue.seconds })),
      ])
    : { problems: [], states: [] };
  const approved = sheetApproved && cues.states.every((one) => one.approved);

  return ok({
    blocking,
    inputs: stage10.data.inputs,
    stage10: stage10.data,
    status: {
      approved,
      cues: cues.states,
      nextStep: nextStep(input, sheetApproved, cues.states),
      notices: missingDialogue(stage10.data.settings),
      problems: [
        ...stage10.data.gate,
        ...blocking,
        ...sheetChanged.map(
          (path) =>
            `${path}: zmienił się od czasu spisania arkusza, przeczytaj arkusz jeszcze raz i zatwierdź ponownie`
        ),
        ...cues.problems,
      ],
      sheet: {
        approved: sheetApproved,
        id: CUES,
        inputsChanged: sheetChanged,
        note: verdict.ok
          ? `${verdict.data.calls} wywołań, ${verdict.data.totalSeconds}s dźwięku`
          : "nie przechodzi walidacji",
        seconds: verdict.ok ? verdict.data.totalSeconds : null,
        state: "completed",
      },
      totalSeconds: verdict.ok ? verdict.data.totalSeconds : 0,
    },
  });
}

function nextStep(input: Stage10Scope, sheetApproved: boolean, cues: readonly CueState[]): string {
  if (!sheetApproved) {
    return `przeczytaj arkusz i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --artifact ${CUES}`;
  }

  const missing = cues.filter((one) => one.state !== "completed");

  if (missing.length > 0) {
    return `aimator sound-design generate ${input.projectId} ${input.episodeId}`;
  }

  const pending = cues.filter((one) => !one.approved);

  return pending.length > 0
    ? `odsłuchaj stemy i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --artifact ${pending.map((one) => one.id).join(",")}`
    : `aimator sound-design mix ${input.projectId} ${input.episodeId} --track <gpt-image|seedream>`;
}

async function readCueStates(
  input: Stage10Scope,
  stage10: Stage10Inputs,
  cues: readonly { id: string; seconds: number }[]
): Promise<{ problems: readonly string[]; states: readonly CueState[] }> {
  const states: CueState[] = [];
  const problems: string[] = [];

  for (const cue of cues) {
    // biome-ignore lint/performance/noAwaitInLoops: each cue read once per check
    const one = await readCueState(input, stage10, cue);

    states.push(one.state);
    problems.push(...one.problems);
  }

  return { problems, states };
}

/** One bought stem: is it there, is it audio, and did anybody accept it. */
async function readCueState(
  input: Stage10Scope,
  stage10: Stage10Inputs,
  cue: { id: string; seconds: number }
): Promise<{ problems: readonly string[]; state: CueState }> {
  const record = stage10.stage.artifacts[cue.id];
  const file = soundStem(stage10.paths.episode, cue.id);

  if (record === undefined || !file.ok) {
    return {
      problems: [],
      state: { ...ABSENT, id: cue.id, note: "nie kupione", state: "absent" },
    };
  }

  // A record that stopped at `submitted` may already have been billed, and
  // here a second attempt is the full price again, not a top-up. Repeating the
  // command finishes it from the archive instead. Said before somebody reaches
  // for --regenerate.
  if (record.status === "submitted") {
    return {
      problems: [
        `${cue.id}: rekord "submitted" bez opublikowanego dźwięku, powtórz polecenie, żeby dokończyć próbę bez drugiej opłaty`,
      ],
      state: {
        ...ABSENT,
        id: cue.id,
        note: `próba ${record.runId} mogła zostać rozliczona`,
        state: "submitted",
      },
    };
  }

  const digest = await readDigest(file.data);
  const audio = digest.ok ? validateAudio(digest.data.bytes) : null;
  const blocking = bytesProblems(cue.id, record.outputs, digest, audio);
  const inputsChanged = await changedInputs(input, record.inputs);

  return {
    problems: [
      ...blocking,
      ...inputsChanged.map(
        (path) => `${cue.id}: ${path} zmienił się od czasu zakupu, odsłuchaj go jeszcze raz`
      ),
    ],
    state: {
      approved:
        record.review.status === "approved" && blocking.length === 0 && inputsChanged.length === 0,
      id: cue.id,
      inputsChanged,
      note:
        audio?.ok === true
          ? `zamówiono ${cue.seconds}s, wróciło ${audio.data.seconds}s`
          : "nie przechodzi walidacji",
      seconds: audio?.ok === true ? audio.data.seconds : null,
      state: "completed",
    },
  };
}

/** Everything wrong with the bytes themselves: missing, changed, or not audio. */
function bytesProblems(
  id: string,
  outputs: readonly RecordedFile[],
  digest: Awaited<ReturnType<typeof readDigest>>,
  audio: ReturnType<typeof validateAudio> | null
): readonly string[] {
  const [output] = outputs;

  if (!digest.ok) {
    return [`${id}: brakuje dźwięku`];
  }

  const changed = output === undefined || output.sha256 !== digest.data.sha256;

  return [
    ...(changed ? [`${id}: dźwięk nie zgadza się z zapisanym hashem`] : []),
    ...(audio !== null && !audio.ok ? [`${id}: ${audio.error.message}`] : []),
  ];
}

/** Reads and reports the shared half. Writes nothing; that is what makes it safe. */
export async function checkSoundDesign(input: Stage10Scope): Promise<Result<SoundDesignStatus>> {
  const inspection = await inspect(input);

  return inspection.ok ? ok(inspection.data.status) : inspection;
}

/**
 * Records that a human read the cue sheet, or listened to named stems.
 *
 * `--artifact` is **required**, for stage 9's reason and with one more edge to
 * it: accepting the sheet authorises buying every cue in it, accepting a stem
 * opens the mix, and this provider charges the full price again for a second
 * attempt.
 */
export async function approveSoundDesign(input: ApproveScope): Promise<Result<SoundDesignStatus>> {
  if (input.artifacts.length === 0) {
    return err(
      new SoundDesignStateError(
        `--artifact jest wymagane: ${CUES} albo M01[,E02], przyjęcie arkusza uruchamia kupowanie każdego cue, a przyjęcie stemu otwiera miks`
      )
    );
  }

  const inspection = await inspect(input);

  if (!inspection.ok) {
    return inspection;
  }

  const { blocking, inputs, stage10, status } = inspection.data;
  const known = new Set([CUES, ...status.cues.map((one) => one.id)]);
  const unknown = input.artifacts.filter((id) => !known.has(id));

  if (unknown.length > 0) {
    return err(
      new SoundDesignStateError(
        `--artifact "${unknown.join(", ")}", etap 10 zna tutaj ${[...known].join(", ")}`
      )
    );
  }

  const notReady = input.artifacts.filter((id) =>
    id === CUES
      ? status.sheet.state !== "completed"
      : status.cues.find((one) => one.id === id)?.state !== "completed"
  );

  if (notReady.length > 0) {
    return err(
      new SoundDesignStateError(`nie ma czego zatwierdzić: ${notReady.join(", ")}`, status.problems)
    );
  }

  if (input.artifacts.includes(CUES) && blocking.length > 0) {
    return err(
      new SoundDesignStateError("nie akceptuje się tego, co nie przechodzi walidacji", blocking)
    );
  }

  let file = stage10.stage;

  for (const id of input.artifacts) {
    file = withInputs(file, id, id === CUES ? inputs : (file.artifacts[id]?.inputs ?? []));
  }

  const approved = approveArtifacts(file, input.artifacts, {
    note: input.note,
    reviewer: input.reviewer,
  });
  const written = await applyWrites(
    [{ kind: "text", text: serialize(approved), to: stage10.paths.episode.soundDesignStage }],
    input.mode
  );

  if (!written.ok) {
    return written;
  }

  const after = await inspect(input);

  return after.ok ? ok(after.data.status) : after;
}

/** Reads and reports one track's full mix. Writes nothing. */
export async function checkMaster(
  input: Stage10Scope & { readonly track: ImageTrack }
): Promise<Result<MasterStatus>> {
  const inspection = await inspectMaster(input);

  return inspection.ok ? ok(inspection.data.status) : inspection;
}

interface MasterInspection {
  readonly blocking: readonly string[];
  readonly inputs: readonly RecordedFile[];
  readonly stage: StageFile;
  readonly stagePath: string;
  readonly status: MasterStatus;
}

async function inspectMaster(
  input: Stage10Scope & { readonly track: ImageTrack }
): Promise<Result<MasterInspection>> {
  const stage10 = await readStage10Inputs(input);

  if (!stage10.ok) {
    return stage10;
  }

  const track = await readTrackState(input, stage10.data);

  if (!track.ok) {
    return track;
  }

  // Two gates here as well, and for stage 9's reason: the narrated cut has
  // to be accepted and so does every stem that would sit on it. A check that
  // reported only the first would call a track ready that the mix command
  // refuses, which is the one thing the ladder above must never be told.
  const stems = await readAcceptedStems(input);

  if (!stems.ok) {
    return stems;
  }

  const gate = [...track.data.gate, ...stems.data.gate];
  const paths = episodeTrackPaths(stage10.data.paths.episode, input.track);
  const record = track.data.stage.artifacts[MIXED];

  if (record === undefined) {
    return ok({
      blocking: [],
      inputs: [],
      stage: track.data.stage,
      stagePath: paths.soundDesignStage,
      status: {
        approved: false,
        artifact: { ...ABSENT, id: MIXED, note: "jeszcze nie zmiksowany", state: "absent" },
        nextStep: `aimator sound-design mix ${input.projectId} ${input.episodeId} --track ${input.track}`,
        notices: missingDialogue(stage10.data.settings),
        problems: gate,
        track: input.track,
      },
    });
  }

  const [output] = record.outputs;
  const digest =
    output === undefined ? null : await readDigest(workspacePath(input.workspace, output.path));
  const blocking: string[] = [];

  if (output === undefined) {
    blocking.push(`${MIXED}: rekord ukończony, ale nie wskazuje żadnego pliku`);
  } else if (!digest?.ok) {
    blocking.push(`${MIXED}: brakuje ${output.path}`);
  } else if (digest.data.sha256 !== output.sha256) {
    blocking.push(`${MIXED}: nie zgadza się z zapisanym hashem`);
  }

  const verdict =
    digest?.ok === true
      ? validateVideo(digest.data.bytes, {
          aspectRatio: stage10.data.aspectRatio,
          seconds: track.data.actualSeconds,
        })
      : null;

  if (verdict !== null && !verdict.ok) {
    blocking.push(`${MIXED}: ${verdict.error.message}`);
  }

  if (digest?.ok === true && !hasSound(digest.data.bytes)) {
    blocking.push(`${MIXED}: plik nie niesie ścieżki dźwiękowej`);
  }

  const levels = await readLevels(input);
  const inputsChanged = [
    ...(await changedInputs(input, record.inputs)),
    // A mix made before anybody dialled the levels holds no entry for
    // `mix.json`, so nothing drifts and `changedInputs` stays quiet. The
    // absence is checked directly, for `readingChanged`'s reason one row up:
    // a mix made on the starting values is not a mix made the way this series
    // was later decided to sound.
    ...(levels.ok &&
    levels.data.input !== null &&
    !record.inputs.some((one) => one.path === levels.data.input?.path)
      ? [levels.data.input.path]
      : []),
  ];
  const approved =
    record.review.status === "approved" && blocking.length === 0 && inputsChanged.length === 0;

  return ok({
    blocking,
    inputs: record.inputs,
    stage: track.data.stage,
    stagePath: paths.soundDesignStage,
    status: {
      approved,
      artifact: {
        approved,
        id: MIXED,
        inputsChanged,
        note:
          verdict?.ok === true
            ? `${verdict.data.width}x${verdict.data.height}, ${verdict.data.seconds}s z pełną ścieżką`
            : "nie przechodzi walidacji",
        seconds: verdict?.ok === true ? verdict.data.seconds : null,
        state: "completed",
      },
      nextStep: approved
        ? `odcinek "${input.episodeId}" na torze ${input.track} ma pełną ścieżkę i jest przyjęty`
        : `obejrzyj całość i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --track ${input.track}`,
      notices: missingDialogue(stage10.data.settings),
      problems: [
        ...gate,
        ...blocking,
        ...inputsChanged.map(
          (path) =>
            `${path}: zmienił się od czasu miksu, obejrzyj odcinek jeszcze raz i zatwierdź ponownie albo zmiksuj go od nowa: aimator sound-design mix ${input.projectId} ${input.episodeId} --track ${input.track} --regenerate`
        ),
      ],
      track: input.track,
    },
  });
}

/**
 * Records "ocena odsłuchu" for one track.
 *
 * `--artifact` is not required, for the reason stage 8's and stage 9's are
 * not: one artifact per track, and nothing below it that an acceptance would
 * buy.
 */
export async function approveMaster(
  input: ApproveScope & { readonly track: ImageTrack }
): Promise<Result<MasterStatus>> {
  const named = input.artifacts.filter((id) => id !== MIXED);

  if (named.length > 0) {
    return err(
      new SoundDesignStateError(
        `--artifact "${named.join(", ")}", pełny miks ma jeden artefakt na tor: ${MIXED}`
      )
    );
  }

  const inspection = await inspectMaster(input);

  if (!inspection.ok) {
    return inspection;
  }

  const { blocking, inputs, stage, stagePath, status } = inspection.data;

  if (status.artifact.state !== "completed") {
    return err(
      new SoundDesignStateError(
        `nie ma czego zatwierdzić: pełnej ścieżki nie złożono na torze ${input.track}`,
        status.problems
      )
    );
  }

  if (blocking.length > 0) {
    return err(
      new SoundDesignStateError("nie akceptuje się tego, co nie przechodzi walidacji", blocking)
    );
  }

  const rebound = withInputs(stage, MIXED, inputs);
  const approved = approveArtifacts(rebound, [MIXED], {
    note: input.note,
    reviewer: input.reviewer,
  });
  const written = await applyWrites(
    [{ kind: "text", text: serialize(approved), to: stagePath }],
    input.mode
  );

  if (!written.ok) {
    return written;
  }

  return ok({
    ...status,
    approved: true,
    artifact: { ...status.artifact, approved: true, inputsChanged: [] },
    nextStep: `odcinek "${input.episodeId}" na torze ${input.track} ma pełną ścieżkę i jest przyjęty`,
  });
}
