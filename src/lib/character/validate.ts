import { err, ok, type Result } from "../result.js";
import type { ImageTrack } from "../workspace.js";

/**
 * Internal to the character module: the verdict on bytes and on a provider's
 * answer. Pure and offline, for the same reason stage 1's validator is — this
 * is the half that decides whether an image that has already been paid for may
 * be published, so it must never need a network of its own.
 *
 * Structure only. Whether the face looks like the person is a separate question
 * that no byte inspection gets to answer.
 */

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** Signature, a complete IHDR chunk and a closing IEND leave nothing smaller. */
const MIN_BYTES = 45;
const MAX_BYTES = 50_000_000;
const IHDR_AT = 12;
const WIDTH_AT = 16;
const HEIGHT_AT = 20;
const COLOR_TYPE_AT = 25;
/** PNG colour types 4 (grey + alpha) and 6 (truecolour + alpha) carry a channel. */
const ALPHA_COLOR_TYPES = new Set([4, 6]);

export interface ImageVerdict {
  /**
   * Reported, never enforced. The views ask for a transparent background and
   * gpt-image has a switch for it; seedream has none, so a missing channel is
   * a judgement for the reviewer rather than grounds for discarding a paid
   * image. `check` surfaces it; nothing fails on it.
   */
  readonly alpha: boolean;
  readonly bytes: number;
  readonly height: number;
  readonly width: number;
}

export type ImagePayload =
  | { readonly bytes: Buffer; readonly kind: "bytes" }
  | { readonly kind: "url"; readonly url: string };

export interface ImageAnswer {
  readonly jobId: string | null;
  readonly payload: ImagePayload;
}

class ImageError extends Error {
  readonly reason: "dimensions" | "malformed";

  constructor(reason: ImageError["reason"], message: string) {
    super(message);
    this.name = "ImageError";
    this.reason = reason;
  }
}

class ImageAnswerError extends Error {
  readonly reason: "count" | "empty" | "malformed" | "provider" | "url";

  constructor(reason: ImageAnswerError["reason"], message: string) {
    super(message);
    this.name = "ImageAnswerError";
    this.reason = reason;
  }
}

/**
 * Is this the image the request asked for?
 *
 * Dimensions are compared rather than corrected: an image of the wrong size is
 * a result that did not follow the request, and silently rescaling it would
 * hide that behind a file that looks right.
 */
export function validateImage(bytes: Buffer, size: string): Result<ImageVerdict> {
  if (bytes.length < SIGNATURE.length || !bytes.subarray(0, SIGNATURE.length).equals(SIGNATURE)) {
    return err(
      new ImageError("malformed", "odpowiedź nie jest plikiem PNG — zachowano ją do sprawdzenia")
    );
  }

  if (bytes.length > MAX_BYTES) {
    return err(
      new ImageError(
        "malformed",
        `obraz ma ${bytes.length} bajtów i przekracza lokalny limit ${MAX_BYTES}`
      )
    );
  }

  if (
    bytes.length < MIN_BYTES ||
    bytes.toString("ascii", IHDR_AT, IHDR_AT + 4) !== "IHDR" ||
    bytes.toString("ascii", bytes.length - 8, bytes.length - 4) !== "IEND"
  ) {
    return err(
      new ImageError("malformed", "PNG jest niekompletny — brak nagłówka IHDR albo bloku IEND")
    );
  }

  const width = bytes.readUInt32BE(WIDTH_AT);
  const height = bytes.readUInt32BE(HEIGHT_AT);

  if (`${width}x${height}` !== size) {
    return err(
      new ImageError(
        "dimensions",
        `obraz ma ${width}x${height}, a żądanie mówiło ${size} — zachowano oryginał, niczego nie przeskalowuję`
      )
    );
  }

  return ok({
    alpha: ALPHA_COLOR_TYPES.has(bytes.readUInt8(COLOR_TYPE_AT)),
    bytes: bytes.length,
    height,
    width,
  });
}

interface ProviderAnswer {
  readonly data?: readonly { b64_json?: string; error?: unknown; url?: string }[];
  readonly error?: { code?: string; message?: string };
  readonly id?: string;
}

/**
 * Where the image is, or why there is none.
 *
 * The two tracks answer differently and the difference matters downstream:
 * gpt-image returns the bytes inline, so a saved body is the image; seedream
 * returns a download URL valid for 24 hours, so a saved body is a second,
 * unbilled chance to fetch it.
 */
export function readImageResponse(track: ImageTrack, body: string): Result<ImageAnswer> {
  let parsed: ProviderAnswer;

  try {
    parsed = JSON.parse(body) as ProviderAnswer;
  } catch {
    return err(new ImageAnswerError("malformed", "odpowiedź API nie jest poprawnym JSON-em"));
  }

  if (parsed.error !== undefined) {
    const code = parsed.error.code ?? "brak kodu";

    return err(
      new ImageAnswerError(
        "provider",
        `API odmówiło wygenerowania obrazu [${code}]: ${parsed.error.message ?? "bez treści"}`
      )
    );
  }

  if (!Array.isArray(parsed.data) || parsed.data.length !== 1) {
    return err(
      new ImageAnswerError(
        "count",
        `API nie zwróciło dokładnie jednego obrazu (${parsed.data?.length ?? 0}) — odpowiedź zachowana`
      )
    );
  }

  const [entry] = parsed.data;
  const jobId = parsed.id ?? null;

  if (entry === undefined || entry.error !== undefined) {
    return err(new ImageAnswerError("provider", "API zwróciło błąd zamiast obrazu"));
  }

  if (track === "gpt-image") {
    return typeof entry.b64_json === "string" && entry.b64_json !== ""
      ? ok({ jobId, payload: { bytes: Buffer.from(entry.b64_json, "base64"), kind: "bytes" } })
      : err(new ImageAnswerError("empty", "API nie zwróciło zakodowanego obrazu"));
  }

  return readDownloadUrl(entry.url, jobId);
}

/**
 * A result URL is followed later, so it is checked now: credentials in a URL
 * would be sent onward by the download, and a non-HTTPS one would carry the
 * image in the clear.
 */
function readDownloadUrl(value: string | undefined, jobId: string | null): Result<ImageAnswer> {
  if (typeof value !== "string" || value === "") {
    return err(new ImageAnswerError("empty", "API nie zwróciło adresu obrazu"));
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return err(new ImageAnswerError("url", "adres obrazu nie jest poprawnym URL-em"));
  }

  return url.protocol === "https:" && url.username === "" && url.password === ""
    ? ok({ jobId, payload: { kind: "url", url: url.href } })
    : err(
        new ImageAnswerError(
          "url",
          "adres obrazu wymaga HTTPS bez danych logowania — nie pobieram go"
        )
      );
}
