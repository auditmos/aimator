import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkMaster, checkSoundDesign } from "../../lib/sound-design/index.js";
import { resolveWorkspace, type Workspace } from "../../lib/workspace.js";
import {
  EPISODE,
  makeCut,
  makeNarration,
  makeSoundDesign,
  makeUpstream,
  PROJECT,
  VOICE,
} from "../../test/fixture.js";
import { run } from "../index.js";

/**
 * Stage 10 asked about on its own: the second stage with an object at **two
 * levels of the tree**, and the first whose bill is counted in seconds.
 *
 * `check --stage sound-design` answers about the cue sheet and the stems,
 * shared by both tracks, and the same command with `--track` answers about
 * that track's full mix. As at stage 9 the flag is not a narrowing but a
 * choice of question, and `--json` has to keep the two apart, because a panel
 * showing one is showing a different artifact from a panel showing the other.
 *
 * The other half is the bill. Stage 9 stopped the count of calls from being
 * it; here it is wrong for a second reason: this provider rates **per minute
 * of generated audio**, so one call for a thirty-second bed and one for a
 * three-second thunderclap are the same count and nothing like the same money.
 * Both numbers travel, and a preview that printed only the count would be
 * printing a number nobody is billed.
 *
 * What this file assumes, and therefore what it is testing against:
 *
 * - The fixture's episode is narrated and cut on one track, and stage 10 has
 *   already run there: a sheet, two stems and a full mix, all accepted. What
 *   is under test is the CLI's answer, never how many calls it took.
 * - `--json` prints the object the module already returns, plus `command` and
 *   `stage`. No format is designed here.
 * - `command` carries the **subcommand**, because one stage is written by
 *   three grammars and one word for all three would answer "which command
 *   wrote this" with a guess.
 * - Nothing here spends: every generating command runs `--dry-run`, which by
 *   contract reads no key and sends nothing.
 */

vi.mock("../../lib/env.js", () => ({ env: { AIMATOR_FFMPEG: "/nonexistent/aimator-ffmpeg" } }));

const TRACK = "gpt-image";

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

async function cli(...argv: readonly string[]): Promise<string> {
  const result = await run([...argv, "--workspace", root]);

  if (!result.ok) {
    throw result.error;
  }

  return result.data;
}

async function object(...argv: readonly string[]): Promise<unknown> {
  return JSON.parse(await cli(...argv));
}

/** All three paid models, named on every call: the environment here is empty. */
const MODELS = [
  "--model",
  "gpt-6-astra",
  "--music-model",
  "music_v2",
  "--effects-model",
  "eleven_text_to_sound_v2",
] as const;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "aimator-cli-sound-"));
  scratch = await mkdtemp(join(tmpdir(), "aimator-cli-sound-src-"));
  const resolved = resolveWorkspace(root);

  if (!resolved.ok) {
    throw resolved.error;
  }

  workspace = resolved.data;

  await makeUpstream({
    answer: answer(),
    approvePackage: true,
    narration: true,
    root,
    scratch,
    voiceId: VOICE,
    workspace,
  });
  await makeCut({ root, track: TRACK, workspace });
  await makeNarration({ root, tracks: [TRACK], workspace });
  await makeSoundDesign({ tracks: [TRACK], workspace });
}, 180_000);

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
  await rm(scratch, { force: true, recursive: true });
});

describe("check --stage sound-design", () => {
  it("should print the shared half's own object when no track is named", async () => {
    const printed = await object("check", PROJECT, EPISODE, "--stage", "sound-design", "--json");
    const stage = await checkSoundDesign({ episodeId: EPISODE, projectId: PROJECT, workspace });

    if (!stage.ok) {
      throw stage.error;
    }

    expect(printed).toEqual({ command: "check", stage: "sound-design", ...stage.data });
  });

  /**
   * The same command with a track is a **different question**, not a narrower
   * one: the sheet and the stems have no track, and the full mix has nothing
   * else, because only the mix is timed against a particular cut.
   */
  it("should print the track's own master object when a track is named", async () => {
    const printed = await object(
      "check",
      PROJECT,
      EPISODE,
      "--stage",
      "sound-design",
      "--track",
      TRACK,
      "--json"
    );
    const stage = await checkMaster({
      episodeId: EPISODE,
      projectId: PROJECT,
      track: TRACK,
      workspace,
    });

    if (!stage.ok) {
      throw stage.error;
    }

    expect(printed).toEqual({ command: "check", stage: "sound-design", ...stage.data });
  });
});

describe("approve --stage sound-design", () => {
  it("should print the shared half's object under --json", async () => {
    const printed = (await object(
      "approve",
      PROJECT,
      EPISODE,
      "--stage",
      "sound-design",
      "--artifact",
      "cues",
      "--reviewer",
      "fixture",
      "--dry-run",
      "--json"
    )) as { command: string; sheet: { id: string }; stage: string };

    expect(printed.command).toBe("approve");
    expect(printed.stage).toBe("sound-design");
    expect(printed.sheet.id).toBe("cues");
  });

  it("should print the track's own master object under --json", async () => {
    const printed = await object(
      "approve",
      PROJECT,
      EPISODE,
      "--stage",
      "sound-design",
      "--track",
      TRACK,
      "--reviewer",
      "fixture",
      "--dry-run",
      "--json"
    );

    expect(printed).toMatchObject({ command: "approve", stage: "sound-design", track: TRACK });
  });
});

describe("sound-design generate --json", () => {
  /**
   * The bill, in the unit this provider actually rates in.
   *
   * Both numbers travel, because neither alone is what a person is deciding
   * on: a count of calls says nothing about the money when one call is a
   * thirty-second bed and the next is a three-second thunderclap, and seconds
   * alone would hide that a regeneration is a second full charge rather than a
   * top-up. A panel reading one of them would put the wrong number beside the
   * button that spends.
   */
  it("should carry the bill in calls and in seconds of audio", async () => {
    const report = (await object(
      "sound-design",
      "generate",
      PROJECT,
      EPISODE,
      ...MODELS,
      "--artifact",
      "M01",
      "--regenerate",
      "--dry-run",
      "--json"
    )) as { calls: number; command: string; seconds: number; stage: string };

    expect(report.command).toBe("generate");
    expect(report.stage).toBe("sound-design");
    expect(report.calls).toBe(1);
    expect(report.seconds).toBe(30);
  });

  it("should say the same numbers in prose as it says in the object", async () => {
    const argv = [
      "sound-design",
      "generate",
      PROJECT,
      EPISODE,
      ...MODELS,
      "--artifact",
      "E01",
      "--regenerate",
      "--dry-run",
    ] as const;
    const report = (await object(...argv, "--json")) as { calls: number; seconds: number };
    const prose = await cli(...argv);

    expect(prose).toContain(`${report.calls} wywołań, ${report.seconds}s dźwięku`);
  });
});

describe("sound-design mix --json", () => {
  /**
   * The per-track half, which buys nothing and still has a report worth
   * reading: where each sound landed on **this** film rather than on the plan.
   * The speech is in it beside the bed and the effect, because the full mix is
   * built from `episode.mp4` and the lossless lines rather than laid over
   * `narrated.mp4`, which is the only arrangement in which music can step back
   * under a voice.
   */
  it("should print the per-track half's report, with its own command word", async () => {
    const report = (await object(
      "sound-design",
      "mix",
      PROJECT,
      EPISODE,
      "--track",
      TRACK,
      "--dry-run",
      "--json"
    )) as {
      command: string;
      sounds: readonly { id: string; kind: string }[];
      stage: string;
      track: string;
    };

    expect(report.command).toBe("mix");
    expect(report.stage).toBe("sound-design");
    expect(report.track).toBe(TRACK);
    expect(report.sounds.filter((one) => one.kind !== "speech").map((one) => one.id)).toEqual([
      "M01",
      "E01",
    ]);
  });
});

describe("sound-design levels --json", () => {
  /**
   * The four numbers a form maps onto, as an object rather than as four lines
   * of Polish with the direction of each knob written into the label.
   */
  it("should print how loud this series sits", async () => {
    const report = (await object(
      "sound-design",
      "levels",
      PROJECT,
      "--music-db",
      "-22",
      "--duck-db",
      "-12",
      "--dry-run",
      "--json"
    )) as {
      command: string;
      levels: { duckDb: number; musicDb: number };
      stage: string;
    };

    expect(report.command).toBe("levels");
    expect(report.stage).toBe("sound-design");
    expect(report.levels.musicDb).toBe(-22);
    expect(report.levels.duckDb).toBe(-12);
  });
});
