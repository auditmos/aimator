import { readFileSync } from "node:fs";
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
   * usual answer is `ffmpeg` on PATH, and unlike a model, a name that is
   * simply "the one everybody installs" is not a decision anybody has to make.
   */
  it("should expose the muxer path as an optional string", () => {
    expect(["string", "undefined"]).toContain(typeof env.AIMATOR_FFMPEG);
  });

  /**
   * Stage 9 buys twice, from two providers, so it carries two model variables,
   * one per call site, exactly as every stage above it does. Neither is the
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

  /**
   * Stage 10 has three of its own, because it has three paid call sites: one
   * text model writes the cue sheet and two audio models make the sound. The
   * key for the last two is stage 9's, the key follows the provider, the
   * variable follows the call site.
   */
  it("should expose the stage-10 cue-sheet model as an optional string", () => {
    expect(["string", "undefined"]).toContain(typeof env.AIMATOR_SOUND_MODEL);
  });

  it("should expose the stage-10 music model as an optional string", () => {
    expect(["string", "undefined"]).toContain(typeof env.AIMATOR_MUSIC_MODEL);
  });

  it("should expose the stage-10 effects model as an optional string", () => {
    expect(["string", "undefined"]).toContain(typeof env.AIMATOR_EFFECTS_MODEL);
  });

  /**
   * Stage 7's second video provider. The key follows the provider, so Kling has
   * its own, read only on the paid path like every other one.
   */
  it("should expose KLING_API_KEY as an optional string", () => {
    expect(["string", "undefined"]).toContain(typeof env.KLING_API_KEY);
  });

  /**
   * Every variable the schema declares is written down twice for a person:
   * `.env.example` is the committed reference and `docs/konfiguracja.md` says
   * what each is for. The list is read off the schema, so a new variable that
   * is not documented fails here rather than being remembered.
   */
  it("should document every variable in .env.example and docs/konfiguracja.md", () => {
    const declared = [
      ...readFileSync("src/lib/env.ts", "utf8").matchAll(/^ {4}([A-Z][A-Z0-9_]+): z\./gm),
    ].map((match) => match[1] ?? "");
    const example = readFileSync(".env.example", "utf8");
    const guide = readFileSync("docs/konfiguracja.md", "utf8");

    expect(declared).toContain("KLING_API_KEY");
    expect(declared.filter((name) => !example.includes(name))).toEqual([]);
    expect(declared.filter((name) => !guide.includes(name))).toEqual([]);
  });
});
