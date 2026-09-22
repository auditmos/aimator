import { ok, type Result } from "../lib/result.js";
import type { Workspace } from "../lib/workspace.js";
import {
  type Answer,
  answerOf,
  type EpisodeScope,
  type Parsed,
  parse,
  requirePositional,
  workspaceOf,
} from "./common.js";
import { checkAssemblyStage } from "./stages/assembly.js";
import { checkCharacterStage } from "./stages/character.js";
import { checkClipsStage } from "./stages/clips.js";
import { checkSoundtrackStage } from "./stages/narration.js";
import { checkOpeningFrameStage } from "./stages/opening-frame.js";
import { checkPrepareStage } from "./stages/project.js";
import { checkPromptPackageStage } from "./stages/prompt-package.js";
import { checkReferencesStage } from "./stages/references.js";
import { checkScreenplayStage } from "./stages/screenplay.js";
import { checkShotListStage } from "./stages/shot-list.js";
import { checkSoundDesignStage } from "./stages/sound-design.js";

/** Every question `check` answers, in the words the usage text promises. */
export const USAGE = `  check <id> [<episode-id>]
  check <id> --stage prepare [--json]
  check <id> <episode-id> --stage screenplay [--json]
  check <id> <episode-id> --stage shot-list [--json]
  check <id> <episode-id> --stage prompt-package [--json]
  check <id> <character-id> --stage character --track <tor> [--json]
  check <id> <episode-id> --stage references --track <tor> [--json]
  check <id> <episode-id> --stage opening-frame --track <tor> [--json]
  check <id> <episode-id> --stage clips --track <tor> [--json]
  check <id> <episode-id> --stage assembly --track <tor>
  check <id> <episode-id> --stage soundtrack [--track <tor>]
  check <id> <episode-id> --stage sound-design [--track <tor>]`;

/**
 * The text stages, whose whole question is an episode and how to print it.
 *
 * A table rather than a chain of `if`s, and the reason is the one this CLI
 * keeps meeting: what the dispatcher knows is **which stages exist**, and a
 * list of them is a list, not control flow. Stage 0 is not here because its
 * scope is a project rather than an episode, which is the whole difference
 * between it and the three below.
 */
const NARROW: Readonly<
  Record<string, (scope: EpisodeScope, answer: Answer) => Promise<Result<string>>>
> = {
  "prompt-package": checkPromptPackageStage,
  screenplay: checkScreenplayStage,
  "shot-list": checkShotListStage,
};

/**
 * The stages whose question carries more than an episode: a track, a
 * character, or both. They read the parsed argv themselves, because which
 * flags narrow them is each stage's own answer and not this file's.
 */
const WIDE: Readonly<
  Record<
    string,
    (
      parsed: Parsed,
      projectId: string,
      workspace: Workspace,
      answer: Answer
    ) => Promise<Result<string>>
  >
> = {
  assembly: checkAssemblyStage,
  character: checkCharacterStage,
  clips: checkClipsStage,
  "opening-frame": checkOpeningFrameStage,
  references: checkReferencesStage,
  "sound-design": checkSoundDesignStage,
  soundtrack: checkSoundtrackStage,
};

/**
 * The episode's whole text side: stage 0, then the three an episode carries.
 *
 * Four verdicts glued into one string, which reads well for a person at a
 * terminal and cannot be read back apart, which is exactly why every one of
 * them can also be asked for by name.
 */
async function checkTextSide(stage0: string, scope: EpisodeScope): Promise<Result<string>> {
  const lines = [stage0];

  for (const read of [checkScreenplayStage, checkShotListStage, checkPromptPackageStage]) {
    // biome-ignore lint/performance/noAwaitInLoops: the ladder is read in order
    const result = await read(scope, "text");

    if (!result.ok) {
      return result;
    }

    lines.push(result.data);
  }

  return ok(lines.join("\n"));
}

/**
 * Verification, and never acceptance.
 *
 * The command writes nothing: drift is reported, never recorded, which is why
 * a passing check is not a human saying yes. `--stage` chooses which stage is
 * being asked; without it the question is the episode's text side, stage 0
 * first and then the three stages an episode carries.
 */
export async function runCheck(argv: readonly string[]): Promise<Result<string>> {
  const parsed = parse(argv, {
    json: { type: "boolean" },
    stage: { type: "string" },
    track: { type: "string" },
  });

  if (!parsed.ok) {
    return parsed;
  }

  const projectId = requirePositional(parsed.data, 0, "project-id");
  const workspace = workspaceOf(parsed.data);
  const answer = answerOf(parsed.data);

  if (!projectId.ok) {
    return projectId;
  }
  if (!workspace.ok) {
    return workspace;
  }
  if (!answer.ok) {
    return answer;
  }

  const { stage } = parsed.data.values;
  const named = typeof stage === "string" ? stage : "";

  // Naming stage 0 narrows the question to it, and it narrows even when an
  // episode is named as well: an id in the argv says which episode, never
  // which stage.
  if (named === "prepare") {
    return await checkPrepareStage(projectId.data, workspace.data, answer.data);
  }

  const narrow = NARROW[named];

  if (narrow !== undefined) {
    const episodeId = requirePositional(parsed.data, 1, "episode-id");

    return episodeId.ok
      ? await narrow(
          {
            episodeId: episodeId.data,
            projectId: projectId.data,
            workspace: workspace.data,
          },
          answer.data
        )
      : episodeId;
  }

  const wide = WIDE[named];

  if (wide !== undefined) {
    return await wide(parsed.data, projectId.data, workspace.data, answer.data);
  }

  const stage0 = await checkPrepareStage(projectId.data, workspace.data, "text");
  const [, episodeId] = parsed.data.positionals;

  if (!stage0.ok || episodeId === undefined) {
    return stage0;
  }

  return await checkTextSide(stage0.data, {
    episodeId,
    projectId: projectId.data,
    workspace: workspace.data,
  });
}
