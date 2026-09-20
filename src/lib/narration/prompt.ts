import { serialize } from "../artifact/index.js";
import type { EpisodeSettings } from "../project/index.js";

/**
 * Internal to the narration module: the instruction, and its declared version.
 *
 * The version is stated rather than hashed, for the reason every other stage
 * states one: a hash changes when a comment is reflowed and says nothing about
 * whether the instruction changed.
 *
 * Rule 9 decides the language, as everywhere: this task is an instruction, so
 * it is English. The shot list it works from is material and travels verbatim,
 * in whatever language it was authored in — and the sentences the model lifts
 * out of it stay in that language too, because they are the film's own words.
 * The request is therefore bilingual, by design.
 *
 * The task is short next to the other text stages', and that is the honest
 * shape of the work: this stage writes nothing. It reads prose a human already
 * approved and says which part of it the narrator speaks and when. Everything
 * else here exists to stop the model from reaching for the pen.
 */

export const PROMPT_VERSION = 1;

interface PromptInput {
  readonly rules: string;
  readonly settings: EpisodeSettings;
  /** The approved plan, verbatim. Every sentence comes out of this document. */
  readonly shotList: string;
}

const TASK = `# Task

Produce the narration script for one episode of an animated series: which
sentences the narrator speaks, and at which second of the plan each one begins.

You are **not** writing the narration. It is already written. Stage 1 wrote the
narrator's words into the screenplay and stage 3 carried them into the \`Audio\`
field of the shots below, where they sit in prose that also describes the music,
the effects and the room. Your work is to find them and lay them on a timeline.

## The one rule that matters

**Every line you write must appear word for word inside the \`Audio\` field of
the shot you attach it to.** Copy the sentence exactly: same words, same order,
same spelling, same punctuation inside the sentence. Strip only the surrounding
quotation marks and the words that introduce the speaker, such as
\`narrator:\`. Nothing else may change.

This is checked mechanically. A sentence that is not in its shot is rejected and
the whole script is refused, however much better it reads. If the narration
needs to say something the shots do not contain, that is a correction to the
screenplay and it belongs to stage 1 — not to you.

Do not translate anything. The narrator's words go into the film in the
language they were written in, which is the episode's \`language\` setting. This
instruction is in English; the material is not, and it stays as it is.

## What you decide

Two things, and only these:

- **Which prose is speech.** An \`Audio\` field describes sound: rain, a low
  roll of thunder, a warm instrumental phrase, and — sometimes — a sentence the
  narrator says. Only the last of those is a line. A shot whose audio is only
  music and effects has no line, and most shots will have none.
- **When each line begins**, in the seconds of the plan. A line must begin
  inside the shot it belongs to, and late enough that the picture it comments on
  is already on screen. Leave room: a spoken sentence takes roughly as long to
  say as it takes to read aloud, and two lines must not overlap. If a shot's
  audio states its own window, such as "at 7-12s", begin at the start of it.

## An utterance is one continuous stretch of speech

One line is one thing the narrator says without stopping, and it is bought with
one call. Two sentences the narrator speaks back to back, with no pause and no
picture between them, are **one** line: splitting them would cut a single piece
of delivery in half. Two sentences separated by seconds of silence are **two**
lines, each anchored where it belongs.

# Output format

Markdown, exactly three sections, in this order, none empty, no code blocks.

## Plan

Prose. What the narration does across this episode: how many times the narrator
speaks, what each line is doing there, and how the lines sit against the music
and the effects the shots describe. Two to six sentences.

## Lines

One block per utterance. The heading is three fields separated by \`|\`:

\`\`\`
### N01 | U02 | 7s
\`\`\`

- the utterance id, numbered consecutively from \`N01\`;
- the id of the shot the line belongs to;
- the second of the plan the line begins at, written with a trailing \`s\`.

The sentence itself goes on the lines below the heading, as plain text, with no
quotation marks, no speaker label and no formatting. Lines must be ordered by
their anchor, earliest first.

## Review

Prose. State, for each line, which shot you took it from, and say plainly what
you left out: audio the shots describe that is not speech, and any sentence you
were unsure about. Do not call the result approved.`;

/**
 * Task, then settings, then the approved plan verbatim.
 *
 * The shot list is embedded unmodified: its digest is recorded alongside the
 * result, and a digest that describes bytes nobody sent would be worthless. It
 * is also the only place the narrator's words exist, so sending anything less
 * than the whole of it would mean asking the model to lift from a document it
 * cannot see.
 *
 * The screenplay is deliberately absent. Stage 3 already carried the narration
 * into the shots, the shot list is what the lift is checked against, and a
 * second copy of the same sentences would invite the model to prefer whichever
 * version read better — which is exactly the drift two files holding one truth
 * always produce.
 */
export function buildPrompt(input: PromptInput): string {
  const settings = {
    audio: input.settings.audio,
    durationSeconds: input.settings.durationSeconds,
    language: input.settings.language,
    subtitles: input.settings.subtitles,
  };

  return `${TASK}

# Production settings

${serialize(settings)}
# Project rules — original source material

${input.rules}

# Shot list — the approved source for this script

${input.shotList}`;
}
