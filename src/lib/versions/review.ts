import {
  applyWrites,
  approveArtifacts,
  driftableInputs,
  readDigest,
  serialize,
  toWorkspacePath,
  type WriteMode,
} from "../artifact/index.js";
import {
  type Check,
  type Checklist,
  checksFlag,
  confirmChecks,
  FILM_CHECKS,
} from "../checklist.js";
import { err, ok, type Result } from "../result.js";
import {
  type ImageTrack,
  projectPaths,
  versionClip,
  versionFilm,
  workspacePath,
} from "../workspace.js";
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
 *
 * The two finished films are accepted the same way, each on its own, keyed by
 * its language. The one in the language of the mouths is accepted against the
 * QC checklist of a film whose mouths were moved; the one in the film's own
 * language is dubbing over those mouths and takes a plain yes. The picture they
 * share is accepted by neither: nobody watches a silent cut.
 */

/** One face the face call found: on screen from `start` to `end` ms, and its picture. */
interface ClipFace {
  readonly end: number;
  readonly id: string;
  /** Workspace-relative, or null when the provider's picture did not arrive. */
  readonly image: string | null;
  readonly start: number;
}

/** One clip whose mouths move, and where its version stands. */
export interface ClipVersion {
  /** True once a person accepted the version and nothing it was made from changed. */
  readonly approved: boolean;
  /** Face id → character, while that word is about the faces found now; null otherwise. */
  readonly binding: Readonly<Record<string, string>> | null;
  /** What the face call found in this clip; null until it is made. */
  readonly faces: readonly ClipFace[] | null;
  readonly id: string;
  /** Recorded inputs whose bytes on disk no longer match what the version used. */
  readonly inputsChanged: readonly string[];
  readonly note: string;
  /** Who speaks in it on screen, in the order the jobs run. */
  readonly speakers: readonly string[];
  readonly state: "absent" | "completed" | "submitted";
}

/** One of the two finished films of this track, and where its yes stands. */
export interface FinalFilm {
  /** True once a person accepted the film and nothing it was made from changed. */
  readonly approved: boolean;
  /** What its yes is given against: the film whose mouths moved has a checklist. */
  readonly checks: readonly Check[];
  /** Its language, which is also its key: `en`, `pl`. */
  readonly id: string;
  /** Recorded inputs whose bytes on disk no longer match what the film was made from. */
  readonly inputsChanged: readonly string[];
  readonly note: string;
  readonly state: "absent" | "completed";
}

export interface VersionsStatus {
  /**
   * True once every clip whose mouths move and both finished films carry a
   * still-valid approval.
   */
  readonly approved: boolean;
  readonly clips: readonly ClipVersion[];
  /** The film in the language of the mouths, then the one in the film's own; empty while gated. */
  readonly finals: readonly FinalFilm[];
  readonly nextStep: string;
  /** What this stage says without refusing: a line heard from off screen. */
  readonly notices: readonly string[];
  readonly problems: readonly string[];
  readonly track: ImageTrack;
  /** Clips nobody visible speaks in, which pass to the version as they are. */
  readonly untouched: readonly string[];
}

type ApproveScope = Stage12Scope & {
  /** The clips and films to accept. Empty is refused rather than read as "everything". */
  readonly artifacts: readonly string[];
  /** `--checks`: what the film whose mouths moved was walked through; nothing else needs one. */
  readonly checks?: Checklist | null;
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

interface FinalInspection {
  /** What an approval of this film may not write over. */
  readonly blocking: readonly string[];
  readonly state: FinalFilm;
}

interface Inspection {
  readonly clips: readonly ClipInspection[];
  readonly finals: readonly FinalInspection[];
  readonly stage12: Stage12;
  readonly status: VersionsStatus;
}

function lipSyncCommand(input: Stage12Scope, clip: string): string {
  return `aimator versions lip-sync ${input.projectId} ${input.episodeId} --track ${input.track} --artifact ${clip}`;
}

function finalCommand(input: Stage12Scope, language: string): string {
  return `aimator versions final ${input.projectId} ${input.episodeId} --track ${input.track} --language ${language}`;
}

/**
 * One finished film: are its bytes the ones recorded, and is everything it was
 * made from unchanged. The picture and its clips are among those inputs, so a
 * clip lip-synced again lapses both films at once, before anyone cuts a new
 * picture under them.
 */
async function inspectFinal(
  input: Stage12Scope,
  stage12: Stage12,
  language: string
): Promise<Result<FinalInspection>> {
  const record = stage12.stage.artifacts[language];
  const file = versionFilm(stage12.paths.track, language);
  const checks = language === stage12.language ? FILM_CHECKS : [];

  if (!file.ok) {
    return file;
  }

  if (record === undefined) {
    return ok({
      blocking: [],
      state: {
        approved: false,
        checks,
        id: language,
        inputsChanged: [],
        note: `jeszcze nie powstał: ${finalCommand(input, language)}`,
        state: "absent",
      },
    });
  }

  const digest = await readDigest(file.data);
  const [output] = record.outputs;
  const inputsChanged: string[] = [];

  for (const entry of driftableInputs(record)) {
    // biome-ignore lint/performance/noAwaitInLoops: each input read once per check
    const now = await readDigest(workspacePath(input.workspace, entry.path));

    if (!now.ok || now.data.sha256 !== entry.sha256) {
      inputsChanged.push(entry.path);
    }
  }

  // A film laid before anybody dialled the levels records no `mix.json`, so
  // nothing in it can drift; the file appearing since is checked directly, for
  // stage 10's reason: a film made on the starting values is not one made the
  // way this series was later decided to sound.
  const project = projectPaths(input.workspace, input.projectId);
  const mix = project.ok ? toWorkspacePath(input.workspace.root, project.data.mix) : null;
  const levels = project.ok ? await readDigest(project.data.mix) : null;

  if (mix !== null && levels?.ok === true && !record.inputs.some((one) => one.path === mix)) {
    inputsChanged.push(mix);
  }

  const blocking = [
    ...(digest.ok ? [] : [`${language}: brakuje filmu wersji`]),
    ...(digest.ok && output?.sha256 !== digest.data.sha256
      ? [`${language}: film wersji nie zgadza się z zapisanym hashem`]
      : []),
    ...inputsChanged.map(
      (path) =>
        `${language}: ${path} zmienił się od złożenia filmu; nowy składa: ${finalCommand(input, language)} --regenerate`
    ),
  ];

  return ok({
    blocking,
    state: {
      approved: record.review.status === "approved" && blocking.length === 0,
      checks,
      id: language,
      inputsChanged,
      note: `próba ${record.runId}`,
      state: "completed",
    },
  });
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
  // Read for what a person binds by, not for the gate: `waiting` judges them.
  const faces = await readClipFaces(input, stage12, target, null);

  if (!file.ok) {
    return file;
  }
  if (!faces.ok) {
    return faces;
  }

  const base = {
    binding: faces.data.binding,
    faces:
      faces.data.found?.faces.map(({ end, id, image, start }) => ({
        end,
        id,
        image: image?.path ?? null,
        start,
      })) ?? null,
    id: target.id,
    inputsChanged: [],
    speakers: target.speakers,
  } as const;

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

function approveCommand(input: Stage12Scope, ids: readonly string[]): string {
  return `obejrzyj i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --track ${input.track} --artifact ${ids.join(",")}`;
}

/**
 * Where a person goes from here, in the order the work runs: every clip's
 * version, then each film, made and then watched.
 */
function nextStep(
  input: Stage12Scope,
  clips: readonly ClipInspection[],
  finals: readonly FinalInspection[],
  gate: string
): string {
  const remedy = clips.find((one) => one.remedy !== null)?.remedy;

  if (gate !== "") {
    return gate;
  }

  if (remedy !== undefined && remedy !== null) {
    return remedy;
  }

  const pending = clips.filter((one) => !one.state.approved).map((one) => one.state.id);

  if (pending.length > 0) {
    return approveCommand(input, pending);
  }

  const film = finals.find((one) => !one.state.approved);

  if (film === undefined) {
    return "każdy klip z mówiącą postacią w kadrze ma lip-sync, a oba filmy mają zgodę";
  }

  if (film.state.state === "absent") {
    return finalCommand(input, film.state.id);
  }

  return film.blocking.length > 0
    ? `${finalCommand(input, film.state.id)} --regenerate`
    : `${approveCommand(input, [film.state.id])}${checksFlag(film.state.checks)}`;
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
  const { filmLanguage, language } = stage12.data;
  const languages = gate.length === 0 && language !== null ? [language, filmLanguage] : [];
  const finals: FinalInspection[] = [];

  for (const one of languages) {
    // biome-ignore lint/performance/noAwaitInLoops: one film at a time, the mouths' language first
    const film = await inspectFinal(input, stage12.data, one);

    if (!film.ok) {
      return film;
    }

    finals.push(film.data);
  }

  return ok({
    clips,
    finals,
    stage12: stage12.data,
    status: {
      approved:
        gate.length === 0 &&
        clips.every((one) => one.state.approved) &&
        finals.every((one) => one.state.approved),
      clips: clips.map((one) => one.state),
      finals: finals.map((one) => one.state),
      nextStep: nextStep(input, clips, finals, gate[0] ?? ""),
      notices,
      problems: [
        ...gate,
        ...stalled,
        ...clips.flatMap((one) => one.problems),
        ...finals.flatMap((one) => one.blocking),
      ],
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

/** What `approve` may name: a clip's version or a finished film, as far as accepting it goes. */
interface Approvable {
  /** What an approval may not write over. */
  readonly blocking: readonly string[];
  readonly checks: readonly Check[];
  readonly id: string;
  readonly state: "absent" | "completed" | "submitted";
}

/**
 * Records that a person watched named clips with their mouths moved, or a
 * finished film from start to end.
 *
 * `--artifact` is **required**: each clip is its own judgement, whether the
 * mouths land on the lines, and an approval nobody wrote down per clip would
 * accept clips nobody watched. The film whose mouths moved is accepted against
 * its checklist, criterion by criterion, and refused without it.
 */
export async function approveVersions(input: ApproveScope): Promise<Result<VersionsStatus>> {
  if (input.artifacts.length === 0) {
    return err(
      new VersionsStateError(
        "--artifact jest wymagane: C01[,C02] albo język filmu, każdy klip wersji i każdy film ocenia się osobno"
      )
    );
  }

  const inspection = await inspect(input);

  if (!inspection.ok) {
    return inspection;
  }

  const { clips, finals, stage12, status } = inspection.data;
  const approvable: readonly Approvable[] = [
    ...clips.map((one) => ({
      blocking: one.blocking,
      checks: [],
      id: one.state.id,
      state: one.state.state,
    })),
    ...finals.map((one) => ({
      blocking: one.blocking,
      checks: one.state.checks,
      id: one.state.id,
      state: one.state.state,
    })),
  ];
  const known = approvable.map((one) => one.id);
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

  const named = approvable.filter((one) => input.artifacts.includes(one.id));
  const notReady = named.filter((one) => one.state !== "completed");

  if (notReady.length > 0) {
    return err(
      new VersionsStateError(
        `nie ma czego zatwierdzić: ${notReady.map((one) => one.id).join(", ")}`,
        status.problems
      )
    );
  }

  const confirmed: Record<string, readonly Check[]> = {};
  const refused = named.flatMap((one) => one.blocking);

  for (const one of named.filter((film) => film.checks.length > 0)) {
    const checks = confirmChecks(`${one.id} (${input.track})`, one.checks, input.checks ?? null);

    if (checks.ok) {
      confirmed[one.id] = checks.data;
    } else {
      refused.push(checks.error.message);
    }
  }

  if (refused.length > 0) {
    return err(
      new VersionsStateError("nie akceptuje się tego, co nie przechodzi weryfikacji", refused)
    );
  }

  const approved = approveArtifacts(stage12.stage, input.artifacts, {
    checks: confirmed,
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
