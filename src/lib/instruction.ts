/**
 * A person's note to a model, and the marked block it travels in.
 *
 * `--instruction` reaches a text model and an image model alike, and the note
 * is the same thing in both: material a person wrote, which rule 9 forbids
 * translating, sent beside a task written in English. How it is marked is one
 * fact rather than a convention each medium spells its own way, because a
 * model reading two spellings of "this is the note" is reading two contracts.
 *
 * Promoted at the second caller: `lib/text-model` quotes a note and the
 * version it corrects, `lib/image-model` quotes a note beside the image it
 * corrects.
 */

/** Material quoted verbatim between two markers that name it. */
export function quoted(label: string, text: string): string {
  return `----- BEGIN ${label} -----\n${text}\n----- END ${label} -----`;
}

/** The note itself, quoted. */
export function noteBlock(note: string): string {
  return quoted("NOTE", note);
}
