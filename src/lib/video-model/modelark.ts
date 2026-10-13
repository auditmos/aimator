import type { ImageAttachment } from "../image-model/index.js";
import { err, ok, type Result } from "../result.js";
import type { VideoRequest } from "./client.js";
import type { VideoProvider } from "./provider.js";
import { parseAnswer, readUrl, TaskError, type VideoTask } from "./validate.js";

/**
 * Internal to the video-model module: BytePlus ModelArk on the wire, the
 * provider behind every `dreamina-seedance-*` model.
 *
 * Its one feature the other provider lacks is the one the chain leans on: asked
 * to, it hands back the frame the clip ended on, so the next clip has something
 * to continue out of without a decoder on this machine.
 */

const BASE = "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks";

/**
 * The resolution tier every clip is rendered in: the largest the model offers.
 *
 * The same reasoning as the image frame. A clip is bought once and cut into a
 * film afterwards, so pixels given up here cannot be recovered in the edit,
 * while an editor who wants fewer can always be given fewer.
 */
const RESOLUTION = "1080p";

/**
 * The ratio is inherited from the first frame, and it has to be: the provider
 * requires `adaptive` whenever a request pins its opening frame. That is not a
 * limitation here but the right answer, the entry frame was drawn in the
 * episode's `aspectRatio`, so the clip inherits a decision stage 0 stored
 * rather than one this module would have to restate.
 */
const RATIO = "adaptive";

interface TaskAnswer {
  readonly content?: { readonly last_frame_url?: string; readonly video_url?: string };
  readonly error?: { readonly code?: string; readonly message?: string };
  readonly id?: string;
  readonly status?: string;
}

export const modelArk: VideoProvider = {
  archive: archiveRequest,
  body: wireBody,
  endFrame: "returned",
  endpoint: () => BASE,
  key: "BYTEPLUS_MODELARK",
  matches: (model) => model.startsWith("dreamina-seedance-"),
  pattern: "dreamina-seedance-*",
  pollUrl: (jobId) => `${BASE}/${encodeURIComponent(jobId)}`,
  promptLimit: null,
  readSubmit: readSubmitResponse,
  readTask: readTaskResponse,
  seconds: { max: 30, min: 4 },
};

/**
 * The archive of a request: everything except the frame's bytes.
 *
 * Those bytes are an input, and the invariant says a run archive never copies
 * one. It is not only a rule: a film frame is megabytes, and an archive that
 * kept it would store the same picture twice on every attempt.
 */
function archiveRequest(request: VideoRequest): unknown {
  return {
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
    generateAudio: false,
    model: request.model,
    prompt: request.prompt,
    ratio: RATIO,
    resolution: RESOLUTION,
  };
}

function wireBody(request: VideoRequest): unknown {
  return {
    content: [
      { text: request.prompt, type: "text" },
      {
        image_url: { url: dataUri(request.firstFrame) },
        // Seedance 2.5 requires a role on every image, and this one is not a
        // reference: it is the instant the clip has to start on. The provider
        // treats the two as mutually exclusive modes, which is why a clip
        // carries its entry frame and nothing else.
        role: "first_frame",
        type: "image_url",
      },
    ],
    duration: request.duration,
    // The episode's soundtrack is continuous across cuts, so it belongs to the
    // edit and not to a model that can only hear one clip at a time. The field
    // defaults to true, so silence has to be asked for.
    generate_audio: false,
    model: request.model,
    ratio: RATIO,
    resolution: RESOLUTION,
    // The frame the clip ends on, handed back as a picture. It is what the next
    // clip is continued out of, so asking for it here is what keeps the chain
    // from needing a decoder of its own.
    return_last_frame: true,
    watermark: false,
  };
}

function dataUri(item: ImageAttachment): string {
  return `data:${item.type};base64,${item.bytes.toString("base64")}`;
}

/**
 * The job id a submitted request came back with.
 *
 * It is the only thing the POST returns, and it is the receipt: with it an
 * interrupted attempt is finished by asking, without it the only way forward is
 * paying again. That is why the caller writes it to disk before doing anything
 * else with it.
 */
function readSubmitResponse(body: string): Result<string> {
  const answer = parseAnswer<TaskAnswer>(body);

  if (!answer.ok) {
    return answer;
  }

  if (answer.data.error !== undefined) {
    return err(
      new TaskError(
        "provider",
        `API odmówiło uruchomienia zadania [${answer.data.error.code ?? "brak kodu"}]: ${answer.data.error.message ?? "bez treści"}`
      )
    );
  }

  return typeof answer.data.id === "string" && answer.data.id !== ""
    ? ok(answer.data.id)
    : err(new TaskError("empty", "API nie zwróciło identyfikatora zadania"));
}

/**
 * What a poll says about a job.
 *
 * A failed job is reported as failed rather than as an error of its own, because
 * the caller treats the two differently: a job the provider abandoned was not
 * rendered and not billed, so it may simply be started again.
 */
function readTaskResponse(body: string): Result<VideoTask> {
  const answer = parseAnswer<TaskAnswer>(body);

  if (!answer.ok) {
    return answer;
  }

  const { content, error, status } = answer.data;

  if (status === "failed" || status === "cancelled" || status === "expired") {
    return ok({
      kind: "failed",
      message: `zadanie zakończyło się statusem "${status}"${error?.message === undefined ? "" : `: ${error.message}`}`,
    });
  }

  if (status !== "succeeded") {
    return ok({ kind: "running", status: status ?? "unknown" });
  }

  const video = readUrl(content?.video_url, "wideo");

  if (!video.ok) {
    return video;
  }

  // The end frame is asked for, not required. A clip that came back without one
  // is still a clip somebody paid for, and the chain that needs the frame says
  // so in its own words rather than losing the video over it.
  const endFrame = readUrl(content?.last_frame_url, "ostatniej klatki");

  return ok({
    endFrameUrl: endFrame.ok ? endFrame.data : null,
    kind: "succeeded",
    // ModelArk names no result a later call could address it by.
    videoId: null,
    videoUrl: video.data,
  });
}
