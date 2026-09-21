import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { config } from "../config/index.js";
import { readStage0Inputs } from "../lib/project/index.js";
import { checkPromptPackage } from "../lib/prompt-package/index.js";
import { err, ok, type Result } from "../lib/result.js";
import {
  characterPaths,
  characterTrackPaths,
  episodePaths,
  episodeTrackPaths,
  type ImageTrack,
  imageTracks,
  projectPaths,
  type Workspace,
} from "../lib/workspace.js";

/**
 * Takes one finished episode out of the workspace and freezes it as a release.
 *
 * This is the **one** operation in this module that reads
 * `AIMATOR_WORKSPACE`, and it is the reason the other two do not have to.
 * `buildSite` and `publishMedia` consume a frozen copy under `out/`, so the
 * page rebuilds from a clone long after the workspace has moved on; freezing is
 * the crossing between the two, exactly as stage 0 is the one stage allowed to
 * pull outside files in. It reads the workspace through `lib/workspace.ts` and
 * every artifact through its own stage's public entry, never by reaching into
 * one.
 *
 * It re-encodes, which is why none of this lives in `lib/muxer`: that module's
 * whole promise is that it copies streams and never re-encodes, and a web
 * preview is a re-encode. The numbers below are facts about the web rather than
 * about the film, so they belong to the publisher that needs them.
 *
 * What it will not do is write the prose. Every text a reader sees comes out as
 * `TODO`, and `buildSite` refuses a registry that still says so: an unwritten
 * description is undecided, and a gate that blocks is the only honest answer to
 * a decision nobody has made.
 */

const run = promisify(execFile);

/** The one string a person has to replace before a release can be published. */
const TODO = "TODO";

/**
 * Where freezing left a decision for a person to make.
 *
 * This is rule 7 one level up from the pipeline: a description nobody has
 * written is undecided, so the gate blocks rather than publishing the word
 * `TODO` to the internet. `freezeRelease` reports these, and `buildSite`
 * refuses on them, one walk, so the two can never disagree about what counts.
 */
export function unwrittenFields(value: unknown, path = ""): string[] {
  if (value === TODO) {
    return [path];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => unwrittenFields(item, `${path}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) =>
      unwrittenFields(item, path ? `${path}.${key}` : key)
    );
  }
  return [];
}

/**
 * H.264 because the video models answer in HEVC, which nothing but Safari
 * plays. CRF 23 with a ceiling, rather than a target size: R2 lifted the file
 * limit, so the bound is here only to keep one long episode from becoming a
 * download nobody finishes.
 */
const VIDEO_ARGS = [
  "-c:v",
  "libx264",
  "-preset",
  "slow",
  "-crf",
  "23",
  "-maxrate",
  "2000k",
  "-bufsize",
  "4000k",
  "-profile:v",
  "high",
  "-level",
  "4.0",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-b:a",
  "128k",
  "-ac",
  "2",
  "-movflags",
  "+faststart",
];
/** Wide enough to read a character sheet, small enough to open on a phone. */
const STILL_WIDTH = 1600;
/** The convention every poster in this repository already follows. */
const POSTER_WIDTH = 960;
const POSTER_SECOND = "3";

/** The stage documents a release publishes, in the order a reader meets them. */
const DOCUMENTS = [
  { file: "screenplay.md", key: "screenplay", stage: 1 },
  { file: "shot-list.md", key: "shotList", stage: 3 },
  { file: "narration.md", key: "narrationScript", stage: 9 },
  { file: "sound-design.md", key: "soundDesign", stage: 10 },
] as const;

class FreezeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FreezeError";
  }
}

interface FreezeInput {
  readonly episodeId: string;
  readonly projectId: string;
  /** The repository root, which is also where `out/` and `site/` sit. */
  readonly root: string;
  readonly version: string;
  /** Resolved by the caller, exactly as every stage takes it. */
  readonly workspace: Workspace;
}

/**
 * The engine, injected exactly as `lib/assembly` injects a `Muxer`. Freezing is
 * a long sequence of decisions around four short operations, and only these
 * four need a media tool, so a test can prove the sequence without one.
 */
export interface Encoder {
  /** One frame of the finished film, for the page's player. */
  readonly poster: (from: string, to: string) => Promise<void>;
  /** Measured from the produced file, never from the source it came from. */
  readonly probe: (path: string) => Promise<{ height: number; seconds: number; width: number }>;
  readonly still: (from: string, to: string) => Promise<void>;
  readonly video: (from: string, to: string) => Promise<void>;
}

interface FreezeReport {
  /** Everything written, repository-relative, in the order it was written. */
  readonly files: readonly string[];
  /** The registry fields still saying `TODO`, as dotted paths. */
  readonly unwritten: readonly string[];
}

async function ffmpeg(args: string[], what: string): Promise<void> {
  const binary = config.env.AIMATOR_FFMPEG ?? "ffmpeg";
  try {
    await run(binary, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  } catch (error) {
    throw new FreezeError(`${what}: ${(error as Error).message}`, { cause: error });
  }
}

/**
 * The real engine. `probe` reads the produced file back rather than the source
 * it came from: every number the registry records describes the bytes a browser
 * will fetch. `check` deliberately avoids a decoder; this is not `check`, it
 * is an operator's tool that already requires ffmpeg on the machine.
 */
const encoder: Encoder = {
  poster: (from, to) =>
    ffmpeg(
      [
        "-ss",
        POSTER_SECOND,
        "-i",
        from,
        "-frames:v",
        "1",
        "-vf",
        `scale=${POSTER_WIDTH}:-2`,
        "-q:v",
        "3",
        to,
      ],
      basename(to)
    ),
  async probe(path) {
    const binary = config.env.AIMATOR_FFMPEG ? `${config.env.AIMATOR_FFMPEG}probe` : "ffprobe";
    try {
      const { stdout } = await run(binary, [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        path,
      ]);
      const [width = "0", height = "0", seconds = "0"] = stdout.trim().split("\n");
      return { height: Number(height), seconds: Number(seconds), width: Number(width) };
    } catch (error) {
      throw new FreezeError(`nie da się zmierzyć ${basename(path)}`, { cause: error });
    }
  },
  still: (from, to) =>
    ffmpeg(["-i", from, "-vf", `scale=${STILL_WIDTH}:-2`, "-q:v", "3", to], basename(to)),
  video: (from, to) => ffmpeg(["-i", from, ...VIDEO_ARGS, to], basename(to)),
};

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

interface Still {
  file: string;
  height: number;
  kind: "character" | "opening-frame" | "reference";
  label: string;
  sha256: string;
  subject: string;
  width: number;
}

/** One still: scaled to a width a page can show, measured after it is made. */
async function freezeStill(
  engine: Encoder,
  from: string,
  to: string,
  file: string,
  still: Pick<Still, "kind" | "label" | "subject">
): Promise<Still> {
  const target = join(to, file);
  await engine.still(from, target);
  const { height, width } = await engine.probe(target);
  return { ...still, file, height, sha256: await sha256(target), width };
}

export async function freezeRelease(
  input: FreezeInput,
  engine: Encoder = encoder
): Promise<Result<FreezeReport>> {
  try {
    return ok(await freeze(input, engine));
  } catch (error) {
    if (error instanceof FreezeError) {
      return err(error);
    }
    throw error;
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: freezing is one sequence; splitting it would hide the order the release depends on
async function freeze(input: FreezeInput, engine: Encoder): Promise<FreezeReport> {
  const registryFile = join(input.root, "site", "releases", `${input.version}.json`);
  if (await exists(registryFile)) {
    throw new FreezeError(
      `wydanie ${input.version} już istnieje. Opublikowanego wydania się nie nadpisuje, wybierz nowy numer.`
    );
  }

  const scope = {
    episodeId: input.episodeId,
    projectId: input.projectId,
    workspace: input.workspace,
  };

  const stage0 = await readStage0Inputs(scope);
  if (!stage0.ok) {
    throw new FreezeError(stage0.error.message, { cause: stage0.error });
  }
  if (!stage0.data.approved) {
    throw new FreezeError(
      `etap 0 nie jest zatwierdzony dla ${input.projectId}/${input.episodeId}; nie zamrażam czegoś, czego nikt nie przyjął.`
    );
  }

  // The subjects come from the package rather than from a person: they are the
  // English lines the model actually received, and retyping them would be a
  // second version of the same truth.
  const packaged = await checkPromptPackage(scope);
  if (!(packaged.ok && packaged.data.verdict)) {
    throw new FreezeError(
      `pakiet promptów ${input.projectId}/${input.episodeId} nie jest gotowy; bez niego nie ma identyfikatorów ani ról referencji.`
    );
  }
  const subjects = new Map(packaged.data.verdict.references.map((one) => [one.id, one.subject]));

  const project = projectPaths(input.workspace, input.projectId);
  if (!project.ok) {
    throw new FreezeError(project.error.message, { cause: project.error });
  }
  const episode = episodePaths(project.data, input.episodeId);
  if (!episode.ok) {
    throw new FreezeError(episode.error.message, { cause: episode.error });
  }

  const exports = join(input.root, "out", "releases", input.version);
  const posters = join(input.root, "site", "assets", "releases", input.version);
  const documents = join(input.root, "site", "documents", input.version);
  const sources = join(input.root, "site", "sources", input.version);
  for (const directory of [exports, posters, documents, sources]) {
    // biome-ignore lint/performance/noAwaitInLoops: four directories, made in order
    await mkdir(directory, { recursive: true });
  }
  const written: string[] = [];
  const relative = (path: string) => path.slice(input.root.length + 1);

  await writeFile(join(sources, "source.md"), stage0.data.source);
  written.push(relative(join(sources, "source.md")));
  const sourceSha = await sha256(join(sources, "source.md"));

  const frozenDocuments: {
    description: string;
    file: string;
    label: string;
    sha256: string;
    stage: number;
  }[] = [];
  for (const document of DOCUMENTS) {
    const from = episode.data[document.key];
    // biome-ignore lint/performance/noAwaitInLoops: one document at a time, in reading order
    if (!(await exists(from))) {
      continue;
    }
    const to = join(documents, document.file);
    await copyFile(from, to);
    written.push(relative(to));
    frozenDocuments.push({
      description: TODO,
      file: document.file,
      label: document.file,
      sha256: await sha256(to),
      stage: document.stage,
    });
  }

  const tracks: Record<string, unknown>[] = [];
  for (const track of imageTracks) {
    const paths = episodeTrackPaths(episode.data, track satisfies ImageTrack);
    // biome-ignore lint/performance/noAwaitInLoops: one track encoded at a time
    if (!(await exists(paths.mixedVideo))) {
      throw new FreezeError(`brak ${track}/mixed.mp4, ten tor nie ma jeszcze gotowego filmu.`);
    }

    const video = `${track}-mixed.mp4`;
    await engine.video(paths.mixedVideo, join(exports, video));
    written.push(relative(join(exports, video)));
    const measured = await engine.probe(join(exports, video));

    const poster = join(posters, `${track}.jpg`);
    await engine.poster(join(exports, video), poster);
    written.push(relative(poster));

    const stills: Still[] = [];
    stills.push(
      await freezeStill(engine, paths.openingFrameImage, exports, `${track}-opening-frame.jpg`, {
        kind: "opening-frame",
        label: "opening-frame",
        subject: TODO,
      })
    );

    const referenceFiles = (await readdir(paths.references))
      .filter((name) => name.endsWith(".png"))
      .sort();
    for (const name of referenceFiles) {
      const id = basename(name, ".png");
      stills.push(
        // biome-ignore lint/performance/noAwaitInLoops: one reference at a time, in id order
        await freezeStill(
          engine,
          join(paths.references, name),
          exports,
          `${track}-${id.toLowerCase()}.jpg`,
          {
            kind: "reference",
            label: id,
            subject: subjects.get(id) ?? TODO,
          }
        )
      );
    }

    for (const member of stage0.data.cast) {
      const character = characterPaths(project.data, member.id);
      if (!character.ok) {
        throw new FreezeError(character.error.message, { cause: character.error });
      }
      const { card } = characterTrackPaths(character.data, track);
      // biome-ignore lint/performance/noAwaitInLoops: one card checked at a time
      if (!(await exists(card))) {
        throw new FreezeError(
          `brak karty postaci ${member.id} na torze ${track}, etap 2 nie jest skończony.`
        );
      }
      stills.push(
        await freezeStill(engine, card, exports, `${track}-${member.id}.jpg`, {
          kind: "character",
          label: `hero:${member.id}`,
          subject: TODO,
        })
      );
    }
    for (const still of stills) {
      written.push(relative(join(exports, still.file)));
    }

    tracks.push({
      bytes: (await stat(join(exports, video))).size,
      durationSeconds: measured.seconds,
      height: measured.height,
      label: track,
      stills,
      track,
      video,
      videoSha256: await sha256(join(exports, video)),
      width: measured.width,
    });
  }

  const registry = {
    changes: [TODO],
    commit: TODO,
    commitDate: TODO,
    date: new Date().toISOString().slice(0, 10),
    description: TODO,
    documents: frozenDocuments,
    episode: {
      aspectRatio: stage0.data.aspectRatio,
      audio: TODO,
      episode: TODO,
      language: stage0.data.settings.language,
      project: stage0.data.title,
    },
    note: TODO,
    repository: "https://github.com/auditmos/aimator",
    repositoryPrivate: true,
    source: {
      description: TODO,
      filename: "source.md",
      label: "source.md",
      language: stage0.data.settings.language,
      sha256: sourceSha,
    },
    sourceDirectory: `out/releases/${input.version}`,
    title: TODO,
    tracks,
    version: input.version,
  };
  await writeFile(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  written.push(relative(registryFile));

  // Read back out of the registry rather than listed beside it: two lists of
  // the same fields drift at the first one somebody forgets to update.
  return { files: written, unwritten: unwrittenFields(registry) };
}
