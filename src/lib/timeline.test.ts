import { describe, expect, it } from "vitest";
import { type PlanClock, placeSpeech } from "./timeline.js";

/**
 * Where speech lands on one finished film, and when two voices collide.
 *
 * Assumptions this file encodes, stated before its first test:
 *
 * - **The clock is given, not read.** `readPlanClock` reads clips off disk;
 *   what is under test here is the arithmetic after it, so the clock is a plain
 *   function that shifts every second of the plan by the drift a test chooses.
 * - **Any two utterances may collide**, not only neighbours in the list: a
 *   narrator's line and a character's line come from two scripts, and a long
 *   line can still be speaking when the one after next begins.
 * - **Touching is not overlapping.** A line may begin on the very thousandth
 *   of a second the previous one ends.
 * - **Nothing is moved.** Every collision and every overrun is reported for
 *   the caller to word as its own refusal.
 */

/** A clock whose film runs `drift` seconds behind the plan, everywhere. */
function clock(drift = 0): PlanClock {
  return { at: (planned) => Math.round((planned + drift) * 1000) / 1000, drift: [] };
}

describe("placeSpeech", () => {
  it("should place every utterance on the film's clock, in the order it was given", () => {
    const result = placeSpeech({
      actualSeconds: 30,
      clock: clock(0.25),
      speech: [
        { atSeconds: 22, id: "D03", seconds: 1 },
        { atSeconds: 2, id: "N01", seconds: 1.5 },
      ],
    });

    expect(result.placed).toEqual([
      { atSeconds: 22.25, ends: 23.25, id: "D03", plannedSeconds: 22, seconds: 1 },
      { atSeconds: 2.25, ends: 3.75, id: "N01", plannedSeconds: 2, seconds: 1.5 },
    ]);
    expect(result.overlaps).toEqual([]);
    expect(result.overruns).toEqual([]);
  });

  it("should name both utterances when one starts before another has finished", () => {
    const result = placeSpeech({
      actualSeconds: 30,
      clock: clock(),
      speech: [
        { atSeconds: 2, id: "N01", seconds: 1 },
        { atSeconds: 2.5, id: "D01", seconds: 1 },
      ],
    });

    expect(result.overlaps.map(({ earlier, later }) => [earlier.id, later.id])).toEqual([
      ["N01", "D01"],
    ]);
  });

  /** The neighbour test alone would miss this: D02 ends in time, D01 does not. */
  it("should find a collision with an utterance that is not the previous one", () => {
    const result = placeSpeech({
      actualSeconds: 30,
      clock: clock(),
      speech: [
        { atSeconds: 2, id: "D01", seconds: 8 },
        { atSeconds: 4, id: "D02", seconds: 1 },
        { atSeconds: 7, id: "D03", seconds: 1 },
      ],
    });

    expect(result.overlaps.map(({ earlier, later }) => [earlier.id, later.id])).toEqual([
      ["D01", "D02"],
      ["D01", "D03"],
    ]);
  });

  it("should let an utterance begin exactly where the previous one ends", () => {
    const result = placeSpeech({
      actualSeconds: 30,
      clock: clock(),
      speech: [
        { atSeconds: 2, id: "D01", seconds: 1.5 },
        { atSeconds: 3.5, id: "D02", seconds: 1 },
      ],
    });

    expect(result.overlaps).toEqual([]);
  });

  it("should report an utterance that runs past the end of the film", () => {
    const result = placeSpeech({
      actualSeconds: 29.8,
      clock: clock(),
      speech: [{ atSeconds: 28, id: "D03", seconds: 2 }],
    });

    expect(result.overruns.map((one) => [one.id, one.ends])).toEqual([["D03", 30]]);
  });
});
