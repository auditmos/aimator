import { describe, expect, it } from "vitest";
import { parseRange } from "./byte-range.js";

/**
 * The arithmetic of a byte range, which is where an off-by-one hides.
 *
 * It moved here with the function when the local UI became its second caller,
 * and the tests moved with it rather than being rewritten: what they hold is a
 * claim about the parse, not about the worker that used to own it.
 */

const SIZE = 30;

describe("parseRange", () => {
  it("should read a span counted from the start", () => {
    expect(parseRange("bytes=5-9", SIZE)).toEqual({ first: 5, last: 9 });
  });

  it("should run an open-ended span to the last byte", () => {
    expect(parseRange("bytes=20-", SIZE)).toEqual({ first: 20, last: SIZE - 1 });
  });

  it("should read a suffix span counted back from the end", () => {
    expect(parseRange("bytes=-10", SIZE)).toEqual({ first: SIZE - 10, last: SIZE - 1 });
  });

  it("should clamp a span that runs past the end of the file", () => {
    expect(parseRange("bytes=25-999", SIZE)).toEqual({ first: 25, last: SIZE - 1 });
  });

  it("should clamp a suffix longer than the file to the whole file", () => {
    expect(parseRange("bytes=-999", SIZE)).toEqual({ first: 0, last: SIZE - 1 });
  });

  it("should refuse a header that names no span at all", () => {
    expect(parseRange("bytes=-", SIZE)).toBeNull();
    expect(parseRange("bytes=abc", SIZE)).toBeNull();
    expect(parseRange("items=0-9", SIZE)).toBeNull();
  });

  it("should refuse a span that starts at or past the end", () => {
    expect(parseRange(`bytes=${SIZE}-`, SIZE)).toBeNull();
    expect(parseRange("bytes=9-5", SIZE)).toBeNull();
  });
});
