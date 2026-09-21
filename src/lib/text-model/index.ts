/**
 * The paid text call and the lifecycle around it, shared by every text stage.
 *
 * It started as transport alone, promoted out of `lib/screenplay` when the shot
 * list became the second stage to make the same call. Stage 4 made it the
 * third, and the thing being copied by then was no longer the request: it was
 * the order of operations, take the lock, archive the prompt, write
 * `submitted` before the POST, resume from a saved answer rather than pay
 * twice, publish only what validates. That order *is* the contract, so it lives
 * here rather than in three places that can drift apart.
 *
 * A stage brings its prompt, its structural verdict and the files it writes.
 * This module brings the sequence, and knows nothing about any of them.
 */

export { type Publication, type Published, runTextStage, type TextStage } from "./attempt.js";
export type { ResponseFormat } from "./client.js";
