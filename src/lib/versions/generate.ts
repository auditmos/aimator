import {
  type RecordedFile,
  readDigest,
  type StageFile,
  toWorkspacePath,
  type WriteMode,
} from "../artifact/index.js";
import type { HostingVariables } from "../hosting.js";
import { err, ok, type Result } from "../result.js";
import { type PlanClock, readPlanClock } from "../timeline.js";
import { identifyFaces, runLipSync } from "../video-model/index.js";
import { speechTrack } from "../voice-model/index.js";
import { dialogueAudio, versionClip, versionStep } from "../workspace.js";
import {
  type ClipFaces,
  type ClipTarget,
  holdingLock,
  lineProblems,
  readClipFaces,
  readSourceClip,
  readStage12,
  type SourceClip,
  type SpokenLine,
  STAGE,
  type Stage12,
  Stage12BlockedError,
  type Stage12Scope,
  untargeted,
} from "./plan.js";

/**
 * Internal to the versions module: lip-sync, one job per character who speaks
 * on screen, each run on the result of the one before it.
 *
 * The provider moves one face per job, so a clip in which two characters speak
 * is two jobs: the first on the accepted clip, the second on the first one's
 * result. Only the last of them publishes the clip's version; the ones before
 * it are steps, kept on disk because the next job is addressed by them.
 */

type LipSyncInput = Stage12Scope & {
  readonly apiKey: string | null;
  /** The clips to lip-sync, `C01`; empty means every clip that needs it. */
  readonly artifacts: readonly string[];
  readonly fetch: typeof fetch;
  readonly hosting: HostingVariables;
  readonly mode: WriteMode;
  readonly regenerate: boolean;
};

/** One sound as the job sends it: one character's lines in one clip. */
interface Speech {
  readonly seconds: number;
  /** Where on the clip's own clock it is inserted, in seconds. */
  readonly start: number;
  readonly wav: Buffer;
}

interface PlannedJob {
  readonly cast: string;
  readonly face: string;
  /** `C01` for the job that publishes the clip, `C01:ewa` for a step before it. */
  readonly key: string;
  readonly lines: readonly SpokenLine[];
  /** The bought lines it is made of, by path and digest: inputs of its record. */
  readonly sounds: readonly RecordedFile[];
  readonly speech: Speech;
  readonly state: "completed" | "planned" | "resumable";
  readonly target: string;
}

interface PlannedClip {
  readonly faces: ClipFaces | null;
  readonly id: string;
  readonly jobs: readonly PlannedJob[];
  readonly problems: readonly string[];
  readonly source: SourceClip;
}

/** One job as a person reads it before paying: who, which face, and where, in ms. */
interface JobOutcome {
  readonly cast: string;
  readonly end: number;
  readonly face: string;
  readonly key: string;
  readonly lines: readonly string[];
  readonly start: number;
  readonly state: string;
}

interface ClipOutcome {
  readonly id: string;
  readonly jobs: readonly JobOutcome[];
  readonly problems: readonly string[];
}

export interface LipSyncReport {
  readonly clips: readonly ClipOutcome[];
  readonly created: readonly string[];
  readonly nextStep: string;
  readonly notices: readonly string[];
  /** Face calls on a step's result, the ones a second speaker in a clip needs. */
  readonly paidFaces: number;
  readonly paidLipSyncs: number;
  readonly problems: readonly string[];
}

/** The key of a clip's job for one speaker: the last one publishes the clip itself. */
function jobKey(target: ClipTarget, index: number): string {
  const cast = target.speakers[index] ?? "";

  return index === target.speakers.length - 1 ? target.id : `${target.id}:${cast}`;
}

function stateOf(stage: StageFile, key: string, regenerate: boolean): PlannedJob["state"] {
  const record = stage.artifacts[key];

  if (record === undefined || regenerate) {
    return "planned";
  }

  if (record.status === "completed") {
    return "completed";
  }

  return record.jobId === null ? "planned" : "resumable";
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/** One speaker's lines in one clip, laid on the clip's own clock as one sound. */
async function speechOf(
  input: LipSyncInput,
  stage12: Stage12,
  target: ClipTarget,
  clock: PlanClock,
  cast: string
): Promise<Result<{ readonly sounds: readonly RecordedFile[]; readonly speech: Speech }>> {
  const placed: { at: number; wav: Buffer }[] = [];
  const sounds: RecordedFile[] = [];
  const begins = clock.at(target.start);

  for (const line of target.lines.filter((one) => one.cast === cast)) {
    const file = dialogueAudio(stage12.paths.episode, stage12.language ?? "", line.id);

    if (!file.ok) {
      return file;
    }

    // biome-ignore lint/performance/noAwaitInLoops: one recording at a time, in the order spoken
    const bytes = await readDigest(file.data);

    if (!bytes.ok) {
      return bytes;
    }

    placed.push({ at: round(clock.at(line.atSeconds) - begins), wav: bytes.data.bytes });
    sounds.push({
      path: toWorkspacePath(input.workspace.root, file.data),
      sha256: bytes.data.sha256,
    });
  }

  const seconds = clock.drift.find((one) => one.id === target.id)?.actualSeconds ?? 0;
  const speech = speechTrack(placed, seconds);

  return speech.ok ? ok({ sounds, speech: speech.data }) : speech;
}

/** One clip's jobs, or why it has none yet. */
async function planClip(
  input: LipSyncInput,
  stage12: Stage12,
  target: ClipTarget,
  clock: PlanClock
): Promise<Result<PlannedClip>> {
  const source = await readSourceClip(input, stage12, target.id);

  if (!source.ok) {
    return source;
  }

  const faces = await readClipFaces(input, stage12, target, source.data.recorded);

  if (!faces.ok) {
    return faces;
  }

  const problems = [
    ...source.data.problems,
    ...lineProblems(input, stage12, target),
    ...faces.data.problems,
  ];
  const jobs: PlannedJob[] = [];
  const { binding } = faces.data;

  for (const [index, cast] of target.speakers.entries()) {
    const face = Object.entries(binding ?? {}).find(([, bound]) => bound === cast)?.[0];
    const key = jobKey(target, index);
    const published =
      key === target.id
        ? versionClip(stage12.paths.track, target.id)
        : versionStep(stage12.paths.track, target.id, cast);

    if (!published.ok) {
      return published;
    }

    // biome-ignore lint/performance/noAwaitInLoops: one speaker at a time, in the order the jobs run
    const speech = await speechOf(input, stage12, target, clock, cast);

    if (!speech.ok) {
      problems.push(`${target.id}: ${cast}: ${speech.error.message}`);
      continue;
    }

    if (face !== undefined) {
      jobs.push({
        cast,
        face,
        key,
        lines: target.lines.filter((line) => line.cast === cast),
        sounds: speech.data.sounds,
        speech: speech.data.speech,
        state: stateOf(stage12.stage, key, input.regenerate),
        target: published.data,
      });
    }
  }

  return ok({ faces: faces.data, id: target.id, jobs, problems, source: source.data });
}

function outcomeOf(clip: PlannedClip): ClipOutcome {
  return {
    id: clip.id,
    jobs: clip.jobs.map((job) => {
      const start = Math.round(job.speech.start * 1000);

      return {
        cast: job.cast,
        end: start + Math.floor(job.speech.seconds * 1000),
        face: job.face,
        key: job.key,
        lines: job.lines.map((line) => line.key),
        start,
        state: job.state,
      };
    }),
    problems: clip.problems,
  };
}

/** What the clips that may be bought will cost: face calls and jobs, counted apart. */
function billOf(clips: readonly PlannedClip[]): { faces: number; lipSyncs: number } {
  const ready = clips.filter((clip) => clip.problems.length === 0);
  const planned = ready.flatMap((clip) =>
    clip.jobs.map((job, index) => ({ index, planned: job.state === "planned" }))
  );

  return {
    faces: planned.filter((one) => one.planned && one.index > 0).length,
    lipSyncs: planned.filter((one) => one.planned).length,
  };
}

/**
 * Lip-syncs the named clips, or every clip that needs it. A dry run states the
 * jobs, their windows and the bill without reading a key; a real run refuses
 * while any named clip still waits, because a partial purchase nobody asked
 * for is spending nobody agreed to.
 */
export async function generateLipSync(input: LipSyncInput): Promise<Result<LipSyncReport>> {
  const stage12 = await readStage12(input);

  if (!stage12.ok) {
    return stage12;
  }

  const named = input.artifacts.flatMap((id) => untargeted(stage12.data, id));
  const gate = [...stage12.data.gate, ...named];

  if (gate.length > 0) {
    return input.mode === "dry-run"
      ? ok({
          clips: [],
          created: [],
          nextStep: gate[0] ?? "",
          notices: stage12.data.notices,
          paidFaces: 0,
          paidLipSyncs: 0,
          problems: gate,
        })
      : err(new Stage12BlockedError(gate));
  }

  const clock = await readPlanClock({ ...input, aspectRatio: stage12.data.aspectRatio });

  if (!clock.ok) {
    return clock;
  }

  const selected = stage12.data.targets.filter(
    (one) => input.artifacts.length === 0 || input.artifacts.includes(one.id)
  );
  const clips: PlannedClip[] = [];

  for (const target of selected) {
    // biome-ignore lint/performance/noAwaitInLoops: one clip at a time, in the plan's order
    const planned = await planClip(input, stage12.data, target, clock.data);

    if (!planned.ok) {
      return planned;
    }

    clips.push(planned.data);
  }

  const problems = clips.flatMap((clip) => clip.problems);
  const bill = billOf(clips);
  const report = {
    clips: clips.map(outcomeOf),
    created: [],
    nextStep:
      problems[0] ??
      `aimator versions lip-sync ${input.projectId} ${input.episodeId} --track ${input.track}${input.artifacts.length > 0 ? ` --artifact ${input.artifacts.join(",")}` : ""}`,
    notices: stage12.data.notices,
    paidFaces: bill.faces,
    paidLipSyncs: bill.lipSyncs,
    problems,
  };

  if (input.mode === "dry-run") {
    return ok(report);
  }

  if (input.apiKey === null || input.apiKey === "") {
    problems.push("brak klucza KLING_API_KEY, lip-sync jest płatnym zadaniem Kling");
  }

  if (problems.length > 0) {
    return err(new Stage12BlockedError(problems));
  }

  return await holdingLock(stage12.data.paths.track.versionsLock, async () => {
    const bought = await buyAll(input, stage12.data, clips);

    return bought.ok
      ? ok({
          ...report,
          ...bought.data,
          nextStep: `obejrzyj i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --track ${input.track} --artifact ${clips.map((clip) => clip.id).join(",")}`,
          notices: [...report.notices, ...bought.data.notices],
        })
      : bought;
  });
}

type Bought = Pick<LipSyncReport, "clips" | "created" | "notices" | "paidFaces" | "paidLipSyncs">;

/** Every clip's jobs, in the plan's order, one paid call at a time. */
async function buyAll(
  input: LipSyncInput,
  stage12: Stage12,
  clips: readonly PlannedClip[]
): Promise<Result<Bought>> {
  const totals: Totals = { created: [], faces: 0, lipSyncs: 0, notices: [] };
  const outcomes: ClipOutcome[] = [];

  for (const clip of clips) {
    // biome-ignore lint/performance/noAwaitInLoops: one clip at a time, each a chain of paid jobs
    const bought = await buyClip(input, stage12, clip, totals);

    if (!bought.ok) {
      return bought;
    }

    outcomes.push(bought.data);
  }

  return ok({
    clips: outcomes,
    created: totals.created,
    notices: totals.notices,
    paidFaces: totals.faces,
    paidLipSyncs: totals.lipSyncs,
  });
}

/** A session a job is addressed by, and the faces found in its video, in ms. */
interface Session {
  readonly faces: readonly { readonly end: number; readonly id: string; readonly start: number }[];
  readonly sessionId: string;
}

/** Where a job starts from: a video on disk, and the record that published it. */
interface Origin {
  readonly path: string;
  readonly record: { readonly producer: { readonly model: string | null }; readonly runId: string };
}

/**
 * One clip's chain. The first job is addressed by the session `versions faces`
 * opened on the accepted clip; every later one by a session opened on the job
 * before it, under the face id the person bound, because the job is addressed
 * by a session and a session is opened on exactly one video.
 */
async function buyClip(
  input: LipSyncInput,
  stage12: Stage12,
  clip: PlannedClip,
  totals: Totals
): Promise<Result<ClipOutcome>> {
  const found = clip.faces?.found ?? null;

  if (found === null) {
    return err(new Stage12BlockedError([`${clip.id}: twarze nie są rozpoznane`]));
  }

  let { stage } = stage12;
  let origin: Origin = { path: clip.source.path, record: clip.source.record };
  const states: string[] = [];

  for (const [index, job] of clip.jobs.entries()) {
    if (job.state === "completed") {
      states.push(job.state);
    } else {
      // biome-ignore lint/performance/noAwaitInLoops: each job runs on the one before it
      const attempt = await buyJob({ clip, found, index, input, job, origin, stage12, totals });

      if (!attempt.ok) {
        return attempt;
      }

      states.push(attempt.data.state);
      ({ stage } = attempt.data);
    }

    const record = stage.artifacts[job.key];

    origin = record === undefined ? origin : { path: job.target, record };
  }

  const outcome = outcomeOf(clip);

  return ok({
    ...outcome,
    jobs: outcome.jobs.map((job, index) => ({ ...job, state: states[index] ?? job.state })),
  });
}

/** What a run has bought so far, and what it has to say about it, across every clip. */
interface Totals {
  created: string[];
  faces: number;
  lipSyncs: number;
  notices: string[];
}

type Attempt = Extract<Awaited<ReturnType<typeof runLipSync>>, { ok: true }>["data"];

/** One job of a clip's chain: its session, its face in that session, then the paid job. */
async function buyJob(step: {
  readonly clip: PlannedClip;
  readonly found: NonNullable<ClipFaces["found"]>;
  readonly index: number;
  readonly input: LipSyncInput;
  readonly job: PlannedJob;
  readonly origin: Origin;
  readonly stage12: Stage12;
  readonly totals: Totals;
}): Promise<Result<Attempt>> {
  const { clip, found, index, input, job, origin, stage12, totals } = step;
  // A resumed job is collected by asking, so it needs no session of its own:
  // the one recorded in `faces.json` stands in for the judgement before it.
  const session =
    index === 0 || job.state === "resumable"
      ? ok({ faces: found.faces, sessionId: found.sessionId })
      : await reopen(input, stage12, clip, origin, totals);

  if (!session.ok) {
    return session;
  }

  const face = session.data.faces.find((one) => one.id === job.face);

  if (face === undefined) {
    return err(
      new Stage12BlockedError([
        `${clip.id}: w wyniku po poprzedniej postaci Kling nie znalazł twarzy ${job.face}, przypisanej postaci ${job.cast}; znalazł: ${session.data.faces.map((one) => one.id).join(", ") || "żadnej"}`,
        `rozpoznanie jest opłacone; przypisanie dotyczy twarzy z przyjętego klipu, sprawdź je: aimator versions faces ${input.projectId} ${input.episodeId} --track ${input.track} --artifact ${clip.id} --regenerate`,
      ])
    );
  }

  const source = await readDigest(origin.path);

  if (!source.ok) {
    return source;
  }

  // The faces are an input of the first job only: every later one is addressed
  // by a session opened on the job before it, which its own inputs already name.
  const faces = [index === 0 ? clip.faces?.foundFile : null, clip.faces?.bindingFile].filter(
    (one): one is RecordedFile => one !== null && one !== undefined
  );
  const attempt = await runLipSync(
    {
      apiKey: input.apiKey ?? "",
      fetch: input.fetch,
      regenerate: input.regenerate,
      runs: stage12.paths.track.runs,
      workspace: input.workspace,
    },
    {
      blocked: (problems) => new Stage12BlockedError(problems),
      clip: origin.path,
      face,
      inputs: [
        { path: toWorkspacePath(input.workspace.root, origin.path), sha256: source.data.sha256 },
        ...faces,
        ...job.sounds,
      ],
      key: job.key,
      sessionId: session.data.sessionId,
      speech: job.speech,
      stage: STAGE,
      stagePath: stage12.paths.track.versionsStage,
      target: job.target,
    }
  );

  if (attempt.ok) {
    totals.created.push(...attempt.data.created);
    totals.lipSyncs += 1;
  }

  return attempt;
}

/** A fresh session on the job before this one, paid, addressed by Kling's id for its result. */
async function reopen(
  input: LipSyncInput,
  stage12: Stage12,
  clip: PlannedClip,
  origin: Origin,
  totals: Totals
): Promise<Result<Session>> {
  const found = await identifyFaces(
    {
      apiKey: input.apiKey ?? "",
      fetch: input.fetch,
      hosting: input.hosting,
      runs: stage12.paths.track.runs,
      workspace: input.workspace,
    },
    {
      blocked: (problems) => new Stage12BlockedError(problems.map((one) => `${clip.id}: ${one}`)),
      path: origin.path,
      record: origin.record,
    }
  );

  if (!found.ok) {
    return found;
  }

  totals.faces += 1;
  totals.notices.push(...found.data.notices);

  return ok({ faces: found.data.faces, sessionId: found.data.sessionId });
}
