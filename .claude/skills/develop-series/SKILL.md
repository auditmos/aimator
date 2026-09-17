---
name: develop-series
description: Take a vague idea for an animated series to the point where stage 0 can be answered — premise, world, tone, audience, protagonist, visual style, aspect ratio. A gentle one-question-at-a-time development session, not a requirements interrogation. Use when someone wants to make an animated film or series but cannot yet answer what it is about, how it looks, or who it is for: "mam pomysł na serię", "chcę zrobić animację ale nie wiem", "pomóż mi to rozwinąć", "od czego zacząć", "rozwiń ten pomysł". Also use when `aimator check` blocks and the user does not know what to put in the rules. Not for developing a single episode's plot — that belongs to stage 1, which writes the screenplay. Not for saving anything: this session hands its results to `prepare-project`.
---

# Develop a series concept

The session that comes **before** stage 0. Someone has an idea; stage 0 needs decisions.
This is the bridge.

Talk to the user in their language; these instructions stay in English.

**You write nothing.** No files, no JSON, no `project.md`. This session ends by handing
its results to `prepare-project`, which owns every write. Two places where creative
decisions live is one place too many.

## Do not run this if it is not needed

First ask what they already have. If they can answer the project questions below without
help, say so plainly and go straight to `prepare-project`. An interview with someone who
already decided is wasted time and invites them to second-guess good instincts.

If a project already exists, read its `project.md` first and develop only what is still
open.

## How to ask

One question at a time. Wait for the answer before the next one — the answer to "kto to
ogląda" reshapes "jaki ton".

This is the user's own creative material, not a client's business requirement. Guide,
do not interrogate:

- **Offer concrete options instead of an open field.** "Świat współczesny, historyczny czy
  umowny?" beats "jaki jest świat?". A blank page is the thing that stalls people.
- **Proposing is fine — pretending is not.** You may suggest, invent, and offer three
  directions. Label every one as a proposal and never carry an unanswered proposal
  forward as though it were agreed.
- **"Nie wiem jeszcze" is a valid answer.** Park it, say you are parking it, move on.
  Only the aspect ratio and the five episode settings genuinely have to be resolved
  before stage 0; everything else can stay open and be marked as open.
- **Do not ask anyone to justify taste.** If they want a melancholic tone, that is the
  answer. Ask what it looks like on screen, not why they want it.
- **Restate a decision once, warmly, and move on.** Do not re-litigate something settled
  two questions ago.

## What to establish

These are exactly the five project-level decisions stage 0 records — nothing more:

1. **Premise and the episode rule.** What connects the episodes, and what a single one
   tells. This is the question that makes a series a series rather than a pile of films.
2. **World, period, tone, audience.**
3. **Protagonist and look.** Their role — participant, observer, narrator — recurring
   appearance and wardrobe, any recurring cast, and the visual style. Ask whether they
   have photographs of a real person to build the character from, because the character
   stage starts from real photos. Do not record any approval of that material here.
4. **Aspect ratio, opening composition, continuity.** What must stay constant between
   scenes and episodes.
5. **Any other binding constraint** they consider non-negotiable.

Then check they can answer the five episode settings: duration in whole seconds 1–3600;
audio mode; screenplay language; subtitles language or `none`; and what their source file
actually is — an idea, a synopsis or a finished screenplay. If they can, the session is
done. If a settings answer is genuinely undecided, that is fine too — `prepare-project`
will ask again and `aimator check` will hold the line.

## Where to be gently insistent

Everywhere else a soft answer is fine. In two places it is not, and the reason is worth
saying out loud to the user:

**The visual style and the protagonist's fixed appearance become image prompts.** An image
model reads "ładny, klimatyczny" as nothing at all and fills the gap itself — differently
every run, which is exactly the drift people call hallucination. So keep asking, kindly,
until the answer names things a renderer can act on: stylised 3D or 2D, how faces are
treated, palette, lighting, how much realism, what is explicitly unwanted.

**The aspect ratio is a hard requirement.** It has no default, it cannot be changed after
images exist without invalidating them, and stage 0 will not pass without it.

Everything else — the plot, the locations, the props — is deliberately **not** settled
here. Those are derived from the story by later stages, not invented up front.

## What this session must not do

- **Do not develop the episode's plot.** If the user starts telling you the story, listen
  and note it, but do not turn it into a synopsis or a scene list. Stage 1 develops the
  story from the source file, and it must do so from an artifact, not from this
  conversation. An idea alone is a legitimate source.
- **Do not describe locations, props or shots.** Those become reference images derived
  from the shot list, several stages later.
- Do not choose a model, mention an API key, or promise what a generator will produce.

## Hand off

End with three things:

1. **The decisions**, restated as a short list, marked as theirs to confirm.
2. **What is still open**, listed separately and honestly — an open matter is not a failure
   of this session, it is information stage 0 needs.
3. **The next step**: run `prepare-project`, which will save these as `project.md` and the
   episode configuration. Offer to continue straight into it.

Do not summarise a decision the user never made. If this session ends with three answers
and two shrugs, say that.
