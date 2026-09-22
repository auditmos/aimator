import {
  characterPaths,
  characterTrackPaths,
  characterViewImage,
  clipFrame,
  clipVideo,
  type EpisodePaths,
  episodePaths,
  episodeTrackPaths,
  type ImageTrack,
  imageTracks,
  narrationAudio,
  type ProjectPaths,
  projectPaths,
  referenceImage,
  type Workspace,
} from "../lib/workspace.js";

/**
 * Where an identifier becomes a path, and the only place that is allowed to.
 *
 * The client names an artifact by what it is: the project, the stage that
 * wrote it, the stage's own word for it, and whichever of the three axes that
 * stage has, an episode, a track, a character. It never names a file, a
 * directory or a track directory, for the reason rule 3 exists at all: the
 * layout is one module's knowledge, and a browser that learned a second copy
 * of it would drift from the tree the moment a stage moved a file.
 *
 * The axes are the interesting half of the shape. A screenplay is under an
 * episode; a character's card is under a character **and** a track and under
 * no episode at all. So the identifier carries all three and each stage reads
 * the ones it has, which is why the path holds what every artifact has and the
 * rest arrives beside it rather than as a segment nobody fills in.
 *
 * The refusal is the other half. A tuple this table does not know is a 404
 * **before any path is built**, so an identifier carrying `..`, an absolute
 * path or somebody else's project cannot walk out of the workspace: the layout
 * module rejects the id, this table rejects the name, and neither asks the
 * filesystem what it thinks. A resolver that read first and validated after
 * would be one typo away from serving `/etc/passwd` over the loopback address.
 */

export interface LocatedArtifact {
  readonly contentType: string;
  readonly path: string;
}

/** What an artifact is, in the six words the PRD gives the identifier. */
interface ArtifactRequest {
  readonly artifact: string;
  /** Set only where a stage's artifacts live under a character: stage 2. */
  readonly characterId: string;
  /** Set for every stage whose artifacts live under an episode. */
  readonly episodeId: string;
  readonly projectId: string;
  readonly stage: string;
  /** Set only where a stage draws the same artifact once per track. */
  readonly track: string;
}

const MARKDOWN = "text/markdown; charset=utf-8";
const PNG = "image/png";
const MP4 = "video/mp4";
/**
 * Stage 9 buys WAV rather than the provider's default MP3, and the browser is
 * told so: a RIFF header states its own rate and length, which is what lets a
 * bought line be measured on a machine with no media tools.
 */
const WAV = "audio/wav";

/** The one artifact of stage 7 whose id is not simply the clip's. */
const ENTRY = "entry:";

/** Stage 8's own word for the one thing it makes, as `--artifact` spells it. */
const EPISODE_CUT = "episode";

/** Stage 9's two words that are not a line's id: the script, and the mix. */
const SCRIPT = "script";
const NARRATED = "narrated";

/** What each episode stage publishes, in the stage's own word for it. */
const UNDER_EPISODE: Readonly<
  Record<string, Readonly<Record<string, (episode: EpisodePaths) => LocatedArtifact>>>
> = {
  /**
   * Stage 4's manifest, and only the manifest.
   *
   * The tree under `prompts/` is deliberately not here, and not because it
   * would be hard: what stage 4 publishes is **half** a prompt, and the other
   * half is composed by the stage that sends it. `prompt-package show` is the
   * whole one, free, per track, so a panel that served the raw file would be
   * showing a person less than the command already gives them.
   */
  "prompt-package": {
    manifest: (episode) => ({
      contentType: "application/json; charset=utf-8",
      path: episode.promptPackage,
    }),
  },
  screenplay: {
    screenplay: (episode) => ({ contentType: MARKDOWN, path: episode.screenplay }),
  },
  "shot-list": {
    "shot-list": (episode) => ({ contentType: MARKDOWN, path: episode.shotList }),
  },
};

const TRACKS = new Set<string>(imageTracks);

/** The track a request names, or nothing, which is never a path. */
function trackOf(request: ArtifactRequest): ImageTrack | null {
  return TRACKS.has(request.track) ? (request.track as ImageTrack) : null;
}

/**
 * Stages 5 and 6: the pictures an episode is drawn from, once per track.
 *
 * Two stages in one function because they answer the same question with the
 * same two axes, and differ only in how many artifacts they have. Stage 5 has
 * a set, so the id is checked by the layout module as it becomes a file name;
 * stage 6 has exactly one, which is why its own word is the only name it
 * accepts and why nothing here narrows it further.
 */
function underTrack(project: ProjectPaths, request: ArtifactRequest): LocatedArtifact | null {
  const track = trackOf(request);
  const episode = episodePaths(project, request.episodeId);

  if (track === null || !episode.ok) {
    return null;
  }

  const paths = episodeTrackPaths(episode.data, track);

  if (request.stage === "opening-frame") {
    return request.artifact === "opening-frame"
      ? { contentType: PNG, path: paths.openingFrameImage }
      : null;
  }

  const image = referenceImage(paths, request.artifact);

  return image.ok ? { contentType: PNG, path: image.data } : null;
}

/**
 * Stage 7: the first artifact a person watches rather than looks at.
 *
 * The two media are one list here for the reason they are one list in the
 * stage: a clip and the frame it starts on are two purchases and one review.
 * The ids are the ones `--artifact` already spells, `C01` and `entry:C02`, so
 * a panel that can approve something can also show it without a second naming
 * scheme, and a clip's id resolving to an MP4 while a frame's resolves to a
 * PNG is the layout module's answer rather than this table's guess.
 *
 * `end:Cnn` is deliberately absent although the chain talks about it
 * constantly. Its format is the video provider's choice, `end.jpg` for the
 * JPEG ModelArk returns, and the only honest way to name the file is to read
 * what the stage recorded, which this resolver may not do: it builds paths and
 * never asks the stage or the filesystem what it thinks. A table that tried
 * both extensions would be guessing, and a guess is exactly what the 404 above
 * exists to refuse.
 */
function underClips(project: ProjectPaths, request: ArtifactRequest): LocatedArtifact | null {
  const track = trackOf(request);
  const episode = episodePaths(project, request.episodeId);

  if (track === null || !episode.ok) {
    return null;
  }

  const paths = episodeTrackPaths(episode.data, track);

  if (request.artifact.startsWith(ENTRY)) {
    const frame = clipFrame(paths, request.artifact.slice(ENTRY.length), "entry");

    return frame.ok ? { contentType: PNG, path: frame.data } : null;
  }

  const video = clipVideo(paths, request.artifact);

  return video.ok ? { contentType: MP4, path: video.data } : null;
}

/**
 * Stage 8: one film per track, and the only artifact this table narrows to a
 * single legal name.
 *
 * It is a row of its own rather than a line in `underTrack` because what it
 * serves is neither a set nor a picture: there is exactly one cut per track,
 * the stage's own word for it is `episode`, and its bytes are an MP4 the same
 * way a clip's are. Anything else under this stage is a 404 before a path
 * exists, for the reason stage 6's is: a name the stage does not have cannot
 * be guessed into a file.
 */
function underAssembly(project: ProjectPaths, request: ArtifactRequest): LocatedArtifact | null {
  const track = trackOf(request);
  const episode = episodePaths(project, request.episodeId);

  if (track === null || !episode.ok || request.artifact !== EPISODE_CUT) {
    return null;
  }

  return { contentType: MP4, path: episodeTrackPaths(episode.data, track).episodeVideo };
}

/**
 * Stage 9: the first stage whose artifacts live at **two levels of the tree**.
 *
 * The script and every bought recording are shared between the tracks and
 * therefore carry no track at all: what their bytes depend on, the text, the
 * voice and the speech model, does not differ per production. Only the mix
 * does, because only the mix is timed against a particular cut, so `narrated`
 * is the one id here that needs a track and the one that refuses without one.
 *
 * Getting that backwards would not be a 404; it would be a second copy of a
 * recording nobody bought, or one film's narration served over the other's
 * picture. So the level is read off the id rather than off whatever the
 * caller happened to put in the query.
 */
function underSoundtrack(project: ProjectPaths, request: ArtifactRequest): LocatedArtifact | null {
  const episode = episodePaths(project, request.episodeId);

  if (!episode.ok) {
    return null;
  }

  if (request.artifact === NARRATED) {
    const track = trackOf(request);

    return track === null
      ? null
      : { contentType: MP4, path: episodeTrackPaths(episode.data, track).narratedVideo };
  }

  if (request.artifact === SCRIPT) {
    return { contentType: MARKDOWN, path: episode.data.narrationScript };
  }

  const line = narrationAudio(episode.data, request.artifact);

  return line.ok ? { contentType: WAV, path: line.data } : null;
}

/**
 * Stage 2's images: one character, one track, one of the ten pictures.
 *
 * It is a function rather than a row in the table above because its artifacts
 * are not a fixed list of names: two of them are, and the other eight are view
 * names that the layout module validates as it turns them into files. That
 * check belongs there rather than here, and a second copy of the eight names
 * in this file would be exactly the drift rule 3 exists to prevent.
 */
function underCharacter(project: ProjectPaths, request: ArtifactRequest): LocatedArtifact | null {
  const track = trackOf(request);
  const character = characterPaths(project, request.characterId);

  if (track === null || !character.ok) {
    return null;
  }

  const paths = characterTrackPaths(character.data, track);

  if (request.artifact === "card") {
    return { contentType: PNG, path: paths.card };
  }

  if (request.artifact === "hero") {
    return { contentType: PNG, path: paths.hero };
  }

  const view = characterViewImage(paths, request.artifact);

  return view.ok ? { contentType: PNG, path: view.data } : null;
}

/** The file a tuple names, or nothing at all. There is no third answer. */
export function locateArtifact(
  workspace: Workspace,
  request: ArtifactRequest
): LocatedArtifact | null {
  const project = projectPaths(workspace, request.projectId);

  if (!project.ok) {
    return null;
  }

  if (request.stage === "character") {
    return underCharacter(project.data, request);
  }

  if (request.stage === "references" || request.stage === "opening-frame") {
    return underTrack(project.data, request);
  }

  if (request.stage === "clips") {
    return underClips(project.data, request);
  }

  if (request.stage === "assembly") {
    return underAssembly(project.data, request);
  }

  if (request.stage === "soundtrack") {
    return underSoundtrack(project.data, request);
  }

  const locate = UNDER_EPISODE[request.stage]?.[request.artifact];

  if (locate === undefined) {
    return null;
  }

  const episode = episodePaths(project.data, request.episodeId);

  return episode.ok ? locate(episode.data) : null;
}
