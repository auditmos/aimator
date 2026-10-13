import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { wav } from "../../test/fixture.js";
import { sha256Of } from "../artifact/index.js";
import { addCharacter, initProject } from "../project/index.js";
import { resolveWorkspace, type Workspace } from "../workspace.js";
import { approveVoice, checkVoice, generateSample, setVoice } from "./index.js";

/**
 * A character's voice, through the module entry: the choice, the sample bought
 * to hear it, and what its approval is bound to.
 *
 * Assumptions this file encodes, stated before the first test:
 *
 * - **The sample records `voice.json` as its only input.** Not `project.json`:
 *   that file is an input of nearly every artifact, and a voice changed there
 *   would lapse things it never touched. So changing the voice lapses the
 *   sample of that language and nothing else.
 * - **The transport is the only thing faked.** It counts calls, because a paid
 *   command's bill is the assertion, and answers with a WAV the verdict reads.
 * - **Stage 0 need not be accepted to hear a voice.** A sample reads the voice
 *   and the sentence a person typed, nothing stage 0 approves, and hearing a
 *   voice is how casting is decided in the first place.
 */

const PROJECT = "demo";
const CHARACTER = "ewa";
const VOICE_PL = "pNInz6obpgDQGcFmaJgB";
const MODEL = "eleven_multilingual_v2";
const KEY = "xi-test-0123456789";
const SENTENCE = "Nie boję się burzy, tato.";

let root = "";
let workspace: Workspace = { root: "" };

/** A provider that answers every call with a short WAV, and remembers each one. */
function provider(): { readonly calls: string[]; readonly fetch: typeof fetch } {
  const calls: string[] = [];
  const answer = ((url: string | URL) => {
    calls.push(String(url));

    return Promise.resolve(
      new Response(wav({ seconds: 1.5 }), {
        headers: { "content-type": "audio/wav" },
        status: 200,
      })
    );
  }) as unknown as typeof fetch;

  return { calls, fetch: answer };
}

function voicePath(language: string, file: string): string {
  return join(root, "projects", PROJECT, "characters", CHARACTER, "voices", language, file);
}

function relative(language: string, file: string): string {
  return `projects/${PROJECT}/characters/${CHARACTER}/voices/${language}/${file}`;
}

async function digest(path: string): Promise<string> {
  return sha256Of(await readFile(path));
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "aimator-voice-"));
  const resolved = resolveWorkspace(root);

  if (!resolved.ok) {
    throw resolved.error;
  }

  workspace = resolved.data;

  const scope = { mode: "apply", projectId: PROJECT, workspace } as const;

  await initProject({ ...scope, aspectRatio: "16:9", title: "Demo" });
  await addCharacter({ ...scope, characterId: CHARACTER, name: "Ewa" });
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("generateSample", () => {
  it("should publish sample.wav with its producer, voice.json as its input, review pending", async () => {
    const scope = { characterId: CHARACTER, language: "pl", projectId: PROJECT, workspace };
    const transport = provider();

    await setVoice({ ...scope, mode: "apply", voiceId: VOICE_PL });

    const bought = await generateSample({
      ...scope,
      apiKey: KEY,
      fetch: transport.fetch,
      mode: "apply",
      model: MODEL,
      regenerate: false,
      text: SENTENCE,
    });
    const stage: unknown = JSON.parse(await readFile(voicePath("pl", "voice.stage.json"), "utf8"));

    expect(bought.ok ? bought.data : bought.error.message).toMatchObject({
      characters: [...SENTENCE].length,
      paidCalls: 1,
      state: "published",
    });
    expect(transport.calls).toHaveLength(1);
    expect(stage).toMatchObject({
      artifacts: {
        sample: {
          inputs: [
            {
              path: relative("pl", "voice.json"),
              sha256: await digest(voicePath("pl", "voice.json")),
            },
          ],
          outputs: [
            {
              path: relative("pl", "sample.wav"),
              sha256: await digest(voicePath("pl", "sample.wav")),
            },
          ],
          producer: { kind: "model", model: `${MODEL} / voice ${VOICE_PL}` },
          review: { status: "pending" },
          status: "completed",
        },
      },
      stage: "voice",
    });
  });

  /** Nothing retries by itself: a second charge needs --regenerate. */
  it("should buy nothing when a sample exists and no --regenerate was given", async () => {
    const transport = provider();
    const again = await generateSample({
      apiKey: KEY,
      characterId: CHARACTER,
      fetch: transport.fetch,
      language: "pl",
      mode: "apply",
      model: MODEL,
      projectId: PROJECT,
      regenerate: false,
      text: "Zupełnie inne zdanie.",
      workspace,
    });

    expect(again.ok ? again.data : again.error.message).toMatchObject({
      characters: 0,
      paidCalls: 0,
      state: "skipped",
    });
    expect(transport.calls).toHaveLength(0);
  });
});

/**
 * Approval is bound to bytes. A recorded "approved" over a sample whose bytes
 * changed is not an approval, it is a stale claim, so `check` stops counting it
 * the moment the file differs, and counts it again when the bytes come back.
 */
describe("approveVoice", () => {
  const scope = { characterId: CHARACTER, language: "pl", projectId: PROJECT };

  it("should bind the approval to the sample's sha256", async () => {
    const approved = await approveVoice({
      ...scope,
      mode: "apply",
      note: null,
      reviewer: "fixture",
      workspace,
    });
    const stage = JSON.parse(await readFile(voicePath("pl", "voice.stage.json"), "utf8")) as {
      artifacts: { sample: { outputs: { sha256: string }[]; review: unknown } };
    };

    expect(approved.ok ? approved.data.approved : approved.error.message).toBe(true);
    expect(stage.artifacts.sample.review).toMatchObject({
      reviewer: "fixture",
      status: "approved",
    });
    expect(stage.artifacts.sample.outputs[0]?.sha256).toBe(
      await digest(voicePath("pl", "sample.wav"))
    );
  });

  it("should stop counting the approval once the sample's bytes change", async () => {
    const sample = voicePath("pl", "sample.wav");
    const bytes = await readFile(sample);

    await writeFile(sample, wav({ seconds: 2 }));

    const changed = await checkVoice({ ...scope, workspace });

    await writeFile(sample, bytes);

    const restored = await checkVoice({ ...scope, workspace });

    expect(changed.ok ? changed.data.approved : changed.error.message).toBe(false);
    expect(changed.ok ? changed.data.problems : []).toContainEqual(
      expect.stringContaining("nie zgadza się z zapisanym hashem")
    );
    expect(restored.ok ? restored.data.approved : restored.error.message).toBe(true);
  });
});

/**
 * Where a decision lives decides what changing it lapses. The voice of one
 * language is one file, recorded by that language's sample alone, so choosing
 * another Polish voice lapses the Polish sample and leaves the English one,
 * and the decision says so rather than leaving it to the next check.
 */
describe("setVoice after an approved sample", () => {
  const VOICE_EN = "EXAVITQu4vr4xnSDxMaL";
  const OTHER_PL = "TxGEqnHWrfWFTfGW9XjX";

  it("should lapse that language's sample and leave the other language's standing", async () => {
    const transport = provider();
    const en = { characterId: CHARACTER, language: "en", projectId: PROJECT, workspace };
    const pl = { ...en, language: "pl" };

    await setVoice({ ...en, mode: "apply", voiceId: VOICE_EN });
    await generateSample({
      ...en,
      apiKey: KEY,
      fetch: transport.fetch,
      mode: "apply",
      model: MODEL,
      regenerate: false,
      text: "I am not afraid of the storm.",
    });
    await approveVoice({ ...en, mode: "apply", note: null, reviewer: "fixture" });

    const decided = await setVoice({ ...pl, mode: "apply", voiceId: OTHER_PL });
    const lapsed = await checkVoice(pl);
    const standing = await checkVoice(en);

    expect(decided.ok ? decided.data.problems : []).toContainEqual(
      expect.stringContaining("zgoda na próbkę wygasła")
    );
    expect(lapsed.ok ? lapsed.data.sample : null).toMatchObject({
      approved: false,
      voiceChanged: true,
    });
    expect(standing.ok ? standing.data.approved : standing.error.message).toBe(true);
  });

  it("should refuse to approve a sample read in the voice that was replaced", async () => {
    const refused = await approveVoice({
      characterId: CHARACTER,
      language: "pl",
      mode: "apply",
      note: null,
      projectId: PROJECT,
      reviewer: "fixture",
      workspace,
    });

    expect(refused.ok ? "approved" : refused.error.message).toContain("--regenerate");
  });
});

/** Every refusal happens before the network, and says what would unblock it. */
describe("refusals", () => {
  it("should refuse to pay without a key, and send nothing", async () => {
    const transport = provider();
    const refused = await generateSample({
      apiKey: null,
      characterId: CHARACTER,
      fetch: transport.fetch,
      language: "pl",
      mode: "apply",
      model: MODEL,
      projectId: PROJECT,
      regenerate: true,
      text: SENTENCE,
      workspace,
    });

    expect(refused.ok ? "paid" : refused.error.message).toContain("ELEVENLABS_API_KEY");
    expect(transport.calls).toHaveLength(0);
  });

  it("should name a character the roster does not hold, rather than a missing voice", async () => {
    const refused = await setVoice({
      characterId: "ewka",
      language: "pl",
      mode: "apply",
      projectId: PROJECT,
      voiceId: VOICE_PL,
      workspace,
    });

    expect(refused.ok ? "written" : refused.error.message).toContain("nie jest w obsadzie");
  });
});
