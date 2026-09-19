import { err, ok, type Result } from "../result.js";

/**
 * Internal to the video-model module: the verdict on bytes and on a provider's
 * answer. Pure and offline, like the image verdict and for the same reason —
 * it decides whether a clip that has already been paid for may be published, so
 * it must never need a network, a secret or a decoder of its own.
 *
 * Structure only. Whether the motion is any good is a separate question that no
 * byte inspection gets to answer.
 *
 * It reads the MP4's own boxes rather than shelling out to a media tool. Two
 * reasons: `check` has to re-run this verdict long after the command that
 * bought the clip, on whatever machine the workspace is sitting on, and the
 * three numbers it needs — duration, width, height — live in two headers that
 * are eight lines of arithmetic away.
 */

/** The one box every ISO-BMFF file opens with, at offset 4. */
const FTYP = "ftyp";
const HEADER = 8;
const MAX_BYTES = 500_000_000;
/**
 * How far the clip's own duration may sit from the one that was ordered. A
 * frame rate leaves a fraction of a second over — 14 s at 24 fps is 335 frames
 * plus a remainder — so the tolerance is under one second and never a whole
 * one, which would let a 15 s answer pass for a 14 s order.
 */
const SECOND = 1;
/** Two ratios are the same picture when they agree to within a rounded pixel. */
const RATIO_TOLERANCE = 0.01;
const RATIO = /^(\d{1,4}):(\d{1,4})$/;

/**
 * What the video model renders. Both tracks send their clips to the same model,
 * so this is one range rather than one per track: the model is a decision the
 * user stores in a variable, and the track decides what the clip is drawn from.
 */
const MIN_SECONDS = 4;
const MAX_SECONDS = 30;

export interface VideoVerdict {
  readonly bytes: number;
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

class DurationError extends Error {
  readonly seconds: number;

  constructor(seconds: number, message: string) {
    super(message);
    this.name = "DurationError";
    this.seconds = seconds;
  }
}

/**
 * Whether the model will render a clip of this length.
 *
 * Refused rather than rounded, for the reason `frameSize` refuses a ratio no
 * track renders: the shot list is an approved decision, and a tool that
 * silently ordered fifteen seconds where a human planned fourteen would be
 * changing the film's timing on nobody's authority. The remedy is upstream —
 * a different `maxClipSeconds` and a re-planned shot list — and the message
 * says so, because that is a decision the person makes, not the tool.
 */
export function clipDuration(seconds: number): Result<number> {
  if (!Number.isInteger(seconds)) {
    return err(
      new DurationError(seconds, `długość klipu ${seconds}s nie jest pełną liczbą sekund`)
    );
  }

  return seconds >= MIN_SECONDS && seconds <= MAX_SECONDS
    ? ok(seconds)
    : err(
        new DurationError(
          seconds,
          `klip trwa ${seconds}s, a model wideo renderuje od ${MIN_SECONDS} do ${MAX_SECONDS}s — zmień maxClipSeconds odcinka i przeplanuj listę ujęć, bo tego narzędzie nie zaokrągli za ciebie`
        )
      );
}

/**
 * Is this the clip the request asked for?
 *
 * The duration is compared because it is what was ordered and what was billed.
 * The frame is compared against the episode's ratio rather than against an
 * exact size, because that is what the request actually stated: the entry frame
 * pins the ratio and the provider picks the pixels inside its resolution tier.
 * Neither is corrected — a clip of the wrong length is a result that did not
 * follow the request, and re-encoding it would hide that behind a file that
 * looks right.
 */
export function validateVideo(
  bytes: Buffer,
  expected: { readonly aspectRatio: string; readonly seconds: number }
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
      new VideoError("malformed", "odpowiedź nie jest plikiem MP4 — zachowano ją do sprawdzenia")
    );
  }

  const moov = findBox(bytes, 0, bytes.length, "moov");

  if (moov === null) {
    return err(new VideoError("malformed", "MP4 jest niekompletny — brak bloku moov"));
  }

  const seconds = readDuration(bytes, moov);
  const frame = readFrame(bytes, moov);

  if (seconds === null || frame === null) {
    return err(
      new VideoError("malformed", "MP4 nie niesie nagłówka filmu albo nagłówka ścieżki obrazu")
    );
  }

  if (Math.abs(seconds - expected.seconds) >= SECOND) {
    return err(
      new VideoError(
        "duration",
        `klip trwa ${round(seconds)}s, a plan kupił ${expected.seconds}s — zachowano oryginał, niczego nie przycinam`
      )
    );
  }

  const wanted = readRatio(expected.aspectRatio);

  if (wanted !== null && Math.abs(frame.width / frame.height - wanted) > RATIO_TOLERANCE) {
    return err(
      new VideoError(
        "ratio",
        `klip ma kadr ${frame.width}x${frame.height}, a odcinek jest w proporcjach ${expected.aspectRatio} — zachowano oryginał, niczego nie przeskalowuję`
      )
    );
  }

  return ok({
    bytes: bytes.length,
    height: frame.height,
    seconds: round(seconds),
    width: frame.width,
  });
}

function round(seconds: number): number {
  return Math.round(seconds * 100) / 100;
}

/** Where a job stands, in the only three shapes a caller can act on. */
type VideoTask =
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "running"; readonly status: string }
  | { readonly endFrameUrl: string | null; readonly kind: "succeeded"; readonly videoUrl: string };

interface TaskAnswer {
  readonly content?: { readonly last_frame_url?: string; readonly video_url?: string };
  readonly error?: { readonly code?: string; readonly message?: string };
  readonly id?: string;
  readonly status?: string;
}

class TaskError extends Error {
  readonly reason: "empty" | "malformed" | "provider" | "url";

  constructor(reason: TaskError["reason"], message: string) {
    super(message);
    this.name = "TaskError";
    this.reason = reason;
  }
}

function parse(body: string): Result<TaskAnswer> {
  try {
    return ok(JSON.parse(body) as TaskAnswer);
  } catch {
    return err(new TaskError("malformed", "odpowiedź API nie jest poprawnym JSON-em"));
  }
}

/**
 * The job id a submitted request came back with.
 *
 * It is the only thing the POST returns, and it is the receipt: with it an
 * interrupted attempt is finished by asking, without it the only way forward is
 * paying again. That is why the caller writes it to disk before doing anything
 * else with it.
 */
export function readSubmitResponse(body: string): Result<string> {
  const answer = parse(body);

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
export function readTaskResponse(body: string): Result<VideoTask> {
  const answer = parse(body);

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
    videoUrl: video.data,
  });
}

/**
 * A result URL is followed later, so it is checked now: credentials in a URL
 * would be sent onward by the download, and a non-HTTPS one would carry the
 * result in the clear.
 */
function readUrl(value: string | undefined, what: string): Result<string> {
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
    : err(
        new TaskError("url", `adres ${what} wymaga HTTPS bez danych logowania — nie pobieram go`)
      );
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
 * container is more boxes — so one walk serves both levels. A `1` in the length
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
 * A soundtrack is a track too, and its header states a frame of zero by zero —
 * so the first track is not necessarily the picture, and taking it on faith
 * would report a clip with audio as having no frame at all.
 */
function readFrame(bytes: Buffer, moov: Box): { height: number; width: number } | null {
  let at = moov.body;

  while (at < moov.end) {
    const trak = findBox(bytes, at, moov.end, "trak");

    if (trak === null) {
      return null;
    }

    const frame = readTrackFrame(bytes, trak);

    if (frame !== null) {
      return frame;
    }

    at = trak.end;
  }

  return null;
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
