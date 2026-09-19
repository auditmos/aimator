import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { approveReferences, generateReferences } from "../references/index.js";
import { approveScreenplay, generateScreenplay } from "../screenplay/index.js";
import { approveShotList, generateShotList } from "../shot-list/index.js";
import { type ImageTrack, imageTracks, resolveWorkspace, type Workspace } from "../workspace.js";
import { approveOpeningFrame, checkOpeningFrame, generateOpeningFrame } from "./index.js";

/**
 * Stage 6 end to end, through the module entry.
 *
 * It is the first stage whose gate reads another stage's per-track results: the
 * opening frame waits for the references its manifest entry names, accepted on
 * this track and no other. It is also the first with exactly one artifact, so the flags
 * stage 5 needed to disambiguate a set — `--artifact` on a regenerate, on an
 * approval — have nothing here to disambiguate, and their absence is a tested
 * promise rather than an oversight.
 *
 * The fixture builds stages 0 to 5 through their own entries rather than by
 * writing files, so a change that breaks an upstream contract breaks here too.
 */

const API_KEY = "sk-test-0123456789";
const EPISODE = "01-burza";
const PROJECT = "ewa";
const CAST = ["ewa", "tata"] as const;
/** The film frame of a 16:9 episode: what both tracks render and validate. */
const FRAME = { height: 1584, width: 2816 };
/** What this episode's `opening.referenceIds` names, beside `hero:ewa`. */
const OPENING_NEEDS = "R01";

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

/**
 * `fill` exists so two images can share a frame and differ in bytes, which is
 * what a redrawn dependency looks like to a digest. Same size, same validity,
 * different hash.
 */
function png(width: number, height: number, fill = 0): Buffer {
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

  return Buffer.concat([head, Buffer.alloc(64, fill), tail]);
}

const HERO = png(1536, 2304);
const FILM = png(FRAME.width, FRAME.height);

interface Recorder {
  readonly calls: { body: unknown; prompt: string; url: string }[];
  readonly fetch: typeof fetch;
}

/**
 * The prompt a request carried, whichever shape it travelled in.
 *
 * gpt-image splits its endpoint by whether references are attached, and the one
 * that takes them — `/v1/images/edits` — is multipart, where every field is a
 * form entry rather than a JSON key. Reading only the JSON shape made an
 * assertion about rule 8 pass against an empty string.
 */
function promptOf(body: unknown): string {
  if (body instanceof FormData) {
    const field = body.get("prompt");

    return typeof field === "string" ? field : "";
  }

  return typeof body === "object" && body !== null && "prompt" in body
    ? String((body as { prompt: unknown }).prompt)
    : "";
}

/**
 * A provider that answers correctly, counting every request. Stage 6 buys
 * exactly one image, so the count is the assertion that matters most: a stage
 * that drew twice would be charging twice for one frame.
 */
function recorder(options: { readonly image?: Buffer } = {}): Recorder {
  const calls: { body: unknown; prompt: string; url: string }[] = [];
  const image = options.image ?? FILM;

  const impl = ((url: string | URL, init?: RequestInit) => {
    const href = String(url);

    if (href.startsWith("https://download/")) {
      calls.push({ body: null, prompt: "", url: href });
      return Promise.resolve(new Response(image, { status: 200 }));
    }

    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    calls.push({ body, prompt: promptOf(body), url: href });

    return Promise.resolve(
      href.includes("bytepluses.com")
        ? Response.json({ data: [{ url: "https://download/opening" }], id: "job-1" })
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
 * The opening frame depends on `hero:ewa` and `R01`, so stage 6's gate has one
 * thing to wait for that stage 5 had to draw first — which is the whole point
 * of the stage's position in the pipeline.
 */
function answer(): string {
  return JSON.stringify({
    clips: [
      {
        id: "C01",
        prompt: "Salon wieczorem, Ewa po lewej.",
        referenceIds: ["hero:ewa", "hero:tata", "R01"],
      },
      {
        id: "C02",
        prompt: "Oboje na dywanie.",
        referenceIds: ["hero:ewa", "hero:tata", "R01"],
      },
    ],
    entryFrames: [{ clipId: "C02", prompt: "Dokładnie końcowe położenie z C01." }],
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
  await approvePromptPackage({
    episodeId: EPISODE,
    mode: "apply",
    note: null,
    projectId: PROJECT,
    reviewer: "test",
    workspace,
  });
}

/** Stage 5 on one track, up to and including the human's acceptance of R01. */
async function makeReferences(track: ImageTrack): Promise<void> {
  await generateReferences({
    apiKey: API_KEY,
    artifacts: [],
    episodeId: EPISODE,
    fetch: recorder().fetch,
    mode: "apply",
    model: "gpt-image-2.5-sunburst",
    projectId: PROJECT,
    regenerate: false,
    track,
    workspace,
  });
  await approveReferences({
    artifacts: [OPENING_NEEDS],
    episodeId: EPISODE,
    mode: "apply",
    note: "ok",
    projectId: PROJECT,
    reviewer: "tester",
    track,
    workspace,
  });
}

function generate(overrides: Partial<Parameters<typeof generateOpeningFrame>[0]> = {}) {
  return generateOpeningFrame({
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

function accept(overrides: Partial<Parameters<typeof approveOpeningFrame>[0]> = {}) {
  return approveOpeningFrame({
    artifacts: [],
    episodeId: EPISODE,
    mode: "apply",
    note: "ok",
    projectId: PROJECT,
    reviewer: "tester",
    track: "gpt-image",
    workspace,
    ...overrides,
  });
}

function inspect(track: ImageTrack = "gpt-image") {
  return checkOpeningFrame({ episodeId: EPISODE, projectId: PROJECT, track, workspace });
}

function trackDir(track: ImageTrack = "gpt-image"): string {
  return join(root, "projects", PROJECT, "episodes", EPISODE, track);
}

async function readStageFile(track: ImageTrack = "gpt-image") {
  return JSON.parse(await readFile(join(trackDir(track), "opening-frame.stage.json"), "utf8"));
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aimator-stage6-"));
  root = join(scratch, "workspace");
  const resolved = resolveWorkspace(root);
  workspace = resolved.ok ? resolved.data : { root: "" };
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

describe("generateOpeningFrame gates", () => {
  it("should refuse to spend until the reference it names is approved on this track", async () => {
    await makeUpstream();
    const call = recorder();
    const result = await generate({ fetch: call.fetch });

    expect(call.calls).toHaveLength(0);
    expect(result.ok ? null : result.error.message).toContain(OPENING_NEEDS);
  });

  /**
   * The gate reads this track's own results. A reference accepted on gpt-image
   * says nothing about seedream, exactly as stage 5's own graph gate does.
   */
  it("should not let an approval on one track open the other", async () => {
    await makeUpstream();
    await makeReferences("gpt-image");
    const call = recorder();
    const result = await generate({ fetch: call.fetch, track: "seedream" });

    expect(call.calls).toHaveLength(0);
    expect(result.ok ? null : result.error.message).toContain(OPENING_NEEDS);
  });

  it("should refuse a model nobody chose", async () => {
    await makeUpstream();
    await makeReferences("gpt-image");
    const call = recorder();
    const result = await generate({ fetch: call.fetch, model: null });

    expect(call.calls).toHaveLength(0);
    expect(result.ok ? null : result.error.message).toContain("--model");
  });

  it("should refuse an --artifact that is not the opening frame", async () => {
    await makeUpstream();
    const call = recorder();
    const result = await generate({ artifacts: ["R01"], fetch: call.fetch });

    expect(call.calls).toHaveLength(0);
    expect(result.ok ? null : result.error.message).toContain("etap 6");
  });
});

describe("generateOpeningFrame --dry-run", () => {
  it("should show the whole prompt, count one call and spend nothing", async () => {
    await makeUpstream();
    await makeReferences("gpt-image");
    const call = recorder();
    const result = await generate({ fetch: call.fetch, mode: "dry-run" });

    expect(call.calls).toHaveLength(0);
    expect(result.ok ? result.data.paidCalls : null).toBe(1);
    expect(result.ok ? result.data.size : null).toBe(`${FRAME.width}x${FRAME.height}`);
    expect(result.ok ? result.data.artifact.prompt : null).toContain("Image 1 =");
  });

  /** A dry run never reads the key, so it must not claim the key is missing. */
  it("should say the key was not read rather than that it is absent", async () => {
    await makeUpstream();
    await makeReferences("gpt-image");
    const result = await generate({ apiKey: null, mode: "dry-run" });

    expect(result.ok ? result.data.problems.join("\n") : null).toContain("nie był czytany");
  });

  it("should report the gate as an obstacle and still show the prompt", async () => {
    await makeUpstream();
    const result = await generate({ mode: "dry-run" });

    expect(result.ok ? result.data.paidCalls : null).toBe(0);
    expect(result.ok ? result.data.artifact.state : null).toBe("blocked");
  });
});

describe("generateOpeningFrame", () => {
  it("should buy exactly one image and publish it under the track", async () => {
    await makeUpstream();
    await makeReferences("gpt-image");
    const call = recorder();
    const result = await generate({ fetch: call.fetch });

    expect(result.ok ? result.data.paidCalls : null).toBe(1);
    expect(call.calls).toHaveLength(1);

    const stage = await readStageFile();
    expect(stage.stage).toBe("opening-frame");
    expect(stage.artifacts["opening-frame"].status).toBe("completed");
    expect(stage.artifacts["opening-frame"].review.status).toBe("pending");
    expect(await readFile(join(trackDir(), "opening-frame.png"))).toEqual(FILM);
  });

  /** Rule 8: the text addresses its attachments by position in the list. */
  it("should send the attachment block ahead of the task", async () => {
    await makeUpstream();
    await makeReferences("gpt-image");
    const call = recorder();
    await generate({ fetch: call.fetch });

    const prompt = call.calls[0]?.prompt ?? "";
    expect(prompt).toContain("Image 1 = hero:ewa");
    expect(prompt).toContain(`Image 2 = ${OPENING_NEEDS}`);
    expect(prompt.indexOf("Image 1 =")).toBeLessThan(prompt.indexOf("Ewa centralnie"));
  });

  it("should record the shot list, because the opening frame carries its shots", async () => {
    await makeUpstream();
    await makeReferences("gpt-image");
    await generate();

    const stage = await readStageFile();
    const inputs = stage.artifacts["opening-frame"].inputs.map((one: { path: string }) => one.path);
    expect(inputs.some((path: string) => path.endsWith("shot-list.md"))).toBe(true);
  });

  it("should not redraw a finished frame without --regenerate", async () => {
    await makeUpstream();
    await makeReferences("gpt-image");
    await generate();
    const call = recorder();
    const result = await generate({ fetch: call.fetch });

    expect(call.calls).toHaveLength(0);
    expect(result.ok ? result.data.paidCalls : null).toBe(0);
  });

  /**
   * With one artifact there is nothing for `--artifact` to disambiguate, so a
   * bare `--regenerate` is unambiguous and must work. Stage 5 needs the flag
   * because it has six candidates; copying that ceremony here would be asking
   * for an answer that has only one possible value.
   */
  it("should accept a bare --regenerate and draw again", async () => {
    await makeUpstream();
    await makeReferences("gpt-image");
    await generate();
    const call = recorder();
    const result = await generate({ fetch: call.fetch, regenerate: true });

    expect(call.calls).toHaveLength(1);
    expect(result.ok ? result.data.paidCalls : null).toBe(1);
  });

  it("should keep the previous frame when it regenerates", async () => {
    await makeUpstream();
    await makeReferences("gpt-image");
    await generate();
    await generate({ regenerate: true });

    const stage = await readStageFile();
    const { runId } = stage.artifacts["opening-frame"];
    expect(await readFile(join(trackDir(), "runs", runId, "previous.png"))).toEqual(FILM);
  });

  it("should refuse to publish an image in the wrong frame", async () => {
    await makeUpstream();
    await makeReferences("gpt-image");
    const call = recorder({ image: png(1024, 1024) });
    const result = await generate({ fetch: call.fetch });

    expect(result.ok).toBe(false);

    const stage = await readStageFile();
    expect(stage.artifacts["opening-frame"].status).toBe("submitted");
  });
});

describe("checkOpeningFrame", () => {
  it("should report a drawn frame as pending and write nothing", async () => {
    await makeUpstream();
    await makeReferences("gpt-image");
    await generate();
    const before = await readStageFile();
    const status = await inspect();

    expect(status.ok ? status.data.approved : null).toBe(false);
    expect(status.ok ? status.data.artifact.state : null).toBe("completed");
    expect(await readStageFile()).toEqual(before);
  });

  it("should report a frame that was never drawn", async () => {
    await makeUpstream();
    await makeReferences("gpt-image");
    const status = await inspect();

    expect(status.ok ? status.data.artifact.state : null).toBe("absent");
  });
});

describe("approveOpeningFrame", () => {
  /** One artifact, so the command itself is the naming — no flag to repeat. */
  it("should accept the frame without an --artifact flag", async () => {
    await makeUpstream();
    await makeReferences("gpt-image");
    await generate();
    const result = await accept();

    expect(result.ok ? result.data.approved : null).toBe(true);

    const stage = await readStageFile();
    expect(stage.artifacts["opening-frame"].review.status).toBe("approved");
    expect(stage.artifacts["opening-frame"].review.reviewer).toBe("tester");
  });

  it("should still accept an explicit --artifact opening-frame", async () => {
    await makeUpstream();
    await makeReferences("gpt-image");
    await generate();
    const result = await accept({ artifacts: ["opening-frame"] });

    expect(result.ok ? result.data.approved : null).toBe(true);
  });

  it("should refuse an --artifact naming something else", async () => {
    await makeUpstream();
    await makeReferences("gpt-image");
    await generate();
    const result = await accept({ artifacts: ["R01"] });

    expect(result.ok ? null : result.error.message).toContain("opening-frame");
  });

  it("should refuse to accept a frame that does not exist", async () => {
    await makeUpstream();
    await makeReferences("gpt-image");
    const result = await accept();

    expect(result.ok).toBe(false);
  });

  /** Acceptance is bound to bytes: editing the image revokes it. */
  it("should stop reporting an approval once the bytes change", async () => {
    await makeUpstream();
    await makeReferences("gpt-image");
    await generate();
    await accept();
    await writeFile(join(trackDir(), "opening-frame.png"), png(FRAME.width, FRAME.height + 16));
    const status = await inspect();

    expect(status.ok ? status.data.approved : null).toBe(false);
  });

  /**
   * Input drift is an expiry of consent, not a validation failure: the frame is
   * exactly what stage 6 produced, drawn from a reference that has since been
   * redrawn. `approve` re-records the digests, because the person who typed it
   * is the one who looked at both.
   */
  it("should let an approval re-record a reference that drifted", async () => {
    await makeUpstream();
    await makeReferences("gpt-image");
    await generate();
    await accept();
    await generateReferences({
      apiKey: API_KEY,
      artifacts: [OPENING_NEEDS],
      episodeId: EPISODE,
      // Same frame, different bytes: a redrawn R01 that still validates.
      fetch: recorder({ image: png(FRAME.width, FRAME.height, 7) }).fetch,
      mode: "apply",
      model: "gpt-image-2.5-sunburst",
      projectId: PROJECT,
      regenerate: true,
      track: "gpt-image",
      workspace,
    });
    await approveReferences({
      artifacts: [OPENING_NEEDS],
      episodeId: EPISODE,
      mode: "apply",
      note: "ok",
      projectId: PROJECT,
      reviewer: "tester",
      track: "gpt-image",
      workspace,
    });

    const drifted = await inspect();
    expect(drifted.ok ? drifted.data.approved : null).toBe(false);
    expect(drifted.ok ? drifted.data.artifact.inputsChanged.length : 0).toBeGreaterThan(0);

    const again = await accept();
    expect(again.ok ? again.data.approved : null).toBe(true);
  });
});
