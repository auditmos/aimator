/**
 * Style frames generated per track from the project's Style Bible.
 *
 * Not a numbered row of the pipeline: it sits beside stage 2, at the project
 * level, and like stage 2 it reads stage 0 alone. It exists for projects whose
 * style decision is `generated`, and draws, on each track separately, the
 * number of frames that decision names: two models are two hands, and a style
 * frame drawn by one beside the other would mix them in one drawing.
 *
 * Four invariants this interface protects: nothing is paid for before stage 0
 * is accepted and its Style Bible answered, one call buys one image and the
 * count is said first, nothing retries by itself, and an approval is bound to
 * the digest of one image rather than to the set. Stages 5 to 7 attach only the
 * frames accepted here, on their own track.
 */

export { generateStyle, type StyleReport } from "./generate.js";
export { approveStyle, checkStyle, type StyleStatus } from "./review.js";
