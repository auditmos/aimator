import {
  characterPaths,
  characterTrackPaths,
  characterViewImage,
  type EpisodePaths,
  episodePaths,
  episodeTrackPaths,
  type ImageTrack,
  imageTracks,
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

interface LocatedArtifact {
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

  const locate = UNDER_EPISODE[request.stage]?.[request.artifact];

  if (locate === undefined) {
    return null;
  }

  const episode = episodePaths(project.data, request.episodeId);

  return episode.ok ? locate(episode.data) : null;
}
