/**
 * Stage 2 — character. The first image stage, and the first that branches into
 * two model tracks.
 *
 * It consumes only stage-0 artifacts — `project.json`, `project.md` and, when
 * a character's basis is `photographs`, that character's own `sources/` — and
 * produces, in order, `card.png`, eight standalone views and `hero.png` under
 * `characters/<character-id>/<track>/`, beside one `character.stage.json` that
 * records all ten as separate artifacts.
 *
 * Four invariants this interface exists to protect: the paid call refuses until
 * stage 0 is approved, each step refuses until the previous one is accepted,
 * nothing ever retries by itself, and an approval is bound to the digest of one
 * image rather than to the set.
 *
 * It does not depend on stage 1 and may run alongside it.
 */

export { type CharacterReport, generateCharacter } from "./generate.js";
export {
  buildPrompt,
  CHARACTER_ARTIFACTS,
  CHARACTER_VIEWS,
  type CharacterArtifact,
  isCharacterArtifact,
  referencePlan,
} from "./prompt.js";
export { approveCharacter, type CharacterStatus, checkCharacter } from "./review.js";
