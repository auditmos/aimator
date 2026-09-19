import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Of } from "../lib/artifact/index.js";
import {
  addCharacter,
  addEpisode,
  approveStage0,
  initProject,
  setCharacterBasis,
  setEpisodeSettings,
} from "../lib/project/index.js";
import { approvePromptPackage, generatePromptPackage } from "../lib/prompt-package/index.js";
import { approveScreenplay, generateScreenplay } from "../lib/screenplay/index.js";
import { approveShotList, generateShotList } from "../lib/shot-list/index.js";
import { imageTracks, type Workspace } from "../lib/workspace.js";

/**
 * The pipeline a stage-5-and-later test needs before it can test anything.
 *
 * Every image stage consumes an episode that has already been through stages 0
 * to 4, and building one takes about two hundred lines of calls through those
 * stages' own entries. `lib/media-prompt`, `lib/references` and
 * `lib/opening-frame` each carried their own copy of it, byte-identical in the
 * parts that matter, and stage 7 would have been the fourth. That is the
 * threshold this repository promotes at, so it is promoted here.
 *
 * It is **not** a domain module. Nothing under `src/lib` imports it, `src/index.ts`
 * does not re-export it and `tsup` does not bundle it — it lives under `src/test`
 * so that a reader looking at the layer table in AGENTS.md does not have to
 * wonder which layer it belongs to. The answer is none of them.
 *
 * The fixture builds through each stage's **public entry**, never by writing
 * artifacts directly, with one exception: `makeHero` forges a stage-2 result,
 * because drawing ten images per character per track through the real stage
 * would make every test that needs a canonical image pay for a hundred fake
 * HTTP calls. That file is the only place a stage's output is written from
 * outside it, and it is written in the shape `lib/artifact` defines.
 *
 * What it deliberately does **not** own is the prompt package's `answer` — the
 * manifest each test's model returns. That manifest is the dependency graph
 * under test: stage 5 wants two roots and a dependent, stage 6 wants a frame
 * with one reference to wait for, and `media-prompt` wants a package big enough
 * to exceed a track's reference limit. Centralising it would mean one test's
 * change quietly rewrote what the other two were asserting.
 */

export const API_KEY = "sk-test-0123456789";
export const EPISODE = "01-burza";
export const PROJECT = "ewa";
const CAST = ["ewa", "tata"] as const;

/** The film frame of a 16:9 episode: what both tracks render and validate. */
export const FRAME = { height: 1584, width: 2816 };

/** `project.md` — the art direction every stage reads and no stage invents. */
export const RULES = "# Ewa — zasady wspólne\n\nPłaskie 2D. Paleta dziesięciu barw.\n";

/**
 * A structurally valid PNG of a given size, built rather than committed as a
 * binary. `fill` exists so two images can share a frame and differ in bytes,
 * which is what a redrawn dependency looks like to a digest.
 */
export function png(width: number, height: number, fill = 0): Buffer {
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

/**
 * A structurally valid MP4 of a given frame and duration, built rather than
 * committed as a binary — the same reason `png` is built.
 *
 * It carries exactly what the verdict reads: an `ftyp`, an `mvhd` holding the
 * timescale and duration, and one `trak` whose `tkhd` holds the frame. `audio`
 * adds a second, frameless track, which is what a real clip with a soundtrack
 * looks like and what stops the parser from reading `0x0` as the picture.
 */
export function mp4(options: {
  readonly audio?: boolean;
  readonly height: number;
  readonly seconds: number;
  readonly width: number;
}): Buffer {
  const { audio = false, height, seconds, width } = options;
  const tracks = [trak(width, height), ...(audio ? [trak(0, 0)] : [])];

  return Buffer.concat([
    box("ftyp", Buffer.concat([Buffer.from("isomiso2mp41", "ascii")])),
    box("moov", Buffer.concat([mvhd(seconds), ...tracks])),
    box("mdat", Buffer.alloc(32, 7)),
  ]);
}

function box(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length + 8, 0);
  head.write(type, 4, "ascii");

  return Buffer.concat([head, payload]);
}

/** A version-0 movie header. The timescale is 1000, so duration is in ms. */
function mvhd(seconds: number): Buffer {
  const payload = Buffer.alloc(100);
  payload.writeUInt32BE(1000, 12);
  payload.writeUInt32BE(Math.round(seconds * 1000), 16);
  payload.writeUInt32BE(1, 96);

  return box("mvhd", payload);
}

/** A version-0 track header, with the frame in the 16.16 fields at the end. */
function trak(width: number, height: number): Buffer {
  const payload = Buffer.alloc(84);
  payload.writeUInt32BE(width * 0x1_00_00, 76);
  payload.writeUInt32BE(height * 0x1_00_00, 80);

  return box("trak", box("tkhd", payload));
}

/** The canonical image of a character: what stage 2 hands to stages 4 and on. */
const HERO = png(1536, 2304);

/** One reference or film frame, in the frame both tracks draw a 16:9 episode in. */
export const FILM = png(FRAME.width, FRAME.height);

/** A screenplay the stage-1 validator accepts: three scenes, thirty seconds. */
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

/**
 * A shot list the stage-3 validator accepts: two clips, four shots, both
 * characters on screen. `castSeen` is what stage 4's gate reads, so both members
 * of the roster appear — a fixture with one would make the two-track hero gate
 * untestable.
 *
 * `three-clips` is the same episode cut three ways instead of two, and it exists
 * because two clips can only show one way of seeding a later one. Stage 7 needs
 * both: a clip that continues the previous one out of its end frame, and a clip
 * that opens a new scene and continues nothing. `unrenderable-clip` is that same
 * cut with a first clip of three seconds — legal for stage 3, which only caps
 * the longest clip, and shorter than any video model renders, which is what
 * stage 7 has to refuse before it spends anything.
 *
 * These are options rather than the only shape because the manifest a test
 * brings has to name exactly the clips the shot list plans — so switching
 * everybody to three clips would silently rewrite what stages 5 and 6 assert.
 */
export type ShotListShape = "three-clips" | "two-clips" | "unrenderable-clip";

function shotList(shape: ShotListShape): string {
  if (shape === "two-clips") {
    return twoClips();
  }

  return shape === "three-clips" ? threeClips() : unrenderableClips();
}

function twoClips(): string {
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

/** The same thirty seconds, cut so that every way of seeding a clip appears. */
function threeClips(): string {
  return [
    "## Plan\n\nTrzy klipy, kadr 16:9.\n",
    [
      "## Clips",
      "",
      "### C01 | 0-10s",
      "",
      "- Shots: U01",
      "- Reference: opening-frame",
      "- Continuity: Ewa przy stole.",
      "",
      "### C02 | 10-20s",
      "",
      "- Shots: U02",
      "- Reference: new-scene-frame",
      "- Continuity: Nowa scena: oboje na dywanie.",
      "",
      "### C03 | 20-30s",
      "",
      "- Shots: U03",
      "- Reference: previous-end-frame",
      "- Continuity: Dokładnie końcowe położenie z C02.",
      "",
    ].join("\n"),
    [
      "## Shots",
      "",
      shot("U01", "S01", "C01", "0-10s", "ewa"),
      shot("U02", "S02", "C02", "10-20s", "ewa,tata"),
      shot("U03", "S03", "C03", "20-30s", "tata"),
    ].join("\n"),
    "## Review\n\nSprawdzono sumy czasów. Plan wymaga oceny.\n",
  ].join("\n");
}

/**
 * Four clips, the first of them three seconds long.
 *
 * Stage 3 accepts it: `maxClipSeconds` caps the longest clip and says nothing
 * about the shortest, and every shot still sits inside one scene and sums to
 * the episode's duration. The video model does not render anything under four
 * seconds, so this is the plan stage 7 has to refuse — before it spends.
 */
function unrenderableClips(): string {
  return [
    "## Plan\n\nCztery klipy, pierwszy bardzo krótki, kadr 16:9.\n",
    [
      "## Clips",
      "",
      "### C01 | 0-3s",
      "",
      "- Shots: U01",
      "- Reference: opening-frame",
      "- Continuity: Ewa przy stole.",
      "",
      "### C02 | 3-10s",
      "",
      "- Shots: U02",
      "- Reference: previous-end-frame",
      "- Continuity: Ewa siada.",
      "",
      "### C03 | 10-20s",
      "",
      "- Shots: U03",
      "- Reference: new-scene-frame",
      "- Continuity: Nowa scena: oboje na dywanie.",
      "",
      "### C04 | 20-30s",
      "",
      "- Shots: U04",
      "- Reference: previous-end-frame",
      "- Continuity: Dokładnie końcowe położenie z C03.",
      "",
    ].join("\n"),
    [
      "## Shots",
      "",
      shot("U01", "S01", "C01", "0-3s", "ewa"),
      shot("U02", "S01", "C02", "3-10s", "ewa,tata"),
      shot("U03", "S02", "C03", "10-20s", "ewa,tata"),
      shot("U04", "S03", "C04", "20-30s", "tata"),
    ].join("\n"),
    "## Review\n\nSprawdzono sumy czasów. Plan wymaga oceny.\n",
  ].join("\n");
}

/** One text model's answer, in the envelope `lib/text-model` unwraps. */
function completion(text: string): string {
  return JSON.stringify({
    id: "resp_1",
    model: "gpt-6-astra",
    output: [{ content: [{ text, type: "output_text" }], role: "assistant", type: "message" }],
    status: "completed",
  });
}

/** A transport that always answers with the same body. */
function respondWith(body: string): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(body, { headers: { "x-request-id": "req_1" }, status: 200 })
    )) as unknown as typeof fetch;
}

interface Recorder {
  readonly calls: { body: unknown; prompt: string; url: string }[];
  readonly fetch: typeof fetch;
}

/**
 * The prompt a request carried, whichever shape it travelled in.
 *
 * gpt-image splits its endpoint by whether references are attached, and the one
 * that takes them — `/v1/images/edits` — is multipart, where every field is a
 * form entry rather than a JSON key. Reading only the JSON shape makes an
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
 * An image provider that answers correctly, counting every request.
 *
 * The count is the assertion that matters most in an image stage: these stages
 * bill per call, so a stage that drew twice would be charging twice.
 */
export function recorder(options: { readonly image?: Buffer } = {}): Recorder {
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
        ? Response.json({ data: [{ url: "https://download/image" }], id: "job-1" })
        : Response.json({ data: [{ b64_json: image.toString("base64") }] })
    );
  }) as unknown as typeof fetch;

  return { calls, fetch: impl };
}

interface HeroOptions {
  /** Whether a human accepted it. Stage 4's gate reads exactly this. */
  readonly approved?: boolean;
  readonly characterId: string;
  readonly root: string;
  readonly track: string;
}

/**
 * A finished stage-2 result, forged rather than drawn.
 *
 * This is the one place the fixture writes another stage's artifact directly.
 * Running the real stage would mean ten fake image calls per character per
 * track before any test could start, and what stages 4 and on actually consume
 * is one file plus the record saying somebody accepted it.
 */
export async function makeHero(options: HeroOptions): Promise<void> {
  const { approved = true, characterId, root, track } = options;
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

interface UpstreamOptions {
  /**
   * The manifest stage 4's model returns, as JSON. Every test brings its own,
   * because the graph it describes is the thing under test.
   */
  readonly answer: string;
  /**
   * Whether stage 4 ends accepted. **Stated, never defaulted**: stage 5's tests
   * accept the package inside each case so they can also test the gate that
   * refuses before it, while stage 6's want it already accepted. A default here
   * would silently change what one of them asserts.
   */
  readonly approvePackage: boolean;
  readonly root: string;
  readonly rules?: string;
  readonly scratch: string;
  /**
   * Which cut of the same thirty seconds the shot list plans. Two clips by
   * default; three when a test needs both ways of seeding a later clip, which
   * only a third one can show; and one cut so short no video model renders it,
   * for the stage that has to refuse it before spending anything.
   */
  readonly shotList?: ShotListShape;
  readonly workspace: Workspace;
}

/** Stages 0 to 4, with a canonical image for every character on every track. */
export async function makeUpstream(options: UpstreamOptions): Promise<void> {
  const {
    answer,
    approvePackage,
    root,
    rules = RULES,
    scratch,
    shotList: shape = "two-clips",
    workspace,
  } = options;
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

  await writeFile(join(root, "projects", PROJECT, "project.md"), rules, "utf8");
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
  await Promise.all(
    CAST.flatMap((characterId) =>
      imageTracks.map((track) => makeHero({ characterId, root, track }))
    )
  );

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
    fetch: respondWith(completion(shotList(shape))),
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
    fetch: respondWith(completion(answer)),
    maxOutputTokens: 32_000,
    mode: "apply",
    model: "gpt-6-astra",
    projectId: PROJECT,
    regenerate: false,
    republish: false,
    workspace,
  });

  if (approvePackage) {
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
