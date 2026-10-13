import { err, ok, type Result } from "../result.js";
import { type Pcm, readPcm } from "./validate.js";

/**
 * Internal to the voice-model module: one character's lines in one clip, laid
 * into one file.
 *
 * A lip-sync job takes exactly one face and exactly one sound, so a character
 * who speaks twice in a clip has to arrive as a single recording, with the
 * silence between the lines exactly as long as the clip has it. Pure and
 * offline, like the verdict it reads its lines through: the track is a function
 * of accepted lines and their positions, which is why nothing stores it.
 *
 * The samples are copied, never converted. Two lines in different formats are
 * refused rather than resampled, because a resampled line is no longer the line
 * a person accepted, and every line this pipeline buys arrives in one format.
 */

/** The provider's floor and ceiling for one sound, and its weight limit. */
const MIN_SECONDS = 2;
const MAX_SECONDS = 60;
const MAX_BYTES = 5_000_000;
/** The canonical RIFF/WAVE header: `fmt ` of sixteen bytes, then `data`. */
const HEADER_BYTES = 44;

/** One accepted line, and where on the clip's own clock it starts, in seconds. */
interface PlacedSpeech {
  readonly at: number;
  readonly wav: Buffer;
}

interface SpeechTrack {
  /** The track's length, at least the provider's two seconds. */
  readonly seconds: number;
  /** Where on the clip's clock the track begins, which is where it is inserted. */
  readonly start: number;
  readonly wav: Buffer;
}

class SpeechTrackError extends Error {
  readonly reason: "format" | "length" | "overlap" | "weight";

  constructor(reason: SpeechTrackError["reason"], message: string) {
    super(message);
    this.name = "SpeechTrackError";
    this.reason = reason;
  }
}

function describe(pcm: Pcm): string {
  return `${pcm.sampleRate} Hz, ${pcm.channels} kan., ${pcm.bitsPerSample} bit`;
}

/**
 * The lines laid on one file, starting at the first of them, silent between
 * and after, padded at the end to two seconds. When padding would run past the
 * clip, the silence goes in front instead, because the provider refuses a sound
 * inserted beyond the end of the video.
 */
export function speechTrack(
  lines: readonly PlacedSpeech[],
  clipSeconds: number
): Result<SpeechTrack> {
  const read: { at: number; pcm: Pcm }[] = [];

  for (const line of [...lines].sort((one, two) => one.at - two.at)) {
    const pcm = readPcm(line.wav);

    if (!pcm.ok) {
      return pcm;
    }

    read.push({ at: line.at, pcm: pcm.data });
  }

  const [first] = read;

  if (first === undefined) {
    return err(new SpeechTrackError("length", "postać nie ma w tym klipie żadnej kwestii"));
  }

  const other = read.find((one) => describe(one.pcm) !== describe(first.pcm));

  if (other !== undefined) {
    return err(
      new SpeechTrackError(
        "format",
        `kwestie mają różne formaty PCM (${describe(first.pcm)} i ${describe(other.pcm)}), a ścieżki nie przepróbkowuję`
      )
    );
  }

  const { blockAlign, sampleRate } = first.pcm;
  const clip = Math.floor(clipSeconds * sampleRate);
  const placed = read.map((one) => {
    const from = Math.round(one.at * sampleRate);

    return { from, pcm: one.pcm, to: from + one.pcm.data.length / blockAlign };
  });

  for (const [index, line] of placed.entries()) {
    const previous = placed[index - 1];

    if (previous !== undefined && line.from < previous.to) {
      return err(
        new SpeechTrackError(
          "overlap",
          `kwestia od ${round(line.from / sampleRate)}s zaczyna się, zanim poprzednia skończy się w ${round(previous.to / sampleRate)}s`
        )
      );
    }
  }

  const last = Math.max(...placed.map((one) => one.to));

  if (last > clip) {
    return err(
      new SpeechTrackError(
        "length",
        `kwestie kończą się w ${round(last / sampleRate)}s, a klip trwa ${clipSeconds}s`
      )
    );
  }

  const begins = Math.min(...placed.map((one) => one.from));
  const shortest = Math.ceil(MIN_SECONDS * sampleRate);
  const end = Math.min(Math.max(last, begins + shortest), clip);
  const start = Math.min(begins, end - shortest);

  if (start < 0) {
    return err(
      new SpeechTrackError(
        "length",
        `klip trwa ${clipSeconds}s, a dźwięk lip-syncu musi trwać co najmniej ${MIN_SECONDS}s`
      )
    );
  }

  if (end - start > MAX_SECONDS * sampleRate) {
    return err(
      new SpeechTrackError(
        "length",
        `ścieżka trwałaby ${round((end - start) / sampleRate)}s, a dostawca przyjmuje najwyżej ${MAX_SECONDS}s`
      )
    );
  }

  const silence = first.pcm.bitsPerSample === 8 ? 0x80 : 0;
  const data = Buffer.alloc((end - start) * blockAlign, silence);

  for (const line of placed) {
    line.pcm.data.copy(data, (line.from - start) * blockAlign);
  }

  const wav = Buffer.concat([header(first.pcm, data.length), data]);

  return wav.length > MAX_BYTES
    ? err(
        new SpeechTrackError(
          "weight",
          `ścieżka waży ${(wav.length / 1_000_000).toFixed(1)} MB, a dostawca przyjmuje najwyżej ${MAX_BYTES / 1_000_000} MB`
        )
      )
    : ok({ seconds: round((end - start) / sampleRate), start: start / sampleRate, wav });
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

function header(pcm: Pcm, bytes: number): Buffer {
  const out = Buffer.alloc(HEADER_BYTES);

  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(HEADER_BYTES - 8 + bytes, 4);
  out.write("WAVEfmt ", 8, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(pcm.channels, 22);
  out.writeUInt32LE(pcm.sampleRate, 24);
  out.writeUInt32LE(pcm.sampleRate * pcm.blockAlign, 28);
  out.writeUInt16LE(pcm.blockAlign, 32);
  out.writeUInt16LE(pcm.bitsPerSample, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(bytes, 40);

  return out;
}
