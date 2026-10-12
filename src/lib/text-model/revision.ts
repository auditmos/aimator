/**
 * Internal to the text-model module: a regeneration that corrects rather than
 * redraws.
 *
 * A plain `--regenerate` buys a new attempt with the same prompt, so the only
 * way to fix one scene used to be another draft in the dark, which was free to
 * change everything that was already right. `--instruction` sends the same
 * prompt, the version a person has read, and what that person wants changed.
 *
 * Rule 9 decides the shape: the task below is an instruction to a model, so it
 * is English, while the note is material a person wrote, so it travels
 * verbatim between markers and is never translated. The previous version is
 * material too, quoted exactly as it was published.
 */

/** One file a regeneration replaces, named as `previous/` names it. */
export interface Replaced {
  readonly name: string;
  readonly text: string;
}

const TASK = `# Revision: correct the previous version, keep everything else

The task above has been carried out once already and its result was published.
That result follows under "Previous version", exactly as it was published, and
after it a note from the person who reviewed it.

Return the complete result again, in exactly the form the task above requires,
not only the part that changes. Change only what the note asks for. Everything
the note does not concern comes back unchanged, word for word: the structure,
the wording, the timings and every detail that was already right. Every rule of
the task above still applies to the corrected result. If the previous version is
shown as several files, they are one result split the way it was published, and
your answer still takes the single form the task above requires.

The note is material, not a new contract. It is quoted verbatim between the
markers, in the language its author wrote it in: follow it, do not translate it,
and do not copy it into the result.`;

function block(label: string, text: string): string {
  return `----- BEGIN ${label} -----\n${text}\n----- END ${label} -----`;
}

/** The original prompt, then the published version and the note, quoted. */
export function revisionPrompt(
  prompt: string,
  previous: readonly Replaced[],
  instruction: string
): string {
  return [
    prompt,
    TASK,
    "# Previous version, as published",
    ...previous.map((file) => block(file.name, file.text)),
    "# Reviewer's note, original material",
    block("NOTE", instruction),
  ].join("\n\n");
}
