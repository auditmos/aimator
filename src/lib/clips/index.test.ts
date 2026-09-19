import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  API_KEY,
  EPISODE,
  makeUpstream,
  mp4,
  PROJECT,
  png,
  recorder,
  type ShotListShape,
} from "../../test/fixture.js";
import { approveOpeningFrame, generateOpeningFrame } from "../opening-frame/index.js";
import { approveReferences, generateReferences } from "../references/index.js";
import { type ImageTrack, resolveWorkspace, type Workspace } from "../workspace.js";
import { approveClips, checkClips, generateClips } from "./index.js";

/**
 * Stage 7 end to end, through the module entry.
 *
 * It is the first stage that buys two kinds of media, and the first whose gate
 * is a chain: an entry frame waits for the accepted end of the clip before it,
 * that clip waits for its own entry frame, and every link is a human saying yes.
 * Both facts are what these tests are about — everything else is borrowed from
 * `lib/image-model`, `lib/video-model` and `lib/media-prompt`, which have their
 * own.
 *
 * Stages 0 to 4 come from `src/test/fixture`, stages 5 and 6 are run here by
 * their real commands, because what stage 7 refuses to do without an accepted
 * opening frame is precisely the thing under test.
 */

const VIDEO_KEY = "ark-test-key";
const CLIP = mp4({ height: 1080, seconds: 10, width: 1920 });
const SHORT_CLIP = mp4({ height: 1080, seconds: 3, width: 1920 });
const END_FRAME = png(1920, 1080, 3);

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

/** A manifest for however many clips the shot list plans. */
function answer(clipIds: readonly string[]): string {
  return JSON.stringify({
    clips: clipIds.map((id) => ({
      id,
      prompt: `Akcja klipu ${id}.`,
      referenceIds: ["hero:ewa", "hero:tata", "R01"],
    })),
    entryFrames: clipIds.slice(1).map((id) => ({
      clipId: id,
      prompt: `Pierwsza chwila klipu ${id}.`,
    })),
    opening: { prompt: "Ewa centralnie, burza za oknem.", referenceIds: ["hero:ewa", "R01"] },
    references: [
      {
        dependsOn: ["hero:ewa"],
        id: "R01",
        kind: "location",
        prompt: "Salon z niską kanapą.",
        subject: "Living room — evening",
      },
    ],
    review: "Do rozstrzygnięcia: skala alpaki.",
  });
}

function upstream(shape: ShotListShape = "three-clips"): Promise<void> {
  const clipIds =
    shape === "unrenderable-clip" ? ["C01", "C02", "C03", "C04"] : ["C01", "C02", "C03"];

  return makeUpstream({
    answer: answer(clipIds),
    approvePackage: true,
    root,
    scratch,
    shotList: shape,
    workspace,
  });
}

/** Stage 5 and stage 6 on one track, both accepted — stage 7's starting point. */
async function makeOpeningFrame(track: ImageTrack, approve = true): Promise<void> {
  await generateReferences({
    apiKey: API_KEY,
    artifacts: [],
    episodeId: EPISODE,
    fetch: recorder().fetch,
    mode: "apply",
    model: "gpt-image-2.5-sunburst",
    projectId: PROJECT,
    regenerate: false,
    track,
    workspace,
  });
  await approveReferences({
    artifacts: ["R01"],
    episodeId: EPISODE,
    mode: "apply",
    note: "ok",
    projectId: PROJECT,
    reviewer: "tester",
    track,
    workspace,
  });
  await generateOpeningFrame({
    apiKey: API_KEY,
    artifacts: [],
    episodeId: EPISODE,
    fetch: recorder().fetch,
    mode: "apply",
    model: "gpt-image-2.5-sunburst",
    projectId: PROJECT,
    regenerate: false,
    track,
    workspace,
  });

  if (approve) {
    await approveOpeningFrame({
      artifacts: [],
      episodeId: EPISODE,
      mode: "apply",
      note: "ok",
      projectId: PROJECT,
      reviewer: "tester",
      track,
      workspace,
    });
  }
}

interface Provider {
  readonly calls: { method: string; url: string }[];
  readonly fetch: typeof fetch;
}

/**
 * Both providers behind one transport: the image API stage 7 draws entry frames
 * with, and the video API it buys clips from. One fake because one command uses
 * both, and the count of each is the assertion that matters most.
 */
function provider(options: { clip?: Buffer } = {}): Provider {
  const clip = options.clip ?? CLIP;
  const images = recorder();
  const calls: { method: string; url: string }[] = [];
  let jobs = 0;

  const impl = ((url: string | URL, init?: RequestInit) => {
    const href = String(url);
    const method = init?.method ?? "GET";

    calls.push({ method, url: href });

    if (href === "https://download/clip") {
      return Promise.resolve(new Response(clip, { status: 200 }));
    }

    if (href === "https://download/end") {
      return Promise.resolve(new Response(END_FRAME, { status: 200 }));
    }

    if (!href.includes("/contents/generations/tasks")) {
      return images.fetch(url, init);
    }

    if (method === "POST") {
      jobs += 1;

      return Promise.resolve(Response.json({ id: `cgt-${jobs}` }));
    }

    return Promise.resolve(
      Response.json({
        content: { last_frame_url: "https://download/end", video_url: "https://download/clip" },
        id: href.slice(href.lastIndexOf("/") + 1),
        status: "succeeded",
      })
    );
  }) as unknown as typeof fetch;

  return { calls, fetch: impl };
}

function generate(overrides: Partial<Parameters<typeof generateClips>[0]> = {}) {
  return generateClips({
    artifacts: [],
    episodeId: EPISODE,
    fetch: provider().fetch,
    imageKey: API_KEY,
    imageModel: "gpt-image-2.5-sunburst",
    mode: "apply",
    projectId: PROJECT,
    regenerate: false,
    track: "gpt-image",
    videoKey: VIDEO_KEY,
    videoModel: "dreamina-seedance-2-5-260628",
    wait: () => Promise.resolve(),
    workspace,
    ...overrides,
  });
}

function accept(artifacts: readonly string[]) {
  return approveClips({
    artifacts,
    episodeId: EPISODE,
    mode: "apply",
    note: "ok",
    projectId: PROJECT,
    reviewer: "tester",
    track: "gpt-image",
    workspace,
  });
}

function status() {
  return checkClips({ episodeId: EPISODE, projectId: PROJECT, track: "gpt-image", workspace });
}

async function stageFile(): Promise<Record<string, { review: { status: string } } | undefined>> {
  const path = join(
    root,
    "projects",
    PROJECT,
    "episodes",
    EPISODE,
    "gpt-image",
    "clips.stage.json"
  );
  const parsed = JSON.parse(await readFile(path, "utf8")) as {
    artifacts: Record<string, { review: { status: string } } | undefined>;
  };

  return parsed.artifacts;
}

function reason(result: { error?: Error; ok: boolean }): string {
  return result.ok ? "" : (result.error?.message ?? "");
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aimator-clips-"));
  root = join(scratch, "workspace");
  const resolved = resolveWorkspace(root);
  workspace = resolved.ok ? resolved.data : { root: "" };
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

describe("generateClips", () => {
  it("should refuse to buy anything until the opening frame is accepted here", async () => {
    await upstream();
    await makeOpeningFrame("gpt-image", false);

    const result = await generate();

    expect(result.ok ? result.data.paidVideos : null).toBe(0);
    expect(result.ok ? result.data.problems.join("\n") : reason(result)).toContain("opening-frame");
  });

  /**
   * The first clip starts on the opening frame and the second opens a new
   * scene, so both are runnable at once — one video and one image, from two
   * different providers, in one command.
   */
  it("should buy what the gates allow, in both media at once", async () => {
    await upstream();
    await makeOpeningFrame("gpt-image");

    const result = await generate();

    expect(result.ok ? result.data.paidVideos : reason(result)).toBe(1);
    expect(result.ok ? result.data.paidImages : null).toBe(1);
    expect(Object.keys(await stageFile())).toEqual(["C01", "entry:C02"]);
  });

  /** Rule 1: one `<stage>.stage.json`, whatever media the stage buys. */
  it("should keep clips and entry frames in one state file", async () => {
    await upstream();
    await makeOpeningFrame("gpt-image");
    await generate();

    const artifacts = await stageFile();

    expect(artifacts.C01?.review.status).toBe("pending");
    expect(artifacts["entry:C02"]?.review.status).toBe("pending");
  });

  it("should state what it would spend, per medium, and spend nothing", async () => {
    await upstream();
    await makeOpeningFrame("gpt-image");

    const api = provider();
    const result = await generate({
      fetch: api.fetch,
      imageKey: null,
      mode: "dry-run",
      videoKey: null,
    });

    expect(result.ok ? result.data.paidVideos : reason(result)).toBe(1);
    expect(result.ok ? result.data.paidImages : null).toBe(1);
    expect(api.calls).toHaveLength(0);
    expect(result.ok ? result.data.artifacts[0]?.prompt : null).toContain("OUTPUT CLIP");
  });

  /**
   * The chain: C03 continues C02, so its entry frame cannot be drawn until a
   * human has accepted the clip whose final frame it has to match.
   */
  it("should wait for the accepted end of the clip a later one continues", async () => {
    await upstream();
    await makeOpeningFrame("gpt-image");
    await generate();

    const waiting = await status();
    const entry = waiting.ok
      ? waiting.data.artifacts.find((one) => one.id === "entry:C03")
      : undefined;

    expect(entry?.state).toBe("absent");
    expect(entry?.note).toContain("C02");
  });

  it("should open the next link once the clip before it is accepted", async () => {
    await upstream();
    await makeOpeningFrame("gpt-image");
    await generate();
    await accept(["C01", "entry:C02"]);
    await generate();
    await accept(["C02"]);

    const result = await generate({ artifacts: ["entry:C03"] });

    expect(result.ok ? result.data.paidImages : reason(result)).toBe(1);
    expect(Object.keys(await stageFile())).toContain("entry:C03");
  });

  /**
   * The duration is a stored decision of the approved shot list, and the model
   * renders a narrower range than stage 3 allows. Refused before the POST, with
   * the remedy named, rather than rounded to something nobody planned.
   */
  it("should refuse a clip the video model cannot render, before spending", async () => {
    await upstream("unrenderable-clip");
    await makeOpeningFrame("gpt-image");

    const api = provider({ clip: SHORT_CLIP });
    const result = await generate({ fetch: api.fetch });

    expect(result.ok ? result.data.problems.join("\n") : reason(result)).toContain(
      "maxClipSeconds"
    );
    // No video job was ever started. The entry frame of a later clip is drawn,
    // because nothing about it is unrenderable — only C01's three seconds are.
    expect(
      api.calls.filter((call) => call.method === "POST" && call.url.includes("/tasks"))
    ).toHaveLength(0);
  });

  it("should require an explicit target for a new paid attempt", async () => {
    await upstream();
    await makeOpeningFrame("gpt-image");

    const result = await generate({ regenerate: true });

    expect(reason(result)).toContain("--artifact");
  });

  it("should refuse an artifact that belongs to another stage", async () => {
    await upstream();
    await makeOpeningFrame("gpt-image");

    expect(reason(await generate({ artifacts: ["R01"] }))).toContain("etapu 5");
  });
});

describe("approveClips", () => {
  it("should refuse to accept anything nobody named", async () => {
    await upstream();
    await makeOpeningFrame("gpt-image");
    await generate();

    expect(reason(await accept([]))).toContain("--artifact");
  });

  it("should record acceptance of a clip bound to the bytes on disk", async () => {
    await upstream();
    await makeOpeningFrame("gpt-image");
    await generate();

    const approved = await accept(["C01"]);

    expect(
      approved.ok ? approved.data.artifacts.find((one) => one.id === "C01")?.approved : null
    ).toBe(true);
    expect((await stageFile()).C01?.review.status).toBe("approved");
  });

  it("should not accept what has not been produced", async () => {
    await upstream();
    await makeOpeningFrame("gpt-image");

    expect(reason(await accept(["C01"]))).toContain("nie ma czego zatwierdzić");
  });
});

describe("checkClips", () => {
  it("should report every clip and entry frame this episode plans", async () => {
    await upstream();
    await makeOpeningFrame("gpt-image");

    const result = await status();

    expect(result.ok ? result.data.artifacts.map((one) => one.id) : reason(result)).toEqual([
      "C01",
      "entry:C02",
      "C02",
      "entry:C03",
      "C03",
    ]);
  });

  it("should write nothing", async () => {
    await upstream();
    await makeOpeningFrame("gpt-image");
    await status();

    await expect(stageFile()).rejects.toThrow();
  });
});
