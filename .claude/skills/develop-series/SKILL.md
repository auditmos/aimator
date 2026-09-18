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
   appearance and wardrobe, any recurring cast, and the visual style. Ask early whether
   they have photographs of a real person to build the character from, because that single
   answer decides how much work is left in this session:

   - **Photographs.** The character stage starts from those files. Settle the style and the
     recurring wardrobe; the face arrives with the photos.
   - **Description.** No photograph exists anywhere later in the pipeline. Everything the
     character stage will have is the prose written now — so finish the visual brief below
     before this session ends.

   Record neither as approved material. Stage 0 writes the decision itself; the photographs
   are only ever inspected in the character stage.

   Whatever recurring characters, objects and places come up while answering this go on the
   running list described below — **in both branches**. A photograph fixes a face; it never
   fixes an object or a room, so those need prose either way.
4. **Aspect ratio, opening composition, continuity.** What must stay constant between
   scenes and episodes.
5. **Any other binding constraint** they consider non-negotiable.

Then check they can answer the five episode settings: duration in whole seconds 1–3600;
audio mode; screenplay language; subtitles language or `none`; and what their source file
actually is — an idea, a synopsis or a finished screenplay. If they can, the session is
done. If a settings answer is genuinely undecided, that is fine too — `prepare-project`
will ask again and `aimator check` will hold the line.

## The running list, and the brief it has to close

Nothing downstream invents appearance: the image model receives this prose and nothing
else, and whatever the prose leaves open it fills in differently on every single run.
Choosing "no photographs" widens that to the characters themselves — their look moves into
this conversation, because there is no file anywhere later that holds it.

Closing that gap is still the same conversation: one question at a time, still offering
options, still not asking anyone to justify taste.

**Keep a running list.** Any answer can introduce a recurring character, object or place.
Add each one to a list the moment it appears, and treat that list — not this page — as the
set of things that must be described before the session ends. It holds whatever this
particular interview surfaced: one series has three recurring characters and no objects,
another has a single character and four. Nothing belongs on the list because you expected
it, and nothing stays off it because you did not.

Only the main character is on the list from the start. Everything else is there because the
user put it there, and how much detail an entry needs follows how often it will be on
screen, not what kind of thing it is.

With photographs, the photos settle face and body, so skip that row — proportions and
wardrobe are still yours, because a photograph fixes who someone is, not how stylised the
drawing of them is nor what they wear in every episode. With a description all three rows
are yours. The object and place rows apply either way.

**Naming a thing is not describing it, and the difference is the whole point.** "Nosi ten
sam strój" and "ma swój przedmiot" are inventory, not appearance; a renderer given only
those draws something new each time. So whenever an answer puts something on the list, that
element becomes its own question before you move on. Two exchanges, not one.

Work down the list until each entry is something a renderer could act on:

- **Proportions and degree of stylisation**, for every character on the list. Head-to-body
  ratio, how deformed or naturalistic the figure is. This is the strongest stylistic tell
  and the easiest to skip, because people describe colour first. Ask it separately from the
  aspect ratio; in Polish both are "proporcje" and the two get confused.
- **Face and body**, for every character on the list. Age read, build, skin tone, hair
  colour, hair shape and length, eyes, distinguishing features. An age and a role together
  are a casting note, not an appearance.
- **The recurring wardrobe**, for every character on the list. The exact outfit that returns
  every episode: garments, cut, colours. In flat or stylised 2D the outfit carries
  recognition more reliably than the face, so this one is not optional.
- **Every recurring object on the list.** Ask first whether any object recurs at all — many
  series have none, and inventing one is not your job. For each that does: what it is, its
  size against the character, shape, material, colour, wear, and whatever makes it *that*
  one rather than a generic one. An object the story leans on earns as much detail as a
  character, because it will be in as many frames.
- **Every recurring place on the list.** What is fixed in it: palette, light, and the
  furnishings that may not move between episodes.
- **The visual style**, below. That one applies whichever basis they chose.

The boundary is recurrence, not subject matter. Ask yourself: would this have to look the
same in episode seven? Then it belongs here. The episode's own locations, its one-off
objects and every shot still belong to later stages, derived from the screenplay.

Before handing off, re-read the list. Any entry named but not described is an unasked
question, not a finished session.

If they truly cannot answer one of these yet, that is allowed — but say plainly that the
character stage will then have to invent it, and will invent it differently each run.

## Where to be gently insistent

Everywhere else a soft answer is fine. In two places it is not, and the reason is worth
saying out loud to the user:

**The visual style and the protagonist's fixed appearance become image prompts.** An image
model reads "ładny, klimatyczny" as nothing at all and fills the gap itself — differently
every run, which is exactly the drift people call hallucination. So keep asking, kindly,
until the answer names things a renderer can act on: stylised 3D or 2D, figure proportions,
how faces are treated, palette, lighting, how much realism, what is explicitly unwanted.

Figure proportions belong here even when photographs exist: a photograph fixes who the
character is, never how stylised the drawing of them should be.

**The aspect ratio is a hard requirement.** It has no default, it cannot be changed after
images exist without invalidating them, and stage 0 will not pass without it.

**Where the character comes from is a hard requirement too.** Photographs or description —
stage 0 will not pass while it is undecided, because an empty photo directory cannot tell
"deliberately none" apart from "not supplied yet". And when the answer is description, the
characters' own rows become as binding as the style, for the same reason: they are the only
input the character stage will ever get. The object and place entries on the list bind
whichever way that question went — no photograph ever described a room.

Everything else — the plot, the episode's own locations, its one-off props — is deliberately
**not** settled here. Those are derived from the story by later stages, not invented up front.

## What this session must not do

- **Do not develop the episode's plot.** If the user starts telling you the story, listen
  and note it, but do not turn it into a synopsis or a scene list. Stage 1 develops the
  story from the source file, and it must do so from an artifact, not from this
  conversation. An idea alone is a legitimate source.
- **Do not describe the episode's own locations, props or shots.** Those become reference
  images derived from the shot list, several stages later. What recurs across every episode
  is a different matter and belongs here — that distinction is the whole of the section
  above, not a loophole around this rule.
- Do not choose a model, mention an API key, or promise what a generator will produce.

## Hand off

End with four things:

1. **The decisions**, restated as a short list, marked as theirs to confirm — including
   whether the character comes from photographs or from the description, and the running
   list with every entry's description attached. Restate only what they introduced; an
   entry you added on your own is a proposal and says so.
2. **What is still open**, listed separately and honestly — an open matter is not a failure
   of this session, it is information stage 0 needs.
3. **What nothing downstream will fill in**, if anything in the brief stayed open. Say it
   once, plainly, without nagging.
4. **The next step**: run `prepare-project`, which will save these as `project.md` and the
   episode configuration. Offer to continue straight into it.

Do not summarise a decision the user never made. If this session ends with three answers
and two shrugs, say that.
