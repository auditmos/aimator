import { err, ok, type Result } from "../result.js";

/**
 * Internal to the voice-model module: the verdict on bought speech, and the two
 * limits that belong to any utterance rather than to one stage.
 *
 * Pure and offline, like the image and video verdicts and for the same reason —
 * it decides whether a line that has already been paid for may be published, so
 * it must never need a network, a secret or a decoder of its own.
 *
 * It reads a RIFF header rather than shelling out to a media tool, and the
 * container is chosen so that it can. The provider's default is MP3, whose
 * length is known only to whoever walks its frames, counting them against a
 * table of bitrates and hoping the stream is constant. A WAV states its rate,
 * its channels and the size of its data block in twenty-four bytes near the
 * front, so the length of a line is arithmetic. Stage 7 read MP4 boxes instead
 * of calling a decoder for exactly this reason; choosing the container is the
 * same choice, one step earlier.
 *
 * Structure only. Whether the reading is any good is a separate question that
 * no byte inspection gets to answer.
 */

const HEADER = 8;
const MAX_BYTES = 50_000_000;
/** Linear PCM. Anything else is a container this reader has not been taught. */
const PCM = 1;
/**
 * The longest text the speech model takes in one request.
 *
 * Refused rather than truncated, for the reason `clipDuration` refuses a length
 * no video model renders: a tool that quietly sent half a sentence would change
 * what the film says on nobody's authority. The remedy is upstream and the
 * message says so — an utterance is one continuous stretch of speech, and one
 * that runs past this is really two.
 */
const MAX_CHARACTERS = 5000;

export interface SpeechVerdict {
  readonly bytes: number;
  readonly channels: number;
  readonly sampleRate: number;
  /** The line's own length, as its header states it. */
  readonly seconds: number;
}

class SpeechError extends Error {
  readonly reason: "empty" | "malformed" | "unsupported";

  constructor(reason: SpeechError["reason"], message: string) {
    super(message);
    this.name = "SpeechError";
    this.reason = reason;
  }
}

class UtteranceError extends Error {
  readonly characters: number;

  constructor(characters: number, message: string) {
    super(message);
    this.name = "UtteranceError";
    this.characters = characters;
  }
}

/**
 * What the bill is measured in.
 *
 * Every stage above this one prints how many paid calls it is about to make,
 * and for an image or a clip that number *is* the bill. Here it is not: this
 * provider charges per character of the text it is handed, so a count of calls
 * says nothing about what an episode costs. Code points rather than UTF-16
 * units, because a Polish diacritic is one character and this pipeline's own
 * language is full of them.
 */
export function billedCharacters(text: string): number {
  return [...text].length;
}

/**
 * What the continuity parameters carry, counted **apart** from the bill.
 *
 * The neighbouring lines are handed to the provider so a sentence bought on its
 * own is read as part of a paragraph. They are never rendered, so on any
 * ordinary reading of "billed per character of text converted to audio" they
 * cost nothing — but the provider's billing page does not say so, and this tool
 * has never guessed with somebody else's account. So the number is reported
 * beside the bill rather than folded into it, and the preview says which is
 * which. If it turns out these are charged for, the figure to add is already on
 * screen.
 */
export function contextCharacters(context: {
  readonly next: string | null;
  readonly previous: string | null;
}): number {
  return billedCharacters(context.previous ?? "") + billedCharacters(context.next ?? "");
}

/**
 * Whether the model will read a line of this length, and how much it bills.
 *
 * An empty line is refused before the limit is, because the two are different
 * mistakes: one is a script that says nothing at an anchor, the other is a
 * script that says too much at one.
 */
export function utteranceLength(text: string): Result<number> {
  const characters = billedCharacters(text.trim());

  if (characters === 0) {
    return err(new UtteranceError(0, "kwestia jest pusta — nie ma czego przeczytać"));
  }

  return characters <= MAX_CHARACTERS
    ? ok(characters)
    : err(
        new UtteranceError(
          characters,
          `kwestia ma ${characters} znaków, a model czyta najwyżej ${MAX_CHARACTERS} w jednym wywołaniu — skróć ją w skrypcie narracji albo rozbij na dwie wypowiedzi`
        )
      );
}

/**
 * Is this speech, and how long does it run?
 *
 * Nothing is compared against an order, because nothing was ordered: a voice
 * provider is handed a sentence and hands back however long saying it took.
 * That length is the whole of what the mix needs and the whole of what this can
 * honestly report — which is why the decision about a line that does not fit
 * belongs to the stage laying it down, not here.
 */
export function validateSpeech(bytes: Buffer): Result<SpeechVerdict> {
  if (bytes.length > MAX_BYTES) {
    return err(
      new SpeechError(
        "malformed",
        `kwestia ma ${bytes.length} bajtów i przekracza lokalny limit ${MAX_BYTES}`
      )
    );
  }

  if (
    bytes.length < 12 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return err(
      new SpeechError(
        "malformed",
        "odpowiedź nie jest plikiem WAV — zachowano ją do sprawdzenia; zwykle jest to komunikat błędu dostawcy"
      )
    );
  }

  const format = findChunk(bytes, "fmt ");
  const data = findChunk(bytes, "data");

  if (format === null || data === null || format.end - format.body < 16) {
    return err(
      new SpeechError("malformed", "WAV jest niekompletny — brak bloku fmt albo bloku data")
    );
  }

  const encoding = bytes.readUInt16LE(format.body);

  if (encoding !== PCM) {
    return err(
      new SpeechError(
        "unsupported",
        `WAV niesie kodowanie ${encoding}, a ten werdykt czyta wyłącznie PCM — zachowano oryginał`
      )
    );
  }

  const channels = bytes.readUInt16LE(format.body + 2);
  const sampleRate = bytes.readUInt32LE(format.body + 4);
  const byteRate = bytes.readUInt32LE(format.body + 8);
  const samples = data.end - data.body;

  if (byteRate === 0 || channels === 0 || sampleRate === 0) {
    return err(new SpeechError("malformed", "nagłówek WAV podaje zerową częstotliwość albo tempo"));
  }

  if (samples === 0) {
    return err(
      new SpeechError("empty", "kwestia jest pusta — WAV nie niesie ani jednej próbki dźwięku")
    );
  }

  return ok({
    bytes: bytes.length,
    channels,
    sampleRate,
    seconds: round(samples / byteRate),
  });
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

interface Chunk {
  /** Where the payload starts, past this chunk's own eight-byte header. */
  readonly body: number;
  readonly end: number;
}

/**
 * The first chunk of an id, among the children of the RIFF body.
 *
 * A RIFF file is a chain of chunks — four characters, a little-endian length,
 * a payload padded to an even boundary — and an encoder is free to put chunks
 * in front of the ones that matter. So the chain is walked rather than assumed:
 * a reader that took `fmt ` to be at offset twelve would work against one
 * encoder and quietly misread another.
 */
function findChunk(bytes: Buffer, id: string): Chunk | null {
  let at = 12;

  while (at + HEADER <= bytes.length) {
    const size = bytes.readUInt32LE(at + 4);
    const body = at + HEADER;
    const end = body + size;

    if (end > bytes.length) {
      return null;
    }

    if (bytes.toString("ascii", at, at + 4) === id) {
      return { body, end };
    }

    at = end + (size % 2);
  }

  return null;
}
