import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkDialogue, generateDialogue, translateDialogue } from "../../lib/dialogue/index.js";
import { resolveWorkspace, type Workspace } from "../../lib/workspace.js";
import {
  API_KEY,
  DIALOGUE,
  EPISODE,
  makeUpstream,
  makeVoices,
  PROJECT,
} from "../../test/fixture.js";
import { run } from "../index.js";

/**
 * Stage 11 through the terminal: the bill before anything is sent, the stage's
 * own object under `--json`, and an approval that has to name what it accepts.
 * Nothing here spends: the one script is bought through the module entry with
 * a fake provider, and `generate` is only ever previewed.
 */

vi.mock("../../lib/env.js", () => ({ env: {} }));

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

function answer(): string {
  return JSON.stringify({
    clips: [{ id: "C01", prompt: "Akcja klipu C01.", referenceIds: ["hero:ewa"] }],
    entryFrames: [],
    opening: { prompt: "Ewa centralnie, burza za oknem.", referenceIds: ["hero:ewa"] },
    references: [],
    review: "Do rozstrzygnięcia: skala alpaki.",
  });
}

/** A script that lifts every attributed line of the fixture's plan, once. */
function script(): string {
  return [
    "## Plan\n\nEwa pyta dwa razy, tata odpowiada raz.\n",
    "## Lines\n",
    `### D01 | U01 | ewa | 2s\n\n${DIALOGUE.U01.text}\n`,
    `### D02 | U03 | ewa | 16s\n\n${DIALOGUE.U03.text}\n`,
    `### D03 | U04 | tata | 22s\n\n${DIALOGUE.U04.text}\n`,
    "## Review\n\nKażda kwestia pochodzi z pola Audio swojego ujęcia.\n",
  ].join("\n");
}

/** The same three lines in English, every heading untouched. */
function translated(): string {
  return [
    "## Lines\n",
    "### D01 | U01 | ewa | 2s\n\nDad, is the storm coming?\n",
    "### D02 | U03 | ewa | 16s\n\nDad, where are you?\n",
    "### D03 | U04 | tata | 22s\n\nI'm right here, Ewa.\n",
    "## Review\n\nNothing was shortened.\n",
  ].join("\n");
}

function provider(text = script()): typeof fetch {
  return (() =>
    Promise.resolve(
      Response.json({
        id: "resp_1",
        output: [
          {
            content: [{ text, type: "output_text" }],
            role: "assistant",
            type: "message",
          },
        ],
        status: "completed",
      })
    )) as unknown as typeof fetch;
}

/** What the terminal would print, or the error it would print instead. */
async function cli(...argv: readonly string[]): Promise<string> {
  const result = await run([...argv, "--workspace", root]);

  if (!result.ok) {
    throw result.error;
  }

  return result.data;
}

async function object(...argv: readonly string[]): Promise<Record<string, unknown>> {
  return JSON.parse(await cli(...argv)) as Record<string, unknown>;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "aimator-cli-dialogue-"));
  scratch = await mkdtemp(join(tmpdir(), "aimator-cli-dialogue-src-"));
  const resolved = resolveWorkspace(root);

  if (!resolved.ok) {
    throw resolved.error;
  }

  workspace = resolved.data;

  await makeUpstream({
    answer: answer(),
    approvePackage: true,
    dialogue: true,
    root,
    scratch,
    workspace,
  });
}, 60_000);

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
  await rm(scratch, { force: true, recursive: true });
});

describe("dialogue generate", () => {
  it("should state the bill and the prompt before anything is sent", async () => {
    const printed = await object(
      "dialogue",
      "generate",
      PROJECT,
      EPISODE,
      "--model",
      "gpt-6-astra",
      "--dry-run",
      "--json"
    );

    expect(printed).toMatchObject({ command: "generate", paidCalls: 1, stage: "dialogue" });
    expect(String(printed.prompt)).toContain(`ewa: "${DIALOGUE.U01.text}"`);
  });

  it("should say which model is missing rather than guess one", async () => {
    const printed = await cli("dialogue", "generate", PROJECT, EPISODE, "--dry-run");

    expect(printed).toContain("AIMATOR_DIALOGUE_MODEL");
    expect(printed).toContain("płatnych wywołań do wykonania: 0");
  });
});

describe("check and approve --stage dialogue", () => {
  beforeAll(async () => {
    const bought = await generateDialogue({
      apiKey: API_KEY,
      artifacts: [],
      episodeId: EPISODE,
      fetch: provider(),
      maxOutputTokens: 8000,
      mode: "apply",
      model: "gpt-6-astra",
      projectId: PROJECT,
      regenerate: false,
      voiceKey: null,
      voiceModel: null,
      workspace,
    });

    if (!bought.ok) {
      throw bought.error;
    }
  });

  it("should print the stage's own object, plus the two fields that place it", async () => {
    const printed = await object("check", PROJECT, EPISODE, "--stage", "dialogue", "--json");
    const stage = await checkDialogue({ episodeId: EPISODE, projectId: PROJECT, workspace });

    if (!stage.ok) {
      throw stage.error;
    }

    expect(printed).toEqual({ command: "check", stage: "dialogue", ...stage.data });
  });

  it("should accept the script only when it is named", async () => {
    const unnamed = await run([
      "approve",
      PROJECT,
      EPISODE,
      "--stage",
      "dialogue",
      "--workspace",
      root,
    ]);
    const printed = await object(
      "approve",
      PROJECT,
      EPISODE,
      "--stage",
      "dialogue",
      "--artifact",
      "script",
      "--reviewer",
      "fixture",
      "--json"
    );

    expect(unnamed.ok ? null : unnamed.error.message).toContain("--artifact jest wymagane");
    expect(printed).toMatchObject({
      command: "approve",
      script: { approved: true },
      stage: "dialogue",
    });
  });

  it("should state the bill of the lines in calls and characters, line by line", async () => {
    await makeVoices({ workspace });
    const printed = await cli(
      "dialogue",
      "generate",
      PROJECT,
      EPISODE,
      "--voice-model",
      "eleven_multilingual_v2",
      "--dry-run"
    );
    const characters = [DIALOGUE.U01, DIALOGUE.U03, DIALOGUE.U04].map(
      (one) => [...one.text].length
    );

    expect(printed).toContain("płatnych wywołań do wykonania: 3");
    expect(printed).toContain(`znaków do rozliczenia: ${characters.reduce((a, b) => a + b, 0)}`);
    expect(printed).toContain(`D03: tata, planned, gotowa do kupienia, ${characters[2]} znaków`);
  });

  it("should name the speech model it was not given rather than guess one", async () => {
    const printed = await cli("dialogue", "generate", PROJECT, EPISODE, "--dry-run");

    expect(printed).toContain("AIMATOR_DIALOGUE_VOICE_MODEL");
    expect(printed).toContain("płatnych wywołań do wykonania: 0");
  });
});

describe("dialogue translate", () => {
  it("should name the undecided language of the mouths and the variable of its model", async () => {
    const printed = await cli("dialogue", "translate", PROJECT, EPISODE, "--dry-run");

    expect(printed).toContain(`aimator episode lip-sync ${PROJECT} ${EPISODE} --language <kod>`);
    expect(printed).toContain("AIMATOR_TRANSLATION_MODEL");
    expect(printed).toContain("płatnych wywołań do wykonania: 0");
  });

  it("should state one paid call and a prompt carrying each line's window", async () => {
    await cli("episode", "lip-sync", PROJECT, EPISODE, "--language", "en");
    const printed = await object(
      "dialogue",
      "translate",
      PROJECT,
      EPISODE,
      "--model",
      "gpt-6-astra",
      "--dry-run",
      "--json"
    );

    expect(printed).toMatchObject({ command: "translate", paidCalls: 1, stage: "dialogue" });
    expect(String(printed.prompt)).toContain("D02 | U03 | ewa: 16-20s of the plan, 4s");
  });

  it("should print where the translation stands in check, once the episode names a language", async () => {
    const printed = await cli("check", PROJECT, EPISODE, "--stage", "dialogue");

    expect(printed).toContain("script-en: absent, jeszcze nie powstał");
  });

  it("should accept script-en when it is named", async () => {
    const bought = await translateDialogue({
      apiKey: API_KEY,
      episodeId: EPISODE,
      fetch: provider(translated()),
      maxOutputTokens: 8000,
      mode: "apply",
      model: "gpt-6-astra",
      projectId: PROJECT,
      regenerate: false,
      workspace,
    });

    if (!bought.ok) {
      throw bought.error;
    }

    const printed = await object(
      "approve",
      PROJECT,
      EPISODE,
      "--stage",
      "dialogue",
      "--artifact",
      "script-en",
      "--reviewer",
      "fixture",
      "--json"
    );

    expect(printed).toMatchObject({
      command: "approve",
      stage: "dialogue",
      translation: { approved: true, id: "script-en" },
    });
  });
});

describe("dialogue generate --language", () => {
  it("should bill the lines of the accepted translation, keyed by their language", async () => {
    await makeVoices({ language: "en", workspace });
    const printed = await cli(
      "dialogue",
      "generate",
      PROJECT,
      EPISODE,
      "--language",
      "en",
      "--voice-model",
      "eleven_multilingual_v2",
      "--dry-run"
    );

    expect(printed).toContain("płatnych wywołań do wykonania: 3");
    expect(printed).toContain("en:D01: ewa, planned, gotowa do kupienia");
  });

  it("should print the second language's lines under script-en in check", async () => {
    const printed = await cli("check", PROJECT, EPISODE, "--stage", "dialogue");

    expect(printed).toContain("en:D03: U04, tata, 22s planu, absent, nie kupiona");
  });
});
