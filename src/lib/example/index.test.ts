import { describe, expect, it } from "vitest";
// Tests import the module entry only — normalize.ts is never imported directly.
import { greet } from "./index.js";

describe("greet", () => {
  it("should return a greeting with the given name", () => {
    expect(greet("World")).toBe("Hello, World!");
  });

  it("should handle empty string", () => {
    expect(greet("")).toBe("Hello, !");
  });

  it("should collapse surrounding and repeated whitespace", () => {
    expect(greet("  Ada   Lovelace  ")).toBe("Hello, Ada Lovelace!");
  });

  it("should strip zero-width characters", () => {
    expect(greet("Ada​Lovelace")).toBe("Hello, AdaLovelace!");
  });
});
