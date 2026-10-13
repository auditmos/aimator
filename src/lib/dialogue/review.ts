import {
  applyWrites,
  approveArtifacts,
  driftableInputs,
  type RecordedFile,
  readDigest,
  serialize,
  type WriteMode,
  withAmendments,
  withInputs,
} from "../artifact/index.js";
import { err, ok, type Result } from "../result.js";
import { readStage11Inputs, SCRIPT, STAGE, type Stage11Inputs, type Stage11Scope } from "./plan.js";
import { type DialogueLine, validateDialogue } from "./validate.js";

/**
 * Internal to the dialogue module: verification, and the approval on top of it.
 *
 * `check` reads and reports; it writes nothing. `approve` repeats the whole
 * verification and only then records acceptance, bound to the script's bytes
 * as they now stand. A script corrected by hand is a lapsed consent rather than
 * an error, and is still held to "lifted, not invented, nothing left behind".
 */

export interface ScriptState {
  readonly approved: boolean;
  readonly id: typeof SCRIPT;
  /** Recorded inputs whose bytes on disk no longer match what the script used. */
  readonly inputsChanged: readonly string[];
  readonly note: string;
  readonly state: "absent" | "completed" | "submitted";
}

export interface DialogueStatus {
  /** The script, when a person corrected it by hand and nobody accepted that yet. */
  readonly amended: readonly string[];
  readonly approved: boolean;
  /** The script as data, once it validates against the plan as it stands. */
  readonly lines: readonly DialogueLine[];
  readonly nextStep: string;
  /** What this stage says without refusing: a voice from off screen. */
  readonly notices: readonly string[];
  readonly problems: readonly string[];
  readonly script: ScriptState;
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
  /** Problems an approval may not write over. Input drift is not among them. */
  readonly blocking: readonly string[];
  readonly stage11: Stage11Inputs;
  readonly status: DialogueStatus;
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

function approveCommand(input: Stage11Scope): string {
  return `aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --artifact ${SCRIPT}`;
}

async function inspect(input: Stage11Scope): Promise<Result<Inspection>> {
  const stage11 = await readStage11Inputs(input);

  if (!stage11.ok) {
    return stage11;
  }

  const { episode, gate, plan, stage } = stage11.data;
  const record = stage.artifacts[SCRIPT];
  const text = await readDigest(episode.dialogueScript);
  const absent = (
    state: ScriptState["state"],
    note: string,
    problems: readonly string[]
  ): Inspection => ({
    amended: [],
    blocking: [...problems],
    stage11: stage11.data,
    status: {
      amended: [],
      approved: false,
      lines: [],
      nextStep: `aimator dialogue generate ${input.projectId} ${input.episodeId}`,
      notices: [],
      problems,
      script: { approved: false, id: SCRIPT, inputsChanged: [], note, state },
    },
  });

  if (record?.status === "submitted") {
    return ok(
      absent("submitted", `próba ${record.runId} mogła zostać rozliczona`, [
        ...gate,
        `rekord "submitted" bez opublikowanego skryptu, powtórz polecenie, żeby dokończyć próbę bez drugiej opłaty`,
      ])
    );
  }

  if (record === undefined || !text.ok) {
    return ok(absent("absent", gate.length > 0 ? gate.join("; ") : "jeszcze nie powstał", gate));
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
  const approved =
    record.review.status === "approved" &&
    blocking.length === 0 &&
    inputsChanged.length === 0 &&
    amended.length === 0;
  const script = verdict?.ok === true ? verdict.data : null;

  return ok({
    amended,
    blocking,
    stage11: stage11.data,
    status: {
      amended: amended.map((one) => one.path),
      approved,
      lines: script?.lines ?? [],
      nextStep: approved
        ? "skrypt przyjęty; kwestie w języku filmu to kolejny krok etapu 11, jeszcze nie zaimplementowany"
        : `przeczytaj skrypt i zatwierdź: ${approveCommand(input)}`,
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
      ],
      script: {
        approved,
        id: SCRIPT,
        inputsChanged,
        note: script === null ? "nie przechodzi walidacji" : `${script.lines.length} kwestii`,
        state: "completed",
      },
    },
  });
}

/** Reads and reports. Writes nothing; that is what makes it safe. */
export async function checkDialogue(input: Stage11Scope): Promise<Result<DialogueStatus>> {
  const inspection = await inspect(input);

  return inspection.ok ? ok(inspection.data.status) : inspection;
}

/**
 * Records that a human read the script.
 *
 * `--artifact` is **required**, as in stage 9: accepting the script is what
 * will authorise buying every line in it, and an approval nobody wrote down
 * would spend money nobody agreed to.
 */
export async function approveDialogue(input: ApproveScope): Promise<Result<DialogueStatus>> {
  if (input.artifacts.length === 0) {
    return err(
      new DialogueStateError(
        `--artifact jest wymagane: ${SCRIPT}, przyjęcie skryptu otwiera kupowanie każdej jego kwestii`
      )
    );
  }

  const unknown = input.artifacts.filter((id) => id !== SCRIPT);

  if (unknown.length > 0) {
    return err(
      new DialogueStateError(`--artifact "${unknown.join(", ")}", etap 11 zna tutaj ${SCRIPT}`)
    );
  }

  const inspection = await inspect(input);

  if (!inspection.ok) {
    return inspection;
  }

  const { amended, blocking, stage11, status } = inspection.data;

  if (status.script.state !== "completed") {
    return err(new DialogueStateError(`nie ma czego zatwierdzić: ${SCRIPT}`, status.problems));
  }

  if (blocking.length > 0) {
    return err(
      new DialogueStateError("nie akceptuje się tego, co nie przechodzi walidacji", blocking)
    );
  }

  // A hand correction that validated is accepted here: its digest is rebound
  // and the record says who changed it from what.
  const rebound = withInputs(
    withAmendments(stage11.stage, amended, input.reviewer),
    SCRIPT,
    stage11.inputs
  );
  const approved = approveArtifacts(rebound, [SCRIPT], {
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
