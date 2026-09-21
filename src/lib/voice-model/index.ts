/**
 * One billed speech call, and what is true of any utterance a stage buys.
 *
 * It is a module rather than a flag in `lib/text-model` for the reason
 * `lib/video-model` is one: the order of operations *is* the contract of a
 * billed call, and these are not the same. A text call answers with a document
 * this pipeline then validates as prose; a speech call answers with bytes, and
 * what it charges for is not the answer but the question, this provider bills
 * per character of the text it is handed, so the number every other stage
 * prints before it spends, the count of calls, stops being the bill here.
 *
 * What lives here is everything true of *any* line: the endpoint, how the bytes
 * travel, the format they travel in and why that is a decision, how long a line
 * may be, what the bill is measured in, and the verdict on what came back.
 *
 * What stays with the stage is everything about *its* artifact: which sentence,
 * which voice, where the file goes, where on the timeline it lands, and the
 * words it uses for a refusal.
 *
 * One voice model reads both tracks, which is a decision the user stores in one
 * variable rather than a fact about a track, and the lines themselves are
 * shared, because a voice reading a sentence has no idea which of the two films
 * it will sit over.
 */

export { runVoiceStage } from "./attempt.js";
export type { SpeechContext, SpeechDelivery } from "./client.js";
export { DEFAULT_DELIVERY } from "./client.js";
export {
  billedCharacters,
  contextCharacters,
  utteranceLength,
  validateSpeech,
} from "./validate.js";
