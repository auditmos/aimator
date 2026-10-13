import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkCharacter } from "../../lib/character/index.js";
import { checkVoice, generateSample } from "../../lib/character-voice/index.js";
import { resolveWorkspace, type Workspace } from "../../lib/workspace.js";
import { EPISODE, makeCut, makeUpstream, PROJECT, wav } from "../../test/fixture.js";
import { run } from "../index.js";

/**
 * Stage 2 asked about on its own, and the first stage whose bill is a set.
 *
 * Three stages above this one buy exactly one text call, so their whole bill
 * is "one or none" and the number is almost a formality. Stage 2 draws a card,
 * eight views and a hero, and one command can buy several of them, which makes
 * the count the thing a person actually needs before clicking. So it is
 * reported the way stage 5 reports its own: how many billed image calls this
 * invocation is about, stated before anything is sent.
 *
 * The other claims are the ones every stage before it made: `--json` prints
 * the stage's own object plus `command` and `stage`, `check` and `approve`
 * answer for this stage alone when it is named, and nothing here writes or
 * spends, because `approve` runs with `--dry-run` and `generate` never leaves
 * the dry-run path.
 */

vi.mock("../../lib/env.js", () => ({ env: {} }));

const TRACK = "gpt-image";
const CHARACTER = "ewa";
/** Real ElevenLabs id shapes, as the fixture's narrator is. */
const VOICE_PL = "pNInz6obpgDQGcFmaJgB";
const SPEECH_MODEL = "eleven_multilingual_v2";
/** What a person types to hear the voice; the bill counts its characters. */
const SENTENCE = "Nie boję się burzy, tato.";

/** A second Polish voice, for the decision somebody changes their mind about. */
const OTHER_PL = "TxGEqnHWrfWFTfGW9XjX";
/** How a status cell carries an accepted hero, the one image the fixture forges. */
const HERO_APPROVED = { approved: true, artifact: "hero" };

/**
 * A Polish sample bought through the module, with a fake provider: the
 * terminal reads the real one, and what is under test here is the terminal.
 */
async function buySample(): Promise<void> {
  const bought = await generateSample({
    apiKey: "xi-test-0123456789",
    characterId: CHARACTER,
    fetch: (() =>
      Promise.resolve(
        new Response(wav({ seconds: 1 }), { headers: { "content-type": "audio/wav" } })
      )) as unknown as typeof fetch,
    language: "pl",
    mode: "apply",
    model: SPEECH_MODEL,
    projectId: PROJECT,
    regenerate: true,
    text: SENTENCE,
    workspace,
  });

  if (!bought.ok) {
    throw bought.error;
  }
}

/** The same sample, then accepted the way a person accepts it. */
async function approvedSample(): Promise<void> {
  await buySample();
  await cli(
    "approve",
    PROJECT,
    CHARACTER,
    "--stage",
    "voice",
    "--language",
    "pl",
    "--reviewer",
    "fixture"
  );
}

/** Where one language of a character's voice is recorded. */
function voiceFile(language: string): string {
  return join(root, "projects", PROJECT, "characters", CHARACTER, "voices", language, "voice.json");
}

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

function answer(): string {
  return JSON.stringify({
    clips: [
      { id: "C01", prompt: "Akcja klipu C01.", referenceIds: ["hero:ewa", "hero:tata", "R01"] },
      { id: "C02", prompt: "Akcja klipu C02.", referenceIds: ["hero:ewa", "hero:tata", "R01"] },
    ],
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

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "aimator-cli-character-"));
  scratch = await mkdtemp(join(tmpdir(), "aimator-cli-character-src-"));
  const resolved = resolveWorkspace(root);

  if (!resolved.ok) {
    throw resolved.error;
  }

  workspace = resolved.data;

  await makeUpstream({ answer: answer(), approvePackage: true, root, scratch, workspace });
  // A finished track up to the cut, so a voice change has approvals of stages
  // 2 to 8 to leave standing, and the claim that it does is not vacuous.
  await makeCut({ root, track: TRACK, workspace });
}, 120_000);

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
  await rm(scratch, { force: true, recursive: true });
});

describe("check --stage character", () => {
  it("should print the stage's own object, plus the two fields that place it", async () => {
    const printed = await object(
      "check",
      PROJECT,
      CHARACTER,
      "--stage",
      "character",
      "--track",
      TRACK,
      "--json"
    );
    const stage = await checkCharacter({
      characterId: CHARACTER,
      projectId: PROJECT,
      track: TRACK,
      workspace,
    });

    if (!stage.ok) {
      throw stage.error;
    }

    expect(printed).toEqual({ command: "check", stage: "character", ...stage.data });
  });

  it("should answer per track, because the two tracks are drawn separately", async () => {
    const one = await cli("check", PROJECT, CHARACTER, "--stage", "character", "--track", TRACK);
    const other = await cli(
      "check",
      PROJECT,
      CHARACTER,
      "--stage",
      "character",
      "--track",
      "seedream"
    );

    expect(one).toContain(`tor ${TRACK}`);
    expect(other).toContain("tor seedream");
  });
});

describe("approve --stage character", () => {
  it("should print the stage's own object under --json", async () => {
    const printed = await object(
      "approve",
      PROJECT,
      CHARACTER,
      "--stage",
      "character",
      "--track",
      TRACK,
      "--artifact",
      "hero",
      "--reviewer",
      "fixture",
      "--dry-run",
      "--json"
    );

    expect(printed).toMatchObject({ command: "approve", stage: "character" });
    expect(printed).toMatchSnapshot();
  });
});

/**
 * Casting a character's voice, one language at a time.
 *
 * Assumptions this block encodes: the choice is free and writes one file,
 * `characters/<c>/voices/<język>/voice.json`, holding the id verbatim; the
 * language is a directory level, so it is checked as an id and never trusted
 * into a path; and nothing here may reach the network.
 */
describe("character voice", () => {
  it("should record the voice in voices/<language>/voice.json and buy nothing", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    const printed = await object(
      "character",
      "voice",
      PROJECT,
      CHARACTER,
      "--language",
      "pl",
      "--voice-id",
      VOICE_PL,
      "--json"
    );
    const file: unknown = JSON.parse(await readFile(voiceFile("pl"), "utf8"));

    expect(file).toEqual({ voiceId: VOICE_PL });
    expect(printed).toMatchObject({
      characterId: CHARACTER,
      command: "voice",
      language: "pl",
      stage: "voice",
      voiceId: VOICE_PL,
    });
    expect(network).not.toHaveBeenCalled();
    network.mockRestore();
  });
});

/**
 * The sample's bill, said before anything is sent. ElevenLabs charges per
 * character of the text it is handed, so the count of calls is not the bill
 * and the preview prints both, as stage 9's does.
 */
describe("character sample --dry-run", () => {
  it("should bill one call and the characters of the sentence, without a key", async () => {
    await cli("character", "voice", PROJECT, CHARACTER, "--language", "pl", "--voice-id", VOICE_PL);

    const printed = await object(
      "character",
      "sample",
      PROJECT,
      CHARACTER,
      "--language",
      "pl",
      "--text",
      SENTENCE,
      "--model",
      SPEECH_MODEL,
      "--dry-run",
      "--json"
    );

    expect(printed).toMatchObject({
      characters: [...SENTENCE].length,
      command: "sample",
      paidCalls: 1,
      stage: "voice",
      voiceId: VOICE_PL,
    });
  });

  it("should name a voice nobody chose as the obstacle, and bill nothing", async () => {
    const printed = (await object(
      "character",
      "sample",
      PROJECT,
      CHARACTER,
      "--language",
      "de",
      "--text",
      SENTENCE,
      "--model",
      SPEECH_MODEL,
      "--dry-run",
      "--json"
    )) as { characters: number; paidCalls: number; problems: readonly string[] };

    expect(printed).toMatchObject({ characters: 0, paidCalls: 0 });
    expect(printed.problems).toContainEqual(
      expect.stringContaining(`aimator character voice ${PROJECT} ${CHARACTER} --language de`)
    );
  });
});

/**
 * The voice asked about and accepted through the terminal. The sample is
 * bought through the module, with a fake provider, because the terminal reads
 * the real one; what is under test here is the wiring of `--stage voice`.
 */
describe("check and approve --stage voice", () => {
  beforeAll(async () => {
    await cli("character", "voice", PROJECT, CHARACTER, "--language", "pl", "--voice-id", VOICE_PL);
    await buySample();
  });

  it("should print the voice's own object under check --json", async () => {
    const printed = await object(
      "check",
      PROJECT,
      CHARACTER,
      "--stage",
      "voice",
      "--language",
      "pl",
      "--json"
    );
    const status = await checkVoice({
      characterId: CHARACTER,
      language: "pl",
      projectId: PROJECT,
      workspace,
    });

    if (!status.ok) {
      throw status.error;
    }

    expect(printed).toEqual({ command: "check", stage: "voice", ...status.data });
  });

  it("should accept the sample, and check should then count it", async () => {
    const approved = await object(
      "approve",
      PROJECT,
      CHARACTER,
      "--stage",
      "voice",
      "--language",
      "pl",
      "--reviewer",
      "fixture",
      "--json"
    );
    const checked = await cli("check", PROJECT, CHARACTER, "--stage", "voice", "--language", "pl");

    expect(approved).toMatchObject({ approved: true, command: "approve", stage: "voice" });
    expect(checked).toContain("zatwierdzona");
  });
});

/**
 * A voice is not in `project.json`, and this is the test of why. That file is
 * a recorded input of nearly everything below it, so a voice changed there
 * would lapse a rendered clip whose bytes it never touched. In `voice.json` it
 * lapses the sample of its own language and nothing else, which `status`, the
 * one command that reads every stage at once, can show in a single comparison.
 */
describe("a voice changed after its sample was approved", () => {
  /**
   * Two full walks of a finished episode through `status`. Alone it takes
   * ~0.3 s; beside the whole suite it was measured past 5 s, the default
   * limit, so it gets the headroom the UI's ladder test has for the same walk.
   */
  it("should lapse the sample and leave every cell of stages 0 to 8 as it was", {
    timeout: 45_000,
  }, async () => {
    const before = (await object("status", PROJECT, EPISODE, "--json")) as {
      cells: readonly {
        id: string;
        stage: number;
        state: string;
        status: unknown;
        track: string | null;
      }[];
    };

    await cli("character", "voice", PROJECT, CHARACTER, "--language", "pl", "--voice-id", VOICE_PL);
    await approvedSample();
    await cli("character", "voice", PROJECT, CHARACTER, "--language", "pl", "--voice-id", OTHER_PL);

    const after = await object("status", PROJECT, EPISODE, "--json");
    const voice = await object(
      "check",
      PROJECT,
      CHARACTER,
      "--stage",
      "voice",
      "--language",
      "pl",
      "--json"
    );
    // Stages 3 to 8 are finished on this track; stage 2 holds the one image
    // the fixture forges, the hero, approved. Both make the equality below a
    // claim about approvals that exist rather than about an empty ladder.
    const finished = before.cells.filter(
      (cell) => (cell.track === TRACK || cell.track === null) && cell.stage >= 3 && cell.stage <= 8
    );
    const hero = before.cells.find((cell) => cell.id === `2/${CHARACTER}/${TRACK}`);

    expect(finished.map((cell) => cell.stage)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(finished.filter((cell) => cell.state !== "approved")).toEqual([]);
    expect(hero?.status).toMatchObject({
      artifacts: expect.arrayContaining([expect.objectContaining(HERO_APPROVED)]),
    });
    expect(after).toEqual(before);
    expect(voice).toMatchObject({ approved: false, sample: { voiceChanged: true } });
  });
});

describe("character generate --json", () => {
  it("should print the report this command returns, with every prompt in it", async () => {
    const printed = (await object(
      "character",
      "generate",
      PROJECT,
      CHARACTER,
      "--track",
      TRACK,
      "--model",
      "gpt-image-2.5-sunburst",
      "--dry-run",
      "--json"
    )) as {
      artifacts: readonly { readonly prompt: string | null }[];
      command: string;
      stage: string;
    };

    expect(printed.command).toBe("generate");
    expect(printed.stage).toBe("character");
    expect(printed.artifacts.every((one) => one.prompt !== null)).toBe(true);
  });

  /**
   * The first bill on this screen that is a set rather than a coin flip.
   *
   * And it counts **images that would actually be bought**, not names somebody
   * typed: the eight views wait for an accepted card, so asking for the card
   * and a view at once is two artifacts and one purchase. A count of the names
   * would have promised a picture the gate refuses to draw.
   */
  it("should count the images it would buy, not the artifacts it was asked about", async () => {
    const named = (await object(
      "character",
      "generate",
      PROJECT,
      CHARACTER,
      "--track",
      TRACK,
      "--artifact",
      "card,front",
      "--model",
      "gpt-image-2.5-sunburst",
      "--dry-run",
      "--json"
    )) as {
      artifacts: readonly { readonly artifact: string; readonly state: string }[];
      paidCalls: number;
    };
    const next = (await object(
      "character",
      "generate",
      PROJECT,
      CHARACTER,
      "--track",
      TRACK,
      "--model",
      "gpt-image-2.5-sunburst",
      "--dry-run",
      "--json"
    )) as { paidCalls: number };

    expect(named.artifacts.map((one) => [one.artifact, one.state])).toEqual([
      ["card", "planned"],
      ["front", "blocked"],
    ]);
    expect(named.paidCalls).toBe(1);
    // Without `--artifact` the gates decide, and on a character with nothing
    // drawn what they allow is the one card the eight views come from.
    expect(next.paidCalls).toBe(1);
  });

  it("should say the same number in prose as it says in the object", async () => {
    const prose = await cli(
      "character",
      "generate",
      PROJECT,
      CHARACTER,
      "--track",
      TRACK,
      "--artifact",
      "card,front",
      "--model",
      "gpt-image-2.5-sunburst",
      "--dry-run"
    );

    expect(prose).toContain("płatnych wywołań do wykonania: 1");
  });
});
