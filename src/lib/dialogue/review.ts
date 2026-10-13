import {
  applyWrites,
  approveArtifacts,
  driftableInputs,
  type RecordedFile,
  readDigest,
  type StageFile,
  serialize,
  toWorkspacePath,
  type WriteMode,
  withAmendments,
  withInputs,
} from "../artifact/index.js";
import { err, ok, type Result } from "../result.js";
import { validateSpeech } from "../voice-model/index.js";
import { dialogueAudio, dialogueTranslation, workspacePath } from "../workspace.js";
import {
  readStage11Inputs,
  readTranslationTarget,
  SCRIPT,
  STAGE,
  type Stage11Inputs,
  type Stage11Scope,
  type TranslationTarget,
  translationKey,
} from "./plan.js";
import { type DialogueLine, validateDialogue, validateTranslation } from "./validate.js";

/**
 * Internal to the dialogue module: verification, and the approval on top of it.
 *
 * `check` reads and reports; it writes nothing. `approve` repeats the whole
 * verification and only then records acceptance, bound to the bytes as they
 * now stand. A script corrected by hand is a lapsed consent rather than an
 * error, and is still held to "lifted, not invented, nothing left behind".
 *
 * A bought line is accepted on its own, by a human who listened to it, and its
 * yes is bound to the recording and to the two things it was read from: the
 * script and its speaker's voice. A line whose voice has since been replaced
 * is a recording of somebody else, so its approval lapses, and accepting it
 * again is refused rather than recorded: the remedy is a new recording.
 */

export interface ScriptState {
  readonly approved: boolean;
  readonly id: typeof SCRIPT;
  /** Recorded inputs whose bytes on disk no longer match what the script used. */
  readonly inputsChanged: readonly string[];
  readonly note: string;
  readonly state: "absent" | "completed" | "submitted";
}

/** One line of the script, and where its recording stands. */
export interface LineState extends DialogueLine {
  /** True once a human accepted this recording and nothing it was read from changed. */
  readonly approved: boolean;
  /** Recorded inputs whose bytes on disk no longer match what this recording used. */
  readonly inputsChanged: readonly string[];
  readonly note: string;
  /** How long the recording runs, read from its own header; null without one. */
  readonly seconds: number | null;
  readonly state: "absent" | "completed" | "submitted";
}

/** The script in the episode's second language, and where its yes stands. */
export interface TranslationState {
  /**
   * True once a human accepted this translation, nothing it was made from
   * changed, and the script it translates is itself accepted.
   */
  readonly approved: boolean;
  /** Its key in `dialogue.stage.json`: `script-en`. */
  readonly id: string;
  /** Recorded inputs whose bytes on disk no longer match what the translation used. */
  readonly inputsChanged: readonly string[];
  /** The language of the mouths, which this script is written in. */
  readonly language: string;
  readonly note: string;
  readonly state: "absent" | "completed" | "submitted";
}

export interface DialogueStatus {
  /** The script, when a person corrected it by hand and nobody accepted that yet. */
  readonly amended: readonly string[];
  /**
   * True once the script and every line carry a still-valid approval. The
   * film's language only: a second one is the translation's own business.
   */
  readonly approved: boolean;
  /** The script as data, once it validates against the plan as it stands. */
  readonly lines: readonly LineState[];
  readonly nextStep: string;
  /** What this stage says without refusing: a voice from off screen. */
  readonly notices: readonly string[];
  readonly problems: readonly string[];
  readonly script: ScriptState;
  /** The script in the episode's second language; null while it names none. */
  readonly translation: TranslationState | null;
}

type ApproveScope = Stage11Scope & {
  readonly artifacts: readonly string[];
  readonly mode: WriteMode;
  readonly note: string | null;
  readonly reviewer: string;
};

class DialogueStateError extends Error {
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[] = []) {
    super(
      problems.length === 0 ? message : `${message}\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "DialogueStateError";
    this.problems = problems;
  }
}

interface Inspection {
  /** A hand-corrected script, with the digest it has now, what an approval accepts. */
  readonly amended: readonly RecordedFile[];
  /** Problems an approval of the script may not write over. Input drift is not among them. */
  readonly blocking: readonly string[];
  /** Per line, what an approval of that line may not write over. */
  readonly lineBlocking: ReadonlyMap<string, readonly string[]>;
  readonly stage11: Stage11Inputs;
  readonly status: DialogueStatus;
  readonly translation: TranslationInspection | null;
}

/** The translation as `approve` needs it: what it may not write over, and what it rebinds. */
interface TranslationInspection {
  /** A hand-corrected translation, with the digest it has now. */
  readonly amended: readonly RecordedFile[];
  readonly blocking: readonly string[];
  /** What the translation records, as the files stand now. */
  readonly inputs: readonly RecordedFile[];
  readonly problems: readonly string[];
  readonly state: TranslationState;
}

function changedInputs(
  recorded: readonly RecordedFile[],
  current: readonly RecordedFile[]
): readonly string[] {
  return recorded
    .filter(
      (entry) => !current.some((now) => now.path === entry.path && now.sha256 === entry.sha256)
    )
    .map((entry) => entry.path);
}

function approveCommand(input: Stage11Scope, key = SCRIPT): string {
  return `aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --artifact ${key}`;
}

/** What the script being translated is, as far as its translation's yes goes. */
interface Source {
  readonly approved: boolean;
  /** Its lines, or null while it does not validate. */
  readonly lines: readonly DialogueLine[] | null;
}

/**
 * The translation into the episode's second language, judged the way the
 * script is: a validating answer, its own yes, and the inputs it was made from.
 *
 * Its yes counts only while the script it translates holds its own, because a
 * translation of words nobody currently accepts accepts nothing.
 */
async function readTranslation(
  input: Stage11Scope,
  stage11: Stage11Inputs,
  target: TranslationTarget,
  source: Source
): Promise<TranslationInspection | null> {
  const path =
    target.language === null ? null : dialogueTranslation(stage11.episode, target.language);

  if (target.language === null || path === null || !path.ok) {
    return null;
  }

  const id = translationKey(target.language);
  const record = stage11.stage.artifacts[id];
  const base = { approved: false, id, inputsChanged: [], language: target.language } as const;
  const empty = { amended: [], blocking: [], inputs: target.inputs } as const;

  if (record === undefined) {
    return {
      ...empty,
      problems: [],
      state: { ...base, note: "jeszcze nie powstał", state: "absent" },
    };
  }

  if (record.status === "submitted") {
    return {
      ...empty,
      problems: [
        `${id}: rekord "submitted" bez opublikowanego przekładu, powtórz polecenie, żeby dokończyć próbę bez drugiej opłaty: aimator dialogue translate ${input.projectId} ${input.episodeId}`,
      ],
      state: { ...base, note: `próba ${record.runId} mogła zostać rozliczona`, state: "submitted" },
    };
  }

  const text = await readDigest(path.data);
  const [output] = record.outputs;
  const amended: readonly RecordedFile[] =
    output !== undefined && text.ok && output.sha256 !== text.data.sha256
      ? [{ path: output.path, sha256: text.data.sha256 }]
      : [];
  const verdict =
    source.lines !== null && text.ok
      ? validateTranslation({ source: source.lines, text: text.data.bytes.toString("utf8") })
      : null;
  const blocking = [
    ...(text.ok ? [] : [`${id}: brakuje ${toWorkspacePath(input.workspace.root, path.data)}`]),
    ...(source.lines === null
      ? [`${id}: skrypt, który przekład tłumaczy, nie przechodzi walidacji`]
      : []),
    ...(verdict !== null && !verdict.ok ? [verdict.error.message] : []),
  ];
  const inputsChanged = changedInputs(driftableInputs(record), target.inputs);
  const accepted = record.review.status === "approved";

  return {
    amended,
    blocking,
    inputs: target.inputs,
    problems: [
      ...blocking,
      ...inputsChanged.map(
        (changed) =>
          `${changed}: zmienił się od czasu przekładu (${id}), przeczytaj przekład jeszcze raz i zatwierdź ponownie: ${approveCommand(input, id)}`
      ),
      ...amended.map(
        (one) =>
          `${one.path}: poprawiony ręcznie po generacji, tej wersji nikt jeszcze nie przyjął; przeczytaj i zatwierdź: ${approveCommand(input, id)}`
      ),
      ...(accepted && !source.approved
        ? [
            `${id}: przekład liczy się dopiero ze zgodą na skrypt, który tłumaczy: ${approveCommand(input)}`,
          ]
        : []),
    ],
    state: {
      ...base,
      approved:
        accepted &&
        source.approved &&
        blocking.length === 0 &&
        inputsChanged.length === 0 &&
        amended.length === 0,
      inputsChanged,
      note:
        verdict?.ok === true ? `${verdict.data.lines.length} kwestii` : "nie przechodzi walidacji",
      state: "completed",
    },
  };
}

/** What the translation adds to the stage's problems: nothing while there is none. */
function problemsOf(translation: TranslationInspection | null): readonly string[] {
  return translation === null ? [] : translation.problems;
}

/** The translation as the status reports it, or null while the episode names no language. */
function translationState(translation: TranslationInspection | null): TranslationState | null {
  return translation === null ? null : translation.state;
}

/** A script that is not on disk: nothing to verify, and no line to read out of it. */
async function unwritten(
  input: Stage11Scope,
  read: { readonly stage11: Stage11Inputs; readonly target: TranslationTarget },
  script: {
    readonly note: string;
    readonly problems: readonly string[];
    readonly state: ScriptState["state"];
  }
): Promise<Inspection> {
  const { note, problems, state } = script;
  const translation = await readTranslation(input, read.stage11, read.target, {
    approved: false,
    lines: null,
  });

  return {
    amended: [],
    blocking: [...problems],
    lineBlocking: new Map(),
    stage11: read.stage11,
    status: {
      amended: [],
      approved: false,
      lines: [],
      nextStep: `aimator dialogue generate ${input.projectId} ${input.episodeId}`,
      notices: [],
      problems: [...problems, ...problemsOf(translation)],
      script: { approved: false, id: SCRIPT, inputsChanged: [], note, state },
      translation: translationState(translation),
    },
    translation,
  };
}

async function inspect(input: Stage11Scope): Promise<Result<Inspection>> {
  const stage11 = await readStage11Inputs(input);

  if (!stage11.ok) {
    return stage11;
  }

  const target = await readTranslationTarget(input, stage11.data);

  if (!target.ok) {
    return target;
  }

  const { episode, gate, plan, stage } = stage11.data;
  const record = stage.artifacts[SCRIPT];
  const text = await readDigest(episode.dialogueScript);
  const absent = (state: ScriptState["state"], note: string, problems: readonly string[]) =>
    unwritten(input, { stage11: stage11.data, target: target.data }, { note, problems, state });

  if (record?.status === "submitted") {
    return ok(
      await absent("submitted", `próba ${record.runId} mogła zostać rozliczona`, [
        ...gate,
        `rekord "submitted" bez opublikowanego skryptu, powtórz polecenie, żeby dokończyć próbę bez drugiej opłaty`,
      ])
    );
  }

  if (record === undefined || !text.ok) {
    return ok(
      await absent("absent", gate.length > 0 ? gate.join("; ") : "jeszcze nie powstał", gate)
    );
  }

  const blocking: string[] = [];
  const [output] = record.outputs;

  if (output === undefined) {
    blocking.push("dialogue.md: rekord nie wskazuje żadnego pliku");
  }

  const amended: readonly RecordedFile[] =
    output !== undefined && output.sha256 !== text.data.sha256
      ? [{ path: output.path, sha256: text.data.sha256 }]
      : [];

  // Re-validated against the plan as it stands: a shot list whose lines changed
  // stops this script validating rather than silently disagreeing with it.
  const verdict =
    plan === null
      ? null
      : validateDialogue({
          cast: stage11.data.cast.map((member) => member.id),
          shotList: plan,
          text: text.data.bytes.toString("utf8"),
        });

  if (verdict === null) {
    blocking.push("lista ujęć nie przechodzi walidacji, skryptu nie ma względem czego sprawdzić");
  } else if (!verdict.ok) {
    blocking.push(verdict.error.message);
  }

  const inputsChanged = changedInputs(driftableInputs(record), stage11.data.inputs);
  const scriptApproved =
    record.review.status === "approved" &&
    blocking.length === 0 &&
    inputsChanged.length === 0 &&
    amended.length === 0;
  const script = verdict?.ok === true ? verdict.data : null;
  const lines = await readLineStates(input, stage11.data, script?.lines ?? []);
  const translation = await readTranslation(input, stage11.data, target.data, {
    approved: scriptApproved,
    lines: script?.lines ?? null,
  });

  return ok({
    amended,
    blocking,
    lineBlocking: lines.blocking,
    stage11: stage11.data,
    status: {
      amended: amended.map((one) => one.path),
      approved: scriptApproved && lines.states.every((one) => one.approved),
      lines: lines.states,
      nextStep: nextStep(input, scriptApproved, lines.states),
      notices: script?.notices ?? [],
      problems: [
        ...gate,
        ...blocking,
        ...inputsChanged.map(
          (path) =>
            `${path}: zmienił się od czasu spisania skryptu, przeczytaj skrypt jeszcze raz i zatwierdź ponownie: ${approveCommand(input)}`
        ),
        ...amended.map(
          (one) =>
            `${one.path}: poprawiony ręcznie po generacji, tej wersji nikt jeszcze nie przyjął; przeczytaj i zatwierdź: ${approveCommand(input)}`
        ),
        ...lines.problems,
        ...problemsOf(translation),
      ],
      script: {
        approved: scriptApproved,
        id: SCRIPT,
        inputsChanged,
        note: script === null ? "nie przechodzi walidacji" : `${script.lines.length} kwestii`,
        state: "completed",
      },
      translation: translationState(translation),
    },
    translation,
  });
}

function nextStep(
  input: Stage11Scope,
  scriptApproved: boolean,
  lines: readonly LineState[]
): string {
  if (!scriptApproved) {
    return `przeczytaj skrypt i zatwierdź: ${approveCommand(input)}`;
  }

  if (lines.some((one) => one.state !== "completed")) {
    return `aimator dialogue generate ${input.projectId} ${input.episodeId}`;
  }

  const pending = lines.filter((one) => !one.approved);

  return pending.length > 0
    ? `odsłuchaj kwestie i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --artifact ${pending.map((one) => one.id).join(",")}`
    : `skrypt i wszystkie kwestie przyjęte; pełna ścieżka położy je obok muzyki: aimator sound-design mix ${input.projectId} ${input.episodeId} --track <gpt-image|seedream>`;
}

interface LineStates {
  /** Per line, what an approval of it may not write over. */
  readonly blocking: ReadonlyMap<string, readonly string[]>;
  readonly problems: readonly string[];
  readonly states: readonly LineState[];
}

async function readLineStates(
  input: Stage11Scope,
  stage11: Stage11Inputs,
  lines: readonly DialogueLine[]
): Promise<LineStates> {
  const blocking = new Map<string, readonly string[]>();
  const problems: string[] = [];
  const states: LineState[] = [];

  for (const line of lines) {
    // biome-ignore lint/performance/noAwaitInLoops: each line read once per check
    const one = await readLineState(input, stage11, line);

    blocking.set(line.id, one.blocking);
    problems.push(...one.problems);
    states.push(one.state);
  }

  return { blocking, problems, states };
}

/** The command that buys one line again, which is every lapsed recording's remedy. */
function regenerateCommand(input: Stage11Scope, id: string): string {
  return `aimator dialogue generate ${input.projectId} ${input.episodeId} --regenerate --artifact ${id}`;
}

/** One bought line: is the recording there, is it speech, and did anybody accept it. */
async function readLineState(
  input: Stage11Scope,
  stage11: Stage11Inputs,
  line: DialogueLine
): Promise<{ blocking: readonly string[]; problems: readonly string[]; state: LineState }> {
  const record = stage11.stage.artifacts[line.id];
  const file = dialogueAudio(stage11.episode, stage11.language, line.id);
  const absent = { ...line, approved: false, inputsChanged: [], seconds: null } as const;

  if (record === undefined || !file.ok) {
    return {
      blocking: [],
      problems: [],
      state: { ...absent, note: "nie kupiona", state: "absent" },
    };
  }

  if (record.status === "submitted") {
    return {
      blocking: [],
      problems: [
        `${line.id}: rekord "submitted" bez opublikowanego nagrania, powtórz polecenie, żeby dokończyć próbę bez drugiej opłaty`,
      ],
      state: {
        ...absent,
        note: `próba ${record.runId} mogła zostać rozliczona`,
        state: "submitted",
      },
    };
  }

  const digest = await readDigest(file.data);
  const speech = digest.ok ? validateSpeech(digest.data.bytes) : null;
  const [output] = record.outputs;
  const bytes = [
    ...(digest.ok ? [] : [`${line.id}: brakuje nagrania`]),
    ...(digest.ok && output?.sha256 !== digest.data.sha256
      ? [`${line.id}: nagranie nie zgadza się z zapisanym hashem`]
      : []),
    ...(speech !== null && !speech.ok ? [`${line.id}: ${speech.error.message}`] : []),
  ];
  const inputsChanged: string[] = [];

  for (const entry of driftableInputs(record)) {
    // biome-ignore lint/performance/noAwaitInLoops: each input read once per check
    const now = await readDigest(workspacePath(input.workspace, entry.path));

    if (!now.ok || now.data.sha256 !== entry.sha256) {
      inputsChanged.push(entry.path);
    }
  }

  const drift = inputsChanged.map(
    (path) =>
      `${line.id}: ${path} zmienił się od czasu nagrania, to nagranie czyta coś innego niż teraz; nowe kupuje: ${regenerateCommand(input, line.id)}`
  );

  return {
    blocking: [...bytes, ...drift],
    problems: [...bytes, ...drift],
    state: {
      ...line,
      approved: record.review.status === "approved" && bytes.length === 0 && drift.length === 0,
      inputsChanged,
      note: speech?.ok === true ? `${speech.data.seconds}s` : "nie przechodzi walidacji",
      seconds: speech?.ok === true ? speech.data.seconds : null,
      state: "completed",
    },
  };
}

/** Reads and reports. Writes nothing; that is what makes it safe. */
export async function checkDialogue(input: Stage11Scope): Promise<Result<DialogueStatus>> {
  const inspection = await inspect(input);

  return inspection.ok ? ok(inspection.data.status) : inspection;
}

/** Where a named artifact stands, whichever of the three kinds it is. */
function stateOf(status: DialogueStatus, id: string): string | undefined {
  if (id === SCRIPT) {
    return status.script.state;
  }

  return id === status.translation?.id
    ? status.translation.state
    : status.lines.find((one) => one.id === id)?.state;
}

/**
 * A hand correction that validated is accepted with its script, the one
 * decision able to: its digest is rebound, its inputs are taken as they now
 * stand, and the record says who changed it from what. The script and its
 * translation are each rebound only when named.
 */
function rebind(inspection: Inspection, input: ApproveScope): StageFile {
  const { amended, stage11, translation } = inspection;
  const script = input.artifacts.includes(SCRIPT)
    ? withInputs(withAmendments(stage11.stage, amended, input.reviewer), SCRIPT, stage11.inputs)
    : stage11.stage;

  return translation !== null && input.artifacts.includes(translation.state.id)
    ? withInputs(
        withAmendments(script, translation.amended, input.reviewer),
        translation.state.id,
        translation.inputs
      )
    : script;
}

/**
 * Records that a human read the script, or listened to named lines.
 *
 * `--artifact` is **required**, as in stage 9: accepting the script authorises
 * buying every line in it, and accepting a line opens the mix. An approval
 * nobody wrote down would spend money nobody agreed to.
 */
export async function approveDialogue(input: ApproveScope): Promise<Result<DialogueStatus>> {
  if (input.artifacts.length === 0) {
    return err(
      new DialogueStateError(
        `--artifact jest wymagane: ${SCRIPT}, ${SCRIPT}-<język> albo D01[,D02], przyjęcie skryptu otwiera kupowanie każdej jego kwestii, a przyjęcie kwestii otwiera miks`
      )
    );
  }

  const inspection = await inspect(input);

  if (!inspection.ok) {
    return inspection;
  }

  const { blocking, lineBlocking, stage11, status, translation } = inspection.data;
  const known = [
    SCRIPT,
    ...(translation === null ? [] : [translation.state.id]),
    ...status.lines.map((one) => one.id),
  ];
  const unknown = input.artifacts.filter((id) => !known.includes(id));

  if (unknown.length > 0) {
    return err(
      new DialogueStateError(
        `--artifact "${unknown.join(", ")}", etap 11 zna tutaj ${known.join(", ")}`
      )
    );
  }

  const notReady = input.artifacts.filter((id) => stateOf(status, id) !== "completed");

  if (notReady.length > 0) {
    return err(
      new DialogueStateError(`nie ma czego zatwierdzić: ${notReady.join(", ")}`, status.problems)
    );
  }

  const refused = [
    ...(input.artifacts.includes(SCRIPT) ? blocking : []),
    ...(translation !== null && input.artifacts.includes(translation.state.id)
      ? translation.blocking
      : []),
    ...input.artifacts.flatMap((id) => lineBlocking.get(id) ?? []),
  ];

  if (refused.length > 0) {
    return err(
      new DialogueStateError("nie akceptuje się tego, co nie przechodzi walidacji", refused)
    );
  }

  const approved = approveArtifacts(rebind(inspection.data, input), input.artifacts, {
    note: input.note,
    reviewer: input.reviewer,
  });
  const written = await applyWrites(
    [{ kind: "text", text: serialize(approved), to: stage11.episode.dialogueStage }],
    input.mode
  );

  if (!written.ok) {
    return written;
  }

  if (input.mode === "dry-run") {
    return ok(status);
  }

  const after = await inspect(input);

  return after.ok ? ok(after.data.status) : after;
}

/** One accepted line as a mixer needs it: where the plan starts it, and its bytes. */
interface AcceptedLine {
  /** Where the plan puts it, before any track's drift is applied. */
  readonly atSeconds: number;
  readonly cast: string;
  readonly id: string;
  /** Absolute, for a mixer. */
  readonly path: string;
  /** How long the bought recording runs, from its own header. */
  readonly seconds: number;
}

interface AcceptedDialogue {
  /** Why these lines may not be laid down yet, line by line. Empty means they may. */
  readonly gate: readonly string[];
  readonly inputs: readonly RecordedFile[];
  readonly lines: readonly AcceptedLine[];
}

/**
 * Every line of the accepted script, with the recording somebody accepted.
 *
 * Exported for stage 9's `readAcceptedLines` reason: stage 10 lays these lines
 * in the full mix, and "which lines did a human accept" is a question about
 * this stage's artifact, answered here through the same verdict `check` prints
 * rather than by a second copy of it one row down. Every line of the script
 * has to be accepted, not merely the ones that are: a film missing a line is a
 * film saying less than the script a person approved.
 */
export async function readAcceptedDialogue(input: Stage11Scope): Promise<Result<AcceptedDialogue>> {
  const inspection = await inspect(input);

  if (!inspection.ok) {
    return inspection;
  }

  const { stage11, status } = inspection.data;
  const scope = `${input.projectId} ${input.episodeId}`;

  if (status.script.state !== "completed") {
    return ok({
      gate: [`nie ma skryptu dialogu, uruchom najpierw: aimator dialogue generate ${scope}`],
      inputs: [],
      lines: [],
    });
  }

  const script = await readDigest(stage11.episode.dialogueScript);
  const gate: string[] = status.script.approved
    ? []
    : [`skrypt dialogu nie ma ważnej zgody: ${status.nextStep}`];
  const inputs: RecordedFile[] = script.ok
    ? [
        {
          path: toWorkspacePath(input.workspace.root, stage11.episode.dialogueScript),
          sha256: script.data.sha256,
        },
      ]
    : [];
  const lines: AcceptedLine[] = [];

  for (const line of status.lines) {
    const file = dialogueAudio(stage11.episode, stage11.language, line.id);

    if (!file.ok) {
      return file;
    }

    if (line.state !== "completed") {
      gate.push(
        `${line.id}: kwestia dialogu nie została kupiona: aimator dialogue generate ${scope}`
      );
      continue;
    }

    if (!line.approved || line.seconds === null) {
      gate.push(
        `${line.id}: kwestia dialogu nie ma ważnej zgody, szczegóły: aimator check ${scope} --stage ${STAGE}`
      );
      continue;
    }

    // biome-ignore lint/performance/noAwaitInLoops: one recording read at a time, in the script's order
    const bytes = await readDigest(file.data);

    if (!bytes.ok) {
      return bytes;
    }

    inputs.push({
      path: toWorkspacePath(input.workspace.root, file.data),
      sha256: bytes.data.sha256,
    });
    lines.push({
      atSeconds: line.atSeconds,
      cast: line.cast,
      id: line.id,
      path: file.data,
      seconds: line.seconds,
    });
  }

  return ok({ gate, inputs, lines });
}
