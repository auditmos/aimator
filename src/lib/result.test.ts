import { describe, expect, it } from "vitest";
import { err, ok, type Result } from "./result.js";

describe("Result", () => {
  it("should carry data on the ok branch", () => {
    expect(ok(42)).toEqual({ data: 42, ok: true });
  });

  it("should carry the error on the err branch", () => {
    const error = new Error("boom");
    expect(err(error)).toEqual({ error, ok: false });
  });

  it("should narrow to data when ok is true", () => {
    const result: Result<number> = ok(42);
    expect(result.ok ? result.data : null).toBe(42);
  });

  it("should narrow to error when ok is false", () => {
    const result: Result<number> = err(new Error("boom"));
    expect(result.ok ? null : result.error.message).toBe("boom");
  });

  it("should type a function returning either branch", () => {
    function parsePort(raw: string): Result<number> {
      const port = Number(raw);
      return Number.isInteger(port) ? ok(port) : err(new Error(`invalid port: ${raw}`));
    }

    expect(parsePort("8080")).toEqual({ data: 8080, ok: true });
    expect(parsePort("nope").ok).toBe(false);
  });
});
