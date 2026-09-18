import { describe, expect, it } from "vitest";
import { CHARACTER_ARTIFACTS, readImageResponse, validateImage } from "./index.js";

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

describe("CHARACTER_ARTIFACTS", () => {
  it("should run card, then the eight views, then hero", () => {
    expect(CHARACTER_ARTIFACTS[0]).toBe("card");
    expect(CHARACTER_ARTIFACTS.at(-1)).toBe("hero");
    expect(CHARACTER_ARTIFACTS).toHaveLength(10);
  });
});
