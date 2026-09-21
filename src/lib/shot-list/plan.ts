import { type RecordedFile, readDigest, toWorkspacePath } from "../artifact/index.js";
import { type CastMember, readStage0Inputs, type ShotListSettings } from "../project/index.js";
import { ok, type Result } from "../result.js";
import { checkScreenplay } from "../screenplay/index.js";
import {
  type EpisodePaths,
  episodePaths,
  type ProjectPaths,
  projectPaths,
  type Workspace,
} from "../workspace.js";
import { buildPrompt } from "./prompt.js";

/**
 * Internal to the shot-list module: what stage 3 reads, and whether it may pay.
 *
 * Both halves belong together because both are about inputs. The gate asks
 * whether the screenplay this plan is drawn from has been accepted; the read
 * turns the accepted artifacts into the exact prompt a request would carry.
 * Nothing here touches the network, writes a file, or knows that a call costs
 * money.
 */

export interface Stage3Scope {
  readonly episodeId: string;
  readonly projectId: string;
  readonly workspace: Workspace;
}

/** Where stage 3 writes, and where it reads the screenplay from. */
export interface Stage3Paths {
  readonly episode: EpisodePaths;
  readonly project: ProjectPaths;
}

export interface Stage3Inputs {
  readonly cast: readonly CastMember[];
  /**
   * Why a paid call may not happen yet. Empty means the upstream is in order,
   * the model and the key are the command's own business, not this module's.
   */
  readonly gate: readonly string[];
  /** project.json, project.md, episode.json and screenplay.md, with digests. */
  readonly inputs: readonly RecordedFile[];
  readonly paths: Stage3Paths;
  /** The exact text a paid call would send, or `null` when it cannot be built. */
  readonly prompt: string | null;
  /** `screenplay.md`, verbatim, or `null` when stage 1 has produced none. */
  readonly screenplay: string | null;
  /** `null` until somebody decides `maxClipSeconds`. */
  readonly settings: ShotListSettings | null;
}

function resolvePaths(input: Stage3Scope): Result<Stage3Paths> {
  const project = projectPaths(input.workspace, input.projectId);

  if (!project.ok) {
    return project;
  }

  const episode = episodePaths(project.data, input.episodeId);

  return episode.ok ? ok({ episode: episode.data, project: project.data }) : episode;
}

/**
 * Everything stage 3 consumes, with the digest of each file at the moment it
 * was read.
 *
 * `source.md` is deliberately not among the inputs: stage 3 plans from the
 * screenplay, so the raw episode source is neither read nor sent, and recording
 * a digest for bytes nobody sent would describe a question that was never asked.
 */
export async function readStage3Inputs(input: Stage3Scope): Promise<Result<Stage3Inputs>> {
  const paths = resolvePaths(input);

  if (!paths.ok) {
    return paths;
  }

  const stage0 = await readStage0Inputs(input);

  if (!stage0.ok) {
    return stage0;
  }

  const relative = (path: string): string => toWorkspacePath(input.workspace.root, path);
  const sourcePath = relative(paths.data.episode.source);
  const gate: string[] = [];

  // One gate, and it is the screenplay's approval. It transitively covers the
  // stage-0 artifacts too: they are recorded inputs of stage 1, so an edited
  // `project.md` shows up here as drift rather than needing a rule of its own.
  const upstream = await checkScreenplay(input);

  if (!upstream.ok) {
    return upstream;
  }

  if (!upstream.data.approved) {
    gate.push(...upstream.data.problems);
    gate.push(
      `etap 1 musi mieć review.status = "approved" zanim etap 3 wyda pieniądze: aimator approve ${input.projectId} ${input.episodeId} --stage screenplay`
    );
  }

  const screenplay = await readDigest(paths.data.episode.screenplay);

  if (!screenplay.ok) {
    gate.push(`brakuje ${relative(paths.data.episode.screenplay)}, etap 3 nie ma czego planować`);
  }

  const { maxClipSeconds } = stage0.data.settings;

  if (maxClipSeconds === null) {
    gate.push(
      `odcinek "${input.episodeId}": brak decyzji, maxClipSeconds; ustaw ją przez: aimator episode set ${input.projectId} ${input.episodeId} --max-clip <1-60>`
    );
  }

  const settings: ShotListSettings | null =
    maxClipSeconds === null ? null : { ...stage0.data.settings, maxClipSeconds };
  const text = screenplay.ok ? screenplay.data.bytes.toString("utf8") : null;

  return ok({
    cast: stage0.data.cast,
    gate,
    inputs: [
      ...stage0.data.inputs.filter((entry) => entry.path !== sourcePath),
      ...(screenplay.ok
        ? [
            {
              path: relative(paths.data.episode.screenplay),
              sha256: screenplay.data.sha256,
            },
          ]
        : []),
    ],
    paths: paths.data,
    prompt:
      settings === null || text === null
        ? null
        : buildPrompt({
            aspectRatio: stage0.data.aspectRatio,
            cast: stage0.data.cast,
            rules: stage0.data.rules,
            screenplay: text,
            settings,
          }),
    screenplay: text,
    settings,
  });
}
