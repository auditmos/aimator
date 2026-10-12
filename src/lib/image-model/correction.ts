import { noteBlock } from "../instruction.js";

/**
 * Internal to the image-model module: an image corrected rather than redrawn.
 *
 * A plain `--regenerate` draws the image from nothing with the same prompt, so
 * fixing one detail risked every detail that was right. Under `--instruction`
 * the image a person has seen travels as Image 1 and the task says to change
 * only what the note names. It is true of any image a stage buys, which is why
 * it lives here: how stage 2 numbers its list and how stages 5 to 7 do differ,
 * and what Image 1 is for does not.
 *
 * Both providers already take the image this way: gpt-image through
 * `/images/edits`, seedream as the first element of `image`. What changes is
 * the set of attachments and their order, never the endpoint.
 */

/** How the attachment list names the image being corrected: `previous:R02`. */
export function previousId(name: string): string {
  return `previous:${name}`;
}

/** Its role, one line of English, because it reaches the model in the list. */
export const PREVIOUS_ROLE =
  "the image to correct; keep everything the note does not name exactly as it is";

/**
 * The task that turns a drawing request into a correction, with the note.
 *
 * It sits right after the numbered list, because it is about Image 1 and the
 * reader has to know what Image 1 is for before reading the brief it was drawn
 * from. The note is material: quoted verbatim, never translated (rule 9).
 */
export function correction(note: string): string {
  return `CORRECTION OF IMAGE 1, NOT A NEW DRAWING
Image 1 is the image this request already produced, reviewed by a person. Return
it corrected: change only what the note below names, and keep the composition,
the framing, every identity, the costumes, the palette, the lighting and every
other detail of Image 1 exactly as they are. The images after Image 1 and the
brief below are what Image 1 was drawn from; use them only to get right what the
note asks for. The note is material, quoted verbatim in the language its author
wrote it in: follow it, do not translate it, and do not draw it as text.

${noteBlock(note)}`;
}
