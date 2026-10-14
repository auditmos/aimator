import { z } from "zod";
import type { ResponseFormat } from "../text-model/index.js";

/**
 * Internal to the project module: the instruction half of a drafted
 * `project.md`, and the shape the provider is asked to return.
 *
 * The model fills fields and never writes the document: it answers one value
 * per field of the scaffold, or `null` where the material is silent, and the
 * code renders `project.md` from the same template `init` scaffolds. So the
 * structure stage 0 reads (the sections, the Style Bible block, the markers
 * left for a person) cannot come back broken, whatever the answer says.
 *
 * It never fills the two lines about provenance: when and from what the draft
 * was made is the code's to write, and that a person approved it is a person's.
 */

export const PROMPT_VERSION = 1;

/**
 * Every field a draft may fill, each `null` when the material does not say.
 * Strict and fully required because the provider's strict dialect is.
 */
export const answerSchema = z.strictObject({
  alwaysNever: z.string().nullable(),
  audience: z.string().nullable(),
  cast: z.string().nullable(),
  continuity: z.string().nullable(),
  episodeRule: z.string().nullable(),
  linework: z.string().nullable(),
  opening: z.string().nullable(),
  openQuestions: z.string().nullable(),
  palette: z.string().nullable(),
  proportions: z.string().nullable(),
  props: z.string().nullable(),
  protagonist: z.string().nullable(),
  relations: z.string().nullable(),
  scenery: z.string().nullable(),
  styleLine: z.string().nullable(),
  theme: z.string().nullable(),
  traits: z.string().nullable(),
  world: z.string().nullable(),
});

export type DraftAnswer = z.infer<typeof answerSchema>;

/** Derived from `answerSchema`, for the reason stage 4 gives: one description of one shape. */
export const DRAFT_FORMAT: ResponseFormat = { name: "project_rules_draft", schema: jsonSchema() };

function jsonSchema(): Readonly<Record<string, unknown>> {
  const { $schema, ...rest } = z.toJSONSchema(answerSchema) as Record<string, unknown>;

  return rest;
}

const TASK = `# Task: draft the shared rules of an animated series from its imported material

A person is preparing a short animated series in a production pipeline. They
brought a document (a director's treatment, a series bible) that was converted
and sorted by what each part is about. You receive those parts below. From
them, fill the fields of the series' shared rules, \`project.md\`: the decisions
every episode and every generated image of the series relies on.

What you write is a **proposal**. The person reads every field, corrects it and
approves the rules themselves; nothing you return is accepted until they do.

## How to fill a field

- Use only what the material states or clearly implies. Condense and rephrase
  freely, but invent nothing: no trait, colour, rule or place the material does
  not support.
- When the material does not answer a field, return \`null\`. The field then
  stays open for the person to answer. An empty field costs them one answer; a
  guess presented as the material's costs them a wrong series.
- Never write the plot of an episode. Each episode's story is written later,
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
- \`palette\`: 5–8 colours, each a name and a hex value. Colours the material
  names may be turned into hex values; the person will check them.

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

/** One part of the material, under the name its grouping gave it: `series`, `character:miko`. */
export interface DraftMaterial {
  readonly destination: string;
  readonly text: string;
}

/**
 * Task, fields, then each part of the material verbatim between markers.
 *
 * Deterministic for the same material, which is what lets `--dry-run` show
 * the exact text a paid call would send.
 */
export function buildPrompt(material: readonly DraftMaterial[]): string {
  const fields = ORDER.map((key) => `- \`${key}\`: ${BRIEFS[key]}`).join("\n");
  const blocks = material.map(
    (part) => `<<< ${part.destination}\n${part.text.trimEnd()}\n>>> ${part.destination}`
  );

  return `${TASK}

${fields}

# The material, part by part

${blocks.join("\n\n")}
`;
}
