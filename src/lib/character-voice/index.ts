/**
 * A character's voice, per language: the choice, a sample bought to hear it,
 * and the approval of that sample.
 *
 * Not a numbered row of the pipeline: it sits beside stage 0, whose casting it
 * completes. The narrator is cast in `project.json`; a character's voice is
 * not, because that file is a recorded input of nearly every artifact, and a
 * voice changed there would lapse rendered clips whose bytes it never touched.
 * So each language of each character is its own file, `voice.json`, and the
 * sample bought to hear it records that file alone as its input.
 *
 * The invariants this interface protects: choosing a voice costs nothing and
 * never defaults, the sample's bill is said in calls and in characters before
 * any is sent, nothing retries by itself, and an approval is bound to the
 * sample's digest and to the voice it was read in, so choosing another voice
 * lapses it and nothing else.
 */

export { generateSample, type SampleReport } from "./generate.js";
export { setVoice, type VoiceDecision } from "./plan.js";
export {
  approveVoice,
  type CastVoice,
  checkVoice,
  type VoiceStatus,
  voicesOf,
} from "./review.js";
