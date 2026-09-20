/**
 * Stage 10 — the sound design. Music and effects, and the film with every
 * sound it has.
 *
 * The declared row 10 said music and effects were an **input**, brought in by
 * a person, and admitted in the same breath that it did not settle where they
 * came from. It does not survive contact with the rest of the contract:
 * pulling outside files into the workspace is stage 0's monopoly, so "a person
 * brings them" was a rewrite of stage 0 under another name. Stage 10 buys them
 * instead, from ElevenLabs — which is not a fourth provider but a fourth and
 * fifth paid call site at the one this pipeline already uses for speech.
 *
 * Five things are worth knowing before reading further.
 *
 * **There is no "lifted, not invented" here, and something else stands in its
 * place.** Stage 9 could prove its script honest by finding every sentence
 * word for word inside the shot it names. Stage 10 cannot: a music prompt is
 * an instruction, which rule 9 writes in English, and the `Audio` prose it
 * comes from is material, which rule 9 forbids translating — so copying is
 * illegal in both directions and there is no match to look for. What replaces
 * it is stage 4's bargain: a wiring verdict that never reads a prompt, and a
 * human who does. Rule 9 is carried by the instruction and by that reader, not
 * by a parser — see `validate.ts`, where a parser was tried and taken out.
 *
 * **The stems are shared; only the mix is per track.** A bed has no idea which
 * of the two films it will sit under, and the two differ only by the drift
 * their clips came back with — so buying twice would be paying for a
 * directory. Stage 9's precedent, read to the letter.
 *
 * **The bill is seconds, not calls.** This provider rates music and effects
 * per minute of generated audio and charges at the moment of generation rather
 * than at download, so a regeneration is a second full charge. The preview
 * prints both numbers before anything is sent, exactly as stage 9 prints
 * characters beside calls.
 *
 * **It rebuilds rather than laying music over `narrated.mp4`.** The picture is
 * a stream copy of the approved `episode.mp4`, the speech comes from the
 * lossless lines stage 9 bought, and the stems come from here — so the speech
 * is encoded exactly once, and the music can step back under a voice, which is
 * only possible when the voice is an input of the graph rather than already
 * inside it. `narrated.mp4` is neither overwritten nor invalidated: it becomes
 * a reviewed intermediate, and the only place where the narrator's placement
 * can be heard without music in the way.
 *
 * **It does not close `audio` either, and says which part it leaves open.**
 * After this stage `music-and-effects` and `narration` are complete. `dialogue`
 * and `dialogue-and-narration` are not: no stage in this pipeline produces
 * character dialogue, and none does after this one. That row is declared, not
 * half-built.
 */

export { generateSoundDesign, type SoundDesignReport } from "./generate.js";
export { type LevelsReport, setLevels } from "./levels.js";
export { generateMaster, type MasterReport } from "./mix.js";
export {
  approveMaster,
  approveSoundDesign,
  checkMaster,
  checkSoundDesign,
  type MasterStatus,
  type SoundDesignStatus,
} from "./review.js";
export { validateSoundDesign } from "./validate.js";
