import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { hostFile, presignUrl } from "./hosting.js";

interface Sent {
  readonly bytes: number;
  readonly method: string;
  readonly url: URL;
}

/**
 * A bucket that answers every verb with the status the test chose, or never
 * answers at all, the way a dropped connection does.
 */
function bucket(status: Partial<Record<string, number | "offline">> = {}) {
  const sent: Sent[] = [];
  const transport = ((url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body;
    const answer = status[method] ?? (method === "DELETE" ? 204 : 200);

    sent.push({
      bytes: body instanceof Uint8Array ? body.length : 0,
      method,
      url: new URL(String(url)),
    });

    if (answer === "offline") {
      return Promise.reject(new TypeError("fetch failed"));
    }

    return Promise.resolve(
      new Response(answer === 204 ? null : "<Error><Code>InternalError</Code></Error>", {
        status: answer,
      })
    );
  }) as unknown as typeof fetch;

  return { sent, transport };
}

const VARIABLES = {
  AIMATOR_LIPSYNC_BUCKET: "aimator-lipsync",
  R2_ACCESS_KEY_ID: "access-id",
  R2_ACCOUNT_ID: "acc123",
  R2_SECRET_ACCESS_KEY: "secret",
};

/** A clip where stage 7 leaves one, so the test can say the key never repeats it. */
function clip(): string {
  const root = mkdtempSync(join(tmpdir(), "aimator-hosting-"));
  const path = join(root, "projects", "dzielna-ewa", "episodes", "e01", "seedream", "C01.mp4");

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.from("not really a film"));

  return path;
}

const NOW = () => new Date("2026-10-13T12:00:00Z");
const SIGNATURE = /^[0-9a-f]{64}$/;
const IN_BUCKET = /^\/aimator-lipsync\/.+/;

describe("hostFile", () => {
  it("should upload to the private bucket and hand out a GET that expires within the hour", async () => {
    const { sent, transport } = bucket();
    const hosted = await hostFile({
      fetch: transport,
      now: NOW,
      path: clip(),
      variables: VARIABLES,
    });

    expect(sent.map((one) => one.method)).toEqual(["PUT"]);
    expect(sent[0]?.url.origin).toBe("https://acc123.r2.cloudflarestorage.com");
    expect(sent[0]?.url.pathname).toMatch(IN_BUCKET);
    expect(sent[0]?.bytes).toBe(17);

    const url = new URL(hosted.ok ? hosted.data.url : "https://refused.invalid");

    expect(url.origin + url.pathname).toBe(sent[0]?.url.origin + (sent[0]?.url.pathname ?? ""));
    expect(url.searchParams.get("X-Amz-Credential")).toBe(
      "access-id/20261013/auto/s3/aws4_request"
    );
    expect(Number(url.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(3600);
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(SIGNATURE);
  });

  it("should take the file back with a signed DELETE of the same object", async () => {
    const { sent, transport } = bucket();
    const hosted = await hostFile({
      fetch: transport,
      now: NOW,
      path: clip(),
      variables: VARIABLES,
    });
    const notice = hosted.ok ? await hosted.data.remove() : "refused";

    expect(notice).toBeNull();
    expect(sent.map((one) => one.method)).toEqual(["PUT", "DELETE"]);
    expect(sent[1]?.url.pathname).toBe(sent[0]?.url.pathname);
    expect(sent[1]?.url.searchParams.get("X-Amz-Signature")).toMatch(SIGNATURE);
  });

  /**
   * A failed DELETE is reported, not refused. The bucket is private and the
   * address expires on its own, so the job's result is still good; what a
   * person needs is the object's name, to remove it by hand.
   */
  it("should report a failed DELETE as a notice naming the object", async () => {
    const { transport } = bucket({ DELETE: 500 });
    const hosted = await hostFile({
      fetch: transport,
      now: NOW,
      path: clip(),
      variables: VARIABLES,
    });
    const notice = hosted.ok ? await hosted.data.remove() : null;

    expect(notice).toContain("500");
    expect(notice).toContain(hosted.ok ? hosted.data.key : "refused");
  });

  it("should report a DELETE that never arrived as a notice too", async () => {
    const { transport } = bucket({ DELETE: "offline" });
    const hosted = await hostFile({
      fetch: transport,
      now: NOW,
      path: clip(),
      variables: VARIABLES,
    });
    const notice = hosted.ok ? await hosted.data.remove() : null;

    expect(notice).toContain(hosted.ok ? hosted.data.key : "refused");
  });

  /**
   * Each variable is named in the refusal, and the refusal comes before the
   * upload: a person fixes this with one line in `.env.local`, and the words of
   * that line are what the message has to carry.
   */
  it.each([
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "AIMATOR_LIPSYNC_BUCKET",
  ] as const)("should refuse without %s before anything is sent", async (missing) => {
    const { sent, transport } = bucket();
    const hosted = await hostFile({
      fetch: transport,
      now: NOW,
      path: clip(),
      variables: { ...VARIABLES, [missing]: undefined },
    });

    expect(hosted.ok ? "hosted" : hosted.error.message).toContain(missing);
    expect(sent).toEqual([]);
  });

  /**
   * Rule 3 one level out: the layout is `workspace.ts`'s, and a key that
   * carried a project's or a clip's name would copy it into a bucket somebody
   * else's servers read. The digest names the bytes and nothing else.
   */
  it("should name the object by the file's digest and never by its path", async () => {
    const { sent, transport } = bucket();
    const path = clip();
    const hosted = await hostFile({ fetch: transport, now: NOW, path, variables: VARIABLES });
    const key = hosted.ok ? hosted.data.key : "";

    expect(key).toBe(`${createHash("sha256").update("not really a film").digest("hex")}.mp4`);

    for (const segment of path.split(sep).filter((one) => one !== "")) {
      if (segment !== "C01.mp4") {
        expect(sent[0]?.url.pathname).not.toContain(`/${segment}/`);
      }
      expect(key).not.toContain(segment);
    }
  });

  it("should refuse when the bucket refuses the upload, and hand out nothing", async () => {
    const { sent, transport } = bucket({ PUT: 403 });
    const hosted = await hostFile({
      fetch: transport,
      now: NOW,
      path: clip(),
      variables: VARIABLES,
    });

    expect(hosted.ok ? "hosted" : hosted.error.message).toContain("403");
    expect(sent.map((one) => one.method)).toEqual(["PUT"]);
  });
});

/**
 * A file lent to a provider for one job, through the module entry.
 *
 * The transport is a fake that records every request and answers what the test
 * tells it to, so nothing here touches the network or a bucket. What the tests
 * pin is the order around the lending: the variables are checked before any
 * request, the upload is signed, the address handed out expires within an
 * hour, and taking the file back is a notice when it fails, never a refusal.
 */

describe("presignUrl", () => {
  /**
   * The signature is the one part nobody can eyeball, so it is pinned against
   * the worked example AWS publishes in "Authenticating Requests: Using Query
   * Parameters (AWS Signature Version 4)": the same key, the same moment, the
   * same object, and the signature the page prints.
   */
  it("should sign AWS's documented example to the documented signature", () => {
    const url = new URL(
      presignUrl({
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        at: new Date("2013-05-24T00:00:00Z"),
        expires: 86_400,
        method: "GET",
        region: "us-east-1",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        url: "https://examplebucket.s3.amazonaws.com/test.txt",
      })
    );

    expect(url.searchParams.get("X-Amz-Credential")).toBe(
      "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request"
    );
    expect(url.searchParams.get("X-Amz-Signature")).toBe(
      "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
    );
  });
});
