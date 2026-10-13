import { err, ok, type Result } from "../result.js";
import type { StillFormat } from "../workspace.js";

/**
 * Internal to the video-model module: the verdict on bytes and on a provider's
 * answer. Pure and offline, like the image verdict and for the same reason,
 * it decides whether a clip that has already been paid for may be published, so
 * it must never need a network, a secret or a decoder of its own.
 *
 * Structure only. Whether the motion is any good is a separate question that no
 * byte inspection gets to answer.
 *
 * It reads the MP4's own boxes rather than shelling out to a media tool. Two
 * reasons: `check` has to re-run this verdict long after the command that
 * bought the clip, on whatever machine the workspace is sitting on, and the
 * three numbers it needs, duration, width, height, live in two headers that
 * are eight lines of arithmetic away.
 */

/** The one box every ISO-BMFF file opens with, at offset 4. */
const FTYP = "ftyp";
const HEADER = 8;
const MAX_BYTES = 500_000_000;
/**
 * How far the clip's own duration may sit from the one that was ordered. A
 * frame rate leaves a fraction of a second over, 14 s at 24 fps is 335 frames
 * plus a remainder, so the tolerance is under one second and never a whole
 * one, which would let a 15 s answer pass for a 14 s order.
 */
const SECOND = 1;
/** Two ratios are the same picture when they agree to within a rounded pixel. */
const RATIO_TOLERANCE = 0.01;
const RATIO = /^(\d{1,4}):(\d{1,4})$/;

export interface VideoVerdict {
  readonly bytes: number;
  /**
   * The picture's sample entry format, `avc1` or `hvc1`, or null where its
   * sample tables are missing. With the frame and the frame rate, what a
   * stream copy of several clips has to agree on.
   */
  readonly codec: string | null;
  /** Pictures a second, to the thousandth, from the picture's own sample tables; null without them. */
  readonly frameRate: number | null;
  readonly height: number;
  /** The clip's own duration, as its movie header states it. */
  readonly seconds: number;
  readonly width: number;
}

class VideoError extends Error {
  readonly reason: "duration" | "malformed" | "ratio";

  constructor(reason: VideoError["reason"], message: string) {
    super(message);
    this.name = "VideoError";
    this.reason = reason;
  }
}

/**
 * Is this the clip the request asked for?
 *
 * The duration is compared when something was ordered. `seconds: null` means
 * nothing was, stage 9 reads a finished cut whose length stage 8 already
 * judged, and it needs the number rather than a second opinion on it. Stated in
 * the type rather than passed as an impossible expectation, because a caller
 * that had to spell "no expectation" as a number nobody matches would be
 * relying on arithmetic to mean something it does not say.
 *
 * Where it is compared; it is compared because it is what was ordered and billed.
 * The frame is compared against the episode's ratio rather than against an
 * exact size, because that is what the request actually stated: the entry frame
 * pins the ratio and the provider picks the pixels inside its resolution tier.
 * Neither is corrected, a clip of the wrong length is a result that did not
 * follow the request, and re-encoding it would hide that behind a file that
 * looks right.
 */
export function validateVideo(
  bytes: Buffer,
  expected: { readonly aspectRatio: string | null; readonly seconds: number | null }
): Result<VideoVerdict> {
  if (bytes.length > MAX_BYTES) {
    return err(
      new VideoError(
        "malformed",
        `klip ma ${bytes.length} bajtów i przekracza lokalny limit ${MAX_BYTES}`
      )
    );
  }

  if (bytes.length < HEADER * 2 || bytes.toString("ascii", 4, 8) !== FTYP) {
    return err(
      new VideoError("malformed", "odpowiedź nie jest plikiem MP4, zachowano ją do sprawdzenia")
    );
  }

  const moov = findBox(bytes, 0, bytes.length, "moov");

  if (moov === null) {
    return err(new VideoError("malformed", "MP4 jest niekompletny, brak bloku moov"));
  }

  const seconds = readDuration(bytes, moov);
  const frame = readFrame(bytes, moov);

  if (seconds === null || frame === null) {
    return err(
      new VideoError("malformed", "MP4 nie niesie nagłówka filmu albo nagłówka ścieżki obrazu")
    );
  }

  if (expected.seconds !== null && Math.abs(seconds - expected.seconds) >= SECOND) {
    return err(
      new VideoError(
        "duration",
        `klip trwa ${round(seconds)}s, a plan kupił ${expected.seconds}s, zachowano oryginał, niczego nie przycinam`
      )
    );
  }

  const wanted = expected.aspectRatio === null ? null : readRatio(expected.aspectRatio);

  if (wanted !== null && Math.abs(frame.width / frame.height - wanted) > RATIO_TOLERANCE) {
    return err(
      new VideoError(
        "ratio",
        `klip ma kadr ${frame.width}x${frame.height}, a odcinek jest w proporcjach ${expected.aspectRatio}, zachowano oryginał, niczego nie przeskalowuję`
      )
    );
  }

  return ok({
    bytes: bytes.length,
    ...readStream(bytes, frame.trak),
    height: frame.height,
    seconds: round(seconds),
    width: frame.width,
  });
}

function round(seconds: number): number {
  return Math.round(seconds * 100) / 100;
}

/**
 * Whether a lip-synced result is the clip it was made from with new lips: the
 * same frame to the pixel and the same length within a frame's remainder. A
 * provider that scaled the picture handed back a different film, and nothing
 * here scales it back.
 */
export function validateLipSyncResult(
  bytes: Buffer,
  input: { readonly height: number; readonly seconds: number; readonly width: number }
): Result<VideoVerdict> {
  const verdict = validateVideo(bytes, { aspectRatio: null, seconds: input.seconds });

  if (!verdict.ok) {
    return verdict;
  }

  const { height, width } = verdict.data;

  return width === input.width && height === input.height
    ? verdict
    : err(
        new VideoError(
          "ratio",
          `wynik lip-syncu ma kadr ${width}x${height}, a klip wejściowy ${input.width}x${input.height}, zachowano oryginał, niczego nie przeskalowuję`
        )
      );
}

/** What Kling's lip-sync takes as a video, by its own documentation. */
const LIP_SYNC_INPUT = {
  maxBytes: 100_000_000,
  maxSeconds: 60,
  maxSide: 2160,
  minSeconds: 2,
  minSide: 512,
};

/**
 * Whether lip-sync will take this clip, judged here rather than by the
 * provider, because the face call that would discover it is paid for.
 *
 * The limits are the provider's, stated with the numbers that broke them. No
 * clip is cut or scaled to fit: a clip out of range is a plan out of range,
 * and the remedy is upstream.
 */
export function validateLipSyncInput(bytes: Buffer): Result<VideoVerdict> {
  if (bytes.length > LIP_SYNC_INPUT.maxBytes) {
    return err(
      new VideoError(
        "malformed",
        `klip ma ${bytes.length} bajtów, a lip-sync przyjmuje najwyżej ${LIP_SYNC_INPUT.maxBytes}`
      )
    );
  }

  const verdict = validateVideo(bytes, { aspectRatio: null, seconds: null });

  if (!verdict.ok) {
    return verdict;
  }

  const { height, seconds, width } = verdict.data;

  if (seconds < LIP_SYNC_INPUT.minSeconds || seconds > LIP_SYNC_INPUT.maxSeconds) {
    return err(
      new VideoError(
        "duration",
        `klip trwa ${seconds}s, a lip-sync przyjmuje od ${LIP_SYNC_INPUT.minSeconds} do ${LIP_SYNC_INPUT.maxSeconds}s`
      )
    );
  }

  return [width, height].every(
    (side) => side >= LIP_SYNC_INPUT.minSide && side <= LIP_SYNC_INPUT.maxSide
  )
    ? verdict
    : err(
        new VideoError(
          "ratio",
          `klip ma kadr ${width}x${height}, a lip-sync przyjmuje boki od ${LIP_SYNC_INPUT.minSide} do ${LIP_SYNC_INPUT.maxSide} px`
        )
      );
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
/** The frame-carrying JPEG start-of-frame markers; the rest are not pictures. */
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

interface EndFrameVerdict {
  readonly bytes: number;
  readonly format: StillFormat;
  readonly height: number;
  readonly width: number;
}

/**
 * The frame the clip ended on, as the provider handed it back.
 *
 * Its format is the provider's choice and not ours, ModelArk returns a JPEG
 * beside an MP4, so this reads whichever of the two it is rather than
 * insisting on the one the rest of the pipeline draws in. The bytes are
 * published exactly as they arrived, under a name that says what they are:
 * re-encoding a still somebody is about to accept would mean approving one
 * picture and attaching another.
 *
 * The frame is compared against the clip it came out of, because that is the
 * only size it can honestly be: it is the last instant of that video.
 */
export function validateEndFrame(
  bytes: Buffer,
  clip: { readonly height: number; readonly width: number }
): Result<EndFrameVerdict> {
  const frame = readStill(bytes);

  if (frame === null) {
    return err(new VideoError("malformed", "ostatnia klatka nie jest ani plikiem PNG, ani JPEG"));
  }

  return frame.width === clip.width && frame.height === clip.height
    ? ok({ bytes: bytes.length, ...frame })
    : err(
        new VideoError(
          "ratio",
          `ostatnia klatka ma ${frame.width}x${frame.height}, a klip ${clip.width}x${clip.height}`
        )
      );
}

/**
 * Whether this file carries a sound track, read from its own boxes.
 *
 * Stage 8 reports a silent cut and stage 9 has to be able to say the silence is
 * over, and both answers must survive on a machine with no media tools, which
 * is why this walks `trak` boxes rather than asking a decoder. The test is the
 * one `readFrame` already relies on from the other side: a sound track states a
 * frame of zero by zero, because it has no picture in it.
 *
 * A file it cannot parse reads as silent. That is the honest answer for a
 * verdict whose question is "is there sound here": a shape this cannot read is
 * not a shape it may claim anything about.
 */
export function hasSound(bytes: Buffer): boolean {
  const moov = findBox(bytes, 0, bytes.length, "moov");

  if (moov === null) {
    return false;
  }

  let at = moov.body;

  while (at < moov.end) {
    const trak = findBox(bytes, at, moov.end, "trak");

    if (trak === null) {
      return false;
    }

    if (readTrackFrame(bytes, trak) === null) {
      return true;
    }

    at = trak.end;
  }

  return false;
}

/**
 * Which of the two formats a still is, or `null` for neither.
 *
 * It exists so the archive can name the file after what it holds before
 * anything has judged whether it is the right picture, naming and judging are
 * two questions, and a file named `.png` holding a JPEG is a lie either way.
 */
export function stillFormat(bytes: Buffer): StillFormat | null {
  return readStill(bytes)?.format ?? null;
}

function readStill(bytes: Buffer): { format: StillFormat; height: number; width: number } | null {
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return bytes.length < 24 || bytes.toString("ascii", 12, 16) !== "IHDR"
      ? null
      : { format: "png", height: bytes.readUInt32BE(20), width: bytes.readUInt32BE(16) };
  }

  return bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE) ? readJpeg(bytes) : null;
}

/**
 * A JPEG's frame, from the first start-of-frame segment.
 *
 * A JPEG is a chain of marker segments and only the SOF one states the
 * picture's size, so the chain is walked rather than guessed at: the
 * thumbnails, colour profiles and EXIF blocks that come first say nothing
 * about the frame.
 */
function readJpeg(bytes: Buffer): { format: StillFormat; height: number; width: number } | null {
  let at = 2;

  while (at + 9 < bytes.length) {
    if (bytes.readUInt8(at) !== 0xff) {
      return null;
    }

    const marker = bytes.readUInt8(at + 1);

    if (SOF_MARKERS.has(marker)) {
      return {
        format: "jpeg",
        height: bytes.readUInt16BE(at + 5),
        width: bytes.readUInt16BE(at + 7),
      };
    }

    at += 2 + bytes.readUInt16BE(at + 2);
  }

  return null;
}

/**
 * Where a job stands, in the only three shapes a caller can act on.
 *
 * Every provider's answer is read into this, by that provider's own reader in
 * `modelark.ts` or `kling.ts`, so the lifecycle around a job never learns
 * which wire it came over. `endFrameUrl` is `null` when the provider handed no
 * final frame back, which for Kling is always and for ModelArk is a surprise.
 * `videoId` is the provider's own name for the result, by which a later call
 * can address it without the bytes; `null` when the provider gives none.
 */
export type VideoTask =
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "running"; readonly status: string }
  | {
      readonly endFrameUrl: string | null;
      readonly kind: "succeeded";
      readonly videoId: string | null;
      readonly videoUrl: string;
    };

export class TaskError extends Error {
  readonly reason: "empty" | "malformed" | "provider" | "url";

  constructor(reason: TaskError["reason"], message: string) {
    super(message);
    this.name = "TaskError";
    this.reason = reason;
  }
}

/** An answer's JSON, typed as the shape its provider documents; nothing is trusted yet. */
export function parseAnswer<T>(body: string): Result<T> {
  try {
    return ok(JSON.parse(body) as T);
  } catch {
    return err(new TaskError("malformed", "odpowiedź API nie jest poprawnym JSON-em"));
  }
}

/**
 * A result URL is followed later, so it is checked now: credentials in a URL
 * would be sent onward by the download, and a non-HTTPS one would carry the
 * result in the clear.
 */
export function readUrl(value: string | undefined, what: string): Result<string> {
  if (typeof value !== "string" || value === "") {
    return err(new TaskError("empty", `API nie zwróciło adresu ${what}`));
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return err(new TaskError("url", `adres ${what} nie jest poprawnym URL-em`));
  }

  return url.protocol === "https:" && url.username === "" && url.password === ""
    ? ok(url.href)
    : err(new TaskError("url", `adres ${what} wymaga HTTPS bez danych logowania, nie pobieram go`));
}

function readRatio(aspectRatio: string): number | null {
  const match = RATIO.exec(aspectRatio.trim());
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);

  return match === null || height === 0 ? null : width / height;
}

interface Box {
  /** Where the payload starts, past the header this box happens to carry. */
  readonly body: number;
  readonly end: number;
}

/**
 * The first box of a type, among the children of one range.
 *
 * A box is a length, a four-character type and a payload, and the payload of a
 * container is more boxes, so one walk serves both levels. A `1` in the length
 * field means the real length follows as 64 bits, and a `0` means "to the end",
 * which is legal for the last box in a file.
 */
function findBox(bytes: Buffer, from: number, to: number, type: string): Box | null {
  let at = from;

  while (at + HEADER <= to) {
    const declared = bytes.readUInt32BE(at);
    const name = bytes.toString("ascii", at + 4, at + HEADER);
    let body = at + HEADER;
    let size = declared;

    if (declared === 1) {
      if (at + 16 > to) {
        return null;
      }

      // The 64-bit length; the high word is a file size no workspace will hold.
      size = bytes.readUInt32BE(at + 12);
      body = at + 16;
    } else if (declared === 0) {
      size = to - at;
    }

    const end = Math.min(at + size, to);

    if (size < HEADER || end <= at) {
      return null;
    }

    if (name === type) {
      return { body, end };
    }

    at = end;
  }

  return null;
}

/** The movie header's timescale and duration, in whichever version it uses. */
function readDuration(bytes: Buffer, moov: Box): number | null {
  const mvhd = findBox(bytes, moov.body, moov.end, "mvhd");

  if (mvhd === null) {
    return null;
  }

  const long = bytes.readUInt8(mvhd.body) === 1;
  const timescaleAt = mvhd.body + (long ? 20 : 12);

  if (timescaleAt + (long ? 12 : 8) > mvhd.end) {
    return null;
  }

  const timescale = bytes.readUInt32BE(timescaleAt);
  const duration = long
    ? Number(bytes.readBigUInt64BE(timescaleAt + 4))
    : bytes.readUInt32BE(timescaleAt + 4);

  return timescale === 0 ? null : duration / timescale;
}

/**
 * The picture's frame, from the first track that has one.
 *
 * A soundtrack is a track too, and its header states a frame of zero by zero,
 * so the first track is not necessarily the picture, and taking it on faith
 * would report a clip with audio as having no frame at all.
 */
function readFrame(bytes: Buffer, moov: Box): { height: number; trak: Box; width: number } | null {
  let at = moov.body;

  while (at < moov.end) {
    const trak = findBox(bytes, at, moov.end, "trak");

    if (trak === null) {
      return null;
    }

    const frame = readTrackFrame(bytes, trak);

    if (frame !== null) {
      return { ...frame, trak };
    }

    at = trak.end;
  }

  return null;
}

/** The box of a type under a chain of containers, each looked for inside the last. */
function descend(bytes: Buffer, from: Box, path: readonly string[]): Box | null {
  let box: Box | null = from;

  for (const type of path) {
    box = box === null ? null : findBox(bytes, box.body, box.end, type);
  }

  return box;
}

/**
 * The picture track's format and frame rate.
 *
 * The format is the first sample entry's four letters. The rate is the media
 * timescale over the time between frames, and the time taken is the one most
 * frames have: an encoder may give the last frame a different duration, and
 * that one frame is not the rate of the film.
 */
function readStream(bytes: Buffer, trak: Box): { codec: string | null; frameRate: number | null } {
  const mdhd = descend(bytes, trak, ["mdia", "mdhd"]);
  const stsd = descend(bytes, trak, ["mdia", "minf", "stbl", "stsd"]);
  const stts = descend(bytes, trak, ["mdia", "minf", "stbl", "stts"]);
  const codec =
    stsd !== null && stsd.body + 16 <= stsd.end
      ? bytes.toString("ascii", stsd.body + 12, stsd.body + 16)
      : null;

  if (mdhd === null || stts === null || stts.body + 8 > stts.end) {
    return { codec, frameRate: null };
  }

  const long = bytes.readUInt8(mdhd.body) === 1;
  const timescaleAt = mdhd.body + (long ? 20 : 12);
  const timescale = timescaleAt + 4 <= mdhd.end ? bytes.readUInt32BE(timescaleAt) : 0;
  let delta = 0;
  let most = 0;

  for (let index = 0; index < bytes.readUInt32BE(stts.body + 4); index += 1) {
    const at = stts.body + 8 + index * 8;

    if (at + 8 > stts.end) {
      break;
    }

    if (bytes.readUInt32BE(at) > most) {
      most = bytes.readUInt32BE(at);
      delta = bytes.readUInt32BE(at + 4);
    }
  }

  return {
    codec,
    frameRate:
      timescale === 0 || delta === 0 ? null : Math.round((timescale / delta) * 1000) / 1000,
  };
}

function readTrackFrame(bytes: Buffer, trak: Box): { height: number; width: number } | null {
  const tkhd = findBox(bytes, trak.body, trak.end, "tkhd");

  if (tkhd === null) {
    return null;
  }

  const long = bytes.readUInt8(tkhd.body) === 1;
  const widthAt = tkhd.body + (long ? 88 : 76);

  if (widthAt + 8 > tkhd.end) {
    return null;
  }

  // Both are 16.16 fixed point: the whole pixels are the high half.
  const width = bytes.readUInt32BE(widthAt) / 0x1_00_00;
  const height = bytes.readUInt32BE(widthAt + 4) / 0x1_00_00;

  return width === 0 || height === 0
    ? null
    : { height: Math.round(height), width: Math.round(width) };
}
