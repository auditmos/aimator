import type { ImageAttachment } from "../image-model/index.js";
import { err, ok, type Result } from "../result.js";

/**
 * Internal to the video-model module: the paid job's transport, and nothing
 * else.
 *
 * `fetch` is injected so every rule around the call, no retry, the key never
 * reaching disk, a refusal being an error rather than a blank clip, is
 * testable without spending anything.
 *
 * A clip differs from an image in the one way that shapes this whole module:
 * the POST does not answer with the work, it answers with an id. Rendering
 * takes minutes, so the answer arrives through polling, and the clip arrives
 * through a signed URL that does not live forever. That is also what makes an
 * interrupted attempt cheap to finish: the id is the receipt.
 *
 * What a body looks like and where it goes is each provider's business, in
 * `modelark.ts` and `kling.ts`. This file only carries it, the same way for
 * both: one bearer key, one POST, a GET per poll, and nothing retried.
 */

const REDACTED = "[UKRYTY KLUCZ]";
const TIMEOUT_MS = 2 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_DOWNLOAD_BYTES = 500_000_000;

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

/**
 * Starts one job. Never two: a non-2xx answer is reported as it stands,
 * because a retry here is a second charge nobody asked for.
 */
export async function submitVideo(input: {
  readonly apiKey: string;
  readonly body: unknown;
  readonly fetch: typeof fetch;
  readonly url: string;
}): Promise<Result<Transport>> {
  return await call(input.fetch, input.apiKey, input.url, {
    body: JSON.stringify(input.body),
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
  readonly url: string;
}): Promise<Result<Transport>> {
  return await call(input.fetch, input.apiKey, input.url, {
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
        `nie udało się pobrać ${input.what} spod adresu zwróconego przez API, zadanie jest już opłacone, a adres żyje co najmniej 24 h, więc powtórz to samo polecenie zamiast --regenerate`,
        { cause }
      )
    );
  }

  if (!response.ok) {
    return err(
      new VideoCallError(
        response.status,
        `pobranie ${input.what} zwróciło HTTP ${response.status}, zadanie jest już opłacone; powtórz polecenie, adres żyje co najmniej 24 h`
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
