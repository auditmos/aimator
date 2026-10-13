import { type Check, type Checklist, FILM_CHECKS, FRAME_CHECKS } from "../lib/checklist.js";
import { err, ok, type Result } from "../lib/result.js";
import {
  type Approval,
  answerOf,
  checksOf,
  modeOf,
  type Parsed,
  parse,
  requirePositional,
  reviewerOf,
  UsageError,
  workspaceOf,
} from "./common.js";
import { approveAssemblyStage } from "./stages/assembly.js";
import { approveCharacterStage, approveVoiceStage } from "./stages/character.js";
import { approveClipsStage } from "./stages/clips.js";
import { approveDialogueStage } from "./stages/dialogue.js";
import { approveSoundtrackStage } from "./stages/narration.js";
import { approveOpeningFrameStage } from "./stages/opening-frame.js";
import { approvePrepareStage } from "./stages/project.js";
import { approvePromptPackageStage } from "./stages/prompt-package.js";
import { approveReferencesStage } from "./stages/references.js";
import { approveScreenplayStage } from "./stages/screenplay.js";
import { approveShotListStage } from "./stages/shot-list.js";
import { approveSoundDesignStage } from "./stages/sound-design.js";
import { approveStyleStage } from "./stages/style.js";
import { approveVersionsStage } from "./stages/versions.js";

/** Every acceptance this tool records, in the words the usage text promises. */
export const USAGE = `  approve <id> [<episode-id>] [--stage prepare|screenplay|shot-list|prompt-package]
               [--note <uzasadnienie>] [--reviewer <kto>] [--json]
  approve <id> <character-id> --stage character --track <tor> [--json]
               --artifact <klucz>[,<klucz>...]
  approve <id> --stage style --track <tor> --artifact S01[,S02] [--json]
  approve <id> <character-id> --stage voice --language <kod> [--json]
  approve <id> <episode-id> --stage references --track <tor> --artifact R01[,R02]
               [--json]
  approve <id> <episode-id> --stage opening-frame --track <tor> --checks <kryteria>|all
               [--json]
  approve <id> <episode-id> --stage clips --track <tor> --artifact C01[,entry:C02]
               [--checks <kryteria>|all] [--json]
  approve <id> <episode-id> --stage assembly --track <tor> [--json]
  approve <id> <episode-id> --stage soundtrack --artifact script|N01[,N02] [--json]
  approve <id> <episode-id> --stage soundtrack --track <tor> [--json]
  approve <id> <episode-id> --stage sound-design --artifact cues|M01[,E02] [--json]
  approve <id> <episode-id> --stage sound-design --track <tor> [--json]
  approve <id> <episode-id> --stage dialogue --artifact script|script-<kod>|D01[,<kod>:D01]
               [--json]
  approve <id> <episode-id> --stage versions --track <tor> --artifact C01[,C02]|<kod>
               [--checks <kryteria>|all] [--json]`;

/**
 * The stages accepted against a QC checklist, and whose: the frames a clip
 * starts on are walked through as frames, stage 12's film whose mouths moved
 * as a film.
 */
const CHECKLISTS: Readonly<Record<string, readonly Check[]>> = {
  clips: FRAME_CHECKS,
  "opening-frame": FRAME_CHECKS,
  versions: FILM_CHECKS,
};

/**
 * `--checks`, refused on a stage that has no checklist. It belongs to the
 * frames a clip starts on and to the film whose mouths moved; anywhere else it
 * would be recorded nowhere, and a flag that silently does nothing reads as a
 * check somebody did.
 */
function checksFor(parsed: Parsed): Result<Checklist | null> {
  const { checks, stage } = parsed.values;
  const vocabulary =
    typeof stage === "string" && Object.hasOwn(CHECKLISTS, stage) ? CHECKLISTS[stage] : undefined;

  if (vocabulary !== undefined) {
    return checksOf(parsed, vocabulary);
  }

  return checks === undefined
    ? ok(null)
    : err(
        new UsageError(
          `--checks dotyczy tylko klatek gotowych do animacji i filmu wersji: --stage ${Object.keys(CHECKLISTS).join(" albo --stage ")}`
        )
      );
}

/**
 * Every stage below stage 0, by the word `--stage` takes. A table for the
 * reason `check.ts` keeps one: which stages exist is a list, not control flow.
 */
const STAGES: Readonly<
  Record<string, (parsed: Parsed, approval: Approval) => Promise<Result<string>>>
> = {
  assembly: approveAssemblyStage,
  character: approveCharacterStage,
  clips: approveClipsStage,
  dialogue: approveDialogueStage,
  "opening-frame": approveOpeningFrameStage,
  "prompt-package": approvePromptPackageStage,
  references: approveReferencesStage,
  screenplay: approveScreenplayStage,
  "shot-list": approveShotListStage,
  "sound-design": approveSoundDesignStage,
  soundtrack: approveSoundtrackStage,
  style: approveStyleStage,
  versions: approveVersionsStage,
  voice: approveVoiceStage,
};

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
    checks: { type: "string" },
    json: { type: "boolean" },
    language: { type: "string" },
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
  // Stage 0 is what `approve` with no `--stage` accepts, so it is also what the
  // flag prints: the usage text puts the flag in brackets, and brackets are a
  // promise about the command rather than about how it answers.
  const answer = answerOf(parsed.data, "prepare");
  const checks = checksFor(parsed.data);

  if (!projectId.ok) {
    return projectId;
  }
  if (!workspace.ok) {
    return workspace;
  }
  if (!checks.ok) {
    return checks;
  }
  if (!answer.ok) {
    return answer;
  }

  const { note, stage } = parsed.data.values;
  const approval = {
    answer: answer.data,
    checks: checks.data,
    mode: modeOf(parsed.data),
    note: typeof note === "string" ? note : null,
    projectId: projectId.data,
    reviewer: reviewerOf(parsed.data),
    workspace: workspace.data,
  };

  if (stage === undefined || stage === "prepare") {
    return await approvePrepareStage(approval);
  }

  const accept =
    typeof stage === "string" && Object.hasOwn(STAGES, stage) ? STAGES[stage] : undefined;

  if (accept !== undefined) {
    return await accept(parsed.data, approval);
  }

  return err(
    new UsageError(
      `--stage "${String(stage)}", dozwolone: prepare, screenplay, character, style, shot-list, prompt-package, references, opening-frame, clips, assembly, soundtrack, sound-design, dialogue, versions, voice`
    )
  );
}
