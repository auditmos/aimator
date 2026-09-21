import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  API_KEY,
  EPISODE,
  makeCut,
  makeUpstream,
  mp3,
  muxer,
  PROJECT,
  wav,
} from "../../test/fixture.js";
import {
  approveMix,
  approveNarration,
  generateMix,
  generateNarration,
  type NarrationStatus,
} from "../narration/index.js";
import { readStage0Inputs } from "../project/index.js";
import { type ShotList, validateShotList } from "../shot-list/index.js";
import { episodePaths, projectPaths, resolveWorkspace, type Workspace } from "../workspace.js";
import {
  approveMaster,
  approveSoundDesign,
  checkMaster,
  checkSoundDesign,
  generateMaster,
  generateSoundDesign,
  setLevels,
  validateSoundDesign,
} from "./index.js";

/**
 * Stage 10's cue sheet, through the module entry.
 *
 * Stage 9 could prove its script honest mechanically: an utterance is lifted,
 * never invented, and every sentence has to occur word for word inside the
 * shot it names. **Stage 10 cannot, and this file is where that is faced.** A
 * music prompt is an *instruction*, so rule 9 writes it in English; the `Audio`
 * prose it comes from is *material*, so rule 9 forbids translating it. Copying
 * is therefore illegal in both directions and there is no verbatim match to
 * look for.
 *
 * What replaces it is stage 4's bargain, not stage 9's: **a wiring verdict
 * that never reads a prompt.** It proves that every shot of the plan was
 * accounted for, that nothing was invented for a shot that does not exist,
 * that the bed covers the film end to end, and that every length is one the
 * provider will actually render. What it cannot prove, whether the English
 * says what the Polish says, is what the human approves, exactly as a human
 * approves stage 4's prompts.
 */

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

/** The approved plan as data: four shots over thirty seconds, two clips. */
async function plan(): Promise<ShotList> {
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

/** A sheet the validator accepts, so each test can break exactly one thing. */
function sheet(
  options: { readonly effects?: readonly string[]; readonly music?: readonly string[] } = {}
): string {
  const {
    effects = [cue("E01", "U03", "16s | 3s", "Soft low thunder rolling in the distance.")],
    music = [
      cue(
        "M01",
        "U01,U02,U03,U04",
        "0-30s",
        "A warm, unhurried acoustic theme for a quiet evening room."
      ),
    ],
  } = options;

  return [
    "## Plan",
    "",
    "A quiet evening turning into a storm, scored warmly and never loudly.",
    "",
    "## Music",
    "",
    ...music,
    "## Effects",
    "",
    ...effects,
    "## Review",
    "",
    "Listen for the bed stepping back under the narrator.",
    "",
  ].join("\n");
}

function cue(id: string, shots: string, range: string, text: string): string {
  return [`### ${id} | ${shots} | ${range}`, "", text, ""].join("\n");
}

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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aimator-ws-"));
  scratch = await mkdtemp(join(tmpdir(), "aimator-src-"));
  const resolved = resolveWorkspace(root);
  workspace = resolved.ok ? resolved.data : { root: "" };

  await makeUpstream({
    answer: answer(),
    approvePackage: true,
    narration: true,
    root,
    scratch,
    voiceId: "21m00Tcm4TlvDq8ikWAM",
    workspace,
  });
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
  await rm(scratch, { force: true, recursive: true });
});

describe("validateSoundDesign", () => {
  it("should accept a sheet whose bed covers the film and whose effect sits in its shot", async () => {
    const verdict = validateSoundDesign({ shotList: await plan(), text: sheet() });

    expect(verdict.ok ? verdict.data.music.length : null).toBe(1);
    expect(verdict.ok ? verdict.data.effects.length : null).toBe(1);
  });

  /**
   * The unit this provider rates in. Stage 9 had to print characters beside
   * calls because the count of calls stopped being the bill; here it is
   * seconds of audio, for the same reason and with the same consequence, one
   * number would lie.
   */
  it("should total the seconds of audio the sheet will ask for", async () => {
    const verdict = validateSoundDesign({ shotList: await plan(), text: sheet() });

    expect(verdict.ok ? verdict.data.totalSeconds : null).toBe(33);
    expect(verdict.ok ? verdict.data.calls : null).toBe(2);
  });

  it("should refuse a bed that starts after the film does", async () => {
    const text = sheet({ music: [cue("M01", "U02,U03,U04", "5-30s", "A theme.")] });
    const verdict = validateSoundDesign({ shotList: await plan(), text });

    expect(verdict.ok ? null : verdict.error.message).toContain("0s");
  });

  it("should refuse a bed that stops before the film does", async () => {
    const text = sheet({ music: [cue("M01", "U01,U02,U03", "0-20s", "A theme.")] });
    const verdict = validateSoundDesign({ shotList: await plan(), text });

    expect(verdict.ok).toBe(false);
  });

  it("should refuse two beds that overlap", async () => {
    const text = sheet({
      music: [
        cue("M01", "U01,U02", "0-15s", "A calm theme."),
        cue("M02", "U02,U03,U04", "10-30s", "A storm theme."),
      ],
    });
    const verdict = validateSoundDesign({ shotList: await plan(), text });

    expect(verdict.ok).toBe(false);
  });

  it("should accept two beds that meet exactly", async () => {
    const text = sheet({
      music: [
        cue("M01", "U01,U02", "0-15s", "A calm theme."),
        cue("M02", "U03,U04", "15-30s", "A storm theme."),
      ],
    });
    const verdict = validateSoundDesign({ shotList: await plan(), text });

    expect(verdict.ok ? verdict.data.music.length : null).toBe(2);
  });

  /**
   * The check that carries the weight "lifted, not invented" carries one stage
   * up. It cannot prove the English describes the Polish, but it proves the
   * model walked every shot: the shots a cue declares have to be exactly the
   * shots its seconds cover, so a dropped shot and an invented one both fail.
   */
  it("should refuse a bed whose declared shots are not the shots it covers", async () => {
    const text = sheet({ music: [cue("M01", "U01,U02", "0-30s", "A theme.")] });
    const verdict = validateSoundDesign({ shotList: await plan(), text });

    expect(verdict.ok ? null : verdict.error.message).toContain("U03");
  });

  it("should refuse a bed the music model will not compose", async () => {
    const text = sheet({
      music: [
        cue("M01", "U01", "0-2s", "A stab."),
        cue("M02", "U01,U02,U03,U04", "2-30s", "A theme."),
      ],
    });
    const verdict = validateSoundDesign({ shotList: await plan(), text });

    expect(verdict.ok).toBe(false);
  });

  it("should refuse an effect anchored outside the shot it names", async () => {
    const text = sheet({ effects: [cue("E01", "U03", "25s | 3s", "Thunder.")] });
    const verdict = validateSoundDesign({ shotList: await plan(), text });

    expect(verdict.ok ? null : verdict.error.message).toContain("U03");
  });

  it("should refuse an effect naming a shot that does not exist", async () => {
    const text = sheet({ effects: [cue("E01", "U09", "16s | 3s", "Thunder.")] });
    const verdict = validateSoundDesign({ shotList: await plan(), text });

    expect(verdict.ok).toBe(false);
  });

  it("should refuse an effect longer than the model renders", async () => {
    const text = sheet({ effects: [cue("E01", "U03", "16s | 45s", "A long rain bed.")] });
    const verdict = validateSoundDesign({ shotList: await plan(), text });

    expect(verdict.ok).toBe(false);
  });

  it("should refuse an effect that runs past the end of the plan", async () => {
    const text = sheet({ effects: [cue("E01", "U04", "29s | 5s", "Thunder.")] });
    const verdict = validateSoundDesign({ shotList: await plan(), text });

    expect(verdict.ok).toBe(false);
  });

  /**
   * The boundary this stage inherits from stage 4, pinned so nobody adds a
   * prose parser later. Rule 9 puts the cue sheet in English and the
   * instruction says so, but the verdict **never reads a prompt**, which is
   * the rule stage 4 established, and it does not read this one either.
   *
   * A check was tried here and taken out. The only cheap test is for the film
   * language's own letters, and this very sentence, "Delikatny instrumentalny
   * motyw wieczorny", is Polish without a single one of them. It would have
   * refused honest English quoting a name while letting pasted Polish through,
   * which is worse than the human who reads the sheet before any audio is
   * bought.
   */
  it("should not judge the prose of a cue, only the wiring around it", async () => {
    const text = sheet({
      music: [cue("M01", "U01,U02,U03,U04", "0-30s", "Delikatny instrumentalny motyw wieczorny.")],
    });
    const verdict = validateSoundDesign({ shotList: await plan(), text });

    expect(verdict.ok).toBe(true);
  });

  it("should refuse cues numbered out of order", async () => {
    const text = sheet({ effects: [cue("E02", "U03", "16s | 3s", "Thunder.")] });
    const verdict = validateSoundDesign({ shotList: await plan(), text });

    expect(verdict.ok ? null : verdict.error.message).toContain("E01");
  });

  /**
   * Every sound mode this pipeline offers includes effects, so a sheet with
   * none is a gap rather than a decision, the same reading stage 9 gives a
   * narrated episode whose script says nothing.
   */
  it("should refuse a sheet with no effect in it at all", async () => {
    const verdict = validateSoundDesign({ shotList: await plan(), text: sheet({ effects: [] }) });

    expect(verdict.ok).toBe(false);
  });

  it("should refuse a sheet with an empty cue", async () => {
    const text = sheet({ effects: [cue("E01", "U03", "16s | 3s", "")] });
    const verdict = validateSoundDesign({ shotList: await plan(), text });

    expect(verdict.ok).toBe(false);
  });

  it("should refuse a document carrying a code block", async () => {
    const verdict = validateSoundDesign({
      shotList: await plan(),
      text: `${sheet()}\n\`\`\`json\n{}\n\`\`\`\n`,
    });

    expect(verdict.ok).toBe(false);
  });

  it("should refuse a document missing one of its sections", async () => {
    const verdict = validateSoundDesign({
      shotList: await plan(),
      text: sheet().replace("## Review", "## Notes"),
    });

    expect(verdict.ok).toBe(false);
  });
});

interface Calls {
  /** Every audio request, in order: which endpoint, what was asked for, how long. */
  readonly bought: { endpoint: string; seconds: number; sent: Record<string, unknown> }[];
  readonly fetch: typeof fetch;
  readonly text: number[];
}

/**
 * One transport for the three call sites, counting each separately.
 *
 * Counting "calls" alone would be counting two different bills added together,
 * exactly as it would at stage 9, and here it would be worse, because the two
 * audio call sites are rated per second of what they produce, so a count says
 * nothing at all about what an episode costs.
 */
function transport(options: { readonly sheet?: string; readonly seconds?: number } = {}): Calls {
  const { sheet: written = sheet(), seconds } = options;
  const bought: { endpoint: string; seconds: number; sent: Record<string, unknown> }[] = [];
  const text: number[] = [];

  return {
    bought,
    fetch: ((url: string | URL, init?: RequestInit) => {
      const href = String(url);

      if (href.includes("elevenlabs")) {
        const sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const asked =
          typeof sent.music_length_ms === "number"
            ? sent.music_length_ms / 1000
            : Number(sent.duration_seconds ?? 0);

        bought.push({ endpoint: href, seconds: asked, sent });

        return Promise.resolve(
          new Response(mp3({ seconds: seconds ?? asked }), {
            headers: { "content-type": "audio/mpeg" },
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
              content: [{ text: written, type: "output_text" }],
              role: "assistant",
              type: "message",
            },
          ],
          status: "completed",
        })
      );
    }) as unknown as typeof fetch,
    text,
  };
}

function generate(
  calls: Calls,
  overrides: Partial<Parameters<typeof generateSoundDesign>[0]> = {}
) {
  return generateSoundDesign({
    artifacts: [],
    audioKey: API_KEY,
    effectsModel: "eleven_text_to_sound_v2",
    episodeId: EPISODE,
    fetch: calls.fetch,
    maxOutputTokens: 8000,
    mode: "apply",
    model: "gpt-6-astra",
    musicModel: "music_v2",
    openAiKey: API_KEY,
    projectId: PROJECT,
    regenerate: false,
    workspace,
    ...overrides,
  });
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

/** Accepts named artifacts of the shared half, the way a person would. */
function accept(artifacts: readonly string[]) {
  return approveSoundDesign({
    artifacts,
    episodeId: EPISODE,
    mode: "apply",
    note: "ok",
    projectId: PROJECT,
    reviewer: "test",
    workspace,
  });
}

/** Everything stage 10's buying half needs: a sheet somebody accepted. */
async function boughtStems(calls: Calls): Promise<void> {
  await generate(calls);
  await accept(["cues"]);
  await generate(calls);
  await accept(["M01", "E01"]);
}

/**
 * Stage 9's half of a narrated episode, run for real.
 *
 * Stage 10 mixes the lines stage 9 bought, so a test of the mix cannot forge
 * them: what it needs is the yes a person gave, and only stage 9 records that.
 */
async function narrate(options: { readonly approve?: boolean } = {}): Promise<void> {
  const { approve = true } = options;
  const script = [
    "## Plan",
    "",
    "Narrator prowadzi odcinek jednym zdaniem.",
    "",
    "## Lines",
    "",
    "### N01 | U01 | 2s",
    "",
    "Ewa została sama z burzą",
    "",
    "## Review",
    "",
    "Kwestia pochodzi z pola Audio ujęcia U01.",
    "",
  ].join("\n");
  const speech = ((url: string | URL) =>
    String(url).includes("elevenlabs")
      ? Promise.resolve(
          new Response(wav({ seconds: 1 }), {
            headers: { "content-type": "audio/wav" },
            status: 200,
          })
        )
      : Promise.resolve(
          Response.json({
            id: "resp_1",
            output: [
              {
                content: [{ text: script, type: "output_text" }],
                role: "assistant",
                type: "message",
              },
            ],
            status: "completed",
          })
        )) as unknown as typeof fetch;
  const narration = (artifacts: readonly string[]): Promise<unknown> =>
    approveNarration({
      artifacts,
      episodeId: EPISODE,
      mode: "apply",
      note: "ok",
      projectId: PROJECT,
      reviewer: "test",
      workspace,
    }) as Promise<unknown>;
  const buy = () =>
    generateNarration({
      artifacts: [],
      episodeId: EPISODE,
      fetch: speech,
      maxOutputTokens: 8000,
      mode: "apply",
      model: "gpt-6-astra",
      openAiKey: API_KEY,
      projectId: PROJECT,
      regenerate: false,
      voiceKey: API_KEY,
      voiceModel: "eleven_multilingual_v2",
      workspace,
    });

  await buy();
  await narration(["script"]);
  await buy();
  await narration(["N01"]);
  await generateMix({
    artifacts: [],
    episodeId: EPISODE,
    mode: "apply",
    mux: muxer(),
    projectId: PROJECT,
    regenerate: false,
    track: "gpt-image",
    workspace,
  });
  if (approve) {
    await approveMix({
      artifacts: [],
      episodeId: EPISODE,
      mode: "apply",
      note: "ok",
      projectId: PROJECT,
      reviewer: "test",
      track: "gpt-image",
      workspace,
    });
  }
}

describe("generateSoundDesign", () => {
  /**
   * The number this stage prints before it spends is **two numbers**, and for a
   * reason of its own: the provider rates per minute of generated audio, so one
   * call for a thirty-second bed and one for a three-second thunderclap are the
   * same count and nothing like the same money.
   */
  it("should state calls and seconds before anything is sent", async () => {
    const calls = transport();
    const preview = await generate(calls, { mode: "dry-run" });

    expect(preview.ok ? preview.data.prompt : null).toContain("cue sheet");
    expect(calls.text).toHaveLength(0);
    expect(calls.bought).toHaveLength(0);
  });

  it("should say that a regeneration is a second full charge", async () => {
    const preview = await generate(transport(), { mode: "dry-run" });

    expect(preview.ok ? preview.data.problems.join(" ") : "").toContain("GENERACJI");
  });

  it("should write the cue sheet in one paid text call and buy nothing yet", async () => {
    const calls = transport();
    const result = await generate(calls);

    expect(calls.text).toHaveLength(1);
    expect(calls.bought).toHaveLength(0);
    expect(result.ok ? result.data.sheet.state : null).toBe("published");
  });

  /** Accepting the sheet is what authorises buying every cue in it. */
  it("should refuse to buy a stem before a human accepts the sheet", async () => {
    const calls = transport();

    await generate(calls);
    const second = await generate(calls);

    expect(calls.bought).toHaveLength(0);
    expect(second.ok ? second.data.sheet.note : null).toContain("ocenę");
  });

  it("should buy one bed and one effect once the sheet is accepted", async () => {
    const calls = transport();

    await generate(calls);
    await accept(["cues"]);
    const result = await generate(calls);

    expect(calls.bought).toHaveLength(2);
    expect(result.ok ? result.data.calls : null).toBe(2);
    expect(result.ok ? result.data.seconds : null).toBe(33);
  });

  /**
   * The bed goes to the music endpoint with a length in milliseconds, the
   * effect to the sound endpoint with one in seconds. Two endpoints behind one
   * module, and the stage says which is which.
   */
  it("should send each cue to the endpoint that makes that kind of sound", async () => {
    const calls = transport();

    await generate(calls);
    await accept(["cues"]);
    await generate(calls);

    expect(calls.bought[0]?.endpoint).toContain("/v1/music");
    expect(calls.bought[0]?.sent.music_length_ms).toBe(30_000);
    expect(calls.bought[1]?.endpoint).toContain("/v1/sound-generation");
    expect(calls.bought[1]?.sent.duration_seconds).toBe(3);
  });

  /**
   * An episode whose mode carries speech has already decided a voice is the
   * foreground. A second voice singing over the narrator is not a decision
   * anybody made, so it is derived rather than stored.
   */
  it("should force the bed instrumental when the episode carries speech", async () => {
    const calls = transport();

    await generate(calls);
    await accept(["cues"]);
    await generate(calls);

    expect(calls.bought[0]?.sent.force_instrumental).toBe(true);
  });

  it("should not buy the same stem twice", async () => {
    const calls = transport();

    await boughtStems(calls);
    await generate(calls);

    expect(calls.bought).toHaveLength(2);
  });

  it("should refuse a regeneration that names nobody", async () => {
    const calls = transport();

    await generate(calls);
    const refusal = await generate(calls, { regenerate: true });

    expect(refusal.ok).toBe(false);
  });
});

describe("checkSoundDesign", () => {
  it("should report the sheet as absent before anything runs", async () => {
    const status = await checkSoundDesign({
      episodeId: EPISODE,
      projectId: PROJECT,
      workspace,
    });

    expect(status.ok ? status.data.sheet.state : null).toBe("absent");
  });

  it("should not approve a stem nobody bought", async () => {
    const calls = transport();

    await generate(calls);
    const refusal = await accept(["M01"]);

    expect(refusal.ok).toBe(false);
  });

  it("should require --artifact, because accepting the sheet spends money", async () => {
    const refusal = await accept([]);

    expect(refusal.ok ? null : refusal.error.message).toContain("--artifact");
  });

  /**
   * `dialogue` is the half stage 10 does not close, and saying so at every
   * check is the contract's "reported, not enforced", the same way stage 8
   * reports silence and stage 9 reported the missing music.
   */
  it("should report what it still cannot make", async () => {
    const calls = transport();

    await boughtStems(calls);
    const status = (await checkSoundDesign({
      episodeId: EPISODE,
      projectId: PROJECT,
      workspace,
    })) as { data: NarrationStatus | { problems: readonly string[] }; ok: boolean };

    // This episode declares `narration`, which stages 9 and 10 close between
    // them, so nothing about dialogue is reported for it.
    expect(status.ok ? status.data.problems.join(" ") : "").not.toContain("dialog");
  });
});

describe("generateMaster", () => {
  it("should refuse to mix before the stems are accepted", async () => {
    await makeCut({ root, track: "gpt-image", workspace });
    const refusal = await master();

    expect(refusal.ok).toBe(false);
  });

  it("should refuse to mix an episode whose narration stage never ran", async () => {
    const calls = transport();

    await makeCut({ root, track: "gpt-image", workspace });
    await boughtStems(calls);
    const refusal = await master();

    expect(refusal.ok ? null : refusal.error.message).toContain("etap 9 nie ukończył miksu");
  });

  /**
   * Row 10's gate, kept as declared, and this is the test that proves it is
   * about the **yes** rather than about the file. Stage 10 builds from
   * `episode.mp4` and the stems rather than from `narrated.mp4`, so it never
   * opens those bytes, but the yes on them is the only evidence anywhere that
   * the narration lands correctly over this film, and this stage reuses that
   * fact rather than re-establishing it. Here the narrated cut exists and is
   * valid; only the human is missing, and that alone is enough.
   */
  it("should refuse to mix until the narrated cut carries a human's yes", async () => {
    const calls = transport();

    await makeCut({ root, track: "gpt-image", workspace });
    await boughtStems(calls);
    await narrate({ approve: false });
    const refusal = await master();

    expect(refusal.ok ? null : refusal.error.message).toContain(
      "narracja na torze gpt-image czeka na ocenę"
    );
  });

  it("should publish the full mix once everything is accepted", async () => {
    const calls = transport();

    await makeCut({ root, track: "gpt-image", workspace });
    await boughtStems(calls);
    await narrate();
    const result = await master();

    expect(result.ok ? result.data.state : null).toBe("published");
    expect(result.ok ? result.data.created.some((p) => p.endsWith("mixed.mp4")) : null).toBe(true);
  });

  /** The approved cut and the narrated one are both left exactly as they were. */
  it("should leave episode.mp4 and narrated.mp4 untouched", async () => {
    const calls = transport();

    await makeCut({ root, track: "gpt-image", workspace });
    await boughtStems(calls);
    await narrate();

    const project = projectPaths(workspace, PROJECT);
    const episode = project.ok ? episodePaths(project.data, EPISODE) : null;
    const dir = episode?.ok === true ? join(episode.data.root, "gpt-image") : "";
    const before = await Promise.all([
      readFile(join(dir, "episode.mp4")),
      readFile(join(dir, "narrated.mp4")),
    ]);

    await master();

    const after = await Promise.all([
      readFile(join(dir, "episode.mp4")),
      readFile(join(dir, "narrated.mp4")),
    ]);

    expect(after[0].equals(before[0])).toBe(true);
    expect(after[1].equals(before[1])).toBe(true);
  });

  /**
   * The levels are a knob somebody turns by ear, so they live in their own
   * file, and changing them must lapse the mix they produced and **nothing
   * else**, which is the whole reason they are not inside `narration.json`.
   */
  it("should carry the stored levels into the mix and report them", async () => {
    const calls = transport();

    await makeCut({ root, track: "gpt-image", workspace });
    await boughtStems(calls);
    await narrate();
    await setLevels({
      duckDb: -12,
      duckReleaseMs: null,
      effectsDb: null,
      mode: "apply",
      musicDb: -22,
      projectId: PROJECT,
      workspace,
    });
    const result = await master();

    expect(result.ok ? result.data.levels.musicDb : null).toBe(-22);
    expect(result.ok ? result.data.levels.duckDb : null).toBe(-12);
  });

  it("should lapse the mix when the levels change afterwards", async () => {
    const calls = transport();

    await makeCut({ root, track: "gpt-image", workspace });
    await boughtStems(calls);
    await narrate();
    await master();
    await approveMaster({
      artifacts: [],
      episodeId: EPISODE,
      mode: "apply",
      note: "ok",
      projectId: PROJECT,
      reviewer: "test",
      track: "gpt-image",
      workspace,
    });
    await setLevels({
      duckDb: null,
      duckReleaseMs: null,
      effectsDb: null,
      mode: "apply",
      musicDb: -24,
      projectId: PROJECT,
      workspace,
    });
    const status = await checkMaster({
      episodeId: EPISODE,
      projectId: PROJECT,
      track: "gpt-image",
      workspace,
    });

    expect(status.ok ? status.data.approved : null).toBe(false);
  });

  it("should accept the mix, and only the mix, per track", async () => {
    const calls = transport();

    await makeCut({ root, track: "gpt-image", workspace });
    await boughtStems(calls);
    await narrate();
    await master();

    const approved = await approveMaster({
      artifacts: [],
      episodeId: EPISODE,
      mode: "apply",
      note: "ok",
      projectId: PROJECT,
      reviewer: "test",
      track: "gpt-image",
      workspace,
    });

    expect(approved.ok ? approved.data.approved : null).toBe(true);

    const refusal = await approveMaster({
      artifacts: ["M01"],
      episodeId: EPISODE,
      mode: "apply",
      note: "ok",
      projectId: PROJECT,
      reviewer: "test",
      track: "gpt-image",
      workspace,
    });

    expect(refusal.ok).toBe(false);
  });

  /** A yes on one track is not a yes on the other: two films, one story. */
  it("should not let one track's approval open the other", async () => {
    const calls = transport();

    await makeCut({ root, track: "gpt-image", workspace });
    await makeCut({ root, track: "seedream", workspace });
    await boughtStems(calls);
    await narrate();
    await master();

    const other = await checkMaster({
      episodeId: EPISODE,
      projectId: PROJECT,
      track: "seedream",
      workspace,
    });

    expect(other.ok ? other.data.artifact.state : null).toBe("absent");
  });
});

describe("what the full mix hands the engine, and what it refuses", () => {
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

  /**
   * The whole of decision five, asserted. The picture is `episode.mp4`, not
   * `narrated.mp4`, and the speech arrives as its own input rather than
   * already baked into the video. That is what lets the speech be encoded
   * exactly once, and it is the only arrangement in which music can honestly
   * step back under a voice.
   */
  it("should build over episode.mp4 with the speech as a separate input", async () => {
    const calls = transport();
    const engine = spy();

    await makeCut({ root, track: "gpt-image", workspace });
    await boughtStems(calls);
    await narrate();
    await master({ mux: engine.mux });

    const [sent] = engine.seen;

    expect(sent?.video.endsWith("episode.mp4")).toBe(true);
    expect(sent?.video.endsWith("narrated.mp4")).toBe(false);
    expect(sent?.speech).toHaveLength(1);
    expect(sent?.music).toHaveLength(1);
    expect(sent?.effects).toHaveLength(1);
  });

  /**
   * Stage 7's refusal, inherited. Where a sound sits comes from a plan a human
   * approved, so a tool that quietly slid an effect back inside the film would
   * be moving something nobody moved. The clips here came back a little short,
   * which is the only way a plan-legal effect can overrun a real film.
   */
  it("should refuse an effect that runs past the end of this track's film", async () => {
    const calls = transport();

    await makeCut({ clipSeconds: { C02: 13.2 }, root, track: "gpt-image", workspace });
    await boughtStems(calls);
    await narrate();
    const refusal = await master();

    expect(refusal.ok ? null : refusal.error.message).toContain("nie mieści się w odcinku");
  });

  /**
   * Stage 8's reading, inherited. A bed that stops a fraction before the
   * picture does is a gap rather than a collision, and refusing a film over it
   * would be a refusal with no remedy behind it, the clips came back longer
   * than the plan ordered and nobody downstream can change that.
   */
  it("should report a bed that stops short of the film rather than refusing it", async () => {
    const calls = transport();

    await makeCut({ clipSeconds: { C02: 15.4 }, root, track: "gpt-image", workspace });
    await boughtStems(calls);
    await narrate();
    const result = await master();

    expect(result.ok ? result.data.state : null).toBe("published");
    expect(result.ok ? result.data.problems.join(" ") : "").toContain("gra bez muzyki");
  });
});

/**
 * What a preview says to do next, once there is nothing left to mix.
 *
 * A dry run that points at the command it just told you is finished sends a
 * person back round a loop they have already closed, and here it points past
 * the one thing the pipeline actually needs from them, which is a human
 * listening to the whole film and saying yes.
 */
describe("the next step a preview names", () => {
  it("should point at the approval once a mix exists", async () => {
    const calls = transport();

    await makeCut({ root, track: "gpt-image", workspace });
    await boughtStems(calls);
    await narrate();
    await master();

    const preview = await master({ mode: "dry-run" });

    expect(preview.ok ? preview.data.nextStep : "").toContain("approve");
  });

  it("should say the film is accepted once somebody has accepted it", async () => {
    const calls = transport();

    await makeCut({ root, track: "gpt-image", workspace });
    await boughtStems(calls);
    await narrate();
    await master();
    await approveMaster({
      artifacts: [],
      episodeId: EPISODE,
      mode: "apply",
      note: "ok",
      projectId: PROJECT,
      reviewer: "test",
      track: "gpt-image",
      workspace,
    });

    const preview = await master({ mode: "dry-run" });

    expect(preview.ok ? preview.data.nextStep : "").toContain("przyjęty");
  });

  /** A mix that has not happened still points at the mix. */
  it("should still point at the mix when there is none", async () => {
    const calls = transport();

    await makeCut({ root, track: "gpt-image", workspace });
    await boughtStems(calls);
    await narrate();

    const preview = await master({ mode: "dry-run" });

    expect(preview.ok ? preview.data.nextStep : "").toContain("sound-design mix");
  });
});

/**
 * A preview may not claim an approval that `check` would call lapsed.
 *
 * "Approved" is never the raw field on its own: an approval is bound to the
 * bytes it was given for, so a recorded input that has moved since lapses it.
 * A dry run reading only `review.status` would tell somebody their film is
 * accepted while `check` told them the opposite, which is worse than the
 * unhelpful answer it replaced, because it is wrong rather than merely stale.
 */
describe("what a preview may call accepted", () => {
  it("should not call a mix accepted once its levels have moved", async () => {
    const calls = transport();

    await makeCut({ root, track: "gpt-image", workspace });
    await boughtStems(calls);
    await narrate();
    await master();
    await approveMaster({
      artifacts: [],
      episodeId: EPISODE,
      mode: "apply",
      note: "ok",
      projectId: PROJECT,
      reviewer: "test",
      track: "gpt-image",
      workspace,
    });
    await setLevels({
      duckDb: null,
      duckReleaseMs: null,
      effectsDb: null,
      mode: "apply",
      musicDb: -24,
      projectId: PROJECT,
      workspace,
    });

    const preview = await master({ mode: "dry-run" });
    const status = await checkMaster({
      episodeId: EPISODE,
      projectId: PROJECT,
      track: "gpt-image",
      workspace,
    });

    expect(status.ok ? status.data.approved : null).toBe(false);
    expect(preview.ok ? preview.data.nextStep : "").not.toContain("przyjęty");
  });
});
