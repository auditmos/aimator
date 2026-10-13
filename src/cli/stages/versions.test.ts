import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findFaces, generateLipSync } from "../../lib/versions/index.js";
import { resolveWorkspace, type Workspace } from "../../lib/workspace.js";
import {
  EPISODE,
  makeDialogue,
  makeTrack,
  makeUpstream,
  mp4,
  PROJECT,
  png,
} from "../../test/fixture.js";
import { run } from "../index.js";

/**
 * Stage 12 through the terminal: the bill before anything is sent, counted
 * apart for face calls and lip-sync jobs, the stage's own object under
 * `--json`, a binding refused when it cannot be read, and an approval that has
 * to name the clips it accepts. Nothing here spends: the one face call is made
 * through the module entry on a fake Kling, and `lip-sync` is only previewed.
 */

vi.mock("../../lib/env.js", () => ({ env: {} }));

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

function answer(): string {
  return JSON.stringify({
    clips: ["C01", "C02"].map((id) => ({
      id,
      prompt: `Akcja klipu ${id}.`,
      referenceIds: ["hero:ewa", "hero:tata", "R01"],
    })),
    entryFrames: [{ clipId: "C02", prompt: "Pierwsza chwila klipu C02." }],
    opening: { prompt: "Ewa centralnie, burza za oknem.", referenceIds: ["hero:ewa", "R01"] },
    references: [
      {
        dependsOn: ["hero:ewa"],
        id: "R01",
        kind: "location",
        prompt: "Salon z niską kanapą.",
        subject: "Living room, evening",
      },
    ],
    review: "Do rozstrzygnięcia: skala alpaki.",
  });
}

const HOSTING = {
  AIMATOR_LIPSYNC_BUCKET: "aimator-lipsync",
  R2_ACCESS_KEY_ID: "access-id",
  R2_ACCOUNT_ID: "acc123",
  R2_SECRET_ACCESS_KEY: "secret",
};

/**
 * Kling and the private bucket: one face call finds Ewa alone in the clip, and
 * a lip-sync job hands back the clip's own frame and length.
 */
const kling = ((url: string | URL, init?: RequestInit) => {
  const href = new URL(String(url));

  if (href.hostname.endsWith("r2.cloudflarestorage.com")) {
    return Promise.resolve(new Response(null, { status: init?.method === "DELETE" ? 204 : 200 }));
  }

  if (href.hostname === "faces") {
    return Promise.resolve(new Response(png(256, 256), { status: 200 }));
  }

  if (href.hostname === "download") {
    return Promise.resolve(new Response(mp4({ height: 1080, seconds: 15, width: 1920 })));
  }

  if (href.pathname.startsWith("/v1/videos/advanced-lip-sync")) {
    return Promise.resolve(
      Response.json({
        code: 0,
        data: {
          task_id: "ls-1",
          task_result: { videos: [{ id: "vls-1", url: "https://download/ls-1" }] },
          task_status: init?.method === "POST" ? "submitted" : "succeed",
        },
      })
    );
  }

  return Promise.resolve(
    Response.json({
      code: 0,
      data: {
        face_data: [
          { end_time: 15_000, face_id: "0", face_image: "https://faces/0.png", start_time: 0 },
        ],
        session_id: "session-1",
      },
      message: "SUCCEED",
    })
  );
}) as unknown as typeof fetch;

/** What the terminal would print, or the error it would print instead. */
async function cli(...argv: readonly string[]): Promise<string> {
  const result = await run([...argv, "--workspace", root]);

  if (!result.ok) {
    throw result.error;
  }

  return result.data;
}

const ON = [PROJECT, EPISODE, "--track", "gpt-image"] as const;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aimator-cli-stage12-"));
  root = join(scratch, "workspace");
  const resolved = resolveWorkspace(root);
  workspace = resolved.ok ? resolved.data : { root: "" };
  await makeUpstream({
    answer: answer(),
    approvePackage: true,
    dialogue: true,
    root,
    scratch,
    workspace,
  });
  await makeTrack({ root, track: "gpt-image", workspace });
  await makeDialogue({ workspace });
}, 60_000);

afterAll(async () => {
  await rm(scratch, { force: true, recursive: true });
});

describe("versions faces", () => {
  it("should state the one paid face call before sending anything", async () => {
    const text = await cli("versions", "faces", ...ON, "--artifact", "C01", "--dry-run");

    expect(text).toContain("płatnych rozpoznań do wykonania: 1");
  });

  it("should refuse more than one clip, because one call finds the faces of one", async () => {
    await expect(cli("versions", "faces", ...ON, "--artifact", "C01,C02")).rejects.toThrow(
      "dokładnie jeden klip"
    );
  });
});

describe("versions bind and lip-sync", () => {
  beforeAll(async () => {
    await findFaces({
      apiKey: "kling-key",
      artifact: "C01",
      episodeId: EPISODE,
      fetch: kling,
      hosting: HOSTING,
      mode: "apply",
      projectId: PROJECT,
      regenerate: false,
      track: "gpt-image",
      workspace,
    });
  });

  it("should refuse a --face it cannot read rather than guess at it", async () => {
    await expect(
      cli("versions", "bind", ...ON, "--artifact", "C01", "--face", "0ewa")
    ).rejects.toThrow("<twarz>=<postać>");
  });

  it("should print each job with its window in ms once the faces are bound", async () => {
    await cli("versions", "bind", ...ON, "--artifact", "C01", "--face", "0=ewa");
    const text = await cli("versions", "lip-sync", ...ON, "--artifact", "C01", "--dry-run");

    expect(text).toContain("rozpoznań: 0, zadań lip-sync: 1");
    expect(text).toContain("C01: ewa, twarz 0, od 1000 ms do 3000 ms, en:D01, planned");
  });

  it("should print each clip's faces and who they are bound to in check", async () => {
    await cli("versions", "bind", ...ON, "--artifact", "C01", "--face", "0=ewa");
    const text = await cli("check", ...ON, "--stage", "versions");

    expect(text).toContain("      twarze: 0 (0–15000 ms); przypisanie: 0=ewa");
  });

  it("should answer check --json with the stage's own object", async () => {
    const parsed = JSON.parse(await cli("check", ...ON, "--stage", "versions", "--json")) as {
      clips: { id: string }[];
      command: string;
      stage: string;
    };

    expect(parsed).toMatchObject({ command: "check", stage: "versions" });
    expect(parsed.clips.map((one) => one.id)).toEqual(["C01", "C02"]);
  });

  it("should refuse an approval that names no clip", async () => {
    await expect(cli("approve", ...ON, "--stage", "versions")).rejects.toThrow(
      "--artifact jest wymagane"
    );
  });

  it("should accept a lip-synced clip a person watched", async () => {
    await cli("versions", "bind", ...ON, "--artifact", "C01", "--face", "0=ewa");
    await generateLipSync({
      apiKey: "kling-key",
      artifacts: ["C01"],
      episodeId: EPISODE,
      fetch: kling,
      hosting: HOSTING,
      mode: "apply",
      projectId: PROJECT,
      regenerate: false,
      track: "gpt-image",
      workspace,
    });
    const text = await cli("approve", ...ON, "--stage", "versions", "--artifact", "C01");

    expect(text).toContain("C01: zatwierdzony");
  });
});
