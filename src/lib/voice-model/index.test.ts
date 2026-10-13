import { describe, expect, it } from "vitest";
import { wav } from "../../test/fixture.js";
import { billedCharacters, speechTrack, utteranceLength, validateSpeech } from "./index.js";

/**
 * What is true of any utterance a stage buys, through the module entry.
 *
 * The lifecycle around a paid call is tested by the stage that owns it, with an
 * instrumented transport that counts calls, for a stage that bills per call
 * the count is the assertion. What belongs here is the half that is true
 * whatever the stage: the verdict on the bytes, how long a line may be, and
 * what the bill is measured in.
 */

describe("validateSpeech", () => {
  /**
   * WAV rather than the provider's default MP3, and the verdict is why. A RIFF
   * header states its rate, its channels and the size of its data block, so the
   * length of a bought line is exact arithmetic on a machine with no media
   * tools. Stage 7 read boxes instead of calling a decoder for exactly this.
   */
  it("should read the length from the header alone", () => {
    const verdict = validateSpeech(wav({ seconds: 1.5 }));

    expect(verdict.ok ? verdict.data.seconds : null).toBe(1.5);
    expect(verdict.ok ? verdict.data.sampleRate : null).toBe(24_000);
    expect(verdict.ok ? verdict.data.channels : null).toBe(1);
  });

  /** A real encoder writes chunks the reader does not know. It walks past them. */
  it("should find the header past a chunk it does not know", () => {
    const verdict = validateSpeech(wav({ junk: true, seconds: 2 }));

    expect(verdict.ok ? verdict.data.seconds : null).toBe(2);
  });

  it("should read a stereo line at its own rate", () => {
    const verdict = validateSpeech(wav({ channels: 2, sampleRate: 44_100, seconds: 0.5 }));

    expect(verdict.ok ? verdict.data.seconds : null).toBe(0.5);
    expect(verdict.ok ? verdict.data.channels : null).toBe(2);
  });

  it("should refuse an answer that is not a WAV", () => {
    const verdict = validateSpeech(Buffer.from('{"detail":"invalid api key"}', "utf8"));

    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.error.message).toContain("WAV");
  });

  /**
   * A line with no samples in it is a file, not speech. It is refused rather
   * than laid down, because silence at an anchor is indistinguishable from a
   * line nobody bought, and the remedy is free: the bytes stay in the archive.
   */
  it("should refuse a line with nothing in it", () => {
    const verdict = validateSpeech(wav({ seconds: 0 }));

    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.error.message).toContain("pusta");
  });

  it("should refuse a truncated file rather than guess its length", () => {
    const verdict = validateSpeech(wav({ seconds: 1 }).subarray(0, 20));

    expect(verdict.ok).toBe(false);
  });
});

/**
 * The bill, which this provider does not measure in calls.
 *
 * Every stage above prints how many paid calls it is about to make, and for
 * images and clips that number is the bill. Here it is not: ElevenLabs charges
 * per character of the text it is given, so a count of calls says nothing about
 * what an episode costs. The number the preview needs is this one.
 */
describe("billedCharacters", () => {
  it("should count the characters of the text as it will be sent", () => {
    expect(billedCharacters("Tata usiadł obok")).toBe(16);
  });

  /**
   * Counted in code points, not UTF-16 units. Polish diacritics are one
   * character each and a count that said otherwise would overstate the bill on
   * every line of this pipeline's own language.
   */
  it("should count a diacritic as one character", () => {
    expect(billedCharacters("łódź")).toBe(4);
  });
});

/**
 * How long a line may be, the speech model's own limit, refused rather than
 * truncated, exactly as `clipDuration` refuses a length no video model renders.
 * A tool that quietly sent half a sentence would change the film on nobody's
 * authority, and the remedy is upstream: shorten the line in the script.
 */
describe("utteranceLength", () => {
  it("should accept a line the model reads", () => {
    const length = utteranceLength("Na kanapie czekało miejsce dla Ewy");

    expect(length.ok ? length.data : null).toBe(34);
  });

  it("should refuse an empty line rather than buy silence", () => {
    expect(utteranceLength("   ").ok).toBe(false);
  });

  it("should refuse a line past the model's limit and name the remedy", () => {
    const length = utteranceLength("a".repeat(5001));

    expect(length.ok).toBe(false);
    expect(length.ok ? "" : length.error.message).toContain("skróć");
  });
});

/**
 * One character's speech in one clip, as one file, because a lip-sync job takes
 * exactly one face and one sound.
 *
 * Assumptions this pins: positions are seconds of the clip's own clock; the
 * file starts at the first line, so the provider is told to insert it there;
 * every sample between and after the lines is silence; the file is padded at
 * its end to the provider's two-second floor; the lines' PCM is copied, never
 * resampled, so lines in different formats are refused rather than converted.
 */
describe("speechTrack", () => {
  const RATE = 24_000;
  const FRAME = 2;

  /** The value of every sample in a span of the track's own seconds. */
  function samples(track: Buffer, from: number, to: number): Set<number> {
    const data = track.subarray(44);
    const values = new Set<number>();

    for (let at = Math.round(from * RATE); at < Math.round(to * RATE); at += 1) {
      values.add(data.readUInt16LE(at * FRAME));
    }

    return values;
  }

  it("should lay two lines at their positions with silence between and after", () => {
    const track = speechTrack(
      [
        { at: 1.85, wav: wav({ fill: 0x22, seconds: 1.1 }) },
        { at: 1, wav: wav({ fill: 0x11, seconds: 0.8 }) },
      ],
      10
    );

    expect(track.ok ? { seconds: track.data.seconds, start: track.data.start } : null).toEqual({
      seconds: 2,
      start: 1,
    });

    const bytes = track.ok ? track.data.wav : Buffer.alloc(0);

    expect(validateSpeech(bytes).ok ? validateSpeech(bytes) : null).toMatchObject({
      data: { channels: 1, sampleRate: RATE, seconds: 2 },
    });
    expect(samples(bytes, 0, 0.8)).toEqual(new Set([0x11_11]));
    expect(samples(bytes, 0.8, 0.85)).toEqual(new Set([0]));
    expect(samples(bytes, 0.85, 1.95)).toEqual(new Set([0x22_22]));
    expect(samples(bytes, 1.95, 2)).toEqual(new Set([0]));
  });

  it("should refuse lines recorded at different sample rates", () => {
    const track = speechTrack(
      [
        { at: 0, wav: wav({ seconds: 1 }) },
        { at: 2, wav: wav({ sampleRate: 44_100, seconds: 1 }) },
      ],
      10
    );

    expect(track.ok ? "laid" : track.error.message).toContain("44100");
  });

  it("should refuse a track longer than the provider's sixty seconds", () => {
    const track = speechTrack(
      [
        { at: 0, wav: wav({ seconds: 1 }) },
        { at: 60, wav: wav({ seconds: 1 }) },
      ],
      90
    );

    expect(track.ok ? "laid" : track.error.message).toContain("60");
  });

  it("should refuse a track heavier than the provider's five megabytes", () => {
    const track = speechTrack(
      [{ at: 0, wav: wav({ channels: 2, sampleRate: 48_000, seconds: 28 }) }],
      30
    );

    expect(track.ok ? "laid" : track.error.message).toContain("5");
    expect(track.ok ? "laid" : track.error.message).toContain("MB");
  });
});
