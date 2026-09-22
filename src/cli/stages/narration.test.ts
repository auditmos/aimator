import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkMix, checkNarration } from "../../lib/narration/index.js";
import { resolveWorkspace, type Workspace } from "../../lib/workspace.js";
import {
  EPISODE,
  makeCut,
  makeNarration,
  makeUpstream,
  PROJECT,
  VOICE,
} from "../../test/fixture.js";
import { run } from "../index.js";

/**
 * Stage 9 asked about on its own: the first object at **two levels of the tree**.
 *
 * `check --stage soundtrack` answers about the words, shared by both tracks,
 * and the same command with `--track` answers about that track's mix. It is
 * not a narrowing but a choice of question, and `--json` has to keep the two
 * apart, because a panel showing one is showing a different artifact from a
 * panel showing the other.
 *
 * The other half is the bill, and stage 9 is where the count of calls stops
 * being it. This provider charges per character of the text it is handed, so
 * the report carries both numbers and a preview that printed only one would be
 * printing a number nobody is billed.
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

/** Both paid models, named on every call: the environment here is empty. */
const MODELS = ["--model", "gpt-6-astra", "--voice-model", "eleven_multilingual_v2"] as const;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "aimator-cli-narration-"));
  scratch = await mkdtemp(join(tmpdir(), "aimator-cli-narration-src-"));
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
}, 180_000);

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
  await rm(scratch, { force: true, recursive: true });
});

describe("check --stage soundtrack", () => {
  it("should print the shared half's own object when no track is named", async () => {
    const printed = await object("check", PROJECT, EPISODE, "--stage", "soundtrack", "--json");
    const stage = await checkNarration({ episodeId: EPISODE, projectId: PROJECT, workspace });

    if (!stage.ok) {
      throw stage.error;
    }

    expect(printed).toEqual({ command: "check", stage: "soundtrack", ...stage.data });
  });

  /**
   * The same command with a track is a **different question**, not a narrower
   * one: stage 9 is the first stage whose artifacts live at two levels, and
   * the words have no track while the mix has nothing else.
   */
  it("should print the track's own mix object when a track is named", async () => {
    const printed = await object(
      "check",
      PROJECT,
      EPISODE,
      "--stage",
      "soundtrack",
      "--track",
      TRACK,
      "--json"
    );
    const stage = await checkMix({
      episodeId: EPISODE,
      projectId: PROJECT,
      track: TRACK,
      workspace,
    });

    if (!stage.ok) {
      throw stage.error;
    }

    expect(printed).toEqual({ command: "check", stage: "soundtrack", ...stage.data });
  });
});

describe("approve --stage soundtrack", () => {
  it("should print the shared half's object under --json", async () => {
    const printed = (await object(
      "approve",
      PROJECT,
      EPISODE,
      "--stage",
      "soundtrack",
      "--artifact",
      "script",
      "--reviewer",
      "fixture",
      "--dry-run",
      "--json"
    )) as { command: string; script: { id: string }; stage: string };

    expect(printed.command).toBe("approve");
    expect(printed.stage).toBe("soundtrack");
    expect(printed.script.id).toBe("script");
  });

  it("should print the track's own mix object under --json", async () => {
    const printed = await object(
      "approve",
      PROJECT,
      EPISODE,
      "--stage",
      "soundtrack",
      "--track",
      TRACK,
      "--reviewer",
      "fixture",
      "--dry-run",
      "--json"
    );

    expect(printed).toMatchObject({ command: "approve", stage: "soundtrack", track: TRACK });
  });
});

describe("narration generate --json", () => {
  /**
   * The first report whose bill is **not** the count of calls.
   *
   * Both numbers travel, because neither alone is what a person needs: every
   * stage above this one is billed per call, and this provider charges for the
   * characters of the text it is handed. A panel reading one of them would put
   * the wrong number beside the button that spends.
   */
  it("should carry the bill in calls and in characters", async () => {
    const report = (await object(
      "narration",
      "generate",
      PROJECT,
      EPISODE,
      ...MODELS,
      "--artifact",
      "N01",
      "--regenerate",
      "--dry-run",
      "--json"
    )) as { calls: number; characters: number; command: string; stage: string };

    expect(report.command).toBe("generate");
    expect(report.stage).toBe("soundtrack");
    expect(report.calls).toBe(1);
    expect(report.characters).toBeGreaterThan(0);
  });

  /**
   * The continuity parameters ride **beside** the bill and never inside it:
   * the provider documents them and does not say whether it charges for them,
   * and this tool does not guess with somebody else's account.
   */
  it("should keep the context characters out of the bill and still report them", async () => {
    const report = (await object(
      "narration",
      "generate",
      PROJECT,
      EPISODE,
      ...MODELS,
      "--artifact",
      "N02",
      "--regenerate",
      "--dry-run",
      "--json"
    )) as { characters: number; contextCharacters: number };

    expect(report.contextCharacters).toBeGreaterThan(0);
    expect(report.contextCharacters).not.toBe(report.characters);
  });

  it("should say the same numbers in prose as it says in the object", async () => {
    const report = (await object(
      "narration",
      "generate",
      PROJECT,
      EPISODE,
      ...MODELS,
      "--artifact",
      "N01",
      "--regenerate",
      "--dry-run",
      "--json"
    )) as { calls: number; characters: number };
    const prose = await cli(
      "narration",
      "generate",
      PROJECT,
      EPISODE,
      ...MODELS,
      "--artifact",
      "N01",
      "--regenerate",
      "--dry-run"
    );

    expect(prose).toContain(`${report.calls} wywołań, ${report.characters} znaków`);
  });
});

describe("narration mix --json", () => {
  it("should print the per-track half's report, with its own command word", async () => {
    const report = (await object(
      "narration",
      "mix",
      PROJECT,
      EPISODE,
      "--track",
      TRACK,
      "--dry-run",
      "--json"
    )) as { command: string; lines: readonly { id: string }[]; stage: string; track: string };

    expect(report.command).toBe("mix");
    expect(report.stage).toBe("soundtrack");
    expect(report.track).toBe(TRACK);
    expect(report.lines.map((one) => one.id)).toEqual(["N01", "N02"]);
  });
});

describe("narration direction --json", () => {
  /**
   * The five numbers a form maps onto, as an object rather than as five lines
   * of Polish with the direction of each knob written into the label.
   */
  it("should print the reading the narrator is directed to give", async () => {
    const report = (await object(
      "narration",
      "direction",
      PROJECT,
      "--stability",
      "0.35",
      "--style",
      "0.4",
      "--dry-run",
      "--json"
    )) as {
      command: string;
      delivery: { stability: number; style: number };
      stage: string;
    };

    expect(report.command).toBe("direction");
    expect(report.stage).toBe("soundtrack");
    expect(report.delivery.stability).toBe(0.35);
    expect(report.delivery.style).toBe(0.4);
  });
});
