/**
 * Stage 9, the soundtrack. The first stage that buys from two providers, and
 * the first whose artifacts live at two levels of the tree.
 *
 * It consumes the approved `screenplay.md` and `shot-list.md`, the stage-0
 * decisions every stage reads, the narrator's voice from `project.json`, and,
 * for the mix alone, this track's approved `episode.mp4`. It produces a
 * `narration.md` and one bought `narration/Nnn.wav` per utterance, shared
 * between the tracks, and a `<track>/narrated.mp4` per track.
 *
 * Five things are worth knowing before reading further.
 *
 * **The narration is lifted, not written.** Stage 1's prompt asks for the
 * narrator's words in the film's language whenever the episode's sound mode
 * permits speech, and stage 3 carries them into each shot's `Audio` prose. So
 * the sentences already exist; what does not exist is a machine-readable form
 * of them. A model does the lifting, because reading prose is what a model is
 * for, and the validator proves the lift was a lift by finding every sentence
 * inside the shot it names. Rule 7 is satisfied rather than bent: every
 * decision this script is drawn from is already stored, and what the model adds
 * (an id per utterance and the second it is anchored at) is exactly the part
 * no approved artifact holds.
 *
 * **The words are shared; only the mix is per track.** A voice reading a
 * sentence has no idea which of the two films it will sit over, so buying it
 * twice would be paying for a directory. What differs per track is when each
 * line lands, because the clips came back with their own drift, and that is
 * stage 4's precedent read exactly: one artifact, two productions, resolved at
 * the sender. `hero:ewa` becomes a file per track; `N02 at 7s of the plan`
 * becomes a timecode per track.
 *
 * **Bytes are published as they came; placement is refused rather than nudged.**
 * A voice provider hands back however long saying the sentence took, and those
 * are bytes somebody paid for, so no stretching, no faster reading, no
 * shortened pause, for the reason stage 8 cuts what came back and stage 2 will
 * not strip a background. But where a line *sits* comes from a plan a human
 * approved, so a line that would talk over the next one, or run past the end of
 * the film, is a refusal that names the remedy, the way stage 7 refuses a
 * duration no model renders rather than rounding it.
 *
 * **It cannot fulfil `audio: narration` and says so.** All four sound modes
 * include music and effects. No model here writes either, no variable names one
 * and no command brings one in, so inventing any of that would be answering a
 * question nobody asked. They are absent, and the absence is reported exactly
 * as stage 8 reports silence and stage 2 reports a missing alpha channel. The
 * row below this one is declared, not half-built.
 *
 * **`episode.mp4` is never touched.** The narrated cut is a new file whose
 * picture is a stream copy of the approved one, so the yes a human gave the
 * assembly stays exactly where it was.
 */

export { type DirectionReport, readDirection, setDirection } from "./delivery.js";
export { generateNarration, type NarrationReport } from "./generate.js";
export { generateMix, type MixReport } from "./mix.js";
export { readAcceptedLines } from "./plan.js";
export {
  approveMix,
  approveNarration,
  checkMix,
  checkNarration,
  type MixStatus,
  type NarrationStatus,
} from "./review.js";
export { validateNarration } from "./validate.js";
