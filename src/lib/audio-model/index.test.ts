import { describe, expect, it } from "vitest";
import { mp3 } from "../../test/fixture.js";
import { effectLength, musicLength, validateAudio } from "./index.js";

/**
 * The verdict on bought music and effects, through the module entry.
 *
 * Stage 9 could read a line's length out of twenty-four bytes because it chose
 * the container it bought in. Stage 10 cannot: neither the music endpoint nor
 * the sound-effect one offers WAV, and the raw PCM they do offer has no header
 * at all — so the channel count would be a guess, and a wrong guess states a
 * length twice the truth silently. MP3 it is, and the price of that is a walk
 * over every frame rather than a read of one header.
 *
 * Walking is what makes it exact. The objection stage 9 raised against MP3 —
 * that its length is known only to whoever counts frames "against a table of
 * bitrates, hoping the stream is constant" — is answered by not hoping: each
 * frame header declares its own bitrate, so a variable-rate stream comes out
 * right for the same reason a constant one does.
 */

describe("validateAudio", () => {
  it("should read a constant-bitrate stream's length from its frames", () => {
    const verdict = validateAudio(mp3({ seconds: 30 }));

    expect(verdict.ok ? Math.round(verdict.data.seconds) : null).toBe(30);
    expect(verdict.ok ? verdict.data.sampleRate : null).toBe(44_100);
  });

  /**
   * The case a reader that divides the file size by one bitrate gets wrong.
   * Every frame states its own, so the walk is exact rather than approximate.
   */
  it("should read a variable-bitrate stream exactly", () => {
    const verdict = validateAudio(mp3({ bitrate: [128, 192, 320, 96], seconds: 12 }));

    expect(verdict.ok ? Math.round(verdict.data.seconds) : null).toBe(12);
  });

  it("should skip an ID3v2 tag in front of the first frame", () => {
    const tagged = validateAudio(mp3({ id3: true, seconds: 10 }));
    const bare = validateAudio(mp3({ seconds: 10 }));

    expect(tagged.ok ? tagged.data.seconds : null).toBe(bare.ok ? bare.data.seconds : -1);
  });

  /**
   * A metadata frame carries no audio, and counting it would add a frame's
   * worth of silence to every file the provider sends. Small, and wrong.
   */
  it("should not count a metadata frame as a frame of audio", () => {
    const withTag = validateAudio(mp3({ seconds: 10, xing: true }));
    const without = validateAudio(mp3({ seconds: 10 }));

    expect(withTag.ok ? withTag.data.seconds : null).toBe(without.ok ? without.data.seconds : -1);
  });

  it("should report the channel mode the frames declare", () => {
    const stereo = validateAudio(mp3({ seconds: 5 }));
    const mono = validateAudio(mp3({ mono: true, seconds: 5 }));

    expect(stereo.ok ? stereo.data.channels : null).toBe(2);
    expect(mono.ok ? mono.data.channels : null).toBe(1);
  });

  it("should read a half-rate MPEG2 stream, which the cheaper formats are", () => {
    const verdict = validateAudio(mp3({ bitrate: 32, sampleRate: 22_050, seconds: 8 }));

    expect(verdict.ok ? Math.round(verdict.data.seconds) : null).toBe(8);
    expect(verdict.ok ? verdict.data.sampleRate : null).toBe(22_050);
  });

  /**
   * The provider answers a refusal with JSON rather than audio. It has to read
   * as a refusal here rather than as a zero-length track, because the archive
   * keeps it and somebody has to be told what the API actually said.
   */
  it("should refuse an answer that is not audio at all", () => {
    const verdict = validateAudio(Buffer.from('{"detail":{"status":"quota_exceeded"}}', "utf8"));

    expect(verdict.ok).toBe(false);
  });

  it("should refuse a stream with no frames in it", () => {
    expect(validateAudio(Buffer.alloc(0)).ok).toBe(false);
  });
});

/**
 * The two lengths a stage may ask this provider for, refused rather than
 * clamped — the same reading `clipDuration` gives a duration no video model
 * renders. Quietly shortening a cue would change what the film sounds like on
 * nobody's authority, and the remedy is upstream in every case.
 */
describe("the provider's limits", () => {
  it("should accept a bed between three seconds and ten minutes", () => {
    expect(musicLength(90).ok).toBe(true);
    expect(musicLength(3).ok).toBe(true);
    expect(musicLength(600).ok).toBe(true);
  });

  it("should refuse a bed the music model will not compose", () => {
    expect(musicLength(2).ok).toBe(false);
    expect(musicLength(601).ok).toBe(false);
  });

  it("should hold an effect to the half-second-to-thirty-seconds window", () => {
    expect(effectLength(0.5).ok).toBe(true);
    expect(effectLength(30).ok).toBe(true);
    expect(effectLength(0.4).ok).toBe(false);
    expect(effectLength(31).ok).toBe(false);
  });

  it("should name the remedy rather than only refusing", () => {
    const refusal = effectLength(45);

    expect(refusal.ok ? null : refusal.error.message).toContain("30");
  });
});
