/**
 * Internal to the style module: the instruction half of every paid call.
 *
 * A constant with a declared version, for the reason stage 2's prompts are one:
 * tsup bundles `src/` alone, so a sibling Markdown file would not exist in
 * `dist/`, and a hash of this file would change with a reformatted comment.
 *
 * It carries the task and nothing of the art direction. The look is the Style
 * Bible's, quoted verbatim at the end inside `project.md` (rule 9: the task is
 * English, the material stays as written), and the task says so rather than
 * naming a medium of its own.
 */

export const PROMPT_VERSION = 1;

/** `S01`: one style frame, its stage-file key and its file name at once. */
export const STYLE_FRAME_ID = /^S\d{2,}$/;

/** The ids a decided count names, in order: two frames are `S01`, `S02`. */
export function styleIds(count: number): readonly string[] {
  return Array.from({ length: count }, (_, index) => `S${String(index + 1).padStart(2, "0")}`);
}

interface PromptInput {
  readonly aspectRatio: string;
  /** The cast's names, none of whom may appear. */
  readonly cast: readonly string[];
  readonly count: number;
  /** One-based: which frame of the set this request draws. */
  readonly index: number;
  /** `project.md`, verbatim. */
  readonly rules: string;
  readonly size: string;
}

/** Who must not be in it, by the names the project rules use. */
function nobody(cast: readonly string[]): string {
  return cast.length === 0
    ? "No character from the cast appears in it, and no figure stands in for one."
    : `No character from the cast appears in it (${cast.join(", ")}), and no other figure stands in for one.`;
}

/** Several frames of one set show one style in more than one situation. */
function variety(index: number, count: number): string {
  return count === 1
    ? ""
    : `\nThis is frame ${index} of a set of ${count}. Choose a place, a time of day or a
distance from the subject the other frames of the set would not, so that together
they show the style in more than one situation, and keep the style itself identical.`;
}

/**
 * The exact text one paid call carries.
 *
 * Deterministic for the same inputs, which is what lets a free preview show
 * what a paid call would send.
 */
export function buildPrompt(input: PromptInput): string {
  return `# Task: style frame ${input.index} of ${input.count}

Create one style frame for an animated series: a single still whose whole job is
to show how every frame of this production is drawn. Later image requests attach
it beside their own references as evidence of the look alone, never of content.

WHAT IT SHOWS
The medium, line, shading, palette, texture and lighting the Style Bible in the
project rules below defines, exactly as it defines them: the style line, the
palette with its hex values, the linework rule, and every always and never. Do
not introduce a medium, palette, texture or light the Style Bible does not state,
and do not fall back on photorealism or on a generic 3D animated look.

WHAT IT DEPICTS
A neutral scene from the world of the series as the project rules describe it: a
place, its light and its objects, at rest. ${nobody(input.cast)}
No story moment, no action, and no text, sign or lettering.${variety(input.index, input.count)}

OUTPUT FRAME
Return exactly one image, ${input.size} pixels, the ${input.aspectRatio} film frame of this
series, on an opaque background. No label, caption, watermark, border, inset panel
or collage.

# Project rules, the art direction for this production

${input.rules}`;
}
