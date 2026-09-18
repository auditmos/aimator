/**
 * Internal to the character module: the instruction half of every paid call,
 * and the order the artifacts are produced in.
 *
 * Constants rather than Markdown files beside the source, for the reason stage
 * 1 states: tsup bundles `src/` and only `src/`, so a sibling `.md` would not
 * exist in `dist/` and the failure would surface as a paid call with an empty
 * prompt.
 *
 * `PROMPT_VERSION` is declared, never derived from a hash of this file.
 */

/**
 * The eight standalone views, in the order the hero prompt numbers them. The
 * order is load-bearing: `Images 3–10` in that prompt refer to these positions,
 * so changing it silently re-labels the references a paid call carries.
 */
export const CHARACTER_VIEWS = [
  "front",
  "slight-left",
  "slight-right",
  "three-quarter-left",
  "three-quarter-right",
  "profile-left",
  "profile-right",
  "rear",
] as const;

export type CharacterView = (typeof CHARACTER_VIEWS)[number];

/**
 * Every artifact of the stage, in production order: the card first, because
 * the views are drawn from it; the views next, because the hero is drawn from
 * them. The list is also the vocabulary `--artifact` accepts and the key set of
 * `character.stage.json`, so a key, a filename and a flag value are one word.
 */
export const CHARACTER_ARTIFACTS = ["card", ...CHARACTER_VIEWS, "hero"] as const;

export type CharacterArtifact = (typeof CHARACTER_ARTIFACTS)[number];

export function isCharacterView(value: string): value is CharacterView {
  return (CHARACTER_VIEWS as readonly string[]).includes(value);
}
