import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ffmpeg } from "./index.js";

/**
 * The real engine, which every other test replaces with a fake.
 *
 * Two things here cannot be faked without testing the fake instead: what
 * happens when the program is not on this machine, and whether the version
 * string a real ffmpeg prints is the one this module claims to read. The first
 * runs anywhere; the second only where ffmpeg is installed, and is skipped
 * rather than mocked, because a mocked `ffmpeg -version` would assert nothing
 * about the format it exists to parse.
 */

/** What the module promises a version string looks like: the name, then one token. */
const VERSION = /^ffmpeg \S+$/;

/** Whether this machine has one, so the second test knows to run. */
function installed(): boolean {
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" });

    return true;
  } catch {
    return false;
  }
}

describe("ffmpeg", () => {
  /**
   * The refusal is the whole of what stage 8 does without an engine — there is
   * no second road — so the message has to name both remedies.
   */
  it("should refuse by name when the program is not there", async () => {
    const result = await ffmpeg("aimator-no-such-muxer").version();

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain("AIMATOR_FFMPEG");
  });

  it("should refuse a program that answers but is not ffmpeg", async () => {
    const result = await ffmpeg("echo").version();

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain("ffmpeg");
  });

  it.runIf(installed())("should read the version a real ffmpeg prints", async () => {
    const result = await ffmpeg("ffmpeg").version();

    expect(result.ok ? result.data : "").toMatch(VERSION);
  });
});
