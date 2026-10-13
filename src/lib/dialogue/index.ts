/**
 * Stage 11, dialogue. The lines the characters speak, in the film's language.
 *
 * It consumes the approved `shot-list.md` and the stage-0 decisions every stage
 * reads, and produces `dialogue.md` under the episode, shared by both tracks,
 * with a `dialogue.stage.json` whose `script` record says what went in and who
 * accepted it. Once the script is accepted it buys each line, one speech call
 * apiece, into `dialogue/<language>/Dnn.wav`, in its speaker's voice, and each
 * line gets a record of its own beside the script's.
 *
 * **A line is lifted, never invented, and none is left behind.** Stage 9 can
 * prove only the first half, because a narrator's sentence sits in prose.
 * Stage 3 writes a character's line as `<cast-id>: "<line>"`, so this script is
 * checked both ways: each of its lines is one the plan attributes to that
 * character in that shot, and each attributed line is in it exactly once.
 *
 * A speaker heard from outside the shot's `Cast` is reported, not refused: the
 * line is real, there is just no face for lip-sync to move.
 */

export { type DialogueReport, generateDialogue } from "./generate.js";
export {
  approveDialogue,
  checkDialogue,
  type DialogueStatus,
  readAcceptedDialogue,
} from "./review.js";
