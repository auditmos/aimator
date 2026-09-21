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
import { err, ok, type Result } from "../result.js";
import { checkShotList } from "../shot-list/index.js";
import { hasSound, validateVideo } from "../video-model/index.js";
import { validateSpeech } from "../voice-model/index.js";
import { episodeTrackPaths, type ImageTrack, narrationAudio, workspacePath } from "../workspace.js";
import { readDirection } from "./delivery.js";
import {
  missingSound,
  NARRATED,
  readStage9Inputs,
  readTrackTimeline,
  SCRIPT,
  STAGE,
  type Stage9Inputs,
  type Stage9Scope,
} from "./plan.js";
import { validateNarration } from "./validate.js";

/**
 * Internal to the narration module: verification, and the approval on top of it.
 *
 * Stage 9 is reviewed at two levels because it produces at two levels, and the
 * two questions are genuinely different.
 *
 * The **shared** review is about words and voices: does this script say what the
 * approved plan says, and does this reading sound like the narrator of this
 * series. It is answered once, because the answer does not depend on which of
 * the two films the line will sit over.
 *
 * The **per-track** review is "ocena odsłuchu" as the contract names it, and it
 * cannot be answered anywhere else: does the narrator land in the right place
 * over *this* picture. It is not a repetition of the line reviews above it, in
 * the same way stage 8's review of the whole is not a repetition of eight clip
 * reviews, a line that is perfectly read can still arrive two seconds late.
 *
 * `check` reads and reports; it writes nothing. `approve` repeats the whole
 * verification and only then records acceptance, bound to the bytes as they
 * now stand.
 */

export interface LineState {
  readonly approved: boolean;
  readonly characters: number;
  readonly id: string;
  /** Recorded inputs whose bytes on disk no longer match what this line used. */
  readonly inputsChanged: readonly string[];
  readonly note: string;
  readonly seconds: number | null;
  readonly state: "absent" | "completed" | "submitted";
}

export interface NarrationStatus {
  /** True once the script and every line carry a still-valid approval. */
  readonly approved: boolean;
  readonly lines: readonly LineState[];
  readonly nextStep: string;
  readonly problems: readonly string[];
  readonly script: LineState;
  /** The whole bill of the script, whether or not it has been paid yet. */
  readonly totalCharacters: number;
}

export interface MixStatus {
  readonly approved: boolean;
  readonly artifact: LineState;
  readonly nextStep: string;
  readonly problems: readonly string[];
  readonly track: ImageTrack;
}

type ApproveScope = Stage9Scope & {
  readonly artifacts: readonly string[];
  readonly mode: WriteMode;
  readonly note: string | null;
  readonly reviewer: string;
};

class NarrationStateError extends Error {
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[] = []) {
    super(
      problems.length === 0 ? message : `${message}\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "NarrationStateError";
    this.problems = problems;
  }
}

/** Which recorded inputs no longer match the bytes on disk. */
async function changedInputs(
  input: Stage9Scope,
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
  readonly stage9: Stage9Inputs;
  readonly status: NarrationStatus;
}

const ABSENT = { approved: false, characters: 0, inputsChanged: [], seconds: null } as const;

async function inspect(input: Stage9Scope): Promise<Result<Inspection>> {
  const stage9 = await readStage9Inputs(input);

  if (!stage9.ok) {
    return stage9;
  }

  const plan = await checkShotList(input);

  if (!plan.ok) {
    return plan;
  }

  const text = await readDigest(stage9.data.paths.episode.narrationScript);
  const record = stage9.data.stage.artifacts[SCRIPT];
  const blocking: string[] = [];

  if (record === undefined || !text.ok || plan.data.verdict === null) {
    return ok({
      blocking: [],
      inputs: stage9.data.inputs,
      stage9: stage9.data,
      status: {
        approved: false,
        lines: [],
        nextStep: `aimator narration generate ${input.projectId} ${input.episodeId}`,
        problems: [...stage9.data.gate, ...missingSound(stage9.data.settings)],
        script: {
          ...ABSENT,
          id: SCRIPT,
          note: stage9.data.gate.length > 0 ? stage9.data.gate.join("; ") : "jeszcze nie powstał",
          state: "absent",
        },
        totalCharacters: 0,
      },
    });
  }

  const [output] = record.outputs;

  if (output === undefined || output.sha256 !== text.data.sha256) {
    blocking.push("narration.md: nie zgadza się z zapisanym hashem, plik zmieniono poza próbą");
  }

  // Re-validated against the plan as it stands, exactly as a shot list is
  // re-validated against the screenplay: a shot list whose narration changed
  // stops this script validating rather than silently disagreeing with it.
  const verdict = validateNarration({
    shotList: plan.data.verdict,
    text: text.data.bytes.toString("utf8"),
  });

  if (!verdict.ok) {
    blocking.push(verdict.error.message);
  }

  const scriptChanged = await changedInputs(input, record.inputs);
  const scriptApproved =
    record.review.status === "approved" && blocking.length === 0 && scriptChanged.length === 0;
  // The script's own record is deliberately not bound to the reading: how a
  // line is spoken changes nothing about which sentences the model lifted.
  const direction = await readDirection(input);
  const lines = verdict.ok
    ? await readLineStates(
        input,
        stage9.data,
        verdict.data.lines,
        direction.ok ? direction.data.input : null
      )
    : { problems: [], states: [] };
  const approved = scriptApproved && lines.states.every((one) => one.approved);

  return ok({
    blocking,
    inputs: stage9.data.inputs,
    stage9: stage9.data,
    status: {
      approved,
      lines: lines.states,
      nextStep: nextStep(input, scriptApproved, lines.states),
      problems: [
        ...stage9.data.gate,
        ...blocking,
        ...scriptChanged.map(
          (path) =>
            `${path}: zmienił się od czasu spisania skryptu, przeczytaj skrypt jeszcze raz i zatwierdź ponownie`
        ),
        ...lines.problems,
        ...missingSound(stage9.data.settings),
      ],
      script: {
        approved: scriptApproved,
        characters: verdict.ok ? verdict.data.totalCharacters : 0,
        id: SCRIPT,
        inputsChanged: scriptChanged,
        note: verdict.ok ? `${verdict.data.lines.length} kwestii` : "nie przechodzi walidacji",
        seconds: null,
        state: "completed",
      },
      totalCharacters: verdict.ok ? verdict.data.totalCharacters : 0,
    },
  });
}

function nextStep(
  input: Stage9Scope,
  scriptApproved: boolean,
  lines: readonly LineState[]
): string {
  if (!scriptApproved) {
    return `przeczytaj skrypt i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --artifact ${SCRIPT}`;
  }

  const missing = lines.filter((one) => one.state !== "completed");

  if (missing.length > 0) {
    return `aimator narration generate ${input.projectId} ${input.episodeId}`;
  }

  const pending = lines.filter((one) => !one.approved);

  return pending.length > 0
    ? `odsłuchaj kwestie i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --artifact ${pending.map((one) => one.id).join(",")}`
    : `aimator narration mix ${input.projectId} ${input.episodeId} --track <gpt-image|seedream>`;
}

/**
 * Whether this line was bought before anybody decided how the narrator reads.
 *
 * `changedInputs` cannot see this, and the difference matters. It compares the
 * inputs a record *holds* against the bytes on disk, but a recording made
 * before `narration.json` existed holds no entry for it at all, so nothing
 * drifts and nothing is reported. The absence is therefore checked directly:
 * a line read on the provider's defaults is not a line read the way this series
 * was later decided to sound, and a check that stayed quiet would be presenting
 * a reading nobody chose as one somebody approved.
 */
function readingChanged(
  direction: RecordedFile | null,
  record: StageFile["artifacts"][string]
): boolean {
  return direction !== null && !record.inputs.some((one) => one.path === direction.path);
}

async function readLineStates(
  input: Stage9Scope,
  stage9: Stage9Inputs,
  lines: readonly { characters: number; id: string }[],
  direction: RecordedFile | null
): Promise<{ problems: readonly string[]; states: readonly LineState[] }> {
  const states: LineState[] = [];
  const problems: string[] = [];

  for (const line of lines) {
    // biome-ignore lint/performance/noAwaitInLoops: each line read once per check
    const one = await readLineState(input, stage9, line, direction);

    states.push(one.state);
    problems.push(...one.problems);
  }

  return { problems, states };
}

/** One bought line: is the recording there, is it speech, and did anybody accept it. */
async function readLineState(
  input: Stage9Scope,
  stage9: Stage9Inputs,
  line: { characters: number; id: string },
  direction: RecordedFile | null
): Promise<{ problems: readonly string[]; state: LineState }> {
  const record = stage9.stage.artifacts[line.id];
  const file = narrationAudio(stage9.paths.episode, line.id);
  const base = { characters: line.characters, id: line.id };

  if (record === undefined || !file.ok) {
    return { problems: [], state: { ...ABSENT, ...base, note: "nie kupiona", state: "absent" } };
  }

  // A record that stopped at `submitted` is one that may already have been
  // billed, and repeating the command finishes it from the archive rather than
  // paying again. Reported here so a person reads it before they reach for
  // --regenerate.
  if (record.status === "submitted") {
    return {
      problems: [
        `${line.id}: rekord "submitted" bez opublikowanego nagrania, powtórz polecenie, żeby dokończyć próbę bez drugiej opłaty`,
      ],
      state: {
        ...ABSENT,
        ...base,
        note: `próba ${record.runId} mogła zostać rozliczona`,
        state: "submitted",
      },
    };
  }

  const digest = await readDigest(file.data);
  const speech = digest.ok ? validateSpeech(digest.data.bytes) : null;
  const blocking = bytesProblems(line.id, record.outputs, digest, speech);
  const stale = readingChanged(direction, record);
  const inputsChanged = [
    ...(await changedInputs(input, record.inputs)),
    ...(stale && direction !== null ? [direction.path] : []),
  ];

  return {
    problems: [
      ...blocking,
      ...inputsChanged.map((path) =>
        stale && path === direction?.path
          ? `${line.id}: kupiona zanim ktokolwiek zdecydował, jak narrator czyta, poszła na domyślnych ustawieniach dostawcy; nowe brzmienie kupuje wyłącznie --regenerate`
          : `${line.id}: ${path} zmienił się od czasu nagrania, odsłuchaj je jeszcze raz`
      ),
    ],
    state: {
      ...base,
      approved:
        record.review.status === "approved" && blocking.length === 0 && inputsChanged.length === 0,
      inputsChanged,
      note: speech?.ok === true ? `${speech.data.seconds}s` : "nie przechodzi walidacji",
      seconds: speech?.ok === true ? speech.data.seconds : null,
      state: "completed",
    },
  };
}

/** Everything wrong with the bytes themselves: missing, changed, or not speech. */
function bytesProblems(
  id: string,
  outputs: readonly RecordedFile[],
  digest: Awaited<ReturnType<typeof readDigest>>,
  speech: ReturnType<typeof validateSpeech> | null
): readonly string[] {
  const [output] = outputs;

  if (!digest.ok) {
    return [`${id}: brakuje nagrania`];
  }

  const changed = output === undefined || output.sha256 !== digest.data.sha256;

  return [
    ...(changed ? [`${id}: nagranie nie zgadza się z zapisanym hashem`] : []),
    ...(speech !== null && !speech.ok ? [`${id}: ${speech.error.message}`] : []),
  ];
}

/** Reads and reports the shared half. Writes nothing; that is what makes it safe. */
export async function checkNarration(input: Stage9Scope): Promise<Result<NarrationStatus>> {
  const inspection = await inspect(input);

  return inspection.ok ? ok(inspection.data.status) : inspection;
}

/**
 * Records that a human read the script, or listened to named lines.
 *
 * `--artifact` is **required**, and harder here than in stage 5: accepting the
 * script authorises buying every sentence in it, and accepting a line opens the
 * mix. An approval nobody wrote down would spend money nobody agreed to.
 */
export async function approveNarration(input: ApproveScope): Promise<Result<NarrationStatus>> {
  if (input.artifacts.length === 0) {
    return err(
      new NarrationStateError(
        `--artifact jest wymagane: ${SCRIPT} albo N01[,N02], przyjęcie skryptu uruchamia kupowanie każdej kwestii, a przyjęcie kwestii otwiera miks`
      )
    );
  }

  const inspection = await inspect(input);

  if (!inspection.ok) {
    return inspection;
  }

  const { blocking, inputs, stage9, status } = inspection.data;
  const known = new Set([SCRIPT, ...status.lines.map((one) => one.id)]);
  const unknown = input.artifacts.filter((id) => !known.has(id));

  if (unknown.length > 0) {
    return err(
      new NarrationStateError(
        `--artifact "${unknown.join(", ")}", etap 9 zna tutaj ${[...known].join(", ")}`
      )
    );
  }

  const notReady = input.artifacts.filter((id) =>
    id === SCRIPT
      ? status.script.state !== "completed"
      : status.lines.find((one) => one.id === id)?.state !== "completed"
  );

  if (notReady.length > 0) {
    return err(
      new NarrationStateError(`nie ma czego zatwierdzić: ${notReady.join(", ")}`, status.problems)
    );
  }

  if (input.artifacts.includes(SCRIPT) && blocking.length > 0) {
    return err(
      new NarrationStateError("nie akceptuje się tego, co nie przechodzi walidacji", blocking)
    );
  }

  let file = stage9.stage;

  for (const id of input.artifacts) {
    file = withInputs(file, id, id === SCRIPT ? inputs : (file.artifacts[id]?.inputs ?? []));
  }

  const approved = approveArtifacts(file, input.artifacts, {
    note: input.note,
    reviewer: input.reviewer,
  });
  const written = await applyWrites(
    [{ kind: "text", text: serialize(approved), to: stage9.paths.episode.soundtrackStage }],
    input.mode
  );

  if (!written.ok) {
    return written;
  }

  const after = await inspect(input);

  return after.ok ? ok(after.data.status) : after;
}

/** Reads and reports one track's mix. Writes nothing. */
export async function checkMix(
  input: Stage9Scope & { readonly track: ImageTrack }
): Promise<Result<MixStatus>> {
  const inspection = await inspectMix(input);

  return inspection.ok ? ok(inspection.data.status) : inspection;
}

interface MixInspection {
  readonly blocking: readonly string[];
  readonly inputs: readonly RecordedFile[];
  readonly stage: StageFile;
  readonly stagePath: string;
  readonly status: MixStatus;
}

async function inspectMix(
  input: Stage9Scope & { readonly track: ImageTrack }
): Promise<Result<MixInspection>> {
  const stage9 = await readStage9Inputs(input);

  if (!stage9.ok) {
    return stage9;
  }

  const timeline = await readTrackTimeline(input, stage9.data.paths, stage9.data.aspectRatio);

  if (!timeline.ok) {
    return timeline;
  }

  const paths = episodeTrackPaths(stage9.data.paths.episode, input.track);
  const record = timeline.data.stage.artifacts[NARRATED];

  if (record === undefined) {
    return ok({
      blocking: [],
      inputs: [],
      stage: timeline.data.stage,
      stagePath: paths.soundtrackStage,
      status: {
        approved: false,
        artifact: { ...ABSENT, id: NARRATED, note: "jeszcze nie zmiksowany", state: "absent" },
        nextStep: `aimator narration mix ${input.projectId} ${input.episodeId} --track ${input.track}`,
        problems: [...timeline.data.gate, ...missingSound(stage9.data.settings)],
        track: input.track,
      },
    });
  }

  const [output] = record.outputs;
  const digest =
    output === undefined ? null : await readDigest(workspacePath(input.workspace, output.path));
  const blocking: string[] = [];

  if (output === undefined) {
    blocking.push(`${NARRATED}: rekord ukończony, ale nie wskazuje żadnego pliku`);
  } else if (!digest?.ok) {
    blocking.push(`${NARRATED}: brakuje ${output.path}`);
  } else if (digest.data.sha256 !== output.sha256) {
    blocking.push(`${NARRATED}: nie zgadza się z zapisanym hashem`);
  }

  const verdict =
    digest?.ok === true
      ? validateVideo(digest.data.bytes, {
          aspectRatio: stage9.data.aspectRatio,
          seconds: timeline.data.actualSeconds,
        })
      : null;

  if (verdict !== null && !verdict.ok) {
    blocking.push(`${NARRATED}: ${verdict.error.message}`);
  }

  if (digest?.ok === true && !hasSound(digest.data.bytes)) {
    blocking.push(`${NARRATED}: plik nie niesie ścieżki dźwiękowej`);
  }

  const inputsChanged = await changedInputs(input, record.inputs);
  const approved =
    record.review.status === "approved" && blocking.length === 0 && inputsChanged.length === 0;

  return ok({
    blocking,
    inputs: record.inputs,
    stage: timeline.data.stage,
    stagePath: paths.soundtrackStage,
    status: {
      approved,
      artifact: {
        approved,
        characters: 0,
        id: NARRATED,
        inputsChanged,
        note:
          verdict?.ok === true
            ? `${verdict.data.width}x${verdict.data.height}, ${verdict.data.seconds}s z narracją`
            : "nie przechodzi walidacji",
        seconds: verdict?.ok === true ? verdict.data.seconds : null,
        state: "completed",
      },
      nextStep: approved
        ? `odcinek "${input.episodeId}" na torze ${input.track} ma narrację i jest przyjęty`
        : `obejrzyj całość z narracją i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --track ${input.track}`,
      problems: [
        ...timeline.data.gate,
        ...blocking,
        ...inputsChanged.map(
          (path) =>
            `${path}: zmienił się od czasu miksu, obejrzyj odcinek jeszcze raz i zatwierdź ponownie albo zmiksuj go od nowa: aimator narration mix ${input.projectId} ${input.episodeId} --track ${input.track} --regenerate`
        ),
        ...missingSound(stage9.data.settings),
      ],
      track: input.track,
    },
  });
}

/**
 * Records "ocena odsłuchu" for one track.
 *
 * `--artifact` is not required, for the reason stage 8's is not: one artifact
 * per track, and nothing below it that an acceptance would buy.
 */
export async function approveMix(
  input: ApproveScope & { readonly track: ImageTrack }
): Promise<Result<MixStatus>> {
  const named = input.artifacts.filter((id) => id !== NARRATED);

  if (named.length > 0) {
    return err(
      new NarrationStateError(
        `--artifact "${named.join(", ")}", miks ma jeden artefakt na tor: ${NARRATED}`
      )
    );
  }

  const inspection = await inspectMix(input);

  if (!inspection.ok) {
    return inspection;
  }

  const { blocking, inputs, stage, stagePath, status } = inspection.data;

  if (status.artifact.state !== "completed") {
    return err(
      new NarrationStateError(
        `nie ma czego zatwierdzić: narracji nie położono na torze ${input.track}`,
        status.problems
      )
    );
  }

  if (blocking.length > 0) {
    return err(
      new NarrationStateError("nie akceptuje się tego, co nie przechodzi walidacji", blocking)
    );
  }

  const rebound = withInputs(stage, NARRATED, inputs);
  const approved = approveArtifacts(rebound, [NARRATED], {
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
    nextStep: `odcinek "${input.episodeId}" na torze ${input.track} ma narrację i jest przyjęty`,
  });
}
