import {
  emptyStage,
  type RecordedFile,
  readDigest,
  readJson,
  type StageFile,
  stageFileSchema,
  toWorkspacePath,
} from "../artifact/index.js";
import { type CastMember, readStage0Inputs } from "../project/index.js";
import { ok, type Result } from "../result.js";
import { checkShotList, type ShotList } from "../shot-list/index.js";
import { type EpisodePaths, episodePaths, projectPaths, type Workspace } from "../workspace.js";
import { buildPrompt } from "./prompt.js";

/**
 * Internal to the dialogue module: what stage 11 reads, and whether it may pay.
 *
 * One gate for the script, and it has two halves. The plan has to be accepted,
 * because every line comes out of it; and the episode has to be one in which
 * characters speak, because buying a dialogue script for a film without
 * dialogue would be paying to be told there is nothing to lift.
 *
 * The voices are not here. They gate buying a line, not reading which lines
 * exist, the same split stage 9 makes between its script and its recordings.
 */

/** The one stage name this module writes and reads. */
export const STAGE = "dialogue";

/** The artifact key of the script, beside which the bought lines will sit. */
export const SCRIPT = "script";

export interface Stage11Scope {
  readonly episodeId: string;
  readonly projectId: string;
  readonly workspace: Workspace;
}

export class Stage11BlockedError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`etap 11 nie może tego zrobić:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "Stage11BlockedError";
    this.problems = problems;
  }
}

export interface Stage11Inputs {
  /** The roster's ids, which name who may speak. */
  readonly cast: readonly CastMember[];
  readonly episode: EpisodePaths;
  /** Why the script may not be bought yet. Empty means it may. */
  readonly gate: readonly string[];
  /** project.json, project.md, episode.json and shot-list.md, with digests. */
  readonly inputs: readonly RecordedFile[];
  /** The approved plan as data, or null while it does not validate. */
  readonly plan: ShotList | null;
  /** The exact text a paid call would send, or `null` when it cannot be built. */
  readonly prompt: string | null;
  readonly stage: StageFile;
}

/**
 * Everything stage 11's script consumes, with the digest of each file as it was
 * read. `source.md` is left out for stage 3's reason: nothing here sends it.
 */
export async function readStage11Inputs(input: Stage11Scope): Promise<Result<Stage11Inputs>> {
  const project = projectPaths(input.workspace, input.projectId);

  if (!project.ok) {
    return project;
  }

  const episode = episodePaths(project.data, input.episodeId);

  if (!episode.ok) {
    return episode;
  }

  const stage0 = await readStage0Inputs(input);

  if (!stage0.ok) {
    return stage0;
  }

  const relative = (path: string): string => toWorkspacePath(input.workspace.root, path);
  const gate: string[] = [];
  const { audio } = stage0.data.settings;

  if (audio !== "dialogue" && audio !== "dialogue-and-narration") {
    gate.push(
      `odcinek deklaruje audio: ${audio}, ten odcinek nie ma dialogu, etap 11 nie ma czego podnosić`
    );
  }

  // One gate covers stages 0 and 1 arithmetically, as stage 9's does: they are
  // recorded inputs of the shot list, so editing one revokes its approval.
  const upstream = await checkShotList(input);

  if (!upstream.ok) {
    return upstream;
  }

  if (!upstream.data.approved) {
    gate.push(...upstream.data.problems);
    gate.push(
      `etap 3 musi mieć review.status = "approved" zanim etap 11 wyda pieniądze: aimator approve ${input.projectId} ${input.episodeId} --stage shot-list`
    );
  }

  const plan = upstream.data.verdict;

  // A plan accepted before stage 3 wrote lines with their speaker carries none,
  // and a script lifted from it would be bought to say exactly that.
  if (plan !== null && gate.length === 0 && plan.shots.every((shot) => shot.lines.length === 0)) {
    gate.push(
      `lista ujęć nie przypisuje żadnej kwestii postaci, zapis <id>: "…" dostaje przy: aimator shot-list generate ${input.projectId} ${input.episodeId} --regenerate`
    );
  }

  const shotList = await readDigest(episode.data.shotList);

  if (!shotList.ok) {
    gate.push(`brakuje ${relative(episode.data.shotList)}, etap 11 nie ma z czego podnosić`);
  }

  const stage = await readJson(episode.data.dialogueStage, stageFileSchema);
  const sourcePath = relative(episode.data.source);

  return ok({
    cast: stage0.data.cast,
    episode: episode.data,
    gate,
    inputs: [
      ...stage0.data.inputs.filter((entry) => entry.path !== sourcePath),
      ...(shotList.ok
        ? [{ path: relative(episode.data.shotList), sha256: shotList.data.sha256 }]
        : []),
    ],
    plan,
    prompt: shotList.ok
      ? buildPrompt({
          cast: stage0.data.cast,
          rules: stage0.data.rules,
          settings: stage0.data.settings,
          shotList: shotList.data.bytes.toString("utf8"),
        })
      : null,
    stage: stage.ok ? stage.data : emptyStage(STAGE),
  });
}
