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
});
