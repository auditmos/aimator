import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { imageTracks, resolveWorkspace, type Workspace } from "../lib/workspace.js";
import { EPISODE, makeTrack, makeUpstream, PROJECT, png } from "../test/fixture.js";
import { type Encoder, freezeRelease } from "./episode.js";

/**
 * Freezing, through the module entry.
 *
 * The workspace it reads is built by the shared fixture through each stage's
 * own entry, because what is under test is the crossing, which files a release
 * takes out of a finished episode, what it measures, and what it refuses.
 * The engine is injected for the reason `makeCut` brings its own muxer: the
 * fixture's pictures are structurally valid rather than decodable, and ffmpeg
 * is exercised where it is the thing under test, not here.
 */

const VERSION = "0.2.0";
/** What the manifest names, and therefore what stage 5 draws on each track. */
const REFERENCES = ["R01", "R02"];

let root = "";
let repository = "";
let scratch = "";
let workspace: Workspace = { root: "" };

function answer(): string {
  return JSON.stringify({
    clips: [
      {
        id: "C01",
        prompt: "Salon wieczorem.",
        referenceIds: ["hero:ewa", "hero:tata", "R01"],
      },
      {
        id: "C02",
        prompt: "Oboje na dywanie.",
        referenceIds: ["hero:ewa", "hero:tata", "R01", "R02"],
      },
    ],
    entryFrames: [{ clipId: "C02", prompt: "Dokładnie końcowe położenie z C01." }],
    opening: { prompt: "Ewa centralnie.", referenceIds: ["hero:ewa", "R01"] },
    references: [
      {
        dependsOn: ["hero:ewa"],
        id: "R01",
        kind: "location",
        prompt: "Salon z niską kanapą.",
        subject: "Living room, evening",
      },
      {
        dependsOn: ["hero:ewa"],
        id: "R02",
        kind: "prop",
        prompt: "Alpaka bez wgnieceń.",
        subject: "Alpaca toy, uncompressed",
      },
    ],
    review: "Do rozstrzygnięcia: skala alpaki.",
  });
}

/** An engine that writes a stand-in file and reports one fixed measurement. */
function engine(): Encoder & { readonly made: { from: string; op: string }[] } {
  const made: { from: string; op: string }[] = [];
  const write = async (op: string, from: string, to: string) => {
    made.push({ from, op });
    await writeFile(to, `${op} of ${from}`);
  };
  return {
    made,
    poster: (from, to) => write("poster", from, to),
    probe: () => Promise.resolve({ height: 1080, seconds: 90.5, width: 1920 }),
    still: (from, to) => write("still", from, to),
    video: (from, to) => write("video", from, to),
  };
}

/** Stage 10's output and stage 2's card: the two files freeze reads directly. */
async function finishTrack(track: string): Promise<void> {
  const cut = join(root, "projects", PROJECT, "episodes", EPISODE, track);
  await mkdir(cut, { recursive: true });
  await writeFile(join(cut, "mixed.mp4"), `mixed ${track}`);
  for (const character of ["ewa", "tata"]) {
    const directory = join(root, "projects", PROJECT, "characters", character, track);
    // biome-ignore lint/performance/noAwaitInLoops: two cards, written in cast order
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "card.png"), png(1920, 1920));
  }
}

async function episode(): Promise<void> {
  await makeUpstream({ answer: answer(), approvePackage: true, root, scratch, workspace });
  for (const track of imageTracks) {
    // biome-ignore lint/performance/noAwaitInLoops: one track built at a time
    await makeTrack({ root, track, workspace });
    await finishTrack(track);
  }
}

const freeze = (engineUsed: Encoder, version = VERSION) =>
  freezeRelease(
    { episodeId: EPISODE, projectId: PROJECT, root: repository, version, workspace },
    engineUsed
  );

const registry = async (version = VERSION) =>
  JSON.parse(await readFile(join(repository, "site", "releases", `${version}.json`), "utf8"));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aimator-freeze-ws-"));
  repository = await mkdtemp(join(tmpdir(), "aimator-freeze-repo-"));
  scratch = await mkdtemp(join(tmpdir(), "aimator-freeze-in-"));
  await mkdir(join(repository, "site", "releases"), { recursive: true });
  const resolved = resolveWorkspace(root);
  workspace = resolved.ok ? resolved.data : { root: "" };
});

afterEach(async () => {
  for (const directory of [root, repository, scratch]) {
    // biome-ignore lint/performance/noAwaitInLoops: three temporary trees, removed in order
    await rm(directory, { force: true, recursive: true });
  }
});

describe("freezeRelease", () => {
  it("should take one film, its stills and its documents out of each track", async () => {
    await episode();

    const result = await freeze(engine());

    expect(result.ok ? "" : result.error.message).toBe("");
    const files = result.ok ? result.data.files : [];
    for (const track of imageTracks) {
      expect(files).toContain(`out/releases/${VERSION}/${track}-mixed.mp4`);
      expect(files).toContain(`out/releases/${VERSION}/${track}-opening-frame.jpg`);
      expect(files).toContain(`out/releases/${VERSION}/${track}-ewa.jpg`);
      expect(files).toContain(`site/assets/releases/${VERSION}/${track}.jpg`);
      for (const reference of REFERENCES) {
        expect(files).toContain(`out/releases/${VERSION}/${track}-${reference.toLowerCase()}.jpg`);
      }
    }
    expect(files).toContain(`site/sources/${VERSION}/source.md`);
    expect(files).toContain(`site/documents/${VERSION}/screenplay.md`);
    expect(files).toContain(`site/documents/${VERSION}/shot-list.md`);
    expect(files).toContain(`site/releases/${VERSION}.json`);
  });

  it("should lift each reference's subject from the package rather than asking for it", async () => {
    await episode();

    await freeze(engine());

    const stills = (await registry()).tracks[0].stills as { label: string; subject: string }[];
    expect(stills.find((still) => still.label === "R01")?.subject).toBe("Living room, evening");
    expect(stills.find((still) => still.label === "R02")?.subject).toBe("Alpaca toy, uncompressed");
  });

  it("should cut the poster from the web encode, not from the original", async () => {
    await episode();
    const engineUsed = engine();

    await freeze(engineUsed);

    const posters = engineUsed.made.filter((call) => call.op === "poster");
    expect(posters).toHaveLength(imageTracks.length);
    for (const poster of posters) {
      // The bytes a visitor will stream, so the still matches what plays.
      expect(poster.from).toContain(`out/releases/${VERSION}/`);
      expect(poster.from).not.toContain("projects/");
    }
  });

  it("should measure the file it produced, not the one it read", async () => {
    await episode();

    await freeze(engine());

    const [track] = (await registry()).tracks;
    expect(track.width).toBe(1920);
    expect(track.height).toBe(1080);
    expect(track.durationSeconds).toBe(90.5);
    expect(track.bytes).toBeGreaterThan(0);
  });

  it("should leave every reader-facing text as TODO, and say which", async () => {
    await episode();

    const result = await freeze(engine());

    const written = await registry();
    expect(written.title).toBe("TODO");
    expect(written.episode.audio).toBe("TODO");
    expect(written.source.description).toBe("TODO");
    const unwritten = result.ok ? result.data.unwritten : [];
    expect(unwritten).toContain("title");
    expect(unwritten).toContain("episode.audio");
    expect(unwritten).toContain("documents[0].description");
    // A reference subject was lifted, so nobody is asked to write one.
    expect(unwritten.some((field) => field.endsWith("stills[1].subject"))).toBe(false);
  });

  it("should carry the facts stage 0 already decided", async () => {
    await episode();

    await freeze(engine());

    const written = await registry();
    expect(written.episode.project).toBe("Dzielna Ewa");
    expect(written.episode.aspectRatio).toBe("16:9");
    expect(written.episode.language).toBe("pl");
    expect(written.sourceDirectory).toBe(`out/releases/${VERSION}`);
    expect(written.version).toBe(VERSION);
  });

  it("should refuse to touch a version that already exists", async () => {
    await episode();
    await freeze(engine());
    const before = await readFile(join(repository, "site", "releases", `${VERSION}.json`), "utf8");

    const again = await freeze(engine());

    expect(again.ok ? "" : again.error.message).toContain("już istnieje");
    expect(await readFile(join(repository, "site", "releases", `${VERSION}.json`), "utf8")).toBe(
      before
    );
  });

  it("should refuse a track whose film has not been made", async () => {
    await makeUpstream({ answer: answer(), approvePackage: true, root, scratch, workspace });
    await makeTrack({ root, track: "gpt-image", workspace });
    await finishTrack("gpt-image");
    await makeTrack({ root, track: "seedream", workspace });

    const result = await freeze(engine());

    expect(result.ok ? "" : result.error.message).toContain("seedream/mixed.mp4");
  });

  it("should refuse once a hand edit has lapsed the stage-0 approval", async () => {
    await episode();
    // The same thing `check` reports: acceptance is bound to bytes, and these
    // are not the bytes anybody accepted.
    await writeFile(join(root, "projects", PROJECT, "project.md"), "# Inne zasady\n");

    const result = await freeze(engine());

    expect(result.ok ? "" : result.error.message).toContain("etap 0");
  });

  it("should refuse an episode that is not in the workspace", async () => {
    const result = await freezeRelease(
      { episodeId: "99-nie-ma", projectId: PROJECT, root: repository, version: VERSION, workspace },
      engine()
    );

    expect(result.ok).toBe(false);
  });
});
