import { type EpisodePaths, episodePaths, projectPaths, type Workspace } from "../lib/workspace.js";

/**
 * Where an identifier becomes a path, and the only place that is allowed to.
 *
 * The client names an artifact by what it is: the project, the episode, the
 * stage that wrote it and the stage's own word for it. It never names a file,
 * a directory or a track directory, for the reason rule 3 exists at all: the
 * layout is one module's knowledge, and a browser that learned a second copy
 * of it would drift from the tree the moment a stage moved a file.
 *
 * The refusal is the interesting half. A tuple this table does not know is a
 * 404 **before any path is built**, so an identifier carrying `..`, an absolute
 * path or somebody else's project cannot walk out of the workspace: the layout
 * module rejects the id, this table rejects the name, and neither asks the
 * filesystem what it thinks. A resolver that read first and validated after
 * would be one typo away from serving `/etc/passwd` over the loopback address.
 */

interface LocatedArtifact {
  readonly contentType: string;
  readonly path: string;
}

/** What each stage publishes, in the stage's own word for it. */
const ARTIFACTS: Readonly<
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
    screenplay: (episode) => ({
      contentType: "text/markdown; charset=utf-8",
      path: episode.screenplay,
    }),
  },
  "shot-list": {
    "shot-list": (episode) => ({
      contentType: "text/markdown; charset=utf-8",
      path: episode.shotList,
    }),
  },
};

interface ArtifactRequest {
  readonly artifact: string;
  readonly episodeId: string;
  readonly projectId: string;
  readonly stage: string;
}

/** The file a tuple names, or nothing at all. There is no third answer. */
export function locateArtifact(
  workspace: Workspace,
  request: ArtifactRequest
): LocatedArtifact | null {
  const locate = ARTIFACTS[request.stage]?.[request.artifact];

  if (locate === undefined) {
    return null;
  }

  const project = projectPaths(workspace, request.projectId);

  if (!project.ok) {
    return null;
  }

  const episode = episodePaths(project.data, request.episodeId);

  return episode.ok ? locate(episode.data) : null;
}
