import { z } from "zod";
import type { ResponseFormat } from "../text-model/index.js";

/**
 * Internal to the project module: the instruction half of a drafted
 * `project.md`, and the shape the provider is asked to return.
 *
 * The model fills fields and never writes the document: it answers every
 * field of the scaffold, saying for each whether the material states it or it
 * is the model's own proposal, and the code renders `project.md` from the same
 * template `init` scaffolds. So the structure stage 0 reads (the sections, the
 * Style Bible block, the markers left for a person) cannot come back broken,
 * whatever the answer says. A proposal keeps the marker in front of it, so it
 * blocks stage 0 until a person takes it, exactly as an empty field would.
 *
 * It never fills the two lines about provenance: when and from what the draft
 * was made is the code's to write, and that a person approved it is a person's.
 */

export const PROMPT_VERSION = 2;

/** One field's answer, and whether the material says it or the model proposes it. */
const field = z.strictObject({ grounded: z.boolean(), text: z.string() });

/** Every field a draft fills. Strict and fully required because the provider's strict dialect is. */
export const answerSchema = z.strictObject({
  alwaysNever: field,
  audience: field,
  cast: field,
  continuity: field,
  episodeRule: field,
  linework: field,
  opening: field,
  openQuestions: field,
  palette: field,
  proportions: field,
  props: field,
  protagonist: field,
  relations: field,
  scenery: field,
  styleLine: field,
  theme: field,
  traits: field,
  world: field,
});

export type DraftAnswer = z.infer<typeof answerSchema>;

/** Derived from `answerSchema`, for the reason stage 4 gives: one description of one shape. */
export const DRAFT_FORMAT: ResponseFormat = { name: "project_rules_draft", schema: jsonSchema() };

function jsonSchema(): Readonly<Record<string, unknown>> {
  const { $schema, ...rest } = z.toJSONSchema(answerSchema) as Record<string, unknown>;

  return rest;
}

const TASK = `# Task: draft the shared rules of an animated series from what is known about it

A person is preparing a short animated series in a production pipeline. They
brought a document (a director's treatment, a series bible) that was converted
and sorted by what each part is about, and they have started the project. You
receive what the project already holds and those parts below. From them, answer
every field of the series' shared rules, \`project.md\`: the decisions every
episode and every generated image of the series relies on.

What you write is a **proposal**. The person reads every field, corrects it and
approves the rules themselves; nothing you return is accepted until they do.

## How to answer a field

Answer every field, and say for each which kind of answer it is:

- \`grounded: true\` when the material states it or clearly implies it. Condense
  and rephrase freely, but add nothing the material does not support: no trait,
  colour, rule or place of your own inside a grounded answer.
- \`grounded: false\` when the material does not settle it and you propose it:
  the answer the material most supports, or the usual choice for a series like
  this one. Say it concretely, as a recommendation the person can take as it
  is. It is shown to them as a proposal and stays open until they accept it.
  Never mark a proposal as grounded: a guess presented as the material's costs
  them a wrong series.

And for every answer:

- Episodes are here so you learn what recurs in the series: places, props,
  the look, the cast, the length and the shape of an episode. **Never write the
  plot of an episode** into a field. Each episode's story is written later,
  from that episode's own source; the rules only say what holds across them.
- Write in the language of the material, keeping its names, **except the four
  Style Bible fields**, which are English, because every image model receives
  them verbatim as an instruction.
- Plain text. A field may hold several lines and a list of \`- \` items. No
  headings: a line starting with \`#\` would break the document.
- Image links like \`![I01](images/I01.png)\` stand for pictures you cannot see.
  Do not describe what they might show.

## The Style Bible

- \`styleLine\`: 5–7 comma-separated phrases, in this order of layers: format,
  medium, linework, shading, palette, texture, light and mood, composition.
  Only the layers that set this style apart. Only what is there (what must not
  be there belongs in \`alwaysNever\`), no value judgements such as "beautiful"
  or "high quality".
- **Never a studio, film, artist or series name** in any Style Bible field,
  even one the material uses as a reference (an earlier film of the same
  series included). Describe the look such a name stands for instead.
- \`palette\`: 5–8 colours, each a name and a hex value. Turning a colour the
  material names into a hex value keeps it grounded; the person will check it.

## Fields`;

/** What each field asks, in the scaffold's order, for the model to read beside the keys. */
const BRIEFS: Readonly<Record<keyof DraftAnswer, string>> = {
  alwaysNever: "(English) hard rules for the whole drawing, or an explicit 'none'.",
  audience: "who the series is for (age) and how it speaks to them: the tone.",
  cast: "the recurring supporting cast, or explicitly 'brak stałej obsady'.",
  continuity: "what must stay the same between scenes and between episodes.",
  episodeRule: "what a single episode tells, and how it ties to the rest of the series.",
  linework:
    "(English) outer and inner line weight, taper and colour; for 3D, how edges and outlines read.",
  opening: "a required composition of an episode's opening, or explicitly no extra constraint.",
  openQuestions:
    "only open issues that do not block writing an episode, ideas marked as proposals; 'Brak' when there are none.",
  palette: "(English) 5–8 colours, each a name and a hex value.",
  proportions:
    "how figures are stylised: head-to-body ratio and degree of deformation (not the frame's aspect ratio).",
  props:
    "recurring props, each described by shape, size against the characters, material, colour and wear; or explicitly 'brak'.",
  protagonist: "the main character and their role: participant, observer or narrator.",
  relations:
    "how the characters relate in scale (who is taller and by how much, whether heads are the same size) and what is drawn identically on all of them.",
  scenery:
    "the places the series returns to and what is fixed in each (palette, light, objects that must not move), or explicitly 'brak'.",
  styleLine: "(English) the style line described above.",
  theme: "what connects the episodes: the subject of the series.",
  traits:
    "each recurring character's fixed look and costume: hair colour and shape, cut and colour of clothes, distinguishing features. One `- Name: …` item per character. When a character is drawn from a description, this is the only thing the drawing stage reads, so be complete and concrete.",
  world: "the shared world and time of the action.",
};

/** The order the scaffold asks them in, which is the order the model reads them. */
const ORDER: readonly (keyof DraftAnswer)[] = [
  "theme",
  "episodeRule",
  "audience",
  "world",
  "protagonist",
  "proportions",
  "traits",
  "cast",
  "relations",
  "props",
  "styleLine",
  "palette",
  "linework",
  "alwaysNever",
  "opening",
  "scenery",
  "continuity",
  "openQuestions",
];

/** What the project itself already says, before any of its rules are written. */
export interface DraftFacts {
  readonly aspectRatio: string | null;
  /** The cast declared so far, `id (Name)`; empty before anybody was named. */
  readonly cast: readonly { readonly id: string; readonly name: string }[];
  readonly title: string;
}

/** One part of the material, under the name its grouping gave it: `series`, `character:miko`. */
export interface DraftMaterial {
  readonly destination: string;
  readonly text: string;
}

/**
 * Task, fields, the project's own facts, then each part of the material
 * verbatim between markers.
 *
 * Deterministic for the same project and material, which is what lets
 * `--dry-run` show the exact text a paid call would send.
 */
export function buildPrompt(facts: DraftFacts, material: readonly DraftMaterial[]): string {
  const fields = ORDER.map((key) => `- \`${key}\`: ${BRIEFS[key]}`).join("\n");
  const cast =
    facts.cast.length === 0
      ? "nobody declared yet"
      : facts.cast.map(({ id, name }) => `${id} (${name})`).join(", ");
  const blocks = material.map(
    (part) => `<<< ${part.destination}\n${part.text.trimEnd()}\n>>> ${part.destination}`
  );

  return `${TASK}

${fields}

# The project

- Title: ${facts.title}
- Frame aspect ratio: ${facts.aspectRatio ?? "not decided yet"}
- Cast: ${cast}

# The material, part by part

${blocks.join("\n\n")}
`;
}
