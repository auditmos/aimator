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
import { approveScreenplay, generateScreenplay } from "../screenplay/index.js";
import { approveShotList, generateShotList } from "../shot-list/index.js";
import { imageTracks, resolveWorkspace, type Workspace } from "../workspace.js";
import { approvePromptPackage, checkPromptPackage, generatePromptPackage } from "./index.js";

/**
 * Stage 4 end to end, through the module entry: the two gates, the dry run that
 * touches nothing, the single paid attempt, the split into a manifest and a
 * tree of prompt files, the resume that costs nothing, and the approval that is
 * never implied.
 *
 * The gate on the canonical images is what makes this stage different from the
 * two text stages before it, so it is exercised per track — one track ready is
 * deliberately not enough for an artifact both tracks share.
 */

const API_KEY = "sk-test-0123456789";
const EPISODE = "01-burza";
const PROJECT = "ewa";
const CAST = ["ewa", "tata"] as const;

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };
let calls = 0;

function episodeDir(): string {
  return join(root, "projects", PROJECT, "episodes", EPISODE);
}

/** A PNG as far as the validator reads one, at the size a hero must have. */
function png(width: number, height: number, colorType = 2): Buffer {
  const head = Buffer.alloc(26);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "ascii");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  head.writeUInt8(8, 24);
  head.writeUInt8(colorType, 25);

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
function answer(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    clips: [
      {
        id: "C01",
        prompt: "Salon wieczorem, Ewa po lewej, tata na kanapie.",
        referenceIds: ["hero:ewa", "hero:tata", "R01", "R02"],
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
        subject: "Salon wieczorem",
      },
      {
        dependsOn: ["R01"],
        id: "R02",
        kind: "prop",
        prompt: "Pluszowa alpaka, ucho ugięte kontaktem z policzkiem.",
        subject: "Alpaka, ucho ugięte",
      },
    ],
    review: "Do rozstrzygnięcia: skala alpaki przy twarzy taty.",
    ...overrides,
  });
}

function completion(text: string): string {
  return JSON.stringify({
    id: "resp_package_1",
    model: "gpt-6-astra",
    output: [{ content: [{ text, type: "output_text" }], role: "assistant", type: "message" }],
    status: "completed",
  });
}

function respondWith(body: string, status = 200): typeof fetch {
  return (() => {
    calls += 1;
    return Promise.resolve(new Response(body, { headers: { "x-request-id": "req_1" }, status }));
  }) as unknown as typeof fetch;
}

async function generate(
  overrides: Partial<Parameters<typeof generatePromptPackage>[0]> = {}
): ReturnType<typeof generatePromptPackage> {
  return await generatePromptPackage({
    apiKey: API_KEY,
    episodeId: EPISODE,
    fetch: respondWith(completion(answer())),
    maxOutputTokens: 32_000,
    mode: "apply",
    model: "gpt-6-astra",
    projectId: PROJECT,
    regenerate: false,
    republish: false,
    workspace,
    ...overrides,
  });
}

/**
 * An accepted canonical image for one character on one track, written directly.
 *
 * Stage 2 is exercised by its own tests; what stage 4 needs from it is only the
 * fact its gate reads — a finished, accepted `hero.png` whose bytes still hash
 * to what the record says.
 */
async function makeHero(characterId: string, track: string, approved = true): Promise<void> {
  const dir = join(root, "projects", PROJECT, "characters", characterId, track);
  const image = join(dir, "hero.png");

  await mkdir(dir, { recursive: true });
  await writeFile(image, HERO);
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

/** Stage 0 through 3, all accepted, plus a canonical image per cast and track. */
async function makeUpstream(
  options: { approve?: boolean; heroes?: "all" | "none" | "one-track" } = {}
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

  await writeFile(join(root, "projects", PROJECT, "project.md"), "# Ewa\n\nZasady.\n", "utf8");
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

  if (options.approve !== false) {
    await approveShotList({
      episodeId: EPISODE,
      mode: "apply",
      note: null,
      projectId: PROJECT,
      reviewer: "test",
      workspace,
    });
  }

  const heroes = options.heroes ?? "all";

  if (heroes !== "none") {
    const wanted = imageTracks.filter((track) => heroes === "all" || track === "gpt-image");

    await Promise.all(
      CAST.flatMap((characterId) => wanted.map((track) => makeHero(characterId, track)))
    );
  }

  calls = 0;
}

async function runDirs(): Promise<string[]> {
  return await readdir(join(episodeDir(), "runs")).catch(() => []);
}

async function promptFiles(): Promise<string[]> {
  const entries = await readdir(join(episodeDir(), "prompts"), {
    recursive: true,
    withFileTypes: true,
  }).catch(() => []);

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(join(episodeDir(), "prompts").length))
    .sort();
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aimator-stage4-"));
  root = join(scratch, "workspace");
  const resolved = resolveWorkspace(root);
  workspace = resolved.ok ? resolved.data : { root: "" };
  calls = 0;
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

describe("generatePromptPackage", () => {
  it("should refuse to spend until the shot list carries an approval", async () => {
    await makeUpstream({ approve: false });
    const result = await generate();

    expect(calls).toBe(0);
    expect(result.ok ? null : result.error.message).toContain("--stage shot-list");
  });

  it("should refuse to spend while a canonical image is missing on either track", async () => {
    await makeUpstream({ heroes: "one-track" });
    const result = await generate();

    expect(calls).toBe(0);
    expect(result.ok ? null : result.error.message).toContain("seedream");
  });

  it("should name every character the plan puts on screen when no image exists", async () => {
    await makeUpstream({ heroes: "none" });
    const result = await generate();
    const message = result.ok ? "" : result.error.message;

    expect(calls).toBe(0);
    for (const characterId of CAST) {
      expect(message).toContain(`postać "${characterId}"`);
    }
  });

  it("should show the prompt in a dry run without writing, sending or reading a key", async () => {
    await makeUpstream();
    const result = await generate({ apiKey: null, mode: "dry-run" });

    expect(calls).toBe(0);
    expect(result.ok ? result.data.ready : null).toBe(true);
    expect(result.ok ? result.data.prompt : null).toContain("## Clips");
    expect(await readdir(episodeDir())).not.toContain("prompt-package.json");
  });

  it("should report the gate in a dry run instead of hiding it", async () => {
    await makeUpstream({ heroes: "none" });
    const result = await generate({ apiKey: null, mode: "dry-run" });

    expect(result.ok ? result.data.ready : null).toBe(false);
    expect(result.ok ? result.data.problems.join(" ") : null).toContain("hero.png");
  });

  it("should publish a manifest and one prompt file per future paid call", async () => {
    await makeUpstream();
    const result = await generate();

    expect(result.ok).toBe(true);
    expect(calls).toBe(1);
    expect(await promptFiles()).toEqual([
      "/clips/C01.md",
      "/clips/C02.md",
      "/entry-frames/C02.md",
      "/opening-frame.md",
      "/references/R01.md",
      "/references/R02.md",
    ]);
  });

  /**
   * The whole file is sent to an image model, heading included. Instructing the
   * model to write English while the renderer wrote Polish into the same file
   * left half the rule unenforced.
   */
  it("should write every published prompt in English, heading included", async () => {
    await makeUpstream();
    await generate();

    const opening = await readFile(join(episodeDir(), "prompts", "opening-frame.md"), "utf8");
    const entry = await readFile(join(episodeDir(), "prompts", "entry-frames", "C02.md"), "utf8");

    expect(opening.split("\n")[0]).toBe("# Opening frame");
    expect(entry.split("\n")[0]).toBe("# C02 — entry frame");
  });

  it("should keep the prose out of the manifest and the wiring out of the prompts", async () => {
    await makeUpstream();
    await generate();

    const manifest = await readFile(join(episodeDir(), "prompt-package.json"), "utf8");
    const clip = await readFile(join(episodeDir(), "prompts", "clips", "C01.md"), "utf8");

    expect(manifest).not.toContain("Salon wieczorem, Ewa po lewej");
    expect(manifest).toContain('"dependsOn"');
    expect(clip).toContain("Salon wieczorem, Ewa po lewej");
    expect(clip).not.toContain("hero:ewa");
  });

  it("should record every published file among the outputs", async () => {
    await makeUpstream();
    await generate();

    const stage = JSON.parse(
      await readFile(join(episodeDir(), "prompt-package.stage.json"), "utf8")
    ) as { artifacts: { "prompt-package": { outputs: { path: string }[] } } };

    expect(stage.artifacts["prompt-package"].outputs).toHaveLength(7);
  });

  it("should record the canonical images among the inputs although it never sent them", async () => {
    await makeUpstream();
    await generate();

    const stage = JSON.parse(
      await readFile(join(episodeDir(), "prompt-package.stage.json"), "utf8")
    ) as { artifacts: { "prompt-package": { inputs: { path: string }[] } } };
    const request = JSON.parse(
      await readFile(join(episodeDir(), "runs", (await runDirs())[2] ?? "", "request.json"), "utf8")
    ) as { input: string };

    expect(
      stage.artifacts["prompt-package"].inputs.filter((one) => one.path.endsWith("hero.png"))
    ).toHaveLength(4);
    expect(request.input).not.toContain("iVBOR");
  });

  it("should not publish a package whose wiring contradicts the shot list", async () => {
    await makeUpstream();
    const result = await generate({
      fetch: respondWith(
        completion(
          answer({
            clips: [
              { id: "C01", prompt: "Salon.", referenceIds: ["hero:ewa", "R01", "R02"] },
              { id: "C02", prompt: "Dywan.", referenceIds: ["hero:ewa", "R01"] },
            ],
          })
        )
      ),
    });

    expect(result.ok ? null : result.error.message).toContain("hero:tata");
    expect(await readdir(episodeDir())).not.toContain("prompt-package.json");
  });

  it("should keep a package that already exists and demand --regenerate", async () => {
    await makeUpstream();
    await generate();
    calls = 0;
    const again = await generate();

    expect(calls).toBe(0);
    expect(again.ok ? null : again.error.message).toContain("--regenerate");
  });

  it("should finish an interrupted attempt from the saved answer without paying again", async () => {
    await makeUpstream();
    await generate();
    const [runId] = (await runDirs()).filter(async (id) =>
      (await readdir(join(episodeDir(), "runs", id))).includes("response.json")
    );
    const stagePath = join(episodeDir(), "prompt-package.stage.json");
    const stage = JSON.parse(await readFile(stagePath, "utf8")) as {
      artifacts: { "prompt-package": { status: string } };
    };

    // An attempt that died between the POST and the publication: the answer is
    // on disk and already paid for, so finishing it must send nothing.
    stage.artifacts["prompt-package"].status = "submitted";
    await writeFile(stagePath, `${JSON.stringify(stage, null, 2)}\n`, "utf8");
    await rm(join(episodeDir(), "prompt-package.json"));
    calls = 0;

    const resumed = await generate();

    expect(runId).toBeDefined();
    expect(calls).toBe(0);
    expect(resumed.ok).toBe(true);
    expect(await readdir(episodeDir())).toContain("prompt-package.json");
  });

  /**
   * A renderer found wrong after publication is this stage's own mistake, and
   * the answer it would be re-derived from is already bought. Charging for it
   * again would make a bug in this repo billable to the user.
   */
  it("should publish the archived answer again without sending anything", async () => {
    await makeUpstream();
    await generate();
    await rm(join(episodeDir(), "prompts", "clips", "C01.md"));
    calls = 0;

    const again = await generate({ republish: true });
    const runs = await runDirs();

    expect(calls).toBe(0);
    expect(again.ok).toBe(true);
    expect(await promptFiles()).toContain("/clips/C01.md");
    // The same attempt, not a new one: no run id is minted for work nobody did.
    expect(runs).toHaveLength(3);
  });

  it("should refuse to republish an attempt that saved no answer", async () => {
    await makeUpstream();
    const result = await generate({ republish: true });

    expect(calls).toBe(0);
    expect(result.ok ? null : result.error.message).toContain("nie ma czego opublikować ponownie");
  });

  it("should refuse to republish against inputs that have changed since", async () => {
    await makeUpstream();
    await generate();
    await writeFile(
      join(root, "projects", PROJECT, "characters", "ewa", "seedream", "hero.png"),
      png(1536, 2304, 6)
    );
    calls = 0;

    const again = await generate({ republish: true });

    expect(calls).toBe(0);
    expect(again.ok ? null : again.error.message).toContain("hero.png");
  });

  it("should keep the previous package when --regenerate replaces it", async () => {
    await makeUpstream();
    await generate();
    await generate({ regenerate: true });

    const kept = await Promise.all(
      (await runDirs()).map((runId) =>
        readdir(join(episodeDir(), "runs", runId, "previous"), { recursive: true }).catch(() => [])
      )
    );

    expect(kept.flat()).toContain("prompt-package.json");
  });

  it("should remove a prompt file the new package no longer plans", async () => {
    await makeUpstream();
    await generate();
    await generate({
      fetch: respondWith(
        completion(
          answer({
            clips: [
              {
                id: "C01",
                prompt: "Salon.",
                referenceIds: ["hero:ewa", "hero:tata", "R01"],
              },
              {
                id: "C02",
                prompt: "Dywan.",
                referenceIds: ["hero:ewa", "hero:tata", "R01"],
              },
            ],
            references: [
              {
                dependsOn: ["hero:ewa"],
                id: "R01",
                kind: "location",
                prompt: "Salon z niską kanapą.",
                subject: "Salon wieczorem",
              },
            ],
          })
        )
      ),
      regenerate: true,
    });

    expect(await promptFiles()).not.toContain("/references/R02.md");
  });

  it("should release the lock so the next attempt is not blocked by the last", async () => {
    await makeUpstream();
    await generate();

    expect(await readdir(episodeDir())).not.toContain("prompt-package.lock");
  });
});

describe("checkPromptPackage and approvePromptPackage", () => {
  const scope = () => ({ episodeId: EPISODE, projectId: PROJECT, workspace });

  it("should report a package that validates as still unaccepted", async () => {
    await makeUpstream();
    await generate();
    const status = await checkPromptPackage(scope());

    expect(status.ok ? status.data.status : null).toBe("completed");
    expect(status.ok ? status.data.approved : null).toBe(false);
    expect(status.ok ? status.data.problems : null).toEqual([]);
  });

  it("should record an acceptance bound to the bytes that were verified", async () => {
    await makeUpstream();
    await generate();
    const approved = await approvePromptPackage({
      ...scope(),
      mode: "apply",
      note: "wygląda dobrze",
      reviewer: "test",
    });
    const status = await checkPromptPackage(scope());

    expect(approved.ok ? approved.data.approved : null).toBe(true);
    expect(status.ok ? status.data.approved : null).toBe(true);
  });

  it("should revoke the acceptance when a prompt file is edited outside the tool", async () => {
    await makeUpstream();
    await generate();
    await approvePromptPackage({
      ...scope(),
      mode: "apply",
      note: null,
      reviewer: "test",
    });
    await writeFile(
      join(episodeDir(), "prompts", "clips", "C01.md"),
      "# C01\n\nCoś zupełnie innego.\n",
      "utf8"
    );
    const status = await checkPromptPackage(scope());

    expect(status.ok ? status.data.approved : null).toBe(false);
    expect(status.ok ? status.data.problems.join(" ") : null).toContain("C01.md");
  });

  it("should treat a redrawn canonical image as a lapsed consent, not a broken package", async () => {
    await makeUpstream();
    await generate();
    await approvePromptPackage({
      ...scope(),
      mode: "apply",
      note: null,
      reviewer: "test",
    });

    // The same character, drawn again: the package still fits the plan, but
    // nobody has read it against this face.
    await writeFile(
      join(root, "projects", PROJECT, "characters", "ewa", "seedream", "hero.png"),
      png(1536, 2304, 6)
    );
    const drifted = await checkPromptPackage(scope());

    expect(drifted.ok ? drifted.data.approved : null).toBe(false);
    expect(drifted.ok ? drifted.data.inputsChanged.join(" ") : null).toContain("hero.png");
  });

  it("should refuse to approve what has not been generated", async () => {
    await makeUpstream();
    const approved = await approvePromptPackage({
      ...scope(),
      mode: "apply",
      note: null,
      reviewer: "test",
    });

    expect(approved.ok ? null : approved.error.message).toContain("nie ma czego zatwierdzić");
  });
});
