import { err, ok, type Result } from "../result.js";
import type { VideoRequest } from "./client.js";
import type { JobWire, VideoProvider } from "./provider.js";
import { parseAnswer, readUrl, TaskError, type VideoTask } from "./validate.js";

/**
 * Internal to the video-model module: Kling on the wire, the provider behind
 * `kling-3.0`.
 *
 * Two things differ from ModelArk, and only one of them is visible from
 * outside. The envelope: every answer is `{ code, message, data }`, and `code`
 * other than zero is the provider declining, whatever the HTTP status said. And
 * the end frame: Kling hands back the video and nothing beside it, so the frame
 * the next clip continues out of is cut out of the downloaded clip by this
 * module's caller, which is why `endFrame` here says `cut`.
 */

const BASE = "https://api-singapore.klingai.com";

/** The same tier as ModelArk's, for the same reason: pixels lost here stay lost. */
const RESOLUTION = "1080p";

interface Envelope<T> {
  readonly code?: number;
  readonly data?: T;
  readonly message?: string;
}

interface KlingTask {
  readonly id?: string;
  readonly message?: string;
  readonly outputs?: readonly {
    readonly id?: string;
    readonly type?: string;
    readonly url?: string;
  }[];
  readonly status?: string;
}

export const kling: VideoProvider = {
  archive: archiveRequest,
  body: wireBody,
  endFrame: "cut",
  endpoint: (model) => `${BASE}/image-to-video/${encodeURIComponent(model)}`,
  key: "KLING_API_KEY",
  matches: (model) => model === "kling-3.0",
  pattern: "kling-3.0",
  pollUrl: (jobId) => `${BASE}/tasks?task_ids=${encodeURIComponent(jobId)}`,
  promptLimit: 3072,
  readSubmit,
  readTask,
  seconds: { max: 15, min: 3 },
};

/** The archive of a request: the settings as sent, the frame by digest only. */
function archiveRequest(request: VideoRequest): unknown {
  return {
    audio: "off",
    duration: request.duration,
    endpoint: request.endpoint,
    firstFrame: {
      bytes: request.firstFrame.bytes.length,
      name: request.firstFrame.name,
      position: 1,
      role: "first_frame",
      sha256: request.firstFrame.sha256,
      type: request.firstFrame.type,
    },
    model: request.model,
    multiShot: false,
    prompt: request.prompt,
    resolution: RESOLUTION,
    watermark: false,
  };
}

function wireBody(request: VideoRequest): unknown {
  return {
    contents: [
      { text: request.prompt, type: "prompt" },
      // Raw Base64 with no `data:` prefix. The documentation accepts "URL or
      // Base64" without saying which spelling, and Kling's older endpoints
      // refused the prefix; the first real call is what confirms this.
      { type: "first_frame", url: request.firstFrame.bytes.toString("base64") },
    ],
    // No watermark, for the reason a clip is rendered at the top tier: the
    // bytes are the film.
    options: { watermark_info: { enabled: false } },
    settings: {
      // Silent, like every clip: the soundtrack belongs to the edit, which can
      // hear the whole film, and not to a model that hears one clip.
      audio: "off",
      duration: request.duration,
      // One shot per clip: the shot list already decided where the cuts are.
      multi_shot: false,
      resolution: RESOLUTION,
    },
  };
}

/** The provider's own refusal inside a 2xx answer, or `null` when there is none. */
function declined<T>(answer: Envelope<T>, what: string): TaskError | null {
  return typeof answer.code === "number" && answer.code !== 0
    ? new TaskError(
        "provider",
        `API odmówiło ${what} [${answer.code}]: ${answer.message ?? "bez treści"}`
      )
    : null;
}

/** The receipt: `data.id`, written to disk by the caller before the first poll. */
function readSubmit(body: string): Result<string> {
  const answer = parseAnswer<Envelope<{ readonly id?: string }>>(body);

  if (!answer.ok) {
    return answer;
  }

  const refused = declined(answer.data, "uruchomienia zadania");

  if (refused !== null) {
    return err(refused);
  }

  const id = answer.data.data?.id;

  return typeof id === "string" && id !== ""
    ? ok(id)
    : err(new TaskError("empty", "API nie zwróciło identyfikatora zadania"));
}

/**
 * What a query says about the one task asked after.
 *
 * `failed` carries Kling's `message`, which is the only account of why there
 * is when the platform's content checks turned a job down. The answer itself,
 * with every output id in it, is archived by the caller before this is read.
 */
function readTask(body: string): Result<VideoTask> {
  const answer = parseAnswer<Envelope<readonly KlingTask[]>>(body);

  if (!answer.ok) {
    return answer;
  }

  const refused = declined(answer.data, "odpowiedzi o zadanie");

  if (refused !== null) {
    return err(refused);
  }

  const tasks: readonly KlingTask[] = Array.isArray(answer.data.data) ? answer.data.data : [];
  const [task] = tasks;

  if (task === undefined) {
    return err(new TaskError("empty", "API nie zwróciło stanu zadania"));
  }

  if (task.status === "failed") {
    return ok({
      kind: "failed",
      message: `zadanie zakończyło się statusem "failed"${task.message === undefined || task.message === "" ? "" : `: ${task.message}`}`,
    });
  }

  if (task.status !== "succeeded") {
    return ok({ kind: "running", status: task.status ?? "unknown" });
  }

  const output = task.outputs?.find((one) => one.type === "video");
  const video = readUrl(output?.url, "wideo");

  return video.ok
    ? ok({
        endFrameUrl: null,
        kind: "succeeded",
        videoId: output?.id ?? null,
        videoUrl: video.data,
      })
    : video;
}

/**
 * The other two calls Kling sells for a clip it did not necessarily render:
 * finding the faces in it, and moving one face's lips to a sound. Both live
 * under `/v1/videos/`, unlike the 3.0 render above, and the lip-sync job is
 * polled at its own path rather than through `/tasks`.
 */
export const LIP_SYNC_ENDPOINT = `${BASE}/v1/videos/advanced-lip-sync`;

export const IDENTIFY_FACE = `${BASE}/v1/videos/identify-face`;

/** What a face call is handed: the provider's own id for the clip, or an address to fetch. */
export type FaceSource = { readonly videoId: string } | { readonly videoUrl: string };

export function identifyBody(source: FaceSource): unknown {
  return "videoId" in source ? { video_id: source.videoId } : { video_url: source.videoUrl };
}

/** A face as found: the provider's id for it, its picture, and when it is on screen, in ms. */
export interface Face {
  readonly end: number;
  readonly id: string;
  readonly image: string;
  readonly start: number;
}

interface IdentifiedFace {
  readonly end_time?: number;
  readonly face_id?: string;
  readonly face_image?: string;
  readonly start_time?: number;
}

/** The session a later job is addressed by, and every face in it. */
export function readFaces(
  body: string
): Result<{ readonly faces: readonly Face[]; readonly sessionId: string }> {
  const answer =
    parseAnswer<
      Envelope<{ readonly face_data?: readonly IdentifiedFace[]; readonly session_id?: string }>
    >(body);

  if (!answer.ok) {
    return answer;
  }

  const refused = declined(answer.data, "rozpoznania twarzy");

  if (refused !== null) {
    return err(refused);
  }

  const sessionId = answer.data.data?.session_id;

  if (typeof sessionId !== "string" || sessionId === "") {
    return err(new TaskError("empty", "API nie zwróciło identyfikatora sesji rozpoznania twarzy"));
  }

  const faces: Face[] = [];

  for (const face of answer.data.data?.face_data ?? []) {
    const image = readUrl(face.face_image, "obrazka twarzy");

    if (!image.ok) {
      return image;
    }

    if (
      typeof face.face_id !== "string" ||
      typeof face.start_time !== "number" ||
      typeof face.end_time !== "number"
    ) {
      return err(new TaskError("malformed", "API zwróciło twarz bez id albo bez przedziału czasu"));
    }

    faces.push({ end: face.end_time, id: face.face_id, image: image.data, start: face.start_time });
  }

  return ok({ faces, sessionId });
}

/** One face moved to one sound, every time in ms, the sound as sent. */
interface LipSyncOrder {
  readonly faceId: string;
  /** Where on the clip's clock the sound goes in. */
  readonly insertAt: number;
  readonly sessionId: string;
  readonly sound: Buffer;
  /** The sound's own length: the whole of it is used, never a crop. */
  readonly soundLength: number;
}

/**
 * The job as sent. `face_choose` holds one face, because the provider moves one
 * face per job and a second character in the same clip is a second job, run on
 * the first one's result.
 */
export function lipSyncBody(order: LipSyncOrder): unknown {
  return {
    face_choose: [
      {
        face_id: order.faceId,
        sound_end_time: order.soundLength,
        // Raw Base64, the spelling the clip's first frame travels in.
        sound_file: order.sound.toString("base64"),
        sound_insert_time: order.insertAt,
        sound_start_time: 0,
      },
    ],
    session_id: order.sessionId,
    watermark_info: { enabled: false },
  };
}

/** The job as archived: the sound by digest only, everything else as sent. */
export function lipSyncArchive(order: LipSyncOrder, sha256: string): unknown {
  return {
    endpoint: LIP_SYNC_ENDPOINT,
    faceChoose: [
      {
        faceId: order.faceId,
        sound: { bytes: order.sound.length, sha256, type: "audio/wav" },
        soundEndTime: order.soundLength,
        soundInsertTime: order.insertAt,
        soundStartTime: 0,
      },
    ],
    sessionId: order.sessionId,
    watermark: false,
  };
}

interface LipSyncTask {
  readonly task_id?: string;
  readonly task_result?: {
    readonly videos?: readonly { readonly id?: string; readonly url?: string }[];
  };
  readonly task_status?: string;
  readonly task_status_msg?: string;
}

/**
 * The lip-sync job on the wire: a different receipt (`task_id`), a different
 * poll and a different spelling of success (`succeed`). No frame is handed
 * back and none is cut, because nothing continues out of a lip-synced clip.
 */
export const klingLipSync: JobWire = {
  endFrame: "none",
  pollUrl: (jobId) => `${LIP_SYNC_ENDPOINT}/${encodeURIComponent(jobId)}`,
  readSubmit: (body) => {
    const answer = parseAnswer<Envelope<LipSyncTask>>(body);

    if (!answer.ok) {
      return answer;
    }

    const refused = declined(answer.data, "uruchomienia lip-syncu");
    const id = answer.data.data?.task_id;

    if (refused !== null) {
      return err(refused);
    }

    return typeof id === "string" && id !== ""
      ? ok(id)
      : err(new TaskError("empty", "API nie zwróciło identyfikatora zadania"));
  },
  readTask: (body) => {
    const answer = parseAnswer<Envelope<LipSyncTask>>(body);

    if (!answer.ok) {
      return answer;
    }

    const refused = declined(answer.data, "odpowiedzi o lip-sync");

    if (refused !== null) {
      return err(refused);
    }

    const task = answer.data.data;

    if (task?.task_status === "failed") {
      const message = task.task_status_msg ?? "";

      return ok({
        kind: "failed",
        message: `lip-sync zakończył się statusem "failed"${message === "" ? "" : `: ${message}`}`,
      });
    }

    if (task?.task_status !== "succeed") {
      return ok({ kind: "running", status: task?.task_status ?? "unknown" });
    }

    const [output] = task.task_result?.videos ?? [];
    const video = readUrl(output?.url, "wideo");

    return video.ok
      ? ok({
          endFrameUrl: null,
          kind: "succeeded",
          videoId: output?.id ?? null,
          videoUrl: video.data,
        })
      : video;
  },
};
