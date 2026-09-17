import { describe, expect, it } from "vitest";
import { run } from "./cli.js";

describe("run", () => {
  it("should greet the given name", () => {
    expect(run(["greet", "Ada"])).toEqual({ data: "Hello, Ada!", ok: true });
  });

  it("should return usage when given no arguments", () => {
    const result = run([]);
    expect(result.ok && result.data).toContain("Usage:");
  });

  it("should return usage for --help", () => {
    const result = run(["--help"]);
    expect(result.ok && result.data).toContain("greet <name>");
  });

  it("should fail on an unknown command", () => {
    const result = run(["nope"]);
    expect(result.ok ? null : result.error.message).toContain("unknown command: nope");
  });

  it("should fail when greet is given no name", () => {
    const result = run(["greet"]);
    expect(result.ok ? null : result.error.message).toContain("greet requires a name");
  });

  it("should normalize the name through greet", () => {
    const result = run(["greet", "  Ada   Lovelace  "]);
    expect(result.ok ? result.data : null).toBe("Hello, Ada Lovelace!");
  });
});
