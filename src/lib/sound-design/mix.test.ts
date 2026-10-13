import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  API_KEY,
  DIALOGUE,
  EPISODE,
  makeCut,
  makeNarration,
  makeSoundDesign,
  makeUpstream,
  makeVoices,
  muxer,
  PROJECT,
  VOICE,
  wav,
} from "../../test/fixture.js";
import { approveDialogue, generateDialogue } from "../dialogue/index.js";
import { resolveWorkspace, type Workspace } from "../workspace.js";
import { checkMaster, checkSoundDesign, generateMaster } from "./index.js";

/**
 * Stage 10's full mix when the characters speak, through the module entry.
 *
 * Assumptions this file encodes, stated before its first test:
 *
 * - **Dialogue is one more kind of speech, not a second mix.** Stage 11's
 *   accepted lines reach the engine in the same `speech` list as the
 *   narrator's, so the music steps back under them by the same ducking.
 * - **The gate follows the declared mode.** A mode with dialogue waits for
 *   every line of the script to be accepted; only a mode with a narrator waits
 *   for `narrated.mp4`, so `dialogue` alone never asks stage 9 for anything.
 * - **Any two utterances that would sound at once are refused**, two lines or
 *   a line and the narration, on this track's own clock, and so is one that
 *   runs past the film. The recordings are never moved or stretched.
 * - **Only the transports and the engine are faked**: the providers answer
 *   with bytes the verdicts read, and the muxer is the fixture's, spied on.
 */

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

/** The manifest the fixture deliberately does not own: two clips, one reference. */
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

/** An episode whose cast speaks, cut on one track, with its stems accepted. */
async function episode(): Promise<void> {
  await makeUpstream({
    answer: answer(),
    approvePackage: true,
    dialogue: true,
    root,
    scratch,
    workspace,
  });
  await makeCut({ root, track: "gpt-image", workspace });
  await makeSoundDesign({ workspace });
}

/**
 * A dialogue script lifting every attributed line once, anchored clear of the
 * fixture's narrator, who speaks at 2s and 22s for a second each.
 */
function script(anchors: readonly [string, string, string] = ["5s", "16s", "25s"]): string {
  return [
    "## Plan\n\nEwa pyta dwa razy, tata odpowiada raz.\n",
    "## Lines\n",
    `### D01 | U01 | ewa | ${anchors[0]}\n\n${DIALOGUE.U01.text}\n`,
    `### D02 | U03 | ewa | ${anchors[1]}\n\n${DIALOGUE.U03.text}\n`,
    `### D03 | U04 | tata | ${anchors[2]}\n\n${DIALOGUE.U04.text}\n`,
    "## Review\n\nKażda kwestia pochodzi z pola Audio swojego ujęcia.\n",
  ].join("\n");
}

/**
 * Stage 11 run for real: the voices cast, the script bought and accepted, the
 * lines bought `seconds` long, and the ones named in `accept` accepted.
 */
async function speak(
  options: {
    readonly accept?: readonly string[];
    readonly script?: string;
    readonly seconds?: number;
  } = {}
): Promise<void> {
  const { accept = ["D01", "D02", "D03"], script: written = script(), seconds = 1 } = options;
  const provider = ((url: string | URL) =>
    String(url).includes("elevenlabs")
      ? Promise.resolve(
          new Response(wav({ seconds }), { headers: { "content-type": "audio/wav" }, status: 200 })
        )
      : Promise.resolve(
          Response.json({
            id: "resp_1",
            output: [
              {
                content: [{ text: written, type: "output_text" }],
                role: "assistant",
                type: "message",
              },
            ],
            status: "completed",
          })
        )) as unknown as typeof fetch;
  const paid = {
    apiKey: API_KEY,
    artifacts: [],
    episodeId: EPISODE,
    fetch: provider,
    maxOutputTokens: 8000,
    mode: "apply",
    model: "gpt-6-astra",
    projectId: PROJECT,
    regenerate: false,
    voiceKey: API_KEY,
    voiceModel: "eleven_multilingual_v2",
    workspace,
  } as const;
  const approve = (artifacts: readonly string[]) =>
    approveDialogue({
      artifacts,
      episodeId: EPISODE,
      mode: "apply",
      note: "ok",
      projectId: PROJECT,
      reviewer: "test",
      workspace,
    });

  await makeVoices({ workspace });
  await generateDialogue(paid);
  await approve(["script"]);
  await generateDialogue(paid);

  if (accept.length > 0) {
    await approve(accept);
  }
}

function master(overrides: Partial<Parameters<typeof generateMaster>[0]> = {}) {
  return generateMaster({
    artifacts: [],
    episodeId: EPISODE,
    mode: "apply",
    mux: muxer(),
    projectId: PROJECT,
    regenerate: false,
    track: "gpt-image",
    workspace,
    ...overrides,
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aimator-ws-"));
  scratch = await mkdtemp(join(tmpdir(), "aimator-src-"));
  const resolved = resolveWorkspace(root);
  workspace = resolved.ok ? resolved.data : { root: "" };
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
  await rm(scratch, { force: true, recursive: true });
});

describe("generateMaster with the cast speaking", { timeout: 45_000 }, () => {
  it("should refuse to mix a dialogue episode until every line is accepted, naming each", async () => {
    await episode();
    await speak({ accept: [] });
    const refusal = await master();
    const message = refusal.ok ? "" : refusal.error.message;

    expect(message).toContain("D01");
    expect(message).toContain("D02");
    expect(message).toContain("D03");
  });
});

describe("the full mix with the cast speaking, as the engine is told it", {
  timeout: 45_000,
}, () => {
  /** Captures the one call, so what the engine was told can be asserted. */
  function spy() {
    const seen: Parameters<ReturnType<typeof muxer>["master"]>[0][] = [];
    const real = muxer();

    return {
      mux: {
        ...real,
        master: (input: Parameters<typeof real.master>[0]) => {
          seen.push(input);

          return real.master(input);
        },
      },
      seen,
    };
  }

  it("should lay every accepted line in mixed.mp4 as speech, at its second of the film", async () => {
    await episode();
    await speak();
    const engine = spy();
    const result = await master({ mux: engine.mux });
    const [sent] = engine.seen;

    expect(result.ok ? result.data.state : result.error.message).toBe("published");
    expect(result.ok ? result.data.created.some((p) => p.endsWith("mixed.mp4")) : null).toBe(true);
    expect(sent?.speech.map((one) => one.path.split("/").slice(-3).join("/"))).toEqual([
      "dialogue/pl/D01.wav",
      "dialogue/pl/D02.wav",
      "dialogue/pl/D03.wav",
    ]);
    expect(sent?.speech.map((one) => one.atSeconds)).toEqual([5, 16, 25]);
  });

  /** Stage 9 never ran here, and a dialogue film has no narrated cut to wait for. */
  it("should not ask a dialogue episode for narrated.mp4", async () => {
    await episode();
    await speak();
    const preview = await master({ mode: "dry-run" });

    expect(preview.ok ? preview.data.problems : preview.error.message).toEqual([]);
    expect(preview.ok ? preview.data.state : null).toBe("planned");
  });

  it("should refuse two lines that would sound at once on this track, naming both", async () => {
    await episode();
    await speak({ script: script(["2s", "16s", "22s"]), seconds: 7 });
    const refusal = await master();

    expect(refusal.ok ? null : refusal.error.message).toContain(
      "D02 kończy się w 23s, a D03 zaczyna w 22s, dwie wypowiedzi brzmiałyby naraz"
    );
  });
});

describe("dialogue beside the narrator", { timeout: 45_000 }, () => {
  /** An episode with both voices: the narrator laid and accepted, the stems bought. */
  async function narrated(): Promise<void> {
    await makeUpstream({
      answer: answer(),
      approvePackage: true,
      dialogue: true,
      narration: true,
      root,
      scratch,
      voiceId: VOICE,
      workspace,
    });
    await makeCut({ root, track: "gpt-image", workspace });
    await makeNarration({ root, tracks: ["gpt-image"], workspace });
    await makeSoundDesign({ workspace });
  }

  it("should lay the narration and the dialogue side by side when they do not collide", async () => {
    await narrated();
    await speak();
    const result = await master();

    expect(
      result.ok
        ? result.data.sounds.filter((one) => one.kind === "speech").map((one) => one.id)
        : result.error.message
    ).toEqual(["N01", "N02", "D01", "D02", "D03"]);
  });

  it("should refuse a line that would sound over the narrator", async () => {
    await narrated();
    await speak({ script: script(["2s", "16s", "25s"]) });
    const refusal = await master();

    expect(refusal.ok ? null : refusal.error.message).toContain(
      "N01 kończy się w 3s, a D01 zaczyna w 2s, dwie wypowiedzi brzmiałyby naraz"
    );
  });
});

describe("checkSoundDesign with the cast speaking", { timeout: 45_000 }, () => {
  it("should stop reporting missing dialogue once every line is accepted", async () => {
    const scope = { episodeId: EPISODE, projectId: PROJECT, workspace };

    await episode();
    const before = await checkSoundDesign(scope);
    await speak();
    const after = await checkSoundDesign(scope);

    expect(before.ok ? before.data.notices.join(" ") : "").toContain("mowę postaci");
    expect(after.ok ? after.data.notices.join(" ") : "brak").not.toContain("mowę postaci");
  });
});

describe("checkMaster with the cast speaking", { timeout: 45_000 }, () => {
  /** The ladder reads this check, so it must refuse exactly what the mix refuses. */
  it("should name the lines the mix still waits for", async () => {
    await episode();
    await speak({ accept: ["D01"] });
    const status = await checkMaster({
      episodeId: EPISODE,
      projectId: PROJECT,
      track: "gpt-image",
      workspace,
    });
    const problems = status.ok ? status.data.problems.join("\n") : status.error.message;

    expect(problems).toContain("D02: kwestia dialogu nie ma ważnej zgody");
    expect(problems).toContain("D03: kwestia dialogu nie ma ważnej zgody");
    expect(problems).not.toContain("D01:");
  });
});
