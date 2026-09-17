import { describe, expect, it } from "vitest";
import { env } from "./env.js";

describe("env", () => {
  it("should be defined", () => {
    expect(env).toBeDefined();
  });

  it("should expose AIMATOR_WORKSPACE as an optional string", () => {
    expect(["string", "undefined"]).toContain(typeof env.AIMATOR_WORKSPACE);
  });
});
