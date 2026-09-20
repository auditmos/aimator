import { err, ok, type Result } from "../result.js";

/**
 * Internal to the audio-model module: the verdict on bought music and effects,
 * and the three lengths that belong to any cue rather than to one stage.
 *
 * Pure and offline, like every other verdict here and for the same reason — it
 * decides whether bytes somebody has already paid for may be published, so it
 * must never need a network, a secret or a decoder of its own.
 *
 * **Why it walks frames instead of reading a header.** Stage 9 chose WAV
 * precisely so it would not have to: a RIFF header states the rate, the
 * channels and the size of the data block in twenty-four bytes, and the length
 * of a line is arithmetic. That option does not exist here. The music endpoint
 * and the sound-effect endpoint document exactly one family of containers
 * between them — MP3, raw PCM, µ-law, A-law and Opus — and no WAV at all. Raw
 * PCM would be the lossless choice, but it carries **no header**: the sample
 * rate would be known from the format asked for, the channel count would not,
 * and a wrong guess states a length twice or half the truth without a word.
 *
 * So the verdict walks. Stage 9's objection to MP3 was that its length is
 * known only to whoever counts frames "against a table of bitrates, hoping the
 * stream is constant" — and the answer is to not hope: every frame header
 * declares its own bitrate and its own rate, so a variable stream is read as
 * exactly as a constant one. That is the same trade stage 7 made reading MP4
 * boxes rather than calling a decoder, and it costs a hundred lines rather
 * than twenty-four bytes. Stating the cost is the point; it is not free.
 *
 * Structure only. Whether the music is any good is a separate question no byte
 * inspection gets to answer — and nothing here is compared against what was
 * ordered, because what to do about a bed that came back short is the laying
 * stage's decision, not this one's.
 */

const MAX_BYTES = 80_000_000;
/** How far into a file a first frame may hide before this gives up looking. */
const MAX_SCAN = 1_000_000;
const HEADER = 4;

/** Layer III bitrates in kbps, indexed as the frame header indexes them. */
const MPEG1_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG2_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const MPEG1_RATES = [44_100, 48_000, 32_000, 0];
const MPEG2_RATES = [22_050, 24_000, 16_000, 0];
const MPEG25_RATES = [11_025, 12_000, 8000, 0];

/**
 * The provider's own bounds, each refused rather than clamped.
 *
 * `music_length_ms` takes 3000 to 600000 and `duration_seconds` on an effect
 * takes 0.5 to 30. They are constants of the call site exactly as an endpoint
 * is — nobody in this pipeline decided them and nobody here may move them.
 */
const MUSIC = { max: 600, min: 3 } as const;
const EFFECT = { max: 30, min: 0.5 } as const;

export interface AudioVerdict {
  readonly bytes: number;
  readonly channels: number;
  /** Frames of audio, not counting a metadata frame that carries none. */
  readonly frames: number;
  readonly sampleRate: number;
  /** The stem's own length, summed over the frames that hold sound. */
  readonly seconds: number;
}

class AudioError extends Error {
  readonly reason: "empty" | "malformed";

  constructor(reason: AudioError["reason"], message: string) {
    super(message);
    this.name = "AudioError";
    this.reason = reason;
  }
}

class CueLengthError extends Error {
  readonly seconds: number;

  constructor(seconds: number, message: string) {
    super(message);
    this.name = "CueLengthError";
    this.seconds = seconds;
  }
}

function bounded(
  seconds: number,
  limit: { readonly max: number; readonly min: number },
  what: string,
  remedy: string
): Result<number> {
  if (seconds >= limit.min && seconds <= limit.max) {
    return ok(seconds);
  }

  return err(
    new CueLengthError(
      seconds,
      `${what} trwa ${seconds}s, a dostawca komponuje od ${limit.min}s do ${limit.max}s — ${remedy}`
    )
  );
}

/** Whether the music model will compose a bed of this length. */
export function musicLength(seconds: number): Result<number> {
  return bounded(
    seconds,
    MUSIC,
    "podkład",
    "popraw arkusz cue, a jeśli to długość odcinka jest poza zakresem — etap 0"
  );
}

/** Whether the sound-effect model will render an effect of this length. */
export function effectLength(seconds: number): Result<number> {
  return bounded(
    seconds,
    EFFECT,
    "efekt",
    "popraw jego długość w arkuszu cue; dłuższego tła nie kupuje się jednym efektem"
  );
}

interface Frame {
  readonly channels: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly samples: number;
  /** Where a metadata tag would sit inside this frame, if it is one. */
  readonly tagAt: number;
}

/**
 * A run of bits out of one byte, counted from the most significant.
 *
 * Arithmetic rather than shifts and masks, and not only to satisfy a linter:
 * `bits(b, 3, 2)` says which two bits it wants, where `(b >> 3) & 0b11` makes
 * the reader work that out. A frame header is nothing but named bit runs, so
 * naming the operation once is what keeps the rest of this file readable.
 */
function bits(byte: number, from: number, count: number): number {
  return Math.floor(byte / 2 ** (8 - from - count)) % 2 ** count;
}

/** Which table of sample rates a version field points at. */
function ratesOf(version: number): readonly number[] {
  if (version === 0b11) {
    return MPEG1_RATES;
  }

  return version === 0b10 ? MPEG2_RATES : MPEG25_RATES;
}

/**
 * Where a metadata tag sits inside a frame: past the side information, whose
 * size is fixed by the version and by whether the frame is mono.
 */
function tagOffset(mpeg1: boolean, mono: boolean): number {
  if (mpeg1) {
    return mono ? 21 : 36;
  }

  return mono ? 13 : 21;
}

/**
 * One frame header, or `null` when these four bytes are not one.
 *
 * Every field that decides a length is read out of the header itself, which is
 * what makes the walk exact. A reserved value in any of them means this is not
 * a frame — a sync pattern happens by chance inside audio data often enough
 * that the rest of the header is the only thing that tells them apart.
 */
function readFrame(bytes: Buffer, at: number): Frame | null {
  if (at + HEADER > bytes.length) {
    return null;
  }

  const [b0 = 0, b1 = 0, b2 = 0, b3 = 0] = [bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]];

  if (b0 !== 0xff || bits(b1, 0, 3) !== 0b111) {
    return null;
  }

  const version = bits(b1, 3, 2);
  const layer = bits(b1, 5, 2);

  // 01 is a reserved version and 00 a reserved layer; Layer III is 01.
  if (version === 0b01 || layer !== 0b01) {
    return null;
  }

  const mpeg1 = version === 0b11;
  const sampleRate = ratesOf(version)[bits(b2, 4, 2)] ?? 0;
  const kbps = (mpeg1 ? MPEG1_BITRATES : MPEG2_BITRATES)[bits(b2, 0, 4)] ?? 0;

  // A free-format or reserved bitrate and a reserved rate both mean this is
  // not a frame this reader can measure, so it is not counted as one.
  if (sampleRate === 0 || kbps === 0) {
    return null;
  }

  const mono = bits(b3, 0, 2) === 0b11;
  const samples = mpeg1 ? 1152 : 576;
  const length = Math.floor(((mpeg1 ? 144_000 : 72_000) * kbps) / sampleRate) + bits(b2, 6, 1);

  return {
    channels: mono ? 1 : 2,
    length,
    sampleRate,
    samples,
    tagAt: tagOffset(mpeg1, mono),
  };
}

/**
 * Whether this frame is the metadata one an encoder writes first.
 *
 * It occupies a whole frame and holds no audio, so counting it would add a
 * frame of silence to the length of every file the provider sends. Small, and
 * wrong in the direction that matters: a bed reported longer than it is would
 * be laid over a film it does not reach the end of.
 */
function isMetadata(bytes: Buffer, at: number, frame: Frame): boolean {
  const tag = at + frame.tagAt;

  if (tag + 4 > bytes.length) {
    return false;
  }

  const word = bytes.toString("ascii", tag, tag + 4);

  return word === "Xing" || word === "Info" || word === "VBRI";
}

/** Past an ID3v2 tag, if one is in front of the audio. */
function skipTag(bytes: Buffer): number {
  if (bytes.length < 10 || bytes.toString("ascii", 0, 3) !== "ID3") {
    return 0;
  }

  // A synchsafe integer: seven bits of each of four bytes, high bit always
  // zero, so the size is read in base 128 rather than base 256.
  const size = [6, 7, 8, 9].reduce((total, at) => total * 128 + (bytes[at] ?? 0), 0);

  return Math.min(10 + size, bytes.length);
}

/**
 * Is this audio, and how long does it run?
 *
 * Nothing is compared against what was ordered. The provider may hand back a
 * little more or a little less than the length asked for, and what to do about
 * that is the laying stage's decision — a bed that falls short of the film is
 * a gap to be reported, an effect that overruns its shot is a refusal. Deciding
 * either here would put one answer where the contract wants two.
 */
export function validateAudio(bytes: Buffer): Result<AudioVerdict> {
  if (bytes.length > MAX_BYTES) {
    return err(
      new AudioError(
        "malformed",
        `stem ma ${bytes.length} bajtów i przekracza lokalny limit ${MAX_BYTES}`
      )
    );
  }

  let at = skipTag(bytes);
  let scanned = 0;

  // A first frame is hunted for rather than assumed: encoders pad, and a
  // reader that demanded a sync byte at offset zero would work on one
  // provider's answer and fail on the next.
  while (at < bytes.length && readFrame(bytes, at) === null && scanned < MAX_SCAN) {
    at += 1;
    scanned += 1;
  }

  let frames = 0;
  let samples = 0;
  let sampleRate = 0;
  let channels = 0;

  for (let cursor = at; cursor < bytes.length; ) {
    const frame = readFrame(bytes, cursor);

    if (frame === null) {
      break;
    }

    if (!(frames === 0 && isMetadata(bytes, cursor, frame))) {
      const { channels: mode, sampleRate: rate, samples: perFrame } = frame;

      frames += 1;
      samples += perFrame;
      sampleRate = rate;
      channels = mode;
    }

    cursor += frame.length;
  }

  if (frames === 0 || sampleRate === 0) {
    return err(
      new AudioError(
        "empty",
        "odpowiedź nie niesie ani jednej ramki MP3 — zachowano ją do sprawdzenia; zwykle jest to komunikat błędu dostawcy"
      )
    );
  }

  return ok({
    bytes: bytes.length,
    channels,
    frames,
    sampleRate,
    seconds: Math.round((samples / sampleRate) * 1000) / 1000,
  });
}
