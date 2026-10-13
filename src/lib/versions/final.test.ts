import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EPISODE,
  makeDialogue,
  makeSoundDesign,
  makeTrack,
  makeUpstream,
  makeVersions,
  muxer,
  PROJECT,
  VOICE,
} from "../../test/fixture.js";
import type { Checklist } from "../checklist.js";
import type { Muxer } from "../muxer.js";
import { setLevels } from "../sound-design/index.js";
import { resolveWorkspace, type Workspace } from "../workspace.js";
import { approveVersions, checkVersions, generateFinal } from "./index.js";

/**
 * Stage 12's two finished films, FINAL EN and FINAL PL, through the module entry.
 *
 * Assumptions this file encodes, stated before its first test:
 *
 * - **One picture serves both films.** `versions/episode.mp4` is the cut with
 *   each lip-synced clip in place of the clip it replaces, in the plan's order,
 *   picture only: a lip-synced clip carries the speech it was synced to, and
 *   each version lays its own. It is made once and reused, so the two films
 *   share it byte for byte.
 * - **The films differ only in speech.** The language of the mouths gets the
 *   translated lines `en:Dnn`, the film's language its own lines `Dnn`, and
 *   both get the same accepted stems of stage 10 at the levels of `mix.json`.
 * - **`--language` names either of the episode's two languages** and nothing
 *   else: the mouths' from `lip-sync.json`, or the film's own.
 * - **The gate is everything the film is made of, accepted**: every clip that
 *   needs lip-sync has an accepted version, every other clip is accepted in
 *   stage 7, every line of that language is accepted, and so is every stem.
 * - **Placement is refused, never nudged**, on the picture's own clock: two
 *   utterances at once, or one past the end of the film.
 * - **Only the engine is faked**, and it is the fixture's, spied on; every
 *   earlier stage is run for real.
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
 * An episode whose cast speaks, its clips accepted on one track, and the
 * English lines accepted. In the two-clip cut Ewa speaks on screen in C01 and
 * Tata in C02; in the three-clip cut only C01 has a face to move, and C02 and
 * C03 pass to the version as they are.
 */
async function episode(
  shape: "three-clips" | "two-clips" = "two-clips",
  lineSeconds = 1
): Promise<void> {
  await makeUpstream({
    answer: answer(shape === "two-clips" ? ["C01", "C02"] : ["C01", "C02", "C03"]),
    approvePackage: true,
    dialogue: true,
    root,
    scratch,
    shotList: shape,
    voiceId: VOICE,
    workspace,
  });
  await makeTrack({ root, track: "gpt-image", workspace });
  await makeDialogue({ filmLines: true, lineSeconds, workspace });
}

/**
 * The three-clip cut with everything a film is made of accepted: C01
 * lip-synced, the stems of stage 10 bought.
 */
async function finished(): Promise<void> {
  await episode("three-clips");
  await makeSoundDesign({ workspace });
  await makeVersions({ faces: { C01: { 0: "ewa" } }, seconds: 10, workspace });
}

/** This episode's track directory, where stage 12 writes. */
function trackRoot(): string {
  return join(root, "projects", PROJECT, "episodes", EPISODE, "gpt-image");
}

/** One call the engine was asked to make. */
interface Call {
  readonly input: unknown;
  readonly operation: string;
}

/** The fixture's engine, with every operation it was asked for written down. */
function spy(): { readonly calls: Call[]; readonly mux: Muxer } {
  const calls: Call[] = [];
  const real = muxer();

  return {
    calls,
    mux: {
      concat: (input) => {
        calls.push({ input, operation: "concat" });

        return real.concat(input);
      },
      lastFrame: (input) => {
        calls.push({ input, operation: "lastFrame" });

        return real.lastFrame(input);
      },
      master: (input) => {
        calls.push({ input, operation: "master" });

        return real.master(input);
      },
      mix: (input) => {
        calls.push({ input, operation: "mix" });

        return real.mix(input);
      },
      picture: (input) => {
        calls.push({ input, operation: "picture" });

        return real.picture(input);
      },
      version: () => real.version(),
    },
  };
}

const scope = () =>
  ({ episodeId: EPISODE, projectId: PROJECT, track: "gpt-image", workspace }) as const;

function final(language: string, mux: Muxer, mode: "apply" | "dry-run" = "apply") {
  return generateFinal({ ...scope(), language, mode, mux, regenerate: false });
}

function reason(result: { error?: Error; ok: boolean }): string {
  return result.ok ? "" : (result.error?.message ?? "");
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aimator-final-"));
  root = join(scratch, "workspace");
  const resolved = resolveWorkspace(root);
  workspace = resolved.ok ? resolved.data : { root: "" };
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

describe("versions final gate", { timeout: 60_000 }, () => {
  /** C02's mouths moved and accepted, C01's not: the film waits for C01, by name. */
  it("should refuse while a clip that needs lip-sync has no accepted version, naming it", async () => {
    await episode();
    await makeVersions({ faces: { C02: { 1: "tata" } }, workspace });
    const engine = spy();
    const result = await final("en", engine.mux);

    expect(reason(result)).toContain("C01: klip wymaga lip-syncu");
    expect(reason(result)).not.toContain("C02: klip wymaga lip-syncu");
    expect(engine.calls).toEqual([]);
  });

  /**
   * The two-clip cut with every line six seconds long: Tata's answer in U04
   * starts at 21s while Ewa's line from U03 runs from 16s to 22s.
   */
  it("should refuse English lines that would sound at once, naming both", async () => {
    await episode("two-clips", 6);
    await makeSoundDesign({ workspace });
    await makeVersions({ faces: { C01: { 0: "ewa" }, C02: { 1: "tata" } }, workspace });
    const engine = spy();
    const result = await final("en", engine.mux);

    expect(reason(result)).toContain("en:D02 kończy się w 22s, a en:D03 zaczyna w 21s");
    expect(reason(result)).toContain("aimator dialogue translate");
    expect(engine.calls).toEqual([]);
  });

  /** A film exists in the language of the mouths and in the film's own, and in no third. */
  it("should refuse a language that is neither the mouths' nor the film's", async () => {
    await finished();
    const engine = spy();
    const result = await final("de", engine.mux);

    expect(reason(result)).toContain('--language "de", odcinek ma wersje: en, pl');
    expect(engine.calls).toEqual([]);
  });

  /**
   * The picture is a stream copy, which holds only while every clip shares a
   * frame, a codec and a frame rate. Kling hands C01 back at 30 frames a second
   * over a track rendered at 24, so the cut is refused before the engine runs.
   */
  it("should refuse a picture whose clips do not share a frame, a codec and a frame rate", async () => {
    await episode("three-clips");
    await makeSoundDesign({ workspace });
    await makeVersions({ faces: { C01: { 0: "ewa" } }, fps: 30, seconds: 10, workspace });
    const engine = spy();
    const result = await final("en", engine.mux);

    expect(reason(result)).toContain("C01 (1920x1080, hvc1, 30 kl./s)");
    expect(reason(result)).toContain("C02, C03 (1920x1080, hvc1, 24 kl./s)");
    expect(engine.calls).toEqual([]);
  });
});

describe("what each film says", { timeout: 60_000 }, () => {
  /**
   * The three-clip cut has two lines: Ewa's on screen in C01, and Ewa's again
   * from off screen in C03. The English film speaks both in English, the one
   * nobody lip-synced included; the Polish one speaks both in Polish.
   */
  it("should lay each language's own lines over the same music and effects", async () => {
    await finished();
    const engine = spy();
    await final("en", engine.mux);
    await final("pl", engine.mux);
    const [english, polish] = engine.calls
      .filter((one) => one.operation === "master")
      .map((one) => one.input as Parameters<Muxer["master"]>[0]);
    const episodeRoot = join(root, "projects", PROJECT, "episodes", EPISODE);
    const spoken = (film: typeof english) => film?.speech.map((one) => one.path);

    expect(spoken(english)).toEqual([
      join(episodeRoot, "dialogue", "en", "D01.wav"),
      join(episodeRoot, "dialogue", "en", "D02.wav"),
    ]);
    expect(spoken(polish)).toEqual([
      join(episodeRoot, "dialogue", "pl", "D01.wav"),
      join(episodeRoot, "dialogue", "pl", "D02.wav"),
    ]);
    expect(english?.music).toEqual([{ atSeconds: 0, path: join(episodeRoot, "sound", "M01.mp3") }]);
    expect(english?.effects).toEqual([
      { atSeconds: 16, path: join(episodeRoot, "sound", "E01.mp3") },
    ]);
    expect([polish?.music, polish?.effects]).toEqual([english?.music, english?.effects]);
  });
});

describe("versions final runs", { timeout: 60_000 }, () => {
  /** A preview states the cut and the sounds, and asks the engine nothing but its name. */
  it("should plan the film in a dry run without writing or cutting anything", async () => {
    await finished();
    const engine = spy();
    const result = await final("en", engine.mux, "dry-run");

    expect(
      result.ok
        ? { picture: result.data.picture, problems: result.data.problems, state: result.data.state }
        : reason(result)
    ).toEqual({
      picture: [
        { id: "C01", source: "lip-sync" },
        { id: "C02", source: "clips" },
        { id: "C03", source: "clips" },
      ],
      problems: [],
      state: "planned",
    });
    expect(result.ok ? result.data.sounds.map(({ id, kind }) => ({ id, kind })) : null).toEqual([
      { id: "en:D01", kind: "speech" },
      { id: "en:D02", kind: "speech" },
      { id: "M01", kind: "music" },
      { id: "E01", kind: "effect" },
    ]);
    expect(engine.calls).toEqual([]);
    await expect(readFile(join(trackRoot(), "versions", "episode.mp4"))).rejects.toThrow();
  });

  /** A preview of a film that cannot be made yet lists every obstacle rather than dying on the first. */
  it("should list the obstacles in a dry run instead of refusing", async () => {
    await episode();
    const result = await final("en", spy().mux, "dry-run");

    expect(result.ok ? result.data.state : reason(result)).toBe("blocked");
    expect(result.ok ? result.data.problems.join("\n") : "").toContain(
      "C01: klip wymaga lip-syncu"
    );
  });

  /** Nothing is made twice on its own: a finished film carries a yes, or is about to. */
  it("should leave a finished film alone unless asked to make it again", async () => {
    await finished();
    const engine = spy();
    await final("en", engine.mux);
    const again = await final("en", engine.mux);
    const masters = () => engine.calls.filter((one) => one.operation === "master").length;

    expect(again.ok ? again.data.state : reason(again)).toBe("skipped");
    expect(masters()).toBe(1);

    const remade = await generateFinal({
      ...scope(),
      language: "en",
      mode: "apply",
      mux: engine.mux,
      regenerate: true,
    });

    expect(remade.ok ? remade.data.state : reason(remade)).toBe("published");
    expect(masters()).toBe(2);
  });
});

describe("checking the films", { timeout: 60_000 }, () => {
  /** Once every clip has its yes, the stage points at the films, then at the yes each waits for. */
  it("should point at the film to make, then at the checklist its yes is given against", async () => {
    await finished();
    const before = await checkVersions(scope());
    await final("en", spy().mux);
    const made = await checkVersions(scope());

    expect(before.ok ? before.data.nextStep : reason(before)).toBe(
      `aimator versions final ${PROJECT} ${EPISODE} --track gpt-image --language en`
    );
    expect(made.ok ? made.data.nextStep : reason(made)).toContain(
      "--artifact en --checks animation,timing,acting,lip-sync,continuity"
    );
    expect(made.ok ? made.data.finals.map(({ id, state }) => ({ id, state })) : null).toEqual([
      { id: "en", state: "completed" },
      { id: "pl", state: "absent" },
    ]);
    expect(made.ok ? made.data.approved : null).toBe(false);
  });

  /**
   * Both films were laid at the starting levels; deciding how the series
   * sounds afterwards is a film nobody watched, though no recorded byte moved.
   */
  it("should lapse both films when the series' levels are decided after them", async () => {
    await finished();
    const engine = spy();
    await final("en", engine.mux);
    await final("pl", engine.mux);
    await approveVersions({
      ...scope(),
      artifacts: ["en", "pl"],
      checks: "all",
      mode: "apply",
      note: "ok",
      reviewer: "test",
    });
    const accepted = await checkVersions(scope());
    await setLevels({
      duckDb: null,
      duckReleaseMs: null,
      effectsDb: null,
      mode: "apply",
      musicDb: -20,
      projectId: PROJECT,
      workspace,
    });
    const after = await checkVersions(scope());
    const lapsed = (status: typeof after) =>
      status.ok
        ? status.data.finals.map(({ approved, id, inputsChanged }) => ({
            approved,
            id,
            inputsChanged,
          }))
        : reason(status);

    expect(accepted.ok ? accepted.data.approved : reason(accepted)).toBe(true);
    expect(lapsed(after)).toEqual([
      { approved: false, id: "en", inputsChanged: [`projects/${PROJECT}/mix.json`] },
      { approved: false, id: "pl", inputsChanged: [`projects/${PROJECT}/mix.json`] },
    ]);
    expect(after.ok ? after.data.nextStep : null).toBe(
      `aimator versions final ${PROJECT} ${EPISODE} --track gpt-image --language en --regenerate`
    );
  });
});

describe("approving a film", { timeout: 60_000 }, () => {
  function approve(artifacts: readonly string[], checks: Checklist | null) {
    return approveVersions({
      ...scope(),
      artifacts,
      checks,
      mode: "apply",
      note: "obejrzane w całości",
      reviewer: "test",
    });
  }

  /**
   * The English film is the one whose mouths were moved, so its yes is the QC
   * walk the flow describes; the Polish one is dubbing over those mouths, and
   * a person accepts it as they accept any film.
   */
  it("should refuse the English film without the full checklist, and accept the Polish one without", async () => {
    await finished();
    const engine = spy();
    await final("en", engine.mux);
    await final("pl", engine.mux);
    const bare = await approve(["en"], null);
    const partial = await approve(["en"], ["animation", "timing"]);
    const polish = await approve(["pl"], null);
    const english = await approve(["en"], "all");
    const record = JSON.parse(await readFile(join(trackRoot(), "versions.stage.json"), "utf8")) as {
      artifacts: Record<string, { review: { checks?: string[]; status: string } }>;
    };

    expect(reason(bare)).toContain("animation, timing, acting, lip-sync, continuity");
    expect(reason(partial)).toContain("brakuje kryteriów: acting, lip-sync, continuity");
    expect(polish.ok ? polish.data.finals : reason(polish)).toContainEqual(
      expect.objectContaining({ approved: true, id: "pl" })
    );
    expect(english.ok ? english.data.finals : reason(english)).toContainEqual(
      expect.objectContaining({ approved: true, id: "en" })
    );
    expect(record.artifacts).toMatchObject({
      en: {
        review: {
          checks: ["animation", "timing", "acting", "lip-sync", "continuity"],
          status: "approved",
        },
      },
      pl: { review: { status: "approved" } },
    });
    expect(JSON.stringify(record.artifacts.pl)).not.toContain("checks");
  });
});

describe("the picture of a version", { timeout: 60_000 }, () => {
  /** The cut, with the one lip-synced clip in its own place and the others as stage 7 left them. */
  it("should cut the lip-synced clips and the untouched ones together, in the plan's order", async () => {
    await finished();
    const engine = spy();
    const result = await final("en", engine.mux);
    const cut = engine.calls.filter((one) => one.operation === "picture");

    expect(result.ok ? result.data.problems : reason(result)).toEqual([]);
    expect(cut.map((one) => one.input)).toEqual([
      expect.objectContaining({
        clips: [
          join(trackRoot(), "versions", "clips", "C01.mp4"),
          join(trackRoot(), "clips", "C02.mp4"),
          join(trackRoot(), "clips", "C03.mp4"),
        ],
        target: join(trackRoot(), "versions", "episode.mp4"),
      }),
    ]);
  });

  /** Cut once, laid under both: the films cannot differ in a single frame. */
  it("should lay both films over the one picture, cut once", async () => {
    await finished();
    const engine = spy();
    const english = await final("en", engine.mux);
    const polish = await final("pl", engine.mux);
    const picture = join(trackRoot(), "versions", "episode.mp4");

    expect([english, polish].map((one) => (one.ok ? one.data.problems : reason(one)))).toEqual([
      [],
      [],
    ]);
    expect(engine.calls.filter((one) => one.operation === "picture")).toHaveLength(1);
    expect(
      engine.calls.filter((one) => one.operation === "master").map((one) => one.input)
    ).toEqual([
      expect.objectContaining({
        target: join(trackRoot(), "versions", "en.mp4"),
        video: picture,
      }),
      expect.objectContaining({
        target: join(trackRoot(), "versions", "pl.mp4"),
        video: picture,
      }),
    ]);
  });
});
