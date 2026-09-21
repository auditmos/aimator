import { err, ok, type Result } from "../lib/result.js";
import { runApprove } from "./approve.js";
import { runCheck } from "./check.js";
import { UsageError } from "./common.js";
import { runAssembly } from "./stages/assembly.js";
import { runCharacter } from "./stages/character.js";
import { runClip } from "./stages/clips.js";
import { runEpisode } from "./stages/episode.js";
import { runNarration } from "./stages/narration.js";
import { runOpeningFrame } from "./stages/opening-frame.js";
import { runProject } from "./stages/project.js";
import { runPromptPackage } from "./stages/prompt-package.js";
import { runReference } from "./stages/references.js";
import { runScreenplay } from "./stages/screenplay.js";
import { runShotList } from "./stages/shot-list.js";
import { runSoundDesign } from "./stages/sound-design.js";
import { USAGE } from "./usage.js";

/**
 * argv in, outcome out. Filesystem effects live in lib/project; streams and
 * exit codes live in bin.ts, which is what keeps this testable by calling a
 * function instead of spawning a process.
 */
export async function run(argv: string[]): Promise<Result<string>> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help") {
    return ok(USAGE);
  }

  if (command === "project") {
    return await runProject(rest);
  }

  if (command === "character") {
    return await runCharacter(rest);
  }

  if (command === "episode") {
    return await runEpisode(rest);
  }

  if (command === "screenplay") {
    return await runScreenplay(rest);
  }

  if (command === "shot-list") {
    return await runShotList(rest);
  }

  if (command === "prompt-package") {
    return await runPromptPackage(rest);
  }

  if (command === "reference") {
    return await runReference(rest);
  }

  if (command === "opening-frame") {
    return await runOpeningFrame(rest);
  }

  if (command === "clip") {
    return await runClip(rest);
  }

  if (command === "assembly") {
    return await runAssembly(rest);
  }

  if (command === "narration") {
    return await runNarration(rest);
  }

  if (command === "sound-design") {
    return await runSoundDesign(rest);
  }

  if (command === "check") {
    return await runCheck(rest);
  }

  if (command === "approve") {
    return await runApprove(rest);
  }

  return err(new UsageError(`unknown command: ${command}`));
}
