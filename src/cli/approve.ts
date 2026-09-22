import { err, type Result } from "../lib/result.js";
import {
  answerOf,
  modeOf,
  parse,
  requirePositional,
  reviewerOf,
  UsageError,
  workspaceOf,
} from "./common.js";
import { approveAssemblyStage } from "./stages/assembly.js";
import { approveCharacterStage } from "./stages/character.js";
import { approveClipsStage } from "./stages/clips.js";
import { approveSoundtrackStage } from "./stages/narration.js";
import { approveOpeningFrameStage } from "./stages/opening-frame.js";
import { approvePrepareStage } from "./stages/project.js";
import { approvePromptPackageStage } from "./stages/prompt-package.js";
import { approveReferencesStage } from "./stages/references.js";
import { approveScreenplayStage } from "./stages/screenplay.js";
import { approveShotListStage } from "./stages/shot-list.js";
import { approveSoundDesignStage } from "./stages/sound-design.js";

/** Every acceptance this tool records, in the words the usage text promises. */
export const USAGE = `  approve <id> [<episode-id>] [--stage prepare|screenplay|shot-list|prompt-package]
               [--note <uzasadnienie>] [--reviewer <kto>] [--json]
  approve <id> <character-id> --stage character --track <tor> [--json]
               --artifact <klucz>[,<klucz>...]
  approve <id> <episode-id> --stage references --track <tor> --artifact R01[,R02]
  approve <id> <episode-id> --stage opening-frame --track <tor>
  approve <id> <episode-id> --stage clips --track <tor> --artifact C01[,entry:C02]
  approve <id> <episode-id> --stage assembly --track <tor>
  approve <id> <episode-id> --stage soundtrack --artifact script|N01[,N02]
  approve <id> <episode-id> --stage soundtrack --track <tor>
  approve <id> <episode-id> --stage sound-design --artifact cues|M01[,E02]
  approve <id> <episode-id> --stage sound-design --track <tor>`;

/**
 * Acceptance, and only over artifacts that already validate.
 *
 * Validation is not approval: a check verifies and writes nothing, while this
 * records a human saying yes, bound to the digests the artifact carries now.
 * `--stage` says which stage is being accepted, and defaults to stage 0.
 */
export async function runApprove(argv: readonly string[]): Promise<Result<string>> {
  // `--stage character` narrows acceptance to one track and to named images,
  // so both flags belong to every approve call rather than to a separate
  // command. Declared here because a reader that is never parsed is a flag the
  // usage promises and the parser rejects.
  const parsed = parse(argv, {
    artifact: { type: "string" },
    json: { type: "boolean" },
    note: { type: "string" },
    reviewer: { type: "string" },
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

  const { note, stage } = parsed.data.values;
  const approval = {
    answer: answer.data,
    mode: modeOf(parsed.data),
    note: typeof note === "string" ? note : null,
    projectId: projectId.data,
    reviewer: reviewerOf(parsed.data),
    workspace: workspace.data,
  };

  if (stage === undefined || stage === "prepare") {
    return await approvePrepareStage(approval);
  }

  if (stage === "character") {
    return await approveCharacterStage(parsed.data, approval);
  }

  if (stage === "references") {
    return await approveReferencesStage(parsed.data, approval);
  }

  if (stage === "opening-frame") {
    return await approveOpeningFrameStage(parsed.data, approval);
  }

  if (stage === "clips") {
    return await approveClipsStage(parsed.data, approval);
  }

  if (stage === "assembly") {
    return await approveAssemblyStage(parsed.data, approval);
  }

  if (stage === "soundtrack") {
    return await approveSoundtrackStage(parsed.data, approval);
  }

  if (stage === "sound-design") {
    return await approveSoundDesignStage(parsed.data, approval);
  }

  if (stage === "screenplay") {
    return await approveScreenplayStage(parsed.data, approval);
  }

  if (stage === "shot-list") {
    return await approveShotListStage(parsed.data, approval);
  }

  if (stage === "prompt-package") {
    return await approvePromptPackageStage(parsed.data, approval);
  }

  return err(
    new UsageError(
      `--stage "${String(stage)}", dozwolone: prepare, screenplay, character, shot-list, prompt-package, references, opening-frame, clips, assembly, soundtrack, sound-design`
    )
  );
}
