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
import { validateImage } from "../image-model/index.js";
import { err, ok, type Result } from "../result.js";
import { validateVideo } from "../video-model/index.js";
import { type ImageTrack, workspacePath } from "../workspace.js";
import {
  isClipArtifact,
  readStage7Inputs,
  STAGE,
  type Stage7Inputs,
  type Stage7Scope,
  type Stage7Target,
} from "./plan.js";

/**
 * Internal to the clips module: verification, and the approval that sits on top
 * of it but is never implied by it.
 *
 * `check` reads and reports; it writes nothing. `approve` repeats the whole
 * verification and only then records acceptance, bound to the digest of one
 * result at a time, because each is a separate creative judgement and because
 * the next link's gate reads them separately. Accepting a clip is what lets the
 * next entry frame be drawn, and accepting that frame is what lets the next
 * clip be rendered, so an approval that spilled across the set would open gates
 * nobody looked through, at the price of a video each time.
 *
 * The verdict differs by medium and the reading does not: an entry frame is
 * judged as an image in the film frame, a clip as a video of the length the
 * shot list planned, and a clip's end frame is judged against the clip it came
 * out of. All three end up as one line a person reads.
 */

export interface ClipState {
  readonly approved: boolean;
  readonly id: string;
  /** Recorded inputs whose bytes on disk no longer match what this run used. */
  readonly inputsChanged: readonly string[];
  readonly kind: "clip" | "entry-frame";
  readonly note: string;
  readonly state: "absent" | "completed" | "submitted";
}

export interface ClipsStatus {
  /** True once every clip and entry frame carries a still-valid approval. */
  readonly approved: boolean;
  readonly artifacts: readonly ClipState[];
  readonly nextStep: string;
  readonly problems: readonly string[];
  readonly track: ImageTrack;
}

type ApproveScope = Stage7Scope & {
  /** What to accept. Empty is refused rather than read as "everything". */
  readonly artifacts: readonly string[];
  readonly mode: WriteMode;
  readonly note: string | null;
  readonly reviewer: string;
};

class ClipStateError extends Error {
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[] = []) {
    super(
      problems.length === 0 ? message : `${message}\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "ClipStateError";
    this.problems = problems;
  }
}

interface Inspection {
  /** Problems an approval may not write over. Input drift is not among them. */
  readonly blocking: readonly string[];
  /** The inputs as they now stand, per target, what an approval re-records. */
  readonly inputs: Map<string, readonly RecordedFile[]>;
  readonly stage: StageFile;
  readonly stagePath: string;
  readonly status: ClipsStatus;
}

/**
 * Which recorded inputs no longer match the bytes on disk.
 *
 * Every target records the package, the project rules, the shot list and its
 * own prompt, so the same handful of files appears in every record. Each is
 * hashed once per check rather than once per target.
 */
async function changedInputs(
  input: Stage7Scope,
  recorded: readonly RecordedFile[],
  seen: Map<string, string | null>
): Promise<readonly string[]> {
  const changed: string[] = [];

  for (const entry of recorded) {
    if (!seen.has(entry.path)) {
      // biome-ignore lint/performance/noAwaitInLoops: each input read once per check
      const digest = await readDigest(workspacePath(input.workspace, entry.path));

      seen.set(entry.path, digest.ok ? digest.data.sha256 : null);
    }

    if (seen.get(entry.path) !== entry.sha256) {
      changed.push(entry.path);
    }
  }

  return changed;
}

/** The verdict on one finished record's files, in the medium it belongs to. */
async function verdictOf(
  input: Stage7Scope,
  stage7: Stage7Inputs,
  target: Stage7Target,
  record: StageFile["artifacts"][string]
): Promise<{ blocking: readonly string[]; note: string }> {
  const label = `${target.name} (${input.track})`;
  const [output] = record.outputs;

  if (output === undefined) {
    return {
      blocking: [`${label}: rekord ukończony, ale nie wskazuje żadnego pliku`],
      note: "brak pliku",
    };
  }

  const digest = await readDigest(workspacePath(input.workspace, output.path));

  if (!digest.ok) {
    return { blocking: [`${label}: brakuje ${output.path}`], note: "brak pliku" };
  }

  if (digest.data.sha256 !== output.sha256) {
    return {
      blocking: [
        `${label}: ${output.path} nie zgadza się z zapisanym hashem, wynik został zmieniony poza narzędziem`,
      ],
      note: "bajty nie zgadzają się z rekordem",
    };
  }

  if (target.kind === "entry-frame") {
    const checked = validateImage(digest.data.bytes, stage7.plan.size);

    return checked.ok
      ? { blocking: [], note: `${checked.data.width}x${checked.data.height}` }
      : {
          blocking: [`${label}: ${checked.error.message}`],
          note: "obraz nie przechodzi walidacji",
        };
  }

  const checked = validateVideo(digest.data.bytes, {
    aspectRatio: stage7.plan.aspectRatio,
    seconds: target.seconds ?? 0,
  });

  if (!checked.ok) {
    return {
      blocking: [`${label}: ${checked.error.message}`],
      note: "klip nie przechodzi walidacji",
    };
  }

  // The end frame is what the next clip continues out of, so its absence is
  // reported here rather than discovered by the next link's gate.
  const ended = record.outputs.length > 1;

  return {
    blocking: [],
    note: `${checked.data.width}x${checked.data.height}, ${checked.data.seconds}s${ended ? "" : ", bez końcówki, klip kontynuujący nie ma z czego wyjść"}`,
  };
}

async function inspectOne(
  input: Stage7Scope,
  stage7: Stage7Inputs,
  target: Stage7Target,
  seen: Map<string, string | null>
): Promise<{ blocking: readonly string[]; status: ClipState }> {
  const record = stage7.stage.artifacts[target.name];
  const label = `${target.name} (${input.track})`;

  if (record === undefined) {
    return {
      blocking: [],
      status: {
        approved: false,
        id: target.name,
        inputsChanged: [],
        kind: target.kind,
        note: target.blockers.length > 0 ? target.blockers.join("; ") : "jeszcze nie powstał",
        state: "absent",
      },
    };
  }

  if (record.status === "submitted") {
    const unfinished = `${label}: próba ${record.runId} zapisała status "submitted" i nigdy nie dobiegła końca${record.jobId === null ? "" : ` (zadanie ${record.jobId})`}, powtórz polecenie, żeby ją dokończyć bez drugiej opłaty`;

    return {
      blocking: [unfinished],
      status: {
        approved: false,
        id: target.name,
        inputsChanged: [],
        kind: target.kind,
        note: `próba ${record.runId} nieukończona`,
        state: "submitted",
      },
    };
  }

  const { blocking, note } = await verdictOf(input, stage7, target, record);
  const inputsChanged = await changedInputs(input, record.inputs, seen);

  return {
    blocking,
    status: {
      // Approval is bound to bytes: a recorded "approved" that no longer
      // verifies is not an approval; it is a stale claim.
      approved:
        record.review.status === "approved" && blocking.length === 0 && inputsChanged.length === 0,
      id: target.name,
      inputsChanged,
      kind: target.kind,
      note,
      state: "completed",
    },
  };
}

async function inspect(input: Stage7Scope): Promise<Result<Inspection>> {
  const stage7 = await readStage7Inputs(input);

  if (!stage7.ok) {
    return stage7;
  }

  const blocking: string[] = [];
  const problems: string[] = [];
  const artifacts: ClipState[] = [];
  const inputs = new Map<string, readonly RecordedFile[]>();
  const seen = new Map<string, string | null>();

  for (const target of stage7.data.targets) {
    inputs.set(target.name, target.artifact.inputs);
    // biome-ignore lint/performance/noAwaitInLoops: one target at a time, in order
    const one = await inspectOne(input, stage7.data, target, seen);

    artifacts.push(one.status);
    blocking.push(...one.blocking);
    problems.push(...one.blocking);

    // Drift is reported beside the blocking problems and revokes the approval
    // just as loudly, but it is not one of them. The result is intact; it was
    // made from something that has since changed, and reading it again beside
    // the new version is exactly what an approval is.
    for (const path of one.status.inputsChanged) {
      problems.push(
        `${path}: zmienił się od czasu powstania ${target.name}, obejrzyj wynik jeszcze raz obok nowej wersji i zatwierdź ponownie albo kup go ponownie: aimator clip generate ${input.projectId} ${input.episodeId} --track ${input.track} --regenerate --artifact ${target.name}`
      );
    }
  }

  // A blocker refuses the **stage** only when the stage has nothing left to
  // buy. The gate here is a chain, so a later clip is almost always waiting for
  // an earlier one; listing every link would call a track refused while
  // `clip generate` would buy something on it this second. What is a refusal is
  // a track with nothing buyable, which is what a missing opening frame makes.
  const unfinished = stage7.data.targets.filter(
    (one) => stage7.data.stage.artifacts[one.name]?.status !== "completed"
  );
  const stalled =
    unfinished.length > 0 && unfinished.every((one) => one.blockers.length > 0)
      ? unfinished.flatMap((one) => one.blockers)
      : [];

  return ok({
    blocking,
    inputs,
    stage: stage7.data.stage,
    stagePath: stage7.data.paths.track.clipsStage,
    status: {
      approved: artifacts.length > 0 && artifacts.every((one) => one.approved),
      artifacts,
      nextStep: nextStepOf(input, artifacts),
      problems: [...stage7.data.gate, ...stalled, ...problems],
      track: input.track,
    },
  });
}

function nextStepOf(input: Stage7Scope, artifacts: readonly ClipState[]): string {
  const waiting = artifacts.filter((one) => one.state === "completed" && !one.approved);

  if (waiting.length > 0) {
    return `oceń i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --track ${input.track} --artifact ${waiting.map((one) => one.id).join(",")}`;
  }

  const missing = artifacts.filter((one) => one.state !== "completed");

  return missing.length > 0
    ? `aimator clip generate ${input.projectId} ${input.episodeId} --track ${input.track}`
    : `etap 7 dla odcinka "${input.episodeId}" na torze ${input.track} jest kompletny, dalej etap 8, montaż`;
}

/** Reads and reports. Writes nothing; that is what makes it safe to run. */
export async function checkClips(input: Stage7Scope): Promise<Result<ClipsStatus>> {
  const inspection = await inspect(input);

  return inspection.ok ? ok(inspection.data.status) : inspection;
}

/**
 * Records that a human accepted these results, bound to their current bytes.
 *
 * It names them explicitly and refuses without them, for a reason that is
 * sharper here than anywhere upstream: accepting a clip is what lets the next
 * entry frame be drawn, and accepting that frame is what buys the next clip.
 * An approval nobody typed would spend money nobody agreed to.
 */
export async function approveClips(input: ApproveScope): Promise<Result<ClipsStatus>> {
  if (input.artifacts.length === 0) {
    return err(new ClipStateError("wskaż, co zatwierdzasz: --artifact C01[,entry:C02]"));
  }

  const named = input.artifacts.filter((id) => !isClipArtifact(id));

  if (named.length > 0) {
    return err(
      new ClipStateError(`--artifact "${named.join(", ")}", oczekiwano formy C01 albo entry:C02`)
    );
  }

  const inspection = await inspect(input);

  if (!inspection.ok) {
    return inspection;
  }

  const { blocking, inputs, stage, stagePath, status } = inspection.data;
  const problems: string[] = [];

  for (const id of input.artifacts) {
    const entry = status.artifacts.find((one) => one.id === id);

    if (entry === undefined || entry.state !== "completed") {
      problems.push(`${id}: nie ma czego zatwierdzić (${entry?.state ?? "brak"})`);
    }
  }

  problems.push(
    ...blocking.filter((problem) => input.artifacts.some((id) => problem.startsWith(`${id} (`)))
  );

  if (problems.length > 0) {
    return err(new ClipStateError("nie akceptuje się tego, co nie przechodzi walidacji", problems));
  }

  let rebound = stage;

  for (const id of input.artifacts) {
    rebound = withInputs(rebound, id, inputs.get(id) ?? []);
  }

  const approved = approveArtifacts(rebound, input.artifacts, {
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

  const settled = status.artifacts.map((one) =>
    input.artifacts.includes(one.id) ? { ...one, approved: true, inputsChanged: [] } : one
  );

  return ok({
    ...status,
    approved: settled.every((one) => one.approved),
    artifacts: settled,
    nextStep: nextStepOf(input, settled),
  });
}
