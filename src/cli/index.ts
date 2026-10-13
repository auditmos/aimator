import { err, ok, type Result } from "../lib/result.js";
import { runApprove } from "./approve.js";
import { runCheck } from "./check.js";
import { UsageError } from "./common.js";
import { runList } from "./list.js";
import { runReject } from "./reject.js";
import { runAssembly } from "./stages/assembly.js";
import { runCharacter } from "./stages/character.js";
import { runClip } from "./stages/clips.js";
import { runDialogue } from "./stages/dialogue.js";
import { runEpisode } from "./stages/episode.js";
import { runNarration } from "./stages/narration.js";
import { runOpeningFrame } from "./stages/opening-frame.js";
import { runProject } from "./stages/project.js";
import { runPromptPackage } from "./stages/prompt-package.js";
import { runReference } from "./stages/references.js";
import { runScreenplay } from "./stages/screenplay.js";
import { runShotList } from "./stages/shot-list.js";
import { runSoundDesign } from "./stages/sound-design.js";
import { runStyle } from "./stages/style.js";
import { runStatus } from "./status.js";
import { USAGE } from "./usage.js";

/**
 * Every command, by its first word. A table rather than a chain of `if`s, for
 * the reason `check.ts` gives: what the dispatcher knows is which commands
 * exist, and a list of them is a list, not control flow.
 */
const COMMANDS: Readonly<Record<string, (argv: readonly string[]) => Promise<Result<string>>>> = {
  approve: runApprove,
  assembly: runAssembly,
  character: runCharacter,
  check: runCheck,
  clip: runClip,
  dialogue: runDialogue,
  episode: runEpisode,
  list: runList,
  narration: runNarration,
  "opening-frame": runOpeningFrame,
  project: runProject,
  "prompt-package": runPromptPackage,
  reference: runReference,
  reject: runReject,
  screenplay: runScreenplay,
  "shot-list": runShotList,
  "sound-design": runSoundDesign,
  status: runStatus,
  style: runStyle,
};

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

  // `Object.hasOwn`, so a word such as `constructor` is an unknown command
  // rather than a property every object inherits.
  const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;

  return handler === undefined
    ? err(new UsageError(`unknown command: ${command}`))
    : await handler(rest);
}
