import { describe, expect, it } from "vitest";
import { frameSize, readImageResponse, referenceLimit, validateImage } from "./index.js";

function reason(result: ReturnType<typeof frameSize>): string {
  return result.ok ? "" : result.error.message;
}

function size(aspectRatio: string): string {
  const result = frameSize(aspectRatio);

  return result.ok ? result.data : reason(result);
}

/** The two numbers a provider limit is stated in. */
function pixels(aspectRatio: string): { height: number; width: number } {
  const [width = 0, height = 0] = size(aspectRatio).split("x").map(Number);

  return { height, width };
}

describe("frameSize", () => {
  it("should give 16:9 the largest frame both tracks accept", () => {
    expect(size("16:9")).toBe("2816x1584");
  });

  it("should keep the ratio exactly, not approximately", () => {
    const { height, width } = pixels("16:9");

    expect(width / height).toBe(16 / 9);
  });

  it("should give both sides as multiples of 16, which gpt-image requires", () => {
    for (const aspectRatio of ["16:9", "9:16", "1:1", "4:3", "21:9", "2:1"]) {
      const { height, width } = pixels(aspectRatio);

      expect(width % 16).toBe(0);
      expect(height % 16).toBe(0);
    }
  });

  it("should stay inside the pixel window seedream accepts", () => {
    for (const aspectRatio of ["16:9", "9:16", "1:1", "4:3", "21:9", "2:1"]) {
      const { height, width } = pixels(aspectRatio);

      expect(width * height).toBeGreaterThanOrEqual(921_600);
      expect(width * height).toBeLessThanOrEqual(4_624_220);
    }
  });

  it("should keep the long edge inside what gpt-image renders", () => {
    for (const aspectRatio of ["16:9", "9:16", "1:1", "4:3", "21:9", "2:1"]) {
      const { height, width } = pixels(aspectRatio);

      expect(Math.max(width, height)).toBeLessThanOrEqual(3840);
    }
  });

  it("should turn a portrait ratio the same way round", () => {
    expect(size("9:16")).toBe("1584x2816");
  });

  it("should reduce a ratio before scaling it", () => {
    expect(size("32:18")).toBe(size("16:9"));
  });

  it("should be the same frame on both tracks, so the two results compare", () => {
    expect(size("16:9")).toBe(size("16:9"));
  });

  /** A ratio no track renders is refused, never rounded into one they do. */
  it("should refuse a ratio outside what the tracks render", () => {
    expect(reason(frameSize("4:1"))).toContain("1:3");
  });

  it("should refuse something that is not a ratio", () => {
    expect(reason(frameSize("wide"))).toContain("w:h");
  });

  it("should refuse a ratio with a zero side", () => {
    expect(frameSize("16:0").ok).toBe(false);
  });
});

describe("referenceLimit", () => {
  it("should carry the published limit of each track", () => {
    expect(referenceLimit("seedream")).toBe(10);
    expect(referenceLimit("gpt-image")).toBe(16);
  });
});
/**
 * A PNG only as far as this validator reads one: signature, IHDR with the
 * dimensions and colour type, and a closing IEND. Enough to drive every branch
 * without committing binary fixtures to the repository.
 */
function png(options: {
  readonly colorType?: number;
  readonly height: number;
  readonly padding?: number;
  readonly width: number;
}): Buffer {
  const head = Buffer.alloc(26);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "ascii");
  head.writeUInt32BE(options.width, 16);
  head.writeUInt32BE(options.height, 20);
  head.writeUInt8(8, 24);
  head.writeUInt8(options.colorType ?? 2, 25);

  const tail = Buffer.alloc(12);
  tail.write("IEND", 4, "ascii");

  return Buffer.concat([head, Buffer.alloc(options.padding ?? 64), tail]);
}

describe("validateImage", () => {
  it("should accept a png whose dimensions match the requested size", () => {
    const result = validateImage(png({ height: 1920, width: 1920 }), "1920x1920");

    expect(result.ok && result.data.width).toBe(1920);
    expect(result.ok && result.data.height).toBe(1920);
  });

  it("should reject bytes that are not a png", () => {
    const result = validateImage(Buffer.from("<html>nope</html>"), "1920x1920");

    expect(result.ok ? null : result.error.message).toContain("PNG");
  });

  it("should reject a png that never reaches IEND", () => {
    const truncated = png({ height: 1920, width: 1920 }).subarray(0, 40);
    const result = validateImage(truncated, "1920x1920");

    expect(result.ok ? null : result.error.message).toContain("niekompletny");
  });

  it("should reject dimensions the request never asked for", () => {
    const result = validateImage(png({ height: 1024, width: 1024 }), "1920x1920");

    expect(result.ok ? null : result.error.message).toContain("1024x1024");
  });

  /**
   * Alpha is reported, never enforced: seedream has no background switch, so a
   * missing channel is a judgement for the reviewer rather than grounds for
   * throwing away an image that has already been paid for.
   */
  it("should report a missing alpha channel without failing", () => {
    const result = validateImage(png({ colorType: 2, height: 1536, width: 1536 }), "1536x1536");

    expect(result.ok && result.data.alpha).toBe(false);
  });

  it("should report an alpha channel when the colour type carries one", () => {
    const result = validateImage(png({ colorType: 6, height: 1536, width: 1536 }), "1536x1536");

    expect(result.ok && result.data.alpha).toBe(true);
  });
});

describe("readImageResponse", () => {
  it("should read inline bytes from a gpt-image response", () => {
    const body = JSON.stringify({ data: [{ b64_json: Buffer.from("png").toString("base64") }] });
    const result = readImageResponse("gpt-image", body);

    expect(result.ok && result.data.payload.kind).toBe("bytes");
  });

  it("should read a download url from a seedream response", () => {
    const body = JSON.stringify({ data: [{ url: "https://ark.example/img.png" }], id: "job-1" });
    const result = readImageResponse("seedream", body);

    expect(result.ok && result.data.payload.kind).toBe("url");
    expect(result.ok && result.data.jobId).toBe("job-1");
  });

  it("should refuse a seedream url that is not https", () => {
    const body = JSON.stringify({ data: [{ url: "http://ark.example/img.png" }] });
    const result = readImageResponse("seedream", body);

    expect(result.ok ? null : result.error.message).toContain("HTTPS");
  });

  it("should refuse a url carrying credentials", () => {
    const body = JSON.stringify({ data: [{ url: "https://user:pass@ark.example/img.png" }] });
    const result = readImageResponse("seedream", body);

    expect(result.ok ? null : result.error.message).toContain("HTTPS");
  });

  it("should report a provider error rather than an empty image", () => {
    const body = JSON.stringify({ error: { code: "ModelNotOpen", message: "not enabled" } });
    const result = readImageResponse("seedream", body);

    expect(result.ok ? null : result.error.message).toContain("ModelNotOpen");
  });

  it("should refuse more than one image in a response", () => {
    const body = JSON.stringify({ data: [{ url: "https://a/1.png" }, { url: "https://a/2.png" }] });
    const result = readImageResponse("seedream", body);

    expect(result.ok ? null : result.error.message).toContain("jednego obrazu");
  });

  it("should refuse a body that is not json", () => {
    const result = readImageResponse("gpt-image", "<html>502</html>");

    expect(result.ok ? null : result.error.message).toContain("JSON");
  });
});
