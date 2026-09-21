/**
 * The prompt an image or video model actually receives: text plus ordered
 * attachments, addressed by position.
 *
 * Stage 4 publishes one file per future paid call, carrying the creative
 * direction for that one frame and nothing else, no reference list, no project
 * rules, no shots. That is half a prompt, and a human approving it is approving
 * something they cannot see in the shape it will be sent in. This module is the
 * other half, and it is the same implementation for the free preview and for
 * the stage that pays: one composer, two readers, no drift.
 *
 * It lives outside `lib/prompt-package` on purpose. The package is the one
 * artifact that deliberately names no track, `hero:ewa` and `R03` are written
 * without deciding which of two productions will draw them, so the module that
 * resolves those identifiers into `characters/ewa/seedream/hero.png` cannot be
 * the module forbidden to know the word "seedream". It lives outside stage 5
 * for the opposite reason: stages 6 and 7 need it too, and a stage never
 * reaches into another stage's internals.
 *
 * Resolving the identifiers is also what answers the gate. An attachment a
 * human has not accepted is not an attachment this pipeline sends, so the list
 * and the verdict on it are one question, asked once.
 */

export { type Attachment, type PlannedArtifact, readSendPlan, type SendPlan } from "./plan.js";
