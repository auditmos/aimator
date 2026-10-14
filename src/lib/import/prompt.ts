import { z } from "zod";
import type { ResponseFormat } from "../text-model/index.js";
import type { MaterialSection } from "./material.js";

/**
 * Internal to the import module: the instruction half of the grouping call,
 * and the shape the provider is asked to return.
 *
 * The model is asked to route, never to write. It names where each section
 * goes and who the characters are, in the words the document already uses,
 * and the code copies the sections into the files that routing names. So
 * there is no prose here for a validator to doubt: everything it returns is
 * an id it can check against the material, which is why the check is complete.
 *
 * It sees no image. The call is text, so a picture travels with the section it
 * stands in, and nothing asks the model to place what it cannot look at.
 */

export const PROMPT_VERSION = 1;

/**
 * The answer. `routes` reads `series`, `style`, `other`, `character:<id>` or
 * `episode:<NN-slug>`; the provider's strict dialect takes no pattern, so
 * every such rule lives in `validate.ts`, where it can name what it refused.
 */
export const answerSchema = z.strictObject({
  characters: z.array(z.strictObject({ id: z.string(), name: z.string() })),
  sections: z.array(z.strictObject({ id: z.string(), routes: z.array(z.string()) })),
});

export type GroupingAnswer = z.infer<typeof answerSchema>;

/** Derived from `answerSchema`, for the reason stage 4 gives: one description of one shape. */
export const GROUPING_FORMAT: ResponseFormat = { name: "import_grouping", schema: jsonSchema() };

function jsonSchema(): Readonly<Record<string, unknown>> {
  const { $schema, ...rest } = z.toJSONSchema(answerSchema) as Record<string, unknown>;

  return rest;
}

const TASK = `# Task: sort an imported document by what each section is about

Somebody brought a document into a production pipeline for a short animated
series: a director's treatment, a series bible, or notes for one. It was
converted to Markdown and cut at every heading into sections, T01, T02, and so
on, in document order. What stands before the first heading is a section too.

Your only job is to say where each section belongs. **Write no text of your
own**: no summary, no title, no rewording, no translation. The code copies
every section, word for word, into the files your routing names, so anything
you would add has nowhere to go, and the material stays in the language it was
written in.

## Destinations

- \`series\`: what holds for the whole series: premise, world, theme, audience,
  format, tone, recurring rules.
- \`style\`: the look and sound: medium, rendering, palette, light, camera
  language, music and sound direction.
- \`character:<id>\`: one recurring character: who they are, how they look,
  move, speak and behave.
- \`episode:<NN-slug>\`: one episode's own story: its plot, scenes, beats and
  storyboards.
- \`other\`: what none of the above needs: schedule, budget, contacts, revision
  history, a table of contents.

A section may go to several destinations when it genuinely serves each of
them, for instance one that introduces the hero and the world at once. Do not
add a destination because a section mentions something in passing. \`other\`
stands alone: a section that goes anywhere else does not also go there.

## Ids

- Declare every character you route to in \`characters\`, once. \`name\` is the
  character's name **copied character for character** from a section you route
  to that character; it is checked against the text. \`id\` is that name in
  lowercase ASCII letters, digits and hyphens: "Miko" is \`miko\`, "Pani Zosia" is
  \`pani-zosia\`, "Łucja" is \`lucja\`. Declare nobody you route nothing to.
- An episode id is \`NN-slug\`: \`NN\` is a two-digit number counting the episodes
  in the order they first appear in the document, from \`01\` with no gaps; the
  slug is the episode's title in lowercase ASCII letters, digits and hyphens.
  The numbers are a proposal a person confirms later, so order is all they say.
- Images appear as links like \`![I01](images/I01.png)\`. You cannot see them;
  each one goes wherever the section it stands in goes.

## Before returning

Check that every section appears exactly once in \`sections\` with at least one
route, that no section id is invented, that every \`character:\` id is declared
and every declared character is routed to, that each name appears in a section
routed to that character, and that episode numbers start at 01 and rise in the
order the episodes first appear.`;

/**
 * Task, then each section verbatim between markers that carry its id.
 *
 * The material is cut, never edited: joined back, the sections are
 * `material.md`, whose digest is recorded beside the result. Deterministic for
 * the same material, which is what lets `--dry-run` show the exact text.
 */
export function buildPrompt(sections: readonly MaterialSection[]): string {
  const blocks = sections.map((section) => `<<< ${section.id}\n${section.text}\n>>> ${section.id}`);

  return `${TASK}

# The document, section by section

${blocks.join("\n\n")}
`;
}
