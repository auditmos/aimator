---
name: develop-series
description: Take a vague idea for an animated series to the point where stage 0 can be answered — premise, world, tone, audience, protagonist, visual style, aspect ratio. A gentle one-question-at-a-time development session, not a requirements interrogation. Use when someone wants to make an animated film or series but cannot yet answer what it is about, how it looks, or who it is for: "mam pomysł na serię", "chcę zrobić animację ale nie wiem", "pomóż mi to rozwinąć", "od czego zacząć", "rozwiń ten pomysł". Also use when `aimator check` blocks and the user does not know what to put in the rules. Not for developing a single episode's plot — that belongs to stage 1, which writes the screenplay. Not for saving anything: this session hands its results to `prepare-project`.
---

# Develop a series concept

The session that comes **before** stage 0: someone has an idea, stage 0 needs decisions.
Talk to the user in their language; these instructions stay in English.

**You write nothing.** No files, no JSON, no `project.md`. `prepare-project` owns every
write, because two places where creative decisions live is one place too many.

## Do not run this if it is not needed

First ask what they already have. If they can answer the five decisions below, say so and go
straight to `prepare-project`: an interview would only make them second-guess good instincts.

<important if="a project already exists">
Read its `project.md` first and develop only what is still open.
</important>

## How to ask

One question at a time, waiting for each answer: "kto to ogląda" reshapes "jaki ton". This
is the user's own creative material, not a client's requirement. Guide, do not interrogate:

- **Offer concrete options, not an open field.** "Świat współczesny, historyczny czy
  umowny?" beats "jaki jest świat?". A blank page is what stalls people.
- **Proposing is fine, pretending is not.** Label every suggestion a proposal and never
  carry an unanswered one forward as agreed.
- **"Nie wiem jeszcze" is a valid answer.** Park it, say so, move on. What stage 0 cannot
  pass without is for `aimator check` to say, not for this session.
- **Do not ask anyone to justify taste.** Ask how a melancholic tone looks on screen, not why.
- **Restate a decision once, warmly, and move on.** Never re-litigate what is settled.

## What to establish: the five decisions stage 0 records, nothing more

1. **Premise and the episode rule:** what connects the episodes and what a single one tells.
2. **World, period, tone, audience.**
3. **Protagonist and look:** their role (participant, observer, narrator), the recurring
   cast, how they look, the visual style. Ask early whether there are photographs of a real
   person to build a character from; that answer decides how much is left to do here.
4. **Aspect ratio, opening composition, continuity:** what must stay constant between scenes
   and episodes. The aspect ratio cannot change once images exist without invalidating them.
5. **Any other binding constraint** they consider non-negotiable.

When the conversation reaches decision 3, read [references/elementy.md](references/elementy.md).
When it reaches the visual style, read [docs/styl.md](../../../docs/styl.md), ask its questions
rather than recite its method, and answer a studio, film or artist name with a proposed
decomposition from its "Zamiast → użyj" table, never with the name. Before naming a style or
cast concept, read [docs/slownik.md](../../../docs/slownik.md) and use the word it gives.

<important if="a character's look comes from photographs">
The face arrives with the photographs; the rest of the running list still needs prose.
Restate them as a decision, never as approved material: only stage 2 inspects them.
</important>

<important if="a character's look comes from a description">
No picture of that character exists anywhere later: the prose settled here is all the
character stage will ever get, so close every row of that entry.
</important>

## Where to be gently insistent

Everywhere else a soft answer is fine. Here it is not, and say why: **the visual style and
the fixed look of everything on the running list become image prompts**, and a model fills
"ładny, klimatyczny" in itself, differently every run. Ask until a renderer could act on it.

## What this session must not do

- **Do not describe the episode's own locations, props or shots:** later stages derive them.
- **Do not choose a model**, mention an API key, or promise what a generator will produce.

<important if="the user starts telling the episode's story">
Listen and note it, but do not turn it into a synopsis or a scene list. Stage 1 develops the
story from the source file, not from this conversation, and an idea alone is a valid source.
</important>

## Hand off

Before handing off, check they can answer [the episode's
settings](../../../docs/stages/00-przygotowanie.md#sześć-decyzji-odcinka); an undecided one is
fine, `prepare-project` asks again.

End with one block, spoken and never saved, shaped like `project.md`: its `##` sections in
order, each holding what this session settled for it. Take the headings, at hand-off, from the
project's own `project.md`, or else from [the template](../../../src/lib/project/template.ts);
never from memory, because a second copy of the template drifts from the first.

- Each decision is the user's, to confirm, including where each character's look comes from
  and every running-list entry with its description. Whatever you added is a proposal.
- The section for proposals and open matters lists what is still open, which stage 0 needs
  to know rather than a failure, and says once what nothing downstream will fill in.
- Never summarise a decision the user did not make. Three answers and two shrugs is the report.

Then offer to continue straight into `prepare-project`, which saves all of it.
