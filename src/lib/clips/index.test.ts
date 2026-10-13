import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  API_KEY,
  EPISODE,
  makeUpstream,
  mp4,
  muxer,
  PROJECT,
  png,
  recorder,
  type ShotListShape,
} from "../../test/fixture.js";
import { approveOpeningFrame, generateOpeningFrame } from "../opening-frame/index.js";
import { approveReferences, generateReferences } from "../references/index.js";
import { err } from "../result.js";
import { type ImageTrack, resolveWorkspace, type Workspace } from "../workspace.js";
import { approveClips, checkClips, generateClips } from "./index.js";

/**
 * Stage 7 end to end, through the module entry.
 *
 * It is the first stage that buys two kinds of media, and the first whose gate
 * is a chain: an entry frame waits for the accepted end of the clip before it,
 * that clip waits for its own entry frame, and every link is a human saying yes.
 * Both facts are what these tests are about, everything else is borrowed from
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
/** How stage 7 names a prompt Kling will not take: the clip, then the count. */
const TOO_LONG = /C01: prompt klipu ma \d{4} znaków/;
/** A next step that names one clip and no checklist: nothing but C01 waits. */
const ONLY_CLIP_WAITS = /--artifact C01$/;

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

/** A manifest for however many clips the shot list plans. */
function answer(clipIds: readonly string[], action = "Akcja klipu"): string {
  return JSON.stringify({
    clips: clipIds.map((id) => ({
      id,
      prompt: `${action} ${id}.`,
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
        subject: "Living room, evening",
      },
    ],
    review: "Do rozstrzygnięcia: skala alpaki.",
  });
}

function upstream(shape: ShotListShape = "three-clips", action?: string): Promise<void> {
  const clipIds =
    shape === "unrenderable-clip" ? ["C01", "C02", "C03", "C04"] : ["C01", "C02", "C03"];

  return makeUpstream({
    answer: answer(clipIds, action),
    approvePackage: true,
    root,
    scratch,
    shotList: shape,
    workspace,
  });
}

/** Stage 5 and stage 6 on one track, both accepted, stage 7's starting point. */
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
      checks: "all",
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
  /** Every video job's body, as the provider received it. */
  readonly jobs: unknown[];
}

/** Where Kling answers, so this transport can answer in its envelope. */
const KLING_API = "https://api-singapore.klingai.com/";

/**
 * Both providers behind one transport: the image API stage 7 draws entry frames
 * with, and the video APIs it buys clips from, ModelArk and Kling, each in its
 * own envelope. One fake because one command uses both, and the count of each
 * is the assertion that matters most.
 */
function provider(options: { clip?: Buffer } = {}): Provider {
  const clip = options.clip ?? CLIP;
  const images = recorder();
  const calls: { method: string; url: string }[] = [];
  const jobs: unknown[] = [];

  const impl = ((url: string | URL, init?: RequestInit) => {
    const href = String(url);
    const method = init?.method ?? "GET";
    const kling = href.startsWith(KLING_API);

    calls.push({ method, url: href });

    if (href === "https://download/clip") {
      return Promise.resolve(new Response(clip, { status: 200 }));
    }

    if (href === "https://download/end") {
      return Promise.resolve(new Response(END_FRAME, { status: 200 }));
    }

    if (!(kling || href.includes("/contents/generations/tasks"))) {
      return images.fetch(url, init);
    }

    if (method === "POST") {
      jobs.push(JSON.parse(String(init?.body ?? "{}")));

      return Promise.resolve(
        Response.json(
          kling
            ? { code: 0, data: { id: `kt-${jobs.length}`, status: "submitted" } }
            : { id: `cgt-${jobs.length}` }
        )
      );
    }

    if (kling) {
      const task = new URL(href).searchParams.get("task_ids") ?? "";

      return Promise.resolve(
        Response.json({
          code: 0,
          data: [
            {
              id: task,
              outputs: [{ id: `vid-${task}`, type: "video", url: "https://download/clip" }],
              status: "succeeded",
            },
          ],
        })
      );
    }

    return Promise.resolve(
      Response.json({
        content: { last_frame_url: "https://download/end", video_url: "https://download/clip" },
        id: href.slice(href.lastIndexOf("/") + 1),
        status: "succeeded",
      })
    );
  }) as unknown as typeof fetch;

  return { calls, fetch: impl, jobs };
}

function generate(overrides: Partial<Parameters<typeof generateClips>[0]> = {}) {
  return generateClips({
    artifacts: [],
    episodeId: EPISODE,
    fetch: provider().fetch,
    imageKey: API_KEY,
    imageModel: "gpt-image-2.5-sunburst",
    mode: "apply",
    mux: muxer(),
    projectId: PROJECT,
    regenerate: false,
    republish: false,
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
    checks: "all",
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
   * scene, so both are runnable at once, one video and one image, from two
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

  it("should correct an entry frame under --instruction, the previous frame first", async () => {
    const note = "Ewa ma zostać w łóżku.";
    await upstream();
    await makeOpeningFrame("gpt-image");
    await generate();
    const named = { artifacts: ["entry:C02"], instruction: note, regenerate: true };
    const preview = await generate({ ...named, mode: "dry-run" });
    const result = await generate(named);
    const prompt = preview.ok ? (preview.data.artifacts[0]?.prompt ?? "") : "";
    const record = (await stageFile())["entry:C02"] as unknown as {
      readonly inputs: readonly { readonly path: string }[];
      readonly instruction: string;
      readonly runId: string;
    };

    expect(prompt).toContain("REFERENCE INPUTS, IN THIS ORDER\nImage 1 = previous:entry:C02 — ");
    expect(prompt).toContain(`----- BEGIN NOTE -----\n${note}\n----- END NOTE -----`);
    expect(preview.ok ? [preview.data.paidImages, preview.data.paidVideos] : null).toEqual([1, 0]);
    expect(result.ok ? result.data.paidImages : reason(result)).toBe(1);
    expect(record.instruction).toBe(note);
    expect(record.inputs.map((entry) => entry.path)).toContainEqual(
      expect.stringContaining(`/runs/${record.runId}/previous.png`)
    );
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
  /**
   * The next step is a command that works: with an entry frame among what
   * waits it carries the checklist, and with only a clip waiting it does not.
   */
  it("should carry --checks in the next step only while an entry frame waits", async () => {
    await upstream();
    await makeOpeningFrame("gpt-image");
    const bought = await generate();
    const both = await status();

    for (const step of [
      bought.ok ? bought.data.nextStep : reason(bought),
      both.ok ? both.data.nextStep : reason(both),
    ]) {
      expect(step).toContain(
        "--artifact C01,entry:C02 --checks anatomy,master,style,continuity,props"
      );
    }

    await accept(["entry:C02"]);
    const clip = await status();

    expect(clip.ok ? clip.data.nextStep : reason(clip)).toMatch(ONLY_CLIP_WAITS);
  });

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
    // because nothing about it is unrenderable, only C01's three seconds are.
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

/**
 * The second video model. The id picks the provider through a closed table in
 * `lib/video-model`, so what this stage owns is the refusals that come before
 * any money moves: a model nobody listed, a key that is missing, a prompt Kling
 * will not take, and an engine that is not there to cut the end frame.
 */
/**
 * An entry frame is a film frame and carries the series' style frames; a clip
 * is not drawn, it continues from a frame that already carried them.
 */
describe("style frames", () => {
  function styled(style: "undecided" | readonly Buffer[]): Promise<void> {
    return makeUpstream({
      answer: answer(["C01", "C02", "C03"]),
      approvePackage: true,
      root,
      scratch,
      shotList: "three-clips",
      style,
      workspace,
    });
  }

  it("should refuse to buy anything while nobody has decided the style frames", async () => {
    await styled("undecided");
    const api = provider();
    const result = await generate({ fetch: api.fetch });

    expect(api.calls).toHaveLength(0);
    expect(result.ok ? result.data.problems.join("\n") : reason(result)).toContain(
      `aimator project style ${PROJECT} --none`
    );
  });

  it("should show them on an entry frame in a dry run, and never on a clip", async () => {
    await styled([png(64, 64, 1)]);
    await makeOpeningFrame("gpt-image");
    const result = await generate({ artifacts: ["C01", "entry:C02"], mode: "dry-run" });
    const prompt = (id: string): string | null | undefined =>
      result.ok ? result.data.artifacts.find((one) => one.id === id)?.prompt : null;

    expect(prompt("entry:C02")).toContain("= style:S01 — style frame");
    expect(prompt("C01")).not.toContain("style:S01");
  });
});

describe("generateClips on Kling", () => {
  const KLING = "kling-3.0";

  function videoPosts(api: Provider): number {
    return api.calls.filter((call) => call.method === "POST" && !call.url.includes("openai"))
      .length;
  }

  it("should refuse a model outside the table before sending anything", async () => {
    await upstream();
    await makeOpeningFrame("gpt-image");

    const api = provider();
    const result = await generate({ artifacts: ["C01"], fetch: api.fetch, videoModel: "veo-9" });

    expect(reason(result)).toContain("dreamina-seedance-*");
    expect(reason(result)).toContain("kling-3.0");
    expect(api.calls).toHaveLength(0);
    expect(videoPosts(api)).toBe(0);
  });

  /** The key follows the provider the model names, and only a paid run reads it. */
  it("should demand KLING_API_KEY on the paid path, and nowhere else", async () => {
    await upstream();
    await makeOpeningFrame("gpt-image");

    const api = provider();
    const paid = await generate({
      artifacts: ["C01"],
      fetch: api.fetch,
      videoKey: null,
      videoModel: KLING,
    });

    expect(reason(paid)).toContain("KLING_API_KEY");
    expect(api.calls).toHaveLength(0);

    const preview = await generate({
      artifacts: ["C01"],
      fetch: api.fetch,
      mode: "dry-run",
      videoKey: null,
      videoModel: KLING,
    });

    expect(preview.ok ? preview.data.paidVideos : reason(preview)).toBe(1);
    expect(preview.ok ? preview.data.problems.join("\n") : "").not.toContain("KLING_API_KEY");
    expect(preview.ok ? preview.data.artifacts[0]?.prompt : null).toContain("OUTPUT CLIP");
    expect(api.calls).toHaveLength(0);
  });

  /**
   * Kling refuses a prompt over 3072 characters, and the prompt is composed
   * here, out of stage 4's direction and the shot list's own words, so this is
   * where its length is known. Refused before the POST, with the number.
   */
  it("should refuse a composed prompt Kling will not take, before sending it", async () => {
    await upstream("three-clips", "Ewa idzie przez salon. ".repeat(140));
    await makeOpeningFrame("gpt-image");

    const api = provider();
    const result = await generate({ artifacts: ["C01"], fetch: api.fetch, videoModel: KLING });
    const said = result.ok ? result.data.problems.join("\n") : reason(result);

    expect(said).toContain("3072");
    expect(said).toMatch(TOO_LONG);
    expect(api.calls).toHaveLength(0);
  });

  /**
   * Kling's clip comes back without its last frame, so the frame is cut out
   * here, and a paid clip whose frame cannot be cut is a chain with a missing
   * link. Stage 8's precedent: no engine is a refusal before anything is spent.
   */
  it("should refuse to render on Kling without ffmpeg, before sending anything", async () => {
    await upstream();
    await makeOpeningFrame("gpt-image");

    const api = provider();
    const absent = {
      ...muxer(),
      version: () => Promise.resolve(err(new Error("nie znaleziono ffmpeg (AIMATOR_FFMPEG)"))),
    };
    const result = await generate({
      artifacts: ["C01"],
      fetch: api.fetch,
      mux: absent,
      videoModel: KLING,
    });

    expect(reason(result)).toContain("ffmpeg");
    expect(api.calls).toHaveLength(0);

    const seedance = await generate({ artifacts: ["C01"], mux: absent });

    expect(seedance.ok ? seedance.data.paidVideos : reason(seedance)).toBe(1);
  });

  /**
   * Re-rendering a track clip by clip with another model is legal, so it is
   * not refused; but stage 8 will refuse the track until every clip is on one
   * model, and a person should know that before paying, not after.
   */
  it("should warn, not refuse, when the track's accepted clips came from another model", async () => {
    await upstream();
    await makeOpeningFrame("gpt-image");
    await generate();
    await accept(["C01", "entry:C02"]);

    const preview = await generate({
      artifacts: ["C02"],
      imageKey: null,
      mode: "dry-run",
      videoKey: null,
      videoModel: KLING,
    });

    expect(preview.ok ? preview.data.notices.join("\n") : reason(preview)).toContain(
      "C01 (dreamina-seedance-2-5-260628)"
    );
    expect(preview.ok ? preview.data.paidVideos : null).toBe(1);
    expect(preview.ok ? preview.data.problems.join("\n") : "").not.toContain("C01 (");

    const same = await generate({
      artifacts: ["C02"],
      imageKey: null,
      mode: "dry-run",
      videoKey: null,
    });

    expect(same.ok ? same.data.notices : null).toEqual([]);
  });

  /** Seedance takes the same prompt: the limit is Kling's, not this stage's. */
  it("should send the same long prompt to Seedance", async () => {
    await upstream("three-clips", "Ewa idzie przez salon. ".repeat(140));
    await makeOpeningFrame("gpt-image");

    const result = await generate({ artifacts: ["C01"] });

    expect(result.ok ? result.data.paidVideos : reason(result)).toBe(1);
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

  /**
   * A blocker refuses the **stage** only when the stage has nothing left to buy.
   *
   * The gate here is a chain, so a later clip is almost always waiting for an
   * earlier one, and listing every link would call a track refused while
   * `clip generate` would buy something on it this second. What is a refusal is
   * a track with nothing buyable at all, which is what an untouched track is:
   * no references and no opening frame, so not one of the five has an input.
   * The ladder then reads "zablokowany" rather than "gotowy do generowania",
   * and says what it waits for.
   */
  it("should report a track with nothing buyable as a refusal of the stage", async () => {
    await upstream();
    await makeOpeningFrame("gpt-image");

    const result = await checkClips({
      episodeId: EPISODE,
      projectId: PROJECT,
      track: "seedream",
      workspace,
    });

    expect(result.ok ? result.data.problems.join("\n") : reason(result)).toContain(
      "klatka otwarcia nie powstała na torze seedream"
    );
  });

  /**
   * The other half of the same rule, and the one that makes it worth having:
   * an opening frame nobody has accepted blocks C01 and nothing else, because
   * the entry frame of C02 needs no clip to exist first. A track one command
   * away from spending money is not a refused track.
   */
  it("should not call a track refused while it still has something to buy", async () => {
    await upstream();
    await makeOpeningFrame("gpt-image", false);

    const result = await status();

    expect(result.ok ? result.data.problems : reason(result)).toEqual([]);
  });

  it("should write nothing", async () => {
    await upstream();
    await makeOpeningFrame("gpt-image");
    await status();

    await expect(stageFile()).rejects.toThrow();
  });
});

describe("--republish", () => {
  it("should refuse to republish without naming a clip", async () => {
    await upstream();
    await makeOpeningFrame("gpt-image");

    expect(reason(await generate({ republish: true }))).toContain("--artifact");
  });

  it("should refuse to republish and regenerate at once", async () => {
    await upstream();

    expect(
      reason(await generate({ artifacts: ["C01"], regenerate: true, republish: true }))
    ).toContain("wykluczają się");
  });

  /**
   * An entry frame is published exactly as the image model drew it, so there is
   * no renderer there whose mistake would need undoing, and saying so is more
   * useful than quietly doing nothing.
   */
  it("should refuse to republish an entry frame", async () => {
    await upstream();

    expect(reason(await generate({ artifacts: ["entry:C02"], republish: true }))).toContain(
      "wyłącznie klipów"
    );
  });

  it("should republish a finished clip without buying anything", async () => {
    await upstream();
    await makeOpeningFrame("gpt-image");

    const api = provider();
    await generate({ fetch: api.fetch });
    const before = api.calls.length;
    const again = await generate({ artifacts: ["C01"], fetch: api.fetch, republish: true });

    expect(again.ok ? again.data.paidVideos : reason(again)).toBe(0);
    expect(api.calls).toHaveLength(before);
    expect((await stageFile()).C01?.review.status).toBe("pending");
  });
});

/**
 * `--regenerate --artifact Cnn --instruction`: no provider edits a finished
 * video, so a note on a clip buys a new one, from the same entry frame, with
 * the note quoted in the clip's prompt.
 *
 * Assumptions this block encodes: the clip's attachment list is unchanged, one
 * image, the frame it starts on; the note travels verbatim between markers;
 * the report says plainly that this is a full new charge; both video models
 * take it the same way, each in its own wire.
 */
describe("generateClips --instruction on a clip", () => {
  const NOTE = "Wanda ma zostać w łóżku.";

  /** The first frame a job carried, in whichever wire it was sent. */
  function frameOf(job: unknown): string | undefined {
    const body = job as {
      content?: readonly { image_url?: { url: string }; type: string }[];
      contents?: readonly { type: string; url?: string }[];
    };

    return (
      body.content?.find((part) => part.type === "image_url")?.image_url?.url ??
      body.contents?.find((part) => part.type === "first_frame")?.url
    );
  }

  /** The prompt a job carried, in whichever wire it was sent. */
  function promptOf(job: unknown): string {
    const body = job as {
      content?: readonly { text?: string }[];
      contents?: readonly { text?: string }[];
    };

    return (body.content ?? body.contents ?? []).map((part) => part.text ?? "").join("");
  }

  it.each([["dreamina-seedance-2-5-260628"], ["kling-3.0"]])(
    "should render %s anew from the same entry frame, the note quoted",
    async (videoModel) => {
      await upstream();
      await makeOpeningFrame("gpt-image");
      const first = provider();
      await generate({ artifacts: ["C01"], fetch: first.fetch, videoModel });
      const named = { artifacts: ["C01"], instruction: NOTE, regenerate: true, videoModel };
      const preview = await generate({ ...named, imageKey: null, mode: "dry-run", videoKey: null });
      const again = provider();
      const result = await generate({ ...named, fetch: again.fetch });
      const clip = preview.ok ? preview.data.artifacts[0] : undefined;
      const record = (await stageFile()).C01 as unknown as { readonly instruction: string };

      expect(clip?.prompt).toContain(`----- BEGIN NOTE -----\n${NOTE}\n----- END NOTE -----`);
      expect(clip?.prompt).toContain("FIRST FRAME, THIS CLIP BEGINS HERE\nImage 1 = opening-frame");
      expect(preview.ok ? [preview.data.paidVideos, preview.data.paidImages] : null).toEqual([
        1, 0,
      ]);
      expect(clip?.note).toContain("pełna nowa opłata");
      expect(result.ok ? result.data.paidVideos : reason(result)).toBe(1);
      expect(again.jobs).toHaveLength(1);
      expect(frameOf(again.jobs[0])).toBe(frameOf(first.jobs[0]));
      expect(promptOf(again.jobs[0])).toContain(`----- BEGIN NOTE -----\n${NOTE}\n`);
      expect(record.instruction).toBe(NOTE);
    }
  );
});
