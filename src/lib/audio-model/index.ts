/**
 * One billed audio call — music or a sound effect — and what is true of any
 * cue a stage buys.
 *
 * It is a module rather than a flag in `lib/voice-model` for the reason
 * `lib/video-model` is one rather than a flag in `lib/text-model`: what a
 * module of this kind holds is the contract of a *kind* of billed call, and
 * speech and music are not one kind. A speech call is handed a sentence and
 * charges for the sentence; these two are handed a description and charge for
 * **the length of audio they are asked to produce**. That changes the number a
 * stage has to print before it spends, which is the one thing every paid stage
 * here is required to get right.
 *
 * Two endpoints behind one entry, with `lib/image-model`'s precedent: that one
 * holds two providers and two endpoints because "which endpoint, and how the
 * bytes travel" is true of any image. Here it is truer still — one provider,
 * one key, one container, one verdict, one lifecycle, and a body that differs
 * by which of two things is being asked for. Splitting them would have made
 * two modules whose only difference is a URL and a field name.
 *
 * What lives here is everything true of *any* cue: the endpoints, how the
 * bytes travel, the container they travel in and why that is forced rather
 * than chosen, the three lengths the provider will and will not compose, and
 * the verdict on what came back.
 *
 * What stays with the stage is everything about *its* artifact: which cue,
 * which shot it belongs to, where the file goes, where on the timeline it
 * lands, how loud it sits, and the words it uses for a refusal.
 *
 * **On the bill.** This provider rates both products per minute of generated
 * audio and charges at the moment of generation rather than at download — so a
 * regeneration is a second full charge, not a top-up. The count of calls is
 * therefore not the bill, exactly as it stopped being the bill at stage 9, and
 * a stage using this module prints seconds beside calls. Prices are not stated
 * anywhere in this pipeline and are not stated here.
 */

export { runAudioStage } from "./attempt.js";
export type { AudioKind } from "./client.js";
export { effectLength, musicLength, validateAudio } from "./validate.js";
