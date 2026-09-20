import { err, ok, type Result } from "../result.js";

/**
 * Internal to the voice-model module: the paid call, and nothing else.
 *
 * `fetch` is injected so every rule around the call — no retry, the key never
 * reaching disk, a refusal being an error rather than a blank line — is
 * testable without spending anything.
 *
 * This provider differs from the other three in one way that shapes the whole
 * module: **the answer is not JSON.** An image endpoint hands back a document
 * holding bytes or a URL; this one hands back the audio itself, and only speaks
 * JSON when it is refusing. So the transport carries both, and which one is
 * filled is how a caller tells a bought line from a rejected request.
 *
 * The output format is a constant of the call site rather than a decision,
 * exactly as an endpoint is. It is WAV because the verdict on a bought line has
 * to be readable offline, with no decoder — see `validate.ts`.
 */

const ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";
/**
 * The container and rate every line is bought in.
 *
 * WAV so the length is stated in the header rather than counted out of frames;
 * 24 kHz because the rates above it are gated behind a higher plan than this
 * account holds, and a request the provider refuses is worse than a rate nobody
 * hears the difference in under a film.
 */
const OUTPUT_FORMAT = "wav_24000";
const REDACTED = "[UKRYTY KLUCZ]";
const TIMEOUT_MS = 5 * 60_000;
const MAX_BYTES = 50_000_000;

export interface SpeechRequest {
  readonly endpoint: string;
  readonly model: string;
  /** Verbatim, in the film's own language. It is material, never an instruction. */
  readonly text: string;
  readonly voiceId: string;
}

interface SpeechTransport {
  /** The audio, when the provider sent audio. `null` on a refusal. */
  readonly audio: Buffer | null;
  /** The refusal, with the key redacted, ready to archive. `null` on success. */
  readonly body: string | null;
  readonly httpStatus: number;
  readonly receivedAt: string;
  readonly requestId: string | null;
}

class SpeechCallError extends Error {
  readonly httpStatus: number | null;

  constructor(httpStatus: number | null, message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "SpeechCallError";
    this.httpStatus = httpStatus;
  }
}

/**
 * The request, assembled from what the stage decided.
 *
 * The voice comes from the stage because it comes from `project.json`: which
 * voice reads the series is casting, and casting is not a fact about how bytes
 * travel. What this module decides is the part true of any line — which
 * endpoint, which container, and that there is exactly one call per utterance.
 */
export function buildRequest(input: {
  readonly model: string;
  readonly text: string;
  readonly voiceId: string;
}): SpeechRequest {
  return {
    endpoint: `${ENDPOINT}/${encodeURIComponent(input.voiceId)}?output_format=${OUTPUT_FORMAT}`,
    model: input.model,
    text: input.text,
    voiceId: input.voiceId,
  };
}

/**
 * The archive of a request. Unlike an image request there is nothing to leave
 * out: a speech call carries no attachments, so what was sent is exactly this.
 */
export function archiveRequest(request: SpeechRequest): unknown {
  return {
    endpoint: request.endpoint,
    model: request.model,
    outputFormat: OUTPUT_FORMAT,
    text: request.text,
    voiceId: request.voiceId,
  };
}

/**
 * One call. Never two: a non-2xx answer is reported as it stands, because a
 * retry here is a second charge nobody asked for.
 */
export async function callSpeech(input: {
  readonly apiKey: string;
  readonly fetch: typeof fetch;
  readonly request: SpeechRequest;
}): Promise<Result<SpeechTransport>> {
  let response: Response;

  try {
    response = await input.fetch(input.request.endpoint, {
      body: JSON.stringify({ model_id: input.request.model, text: input.request.text }),
      headers: {
        Accept: "audio/wav",
        "Content-Type": "application/json",
        "xi-api-key": input.apiKey,
      },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    return err(
      new SpeechCallError(
        null,
        "wywołanie API nie doszło do skutku (sieć albo przekroczony czas) — nie ponawiam; sprawdź, czy próba nie została rozliczona",
        { cause }
      )
    );
  }

  const raw = Buffer.from(await response.arrayBuffer());

  if (raw.length > MAX_BYTES) {
    return err(
      new SpeechCallError(
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

  // Any answer that arrived is returned, including a rejection. Judging it here
  // would mean discarding the body before the caller could archive it, and a
  // refusal nobody can read is the one thing worse than a refusal.
  return ok(
    response.status >= 400
      ? { ...meta, audio: null, body: raw.toString("utf8").replaceAll(input.apiKey, REDACTED) }
      : { ...meta, audio: raw, body: null }
  );
}

/**
 * Whether an archived answer is a refusal, and what the provider said.
 *
 * `null` means the call succeeded. The message carries the provider's own
 * words, because "check your key" is useless advice when the API already said
 * which field it objected to.
 */
export function httpFailure(transport: SpeechTransport): Error | null {
  if (transport.httpStatus < 400) {
    return null;
  }

  return new SpeechCallError(
    transport.httpStatus,
    `API zwróciło HTTP ${transport.httpStatus} — nie ponawiam wywołania. Odpowiedź dostawcy: ${providerMessage(transport.body ?? "")}`
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
