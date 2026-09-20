import { serialize } from "../artifact/index.js";
import type { EpisodeSettings } from "../project/index.js";

/**
 * Internal to the sound-design module: the instruction, and its declared
 * version.
 *
 * The version is stated rather than hashed, for the reason every other stage
 * states one: a hash changes when a comment is reflowed and says nothing about
 * whether the instruction changed.
 *
 * **Rule 9 does more work here than anywhere else in the pipeline, and it is
 * this file that carries it.** Stage 9's task was easy to word because the
 * thing it asked for was a copy: the narrator's words already existed, and the
 * instruction only had to forbid touching them. Here the thing asked for is a
 * translation of purpose **without** a translation of words — the model reads
 * Polish prose describing rain, thunder and an evening theme, and writes an
 * English instruction to a music model. The shot list travels verbatim beside
 * this task, as always; what comes back is English, because it is an
 * instruction and instructions are English.
 *
 * Nothing downstream checks that, which is why it is said three times here.
 * The verdict is stage 4's kind — it judges the wiring and never reads a
 * prompt — so the instruction and the human who approves the sheet are the
 * whole of rule 9's enforcement in this stage. A parser was tried and removed;
 * `validate.ts` says why.
 */

export const PROMPT_VERSION = 1;

interface PromptInput {
  readonly rules: string;
  readonly settings: EpisodeSettings;
  /** The approved plan, verbatim. Every cue is measured against this document. */
  readonly shotList: string;
}

const TASK = `# Task

Produce the cue sheet for one episode of an animated series: the music that
plays under it, and the discrete sound effects that happen in it.

The \`Audio\` field of every shot below already describes what the episode
sounds like — rain on a window, a low roll of thunder, a gentle evening theme,
and sometimes a sentence the narrator says. Your work is to turn that
description into instructions two audio models can act on, and to place each
one on the timeline of the approved plan.

## Language: this is the one thing to get right

The shots are written in the film's own language and **must not be translated,
quoted or copied**. What you write is an **instruction to a model**, and every
instruction in this pipeline is written in **English**. So: read the Polish,
understand what the scene sounds like, and write the cue in English as a
sound designer would brief a composer.

Do not transliterate. Do not paste a phrase from a shot into a cue. Do not
include proper names from the film unless the sound itself depends on them.
The episode's \`language\` setting describes what is spoken and captioned on
screen; it says nothing about this answer.

## Narration is not yours

Some \`Audio\` fields contain a sentence the narrator speaks. **Ignore it.**
Another stage buys the narration and lays it over the film, and the mix steps
the music back underneath it automatically. Never describe speech, never write
lyrics for a voice, and never ask for a track that has singing in it.

## What you decide

- **How the film is scored.** The music covers the episode from its first
  second to its last, with no gap and no overlap. One continuous bed is the
  normal answer and the best-sounding one, because two separately generated
  tracks butted together do not share a key or a tempo. Use a second bed only
  where the film genuinely breaks in two and the seam is meant to be heard.
- **Which sounds are events.** A thunderclap, a door, two playful accents on a
  head turn. These are bought one at a time, anchored at the second they
  happen, and each is between 0.5 and 30 seconds long. Continuous atmosphere —
  rain that runs under a whole scene, room tone — belongs in the music cue, not
  here: it is a bed, and the effect model does not make beds.

# Output format

Markdown, exactly four sections, in this order, none empty, no code blocks.

## Plan

Prose, in English. What the episode sounds like as a whole and how the score
relates to the picture. Two to six sentences.

## Music

One block per continuous bed. The heading is three fields separated by \`|\`:

\`\`\`
### M01 | U01,U02,U03,U04 | 0-30s
\`\`\`

- the bed id, numbered consecutively from \`M01\`;
- **every shot id the bed's seconds cover**, comma separated, in plan order.
  This is checked mechanically against the seconds: a shot you leave out and a
  shot that is not in the range both fail. Work through the shot list in order
  rather than guessing;
- the range of the plan it covers, written \`start-end\` with a trailing \`s\`.
  The beds must meet exactly and together run from \`0s\` to the end of the plan.
  A bed is between 3 and 600 seconds long.

Below the heading, in English prose, the instruction to the music model:
instrumentation, mood, tempo, texture, what it must not do, and how it changes
across its own span. Write it as a brief, not as a list of tags.

## Effects

One block per discrete sound. The heading is four fields separated by \`|\`:

\`\`\`
### E01 | U03 | 16s | 3s
\`\`\`

- the effect id, numbered consecutively from \`E01\`;
- the id of the shot the sound happens in;
- the second of the plan it begins at, inside that shot, with a trailing \`s\`;
- how long it lasts, between \`0.5s\` and \`30s\`. It must finish before the
  plan does.

Below the heading, in English prose, what the sound is. Be concrete about
attack, weight and distance; the model takes the description literally.

## Review

Prose, in English. State which shot each cue came from, and say plainly what
you left out: audio the shots describe that you judged to be narration, and
anything you were unsure how to render. Do not call the result approved.`;

/**
 * Task, then settings, then the approved plan verbatim.
 *
 * The shot list is embedded unmodified: its digest is recorded alongside the
 * result, and a digest that describes bytes nobody sent would be worthless.
 * The request is therefore bilingual, exactly as the invariant says it should
 * be — English instruction, material in its own language.
 *
 * The screenplay and the prompt package are deliberately absent. Stage 3
 * already carried every description of sound into the shots, and a second copy
 * would invite the model to prefer whichever version read better; the package
 * carries no instruction to an audio model at all, so recording a hash of
 * bytes nobody sent would describe a question nobody asked.
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

# Shot list — the approved source for this cue sheet

${input.shotList}`;
}
