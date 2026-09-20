import { describe, expect, it } from "vitest";
import { env } from "./env.js";

describe("env", () => {
  it("should be defined", () => {
    expect(env).toBeDefined();
  });

  it("should expose AIMATOR_WORKSPACE as an optional string", () => {
    expect(["string", "undefined"]).toContain(typeof env.AIMATOR_WORKSPACE);
  });

  // Both are optional so `--dry-run` runs with neither, and neither carries a
  // default: a model nobody chose is not a decision, and a key is a secret.
  it("should expose the stage-1 model as an optional string", () => {
    expect(["string", "undefined"]).toContain(typeof env.AIMATOR_SCREENPLAY_MODEL);
  });

  it("should expose OPENAI_API_KEY as an optional string", () => {
    expect(["string", "undefined"]).toContain(typeof env.OPENAI_API_KEY);
  });

  /**
   * One video model for both tracks, where the image models are one per track.
   * A clip is rendered from a frame its own track already drew, so the choice
   * belongs to the call site rather than to the track.
   */
  it("should expose one video model, shared by both tracks", () => {
    expect(["string", "undefined"]).toContain(typeof env.AIMATOR_VIDEO_MODEL);
  });

  /**
   * Stage 8's engine, and the only variable in this file that is not a model
   * or a key: it points at a program on this machine. Optional because the
   * usual answer is `ffmpeg` on PATH — and unlike a model, a name that is
   * simply "the one everybody installs" is not a decision anybody has to make.
   */
  it("should expose the muxer path as an optional string", () => {
    expect(["string", "undefined"]).toContain(typeof env.AIMATOR_FFMPEG);
  });

  /**
   * Stage 9 buys twice, from two providers, so it carries two model variables
   * — one per call site, exactly as every stage above it does. Neither is the
   * narrator's voice: that is a creative decision recurring across episodes,
   * so it is stored in `project.json` beside the cast rather than left to
   * whichever shell happens to run the command.
   */
  it("should expose the stage-9 narration model as an optional string", () => {
    expect(["string", "undefined"]).toContain(typeof env.AIMATOR_NARRATION_MODEL);
  });

  it("should expose the stage-9 voice model as an optional string", () => {
    expect(["string", "undefined"]).toContain(typeof env.AIMATOR_VOICE_MODEL);
  });

  it("should expose ELEVENLABS_API_KEY as an optional string", () => {
    expect(["string", "undefined"]).toContain(typeof env.ELEVENLABS_API_KEY);
  });
});
