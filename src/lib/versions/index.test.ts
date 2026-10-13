import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EPISODE,
  makeDialogue,
  makeTrack,
  makeUpstream,
  mp4,
  PROJECT,
  png,
  VOICE,
} from "../../test/fixture.js";
import { sha256Of } from "../artifact/index.js";
import { setLipSync } from "../project/index.js";
import { resolveWorkspace, type Workspace } from "../workspace.js";
import { approveVersions, bindFaces, checkVersions, findFaces, generateLipSync } from "./index.js";

/**
 * Stage 12, language versions: faces, who they are, and lip-sync per clip,
 * through the module entry.
 *
 * Assumptions this file encodes, stated before its first test:
 *
 * - **The stage answers one episode decision first.** Without `lip-sync.json`
 *   naming a language every command refuses, and the refusal is the command
 *   that records the decision. A dialogue-and-narration episode is refused too:
 *   an English narrator is out of scope, so its English version cannot exist.
 * - **Which clips is derived, never stored**: a clip is lip-synced when an
 *   English line of the accepted translation is spoken in it by a character
 *   the shot shows. A line from off screen is reported, not refused, and a clip
 *   with nobody visible speaking passes to the version untouched.
 * - **Face to character is a person's decision**, stored per clip in
 *   `binding.json`, even with a single face (rule 7); the faces it binds are
 *   the ones the paid face call found, as recorded in `faces.json`.
 * - **One face per job.** A clip where two characters speak on screen is two
 *   jobs, and the second runs on the first one's result, addressed by Kling's
 *   `video_id` through a fresh face call, under the same `face_id` the person
 *   bound.
 * - **Only the network is faked**: Kling and the private bucket answer the way
 *   their documentation says, and every earlier stage is run for real.
 */

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

/** The manifest the fixture deliberately does not own: a prompt per clip, one reference. */
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
        subject: "Living room, evening",
      },
    ],
    review: "Do rozstrzygnięcia: skala alpaki.",
  });
}

/**
 * An episode whose cast speaks, its clips rendered and accepted on one track;
 * with `narrated`, a narrator speaks beside the cast.
 */
async function episode(
  options: {
    readonly duet?: boolean;
    readonly narrated?: boolean;
    readonly shape?: "three-clips" | "two-clips";
  } = {}
): Promise<void> {
  const { shape = "two-clips" } = options;

  await makeUpstream({
    answer: answer(shape === "two-clips" ? ["C01", "C02"] : ["C01", "C02", "C03"]),
    approvePackage: true,
    dialogue: true,
    duet: options.duet ?? false,
    narration: options.narrated ?? false,
    root,
    scratch,
    shotList: shape,
    voiceId: VOICE,
    workspace,
  });
  await makeTrack({ root, track: "gpt-image", workspace });
}

/** The episode's answer to which language the mouths move in. */
function lipSync(language: string) {
  return setLipSync({
    choice: language === "none" ? { kind: "none" } : { kind: "language", language },
    episodeId: EPISODE,
    mode: "apply",
    projectId: PROJECT,
    workspace,
  });
}

const HOSTING = {
  AIMATOR_LIPSYNC_BUCKET: "aimator-lipsync",
  R2_ACCESS_KEY_ID: "access-id",
  R2_ACCOUNT_ID: "acc123",
  R2_SECRET_ACCESS_KEY: "secret",
};

const IDENTIFY = "/v1/videos/identify-face";
const LIP_SYNC = "/v1/videos/advanced-lip-sync";
/** The picture Kling hands back for every face it finds. */
const FACE = png(256, 256, 7);
/** What every lip-sync job hands back: the clip's own frame and length, mouths moved. */
const SYNCED = mp4({ height: 1080, seconds: 15, width: 1920 });

interface Sent {
  readonly body: unknown;
  readonly method: string;
  readonly url: URL;
}

interface Network {
  readonly fetch: typeof fetch;
  readonly sent: Sent[];
}

/**
 * Kling and the private bucket, answering the way their documentation says.
 * Every face call opens a new session, `session-1` first, and finds the same
 * two faces on screen for the whole clip.
 */
function kling(): Network {
  const sent: Sent[] = [];
  let sessions = 0;
  let jobs = 0;

  const impl = ((url: string | URL, init?: RequestInit) => {
    const href = new URL(String(url));
    const method = init?.method ?? "GET";

    sent.push({
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      method,
      url: href,
    });

    if (href.hostname.endsWith("r2.cloudflarestorage.com")) {
      return Promise.resolve(new Response(null, { status: method === "DELETE" ? 204 : 200 }));
    }

    if (href.hostname === "faces") {
      return Promise.resolve(new Response(FACE, { status: 200 }));
    }

    if (href.pathname === IDENTIFY) {
      sessions += 1;

      return Promise.resolve(
        Response.json({
          code: 0,
          data: {
            face_data: ["0", "1"].map((id) => ({
              end_time: 15_000,
              face_id: id,
              face_image: `https://faces/${sessions}/${id}.png`,
              start_time: 0,
            })),
            session_id: `session-${sessions}`,
          },
          message: "SUCCEED",
        })
      );
    }

    if (href.pathname === LIP_SYNC && method === "POST") {
      jobs += 1;

      return Promise.resolve(
        Response.json({ code: 0, data: { task_id: `ls-${jobs}`, task_status: "submitted" } })
      );
    }

    if (href.pathname.startsWith(`${LIP_SYNC}/`)) {
      const task = href.pathname.slice(LIP_SYNC.length + 1);

      return Promise.resolve(
        Response.json({
          code: 0,
          data: {
            task_id: task,
            task_result: {
              videos: [{ duration: "15", id: `v${task}`, url: `https://download/${task}` }],
            },
            task_status: "succeed",
          },
        })
      );
    }

    if (href.hostname === "download") {
      return Promise.resolve(new Response(SYNCED, { status: 200 }));
    }

    return Promise.reject(new Error(`nieoczekiwane wywołanie ${method} ${href.href}`));
  }) as unknown as typeof fetch;

  return { fetch: impl, sent };
}

/** This episode's track directory, where stage 12 writes. */
function trackRoot(): string {
  return join(root, "projects", PROJECT, "episodes", EPISODE, "gpt-image");
}

/** A network nobody may reach: any call fails the test that made it. */
const silent = (() => {
  throw new Error("nic nie miało zostać wysłane");
}) as unknown as typeof fetch;

const scope = () =>
  ({ episodeId: EPISODE, projectId: PROJECT, track: "gpt-image", workspace }) as const;

/** A paid command's scope, on a network nobody may reach. */
const paid = () =>
  ({
    ...scope(),
    apiKey: "kling-key",
    fetch: silent,
    hosting: HOSTING,
    mode: "apply",
    regenerate: false,
  }) as const;

function reason(result: { error?: Error; ok: boolean }): string {
  return result.ok ? "" : (result.error?.message ?? "");
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aimator-stage12-"));
  root = join(scratch, "workspace");
  const resolved = resolveWorkspace(root);
  workspace = resolved.ok ? resolved.data : { root: "" };
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

describe("stage 12 gate", { timeout: 45_000 }, () => {
  it("should refuse every command until the episode decides the language of the mouths", async () => {
    await episode();
    const decide = `aimator episode lip-sync ${PROJECT} ${EPISODE} --language`;

    const faces = await findFaces({ ...paid(), artifact: "C01" });
    const bound = await bindFaces({
      ...scope(),
      artifact: "C01",
      faces: { 0: "ewa" },
      mode: "apply",
    });
    const synced = await generateLipSync({ ...paid(), artifacts: [] });

    expect(reason(faces)).toContain(decide);
    expect(reason(bound)).toContain(decide);
    expect(reason(synced)).toContain(decide);
  });

  it("should refuse an episode that decided no second version", async () => {
    await episode();
    await lipSync("none");
    const result = await findFaces({ ...paid(), artifact: "C01" });

    expect(reason(result)).toContain("lip-sync.json: none");
  });

  /** Narration in English is out of scope, so such an episode has no English version. */
  it("should refuse an episode whose narrator speaks beside the cast", async () => {
    await episode({ narrated: true });
    await lipSync("en");
    const result = await generateLipSync({ ...paid(), artifacts: [] });

    expect(reason(result)).toContain("dialogue-and-narration");
  });
});

describe("which clips", { timeout: 45_000 }, () => {
  /**
   * The three-clip cut: Ewa speaks on screen in C01, nobody speaks in C02, and
   * in C03 Ewa is heard while only Tata is shown, so her line is reported and
   * C03 passes to the version as it is.
   */
  it("should lip-sync exactly the clips where a character speaks on screen", async () => {
    await episode({ shape: "three-clips" });
    await makeDialogue({ workspace });
    const status = await checkVersions(scope());

    expect(
      status.ok ? status.data.clips.map(({ id, speakers }) => ({ id, speakers })) : reason(status)
    ).toEqual([{ id: "C01", speakers: ["ewa"] }]);
    expect(status.ok ? status.data.untouched : null).toEqual(["C02", "C03"]);
    expect(status.ok ? status.data.notices.join("\n") : null).toContain("en:D02");
  });
});

describe("versions faces", { timeout: 45_000 }, () => {
  it("should find the faces in one clip for one paid call, and keep each face's picture", async () => {
    await episode();
    await makeDialogue({ workspace });
    const api = kling();
    const result = await findFaces({ ...paid(), artifact: "C01", fetch: api.fetch });
    const dir = join(trackRoot(), "versions", "faces", "C01");
    const saved = JSON.parse(await readFile(join(dir, "faces.json"), "utf8")) as unknown;

    expect(result.ok ? result.data.paidCalls : reason(result)).toBe(1);
    expect(api.sent.filter((one) => one.url.pathname === IDENTIFY)).toHaveLength(1);
    expect(saved).toMatchObject({
      faces: [
        { end: 15_000, id: "0", start: 0 },
        { end: 15_000, id: "1", start: 0 },
      ],
      sessionId: "session-1",
    });
    expect((await readFile(join(dir, "0.png"))).equals(FACE)).toBe(true);
    expect((await readFile(join(dir, "1.png"))).equals(FACE)).toBe(true);
  });

  /** Nothing is billed twice: faces found are bought again only on request. */
  it("should refuse to find a clip's faces a second time without --regenerate", async () => {
    await episode();
    await makeDialogue({ workspace });
    await findFaces({ ...paid(), artifact: "C01", fetch: kling().fetch });
    const again = await findFaces({ ...paid(), artifact: "C01" });

    expect(reason(again)).toContain("--regenerate");
  });
});

describe("versions bind", { timeout: 45_000 }, () => {
  /** An episode whose English lines are accepted and whose C01 faces were found. */
  async function found(): Promise<void> {
    await episode();
    await makeDialogue({ workspace });
    await findFaces({ ...paid(), artifact: "C01", fetch: kling().fetch });
  }

  function bind(faces: Readonly<Record<string, string>>) {
    return bindFaces({ ...scope(), artifact: "C01", faces, mode: "apply" });
  }

  it("should refuse a character the cast does not have", async () => {
    await found();
    const result = await bind({ 0: "zosia" });

    expect(reason(result)).toContain('"zosia"');
  });

  it("should refuse a face the face call did not find", async () => {
    await found();
    const result = await bind({ 7: "ewa" });

    expect(reason(result)).toContain("twarzy 7");
  });

  it("should write the person's word on who each face is, bound to the faces it names", async () => {
    await found();
    const result = await bind({ 0: "ewa" });
    const dir = join(trackRoot(), "versions", "faces", "C01");
    const binding = JSON.parse(await readFile(join(dir, "binding.json"), "utf8")) as unknown;
    const faces = await readFile(join(dir, "faces.json"));

    expect(result.ok ? result.data.faces : reason(result)).toEqual({ 0: "ewa" });
    expect(binding).toEqual({
      faces: { 0: "ewa" },
      found: {
        path: `projects/${PROJECT}/episodes/${EPISODE}/gpt-image/versions/faces/C01/faces.json`,
        sha256: sha256Of(faces),
      },
    });
  });
});

describe("versions lip-sync preview", { timeout: 45_000 }, () => {
  /** English lines accepted, faces found in both clips, and nothing bound yet. */
  async function found(): Promise<void> {
    await episode();
    await makeDialogue({ workspace });
    await findFaces({ ...paid(), artifact: "C01", fetch: kling().fetch });
    await findFaces({ ...paid(), artifact: "C02", fetch: kling().fetch });
  }

  function preview(artifacts: readonly string[] = []) {
    return generateLipSync({ ...paid(), artifacts, mode: "dry-run" });
  }

  it("should name the missing binding as the obstacle, and bill nothing", async () => {
    await found();
    const result = await preview(["C01"]);

    expect(result.ok ? result.data.problems.join("\n") : reason(result)).toContain(
      "aimator versions bind"
    );
    expect(result.ok ? [result.data.paidFaces, result.data.paidLipSyncs] : null).toEqual([0, 0]);
  });

  /**
   * Ewa's line sits a second into C01, Tata's six seconds into C02 (21s of the
   * plan, in the clip that starts at 15s). Each line is a second long and the
   * provider takes no sound shorter than two, so each window is padded to two.
   */
  it("should list one job per speaker with its window in ms, once every speaker is bound", async () => {
    await found();
    await bindFaces({ ...scope(), artifact: "C01", faces: { 0: "ewa" }, mode: "apply" });
    await bindFaces({ ...scope(), artifact: "C02", faces: { 1: "tata" }, mode: "apply" });
    const result = await preview();

    expect(
      result.ok
        ? result.data.clips.map((clip) => ({ id: clip.id, jobs: clip.jobs }))
        : reason(result)
    ).toEqual([
      {
        id: "C01",
        jobs: [
          {
            cast: "ewa",
            end: 3000,
            face: "0",
            key: "C01",
            lines: ["en:D01"],
            start: 1000,
            state: "planned",
          },
        ],
      },
      {
        id: "C02",
        jobs: [
          {
            cast: "tata",
            end: 8000,
            face: "1",
            key: "C02",
            lines: ["en:D03"],
            start: 6000,
            state: "planned",
          },
        ],
      },
    ]);
    expect(result.ok ? [result.data.paidFaces, result.data.paidLipSyncs] : null).toEqual([0, 2]);
    expect(result.ok ? result.data.problems : null).toEqual([]);
  });
});

describe("versions lip-sync", { timeout: 45_000 }, () => {
  function posts(api: Network): Sent[] {
    return api.sent.filter((one) => one.url.pathname === LIP_SYNC && one.method === "POST");
  }

  function faceCalls(api: Network): Sent[] {
    return api.sent.filter((one) => one.url.pathname === IDENTIFY);
  }

  /**
   * C01 in the duet cut: Ewa speaks in U01 and Tata answers in U02. The first
   * job moves Ewa's face on the accepted clip, in the session `versions faces`
   * opened; the second finds the faces again in that job's result, addressed
   * by its `video_id`, and moves Tata's in the new session, under the face id
   * the person bound him to.
   */
  it("should run a second job for a second speaker, on the first one's result by its video_id", async () => {
    await episode({ duet: true });
    await makeDialogue({ workspace });
    const api = kling();
    await findFaces({ ...paid(), artifact: "C01", fetch: api.fetch });
    await bindFaces({ ...scope(), artifact: "C01", faces: { 0: "ewa", 1: "tata" }, mode: "apply" });
    const result = await generateLipSync({ ...paid(), artifacts: ["C01"], fetch: api.fetch });
    const sessions = posts(api).map((one) => {
      const body = one.body as { face_choose: { face_id: string }[]; session_id: string };

      return { face: body.face_choose[0]?.face_id, session: body.session_id };
    });

    expect(result.ok ? [result.data.paidFaces, result.data.paidLipSyncs] : reason(result)).toEqual([
      1, 2,
    ]);
    expect(sessions).toEqual([
      { face: "0", session: "session-1" },
      { face: "1", session: "session-2" },
    ]);
    expect(faceCalls(api).map((one) => one.body)).toEqual([
      expect.objectContaining({ video_url: expect.any(String) }),
      { video_id: "vls-1" },
    ]);
    expect((await readFile(join(trackRoot(), "versions", "clips", "C01.mp4"))).equals(SYNCED)).toBe(
      true
    );
  });
});

describe("approveVersions", { timeout: 45_000 }, () => {
  /** C02 of the plain cut, Tata alone on screen speaking, lip-synced. */
  async function synced(): Promise<void> {
    await episode();
    await makeDialogue({ workspace });
    const api = kling();
    await findFaces({ ...paid(), artifact: "C02", fetch: api.fetch });
    await bindFaces({ ...scope(), artifact: "C02", faces: { 1: "tata" }, mode: "apply" });
    await generateLipSync({ ...paid(), artifacts: ["C02"], fetch: api.fetch });
  }

  function approve(artifacts: readonly string[]) {
    return approveVersions({
      ...scope(),
      artifacts,
      mode: "apply",
      note: "usta trafiają",
      reviewer: "test",
    });
  }

  it("should accept a lip-synced clip a person watched, and that clip only", async () => {
    await synced();
    const before = await checkVersions(scope());
    const result = await approve(["C02"]);
    const states = (status: typeof result) =>
      status.ok
        ? status.data.clips.map(({ approved, id, state }) => ({ approved, id, state }))
        : reason(status);

    expect(states(before)).toEqual([
      { approved: false, id: "C01", state: "absent" },
      { approved: false, id: "C02", state: "completed" },
    ]);
    expect(states(result)).toEqual([
      { approved: false, id: "C01", state: "absent" },
      { approved: true, id: "C02", state: "completed" },
    ]);
  });

  it("should refuse to accept a clip nobody lip-synced", async () => {
    await synced();
    const result = await approve(["C01"]);

    expect(reason(result)).toContain("nie ma czego zatwierdzić: C01");
  });

  /** The binding is an input of the version: a face bound to someone else is another film. */
  it("should lapse the yes when the binding the version was made from changes", async () => {
    await synced();
    await approve(["C02"]);
    await bindFaces({ ...scope(), artifact: "C02", faces: { 0: "tata" }, mode: "apply" });
    const status = await checkVersions(scope());
    const c02 = status.ok ? status.data.clips.find((one) => one.id === "C02") : undefined;

    expect(c02).toMatchObject({
      approved: false,
      inputsChanged: [
        `projects/${PROJECT}/episodes/${EPISODE}/gpt-image/versions/faces/C02/binding.json`,
      ],
    });
  });
});

describe("the gate per clip", { timeout: 45_000 }, () => {
  /** A line nobody accepted holds back its own clip, and no other. */
  it("should hold back only the clip whose English line is not accepted", async () => {
    await episode();
    await makeDialogue({ pending: ["en:D01"], workspace });
    for (const [clip, faces] of [
      ["C01", { 0: "ewa" }],
      ["C02", { 1: "tata" }],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: one clip's faces at a time, as a person would
      await findFaces({ ...paid(), artifact: clip, fetch: kling().fetch });
      await bindFaces({ ...scope(), artifact: clip, faces, mode: "apply" });
    }

    const result = await generateLipSync({ ...paid(), artifacts: [], mode: "dry-run" });

    expect(result.ok ? result.data.problems : reason(result)).toEqual([
      expect.stringContaining("en:D01"),
    ]);
    expect(result.ok ? result.data.paidLipSyncs : null).toBe(1);
  });

  /**
   * A track where no clip can move is refused, as stage 7 refuses a chain with
   * nothing to buy: the other track has no accepted clip, so a face call and a
   * job both say no there, and a check that put that in a note alone would let
   * `status` call the track ready. A track with one clip that can move is not.
   */
  it("should refuse a track whose every clip waits for stage 7, and only that track", async () => {
    await episode();
    await makeDialogue({ workspace });
    const stalled = await checkVersions({ ...scope(), track: "seedream" });
    const moving = await checkVersions(scope());

    expect(stalled.ok ? stalled.data.problems.join("\n") : reason(stalled)).toContain(
      "klip nie ma ważnej zgody na torze seedream"
    );
    expect(moving.ok ? moving.data.problems : reason(moving)).toEqual([]);
  });

  /**
   * A face call needs no line, so a clip whose line waits can still move until
   * its faces are found and bound; only then is the job the one step left, and
   * the job refuses an unaccepted line.
   */
  it("should refuse a track once every clip's one step left waits for a line", async () => {
    await episode();
    await makeDialogue({ pending: ["en:D01", "en:D02", "en:D03"], workspace });
    const before = await checkVersions(scope());
    for (const [clip, faces] of [
      ["C01", { 0: "ewa" }],
      ["C02", { 1: "tata" }],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: one clip's faces at a time, as a person would
      await findFaces({ ...paid(), artifact: clip, fetch: kling().fetch });
      await bindFaces({ ...scope(), artifact: clip, faces, mode: "apply" });
    }

    const after = await checkVersions(scope());

    expect(before.ok ? before.data.problems : reason(before)).toEqual([]);
    expect(after.ok ? after.data.problems.join("\n") : reason(after)).toContain(
      "kwestia nie ma ważnej zgody"
    );
  });
});
