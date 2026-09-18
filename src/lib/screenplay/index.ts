/**
 * Stage 1 — screenplay. The first stage that spends money.
 *
 * It consumes only artifacts stage 0 produced (`project.json`, `project.md`,
 * `episode.json`, `source.md`) and produces `screenplay.md` beside a
 * `screenplay.stage.json` recording what went in, what came out and who has
 * accepted it. One attempt is archived under `runs/<runId>/`, holding only
 * what cannot be reconstructed — the inputs are referenced by path and digest,
 * never copied.
 *
 * Three invariants this interface exists to protect: the paid call refuses
 * until stage 0 is approved, nothing ever retries by itself, and validating a
 * draft is not the same as accepting one.
 */

export { generateScreenplay, type ScreenplayReport } from "./generate.js";
export { buildPrompt, PROMPT_VERSION } from "./prompt.js";
export { approveScreenplay, checkScreenplay, type ScreenplayStatus } from "./review.js";
export { validateScreenplay } from "./validate.js";
