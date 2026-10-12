import { err, ok, type Result } from "../result.js";
import type { VideoRequest } from "./client.js";
import type { VideoProvider } from "./provider.js";
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

  const video = readUrl(task.outputs?.find((one) => one.type === "video")?.url, "wideo");

  return video.ok ? ok({ endFrameUrl: null, kind: "succeeded", videoUrl: video.data }) : video;
}
