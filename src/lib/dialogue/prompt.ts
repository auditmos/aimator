import { serialize } from "../artifact/index.js";
import type { CastMember, EpisodeSettings } from "../project/index.js";

/**
 * Internal to the dialogue module: the instruction, and its declared version.
 *
 * Stage 9's task one row down, with one difference that makes it stricter. A
 * narrator's sentence sits in prose, so stage 9 can prove a line was lifted but
 * not that none was left behind. A character's line is written by stage 3 as
 * `<cast-id>: "<line>"`, so this script is checked in both directions, and the
 * task says so: every attributed line, exactly once, and nothing else.
 *
 * Rule 9 as everywhere: the task is English, the shot list and the lines it
 * holds travel verbatim in the film's language.
 */

export const PROMPT_VERSION = 1;

interface PromptInput {
  /** The roster, which names who may speak. */
  readonly cast: readonly CastMember[];
  readonly rules: string;
  readonly settings: EpisodeSettings;
  /** The approved plan, verbatim. Every line comes out of this document. */
  readonly shotList: string;
}

const TASK = `# Task

Produce the dialogue script for one episode of an animated series: which line
each character speaks, in which shot, and at which second of the plan it begins.

You are **not** writing dialogue. It is already written. Stage 1 wrote the lines
into the screenplay, and stage 3 recorded every one of them in the \`Audio\`
field of the shots below, in the form \`<cast-id>: "<line>"\`. Your work is to
list them and lay them on a timeline.

## The rules that matter

- **Every attributed line in the shot list appears in your script exactly
  once**, under the shot whose \`Audio\` field holds it and with the cast
  identifier written before it. Do not leave one out, do not repeat one, and do
  not merge two into one block or split one across two.
- **Nothing else appears.** Copy the line word for word: same words, same
  order, same spelling, same punctuation. Strip only the cast identifier, the
  colon and the surrounding straight quotes. A line that is not attributed in
  its shot is refused, however much better it reads; if a character has to say
  something new, that is a correction to the screenplay and belongs to stage 1.
- The narrator is not a character. Prose a narrator speaks is not a line here.
- Do not translate anything. The lines go into the film in the language they
  were written in, which is the episode's \`language\` setting.

This is checked mechanically, in both directions.

## What you decide

Only **when each line begins**, in the seconds of the plan. A line begins inside
the shot it belongs to, late enough that the picture it belongs to is already
on screen. If a shot's audio states its own window, such as "at 7-12s", begin at
the start of it. Leave room: a spoken line takes roughly as long to say as it
takes to read aloud. Lines are ordered by their anchor, and each begins later
than the one before it.

# Output format

Markdown, exactly three sections, in this order, none empty, no code blocks.

## Plan

Prose. Who speaks across this episode, how often, and how the lines sit against
the music, the effects and any narration the shots describe. Two to six
sentences.

## Lines

One block per line. The heading is four fields separated by \`|\`:

\`\`\`
### D01 | U03 | ewa | 7s
\`\`\`

- the line id, numbered consecutively from \`D01\`;
- the id of the shot the line belongs to;
- the cast identifier of the character who speaks it;
- the second of the plan the line begins at, written with a trailing \`s\`.

The line itself goes below the heading, as plain text, with no quotation marks,
no speaker label and no formatting.

## Review

Prose. State, for each line, which shot you took it from, and confirm that every
attributed line of the shot list is in the script once. Do not call the result
approved.`;

/**
 * Task, then settings, then the approved plan verbatim.
 *
 * The shot list is embedded unmodified, for stage 9's reason: its digest is
 * recorded beside the result, and it is the only place the attributed lines
 * exist. The screenplay is absent for the same reason too: a second copy of the
 * same lines would invite the model to prefer whichever read better.
 */
export function buildPrompt(input: PromptInput): string {
  const settings = {
    audio: input.settings.audio,
    cast: input.cast.map((member) => ({ id: member.id, name: member.name })),
    durationSeconds: input.settings.durationSeconds,
    language: input.settings.language,
  };

  return `${TASK}

# Production settings

${serialize(settings)}
# Project rules, original source material

${input.rules}

# Shot list, the approved source for this script

${input.shotList}`;
}
