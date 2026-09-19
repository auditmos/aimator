/**
 * One billed image call, and what the two image tracks accept.
 *
 * Promoted out of `lib/character` when stage 5 became the second image stage
 * and stage 6 the certain third — the same threshold `lib/text-model` was
 * promoted at, reached deliberately this time rather than discovered after two
 * copies had already drifted apart in their comments.
 *
 * Stage 7 calls this for its **entry frames**, which are images like any other,
 * and `lib/video-model` for its clips. That split is the promise this module
 * made and kept: a clip is an asynchronous job with an id to poll, which is a
 * different order of operations, so it got its own module instead of a flag in
 * this one.
 *
 * What lives here is everything that is true of *any* image a stage buys: the
 * two endpoints and how they differ, the frame a track will render, how many
 * references it carries, the order of operations around the POST, and the
 * verdict on the bytes that come back.
 *
 * What stays with a stage is everything about *its* artifact: the prompt, the
 * attachments it chose, the frame that artifact is drawn in, where the file
 * goes, and the words it uses for a refusal.
 */

export { runImageStage } from "./attempt.js";
export { attach, type ImageAttachment } from "./client.js";
export { frameSize, referenceLimit } from "./track.js";
export { type ImageVerdict, readImageResponse, validateImage } from "./validate.js";
