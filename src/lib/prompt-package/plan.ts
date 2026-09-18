import { type RecordedFile, readDigest, toWorkspacePath } from "../artifact/index.js";
import { checkCharacter } from "../character/index.js";
import { type CastMember, type EpisodeSettings, readStage0Inputs } from "../project/index.js";
import { ok, type Result } from "../result.js";
import { checkShotList, type ShotList } from "../shot-list/index.js";
import {
  characterPaths,
  characterTrackPaths,
  type EpisodePaths,
  episodePaths,
  type ImageTrack,
  imageTracks,
  type ProjectPaths,
  projectPaths,
  type Workspace,
} from "../workspace.js";
import { buildPrompt } from "./prompt.js";

/**
 * Internal to the prompt-package module: what stage 4 reads, and whether it may
 * pay.
 *
 * Both halves belong together because both are about inputs. The gates ask
 * whether the plan and the faces this package is drawn from have been accepted;
 * the read turns those accepted artifacts into the exact prompt a request would
 * carry. Nothing here touches the network, writes a file, or knows that a call
 * costs money.
 *
 * This is the first stage whose gate reaches into the image side of the
 * pipeline, and the first whose gate is **per track** while its artifact is
 * shared. The package assigns `hero:<id>` to a frame without saying which track
 * will draw it, which is exactly what lets one manifest serve both — and is
 * exactly why both have to be ready. A shared artifact whose gate was satisfied
 * by one track alone would be a plan half the pipeline never earned.
 */

export interface Stage4Scope {
  readonly episodeId: string;
  readonly projectId: string;
  readonly workspace: Workspace;
}

/** Where stage 4 writes, and where it reads the plan from. */
export interface Stage4Paths {
  readonly episode: EpisodePaths;
  readonly project: ProjectPaths;
}

export interface Stage4Inputs {
  readonly cast: readonly CastMember[];
  /**
   * Why a paid call may not happen yet. Empty means the upstream is in order —
   * the model and the key are the command's own business, not this module's.
   */
  readonly gate: readonly string[];
  /** The cast ids this episode needs a canonical image of, in roster order. */
  readonly heroes: readonly string[];
  /** Everything consumed, with the digest of each file at the moment it was read. */
  readonly inputs: readonly RecordedFile[];
  readonly paths: Stage4Paths;
  /** The exact text a paid call would send, or `null` when it cannot be built. */
  readonly prompt: string | null;
  readonly settings: EpisodeSettings;
  /** The approved plan, as `validateShotList` returned it. */
  readonly shotList: ShotList | null;
}

function resolvePaths(input: Stage4Scope): Result<Stage4Paths> {
  const project = projectPaths(input.workspace, input.projectId);

  if (!project.ok) {
    return project;
  }

  const episode = episodePaths(project.data, input.episodeId);

  return episode.ok ? ok({ episode: episode.data, project: project.data }) : episode;
}

/**
 * Whether one character's canonical image is accepted on one track, and where
 * those bytes are.
 *
 * The verdict comes from `lib/character`, through its entry: whether an image
 * is accepted is that module's question, and a second answer here would be a
 * second opinion about the same file. The path comes from `lib/workspace`, the
 * only module allowed to know it.
 */
async function readHero(
  input: Stage4Scope,
  characterId: string,
  track: ImageTrack
): Promise<Result<{ input: RecordedFile | null; problems: readonly string[] }>> {
  const status = await checkCharacter({ ...input, characterId, track });

  if (!status.ok) {
    return status;
  }

  const hero = status.data.artifacts.find((entry) => entry.artifact === "hero");
  const label = `postać "${characterId}" na torze ${track}`;

  if (hero === undefined || !hero.approved) {
    return ok({
      input: null,
      problems: [
        `${label}: hero.png nie jest zatwierdzony (${hero?.state ?? "brak"}) — etap 4 planuje obrazy tej postaci, więc czeka na jej wygląd: aimator check ${input.projectId} ${characterId} --stage character --track ${track}`,
      ],
    });
  }

  const project = projectPaths(input.workspace, input.projectId);

  if (!project.ok) {
    return project;
  }

  const character = characterPaths(project.data, characterId);

  if (!character.ok) {
    return character;
  }

  const path = characterTrackPaths(character.data, track).hero;
  const digest = await readDigest(path);

  return digest.ok
    ? ok({
        input: {
          path: toWorkspacePath(input.workspace.root, path),
          sha256: digest.data.sha256,
        },
        problems: [],
      })
    : ok({ input: null, problems: [`${label}: nie udało się odczytać hero.png`] });
}

/**
 * Everything stage 4 consumes, with the digest of each file at the moment it
 * was read.
 *
 * `source.md` and `screenplay.md` are deliberately absent, for the reason stage
 * 3 gives about the source: the shot list has already adapted them, so stage 4
 * neither reads nor sends either, and a digest for bytes nobody sent would
 * describe a question that was never asked.
 *
 * The canonical images are the exception that proves the rule. Their bytes are
 * **not** sent — they are accepted per track and this package is shared — but
 * they are recorded, because what this stage consumes from them is precisely
 * "these exact bytes carry a human's acceptance". That is the fact the gate
 * turns on, so a hero redrawn afterwards has to show up here as drift and send
 * somebody back to reread the package.
 */
export async function readStage4Inputs(input: Stage4Scope): Promise<Result<Stage4Inputs>> {
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

  // One gate on the text side, and it is the shot list's approval. It covers
  // stages 0 and 1 transitively: their artifacts are recorded inputs further
  // up, so an edited `project.md` arrives here as drift rather than needing a
  // rule of its own.
  const upstream = await checkShotList(input);

  if (!upstream.ok) {
    return upstream;
  }

  if (!upstream.data.approved) {
    gate.push(...upstream.data.problems);
    gate.push(
      `etap 3 musi mieć review.status = "approved" zanim etap 4 wyda pieniądze: aimator approve ${input.projectId} ${input.episodeId} --stage shot-list`
    );
  }

  const shotList = upstream.data.verdict;
  const text = await readDigest(paths.data.episode.shotList);

  if (!text.ok) {
    gate.push(`brakuje ${relative(paths.data.episode.shotList)} — etap 4 nie ma czego planować`);
  }

  const heroes = shotList === null ? [] : shotList.castSeen;
  const recorded: RecordedFile[] = [];

  for (const characterId of heroes) {
    for (const track of imageTracks) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered, and the order is the input list
      const hero = await readHero(input, characterId, track);

      if (!hero.ok) {
        return hero;
      }

      gate.push(...hero.data.problems);

      if (hero.data.input !== null) {
        recorded.push(hero.data.input);
      }
    }
  }

  const shotListText = text.ok ? text.data.bytes.toString("utf8") : null;

  return ok({
    cast: stage0.data.cast,
    gate,
    heroes,
    inputs: [
      ...stage0.data.inputs.filter((entry) => entry.path !== sourcePath),
      ...(text.ok
        ? [{ path: relative(paths.data.episode.shotList), sha256: text.data.sha256 }]
        : []),
      ...recorded,
    ],
    paths: paths.data,
    prompt:
      shotListText === null
        ? null
        : buildPrompt({
            aspectRatio: stage0.data.aspectRatio,
            cast: stage0.data.cast,
            heroes,
            rules: stage0.data.rules,
            settings: stage0.data.settings,
            shotList: shotListText,
          }),
    settings: stage0.data.settings,
    shotList,
  });
}
