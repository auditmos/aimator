import { z } from "zod";
import {
  newRunId,
  nowIso,
  type RecordedFile,
  readDigest,
  readJson,
  type StageName,
  serialize,
  sha256Of,
  toWorkspacePath,
  writeNew,
} from "../artifact/index.js";
import { type HostingVariables, hostFile } from "../hosting.js";
import { err, ok, type Result } from "../result.js";
import { videoRunPaths, type Workspace } from "../workspace.js";
import { type JobCall, runJob, type VideoAttempt } from "./attempt.js";
import { httpFailure, submitVideo } from "./client.js";
import {
  type Face,
  type FaceSource,
  IDENTIFY_FACE,
  identifyBody,
  klingLipSync,
  LIP_SYNC_ENDPOINT,
  lipSyncArchive,
  lipSyncBody,
  readFaces,
} from "./kling.js";
import { type JobWire, providerOf } from "./provider.js";
import { validateLipSyncInput, validateLipSyncResult } from "./validate.js";

/**
 * Internal to the video-model module: Kling Lip Sync, the second kind of job
 * this module buys, and the paid call that comes before it.
 *
 * Finding the faces is synchronous and paid, and it is the only call that ever
 * sees the video: the job afterwards is addressed by the session it opened. So
 * the video's source is decided here, once. Kling's own id when Kling rendered
 * the clip less than thirty days ago, read out of the archive of the attempt
 * that bought it; otherwise the clip is lent from the private bucket for the
 * length of this one call and taken back however the call ends.
 */

/** How long Kling addresses a video it rendered by its id. */
const ID_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The name a lip-sync record carries as its model. The endpoint takes no model,
 * and the record still has to say which wire its archive is read in.
 */
const LIP_SYNC_MODEL = "kling-lip-sync";

/** The record that published a clip, as far as finding its provider's id needs it. */
interface PublishedBy {
  readonly producer: { readonly model: string | null };
  readonly runId: string;
}

interface IdentifyCall {
  readonly apiKey: string;
  readonly fetch: typeof fetch;
  /** The private bucket, read only because this call may have to lend the clip. */
  readonly hosting: HostingVariables;
  /** Injected so the thirty days can be crossed in a test; the default is now. */
  readonly now?: () => Date;
  /** The track's `runs/`, where the clip's own attempt was archived and this one is. */
  readonly runs: string;
  readonly workspace: Workspace;
}

interface IdentifyClip {
  readonly blocked: (problems: readonly string[]) => Error;
  readonly path: string;
  readonly record: PublishedBy;
}

interface Identified {
  readonly faces: readonly Face[];
  /** What a person should know that did not stop the call: a lent clip left behind. */
  readonly notices: readonly string[];
  readonly runId: string;
  readonly sessionId: string;
  readonly source: "video_id" | "video_url";
}

function wireOf(model: string | null): JobWire | null {
  if (model === LIP_SYNC_MODEL) {
    return klingLipSync;
  }

  const provider = providerOf(model ?? "");

  return provider.ok ? provider.data : null;
}

/**
 * Kling's id for the clip, when it has one and it still answers to it. The
 * thirty days are counted from when the attempt started rather than from when
 * it was published, so an attempt collected late is never taken for younger
 * than it is.
 */
async function ownId(runs: string, record: PublishedBy, now: Date): Promise<string | null> {
  const wire = wireOf(record.producer.model);

  if (wire === null) {
    return null;
  }

  const run = videoRunPaths({ runs }, record.runId);
  const started = await readJson(run.run, z.object({ startedAt: z.iso.datetime() }));

  if (!started.ok || now.getTime() - Date.parse(started.data.startedAt) >= ID_LIFETIME_MS) {
    return null;
  }

  const saved = await readDigest(run.response);
  const task = saved.ok ? wire.readTask(saved.data.bytes.toString("utf8")) : null;

  return task?.ok === true && task.data.kind === "succeeded" ? task.data.videoId : null;
}

/**
 * Finds the faces in one clip, which is paid, and archives what was asked and
 * answered. The clip is judged first, so a clip lip-sync would refuse costs
 * nothing.
 */
export async function identifyFaces(
  call: IdentifyCall,
  clip: IdentifyClip
): Promise<Result<Identified>> {
  const now = call.now ?? (() => new Date());
  const bytes = await readDigest(clip.path);

  if (!bytes.ok) {
    return err(clip.blocked([`nie ma klipu ${toWorkspacePath(call.workspace.root, clip.path)}`]));
  }

  const input = validateLipSyncInput(bytes.data.bytes);

  if (!input.ok) {
    return err(clip.blocked([input.error.message]));
  }

  const recorded = {
    path: toWorkspacePath(call.workspace.root, clip.path),
    sha256: bytes.data.sha256,
  };
  const own = await ownId(call.runs, clip.record, now());

  if (own !== null) {
    return await identify(call, recorded, { videoId: own }, null);
  }

  const hosted = await hostFile({
    fetch: call.fetch,
    now,
    path: clip.path,
    variables: call.hosting,
  });

  if (!hosted.ok) {
    return err(clip.blocked([hosted.error.message]));
  }

  let found: Result<Identified>;
  let notice: string | null = null;

  try {
    found = await identify(call, recorded, { videoUrl: hosted.data.url }, hosted.data);
  } finally {
    // Taken back however the call ended: the session holds the video now, and
    // nothing after this call fetches it again.
    notice = await hosted.data.remove();
  }

  if (notice === null) {
    return found;
  }

  return found.ok
    ? ok({ ...found.data, notices: [...found.data.notices, notice] })
    : err(clip.blocked([found.error.message, notice]));
}

async function identify(
  call: IdentifyCall,
  clip: RecordedFile,
  source: FaceSource,
  lent: { readonly expiresAt: string; readonly url: string } | null
): Promise<Result<Identified>> {
  const runId = newRunId();
  const run = videoRunPaths(call, runId);
  // A signed URL is a credential until it expires, so the archive keeps the
  // object it named and when it stopped answering, never the signature.
  const sent =
    lent === null
      ? identifyBody(source)
      : { video_url: { expiresAt: lent.expiresAt, object: lent.url.split("?")[0] } };

  await writeNew(run.request, serialize({ body: sent, endpoint: IDENTIFY_FACE }));
  await writeNew(
    run.run,
    serialize({
      endpoint: IDENTIFY_FACE,
      inputs: [clip],
      kind: "identify-face",
      runId,
      startedAt: nowIso(),
      status: "submitted",
    })
  );

  const transport = await submitVideo({
    apiKey: call.apiKey,
    body: identifyBody(source),
    fetch: call.fetch,
    url: IDENTIFY_FACE,
  });

  if (!transport.ok) {
    return transport;
  }

  await writeNew(run.transport, serialize(transport.data));
  await writeNew(run.response, transport.data.body);

  const refused = httpFailure(transport.data);

  if (refused !== null) {
    return err(refused);
  }

  const found = readFaces(transport.data.body);

  return found.ok
    ? ok({
        faces: found.data.faces,
        notices: [],
        runId,
        sessionId: found.data.sessionId,
        source: "videoId" in source ? "video_id" : "video_url",
      })
    : found;
}

/** The provider's floor for how long the sound and the face share the screen. */
const MIN_OVERLAP_MS = 2000;

class LipSyncError extends Error {
  readonly reason: "end-frame" | "model";

  constructor(reason: LipSyncError["reason"], message: string) {
    super(message);
    this.name = "LipSyncError";
    this.reason = reason;
  }
}

/** Everything a lip-sync job needs that is not about one clip. */
type LipSyncCall = Omit<JobCall, "instruction" | "model" | "mux">;

interface LipSyncArtifact {
  readonly blocked: (problems: readonly string[]) => Error;
  /** The clip the faces were found in; the result must keep its frame and length. */
  readonly clip: string;
  /** The one face this job moves, as the face call found it, in ms. */
  readonly face: Pick<Face, "end" | "id" | "start">;
  readonly inputs: readonly RecordedFile[];
  readonly key: string;
  readonly sessionId: string;
  /**
   * One character's lines in this clip as one sound, where it starts on the
   * clip's clock and how long it runs, in seconds: `speechTrack`'s answer.
   */
  readonly speech: { readonly seconds: number; readonly start: number; readonly wav: Buffer };
  readonly stage: StageName;
  readonly stagePath: string;
  readonly target: string;
}

function seconds(ms: number): number {
  return Math.round(ms / 100) / 10;
}

/**
 * One face moved to one sound: judged first, then bought through the same
 * sequence a clip is, so the task id is on disk before the first poll and an
 * interrupted job is finished by asking.
 */
export async function runLipSync(
  call: LipSyncCall,
  artifact: LipSyncArtifact
): Promise<Result<VideoAttempt>> {
  const clip = await readDigest(artifact.clip);

  if (!clip.ok) {
    return err(
      artifact.blocked([`nie ma klipu ${toWorkspacePath(call.workspace.root, artifact.clip)}`])
    );
  }

  const input = validateLipSyncInput(clip.data.bytes);

  if (!input.ok) {
    return err(artifact.blocked([input.error.message]));
  }

  const insertAt = Math.round(artifact.speech.start * 1000);
  const soundLength = Math.floor(artifact.speech.seconds * 1000);
  const ends = insertAt + soundLength;
  const shared = Math.min(ends, artifact.face.end) - Math.max(insertAt, artifact.face.start);

  // Both are the provider's own refusals, made here because the face call
  // before this job is already paid and a refused job would only add a wait.
  if (ends > input.data.seconds * 1000) {
    return err(
      artifact.blocked([
        `dźwięk kończy się w ${seconds(ends)}s, a klip trwa ${input.data.seconds}s`,
      ])
    );
  }

  if (shared < MIN_OVERLAP_MS) {
    return err(
      artifact.blocked([
        `dźwięk od ${seconds(insertAt)}s do ${seconds(ends)}s dzieli z twarzą ${artifact.face.id} (od ${seconds(artifact.face.start)}s do ${seconds(artifact.face.end)}s) ${seconds(Math.max(shared, 0))}s, a lip-sync wymaga co najmniej ${seconds(MIN_OVERLAP_MS)}s`,
      ])
    );
  }

  const order = {
    faceId: artifact.face.id,
    insertAt,
    sessionId: artifact.sessionId,
    sound: artifact.speech.wav,
    soundLength,
  };

  return await runJob(
    { ...call, model: LIP_SYNC_MODEL },
    {
      blocked: artifact.blocked,
      endFrameTarget: () =>
        err(new LipSyncError("end-frame", "lip-sync nie oddaje klatki, z której coś wychodzi")),
      inputs: artifact.inputs,
      key: artifact.key,
      promptVersion: null,
      seconds: input.data.seconds,
      stage: artifact.stage,
      stagePath: artifact.stagePath,
      target: artifact.target,
      verdict: (video) => validateLipSyncResult(video, input.data),
    },
    {
      order: () => ({
        archive: lipSyncArchive(order, sha256Of(order.sound)),
        body: lipSyncBody(order),
        endpoint: LIP_SYNC_ENDPOINT,
        prompt: null,
      }),
      wireOf: (model) =>
        model === LIP_SYNC_MODEL
          ? ok(klingLipSync)
          : err(
              new LipSyncError(
                "model",
                `zadanie zapisano dla modelu ${model}, a lip-sync odbiera wyłącznie ${LIP_SYNC_MODEL}`
              )
            ),
    }
  );
}
