/**
 * Stage 1 — screenplay. The first stage that spends money.
 *
 * It consumes only artifacts stage 0 produced (`project.md`, `project.json`,
 * `source.md`, `episode.json`) and produces `screenplay.md` beside a
 * `screenplay.stage.json` that records what went in, what came out and who
 * has accepted it.
 */

export { buildPrompt, PROMPT_VERSION } from "./prompt.js";
export { validateScreenplay } from "./validate.js";
