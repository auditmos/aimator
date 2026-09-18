import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Of } from "../artifact/index.js";
import {
  addCharacter,
  addEpisode,
  approveStage0,
  initProject,
  setCharacterBasis,
  setEpisodeSettings,
} from "../project/index.js";
import { approvePromptPackage, generatePromptPackage } from "../prompt-package/index.js";
import { approveScreenplay, generateScreenplay } from "../screenplay/index.js";
import { approveShotList, generateShotList } from "../shot-list/index.js";
import { type ImageTrack, imageTracks, resolveWorkspace, type Workspace } from "../workspace.js";
import { approveReferences, checkReferences, generateReferences } from "./index.js";

/**
 * Stage 5 end to end, through the module entry: the graph gate inside its own
 * results, the run that draws every ready reference at once, the preview that
 * spends nothing, the resume that costs nothing, and the approval that is never
 * implied.
 *
 * The gate is what makes this stage different from every one before it, so it
 * is exercised per track: R04 waits for R03 **on this track**, and a reference
 * accepted on gpt-image does nothing for seedream.
 */

const API_KEY = "sk-test-0123456789";
const EPISODE = "01-burza";
const PROJECT = "ewa";
const CAST = ["ewa", "tata"] as const;
/** The film frame of a 16:9 episode: what both tracks render and validate. */
const FRAME = { height: 1584, width: 2816 };

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

function png(width: number, height: number): Buffer {
  const head = Buffer.alloc(26);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "ascii");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  head.writeUInt8(8, 24);
  head.writeUInt8(2, 25);

  const tail = Buffer.alloc(12);
  tail.write("IEND", 4, "ascii");

  return Buffer.concat([head, Buffer.alloc(64), tail]);
}

const HERO = png(1536, 2304);
const REFERENCE = png(FRAME.width, FRAME.height);

interface Recorder {
  readonly calls: { body: unknown; url: string }[];
  readonly fetch: typeof fetch;
}

/**
 * A provider that answers correctly, counting every request. The count is the
 * assertion that matters most: this stage bills per call, and it is the first
 * where one command may make several.
 */
function recorder(options: { readonly image?: Buffer } = {}): Recorder {
  const calls: { body: unknown; url: string }[] = [];
  const image = options.image ?? REFERENCE;

  const impl = ((url: string | URL, init?: RequestInit) => {
    const href = String(url);

    if (href.startsWith("https://download/")) {
      calls.push({ body: null, url: href });
      return Promise.resolve(new Response(image, { status: 200 }));
    }

    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    calls.push({ body, url: href });

    return Promise.resolve(
      href.includes("bytepluses.com")
        ? Response.json({ data: [{ url: "https://download/reference" }], id: "job-1" })
        : Response.json({ data: [{ b64_json: image.toString("base64") }] })
    );
  }) as unknown as typeof fetch;

  return { calls, fetch: impl };
}

function textCompletion(text: string): string {
  return JSON.stringify({
    id: "resp_1",
    model: "gpt-6-astra",
    output: [{ content: [{ text, type: "output_text" }], role: "assistant", type: "message" }],
    status: "completed",
  });
}

function respondWith(body: string): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(body, { headers: { "x-request-id": "req_1" }, status: 200 })
    )) as unknown as typeof fetch;
}

function screenplay(): string {
  const scenes = [1, 2, 3]
    .map((number) =>
      [
        `### S0${number} | 10s | salon, wieczór`,
        "",
        "- Action: Ewa siada przy stole.",
        "- Audio: Narrator opisuje ciszę.",
        "- Text: none",
        "- End state: Ewa przy stole.",
        "",
      ].join("\n")
    )
    .join("\n");

  return ["Premise", "Logline", "Synopsis", "Beats", "Characters and locations", "Scenes", "Review"]
    .map((name) => `## ${name}\n\n${name === "Scenes" ? scenes : `Treść sekcji ${name}.`}\n`)
    .join("\n");
}

function shot(id: string, scene: string, clip: string, range: string, cast: string): string {
  return [
    `### ${id} | ${scene} | ${clip} | ${range}`,
    "",
    "- Purpose: Pokazuje, że Ewa zostaje sama z burzą.",
    "- Frame: Plan amerykański, Ewa po lewej.",
    "- Action: Ewa odsuwa krzesło i siada.",
    "- Expression: Zaciśnięte usta.",
    "- Camera: Statyczny kadr.",
    `- Cast: ${cast}`,
    "- Audio: Deszcz o szybę.",
    "- Text: none",
    "- Start state: Ewa stoi przy krześle.",
    "- End state: Ewa siedzi.",
    "",
  ].join("\n");
}

function shotList(): string {
  return [
    "## Plan\n\nDwa klipy, kadr 16:9.\n",
    [
      "## Clips",
      "",
      "### C01 | 0-15s",
      "",
      "- Shots: U01,U02",
      "- Reference: opening-frame",
      "- Continuity: Ewa przy stole.",
      "",
      "### C02 | 15-30s",
      "",
      "- Shots: U03,U04",
      "- Reference: previous-end-frame",
      "- Continuity: Ewa siedzi, tata obok.",
      "",
    ].join("\n"),
    [
      "## Shots",
      "",
      shot("U01", "S01", "C01", "0-10s", "ewa"),
      shot("U02", "S02", "C01", "10-15s", "ewa,tata"),
      shot("U03", "S02", "C02", "15-20s", "tata"),
      shot("U04", "S03", "C02", "20-30s", "ewa,tata"),
    ].join("\n"),
    "## Review\n\nSprawdzono sumy czasów. Plan wymaga oceny.\n",
  ].join("\n");
}

/**
 * A package whose graph has two roots and one dependent, which is the shape
 * stage 5 exists to enforce: R01 and R02 need only a canonical image, R03 waits
 * for R02.
 */
function answer(): string {
  return JSON.stringify({
    clips: [
      {
        id: "C01",
        prompt: "Salon wieczorem, Ewa po lewej.",
        referenceIds: ["hero:ewa", "hero:tata", "R01", "R03"],
      },
      {
        id: "C02",
        prompt: "Oboje na dywanie.",
        referenceIds: ["hero:ewa", "hero:tata", "R01"],
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
        subject: "Living room — evening",
      },
      {
        dependsOn: ["hero:ewa"],
        id: "R02",
        kind: "prop",
        prompt: "Pluszowa alpaka, nieugnieciona.",
        subject: "Alpaca toy — uncompressed",
      },
      {
        dependsOn: ["R02"],
        id: "R03",
        kind: "prop",
        prompt: "Ta sama alpaka, ucho ugięte kontaktem.",
        subject: "Alpaca toy — contact-bent ear",
      },
    ],
    review: "Do rozstrzygnięcia: skala alpaki przy twarzy taty.",
  });
}

async function makeHero(characterId: string, track: string): Promise<void> {
  const dir = join(root, "projects", PROJECT, "characters", characterId, track);

  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "hero.png"), HERO);
  await writeFile(
    join(dir, "character.stage.json"),
    `${JSON.stringify(
      {
        artifacts: {
          hero: {
            inputs: [],
            jobId: null,
            needsReview: [],
            outputs: [
              {
                path: `projects/${PROJECT}/characters/${characterId}/${track}/hero.png`,
                sha256: sha256Of(HERO),
              },
            ],
            producedAt: "2026-09-18T10:00:00.000Z",
            producer: {
              endpoint: "https://example.test/images",
              kind: "model",
              model: "gpt-image-2.5",
              promptVersion: 1,
              tool: "aimator",
            },
            review: {
              note: null,
              reviewedAt: "2026-09-18T10:05:00.000Z",
              reviewer: "test",
              status: "approved",
            },
            runId: "20260918T100000Z-abcd1234",
            status: "completed",
          },
        },
        stage: "character",
        version: 1,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function makeUpstream(): Promise<void> {
  const source = join(scratch, "01-Burza.md");
  await writeFile(source, "# Burza\n\nEwa boi się burzy.\n", "utf8");

  await initProject({
    aspectRatio: "16:9",
    mode: "apply",
    projectId: PROJECT,
    title: "Dzielna Ewa",
    workspace,
  });

  for (const characterId of CAST) {
    // biome-ignore lint/performance/noAwaitInLoops: the roster is written in order
    await addCharacter({
      characterId,
      mode: "apply",
      name: characterId === "ewa" ? "Ewa" : "Tata",
      projectId: PROJECT,
      workspace,
    });
    await setCharacterBasis({
      basis: "description",
      characterId,
      mode: "apply",
      projectId: PROJECT,
      workspace,
    });
  }

  await writeFile(
    join(root, "projects", PROJECT, "project.md"),
    "# Ewa\n\nPłaskie 2D wektorowe.\n",
    "utf8"
  );
  await addEpisode({
    mode: "apply",
    projectId: PROJECT,
    settings: {},
    sourcePath: source,
    workspace,
  });
  await setEpisodeSettings({
    episodeId: EPISODE,
    mode: "apply",
    projectId: PROJECT,
    settings: {
      audio: "narration",
      durationSeconds: 30,
      language: "pl",
      maxClipSeconds: 15,
      sourceNature: "law-or-idea",
      subtitles: "none",
    },
    workspace,
  });
  await approveStage0({
    mode: "apply",
    note: null,
    projectId: PROJECT,
    reviewer: "test",
    workspace,
  });

  await Promise.all(CAST.flatMap((id) => imageTracks.map((track) => makeHero(id, track))));

  await generateScreenplay({
    apiKey: API_KEY,
    episodeId: EPISODE,
    fetch: respondWith(textCompletion(screenplay())),
    maxOutputTokens: 12_000,
    mode: "apply",
    model: "gpt-6-astra",
    projectId: PROJECT,
    regenerate: false,
    workspace,
  });
  await approveScreenplay({
    episodeId: EPISODE,
    mode: "apply",
    note: null,
    projectId: PROJECT,
    reviewer: "test",
    workspace,
  });
  await generateShotList({
    apiKey: API_KEY,
    episodeId: EPISODE,
    fetch: respondWith(textCompletion(shotList())),
    maxOutputTokens: 24_000,
    mode: "apply",
    model: "gpt-6-astra",
    projectId: PROJECT,
    regenerate: false,
    workspace,
  });
  await approveShotList({
    episodeId: EPISODE,
    mode: "apply",
    note: null,
    projectId: PROJECT,
    reviewer: "test",
    workspace,
  });
  await generatePromptPackage({
    apiKey: API_KEY,
    episodeId: EPISODE,
    fetch: respondWith(textCompletion(answer())),
    maxOutputTokens: 32_000,
    mode: "apply",
    model: "gpt-6-astra",
    projectId: PROJECT,
    regenerate: false,
    republish: false,
    workspace,
  });
}

async function approvePackage(): Promise<void> {
  await approvePromptPackage({
    episodeId: EPISODE,
    mode: "apply",
    note: null,
    projectId: PROJECT,
    reviewer: "test",
    workspace,
  });
}

function generate(overrides: Partial<Parameters<typeof generateReferences>[0]> = {}) {
  return generateReferences({
    apiKey: API_KEY,
    artifacts: [],
    episodeId: EPISODE,
    fetch: recorder().fetch,
    mode: "apply",
    model: "gpt-image-2.5-sunburst",
    projectId: PROJECT,
    regenerate: false,
    track: "gpt-image",
    workspace,
    ...overrides,
  });
}

function accept(artifacts: readonly string[], track: ImageTrack = "gpt-image") {
  return approveReferences({
    artifacts,
    episodeId: EPISODE,
    mode: "apply",
    note: "ok",
    projectId: PROJECT,
    reviewer: "tester",
    track,
    workspace,
  });
}

function trackDir(track: ImageTrack = "gpt-image"): string {
  return join(root, "projects", PROJECT, "episodes", EPISODE, track);
}

async function readStageFile(track: ImageTrack = "gpt-image") {
  return JSON.parse(await readFile(join(trackDir(track), "references.stage.json"), "utf8"));
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aimator-stage5-"));
  root = join(scratch, "workspace");
  const resolved = resolveWorkspace(root);
  workspace = resolved.ok ? resolved.data : { root: "" };
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

describe("generateReferences gates", () => {
  it("should refuse to spend until the package carries an approval", async () => {
    await makeUpstream();
    const call = recorder();
    const result = await generate({ fetch: call.fetch });

    expect(call.calls).toHaveLength(0);
    expect(result.ok ? null : result.error.message).toContain("--stage prompt-package");
  });

  it("should refuse an artifact that belongs to a later stage", async () => {
    await makeUpstream();
    const result = await generate({ artifacts: ["C01"] });

    expect(result.ok ? null : result.error.message).toContain("wyłącznie referencje");
  });

  it("should require an explicit target for a new charge", async () => {
    await makeUpstream();
    const result = await generate({ regenerate: true });

    expect(result.ok ? null : result.error.message).toContain("--regenerate wymaga jawnego celu");
  });

  it("should refuse without a model nobody chose", async () => {
    await makeUpstream();
    await approvePackage();
    const result = await generate({ model: null });

    expect(result.ok ? null : result.error.message).toContain("AIMATOR_IMAGE_MODEL_GPT_IMAGE");
  });
});

describe("generateReferences", () => {
  /**
   * The decision this stage turns on: the gates leave several roots runnable,
   * so one command draws all of them rather than picking one arbitrarily.
   */
  it("should draw every ready reference at once and say how many calls it made", async () => {
    await makeUpstream();
    await approvePackage();
    const call = recorder();
    const result = await generate({ fetch: call.fetch });

    expect(call.calls).toHaveLength(2);
    expect(result.ok && result.data.paidCalls).toBe(2);
    expect(result.ok ? result.data.artifacts.map((one) => one.id) : null).toEqual(["R01", "R02"]);
  });

  /** R03 depends on R02, and drawing R02 is not the same as accepting it. */
  it("should leave a dependent reference blocked until its input is accepted", async () => {
    await makeUpstream();
    await approvePackage();
    await generate();

    const blocked = await generate({ artifacts: ["R03"] });

    expect(blocked.ok && blocked.data.paidCalls).toBe(0);
    expect(blocked.ok ? blocked.data.artifacts[0]?.state : null).toBe("blocked");
    expect(blocked.ok ? blocked.data.artifacts[0]?.note : "").toContain(
      "nikt go jeszcze nie przyjął"
    );
  });

  it("should draw the dependent reference once its input is accepted", async () => {
    await makeUpstream();
    await approvePackage();
    await generate();
    await accept(["R02"]);

    const call = recorder();
    const result = await generate({ fetch: call.fetch });

    expect(call.calls).toHaveLength(1);
    expect(result.ok ? result.data.artifacts.map((one) => one.id) : null).toEqual(["R03"]);
  });

  it("should publish into the track's own directory", async () => {
    await makeUpstream();
    await approvePackage();
    await generate();

    expect(await readdir(join(trackDir(), "references"))).toEqual(["R01.png", "R02.png"]);
    expect((await readStageFile()).stage).toBe("references");
  });

  /** Rule 1: one state filename, and it is not `references-state.json`. */
  it("should keep every reference in one stage file per track", async () => {
    await makeUpstream();
    await approvePackage();
    await generate();

    const stage = await readStageFile();

    expect(Object.keys(stage.artifacts).sort()).toEqual(["R01", "R02"]);
    expect(await readdir(trackDir())).toContain("references.stage.json");
  });

  it("should carry the approved dependency as an ordered attachment", async () => {
    await makeUpstream();
    await approvePackage();
    await generate();
    await accept(["R02"]);

    const call = recorder();
    await generate({ artifacts: ["R03"], fetch: call.fetch });

    const archived = JSON.parse(
      await readFile(
        join(trackDir(), "runs", (await readStageFile()).artifacts.R03.runId, "request.json"),
        "utf8"
      )
    );

    expect(archived.references).toEqual([
      expect.objectContaining({ name: "R02", position: 1, sha256: sha256Of(REFERENCE) }),
    ]);
    expect(archived.size).toBe("2816x1584");
  });

  /** Rule 4: an archive references its inputs, it never copies their bytes. */
  it("should archive the prompt and the request without the reference bytes", async () => {
    await makeUpstream();
    await approvePackage();
    await generate({ artifacts: ["R01"] });

    const runs = join(trackDir(), "runs", (await readStageFile()).artifacts.R01.runId);
    const entries = await readdir(runs);

    expect(entries.sort()).toEqual([
      "prompt.md",
      "request.json",
      "response.json",
      "run.json",
      "transport.json",
      "validation.json",
    ]);
    expect(await readFile(join(runs, "prompt.md"), "utf8")).toContain("REFERENCE INPUTS");
  });

  it("should refuse a published image whose frame is not the film frame", async () => {
    await makeUpstream();
    await approvePackage();
    const wrong = recorder({ image: png(1024, 1024) });
    const result = await generate({ artifacts: ["R01"], fetch: wrong.fetch });

    expect(result.ok ? null : result.error.message).toContain("1024x1024");
    expect((await readStageFile()).artifacts.R01.status).toBe("submitted");
  });

  it("should finish a submitted attempt from the saved response without paying again", async () => {
    await makeUpstream();
    await approvePackage();
    await generate({ artifacts: ["R01"] });

    const stage = await readStageFile();
    stage.artifacts.R01 = { ...stage.artifacts.R01, outputs: [], status: "submitted" };
    await writeFile(
      join(trackDir(), "references.stage.json"),
      `${JSON.stringify(stage, null, 2)}\n`,
      "utf8"
    );
    await rm(join(trackDir(), "references", "R01.png"));

    const second = recorder();
    const resumed = await generate({ artifacts: ["R01"], fetch: second.fetch });

    expect(second.calls).toHaveLength(0);
    expect(resumed.ok ? resumed.data.artifacts[0]?.state : resumed.error.message).toBe("resumed");
    expect((await readStageFile()).artifacts.R01.status).toBe("completed");
  });

  it("should keep a finished result until --regenerate names it", async () => {
    await makeUpstream();
    await approvePackage();
    await generate({ artifacts: ["R01"] });

    const again = recorder();
    const skipped = await generate({ artifacts: ["R01"], fetch: again.fetch });

    expect(again.calls).toHaveLength(0);
    expect(skipped.ok ? skipped.data.artifacts[0]?.state : null).toBe("skipped");

    const regenerated = recorder();
    await generate({ artifacts: ["R01"], fetch: regenerated.fetch, regenerate: true });

    expect(regenerated.calls).toHaveLength(1);
    expect(
      await readFile(
        join(trackDir(), "runs", (await readStageFile()).artifacts.R01.runId, "previous.png")
      )
    ).toEqual(REFERENCE);
  });

  it("should download what a seedream url points at and publish it", async () => {
    await makeUpstream();
    await approvePackage();
    const call = recorder();
    const result = await generate({
      artifacts: ["R01"],
      fetch: call.fetch,
      model: "dola-seedream-5-0-pro-260628",
      track: "seedream",
    });

    expect(call.calls.map((entry) => entry.url)).toEqual([
      "https://ark.ap-southeast.bytepluses.com/api/v3/images/generations",
      "https://download/reference",
    ]);
    expect(result.ok && result.data.artifacts[0]?.state).toBe("published");
    expect((await readStageFile("seedream")).artifacts.R01.jobId).toBe("job-1");
  });

  /** Rule 2: the two tracks hold identically named files and never meet. */
  it("should not let a reference accepted on one track open the other", async () => {
    await makeUpstream();
    await approvePackage();
    await generate();
    await accept(["R02"]);

    const other = await generate({
      artifacts: ["R03"],
      model: "dola-seedream-5-0-pro-260628",
      track: "seedream",
    });

    expect(other.ok ? other.data.artifacts[0]?.state : null).toBe("blocked");
    expect(other.ok ? other.data.artifacts[0]?.note : "").toContain("seedream");
  });
});

describe("generateReferences --dry-run", () => {
  it("should show the exact prompt, the call count and write nothing", async () => {
    await makeUpstream();
    await approvePackage();
    const before = await readdir(join(root, "projects", PROJECT, "episodes", EPISODE));
    const call = recorder();
    const result = await generate({ apiKey: null, fetch: call.fetch, mode: "dry-run" });

    expect(call.calls).toHaveLength(0);
    expect(result.ok && result.data.paidCalls).toBe(2);
    expect(result.ok ? result.data.artifacts[0]?.prompt : null).toContain("REFERENCE INPUTS");
    expect(await readdir(join(root, "projects", PROJECT, "episodes", EPISODE))).toEqual(before);
  });

  /**
   * A preview that counted a finished result as a purchase would overstate the
   * bill for the one command a person runs precisely to find out what it costs.
   */
  it("should not count a finished reference as a call it would make", async () => {
    await makeUpstream();
    await approvePackage();
    await generate({ artifacts: ["R01"] });

    const result = await generate({ apiKey: null, artifacts: ["R01"], mode: "dry-run" });

    expect(result.ok && result.data.paidCalls).toBe(0);
    expect(result.ok ? result.data.artifacts[0]?.state : null).toBe("skipped");
  });

  it("should count it again once --regenerate names it", async () => {
    await makeUpstream();
    await approvePackage();
    await generate({ artifacts: ["R01"] });

    const result = await generate({
      apiKey: null,
      artifacts: ["R01"],
      mode: "dry-run",
      regenerate: true,
    });

    expect(result.ok && result.data.paidCalls).toBe(1);
    expect(result.ok ? result.data.artifacts[0]?.state : null).toBe("planned");
  });

  /**
   * A dry run never reads the key, so it must not claim the key is missing.
   * Saying what it did not check is the whole difference between a preview and
   * a lie about a preview.
   */
  it("should say it never looked for the key rather than that the key is absent", async () => {
    await makeUpstream();
    await approvePackage();
    const result = await generate({ apiKey: null, mode: "dry-run" });

    expect(result.ok ? result.data.problems.join("\n") : "").toContain("nie był czytany");
  });

  it("should report the gate as an obstacle and still show the prompt", async () => {
    await makeUpstream();
    const result = await generate({ apiKey: null, mode: "dry-run" });

    expect(result.ok ? result.data.problems.join("\n") : "").toContain("--stage prompt-package");
    expect(result.ok ? result.data.artifacts[0]?.prompt : null).toContain("REFERENCE INPUTS");
  });
});

describe("checkReferences and approveReferences", () => {
  it("should report a drawn image as pending until somebody accepts it", async () => {
    await makeUpstream();
    await approvePackage();
    await generate();

    const status = await checkReferences({
      episodeId: EPISODE,
      projectId: PROJECT,
      track: "gpt-image",
      workspace,
    });

    expect(status.ok && status.data.approved).toBe(false);
    expect(status.ok ? status.data.artifacts[0]?.state : null).toBe("completed");
    expect(status.ok ? status.data.artifacts[0]?.approved : null).toBe(false);
    expect(status.ok ? status.data.nextStep : "").toContain("--stage references");
  });

  it("should refuse an approval that names nothing", async () => {
    await makeUpstream();
    await approvePackage();
    await generate();

    const result = await accept([]);

    expect(result.ok ? null : result.error.message).toContain("wskaż, co zatwierdzasz");
  });

  it("should refuse to accept something that was never drawn", async () => {
    await makeUpstream();
    await approvePackage();

    const result = await accept(["R01"]);

    expect(result.ok ? null : result.error.message).toContain("nie ma czego zatwierdzić");
  });

  it("should bind an approval to the bytes that were accepted", async () => {
    await makeUpstream();
    await approvePackage();
    await generate({ artifacts: ["R01"] });
    await accept(["R01"]);

    await writeFile(join(trackDir(), "references", "R01.png"), png(FRAME.width, FRAME.height + 16));

    const status = await checkReferences({
      episodeId: EPISODE,
      projectId: PROJECT,
      track: "gpt-image",
      workspace,
    });

    expect(status.ok ? status.data.artifacts[0]?.approved : null).toBe(false);
    expect(status.ok ? status.data.problems.join("\n") : "").toContain("zmieniony poza narzędziem");
  });

  it("should accept one reference without touching the others", async () => {
    await makeUpstream();
    await approvePackage();
    await generate();
    await accept(["R01"]);

    const stage = await readStageFile();

    expect(stage.artifacts.R01.review.status).toBe("approved");
    expect(stage.artifacts.R02.review.status).toBe("pending");
  });
});
