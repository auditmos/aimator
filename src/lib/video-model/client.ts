import type { ImageAttachment } from "../image-model/index.js";
import { err, ok, type Result } from "../result.js";

/**
 * Internal to the video-model module: the paid job, and nothing else.
 *
 * `fetch` is injected so every rule around the call, no retry, the key never
 * reaching disk, a refusal being an error rather than a blank clip, is
 * testable without spending anything.
 *
 * A clip differs from an image in the one way that shapes this whole module:
 * the POST does not answer with the work, it answers with an id. Rendering
 * takes minutes, so the answer arrives through polling, and the clip and its
 * final frame arrive through signed URLs that live 24 hours. That is also what
 * makes an interrupted attempt cheap to finish: the id is the receipt.
 */

const BASE = "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks";

const REDACTED = "[UKRYTY KLUCZ]";
const TIMEOUT_MS = 2 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_DOWNLOAD_BYTES = 500_000_000;

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

export interface VideoRequest {
  readonly duration: number;
  readonly endpoint: string;
  /** The one image the request carries: the instant the clip starts on. */
  readonly firstFrame: ImageAttachment;
  readonly model: string;
  readonly prompt: string;
}

export interface Transport {
  /** The response body with the key redacted, ready to archive. */
  readonly body: string;
  readonly httpStatus: number;
  readonly receivedAt: string;
  readonly requestId: string | null;
}

class VideoCallError extends Error {
  readonly httpStatus: number | null;

  constructor(httpStatus: number | null, message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "VideoCallError";
    this.httpStatus = httpStatus;
  }
}

export function buildRequest(input: {
  readonly duration: number;
  readonly firstFrame: ImageAttachment;
  readonly model: string;
  readonly prompt: string;
}): VideoRequest {
  return { ...input, endpoint: BASE };
}

/**
 * The archive of a request: everything except the frame's bytes.
 *
 * Those bytes are an input, and the invariant says a run archive never copies
 * one. It is not only a rule: a film frame is megabytes, and an archive that
 * kept it would store the same picture twice on every attempt.
 */
export function archiveRequest(request: VideoRequest): unknown {
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

/**
 * Starts one job. Never two: a non-2xx answer is reported as it stands,
 * because a retry here is a second charge nobody asked for.
 */
export async function submitVideo(input: {
  readonly apiKey: string;
  readonly fetch: typeof fetch;
  readonly request: VideoRequest;
}): Promise<Result<Transport>> {
  return await call(input.fetch, input.apiKey, input.request.endpoint, {
    body: JSON.stringify(wireBody(input.request)),
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
}

/** Asks after a job that was already paid for. Free, and therefore repeatable. */
export async function pollVideo(input: {
  readonly apiKey: string;
  readonly fetch: typeof fetch;
  readonly jobId: string;
}): Promise<Result<Transport>> {
  return await call(input.fetch, input.apiKey, `${BASE}/${encodeURIComponent(input.jobId)}`, {
    headers: { Authorization: `Bearer ${input.apiKey}` },
    method: "GET",
  });
}

async function call(
  fetchImpl: typeof fetch,
  apiKey: string,
  url: string,
  init: RequestInit
): Promise<Result<Transport>> {
  let response: Response;

  try {
    response = await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    return err(
      new VideoCallError(
        null,
        "wywołanie API nie doszło do skutku (sieć albo przekroczony czas), nie ponawiam; sprawdź, czy próba nie została rozliczona",
        { cause }
      )
    );
  }

  const raw = await response.text();

  // Any answer that arrived is returned, including a rejection. Judging it here
  // would mean discarding the body before the caller could archive it, and a
  // refusal nobody can read is the one thing worse than a refusal.
  return ok({
    body: raw.replaceAll(apiKey, REDACTED),
    httpStatus: response.status,
    receivedAt: new Date().toISOString(),
    requestId: response.headers.get("x-request-id") ?? response.headers.get("x-tt-logid"),
  });
}

/**
 * Whether an archived answer is a refusal, and what the provider said.
 *
 * `null` means the call went through. The message carries the provider's own
 * words: "check the model, access and balance" is useless advice when the API
 * already said which field it objected to.
 */
export function httpFailure(transport: Transport): Error | null {
  if (transport.httpStatus < 400) {
    return null;
  }

  return new VideoCallError(
    transport.httpStatus,
    `API zwróciło HTTP ${transport.httpStatus}, nie ponawiam wywołania. Odpowiedź dostawcy: ${providerMessage(transport.body)}`
  );
}

function providerMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
    const { code, message } = parsed.error ?? {};

    if (typeof message === "string" && message !== "") {
      return code === undefined ? message : `[${code}] ${message}`;
    }
  } catch {
    // Not JSON: the raw text is the best diagnostic there is.
  }

  return body.slice(0, 600).trim() || "pusta";
}

/**
 * Whether a refused request can have been billed.
 *
 * A 4xx is the provider declining to start the job, so nothing was rendered and
 * a plain re-run is safe. A 429 or a 5xx is different: the job may have
 * started, so those keep the `--regenerate` rule that protects against paying
 * twice.
 */
export function refusedWithoutCharge(httpStatus: number): boolean {
  return httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429;
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
 * Fetches a finished asset. Unbilled and therefore repeatable: an attempt that
 * died after the job succeeded can be finished from the saved answer, with no
 * second charge, for as long as the provider's URL lives.
 */
export async function downloadAsset(input: {
  readonly fetch: typeof fetch;
  readonly url: string;
  readonly what: string;
}): Promise<Result<Buffer>> {
  let response: Response;

  try {
    // No credentials are ever sent to a result URL, including on a redirect.
    response = await input.fetch(input.url, {
      redirect: "error",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (cause) {
    return err(
      new VideoCallError(
        null,
        `nie udało się pobrać ${input.what} spod adresu zwróconego przez API, zadanie jest już opłacone, a adres żyje 24 h, więc powtórz to samo polecenie zamiast --regenerate`,
        { cause }
      )
    );
  }

  if (!response.ok) {
    return err(
      new VideoCallError(
        response.status,
        `pobranie ${input.what} zwróciło HTTP ${response.status}, zadanie jest już opłacone; powtórz polecenie, adres żyje 24 h`
      )
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());

  return bytes.length > MAX_DOWNLOAD_BYTES
    ? err(
        new VideoCallError(
          response.status,
          `pobrany plik ma ${bytes.length} bajtów i przekracza lokalny limit ${MAX_DOWNLOAD_BYTES}`
        )
      )
    : ok(bytes);
}
