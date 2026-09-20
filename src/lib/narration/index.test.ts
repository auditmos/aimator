import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  API_KEY,
  EPISODE,
  makeCut,
  makeUpstream,
  muxer,
  NARRATION,
  PROJECT,
  wav,
} from "../../test/fixture.js";
import { readStage0Inputs } from "../project/index.js";
import { validateShotList } from "../shot-list/index.js";
import { episodePaths, projectPaths, resolveWorkspace, type Workspace } from "../workspace.js";
import {
  approveMix,
  approveNarration,
  checkNarration,
  generateMix,
  generateNarration,
  readDirection,
  setDirection,
  validateNarration,
} from "./index.js";

/**
 * Stage 9's script, through the module entry.
 *
 * The one rule worth more than the rest is that an utterance is **lifted, never
 * invented**: the narrator's sentences already exist in the approved shot list,
 * and this validator proves that each line in the script is one of them. That
 * is what makes the script a derivation rather than a second version of the
 * same truth, and it is what stops stage 9 from putting words in the film that
 * nobody approved.
 */

const VOICE = "21m00Tcm4TlvDq8ikWAM";

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

/** The approved plan as data, which is what the validator judges a script against. */
async function plan() {
  const stage0 = await readStage0Inputs({ episodeId: EPISODE, projectId: PROJECT, workspace });

  if (!stage0.ok) {
    throw stage0.error;
  }

  const project = projectPaths(workspace, PROJECT);
  const episode = project.ok ? episodePaths(project.data, EPISODE) : null;

  if (!(project.ok && episode?.ok)) {
    throw new Error("nie ma ścieżek odcinka");
  }

  const verdict = validateShotList({
    cast: stage0.data.cast,
    screenplay: await readFile(episode.data.screenplay, "utf8"),
    settings: { ...stage0.data.settings, maxClipSeconds: 15 },
    text: await readFile(episode.data.shotList, "utf8"),
  });

  if (!verdict.ok) {
    throw verdict.error;
  }

  return verdict.data;
}

/** A script the validator accepts, so each test can break exactly one thing. */
function script(lines: readonly string[]): string {
  return [
    "## Plan",
    "",
    "Narrator prowadzi odcinek trzema zdaniami, poza kwestiami postaci.",
    "",
    "## Lines",
    "",
    ...lines,
    "## Review",
    "",
    "Każda kwestia pochodzi z pola Audio swojego ujęcia.",
    "",
  ].join("\n");
}

function line(id: string, shot: string, at: string, text: string): readonly string[] {
  return [`### ${id} | ${shot} | ${at}`, "", text, ""];
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aimator-ws-"));
  scratch = await mkdtemp(join(tmpdir(), "aimator-src-"));
  const resolved = resolveWorkspace(root);
  workspace = resolved.ok ? resolved.data : { root: "" };

  await upstream(VOICE);
});

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
        subject: "Living room — evening",
      },
    ],
    review: "Do rozstrzygnięcia: skala alpaki.",
  });
}

/** The whole text pipeline, with or without a narrator cast into it. */
function upstream(voiceId?: string): Promise<void> {
  return makeUpstream({
    answer: answer(),
    approvePackage: true,
    narration: true,
    root,
    scratch,
    workspace,
    ...(voiceId === undefined ? {} : { voiceId }),
  });
}

/**
 * The same episode with nobody cast as narrator.
 *
 * Rebuilt rather than un-set, because `project.json` is a recorded input of
 * every stage below it: removing the voice after the fact would be testing
 * input drift instead of the gate.
 */
async function uncast(): Promise<void> {
  await rm(root, { force: true, recursive: true });
  await upstream();
}

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
  await rm(scratch, { force: true, recursive: true });
});

describe("validateNarration", () => {
  it("should return the lines as data, with the bill in characters", async () => {
    const shotList = await plan();
    const verdict = validateNarration({
      shotList,
      text: script([
        ...line("N01", "U01", "2s", NARRATION.U01),
        ...line("N02", "U04", "22s", NARRATION.U04),
      ]),
    });

    expect(verdict.ok ? verdict.data.lines.map((one) => one.id) : null).toEqual(["N01", "N02"]);
    expect(verdict.ok ? verdict.data.lines[0]?.atSeconds : null).toBe(2);
    expect(verdict.ok ? verdict.data.totalCharacters : null).toBe(
      [...NARRATION.U01].length + [...NARRATION.U04].length
    );
  });

  /**
   * The rule the module stands on. A model that wrote a better sentence than
   * the screenplay's would be writing the film, which is stage 1's job — and
   * the refusal says so rather than merely refusing.
   */
  it("should refuse a sentence the shot list does not contain", async () => {
    const shotList = await plan();
    const verdict = validateNarration({
      shotList,
      text: script(line("N01", "U01", "2s", "Ewa poczuła, że świat się kończy")),
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.error.message).toContain("etapu 1");
  });

  /** The same words under the wrong shot are still words nobody put there. */
  it("should refuse a sentence lifted from a different shot", async () => {
    const shotList = await plan();
    const verdict = validateNarration({
      shotList,
      text: script(line("N01", "U01", "2s", NARRATION.U04)),
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.error.message).toContain("podnoszona");
  });

  it("should accept a line wrapped across two source lines", async () => {
    const shotList = await plan();
    const text: string = NARRATION.U01;
    const wrapped = text.replace(" ", "\n");
    const verdict = validateNarration({
      shotList,
      text: script(line("N01", "U01", "2s", wrapped)),
    });

    expect(verdict.ok ? verdict.data.lines[0]?.text : null).toBe(text);
  });

  it("should refuse an anchor outside the shot that claims it", async () => {
    const shotList = await plan();
    const verdict = validateNarration({
      shotList,
      text: script(line("N01", "U01", "12s", NARRATION.U01)),
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.error.message).toContain("poza ujęciem");
  });

  it("should refuse a shot the plan does not have", async () => {
    const shotList = await plan();
    const verdict = validateNarration({
      shotList,
      text: script(line("N01", "U99", "2s", NARRATION.U01)),
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.error.message).toContain("nie istnieje");
  });

  /**
   * Narration runs forward, like the film. Two lines out of order would mean a
   * mix whose second sentence starts before its first, and no arithmetic
   * downstream straightens that out.
   */
  it("should refuse two lines that do not run forward", async () => {
    const shotList = await plan();
    const verdict = validateNarration({
      shotList,
      text: script([
        ...line("N01", "U04", "22s", NARRATION.U04),
        ...line("N02", "U01", "2s", NARRATION.U01),
      ]),
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.error.message).toContain("do przodu");
  });

  it("should refuse numbering that skips", async () => {
    const shotList = await plan();
    const verdict = validateNarration({
      shotList,
      text: script([
        ...line("N01", "U01", "2s", NARRATION.U01),
        ...line("N03", "U04", "22s", NARRATION.U04),
      ]),
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.error.message).toContain("N02");
  });

  it("should refuse a script with no lines at all", async () => {
    const shotList = await plan();
    const verdict = validateNarration({ shotList, text: script([]) });

    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.error.message).toContain("ani jednej kwestii");
  });

  it("should refuse a missing section", async () => {
    const shotList = await plan();
    const text = script(line("N01", "U01", "2s", NARRATION.U01)).replace("## Review", "## Notes");
    const verdict = validateNarration({ shotList, text });

    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.error.message).toContain("Review");
  });
});

/**
 * Stage 9 end to end, through the module entry.
 *
 * The transports are instrumented rather than replaced by the fixture's,
 * because for a stage that bills per call the count *is* the assertion — and
 * here there is a second one the other stages never needed: this provider
 * charges per character, so what a preview promises has to be both.
 */

/** The script the model would return, lifting two of the shots' own sentences. */
function answerScript(lines: readonly string[] = SCRIPT_LINES): string {
  return [
    "## Plan",
    "",
    "Narrator otwiera i zamyka odcinek.",
    "",
    "## Lines",
    "",
    ...lines,
    "## Review",
    "",
    "Obie kwestie pochodzą z pola Audio swoich ujęć.",
    "",
  ].join("\n");
}

const SCRIPT_LINES = [
  "### N01 | U01 | 2s",
  "",
  NARRATION.U01,
  "",
  "### N02 | U04 | 22s",
  "",
  NARRATION.U04,
  "",
];

interface Calls {
  readonly fetch: typeof fetch;
  /**
   * Every speech request, in order: what was said, how long it was, and the
   * whole body as the provider received it. The body is kept because half of
   * what stage 9 decides never appears in the text — how the narrator performs,
   * what is said either side, and which seed was asked for.
   */
  readonly spoken: { characters: number; sent: Record<string, unknown>; text: string }[];
  readonly text: number[];
}

/**
 * One transport for both providers, counting each separately.
 *
 * Stage 9 is the first stage to buy from two, so a test that counted "calls"
 * would be counting two different bills added together.
 */
function transport(options: { readonly script?: string; readonly seconds?: number } = {}): Calls {
  const { script: lifted = answerScript(), seconds = 1 } = options;
  const spoken: { characters: number; sent: Record<string, unknown>; text: string }[] = [];
  const text: number[] = [];

  return {
    fetch: ((url: string | URL, init?: RequestInit) => {
      const href = String(url);

      if (href.includes("elevenlabs")) {
        const sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const said = typeof sent.text === "string" ? sent.text : "";

        spoken.push({ characters: [...said].length, sent, text: said });

        return Promise.resolve(
          new Response(wav({ seconds }), {
            headers: { "content-type": "audio/wav" },
            status: 200,
          })
        );
      }

      text.push(1);

      return Promise.resolve(
        Response.json({
          id: `resp_${text.length}`,
          output: [
            {
              content: [{ text: lifted, type: "output_text" }],
              role: "assistant",
              type: "message",
            },
          ],
          status: "completed",
        })
      );
    }) as unknown as typeof fetch,
    spoken,
    text,
  };
}

function generate(calls: Calls, overrides: Partial<Parameters<typeof generateNarration>[0]> = {}) {
  return generateNarration({
    artifacts: [],
    episodeId: EPISODE,
    fetch: calls.fetch,
    maxOutputTokens: 8000,
    mode: "apply",
    model: "gpt-6-astra",
    openAiKey: API_KEY,
    projectId: PROJECT,
    regenerate: false,
    voiceKey: API_KEY,
    voiceModel: "eleven_multilingual_v2",
    workspace,
    ...overrides,
  });
}

function mix(overrides: Partial<Parameters<typeof generateMix>[0]> = {}) {
  return generateMix({
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

async function approveScript(): Promise<void> {
  const result = await approveNarration({
    artifacts: ["script"],
    episodeId: EPISODE,
    mode: "apply",
    note: null,
    projectId: PROJECT,
    reviewer: "test",
    workspace,
  });

  expect(result.ok ? null : result.error.message).toBe(null);
}

async function approveLines(ids: readonly string[] = ["N01", "N02"]): Promise<void> {
  const result = await approveNarration({
    artifacts: ids,
    episodeId: EPISODE,
    mode: "apply",
    note: null,
    projectId: PROJECT,
    reviewer: "test",
    workspace,
  });

  expect(result.ok ? null : result.error.message).toBe(null);
}

describe("generateNarration", () => {
  /**
   * The preview's whole job here is the bill, and the bill is not the call
   * count: this provider charges per character of what it is handed.
   */
  it("should state both the calls and the characters before spending", async () => {
    const calls = transport();
    const first = await generate(calls, { mode: "dry-run" });

    expect(first.ok ? first.data.script.state : null).toBe("planned");
    expect(calls.text).toHaveLength(0);
    expect(calls.spoken).toHaveLength(0);

    await generate(calls);
    await approveScript();

    const second = await generate(calls, { mode: "dry-run" });

    expect(second.ok ? second.data.calls : null).toBe(2);
    expect(second.ok ? second.data.characters : null).toBe(
      [...NARRATION.U01].length + [...NARRATION.U04].length
    );
    expect(calls.spoken).toHaveLength(0);
  });

  it("should refuse to spend without a narrator anybody cast", async () => {
    await uncast();
    const calls = transport();
    const result = await generate(calls, { mode: "dry-run" });

    expect(result.ok ? result.data.problems.join(" ") : null).toContain("nie obsadził narratora");
    expect(calls.text).toHaveLength(0);
  });

  /**
   * Accepting the script is what authorises buying every sentence in it, so
   * until somebody has read it nothing may be bought — and the run says so
   * rather than quietly doing nothing.
   */
  it("should buy nothing until a human has read the script", async () => {
    const calls = transport();

    await generate(calls);
    const waiting = await generate(calls);

    expect(calls.text).toHaveLength(1);
    expect(calls.spoken).toHaveLength(0);
    expect(waiting.ok ? waiting.data.nextStep : null).toContain("--artifact script");
  });

  it("should buy each utterance once, sending the film's own words", async () => {
    const calls = transport();

    await generate(calls);
    await approveScript();
    const bought = await generate(calls);

    expect(calls.spoken.map((one) => one.text)).toEqual([NARRATION.U01, NARRATION.U04]);
    expect(bought.ok ? bought.data.calls : null).toBe(2);

    // Running again buys nothing: the recordings are already on disk.
    await generate(calls);
    expect(calls.spoken).toHaveLength(2);
  });

  /**
   * The script is a recorded input of every line bought from it, so a rewritten
   * script is caught before a recording is attached to a sentence it does not
   * contain. The words in the film are the words somebody approved.
   */
  it("should refuse to spend on a script that no longer validates", async () => {
    const calls = transport({
      script: answerScript(["### N01 | U01 | 2s", "", "Zdanie z powietrza", ""]),
    });
    const result = await generate(calls);

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain("etapu 1");
    expect(calls.spoken).toHaveLength(0);
  });
});

describe("generateMix", () => {
  async function bought(options: { readonly seconds?: number } = {}): Promise<void> {
    const calls = transport(options);

    await generate(calls);
    await approveScript();
    await generate(calls);
    await approveLines();
  }

  /**
   * A gate is reported by a preview, never thrown at it. `--dry-run` exists to
   * answer "would this work", and an obstacle it died on is an answer nobody
   * can read beside the others.
   */
  it("should report a missing script rather than fail the preview", async () => {
    await makeCut({ root, track: "gpt-image", workspace });

    const result = await mix({ mode: "dry-run" });

    expect(result.ok ? result.data.state : null).toBe("blocked");
    expect(result.ok ? result.data.problems.join(" ") : null).toContain("nie ma skryptu");
    expect(result.ok ? result.data.actualSeconds : null).toBeGreaterThan(0);
  });

  it("should refuse to mix lines nobody has listened to", async () => {
    await makeCut({ root, track: "gpt-image", workspace });
    const calls = transport();

    await generate(calls);
    await approveScript();
    await generate(calls);

    const result = await mix();

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain("ocenę człowieka");
  });

  it("should lay the lines down and leave episode.mp4 untouched", async () => {
    await makeCut({ root, track: "gpt-image", workspace });
    await bought();

    const cut = join(root, `projects/${PROJECT}/episodes/${EPISODE}/gpt-image/episode.mp4`);
    const before = await readFile(cut);
    const result = await mix();

    expect(result.ok ? result.data.state : null).toBe("published");
    expect(await readFile(cut)).toEqual(before);
    expect(
      await readFile(join(root, `projects/${PROJECT}/episodes/${EPISODE}/gpt-image/narrated.mp4`))
    ).toBeDefined();
  });

  /**
   * The words are shared and the mix is not: both tracks lay down the same two
   * recordings, and neither buys a second copy of them.
   */
  it("should mix both tracks from one set of recordings", async () => {
    await makeCut({ root, track: "gpt-image", workspace });
    await makeCut({ root, track: "seedream", workspace });
    await bought();

    expect((await mix({ track: "gpt-image" })).ok).toBe(true);
    expect((await mix({ track: "seedream" })).ok).toBe(true);
  });

  /**
   * Stage 7's refusal rather than stage 8's acceptance: the bytes are published
   * as they came, but where a line sits is a plan a human approved, so a line
   * that would talk over the next one stops the mix and names the remedy.
   */
  it("should refuse a line that would talk over the next one", async () => {
    await makeCut({ root, track: "gpt-image", workspace });
    // Each recording runs 25 s, so the line anchored at 2 s is still speaking
    // when the one anchored at 22 s is due to start.
    await bought({ seconds: 25 });

    const result = await mix();

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain("sam przez siebie");
  });

  /** The declared sound mode nothing in this pipeline fulfils, stated every time. */
  it("should report the music and effects nobody produces", async () => {
    await makeCut({ root, track: "gpt-image", workspace });
    await bought();

    const result = await mix();

    expect(result.ok ? result.data.problems.join(" ") : null).toContain("muzyki ani efektów");
  });
});

/**
 * How the narrator performs — stage 9's own decision, in stage 9's own file.
 *
 * The bug this answers was not in any line of code. Stage 9 had nowhere to say
 * how the narrator reads, so every call went out on the provider's defaults,
 * and those defaults are `stability: 0.5` with `style: 0` — which the provider
 * itself describes as trending monotone. The recordings sounded flat and no
 * amount of re-buying would have changed that, because nothing in the pipeline
 * was ever asked the question.
 */
describe("narration direction", () => {
  function direction(overrides: Partial<Parameters<typeof setDirection>[0]> = {}) {
    return setDirection({
      mode: "apply",
      projectId: PROJECT,
      similarityBoost: null,
      speakerBoost: null,
      speed: null,
      stability: null,
      style: null,
      workspace,
      ...overrides,
    });
  }

  /**
   * An undecided project reads as the provider's documented defaults rather
   * than as a refusal. Rule 7 binds decisions that *have* no default; these
   * five have one, which is the same reading that lets `AIMATOR_FFMPEG` be
   * optional. What the stage must not do is stay silent about them.
   */
  it("should start at the provider's own defaults, recording nothing", async () => {
    const result = await readDirection({ projectId: PROJECT, workspace });

    expect(result.ok ? result.data.delivery.stability : null).toBe(0.5);
    expect(result.ok ? result.data.delivery.style : null).toBe(0);
    expect(result.ok ? result.data.input : "missing").toBeNull();
  });

  /**
   * Five independent decisions, so a command given one of them leaves the other
   * four alone. Replacing the file wholesale would silently undo a choice
   * nobody revisited, which is the failure `withRecord` exists to prevent one
   * level down.
   */
  it("should merge a single knob over what was decided before", async () => {
    await direction({ stability: 0.35 });
    await direction({ style: 0.4 });

    const result = await readDirection({ projectId: PROJECT, workspace });

    expect(result.ok ? result.data.delivery.stability : null).toBe(0.35);
    expect(result.ok ? result.data.delivery.style : null).toBe(0.4);
    expect(result.ok ? result.data.input : null).not.toBeNull();
  });

  it("should refuse a speed the provider does not accept", async () => {
    const result = await direction({ speed: 2 });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain("zakres");
  });

  /** It says what it lapses rather than leaving it to be discovered. */
  it("should warn that recordings bought under the old reading are stale", async () => {
    const result = await direction({ stability: 0.3 });

    expect(result.ok ? result.data.problems.join(" ") : null).toContain("--regenerate");
  });

  /**
   * The whole point of the separate file: a knob somebody is expected to turn
   * must not lapse approvals whose bytes it never touched. `project.json` is a
   * recorded input of nearly every artifact in the workspace; this one is a
   * recorded input of the recordings it actually produced.
   */
  it("should not touch stage 0's file", async () => {
    const paths = projectPaths(workspace, PROJECT);
    const before = await readFile(paths.ok ? paths.data.file : "", "utf8");

    await direction({ stability: 0.3, style: 0.45 });

    expect(await readFile(paths.ok ? paths.data.file : "", "utf8")).toBe(before);
  });
});

/**
 * What a paid speech call actually carries.
 *
 * Half of what stage 9 decides never appears in the text: how the narrator
 * performs, what is said either side of this line, and which seed was asked
 * for. None of it is visible in the script or in the published WAV, so it is
 * asserted where it is observable — on the request itself.
 */
describe("what stage 9 puts on the wire", () => {
  async function buy(): Promise<Calls> {
    const calls = transport();

    await generate(calls);
    await approveScript();
    await generate(calls);

    return calls;
  }

  function settingsOf(calls: Calls, index: number): Record<string, unknown> {
    return (calls.spoken[index]?.sent.voice_settings ?? {}) as Record<string, unknown>;
  }

  /**
   * The provider's defaults are sent explicitly rather than by omission. An
   * archive that leaves them out cannot answer what produced these bytes, and
   * that is the one question the archive exists for — the defaults are the
   * provider's to change, not ours to assume.
   */
  it("should state the provider's defaults rather than stay silent", async () => {
    const calls = await buy();

    expect(settingsOf(calls, 0).stability).toBe(0.5);
    expect(settingsOf(calls, 0).style).toBe(0);
    expect(settingsOf(calls, 0).use_speaker_boost).toBe(true);
  });

  it("should send the reading somebody decided", async () => {
    await setDirection({
      mode: "apply",
      projectId: PROJECT,
      similarityBoost: null,
      speakerBoost: null,
      speed: 0.95,
      stability: 0.35,
      style: 0.4,
      workspace,
    });

    const calls = await buy();

    expect(settingsOf(calls, 0).stability).toBe(0.35);
    expect(settingsOf(calls, 0).style).toBe(0.4);
    expect(settingsOf(calls, 0).speed).toBe(0.95);
  });

  /**
   * The other half of why the first take sounded flat: every line was bought as
   * if it were the only sentence in the film. The neighbours are derived from
   * the script rather than stored — they *are* the neighbouring lines, so a
   * second copy of them would drift the first time somebody re-lifts it.
   */
  it("should hand each line what is said either side of it", async () => {
    const calls = await buy();

    expect(calls.spoken[0]?.sent.previous_text).toBeNull();
    expect(calls.spoken[0]?.sent.next_text).toBe(NARRATION.U04);
    expect(calls.spoken[1]?.sent.previous_text).toBe(NARRATION.U01);
    expect(calls.spoken[1]?.sent.next_text).toBeNull();
  });

  /**
   * A seed per attempt, not per sentence. Re-deriving a recorded attempt has to
   * ask for the same reading, but `--regenerate` exists because somebody did
   * not like what came back — and a seed fixed to the sentence would sell them
   * the same reading twice.
   */
  it("should ask for a seed, and a different one per attempt", async () => {
    const calls = await buy();

    expect(typeof calls.spoken[0]?.sent.seed).toBe("number");
    expect(calls.spoken[0]?.sent.seed).not.toBe(calls.spoken[1]?.sent.seed);
  });

  /**
   * The reading is half of what produced these bytes, so it is recorded beside
   * the script. That is also what keeps the decision cheap to revisit: it
   * lapses the recordings it made and nothing above them.
   */
  it("should record the reading as an input of every line it bought", async () => {
    await setDirection({
      mode: "apply",
      projectId: PROJECT,
      similarityBoost: null,
      speakerBoost: null,
      speed: null,
      stability: 0.3,
      style: null,
      workspace,
    });
    await buy();

    const project = projectPaths(workspace, PROJECT);
    const episode = project.ok ? episodePaths(project.data, EPISODE) : null;
    const stage = JSON.parse(
      await readFile(episode?.ok === true ? episode.data.soundtrackStage : "", "utf8")
    ) as { artifacts: Record<string, { inputs: { path: string }[] } | undefined> };
    const inputsOf = (key: string): readonly string[] =>
      (stage.artifacts[key]?.inputs ?? []).map((one) => one.path);

    expect(inputsOf("N01")).toContain(`projects/${PROJECT}/narration.json`);
    // The script's own record is not bound to it: how a line is read changes
    // nothing about which sentences the model lifted.
    expect(inputsOf("script")).not.toContain(`projects/${PROJECT}/narration.json`);
  });

  /** Counted beside the bill, because the provider does not say whether it charges. */
  it("should count the context apart from the bill", async () => {
    const calls = transport();

    await generate(calls);
    await approveScript();

    const result = await generate(calls, { mode: "dry-run" });

    expect(result.ok ? result.data.characters : null).toBe(
      [...NARRATION.U01].length + [...NARRATION.U04].length
    );
    expect(result.ok ? result.data.contextCharacters : null).toBe(
      [...NARRATION.U01].length + [...NARRATION.U04].length
    );
  });
});

/**
 * The gap `changedInputs` cannot see.
 *
 * A recording bought before anybody decided how the narrator reads holds no
 * entry for `narration.json` at all, so nothing drifts and nothing is reported.
 * Left alone, `check` would present a reading nobody chose as one somebody
 * approved — which is the exact failure the review exists to prevent.
 */
describe("checkNarration after the reading changes", () => {
  it("should report lines bought before anybody decided how it reads", async () => {
    const calls = transport();

    await generate(calls);
    await approveScript();
    await generate(calls);
    await approveLines();

    const before = await checkNarration({ episodeId: EPISODE, projectId: PROJECT, workspace });

    expect(before.ok ? before.data.lines.every((one) => one.approved) : null).toBe(true);

    await setDirection({
      mode: "apply",
      projectId: PROJECT,
      similarityBoost: null,
      speakerBoost: null,
      speed: null,
      stability: 0.3,
      style: 0.45,
      workspace,
    });

    const after = await checkNarration({ episodeId: EPISODE, projectId: PROJECT, workspace });

    expect(after.ok ? after.data.lines.every((one) => one.approved) : null).toBe(false);
    expect(after.ok ? after.data.problems.join(" ") : null).toContain("domyślnych ustawieniach");
  });
});

/**
 * What a preview says to do next, once there is nothing left to mix.
 *
 * A dry run that points at the command it just told you is finished sends a
 * person back round a loop they have already closed — and here it points past
 * the one thing stage 9 actually needs from them, which is listening to the
 * narration over the picture and saying yes.
 */
describe("the next step a mix preview names", () => {
  it("should point at the approval once a mix exists", async () => {
    const calls = transport();

    await makeCut({ root, track: "gpt-image", workspace });
    await generate(calls);
    await approveScript();
    await generate(calls);
    await approveLines();
    await mix();

    const preview = await mix({ mode: "dry-run" });

    expect(preview.ok ? preview.data.nextStep : "").toContain("approve");
  });

  it("should say the film is accepted once somebody has accepted it", async () => {
    const calls = transport();

    await makeCut({ root, track: "gpt-image", workspace });
    await generate(calls);
    await approveScript();
    await generate(calls);
    await approveLines();
    await mix();
    await approveMix({
      artifacts: [],
      episodeId: EPISODE,
      mode: "apply",
      note: null,
      projectId: PROJECT,
      reviewer: "test",
      track: "gpt-image",
      workspace,
    });

    const preview = await mix({ mode: "dry-run" });

    expect(preview.ok ? preview.data.nextStep : "").toContain("przyjęty");
  });
});
