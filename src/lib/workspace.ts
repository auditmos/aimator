import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { err, ok, type Result } from "./result.js";

/**
 * The only module that knows where artifacts live. Every other module asks it
 * for a path instead of joining segments itself, which is what keeps the
 * per-project / per-model layout a single fact rather than a convention.
 *
 * Deliberately free of filesystem access: paths are decided here, bytes are
 * read and written by the stage that owns them.
 */

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** `R01`, `C01`: a numbered artifact of one episode, and its own file name. */
const ARTIFACT_ID = /^[A-Z]\d{2,}$/;
/** One path segment that cannot escape the directory it is joined onto. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EPISODE_SOURCE = /^(\d{1,3})[-_](.+)\.md$/;
const COMBINING_MARKS = /\p{M}+/gu;
const NON_SLUG = /[^a-z0-9]+/g;
const SLUG_EDGES = /^-+|-+$/g;
const TILDE_PREFIX = /^~(?=\/|$)/;

// NFD leaves these Polish letters undecomposed, so they need an explicit map.
const TRANSLITERATED = new Map([
  ["ł", "l"],
  ["Ł", "L"],
]);

export interface Workspace {
  readonly root: string;
}

/**
 * The image model tracks. A track is a directory level and never a filename
 * prefix, so the two render the same project side by side without either one
 * having to know the other exists.
 */
export const imageTracks = ["gpt-image", "seedream"] as const;

export type ImageTrack = (typeof imageTracks)[number];

export interface ProjectPaths {
  /** The cast. A character is a directory level, exactly as a track is. */
  readonly characters: string;
  readonly episodes: string;
  readonly file: string;
  /**
   * How loud the music sits under the narrator — stage 10's own decision file,
   * and `narration.json`'s twin one row down.
   *
   * At the project level for the same reason: a series sounds like itself
   * between episodes. In a file of its own rather than inside `narration.json`
   * because where a decision lives decides what changing it invalidates, and
   * these two invalidate different things — the reading lapses the recordings
   * it produced, the levels lapse the mix they produced and must leave those
   * recordings, which they never touched, exactly where they are.
   */
  readonly mix: string;
  /**
   * How the narrator of this series performs — stage 9's own decision file.
   *
   * At the project level because a reading recurs between episodes exactly as a
   * cast does, and beside `project.json` rather than inside it because stage 0
   * neither writes it nor reads it. That separation is the whole point: this
   * file is a recorded input of the bought recordings and of nothing else, so
   * changing how the narrator reads lapses the lines it actually produced and
   * leaves every approval above them standing.
   */
  readonly narration: string;
  readonly prepareStage: string;
  readonly root: string;
  readonly rules: string;
}

export interface CharacterPaths {
  readonly root: string;
  /** Photographs of this one character; absent when the basis is a description. */
  readonly sources: string;
}

/** One character as one model track draws it. The two tracks never meet. */
export interface CharacterTrackPaths {
  readonly card: string;
  readonly hero: string;
  /**
   * A file, not a directory, for the reason `screenplayLock` gives: the layout
   * check reports empty directories, so a lock held as one would trip it.
   */
  readonly lock: string;
  readonly root: string;
  readonly runs: string;
  readonly stage: string;
  readonly views: string;
}

/**
 * One episode as one model track draws it — stage 5 and, by contract, stages 6
 * to 8. The track is a directory level here for the same reason it is one under
 * a character: the two productions hold identically named files and neither
 * needs a prefix to stay out of the other's way.
 *
 * The text stages have no counterpart to this, and that is the whole shape of
 * the pipeline: screenplay, shot list and prompt package describe the story and
 * sit directly under the episode, while everything below is drawn twice.
 */
export interface EpisodeTrackPaths {
  readonly assemblyLock: string;
  /**
   * Stage 8's one state file. It sits beside the clips it is cut from rather
   * than above them, because the cut is a per-track artifact: two tracks hold
   * two different films of the same story, and neither is the episode.
   */
  readonly assemblyStage: string;
  /** Stage 7's videos, one file per clip. */
  readonly clips: string;
  readonly clipsLock: string;
  /**
   * Stage 7's one state file, holding both media it buys: a record per clip and
   * a record per entry frame. Rule 1 asks for one `<stage>.stage.json` per
   * stage, and stage 7 is one stage however many kinds of file it writes.
   */
  readonly clipsStage: string;
  /**
   * Stage 8's one output: this track's whole episode, cut from its own clips.
   *
   * A file rather than a directory, for the reason `openingFrameImage` is one —
   * there is exactly one of it — and named `episode.mp4` rather than after the
   * stage, because what it holds is the film, not the assembling of it.
   */
  readonly episodeVideo: string;
  /**
   * Stage 7's stills, one directory per clip. A directory rather than a file
   * because a clip has two of them: the entry frame it is drawn from and the
   * end frame it hands back, which is what the next clip continues out of.
   */
  readonly frames: string;
  /**
   * Stage 10's one output on this track: the whole film, with every sound it
   * has — narration, music and effects — over a picture copied through
   * untouched.
   *
   * It sits beside `narrated.mp4` rather than replacing it, exactly as that
   * one sits beside `episode.mp4`. Each of the three carries a separate yes
   * about a separate question: the cut is the film, the narrated cut is where
   * the narrator lands, and this one is whether the whole thing plays. Stage 10
   * rebuilds from `episode.mp4` and the lossless stems rather than laying music
   * over `narrated.mp4`, so the speech is encoded exactly once — which is also
   * the only arrangement in which music can step back under a voice, because
   * the voice has to be an input of the graph rather than already inside it.
   */
  readonly mixedVideo: string;
  /**
   * Stage 9's one output on this track: the approved picture cut with the
   * narration laid over it, the video copied through untouched.
   *
   * A file rather than a directory, and named for what it holds rather than for
   * the stage that made it — the same reading that makes stage 8's output
   * `episode.mp4` and its state file `assembly.stage.json`. It sits beside
   * `episode.mp4` rather than replacing it: those bytes carry a human's yes,
   * and stage 9 neither overwrites nor re-encodes them.
   */
  readonly narratedVideo: string;
  /**
   * Stage 6's one output. It is a file rather than a directory because the
   * opening frame is a single image, so there is no set for a directory to
   * hold — and it is `openingFrameImage` rather than `openingFrame` because
   * `PromptPaths` already owns that word for the direction stage 4 published.
   */
  readonly openingFrameImage: string;
  readonly openingFrameLock: string;
  readonly openingFrameStage: string;
  readonly references: string;
  /**
   * A file, not an empty directory, for the reason `screenplayLock` gives: the
   * layout check reports empty directories, so a lock held as one would trip
   * the very check it sits beside.
   */
  readonly referencesLock: string;
  readonly referencesStage: string;
  readonly root: string;
  /**
   * This track's own archive, distinct from the episode's text-stage `runs/`.
   * Every stage that draws on this track archives here: a run id is unique and
   * `run.json` records which stage minted it, exactly as the text stages share
   * one `runs/` under the episode.
   */
  readonly runs: string;
  /**
   * Stage 10's per-track lock and state file, at the second of its two levels
   * for the reason stage 9 writes at two: its stems are shared and its mix is
   * not. Rule 1 asks for one state file per stage *per directory it writes to*,
   * which is what both of them do.
   */
  readonly soundDesignLock: string;
  readonly soundDesignStage: string;
  /**
   * Stage 9's per-track lock and state file. Stage 9 is the first stage whose
   * artifacts live at two levels — the words are shared like every text stage's
   * and the mix is per track like every video stage's — so it writes one state
   * file at each, exactly as rule 1 asks: one per stage per directory it writes
   * to, the way stage 2 holds one per character per track.
   */
  readonly soundtrackLock: string;
  readonly soundtrackStage: string;
}

/**
 * What one image attempt archives. `request.json` carries the prompt and the
 * settings but never the reference bytes: those are inputs, and an archive that
 * copied them would duplicate every photograph on every attempt.
 */
export interface ImageRunPaths {
  /** Exactly what the provider returned, before anything was published. */
  readonly image: string;
  /** The result being replaced. Written only by `--regenerate`. */
  readonly previousImage: string;
  readonly prompt: string;
  readonly request: string;
  readonly response: string;
  readonly root: string;
  readonly run: string;
  readonly transport: string;
  readonly validation: string;
}

/**
 * What one video attempt archives. Like an image attempt, it never copies an
 * input: the entry frame the request carried is referenced by path and digest.
 */
export interface VideoRunPaths {
  /**
   * The final frame the provider returned, before it was published, under the
   * name of whatever format it arrived in. Both are declared because the
   * format is the provider's choice and a resume has to find the file again
   * without having seen the bytes yet.
   */
  readonly endFrameJpeg: string;
  readonly endFramePng: string;
  /** The clip being replaced. Written only by `--regenerate`. */
  readonly previousVideo: string;
  readonly prompt: string;
  readonly request: string;
  readonly response: string;
  readonly root: string;
  readonly run: string;
  readonly transport: string;
  readonly validation: string;
  /** Exactly what the provider returned, before anything was published. */
  readonly video: string;
}

/**
 * What one local attempt archives.
 *
 * It is the thinnest archive in the pipeline, and deliberately so: stage 8
 * sends nothing, so there is no request, no response and no prompt. What it
 * keeps is exactly what the invariant asks for — the part that cannot be
 * reconstructed. The cut itself can: it is a pure function of clips whose
 * digests are recorded. Which muxer produced these bytes, with which arguments,
 * and what it said while doing it, cannot — not after the next upgrade.
 */
interface AssemblyRunPaths {
  /** The concat list handed to the muxer: the clips, in the plan's order. */
  readonly list: string;
  /** The cut being replaced. Written only by `--regenerate`. */
  readonly previousVideo: string;
  readonly root: string;
  readonly run: string;
  /**
   * How the bytes travelled. For a paid stage that is HTTP; here it is the
   * process — argv, the version it reported, its exit code and its stderr.
   * The same word, because it answers the same question.
   */
  readonly transport: string;
  readonly validation: string;
}

/**
 * What one speech attempt archives. `request.json` carries the text and the
 * settings, which is the whole of what was sent — a TTS call has no attachments
 * and therefore no reference bytes to leave out.
 */
export interface VoiceRunPaths {
  /** Exactly what the provider returned, before anything was published. */
  readonly audio: string;
  /** The line being replaced. Written only by `--regenerate`. */
  readonly previousAudio: string;
  readonly prompt: string;
  readonly request: string;
  readonly response: string;
  readonly root: string;
  readonly run: string;
  readonly transport: string;
  readonly validation: string;
}

/**
 * What one bought stem archives. Stage 10's counterpart to `VoiceRunPaths`,
 * and separate from it for one reason that is not cosmetic: the container
 * differs, and the archive holds exactly what the provider returned.
 */
export interface AudioRunPaths {
  /** Exactly what the provider returned, before anything was published. */
  readonly audio: string;
  /** The stem being replaced. Written only by `--regenerate`. */
  readonly previousAudio: string;
  readonly prompt: string;
  readonly request: string;
  readonly response: string;
  readonly root: string;
  readonly run: string;
  readonly transport: string;
  readonly validation: string;
}

/**
 * What one local mix archives: stage 8's thin archive, plus where each sound
 * landed. Shared by stage 9's narrated cut and stage 10's full mix, because
 * both are the same act — a local engine laying sound over a picture it copied
 * — and `placement.json` answers the same question for both.
 */
interface MixRunPaths {
  /** Which sound was laid down at which second of this track's own cut. */
  readonly placement: string;
  /** The mix being replaced. Written only by `--regenerate`. */
  readonly previousVideo: string;
  readonly root: string;
  readonly run: string;
  readonly transport: string;
  readonly validation: string;
}

export interface EpisodePaths {
  readonly file: string;
  /**
   * Stage 9's spoken lines, one file per utterance and per paid call.
   *
   * Shared between the tracks, with no track level, because what the bytes
   * depend on — the text, the voice and the speech model — does not differ per
   * track. Only the mix does, because only the mix is timed against a
   * particular cut.
   */
  readonly narration: string;
  readonly narrationLock: string;
  /**
   * Stage 9's script: which sentences the narrator says and where each one is
   * anchored in the plan. It sits directly under the episode, beside the
   * screenplay and the shot list, because it is words rather than pictures.
   */
  readonly narrationScript: string;
  readonly prepareStage: string;
  /**
   * Stage 4. Like the shot list it has no track level: the package describes
   * what every image of this episode must contain, and the two tracks draw the
   * same one. Its reference ids resolve to a track only when a stage attaches
   * them, which is what lets one manifest serve both.
   */
  readonly promptPackage: string;
  readonly promptPackageLock: string;
  readonly promptPackageStage: string;
  /** The tree of prompt files stage 4 publishes; see `promptPaths`. */
  readonly prompts: string;
  readonly root: string;
  /** One archive directory per episode; the run id keeps stages from colliding. */
  readonly runs: string;
  readonly screenplay: string;
  /**
   * A file, not an empty directory. The layout rule says a directory appears
   * when a stage writes into it and `check` reports the empty ones, so a lock
   * held as a directory would trip the very check it sits beside.
   */
  readonly screenplayLock: string;
  readonly screenplayStage: string;
  /**
   * Stage 3. It sits directly under the episode, with no track level: the shot
   * list describes the story, and the two image tracks plan the same one.
   */
  readonly shotList: string;
  readonly shotListLock: string;
  readonly shotListStage: string;
  /**
   * Stage 10's bought stems: the music bed and every sound effect, one file per
   * paid call.
   *
   * Shared between the tracks, with no track level, for the reason stage 9's
   * spoken lines are: what the bytes depend on — the cue text, the audio model
   * and the length asked for — does not differ per track. A music bed has no
   * idea which of the two films it will sit under, and the two differ only by
   * the drift their clips came back with.
   */
  readonly sound: string;
  /**
   * Stage 10's cue sheet: what the episode sounds like, section by section and
   * effect by effect.
   *
   * It sits beside the screenplay, the shot list and the narration script
   * because it is words rather than pictures — but unlike those three it is an
   * **instruction**, so rule 9 puts it in English while the shot list it is
   * written from stays in the film's own language.
   */
  readonly soundDesign: string;
  readonly soundDesignLock: string;
  readonly soundDesignStage: string;
  /**
   * Stage 9's shared state file, holding the script and every bought utterance.
   * Its per-track half sits under the track, because the mix is per track and
   * the words are not.
   */
  readonly soundtrackStage: string;
  readonly source: string;
}

/**
 * What a single attempt archives: only what cannot be reconstructed. The
 * inputs are referenced by path and digest inside `run.json`, never copied.
 */
export interface RunPaths {
  /**
   * The results being replaced, under their own names. Written only by
   * `--regenerate`.
   *
   * A directory rather than one field per stage: stage 4 replaces a manifest
   * and a tree of prompt files at once, so a `previous-<stage>.md` field would
   * have had to become a field per file. What a stage preserves here is its own
   * business; that it goes under `previous/` is this module's.
   */
  readonly previous: string;
  readonly prompt: string;
  readonly request: string;
  readonly response: string;
  readonly root: string;
  readonly run: string;
  readonly transport: string;
  readonly validation: string;
}

interface EpisodeIdentity {
  readonly id: string;
  readonly number: number;
}

class WorkspaceError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = "WorkspaceError";
    this.path = path;
  }
}

class IdentifierError extends Error {
  readonly value: string;

  constructor(value: string, message: string) {
    super(message);
    this.name = "IdentifierError";
    this.value = value;
  }
}

function transliterate(value: string): string {
  let out = "";

  for (const character of value) {
    out += TRANSLITERATED.get(character) ?? character;
  }

  return out;
}

function slugify(value: string): string {
  return transliterate(value)
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(NON_SLUG, "-")
    .replace(SLUG_EDGES, "");
}

/** Resolves the artifact root to an absolute path, expanding a leading `~/`. */
export function resolveWorkspace(root: string | undefined): Result<Workspace> {
  const raw = root?.trim();

  if (raw === undefined || raw === "") {
    return err(
      new WorkspaceError(
        "",
        "no artifact workspace configured: set AIMATOR_WORKSPACE or pass --workspace <path>"
      )
    );
  }

  // A .env file performs no shell expansion, so `~/...` would otherwise
  // become a directory literally named "~".
  const expanded = raw.replace(TILDE_PREFIX, homedir());

  return ok({ root: isAbsolute(expanded) ? expanded : resolve(expanded) });
}

/**
 * Turns a path recorded in an artifact back into one that can be read.
 *
 * Records store workspace-relative paths so the whole tree can be moved, which
 * means verifying a recorded input means resolving it again here — this module
 * is the only one allowed to join a segment, including in this direction.
 */
export function workspacePath(workspace: Workspace, recorded: string): string {
  return join(workspace.root, ...recorded.split("/"));
}

export function projectPaths(workspace: Workspace, projectId: string): Result<ProjectPaths> {
  if (!PROJECT_ID.test(projectId)) {
    return err(
      new IdentifierError(
        projectId,
        `invalid project id "${projectId}": must start with an ASCII letter or digit and contain only letters, digits, - and _`
      )
    );
  }

  const root = join(workspace.root, "projects", projectId);

  return ok({
    characters: join(root, "characters"),
    episodes: join(root, "episodes"),
    file: join(root, "project.json"),
    mix: join(root, "mix.json"),
    narration: join(root, "narration.json"),
    prepareStage: join(root, "prepare.stage.json"),
    root,
    rules: join(root, "project.md"),
  });
}

/**
 * One member of the cast. The identifier is a directory name, so it obeys the
 * same rules as a project or an episode id rather than trusting whatever the
 * roster happens to hold.
 */
export function characterPaths(project: ProjectPaths, characterId: string): Result<CharacterPaths> {
  if (!PROJECT_ID.test(characterId)) {
    return err(
      new IdentifierError(
        characterId,
        `invalid character id "${characterId}": must start with an ASCII letter or digit and contain only letters, digits, - and _`
      )
    );
  }

  const root = join(project.characters, characterId);

  return ok({ root, sources: join(root, "sources") });
}

/**
 * The per-track half of a character. The track is a directory level, so the
 * two tracks hold identically named files and neither needs a prefix to stay
 * out of the other's way.
 */
export function characterTrackPaths(
  character: CharacterPaths,
  track: ImageTrack
): CharacterTrackPaths {
  const root = join(character.root, track);

  return {
    card: join(root, "card.png"),
    hero: join(root, "hero.png"),
    lock: join(root, "character.lock"),
    root,
    runs: join(root, "runs"),
    stage: join(root, "character.stage.json"),
    views: join(root, "views"),
  };
}

/**
 * A view's own file. The view name is the artifact key and the file name at
 * once, so it is checked here rather than trusted into a path.
 */
export function characterViewImage(paths: CharacterTrackPaths, view: string): Result<string> {
  return PROJECT_ID.test(view)
    ? ok(join(paths.views, `${view}.png`))
    : err(new IdentifierError(view, `invalid view name "${view}"`));
}

/**
 * The archive of one image attempt. Run ids are minted by `lib/artifact`.
 *
 * It takes the archive directory rather than a particular track's paths,
 * because a character and an episode archive the same thing in the same shape
 * and only differ in where their `runs/` sits.
 */
export function imageRunPaths(paths: { readonly runs: string }, runId: string): ImageRunPaths {
  const root = join(paths.runs, runId);

  return {
    image: join(root, "original.png"),
    previousImage: join(root, "previous.png"),
    prompt: join(root, "prompt.md"),
    request: join(root, "request.json"),
    response: join(root, "response.json"),
    root,
    run: join(root, "run.json"),
    transport: join(root, "transport.json"),
    validation: join(root, "validation.json"),
  };
}

export function episodePaths(project: ProjectPaths, episodeId: string): Result<EpisodePaths> {
  if (!PROJECT_ID.test(episodeId)) {
    return err(
      new IdentifierError(
        episodeId,
        `invalid episode id "${episodeId}": must start with an ASCII letter or digit and contain only letters, digits, - and _`
      )
    );
  }

  const root = join(project.episodes, episodeId);

  return ok({
    file: join(root, "episode.json"),
    narration: join(root, "narration"),
    narrationLock: join(root, "narration.lock"),
    narrationScript: join(root, "narration.md"),
    prepareStage: join(root, "prepare.stage.json"),
    promptPackage: join(root, "prompt-package.json"),
    promptPackageLock: join(root, "prompt-package.lock"),
    promptPackageStage: join(root, "prompt-package.stage.json"),
    prompts: join(root, "prompts"),
    root,
    runs: join(root, "runs"),
    screenplay: join(root, "screenplay.md"),
    screenplayLock: join(root, "screenplay.lock"),
    screenplayStage: join(root, "screenplay.stage.json"),
    shotList: join(root, "shot-list.md"),
    shotListLock: join(root, "shot-list.lock"),
    shotListStage: join(root, "shot-list.stage.json"),
    sound: join(root, "sound"),
    soundDesign: join(root, "sound-design.md"),
    soundDesignLock: join(root, "sound-design.lock"),
    soundDesignStage: join(root, "sound-design.stage.json"),
    soundtrackStage: join(root, "soundtrack.stage.json"),
    source: join(root, "source.md"),
  });
}

/**
 * The per-track half of an episode, where the two productions diverge.
 *
 * Stage 5 is the first to write here. It needs no validation of its own: the
 * episode id was already checked by `episodePaths` and the track is a closed
 * set, so there is nothing left that could escape the directory.
 *
 * Every state file and every lock is named after the stage that owns it. While
 * stage 5 was the only writer a bare `stage` read correctly, but it encoded
 * "there is one stage down here" — which stage 6 makes false. Rule 1 asks for
 * `<stage>.stage.json`, and that is only unambiguous if the field says which.
 */
export function episodeTrackPaths(episode: EpisodePaths, track: ImageTrack): EpisodeTrackPaths {
  const root = join(episode.root, track);

  return {
    assemblyLock: join(root, "assembly.lock"),
    assemblyStage: join(root, "assembly.stage.json"),
    clips: join(root, "clips"),
    clipsLock: join(root, "clips.lock"),
    clipsStage: join(root, "clips.stage.json"),
    episodeVideo: join(root, "episode.mp4"),
    frames: join(root, "frames"),
    mixedVideo: join(root, "mixed.mp4"),
    narratedVideo: join(root, "narrated.mp4"),
    openingFrameImage: join(root, "opening-frame.png"),
    openingFrameLock: join(root, "opening-frame.lock"),
    openingFrameStage: join(root, "opening-frame.stage.json"),
    references: join(root, "references"),
    referencesLock: join(root, "references.lock"),
    referencesStage: join(root, "references.stage.json"),
    root,
    runs: join(root, "runs"),
    soundDesignLock: join(root, "sound-design.lock"),
    soundDesignStage: join(root, "sound-design.stage.json"),
    soundtrackLock: join(root, "soundtrack.lock"),
    soundtrackStage: join(root, "soundtrack.stage.json"),
  };
}

/**
 * One reference image. The identifier is the artifact key, the manifest entry
 * and the file name at once, so it is checked here rather than trusted into a
 * path — the same reason `characterViewImage` checks a view name.
 */
export function referenceImage(paths: EpisodeTrackPaths, id: string): Result<string> {
  return ARTIFACT_ID.test(id)
    ? ok(join(paths.references, `${id}.png`))
    : err(new IdentifierError(id, `invalid reference id "${id}": expected a form like R01`));
}

/**
 * One clip's video. The identifier is the artifact key and the file name at
 * once, so it is checked here rather than trusted into a path — the same
 * reason `referenceImage` checks a reference id.
 */
export function clipVideo(paths: EpisodeTrackPaths, id: string): Result<string> {
  return ARTIFACT_ID.test(id)
    ? ok(join(paths.clips, `${id}.mp4`))
    : err(new IdentifierError(id, `invalid clip id "${id}": expected a form like C01`));
}

/**
 * The two formats a still is published in, and the extension each one gets.
 *
 * An entry frame is drawn by an image model this pipeline asks for PNG, so it
 * is always a PNG. The frame a clip ended on is whatever the video provider
 * handed back — a JPEG, in practice — and it is published under a name that
 * says so rather than re-encoded into the format the rest of the tree happens
 * to use: approving one picture and attaching another is the thing rule 6 and
 * the bytes-bound approval exist to prevent.
 */
export type StillFormat = "jpeg" | "png";

const EXTENSION: Record<StillFormat, string> = { jpeg: "jpg", png: "png" };

/**
 * One of a clip's two stills.
 *
 * The clip id is a directory level here rather than a filename prefix, for the
 * reason rule 2 gives about tracks and characters: `frames/C03/entry.png` and
 * `frames/C03/end.png` belong to one clip, and nothing else has to know how
 * many stills a clip turns out to have.
 *
 * The entry frame is an artifact of stage 7 even though stage 7 does not draw
 * every one of them: C01's entry frame is the opening frame, which lives at the
 * track root because stage 6 owns it.
 */
export function clipFrame(
  paths: EpisodeTrackPaths,
  id: string,
  kind: "end" | "entry",
  format: StillFormat = "png"
): Result<string> {
  return ARTIFACT_ID.test(id)
    ? ok(join(paths.frames, id, `${kind}.${EXTENSION[format]}`))
    : err(new IdentifierError(id, `invalid clip id "${id}": expected a form like C01`));
}

/**
 * The archive of one video attempt.
 *
 * It is an image attempt plus the two files the provider hands back: the clip
 * itself, and the final frame it ended on. Both are downloaded from signed URLs
 * that live 24 hours, so keeping them here is what makes a resume free — the
 * same reason a seedream image attempt keeps `original.png`.
 */
export function videoRunPaths(paths: { readonly runs: string }, runId: string): VideoRunPaths {
  const root = join(paths.runs, runId);

  return {
    endFrameJpeg: join(root, "last-frame.jpg"),
    endFramePng: join(root, "last-frame.png"),
    previousVideo: join(root, "previous.mp4"),
    prompt: join(root, "prompt.md"),
    request: join(root, "request.json"),
    response: join(root, "response.json"),
    root,
    run: join(root, "run.json"),
    transport: join(root, "transport.json"),
    validation: join(root, "validation.json"),
    video: join(root, "original.mp4"),
  };
}

/**
 * The archive of one local attempt — stage 8's, and the first with no network
 * behind it. It shares this track's `runs/` with the paid stages above it, for
 * the reason they share it with each other: a run id is unique and `run.json`
 * records which stage minted it.
 */
export function assemblyRunPaths(
  paths: { readonly runs: string },
  runId: string
): AssemblyRunPaths {
  const root = join(paths.runs, runId);

  return {
    list: join(root, "concat.txt"),
    previousVideo: join(root, "previous.mp4"),
    root,
    run: join(root, "run.json"),
    transport: join(root, "transport.json"),
    validation: join(root, "validation.json"),
  };
}

/**
 * One utterance's own file. The identifier is the artifact key, the line of
 * the script and the file name at once, so it is checked here rather than
 * trusted into a path — the same reason `referenceImage` checks a reference id.
 *
 * WAV rather than the provider's default MP3, and that is a decision rather
 * than a preference: a RIFF header states its sample rate, its channels and the
 * size of its data block, so the length of a bought line is exact arithmetic on
 * a machine with no media tools. An MP3 states its length only to whoever walks
 * its frames. Stage 7 read boxes instead of calling a decoder for exactly this;
 * choosing the container is the same choice, one step earlier.
 */
export function narrationAudio(paths: EpisodePaths, id: string): Result<string> {
  return ARTIFACT_ID.test(id)
    ? ok(join(paths.narration, `${id}.wav`))
    : err(new IdentifierError(id, `invalid utterance id "${id}": expected a form like N01`));
}

/**
 * One bought stem's own file — the music bed `M01`, or an effect `E01`.
 *
 * MP3 rather than the WAV a line is bought in, and that is the provider's
 * doing rather than this pipeline's preference. Neither the music endpoint nor
 * the sound-effect one offers a WAV container at all, and the raw PCM they do
 * offer carries **no header**: the sample rate would be known from the format
 * asked for, but the channel count would not, and guessing it wrong states a
 * length twice or half the truth without a word of warning. An MP3 frame
 * header declares its own rate, bitrate and channel mode, so the verdict on a
 * stem stays exact and offline — it simply has to walk the frames instead of
 * reading twenty-four bytes. That is the same trade stage 7 made when it read
 * MP4 boxes rather than calling a decoder.
 */
export function soundStem(paths: EpisodePaths, id: string): Result<string> {
  return ARTIFACT_ID.test(id)
    ? ok(join(paths.sound, `${id}.mp3`))
    : err(new IdentifierError(id, `invalid stem id "${id}": expected a form like M01 or E01`));
}

/**
 * The archive of one speech attempt.
 *
 * It sits under the episode rather than under a track, because that is where
 * the line was bought: the words are shared, so the receipt is too. Like every
 * other archive it never copies an input — the text it read out is in the
 * script, referenced by path and digest.
 */
export function voiceRunPaths(paths: { readonly runs: string }, runId: string): VoiceRunPaths {
  const root = join(paths.runs, runId);

  return {
    audio: join(root, "original.wav"),
    previousAudio: join(root, "previous.wav"),
    prompt: join(root, "prompt.md"),
    request: join(root, "request.json"),
    response: join(root, "response.json"),
    root,
    run: join(root, "run.json"),
    transport: join(root, "transport.json"),
    validation: join(root, "validation.json"),
  };
}

/**
 * The archive of one bought stem.
 *
 * It sits under the episode rather than under a track, for the reason a
 * speech attempt does: that is where the stem was bought, and the stems are
 * shared. Like every archive here it never copies an input — the cue it was
 * composed from is in the cue sheet, referenced by path and digest.
 */
export function audioRunPaths(paths: { readonly runs: string }, runId: string): AudioRunPaths {
  const root = join(paths.runs, runId);

  return {
    audio: join(root, "original.mp3"),
    previousAudio: join(root, "previous.mp3"),
    prompt: join(root, "prompt.md"),
    request: join(root, "request.json"),
    response: join(root, "response.json"),
    root,
    run: join(root, "run.json"),
    transport: join(root, "transport.json"),
    validation: join(root, "validation.json"),
  };
}

/**
 * The archive of one local mix — stage 9's narrated cut and stage 10's full
 * one, which are the same act over different inputs. It keeps what stage 8's
 * archive keeps and one thing more: where each sound was laid down. That is
 * arithmetic and could be recomputed, but it is also what the engine was
 * actually told, and an archive holding the arguments without it would record
 * half the invocation.
 */
export function mixRunPaths(paths: { readonly runs: string }, runId: string): MixRunPaths {
  const root = join(paths.runs, runId);

  return {
    placement: join(root, "placement.json"),
    previousVideo: join(root, "previous.mp4"),
    root,
    run: join(root, "run.json"),
    transport: join(root, "transport.json"),
    validation: join(root, "validation.json"),
  };
}

/** The archive of one attempt. Run ids are minted by `lib/artifact`. */
export function runPaths(episode: EpisodePaths, runId: string): RunPaths {
  const root = join(episode.runs, runId);

  return {
    previous: join(root, "previous"),
    prompt: join(root, "prompt.md"),
    request: join(root, "request.json"),
    response: join(root, "response.json"),
    root,
    run: join(root, "run.json"),
    transport: join(root, "transport.json"),
    validation: join(root, "validation.json"),
  };
}

/**
 * A file inside a run's `previous/`, named as the artifact itself is named.
 *
 * A stage preserving its own result knows the names it uses; it does not get to
 * join them onto a path, so it asks here — the same direction `workspacePath`
 * already covers. A name that escapes the archive is refused rather than
 * normalised, because a `--regenerate` that wrote outside its own run
 * directory would be a backup that overwrote something.
 */
export function previousFile(run: RunPaths, name: string): Result<string> {
  const segments = name.split("/");

  return segments.length > 0 && segments.every((segment) => SAFE_SEGMENT.test(segment))
    ? ok(join(run.previous, ...segments))
    : err(new IdentifierError(name, `invalid archive name "${name}"`));
}

/**
 * Where stage 4 publishes the prompt files, one per future paid call.
 *
 * One file per call rather than one document with sections, because the unit a
 * human accepts has to be the unit a later stage sends: stage 5 makes one call
 * per reference, stage 6 one for the opening frame, stage 7 one per clip. A
 * single document would force every one of those calls either to send the whole
 * thing or to cut a slice out of prose a human is invited to rewrite.
 */
interface PromptPaths {
  readonly clips: string;
  readonly entryFrames: string;
  readonly openingFrame: string;
  readonly references: string;
  readonly root: string;
}

/** Which of the three numbered prompt kinds a file is. */
export type PromptKind = "clip" | "entry-frame" | "reference";

export function promptPaths(episode: EpisodePaths): PromptPaths {
  return {
    clips: join(episode.prompts, "clips"),
    entryFrames: join(episode.prompts, "entry-frames"),
    openingFrame: join(episode.prompts, "opening-frame.md"),
    references: join(episode.prompts, "references"),
    root: episode.prompts,
  };
}

/**
 * One numbered prompt file. The identifier is both the artifact key and the
 * file name, so it is checked here rather than trusted into a path — the same
 * reason `characterViewImage` checks a view name.
 */
export function promptFile(paths: PromptPaths, kind: PromptKind, id: string): Result<string> {
  if (!ARTIFACT_ID.test(id)) {
    return err(new IdentifierError(id, `invalid artifact id "${id}": expected a form like R01`));
  }

  if (kind === "reference") {
    return ok(join(paths.references, `${id}.md`));
  }

  return ok(join(kind === "clip" ? paths.clips : paths.entryFrames, `${id}.md`));
}

/**
 * The episode number is part of the filename because it decides the output
 * directory, so it is read from the user's own file name rather than asked for
 * twice. The slug keeps the original padding: "003-Trzeci.md" stays "003-".
 */
export function episodeIdFromSource(filename: string): Result<EpisodeIdentity> {
  const match = EPISODE_SOURCE.exec(filename);

  if (match === null) {
    return err(
      new IdentifierError(
        filename,
        `invalid episode source "${filename}": the file name must start with its number and a separator, like "01-title.md"`
      )
    );
  }

  const [, digits = "", title = ""] = match;
  const number = Number(digits);

  if (number < 1) {
    return err(
      new IdentifierError(filename, `invalid episode number "${digits}": must be 1 or more`)
    );
  }

  const slug = slugify(title);

  if (slug === "") {
    return err(
      new IdentifierError(
        filename,
        `invalid episode source "${filename}": the title has no usable characters`
      )
    );
  }

  return ok({ id: `${digits}-${slug}`, number });
}
