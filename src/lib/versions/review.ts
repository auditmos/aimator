import {
  applyWrites,
  approveArtifacts,
  driftableInputs,
  readDigest,
  serialize,
  type WriteMode,
} from "../artifact/index.js";
import { err, ok, type Result } from "../result.js";
import { type ImageTrack, versionClip, workspacePath } from "../workspace.js";
import {
  type ClipTarget,
  lineProblems,
  readClipFaces,
  readSourceClip,
  readStage12,
  STAGE,
  type Stage12,
  type Stage12Scope,
} from "./plan.js";

/**
 * Internal to the versions module: verification, and the approval on top of it.
 *
 * `check` reads and reports; it writes nothing. `approve` repeats the whole
 * verification and only then records acceptance of a clip's version, bound to
 * its bytes and to everything it was made from: the clip, the faces, the
 * binding and every line. A person watched the mouths land on those lines; a
 * version of other lines is a version nobody watched.
 *
 * Only the clip is accepted, never a step before it: a step is a clip with one
 * face moved and another not yet, which is nothing anybody is meant to watch.
 */

/** One clip whose mouths move, and where its version stands. */
export interface ClipVersion {
  /** True once a person accepted the version and nothing it was made from changed. */
  readonly approved: boolean;
  readonly id: string;
  /** Recorded inputs whose bytes on disk no longer match what the version used. */
  readonly inputsChanged: readonly string[];
  readonly note: string;
  /** Who speaks in it on screen, in the order the jobs run. */
  readonly speakers: readonly string[];
  readonly state: "absent" | "completed" | "submitted";
}

export interface VersionsStatus {
  /** True once every clip whose mouths move carries a still-valid approval. */
  readonly approved: boolean;
  readonly clips: readonly ClipVersion[];
  readonly nextStep: string;
  /** What this stage says without refusing: a line heard from off screen. */
  readonly notices: readonly string[];
  readonly problems: readonly string[];
  readonly track: ImageTrack;
  /** Clips nobody visible speaks in, which pass to the version as they are. */
  readonly untouched: readonly string[];
}

type ApproveScope = Stage12Scope & {
  /** The clips to accept. Empty is refused rather than read as "everything". */
  readonly artifacts: readonly string[];
  readonly mode: WriteMode;
  readonly note: string | null;
  readonly reviewer: string;
};

class VersionsStateError extends Error {
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[] = []) {
    super(
      problems.length === 0 ? message : `${message}\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "VersionsStateError";
    this.problems = problems;
  }
}

interface ClipInspection {
  /**
   * Why nothing on this clip can move until another stage says yes: its
   * stage-7 clip, or, once its faces are found and bound, a line of stage 11.
   * Empty while the clip has a move of its own left.
   */
  readonly blockers: readonly string[];
  /** What an approval of this clip may not write over. */
  readonly blocking: readonly string[];
  readonly problems: readonly string[];
  /** The command that moves this clip on, while it is not yet a version. */
  readonly remedy: string | null;
  readonly state: ClipVersion;
}

interface Inspection {
  readonly clips: readonly ClipInspection[];
  readonly stage12: Stage12;
  readonly status: VersionsStatus;
}

function lipSyncCommand(input: Stage12Scope, clip: string): string {
  return `aimator versions lip-sync ${input.projectId} ${input.episodeId} --track ${input.track} --artifact ${clip}`;
}

/** A clip nobody lip-synced yet: what it waits for, and whether that is another stage. */
interface Waiting {
  readonly blockers: readonly string[];
  /** The one thing to do next, in the command that does it. */
  readonly note: string;
}

/**
 * The order the purchase meets them in, read the way a person moves: a face
 * call wants an accepted clip and nothing else, binding wants the faces, and
 * only the job wants each line accepted. So an unaccepted clip stops the clip
 * outright, while an unaccepted line stops it only once the job is all that
 * is left.
 */
async function waiting(
  input: Stage12Scope,
  stage12: Stage12,
  target: ClipTarget
): Promise<Result<Waiting>> {
  const source = await readSourceClip(input, stage12, target.id);

  if (!source.ok) {
    return source;
  }

  const faces = await readClipFaces(input, stage12, target, source.data.recorded);

  if (!faces.ok) {
    return faces;
  }

  const lines = lineProblems(input, stage12, target);
  const [first] = [...source.data.problems, ...faces.data.problems, ...lines];
  const blockers = ((): readonly string[] => {
    if (source.data.problems.length > 0) {
      return source.data.problems;
    }

    return faces.data.problems.length > 0 ? [] : lines;
  })();

  return ok({
    blockers,
    note: first ?? `gotowy do lip-syncu: ${lipSyncCommand(input, target.id)}`,
  });
}

/** One clip's version: are its bytes the ones recorded, and is what it was made from unchanged. */
async function inspectClip(
  input: Stage12Scope,
  stage12: Stage12,
  target: ClipTarget
): Promise<Result<ClipInspection>> {
  const record = stage12.stage.artifacts[target.id];
  const file = versionClip(stage12.paths.track, target.id);
  const base = { id: target.id, inputsChanged: [], speakers: target.speakers } as const;

  if (!file.ok) {
    return file;
  }

  if (record === undefined) {
    const wait = await waiting(input, stage12, target);

    return wait.ok
      ? ok({
          blockers: wait.data.blockers,
          blocking: [],
          problems: [],
          remedy: wait.data.note,
          state: { ...base, approved: false, note: wait.data.note, state: "absent" },
        })
      : wait;
  }

  if (record.status === "submitted") {
    const problem = `${target.id}: rekord "submitted" bez opublikowanego klipu, powtórz polecenie, żeby odebrać zadanie bez drugiej opłaty: ${lipSyncCommand(input, target.id)}`;

    return ok({
      blockers: [],
      blocking: [],
      problems: [problem],
      remedy: lipSyncCommand(input, target.id),
      state: {
        ...base,
        approved: false,
        note: `próba ${record.runId} mogła zostać rozliczona`,
        state: "submitted",
      },
    });
  }

  const digest = await readDigest(file.data);
  const [output] = record.outputs;
  const bytes = [
    ...(digest.ok ? [] : [`${target.id}: brakuje klipu wersji`]),
    ...(digest.ok && output?.sha256 !== digest.data.sha256
      ? [`${target.id}: klip wersji nie zgadza się z zapisanym hashem`]
      : []),
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
      `${target.id}: ${path} zmienił się od lip-syncu, usta ruszają się do czegoś innego niż teraz; nowy kupuje: ${lipSyncCommand(input, target.id)} --regenerate`
  );
  const blocking = [...bytes, ...drift];

  return ok({
    blockers: [],
    blocking,
    problems: blocking,
    remedy: null,
    state: {
      ...base,
      approved: record.review.status === "approved" && blocking.length === 0,
      inputsChanged,
      note: `${target.speakers.join(", ")}, próba ${record.runId}`,
      state: "completed",
    },
  });
}

function nextStep(input: Stage12Scope, clips: readonly ClipInspection[], gate: string): string {
  const remedy = clips.find((one) => one.remedy !== null)?.remedy;

  if (gate !== "") {
    return gate;
  }

  if (remedy !== undefined && remedy !== null) {
    return remedy;
  }

  const pending = clips.filter((one) => !one.state.approved).map((one) => one.state.id);

  return pending.length > 0
    ? `obejrzyj i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --track ${input.track} --artifact ${pending.join(",")}`
    : "każdy klip z mówiącą postacią w kadrze ma lip-sync i zgodę";
}

async function inspect(input: Stage12Scope): Promise<Result<Inspection>> {
  const stage12 = await readStage12(input);

  if (!stage12.ok) {
    return stage12;
  }

  const { gate, notices, targets, untouched } = stage12.data;
  const clips: ClipInspection[] = [];

  for (const target of targets) {
    // biome-ignore lint/performance/noAwaitInLoops: one clip at a time, in the plan's order
    const clip = await inspectClip(input, stage12.data, target);

    if (!clip.ok) {
      return clip;
    }

    clips.push(clip.data);
  }

  // What another stage owes a clip refuses the **stage** only when no clip on
  // the track has a move left, as stage 7 refuses only a chain with nothing to
  // buy: listing every waiting clip would call a track refused while a face
  // call on its neighbour would go through this second.
  const unfinished = clips.filter((one) => one.state.state === "absent");
  const stalled =
    unfinished.length > 0 && unfinished.every((one) => one.blockers.length > 0)
      ? unfinished.flatMap((one) => one.blockers)
      : [];

  return ok({
    clips,
    stage12: stage12.data,
    status: {
      approved: gate.length === 0 && clips.every((one) => one.state.approved),
      clips: clips.map((one) => one.state),
      nextStep: nextStep(input, clips, gate[0] ?? ""),
      notices,
      problems: [...gate, ...stalled, ...clips.flatMap((one) => one.problems)],
      track: input.track,
      untouched,
    },
  });
}

/** Reads and reports. Writes nothing; that is what makes it safe. */
export async function checkVersions(input: Stage12Scope): Promise<Result<VersionsStatus>> {
  const inspection = await inspect(input);

  return inspection.ok ? ok(inspection.data.status) : inspection;
}

/**
 * Records that a person watched named clips with their mouths moved.
 *
 * `--artifact` is **required**: each clip is its own judgement, whether the
 * mouths land on the lines, and an approval nobody wrote down per clip would
 * accept clips nobody watched.
 */
export async function approveVersions(input: ApproveScope): Promise<Result<VersionsStatus>> {
  if (input.artifacts.length === 0) {
    return err(
      new VersionsStateError(
        "--artifact jest wymagane: C01[,C02], każdy klip wersji ocenia się osobno, oglądając, czy usta trafiają w kwestie"
      )
    );
  }

  const inspection = await inspect(input);

  if (!inspection.ok) {
    return inspection;
  }

  const { clips, stage12, status } = inspection.data;
  const known = clips.map((one) => one.state.id);
  const unknown = input.artifacts.filter((id) => !known.includes(id));

  // A stage that has not opened, or whose clips need no lip-sync, has nothing
  // to accept, and saying why is more use than naming an empty set.
  if (known.length === 0) {
    return err(
      new VersionsStateError(`nie ma czego zatwierdzić: ${input.artifacts.join(", ")}`, [
        ...status.problems,
        ...(status.problems.length === 0
          ? [`na torze ${input.track} żaden klip nie ma postaci mówiącej w kadrze`]
          : []),
      ])
    );
  }

  if (unknown.length > 0) {
    return err(
      new VersionsStateError(
        `--artifact "${unknown.join(", ")}", etap 12 zna na torze ${input.track} ${known.join(", ") || "żaden klip"}`
      )
    );
  }

  const named = clips.filter((one) => input.artifacts.includes(one.state.id));
  const notReady = named.filter((one) => one.state.state !== "completed");

  if (notReady.length > 0) {
    return err(
      new VersionsStateError(
        `nie ma czego zatwierdzić: ${notReady.map((one) => one.state.id).join(", ")}`,
        status.problems
      )
    );
  }

  const refused = named.flatMap((one) => one.blocking);

  if (refused.length > 0) {
    return err(
      new VersionsStateError("nie akceptuje się tego, co nie przechodzi weryfikacji", refused)
    );
  }

  const approved = approveArtifacts(stage12.stage, input.artifacts, {
    note: input.note,
    reviewer: input.reviewer,
  });
  const written = await applyWrites(
    [{ kind: "text", text: serialize(approved), to: stage12.paths.track.versionsStage }],
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
