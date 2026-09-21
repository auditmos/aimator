import { err, ok, type Result } from "../result.js";

/**
 * Internal to the audio-model module: the two paid calls, and nothing else.
 *
 * `fetch` is injected so every rule around a call, no retry, the key never
 * reaching disk, a refusal being an error rather than a blank file, is
 * testable without spending anything.
 *
 * Two endpoints behind one module, with `lib/image-model`'s precedent. What
 * they have in common is everything that matters here: one provider, one key,
 * one container, one verdict, one lifecycle, and an answer that is the audio
 * itself rather than a document describing it. What differs is a URL and the
 * name of the field carrying the description, which is a reason for two
 * functions, not for two modules.
 *
 * Like the speech endpoint and unlike the image ones, **the answer is not
 * JSON**; the provider only speaks JSON when it is refusing. So the transport
 * carries both, and which one is filled is how a caller tells bought audio
 * from a rejected request.
 */

const MUSIC_ENDPOINT = "https://api.elevenlabs.io/v1/music";
const EFFECT_ENDPOINT = "https://api.elevenlabs.io/v1/sound-generation";
/**
 * The container every stem is bought in.
 *
 * MP3 because neither endpoint offers WAV and their raw PCM carries no header;
 * see `validate.ts`, where that is argued out. 44.1 kHz at 128 kbps because
 * it is the one quality both endpoints document on every plan: 192 kbps needs
 * Creator tier or above, and a request the provider refuses is worse than a
 * bitrate nobody hears the difference in under a narrator. A constant of the
 * call site, like an endpoint, not a decision.
 */
const OUTPUT_FORMAT = "mp3_44100_128";
/**
 * How literally the effect model takes its description.
 *
 * The provider's own documented default, sent explicitly for the reason stage
 * 9 sends its delivery settings explicitly: the request archive has to answer
 * what produced these bytes rather than defer to whatever the provider's
 * defaults were that month. It is not a knob, and will not become one until
 * somebody actually needs to turn it, a widened interface bought with nothing
 * is the thing this repository refuses.
 */
const PROMPT_INFLUENCE = 0.3;
const REDACTED = "[UKRYTY KLUCZ]";
const TIMEOUT_MS = 10 * 60_000;
const MAX_BYTES = 80_000_000;

/** Which of the two things is being bought. The stage says; this module sends. */
export type AudioKind = "effect" | "music";

export interface AudioRequest {
  readonly endpoint: string;
  /**
   * Whether the bed is guaranteed to have no singing in it.
   *
   * Derived by the stage from the episode's sound mode rather than stored: an
   * episode whose mode carries speech has already decided that a voice is the
   * foreground, and a second voice singing over the narrator is not a choice
   * anybody made. A mode with no speech in it may legitimately have vocals.
   */
  readonly instrumental: boolean;
  readonly kind: AudioKind;
  readonly model: string;
  /** What the provider rates: the length of audio being asked for. */
  readonly seconds: number;
  /** The cue, in English. It is an instruction, and rule 9 says so. */
  readonly text: string;
}

interface AudioTransport {
  /** The audio, when the provider sent audio. `null` on a refusal. */
  readonly audio: Buffer | null;
  /** The refusal, with the key redacted, ready to archive. `null` on success. */
  readonly body: string | null;
  readonly httpStatus: number;
  readonly receivedAt: string;
  readonly requestId: string | null;
}

class AudioCallError extends Error {
  readonly httpStatus: number | null;

  constructor(httpStatus: number | null, message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "AudioCallError";
    this.httpStatus = httpStatus;
  }
}

/** The request, assembled from what the stage decided. */
export function buildRequest(input: {
  readonly instrumental: boolean;
  readonly kind: AudioKind;
  readonly model: string;
  readonly seconds: number;
  readonly text: string;
}): AudioRequest {
  const base = input.kind === "music" ? MUSIC_ENDPOINT : EFFECT_ENDPOINT;

  return {
    endpoint: `${base}?output_format=${OUTPUT_FORMAT}`,
    instrumental: input.instrumental,
    kind: input.kind,
    model: input.model,
    seconds: input.seconds,
    text: input.text,
  };
}

/**
 * The body, in the provider's spelling. Kept in one place so the archive
 * matches what was actually sent.
 *
 * The music endpoint takes a prose `prompt` and a length in milliseconds; the
 * effect endpoint takes `text` and a length in seconds. Prose rather than a
 * composition plan, because a prompt in this pipeline is prose everywhere else
 * and the model is built to read it, a plan of style lists would be JSON
 * standing where sentences belong, which is what stage 4 refused.
 */
function requestBody(request: AudioRequest): Record<string, unknown> {
  if (request.kind === "music") {
    return {
      force_instrumental: request.instrumental,
      model_id: request.model,
      music_length_ms: Math.round(request.seconds * 1000),
      prompt: request.text,
    };
  }

  return {
    duration_seconds: request.seconds,
    // A one-shot anchored at a second of the film, never a looping bed: the
    // bed is what the music endpoint is for.
    loop: false,
    model_id: request.model,
    prompt_influence: PROMPT_INFLUENCE,
    text: request.text,
  };
}

/** The archive of a request. An audio call carries no attachments, so this is all of it. */
export function archiveRequest(request: AudioRequest): unknown {
  return {
    body: requestBody(request),
    endpoint: request.endpoint,
    kind: request.kind,
    outputFormat: OUTPUT_FORMAT,
    seconds: request.seconds,
  };
}

/**
 * One call. Never two: a non-2xx answer is reported as it stands, because a
 * retry here is a second full charge nobody asked for, this provider bills at
 * generation rather than at download.
 */
export async function callAudio(input: {
  readonly apiKey: string;
  readonly fetch: typeof fetch;
  readonly request: AudioRequest;
}): Promise<Result<AudioTransport>> {
  let response: Response;

  try {
    response = await input.fetch(input.request.endpoint, {
      body: JSON.stringify(requestBody(input.request)),
      headers: {
        Accept: "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": input.apiKey,
      },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    return err(
      new AudioCallError(
        null,
        "wywołanie API nie doszło do skutku (sieć albo przekroczony czas), nie ponawiam; sprawdź, czy próba nie została rozliczona",
        { cause }
      )
    );
  }

  const raw = Buffer.from(await response.arrayBuffer());

  if (raw.length > MAX_BYTES) {
    return err(
      new AudioCallError(
        response.status,
        `odpowiedź ma ${raw.length} bajtów i przekracza lokalny limit ${MAX_BYTES}`
      )
    );
  }

  const meta = {
    httpStatus: response.status,
    receivedAt: new Date().toISOString(),
    requestId: response.headers.get("request-id") ?? response.headers.get("x-request-id"),
  };

  // Any answer that arrived is returned, including a rejection. Judging it
  // here would mean discarding the body before the caller could archive it.
  return ok(
    response.status >= 400
      ? { ...meta, audio: null, body: raw.toString("utf8").replaceAll(input.apiKey, REDACTED) }
      : { ...meta, audio: raw, body: null }
  );
}

/** Whether an archived answer is a refusal, and what the provider said. */
export function httpFailure(transport: AudioTransport): Error | null {
  if (transport.httpStatus < 400) {
    return null;
  }

  return new AudioCallError(
    transport.httpStatus,
    `API zwróciło HTTP ${transport.httpStatus}, nie ponawiam wywołania. Odpowiedź dostawcy: ${providerMessage(transport.body ?? "")}`
  );
}

/** The provider's error text, or the raw body when it is not the shape we know. */
function providerMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      detail?: { message?: string; status?: string } | string;
    };
    const { detail } = parsed;

    if (typeof detail === "string") {
      return detail === "" ? body : detail;
    }

    const message = detail?.message;

    if (typeof message === "string" && message !== "") {
      return detail?.status === undefined ? message : `[${detail.status}] ${message}`;
    }
  } catch {
    // Not JSON: the raw text is the best diagnostic there is.
  }

  return body.slice(0, 600).trim() || "pusta";
}

/**
 * Whether a refused request can have been billed.
 *
 * A 4xx is the provider declining to do the work, so nothing was charged and a
 * plain re-run is safe. A 429 or a 5xx is different: the work may have started,
 * so those keep the `--regenerate` rule that protects against paying twice.
 */
export function refusedWithoutCharge(httpStatus: number): boolean {
  return httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429;
}
