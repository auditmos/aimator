import { sha256Of } from "../artifact/index.js";
import { err, ok, type Result } from "../result.js";
import type { ImageTrack } from "../workspace.js";
import type { CharacterArtifact } from "./prompt.js";

/**
 * Internal to the character module: the paid call, per track, and nothing else.
 *
 * `fetch` is injected so every rule around the call — no retry, the key never
 * reaching disk, a refusal being an error rather than a blank image — is
 * testable without spending anything.
 *
 * The tracks differ in three ways that matter further up. gpt-image posts
 * multipart and answers with the bytes inline, so a saved response body *is*
 * the image. seedream posts JSON and answers with a URL valid for 24 hours, so
 * a saved body is a second, unbilled chance to fetch the same image. And
 * gpt-image splits its endpoint by whether the request carries references at
 * all, which a character drawn from a written description does not.
 */

const EDITS = "https://api.openai.com/v1/images/edits";
const GENERATIONS = "https://api.openai.com/v1/images/generations";
const SEEDREAM = "https://ark.ap-southeast.bytepluses.com/api/v3/images/generations";

const REDACTED = "[UKRYTY KLUCZ]";
const TIMEOUT_MS = 10 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 2 * 60_000;
const MAX_DOWNLOAD_BYTES = 50_000_000;

/**
 * The frame each artifact is rendered in. A per-track constant, not a user
 * decision: the card is square because it holds a 3 × 3 grid, a view is square
 * because it is a head, and the hero is portrait because it is a standing
 * figure. All three sit inside seedream's pixel and ratio limits.
 *
 * None of them is the project's `aspectRatio`. That governs the film frame from
 * stage 5 onward; a character sheet framed 16:9 would waste most of itself.
 */
const SIZES = {
  card: { background: "opaque", size: "1920x1920" },
  hero: { background: "opaque", size: "1536x2304" },
  /** Views composite onto later frames, so they ask for an alpha channel. */
  view: { background: "transparent", size: "1536x1536" },
} as const;

export interface ImageAttachment {
  readonly bytes: Buffer;
  readonly name: string;
  readonly sha256: string;
  readonly type: string;
}

export interface ImageRequest {
  readonly attachments: readonly ImageAttachment[];
  readonly background: string;
  readonly endpoint: string;
  readonly model: string;
  readonly prompt: string;
  readonly size: string;
  readonly track: ImageTrack;
}

interface Transport {
  /** The response body with the key redacted, ready to archive. */
  readonly body: string;
  readonly httpStatus: number;
  readonly receivedAt: string;
  readonly requestId: string | null;
}

class ImageCallError extends Error {
  readonly httpStatus: number | null;

  constructor(httpStatus: number | null, message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "ImageCallError";
    this.httpStatus = httpStatus;
  }
}

/** The frame an artifact is rendered in. */
export function sizeOf(artifact: CharacterArtifact): (typeof SIZES)[keyof typeof SIZES] {
  if (artifact === "card") {
    return SIZES.card;
  }

  return artifact === "hero" ? SIZES.hero : SIZES.view;
}

export function buildRequest(input: {
  readonly artifact: CharacterArtifact;
  readonly attachments: readonly ImageAttachment[];
  readonly model: string;
  readonly prompt: string;
  readonly track: ImageTrack;
}): ImageRequest {
  const { background, size } = sizeOf(input.artifact);

  return {
    attachments: input.attachments,
    background,
    endpoint: endpointOf(input.track, input.attachments.length),
    model: input.model,
    prompt: input.prompt,
    size,
    track: input.track,
  };
}

function endpointOf(track: ImageTrack, attachments: number): string {
  if (track === "seedream") {
    return SEEDREAM;
  }

  // A character drawn from the written rules has nothing to edit.
  return attachments === 0 ? GENERATIONS : EDITS;
}

/**
 * The archive of a request: everything except the image bytes.
 *
 * Those bytes are inputs, and the invariant says a run archive never copies an
 * input. It is not only a rule: a seedream hero carries ten base64 PNGs, so an
 * archive that kept them would write tens of megabytes per attempt for files
 * that already sit in the workspace. The references stay identified by name and
 * digest, which is what makes the attempt reproducible.
 */
export function archiveRequest(request: ImageRequest): unknown {
  return {
    background: request.background,
    endpoint: request.endpoint,
    model: request.model,
    prompt: request.prompt,
    references: request.attachments.map((attachment, index) => ({
      bytes: attachment.bytes.length,
      name: attachment.name,
      position: index + 1,
      sha256: attachment.sha256,
      type: attachment.type,
    })),
    size: request.size,
    track: request.track,
  };
}

/** Identifies an attachment by its bytes, so the archive can name what was sent. */
export function attach(name: string, bytes: Buffer): ImageAttachment {
  return {
    bytes,
    name,
    sha256: sha256Of(bytes),
    type: bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? "image/jpeg" : "image/png",
  };
}

/**
 * One call. Never two: a non-2xx answer is reported as it stands, because a
 * retry here is a second charge nobody asked for.
 */
export async function callImage(input: {
  readonly apiKey: string;
  readonly fetch: typeof fetch;
  readonly request: ImageRequest;
}): Promise<Result<Transport>> {
  let response: Response;

  try {
    response = await input.fetch(input.request.endpoint, {
      body: wireBody(input.request),
      headers: headersOf(input.request, input.apiKey),
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    return err(
      new ImageCallError(
        null,
        "wywołanie API nie doszło do skutku (sieć albo przekroczony czas) — nie ponawiam; sprawdź, czy próba nie została rozliczona",
        { cause }
      )
    );
  }

  const raw = await response.text();

  // Any answer that arrived is returned, including a rejection. Judging it here
  // would mean discarding the body before the caller could archive it, and a
  // refusal nobody can read is the one thing worse than a refusal.
  return ok({
    body: raw.replaceAll(input.apiKey, REDACTED),
    httpStatus: response.status,
    receivedAt: new Date().toISOString(),
    requestId: response.headers.get("x-request-id") ?? response.headers.get("x-tt-logid"),
  });
}

/**
 * Whether an archived answer is a refusal, and what the provider said.
 *
 * `null` means the call succeeded. The message carries the provider's own
 * words: "check the model, access and balance" is useless advice when the API
 * already said which field it objected to.
 */
export function httpFailure(transport: Transport): Error | null {
  if (transport.httpStatus < 400) {
    return null;
  }

  return new ImageCallError(
    transport.httpStatus,
    `API zwróciło HTTP ${transport.httpStatus} — nie ponawiam wywołania. Odpowiedź dostawcy: ${providerMessage(transport.body)}`
  );
}

/** The provider's error text, or the raw body when it is not the shape we know. */
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
 * A 4xx is the provider declining to do the work, so nothing was charged and a
 * plain re-run is safe. A 429 or a 5xx is different: the work may have started,
 * so those keep the `--regenerate` rule that protects against paying twice.
 */
export function refusedWithoutCharge(httpStatus: number): boolean {
  return httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429;
}

function headersOf(request: ImageRequest, apiKey: string): Record<string, string> {
  const authorization = { Authorization: `Bearer ${apiKey}` };
  const multipart = request.track === "gpt-image" && request.attachments.length > 0;

  // Multipart carries its own boundary, so its content type must not be set here.
  return multipart ? authorization : { ...authorization, "Content-Type": "application/json" };
}

function wireBody(request: ImageRequest): FormData | string {
  if (request.track === "seedream") {
    return JSON.stringify({
      model: request.model,
      optimize_prompt_options: { mode: "standard" },
      output_format: "png",
      prompt: request.prompt,
      response_format: "url",
      size: request.size,
      watermark: false,
      // Omitted entirely for text-to-image; seedream has no background switch,
      // so a view's transparency is asked for in the prompt and reported by the
      // validator rather than promised here.
      ...(request.attachments.length > 0
        ? { image: request.attachments.map((item) => dataUri(item)) }
        : {}),
    });
  }

  const fields: Record<string, string> = {
    background: request.background,
    model: request.model,
    n: "1",
    output_format: "png",
    prompt: request.prompt,
    quality: "high",
    size: request.size,
  };

  if (request.attachments.length === 0) {
    return JSON.stringify(fields);
  }

  const form = new FormData();

  for (const [key, value] of Object.entries(fields)) {
    form.set(key, value);
  }

  for (const item of request.attachments) {
    form.append("image[]", new File([Uint8Array.from(item.bytes)], item.name, { type: item.type }));
  }

  return form;
}

function dataUri(item: ImageAttachment): string {
  return `data:${item.type};base64,${item.bytes.toString("base64")}`;
}

/**
 * Fetches a seedream result. Unbilled and therefore repeatable: an attempt that
 * died after the POST but before the download can be finished from the saved
 * response, with no second charge, for as long as the provider's URL lives.
 */
export async function downloadImage(input: {
  readonly fetch: typeof fetch;
  readonly url: string;
}): Promise<Result<Buffer>> {
  let response: Response;

  try {
    // No credentials are ever sent to an image URL, including on a redirect.
    response = await input.fetch(input.url, {
      redirect: "error",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (cause) {
    return err(
      new ImageCallError(
        null,
        "nie udało się pobrać obrazu spod adresu zwróconego przez API — obraz jest już opłacony, a adres żyje 24 h, więc powtórz to samo polecenie zamiast --regenerate",
        { cause }
      )
    );
  }

  if (!response.ok) {
    return err(
      new ImageCallError(
        response.status,
        `pobranie obrazu zwróciło HTTP ${response.status} — obraz jest już opłacony; powtórz polecenie, adres żyje 24 h`
      )
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());

  return bytes.length > MAX_DOWNLOAD_BYTES
    ? err(
        new ImageCallError(
          response.status,
          `pobrany obraz ma ${bytes.length} bajtów i przekracza lokalny limit ${MAX_DOWNLOAD_BYTES}`
        )
      )
    : ok(bytes);
}
