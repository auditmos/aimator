import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { imageTracks, resolveWorkspace, type Workspace } from "../workspace.js";
import { type PlannedArtifact, readSendPlan, type SendPlan } from "./index.js";

/**
 * The composer, through the module entry: the numbered block a request really
 * carries, the per-track resolution of ids that name no track, the gate that
 * falls out of that resolution, and the refusal when a track cannot carry the
 * set a human approved.
 *
 * The fixture builds stages 0 to 4 through their own entries rather than by
 * writing files, so what is composed here is composed from artifacts the
 * pipeline actually produces.
 */

const API_KEY = "sk-test-0123456789";
const EPISODE = "01-burza";
const PROJECT = "ewa";
const CAST = ["ewa", "tata"] as const;
const RULES = "# Ewa — zasady wspólne\n\nPłaskie 2D. Paleta dziesięciu barw.\n";

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

/** A PNG as far as the validator reads one, at the size a hero must have. */
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

/** A package the validator accepts, as the model would return it. */
function answer(extraReferences = 0): string {
  const extra = Array.from({ length: extraReferences }, (_, index) => ({
    dependsOn: ["R01"],
    id: `R${String(index + 3).padStart(2, "0")}`,
    kind: "prop" as const,
    prompt: `Rekwizyt numer ${index + 3}, odizolowany.`,
    subject: `Rekwizyt ${index + 3}`,
  }));
  const ids = ["R01", "R02", ...extra.map((one) => one.id)];

  return JSON.stringify({
    clips: [
      {
        id: "C01",
        prompt: "Salon wieczorem, Ewa po lewej, tata na kanapie.",
        referenceIds: ["hero:ewa", "hero:tata", ...ids],
      },
      {
        id: "C02",
        prompt: "Oboje na dywanie, alpaka przy policzku Ewy.",
        referenceIds: ["hero:ewa", "hero:tata", "R01"],
      },
    ],
    entryFrames: [{ clipId: "C02", prompt: "Dokładnie końcowe położenie z C01." }],
    opening: {
      prompt: "Ewa centralnie na bursztynowym tle, cała sylwetka.",
      referenceIds: ["hero:ewa", "R01"],
    },
    references: [
      {
        dependsOn: ["hero:ewa"],
        id: "R01",
        kind: "location",
        prompt: "Salon z niską kanapą i zamkniętym oknem po lewej.",
        subject: "Living room — evening",
      },
      {
        dependsOn: ["hero:tata", "R01"],
        id: "R02",
        kind: "prop",
        prompt: "Pluszowa alpaka, ucho ugięte kontaktem z policzkiem.",
        subject: "Alpaca toy — contact-bent ear",
      },
      ...extra,
    ],
    review: "Do rozstrzygnięcia: skala alpaki przy twarzy taty.",
  });
}

function completion(text: string): string {
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

async function makeHero(characterId: string, track: string, approved = true): Promise<void> {
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
            review: approved
              ? {
                  note: null,
                  reviewedAt: "2026-09-18T10:05:00.000Z",
                  reviewer: "test",
                  status: "approved",
                }
              : { note: null, reviewedAt: null, reviewer: null, status: "pending" },
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

/** Stages 0 to 4, all accepted, with a canonical image per cast and track. */
async function makeUpstream(
  options: { approvePackage?: boolean; extraReferences?: number } = {}
): Promise<void> {
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

  await writeFile(join(root, "projects", PROJECT, "project.md"), RULES, "utf8");
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

  // Stage 4 refuses to plan until both tracks carry an accepted hero, so the
  // fixture cannot start with one track short.
  await Promise.all(CAST.flatMap((id) => imageTracks.map((track) => makeHero(id, track))));

  await generateScreenplay({
    apiKey: API_KEY,
    episodeId: EPISODE,
    fetch: respondWith(completion(screenplay())),
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
    fetch: respondWith(completion(shotList())),
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
    fetch: respondWith(completion(answer(options.extraReferences ?? 0))),
    maxOutputTokens: 32_000,
    mode: "apply",
    model: "gpt-6-astra",
    projectId: PROJECT,
    regenerate: false,
    republish: false,
    workspace,
  });

  if (options.approvePackage !== false) {
    await approvePromptPackage({
      episodeId: EPISODE,
      mode: "apply",
      note: null,
      projectId: PROJECT,
      reviewer: "test",
      workspace,
    });
  }
}

async function plan(
  track: (typeof imageTracks)[number] = "gpt-image",
  targets: readonly string[] = []
): Promise<SendPlan> {
  const result = await readSendPlan({
    episodeId: EPISODE,
    projectId: PROJECT,
    targets,
    track,
    workspace,
  });

  if (!result.ok) {
    throw result.error;
  }

  return result.data;
}

function artifact(sent: SendPlan, name: string): PlannedArtifact {
  const found = sent.artifacts.find((one) => one.name === name);

  if (found === undefined) {
    throw new Error(`brak artefaktu ${name}`);
  }

  return found;
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aimator-compose-"));
  root = join(scratch, "workspace");
  const resolved = resolveWorkspace(root);
  workspace = resolved.ok ? resolved.data : { root: "" };
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

describe("readSendPlan", () => {
  it("should list every artifact the package plans, in production order", async () => {
    await makeUpstream();
    const sent = await plan();

    expect(sent.artifacts.map((one) => one.name)).toEqual([
      "R01",
      "R02",
      "opening-frame",
      "C01",
      "entry:C02",
      "C02",
    ]);
  });

  it("should compose nothing until an artifact is named", async () => {
    await makeUpstream();
    const sent = await plan();

    expect(sent.artifacts.every((one) => one.text === null)).toBe(true);
  });

  /** Rule 8: the text addresses a position, and the position is generated here. */
  it("should number the attachments in the order the manifest assigned them", async () => {
    await makeUpstream();
    const sent = await plan("gpt-image", ["R02"]);
    const { text } = artifact(sent, "R02");

    expect(text).toContain("REFERENCE INPUTS — IN THIS ORDER");
    expect(text).toContain("Image 1 = hero:tata — the canonical image of Tata");
    expect(text).toContain("Image 2 = R01 — location reference: Living room — evening");
  });

  it("should put the numbered block ahead of the direction that names those ids", async () => {
    await makeUpstream();
    const { text } = artifact(await plan("gpt-image", ["R02"]), "R02");
    const block = text?.indexOf("Image 1 = hero:tata") ?? -1;
    const direction = text?.indexOf("# R02 — Alpaca toy — contact-bent ear") ?? -1;

    expect(block).toBeGreaterThanOrEqual(0);
    expect(direction).toBeGreaterThan(block);
  });

  it("should quote the project rules verbatim at the end", async () => {
    await makeUpstream();
    const { text } = artifact(await plan("gpt-image", ["R01"]), "R01");

    expect(text?.endsWith(RULES)).toBe(true);
  });

  it("should state the film frame derived from the project's aspect ratio", async () => {
    await makeUpstream();
    const sent = await plan("gpt-image", ["R01"]);

    expect(sent.size).toBe("2816x1584");
    expect(artifact(sent, "R01").text).toContain("2816x1584 pixels — the 16:9 film frame");
  });

  it("should draw both tracks in the same frame, so the two results compare", async () => {
    await makeUpstream();

    expect((await plan("seedream")).size).toBe((await plan("gpt-image")).size);
  });

  /** A reference is an asset, not a frame of the film, so it is in no shot. */
  it("should attach no shot-list entries to a reference", async () => {
    await makeUpstream();
    const { text } = artifact(await plan("gpt-image", ["R01"]), "R01");

    expect(text).not.toContain("AUTHORITATIVE SHOTS");
  });

  it("should attach the clip and its shots verbatim to a clip", async () => {
    await makeUpstream();
    const { text } = artifact(await plan("gpt-image", ["C01"]), "C01");

    expect(text).toContain("AUTHORITATIVE SHOTS");
    expect(text).toContain("### C01 | 0-15s");
    expect(text).toContain("### U01 | S01 | C01 | 0-10s");
    expect(text).toContain("### U02 | S02 | C01 | 10-15s");
    expect(text).not.toContain("### U03");
  });

  it("should give an entry frame the references and the shots of its own clip", async () => {
    await makeUpstream();
    const entry = artifact(await plan("gpt-image", ["entry:C02"]), "entry:C02");

    expect(entry.attachments.map((one) => one.id)).toEqual(["hero:ewa", "hero:tata", "R01"]);
    expect(entry.text).toContain("### C02 | 15-30s");
  });

  /** Rule 2, at the last possible moment: one manifest, two sets of files. */
  it("should resolve the same identifiers to a different file on each track", async () => {
    await makeUpstream();
    const gpt = artifact(await plan("gpt-image", []), "R02");
    const seed = artifact(await plan("seedream", []), "R02");

    expect(gpt.attachments[0]?.path).toContain("/gpt-image/hero.png");
    expect(seed.attachments[0]?.path).toContain("/seedream/hero.png");
  });

  it("should report a reference that has not been drawn on this track", async () => {
    await makeUpstream();
    const { attachments, blockers } = artifact(await plan("gpt-image"), "R02");

    expect(attachments.find((one) => one.id === "R01")?.state).toBe("absent");
    expect(blockers.join("\n")).toContain("jeszcze nie powstał na torze gpt-image");
  });

  /**
   * The package is shared and its own gate asks both tracks, so the divergence
   * only appears afterwards: one track's acceptance is withdrawn and the other
   * keeps drawing.
   */
  it("should block only the track whose canonical image is no longer accepted", async () => {
    await makeUpstream();
    await makeHero("ewa", "seedream", false);

    expect(artifact(await plan("gpt-image"), "R01").blockers).toEqual([]);
    expect(artifact(await plan("seedream"), "R01").blockers.join("\n")).toContain(
      "--stage character --track seedream"
    );
  });

  /**
   * Decision: a set a track cannot carry is refused on that track, not trimmed,
   * and not refused for both by the stricter of the two.
   */
  it("should refuse an over-long reference set on the track that cannot carry it", async () => {
    await makeUpstream({ extraReferences: 9 });
    const seed = artifact(await plan("seedream"), "C01");
    const gpt = artifact(await plan("gpt-image"), "C01");

    expect(seed.attachments.length).toBe(13);
    expect(seed.blockers.join("\n")).toContain("tor seedream przyjmuje najwyżej 10");
    expect(gpt.blockers.join("\n")).not.toContain("przyjmuje najwyżej");
  });

  it("should report an unapproved package as a plan-level obstacle", async () => {
    await makeUpstream({ approvePackage: false });
    const sent = await plan();

    expect(sent.problems.join("\n")).toContain("--stage prompt-package");
  });

  it("should still compose the prompt while the package is unapproved", async () => {
    await makeUpstream({ approvePackage: false });
    const { text } = artifact(await plan("gpt-image", ["R01"]), "R01");

    expect(text).toContain("REFERENCE INPUTS");
  });

  it("should record what one call consumes, with a digest for each file", async () => {
    await makeUpstream();
    const { inputs } = artifact(await plan("gpt-image", ["R01"]), "R01");
    const paths = inputs.map((one) => one.path);

    expect(paths).toContain(`projects/${PROJECT}/project.md`);
    expect(paths).toContain(`projects/${PROJECT}/episodes/${EPISODE}/prompt-package.json`);
    expect(paths).toContain(`projects/${PROJECT}/episodes/${EPISODE}/prompts/references/R01.md`);
    expect(paths).toContain(`projects/${PROJECT}/characters/ewa/gpt-image/hero.png`);
    expect(inputs.every((one) => one.sha256.length === 64)).toBe(true);
  });

  /** A reference quotes no shots, so it must not claim the shot list as input. */
  it("should record the shot list only where the prompt actually quotes it", async () => {
    await makeUpstream();
    const sent = await plan("gpt-image", []);
    const shotListPath = `projects/${PROJECT}/episodes/${EPISODE}/shot-list.md`;

    expect(artifact(sent, "R01").inputs.map((one) => one.path)).not.toContain(shotListPath);
    expect(artifact(sent, "C01").inputs.map((one) => one.path)).toContain(shotListPath);
  });

  it("should refuse a name this package does not plan", async () => {
    await makeUpstream();
    const result = await readSendPlan({
      episodeId: EPISODE,
      projectId: PROJECT,
      targets: ["R09"],
      track: "gpt-image",
      workspace,
    });

    expect(result.ok ? null : result.error.message).toContain("R01, R02, opening-frame");
  });
});
