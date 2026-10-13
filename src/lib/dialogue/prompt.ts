import { serialize } from "../artifact/index.js";
import type { CastMember, EpisodeSettings } from "../project/index.js";
import type { ShotListShot } from "../shot-list/index.js";
import type { DialogueLine } from "./validate.js";

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

/**
 * The second-language script's own version, apart from the lift's: the two
 * tasks change for different reasons, and a record has to name the one that
 * really produced its answer.
 */
export const TRANSLATION_PROMPT_VERSION = 1;

interface TranslationPromptInput {
  readonly cast: readonly CastMember[];
  /** The accepted script as data: where each line begins, and in which shot. */
  readonly lines: readonly DialogueLine[];
  readonly rules: string;
  /** The accepted script, verbatim. Every line of the translation comes out of it. */
  readonly script: string;
  /** The approved plan's shots: where each shot ends. */
  readonly shots: readonly ShotListShot[];
  /** The film's language, which the script is written in. */
  readonly source: string;
  /** The language of the mouths, which the translation is written in. */
  readonly target: string;
}

function translationTask(source: string, target: string): string {
  return `# Task

Translate the dialogue script of one episode of an animated series from
\`${source}\` into \`${target}\`.

The translated lines will be read aloud by the same characters, in voices cast
for \`${target}\`, and the characters' mouths will be animated again to match
them. A line that cannot be said inside its window cannot be lip-synced.

## The rules that matter

- **Keep every block, and keep every heading exactly as it is.** The same line
  ids in the same order, each heading copied character for character, such as
  \`### D01 | U03 | ewa | 7s\`. Do not add a line, drop one, merge two or split
  one. Do not move an anchor and do not change who speaks.
- **Translate only the text under each heading.** Write what this character
  would say in \`${target}\`: short, natural, spoken. Keep the meaning, the tone
  and who is being addressed; this is not a word-for-word gloss.
- **Fit the window.** Each line has a time window below: the seconds of the
  plan from its anchor to the next line, or to the end of its shot, whichever
  comes first. Write a line that is comfortable to say inside it at a natural
  pace. Where a faithful translation would not fit, shorten it and keep the
  meaning; nothing downstream will speed a line up.
- Names stay names. No quotation marks, no speaker label, no stage directions,
  no formatting.

This is checked mechanically against the source script: ids, shots, speakers
and anchors, one to one. Whether the translation is faithful is judged by a
person before anything is bought with it.

# Output format

Markdown, exactly two sections, in this order, none empty, no code blocks.

## Lines

One block per line of the source script: its heading, copied unchanged, and
the translated line below it as plain text.

## Review

Prose. Name every line you shortened or rephrased to fit its window, and say
what was given up. Do not call the result approved.`;
}

/** Seconds as a person writes them: 8, 7.5, never 7.499999. */
function seconds(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * How long each line has, in seconds of the plan: from its anchor to the next
 * line, or to the end of its shot, whichever comes first. Derived rather than
 * stored, for rule 7's mirror: the script and the plan already say both ends.
 */
function windows(lines: readonly DialogueLine[], shots: readonly ShotListShot[]): string {
  return lines
    .map((line, index) => {
      const ends = [
        shots.find((shot) => shot.id === line.shot)?.end,
        lines[index + 1]?.atSeconds,
      ].filter((one): one is number => one !== undefined);
      const end = ends.length === 0 ? line.atSeconds : Math.min(...ends);

      return `- ${line.id} | ${line.shot} | ${line.cast}: ${line.atSeconds}-${end}s of the plan, ${seconds(end - line.atSeconds)}s`;
    })
    .join("\n");
}

/**
 * Task, settings, windows, then the material verbatim.
 *
 * This is the one deliberate translation of material in the pipeline, and rule
 * 9 still holds around it: the instruction is English, and `project.md` and the
 * accepted `dialogue.md` travel exactly as they were written. What comes back
 * is a new artifact with its own yes, never a re-encoding of the source.
 */
export function buildTranslationPrompt(input: TranslationPromptInput): string {
  const settings = {
    cast: input.cast.map((member) => ({ id: member.id, name: member.name })),
    sourceLanguage: input.source,
    targetLanguage: input.target,
  };

  return `${translationTask(input.source, input.target)}

# Production settings

${serialize(settings)}
# Time windows

${windows(input.lines, input.shots)}

# Project rules, original source material

${input.rules}

# Dialogue script, the approved source for this translation

${input.script}`;
}
