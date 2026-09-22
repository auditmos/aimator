import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Of } from "../lib/artifact/index.js";
import { approveAssembly, generateAssembly } from "../lib/assembly/index.js";
import { approveClips, generateClips } from "../lib/clips/index.js";
import type { Muxer } from "../lib/muxer.js";
import {
  approveMix,
  approveNarration,
  generateMix,
  generateNarration,
} from "../lib/narration/index.js";
import { approveOpeningFrame, generateOpeningFrame } from "../lib/opening-frame/index.js";
import {
  addCharacter,
  addEpisode,
  approveStage0,
  initProject,
  setCharacterBasis,
  setEpisodeSettings,
  setNarratorVoice,
} from "../lib/project/index.js";
import { approvePromptPackage, generatePromptPackage } from "../lib/prompt-package/index.js";
import { approveReferences, generateReferences } from "../lib/references/index.js";
import { ok } from "../lib/result.js";
import { approveScreenplay, generateScreenplay } from "../lib/screenplay/index.js";
import { approveShotList, generateShotList } from "../lib/shot-list/index.js";
import { type ImageTrack, imageTracks, type Workspace } from "../lib/workspace.js";

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
 * does not re-export it and `tsup` does not bundle it; it lives under `src/test`
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
 * What it deliberately does **not** own is the prompt package's `answer`, the
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

/** `project.md`, the art direction every stage reads and no stage invents. */
export const RULES = "# Ewa, zasady wspólne\n\nPłaskie 2D. Paleta dziesięciu barw.\n";

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
 * A structurally valid JPEG of a given size, built the same way, because the
 * video provider hands the frame a clip ended on back as a JPEG, whatever the
 * rest of the pipeline draws in.
 *
 * It carries what the verdict reads and nothing else: the signature, one
 * segment that is not a start-of-frame (so the walk has something to skip) and
 * the SOF0 segment that states the picture's size.
 */
export function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.alloc(18);
  app0.writeUInt16BE(0xff_e0, 0);
  app0.writeUInt16BE(16, 2);
  app0.write("JFIF\0", 4, "ascii");

  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xff_c0, 0);
  sof.writeUInt16BE(9, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    sof,
    Buffer.alloc(32, 9),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/**
 * A structurally valid MP4 of a given frame and duration, built rather than
 * committed as a binary, the same reason `png` is built.
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

/**
 * A structurally valid PCM WAV of a given length, built rather than committed
 * as a binary, the same reason `mp4` is built.
 *
 * It carries exactly what the verdict reads: a RIFF/WAVE header, an `fmt `
 * chunk stating the rate, the channels and the depth, and a `data` chunk whose
 * size is the whole of the duration. `junk` puts an unknown chunk in front of
 * the ones that matter, because a real encoder does and a reader that assumes
 * a fixed layout would work here and fail there.
 */
export function wav(options: {
  readonly channels?: number;
  readonly junk?: boolean;
  readonly sampleRate?: number;
  readonly seconds: number;
}): Buffer {
  const { channels = 1, junk = false, sampleRate = 24_000, seconds } = options;
  const blockAlign = channels * 2;
  const byteRate = sampleRate * blockAlign;
  const format = Buffer.alloc(16);

  format.writeUInt16LE(1, 0);
  format.writeUInt16LE(channels, 2);
  format.writeUInt32LE(sampleRate, 4);
  format.writeUInt32LE(byteRate, 8);
  format.writeUInt16LE(blockAlign, 12);
  format.writeUInt16LE(16, 14);

  const body = Buffer.concat([
    Buffer.from("WAVE", "ascii"),
    ...(junk ? [chunk("LIST", Buffer.from("INFOhand-rolled", "ascii"))] : []),
    chunk("fmt ", format),
    chunk("data", Buffer.alloc(Math.round(seconds * byteRate), 0)),
  ]);

  return Buffer.concat([chunk("RIFF", body)]);
}

/** MPEG1 Layer III bitrates, in kbps, indexed as the frame header indexes them. */
const MPEG1_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
/** MPEG2 and MPEG2.5 Layer III, same field, a different table behind it. */
const MPEG2_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MPEG1_RATES = [44_100, 48_000, 32_000];
const MPEG2_RATES = [22_050, 24_000, 16_000];

/**
 * A structurally valid Layer III MP3 of a given length, built rather than
 * committed as a binary, the same reason `mp4` and `wav` are built.
 *
 * It carries exactly what the verdict reads: a chain of frame headers, each
 * declaring its own version, bitrate, sample rate and channel mode. `bitrate`
 * takes a list to make a variable-rate stream, which is the case a reader that
 * multiplies one bitrate by a file size gets wrong; `id3` puts a tag in front
 * of the first frame, because every real encoder does; `xing` puts a metadata
 * frame where a real encoder puts one, which carries no audio and must not be
 * counted as a frame of it.
 */
export function mp3(options: {
  readonly bitrate?: number | readonly number[];
  readonly id3?: boolean;
  readonly mono?: boolean;
  readonly sampleRate?: number;
  readonly seconds: number;
  readonly xing?: boolean;
}): Buffer {
  const { bitrate = 128, id3 = false, mono = false, sampleRate = 44_100, seconds, xing } = options;
  const mpeg1 = MPEG1_RATES.includes(sampleRate);
  const perFrame = mpeg1 ? 1152 : 576;
  const rates = mpeg1 ? MPEG1_BITRATES : MPEG2_BITRATES;
  const chosen = typeof bitrate === "number" ? [bitrate] : bitrate;
  const count = Math.round((seconds * sampleRate) / perFrame);
  const frames: Buffer[] = [];

  for (let index = 0; index < count; index += 1) {
    const kbps = chosen[index % chosen.length] ?? 128;
    frames.push(frame({ kbps, mono, mpeg1, rates, sampleRate }));
  }

  return Buffer.concat([
    ...(id3 ? [id3v2()] : []),
    ...(xing === true
      ? [tagged(frame({ kbps: 32, mono, mpeg1, rates, sampleRate }), mpeg1, mono)]
      : []),
    ...frames,
  ]);
}

/** One Layer III frame: a four-byte header and a payload of the length it declares. */
function frame(options: {
  readonly kbps: number;
  readonly mono: boolean;
  readonly mpeg1: boolean;
  readonly rates: readonly number[];
  readonly sampleRate: number;
}): Buffer {
  const { kbps, mono, mpeg1, rates, sampleRate } = options;
  const rateIndex = (mpeg1 ? MPEG1_RATES : MPEG2_RATES).indexOf(sampleRate);
  const head = Buffer.alloc(4);

  head[0] = 0xff;
  // Bit runs, spelled as the arithmetic they are: 111 sync, then version
  // (11 = MPEG1, 10 = MPEG2), layer (01 = Layer III) and the no-CRC bit.
  head[1] = 0b111 * 32 + (mpeg1 ? 0b11 : 0b10) * 8 + 0b01 * 2 + 1;
  head[2] = rates.indexOf(kbps) * 16 + rateIndex * 4;
  // Channel mode 11 is mono, 00 is stereo; the rest of the byte is unused here.
  head[3] = (mono ? 0b11 : 0b00) * 64;

  const length = Math.floor(((mpeg1 ? 144_000 : 72_000) * kbps) / sampleRate) || head.length + 1;

  return Buffer.concat([head, Buffer.alloc(Math.max(length - head.length, 1), 0)]);
}

/** Past the side information, whose size the version and channel mode fix. */
function tagOffset(mpeg1: boolean, mono: boolean): number {
  if (mpeg1) {
    return mono ? 21 : 36;
  }

  return mono ? 13 : 21;
}

/** A metadata frame, where a real encoder writes one: inside the side-info area. */
function tagged(first: Buffer, mpeg1: boolean, mono: boolean): Buffer {
  const at = tagOffset(mpeg1, mono);
  const copy = Buffer.from(first);

  copy.write("Xing", at, "ascii");

  return copy;
}

/**
 * An ID3v2 tag: the three letters, a version, flags, and a synchsafe size.
 *
 * Its payload is filled with something that looks exactly like a frame header,
 * because that is what makes skipping the tag matter. A reader that hunted for
 * the first sync pattern instead of honouring the declared size would start
 * counting here and report a length that is simply wrong.
 */
function id3v2(): Buffer {
  const payload = Buffer.alloc(64, 0);
  const head = Buffer.alloc(10);

  for (let at = 0; at + 4 <= payload.length; at += 4) {
    payload[at] = 0xff;
    payload[at + 1] = 0xfb;
    payload[at + 2] = 0x90;
    payload[at + 3] = 0x00;
  }

  head.write("ID3", 0, "ascii");
  head[3] = 4;
  // Synchsafe: seven bits per byte, so 64 fits in the last one untouched.
  head[9] = payload.length;

  return Buffer.concat([head, payload]);
}

/** One RIFF chunk: a four-character id, a little-endian size, and the payload. */
function chunk(id: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);

  head.write(id, 0, "ascii");
  head.writeUInt32LE(payload.length, 4);

  // RIFF pads an odd payload to an even boundary; the size field does not count it.
  return Buffer.concat([
    head,
    payload,
    payload.length % 2 === 0 ? Buffer.alloc(0) : Buffer.alloc(1),
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

/**
 * What the narrator says in one shot, when the episode has a narrator.
 *
 * Stage 9 lifts these sentences rather than writing them, and its validator
 * proves the lift by finding each one inside the shot it names, so a fixture
 * that wants a narrated episode has to put the words where stage 1 would have
 * put them: in the prose of the Audio field, beside the music and the rain.
 */
export const NARRATION = {
  U01: "Ewa została sama z burzą",
  U02: "Tata usiadł obok",
  U03: "Jeszcze grzmiało",
  U04: "Burza przeszła",
} as const satisfies Readonly<Record<string, string>>;

function shot(
  id: string,
  scene: string,
  clip: string,
  range: string,
  cast: string,
  narrated = false
): string {
  const line: string | undefined = (NARRATION as Readonly<Record<string, string>>)[id];
  const audio =
    narrated && line !== undefined ? `Deszcz o szybę; narrator: „${line}”.` : "Deszcz o szybę.";

  return [
    `### ${id} | ${scene} | ${clip} | ${range}`,
    "",
    "- Purpose: Pokazuje, że Ewa zostaje sama z burzą.",
    "- Frame: Plan amerykański, Ewa po lewej.",
    "- Action: Ewa odsuwa krzesło i siada.",
    "- Expression: Zaciśnięte usta.",
    "- Camera: Statyczny kadr.",
    `- Cast: ${cast}`,
    `- Audio: ${audio}`,
    "- Text: none",
    "- Start state: Ewa stoi przy krześle.",
    "- End state: Ewa siedzi.",
    "",
  ].join("\n");
}

/**
 * A shot list the stage-3 validator accepts: two clips, four shots, both
 * characters on screen. `castSeen` is what stage 4's gate reads, so both members
 * of the roster appear, a fixture with one would make the two-track hero gate
 * untestable.
 *
 * `three-clips` is the same episode cut three ways instead of two, and it exists
 * because two clips can only show one way of seeding a later one. Stage 7 needs
 * both: a clip that continues the previous one out of its end frame, and a clip
 * that opens a new scene and continues nothing. `unrenderable-clip` is that same
 * cut with a first clip of three seconds, legal for stage 3, which only caps
 * the longest clip, and shorter than any video model renders, which is what
 * stage 7 has to refuse before it spends anything.
 *
 * These are options rather than the only shape because the manifest a test
 * brings has to name exactly the clips the shot list plans, so switching
 * everybody to three clips would silently rewrite what stages 5 and 6 assert.
 */
export type ShotListShape = "three-clips" | "two-clips" | "unrenderable-clip";

function shotList(shape: ShotListShape, narrated: boolean): string {
  if (shape === "two-clips") {
    return twoClips(narrated);
  }

  return shape === "three-clips" ? threeClips(narrated) : unrenderableClips(narrated);
}

function twoClips(narrated: boolean): string {
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
      shot("U01", "S01", "C01", "0-10s", "ewa", narrated),
      shot("U02", "S02", "C01", "10-15s", "ewa,tata", narrated),
      shot("U03", "S02", "C02", "15-20s", "tata", narrated),
      shot("U04", "S03", "C02", "20-30s", "ewa,tata", narrated),
    ].join("\n"),
    "## Review\n\nSprawdzono sumy czasów. Plan wymaga oceny.\n",
  ].join("\n");
}

/** The same thirty seconds, cut so that every way of seeding a clip appears. */
function threeClips(narrated: boolean): string {
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
      shot("U01", "S01", "C01", "0-10s", "ewa", narrated),
      shot("U02", "S02", "C02", "10-20s", "ewa,tata", narrated),
      shot("U03", "S03", "C03", "20-30s", "tata", narrated),
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
 * seconds, so this is the plan stage 7 has to refuse, before it spends.
 */
function unrenderableClips(narrated: boolean): string {
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
      shot("U01", "S01", "C01", "0-3s", "ewa", narrated),
      shot("U02", "S01", "C02", "3-10s", "ewa,tata", narrated),
      shot("U03", "S02", "C03", "10-20s", "ewa,tata", narrated),
      shot("U04", "S03", "C04", "20-30s", "tata", narrated),
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
 * that takes them, `/v1/images/edits`, is multipart, where every field is a
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
  /**
   * Which cut of the same thirty seconds the shot list plans. Two clips by
   * default; three when a test needs both ways of seeding a later clip, which
   * only a third one can show; and one cut so short no video model renders it,
   * for the stage that has to refuse it before spending anything.
   */
  /**
   * Whether the shots carry what a narrator says.
   *
   * Off by default, because the episodes stages 5 to 8 test are silent and a
   * longer Audio field would quietly change the prose they attach verbatim.
   * Stage 9 turns it on, which is the only place the words matter.
   */
  readonly narration?: boolean;
  readonly root: string;
  readonly rules?: string;
  readonly scratch: string;
  readonly shotList?: ShotListShape;
  /**
   * Which voice reads the series, cast before stage 0 is approved.
   *
   * Cast here rather than by the test, because that is when a real series casts
   * one: `project.json` is a recorded input of every stage below it, so naming
   * a narrator after the shot list has been accepted is input drift, real,
   * correct, and paid for with a re-approval nobody wants inside a fixture.
   */
  readonly voiceId?: string;
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
  if (options.voiceId !== undefined) {
    await setNarratorVoice({
      mode: "apply",
      projectId: PROJECT,
      voiceId: options.voiceId,
      workspace,
    });
  }

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
    fetch: respondWith(completion(shotList(shape, options.narration ?? false))),
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

/**
 * A finished image-and-video track: stages 5, 6 and 7, all of them accepted.
 *
 * It exists for the stages *below* stage 7, which need a track that is done
 * rather than a track they are testing. The build-up is the same three calls
 * and three approvals every time, and stage 8 would have been the fourth copy
 * of the stage 5-to-6 chain, the threshold this repository promotes at.
 *
 * It deliberately does **not** replace the instrumented transports stages 5, 6
 * and 7 bring to their own tests. Those count calls, because the count is the
 * assertion; this one only has to leave a correct track on disk. That is the
 * same line the fixture already draws around the manifest: what a stage tests,
 * it owns.
 */
export async function makeTrack(options: {
  /** How long each clip comes back, by id. Anything absent runs its planned length. */
  readonly clipSeconds?: Readonly<Record<string, number>>;
  /** Clips left unapproved, so a downstream gate has something to refuse. */
  readonly pending?: readonly string[];
  readonly root: string;
  readonly track: ImageTrack;
  readonly workspace: Workspace;
}): Promise<void> {
  const { clipSeconds = {}, pending = [], track, workspace } = options;

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
    artifacts: ["R01"],
    episodeId: EPISODE,
    mode: "apply",
    note: "ok",
    projectId: PROJECT,
    reviewer: "fixture",
    track,
    workspace,
  });
  await generateOpeningFrame({
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
  await approveOpeningFrame({
    artifacts: [],
    episodeId: EPISODE,
    mode: "apply",
    note: "ok",
    projectId: PROJECT,
    reviewer: "fixture",
    track,
    workspace,
  });

  // Stage 7 is a chain, so it takes as many passes as there are links: one
  // command buys what the gates allow, a human accepts it, and that acceptance
  // is what opens the next one. Looping until nothing new appears is what a
  // person does by hand, and it keeps the fixture free of a clip count.
  for (let pass = 0; pass < MAX_CHAIN_PASSES; pass += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: the chain is sequential
    const bought = await buyAndAccept({ clipSeconds, pending, track, workspace });

    if (bought.length === 0) {
      return;
    }
  }
}

/** How many times the stage-7 chain is pumped before the fixture gives up. */
const MAX_CHAIN_PASSES = 32;

/** One pass of stage 7: buy what the gates allow, then accept all of it. */
async function buyAndAccept(options: {
  readonly clipSeconds: Readonly<Record<string, number>>;
  readonly pending: readonly string[];
  readonly track: ImageTrack;
  readonly workspace: Workspace;
}): Promise<readonly string[]> {
  const { clipSeconds, pending, track, workspace } = options;
  const result = await generateClips({
    artifacts: [],
    episodeId: EPISODE,
    fetch: videoProvider(clipSeconds),
    imageKey: API_KEY,
    imageModel: "gpt-image-2.5-sunburst",
    mode: "apply",
    projectId: PROJECT,
    regenerate: false,
    republish: false,
    track,
    videoKey: API_KEY,
    videoModel: "dreamina-seedance-2-5-260628",
    wait: () => Promise.resolve(),
    workspace,
  });

  if (!result.ok) {
    return [];
  }

  const bought = result.data.artifacts
    .filter((one) => one.state === "published" && !pending.includes(one.id))
    .map((one) => one.id);

  if (bought.length > 0) {
    await approveClips({
      artifacts: bought,
      episodeId: EPISODE,
      mode: "apply",
      note: "ok",
      projectId: PROJECT,
      reviewer: "fixture",
      track,
      workspace,
    });
  }

  return bought;
}

/**
 * Both providers behind one transport: the image API an entry frame is drawn
 * with, and the video API a clip is rendered by.
 *
 * Clips come back at the length `clipSeconds` names, or at the length the plan
 * ordered. The distinction is what a downstream stage needs in order to see a
 * drifting cut at all: a provider that always answers to the second would make
 * the drift untestable, and the drift is the honest behaviour of a renderer
 * working at 24 frames per second.
 */
function videoProvider(clipSeconds: Readonly<Record<string, number>>): typeof fetch {
  const images = recorder();
  let clip = CLIP_FALLBACK;
  let jobs = 0;

  return ((url: string | URL, init?: RequestInit) => {
    const href = String(url);

    if (href === "https://download/clip") {
      return Promise.resolve(new Response(clip, { status: 200 }));
    }

    if (href === "https://download/end") {
      return Promise.resolve(new Response(png(1920, 1080, 3), { status: 200 }));
    }

    if (!href.includes("/contents/generations/tasks")) {
      return images.fetch(url, init);
    }

    if ((init?.method ?? "GET") === "POST") {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      const planned = Number((body as { duration?: number }).duration ?? 0);
      const id = clipIdOf(body);

      jobs += 1;
      clip = mp4({ height: 1080, seconds: clipSeconds[id] ?? planned, width: 1920 });

      return Promise.resolve(Response.json({ id: `cgt-${jobs}` }));
    }

    return Promise.resolve(
      Response.json({
        content: { last_frame_url: "https://download/end", video_url: "https://download/clip" },
        id: href.slice(href.lastIndexOf("/") + 1),
        status: "succeeded",
      })
    );
  }) as unknown as typeof fetch;
}

/**
 * A muxer for the stages that need a finished film rather than a finished
 * muxer.
 *
 * The clips this fixture builds are structurally valid MP4s rather than
 * decodable ones; they carry the boxes every verdict reads and nothing else,
 * so a real ffmpeg has nothing to concatenate. That is the right trade: the
 * real engine is exercised where it is the thing under test, in
 * `muxer.test.ts`, against inputs it made itself. Here what matters is that
 * the stage called it with the right arguments and published what came back.
 */
export function muxer(): Muxer {
  return {
    concat: async (input) => {
      const { writeFile: write } = await import("node:fs/promises");
      const seconds = CUT_SECONDS;

      await write(input.target, mp4({ height: 1080, seconds, width: 1920 }));

      return ok({ argv: ["ffmpeg", "-f", "concat"], engine: ENGINE, stderr: "" });
    },
    master: async (input) => {
      const { writeFile: write } = await import("node:fs/promises");

      // The full mix is the same shape of answer as the narrated one: the film
      // it was given, plus one frameless track carrying everything at once.
      await write(
        input.target,
        mp4({ audio: true, height: 1080, seconds: CUT_SECONDS, width: 1920 })
      );

      return ok({ argv: ["ffmpeg", "-filter_complex"], engine: ENGINE, stderr: "" });
    },
    mix: async (input) => {
      const { writeFile: write } = await import("node:fs/promises");

      // A mix adds a sound track and copies the picture through, so the file it
      // writes is the film it was given plus one frameless track.
      await write(
        input.target,
        mp4({ audio: true, height: 1080, seconds: CUT_SECONDS, width: 1920 })
      );

      return ok({ argv: ["ffmpeg", "-filter_complex"], engine: ENGINE, stderr: "" });
    },
    version: () => Promise.resolve(ok(ENGINE)),
  };
}

/** What the fixture's two-clip plan adds up to. */
const CUT_SECONDS = 30;
const ENGINE = "ffmpeg 7.1.1";

/**
 * A finished picture cut: `makeTrack` plus stage 8, accepted.
 *
 * Promoted at the same threshold as the rest of this file: stage 9 is the first
 * stage that needs an episode already assembled, and it needs one on both
 * tracks. The muxer is the fixture's, for the reason `muxer` gives.
 */
export async function makeCut(options: {
  readonly clipSeconds?: Readonly<Record<string, number>>;
  readonly root: string;
  readonly track: ImageTrack;
  readonly workspace: Workspace;
}): Promise<void> {
  await makeTrack(options);
  await generateAssembly({
    artifacts: [],
    episodeId: EPISODE,
    mode: "apply",
    mux: muxer(),
    projectId: PROJECT,
    regenerate: false,
    track: options.track,
    workspace: options.workspace,
  });
  await approveAssembly({
    artifacts: [],
    episodeId: EPISODE,
    mode: "apply",
    note: "ok",
    projectId: PROJECT,
    reviewer: "fixture",
    track: options.track,
    workspace: options.workspace,
  });
}

/**
 * The voice this series is narrated by, cast in stage 0 like the rest of the
 * cast. A real ElevenLabs id shape, because the CLI validates nothing about it
 * and a fixture that used `voice-1` would teach a reader the wrong thing.
 */
export const VOICE = "21m00Tcm4TlvDq8ikWAM";

/** The two shots the fixture's narrator speaks over, and where each is anchored. */
const SPOKEN = [
  { at: "2s", id: "N01", shot: "U01", text: NARRATION.U01 },
  { at: "22s", id: "N02", shot: "U04", text: NARRATION.U04 },
] as const;

/** A script the stage-9 validator accepts: each sentence lifted from its shot. */
function narrationScript(): string {
  return [
    "## Plan",
    "",
    "Narrator otwiera i zamyka odcinek.",
    "",
    "## Lines",
    "",
    ...SPOKEN.flatMap((one) => [`### ${one.id} | ${one.shot} | ${one.at}`, "", one.text, ""]),
    "## Review",
    "",
    "Obie kwestie pochodzą z pola Audio swoich ujęć.",
    "",
  ].join("\n");
}

/** Both of stage 9's providers behind one transport: a script, then the bytes. */
function voiceProvider(seconds: number): typeof fetch {
  return ((url: string | URL) =>
    String(url).includes("elevenlabs")
      ? Promise.resolve(
          new Response(wav({ seconds }), {
            headers: { "content-type": "audio/wav" },
            status: 200,
          })
        )
      : Promise.resolve(
          Response.json({
            id: "resp_fixture",
            output: [
              {
                content: [{ text: narrationScript(), type: "output_text" }],
                role: "assistant",
                type: "message",
              },
            ],
            status: "completed",
          })
        )) as unknown as typeof fetch;
}

/**
 * Stage 9's words, bought and accepted, and optionally laid on a track.
 *
 * Promoted at the threshold the rest of this file is: the CLI's stage-9 tests
 * and the UI server's both need a narrated episode that is *finished* rather
 * than one they are testing, and neither is asking a question about how many
 * calls it took. What it leaves on disk is `narration.md`, one WAV per line,
 * both accepted, and `narrated.mp4` on every track it was handed.
 *
 * It does **not** replace stage 9's own instrumented transport. That one
 * counts calls and reads the bodies, because for a stage billed per character
 * the request *is* the assertion; this one only has to leave the artifacts.
 *
 * The episode has to have been built with `narration: true` and a cast voice,
 * and each track with `makeCut`, because a mix is laid over an accepted cut.
 */
export async function makeNarration(options: {
  /** How long each bought line comes back. Short enough to fit the plan. */
  readonly lineSeconds?: number;
  readonly root: string;
  /** Tracks to lay the accepted lines on. None by default: the words are shared. */
  readonly tracks?: readonly ImageTrack[];
  readonly workspace: Workspace;
}): Promise<void> {
  const { lineSeconds = 1, tracks = [], workspace } = options;
  const paid = {
    artifacts: [],
    episodeId: EPISODE,
    fetch: voiceProvider(lineSeconds),
    maxOutputTokens: 8000,
    mode: "apply",
    model: "gpt-6-astra",
    openAiKey: API_KEY,
    projectId: PROJECT,
    regenerate: false,
    voiceKey: API_KEY,
    voiceModel: "eleven_multilingual_v2",
    workspace,
  } as const;
  const accept = (artifacts: readonly string[]) =>
    approveNarration({
      artifacts,
      episodeId: EPISODE,
      mode: "apply" as const,
      note: "ok",
      projectId: PROJECT,
      reviewer: "fixture",
      workspace,
    });

  // The script first and on its own, because nothing may be bought until a
  // human has read it: the same two passes a person makes by hand.
  await generateNarration(paid);
  await accept(["script"]);
  await generateNarration(paid);
  await accept(SPOKEN.map((one) => one.id));

  for (const track of tracks) {
    // biome-ignore lint/performance/noAwaitInLoops: one track's mix at a time
    await generateMix({
      artifacts: [],
      episodeId: EPISODE,
      mode: "apply",
      mux: muxer(),
      projectId: PROJECT,
      regenerate: false,
      track,
      workspace,
    });

    await approveMix({
      artifacts: [],
      episodeId: EPISODE,
      mode: "apply",
      note: "ok",
      projectId: PROJECT,
      reviewer: "fixture",
      track,
      workspace,
    });
  }
}

/** A clip of a length no plan orders, so an unmapped call is visibly wrong. */
const CLIP_FALLBACK = mp4({ height: 1080, seconds: 1, width: 1920 });
const CLIP_HEADING = /### (C\d{2,}) \|/;

/**
 * Which clip a video request is for, read from the shots the prompt quotes.
 *
 * The request carries no identifier of its own, rule 8 keeps ids out of a
 * model's instructions, so the fixture reads the one place the clip's name
 * legitimately appears: the verbatim shot-list entries the composer attaches.
 */
function clipIdOf(body: unknown): string {
  const content = body as { content?: readonly { text?: string }[] };
  const text = content.content?.map((one) => one.text ?? "").join("\n") ?? "";

  return CLIP_HEADING.exec(text)?.[1] ?? "";
}
