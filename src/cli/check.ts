import { ok, type Result } from "../lib/result.js";
import { answerOf, parse, requirePositional, workspaceOf } from "./common.js";
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
  check <id> <episode-id> --stage screenplay [--json]
  check <id> <character-id> --stage character --track <tor>
  check <id> <episode-id> --stage references --track <tor>
  check <id> <episode-id> --stage opening-frame --track <tor>
  check <id> <episode-id> --stage clips --track <tor>
  check <id> <episode-id> --stage assembly --track <tor>
  check <id> <episode-id> --stage soundtrack [--track <tor>]
  check <id> <episode-id> --stage sound-design [--track <tor>]`;

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

  // Naming stage 1 narrows the question to it. The wide check answers four
  // stages in one string, which reads well and cannot be read back apart, so
  // anything that wants stage 1's verdict alone has to be able to ask for it.
  if (parsed.data.values.stage === "screenplay") {
    const episodeId = requirePositional(parsed.data, 1, "episode-id");

    if (!episodeId.ok) {
      return episodeId;
    }

    return await checkScreenplayStage(
      {
        episodeId: episodeId.data,
        projectId: projectId.data,
        workspace: workspace.data,
      },
      answer.data
    );
  }

  if (parsed.data.values.stage === "character") {
    return await checkCharacterStage(parsed.data, projectId.data, workspace.data);
  }

  if (parsed.data.values.stage === "references") {
    return await checkReferencesStage(parsed.data, projectId.data, workspace.data);
  }

  if (parsed.data.values.stage === "opening-frame") {
    return await checkOpeningFrameStage(parsed.data, projectId.data, workspace.data);
  }

  if (parsed.data.values.stage === "clips") {
    return await checkClipsStage(parsed.data, projectId.data, workspace.data);
  }

  if (parsed.data.values.stage === "assembly") {
    return await checkAssemblyStage(parsed.data, projectId.data, workspace.data);
  }

  if (parsed.data.values.stage === "soundtrack") {
    return await checkSoundtrackStage(parsed.data, projectId.data, workspace.data);
  }

  if (parsed.data.values.stage === "sound-design") {
    return await checkSoundDesignStage(parsed.data, projectId.data, workspace.data);
  }

  const stage0 = await checkPrepareStage(projectId.data, workspace.data);

  if (!stage0.ok) {
    return stage0;
  }

  const [, episodeId] = parsed.data.positionals;

  if (episodeId === undefined) {
    return stage0;
  }

  // Naming an episode widens the check to its text stages. Nothing is written,
  // a check reports drift, it never records it.
  const scope = { episodeId, projectId: projectId.data, workspace: workspace.data };
  const stage1 = await checkScreenplayStage(scope, "text");

  if (!stage1.ok) {
    return stage1;
  }

  const lines = [stage0.data, stage1.data];
  const stage3 = await checkShotListStage(scope);

  if (!stage3.ok) {
    return stage3;
  }

  lines.push(stage3.data);

  const stage4 = await checkPromptPackageStage(scope);

  if (!stage4.ok) {
    return stage4;
  }

  lines.push(stage4.data);

  return ok(lines.join("\n"));
}
