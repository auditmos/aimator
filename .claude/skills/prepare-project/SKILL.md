---
name: prepare-project
description: Run stage 0 of the animation pipeline — establish a project's shared creative rules and an episode's five production settings, then save them as the artifacts every later stage consumes. Use whenever someone wants to start a new animated project or series, add an episode to an existing one, or asks to "przygotuj projekt", "nowa seria", "nowy odcinek", "etap 0", "przygotowanie serii i odcinka". Also use when a later stage refuses because stage 0 is incomplete. Not for generating a screenplay, images, clips or the final cut — those are later stages and they call paid APIs.
---

# Stage 0 — prepare a project and an episode

A guided preparation step, not a generation step. You ask for creative decisions and
save the approved ones. **Nothing here calls a paid API.** Talk to the user in their
language; these instructions stay in English.

The mechanical work belongs to the CLI, the conversation belongs to you. Never
hand-write `project.json`, `episode.json` or `prepare.stage.json` — those carry digests
and provenance the tool computes. You author exactly one file by hand: `project.md`.

## 1. Read before you ask

Read `docs/pipeline.md` for the stage contract, then run `aimator check <project-id>`
for an existing project. Inspect the actual files under `$AIMATOR_WORKSPACE`.

Do not infer facts from other conversations, and do not borrow another project's story,
character, setting or runtime. If the user has not named the project or the episode
source, ask.

## 2. Collect decisions

First summarise what is **already** approved in the existing files and in this
conversation. Then ask only about what is missing or contradictory, in small groups.

Label every suggestion of yours as a proposal. A proposal the user has not answered is
not a decision, and writing it into `project.md` as though it were is the one failure
this stage exists to prevent.

For a new project establish:

1. the premise, and what a single episode tells relative to the others;
2. the shared world, period, tone and audience;
3. the protagonist's role and recurring appearance, any recurring cast, and the visual
   style. Ask where the character's look comes from — **photographs of a real person**, or
   **the description in `project.md`**. There is no third answer and no default, and the
   readiness gate blocks until one is recorded. Record real paths and the **actual**
   review status: never claim an approval or an inspection that did not happen;

   When the answer is the description, this prose is the only input the character stage
   will ever receive, so finish it here rather than leaving it to a later stage that has
   nowhere to look. Keep asking until each of these names something a renderer can act on:
   the protagonist's proportions — head-to-body ratio and how deformed the figure is, asked
   separately from the aspect ratio because in Polish both are "proporcje" — their face and
   body, the recurring wardrobe, every recurring character, each recurring prop, the
   recurring setting, and the visual style.

   Once there is more than one character, also record how they relate: how they scale
   against each other, whether their heads are the same size, and what is drawn identically
   across all of them. Two independent proportions never fix a relation, and the character
   stage draws each figure separately, so what nobody stated it will invent. `project.md`
   has a row for exactly this, and `aimator check` blocks while its marker is unfilled.

   Keep a running list of every recurring character, object and place the answers surface,
   and describe each entry on it. The list is whatever this interview produced — one series
   has several recurring characters and no objects, another the reverse — so never ask for
   an element the user has not introduced, and never let one they did introduce go
   unspecified. **Naming a recurring element is not describing it:** an object still needs
   its shape, size against the character, material, colour and wear, and one the story
   leans on earns as much detail as a character because it will be in as many frames.
   Before you write anything, re-read the list; an entry named but not described is an
   unasked question.

   What recurs across episodes belongs in the rules; this episode's own locations, one-off
   props and shots do not — those are derived from the screenplay several stages later. If
   something stays open, write it in the open section and say out loud that the character
   stage will otherwise invent it differently on every run;
4. the aspect ratio, and any binding opening-composition or continuity requirement;
5. any other binding creative constraint.

For each episode establish:

1. the source file and its nature — `law-or-idea`, `synopsis` or `screenplay`. An idea
   alone is enough; developing the story is stage 1's job, not the user's;
2. `durationSeconds` — a whole number from 1 to 3600;
3. `audio` — `music-and-effects`, `dialogue`, `narration` or `dialogue-and-narration`.
   All four include music and effects. If the user asks for something none of these
   covers, say so; **never silently map it onto the nearest mode**;
4. `language` — the code for the screenplay and any spoken lines. Required even for a
   film with no speech, because the screenplay document still has a language;
5. `subtitles` — a language code, or `none`. Decided **independently** of `language`.
   Explain that in a speechless film on-screen text means short captions, and that
   `none` also excludes title cards and any text the plot needs to be understood.

## 3. Save

```sh
aimator project init <project-id> --title "<tytuł>" --aspect-ratio 16:9
aimator character new <project-id> <character-id> --name "<nazwa>"
aimator character add <project-id> <character-id> --source <zdjęcie> [--source <zdjęcie>...]
aimator character describe <project-id> <character-id>
aimator episode add <project-id> --source <NN-tytul.md>
aimator episode set <project-id> <episode-id> --duration 60 --audio music-and-effects \
  --language pl --subtitles pl --nature law-or-idea
```

Add `--dry-run` to any of these to see what would be written without writing it.

**Declare every recurring character, not just the lead.** The roster is an explicit
decision and an empty one blocks the gate — a project with nobody in it used to mean
"exactly one, anonymous", which is how a series whose rules described two people produced
one. The criterion is recurrence: a character whose identity has to survive between
episodes belongs here; a face seen once is a stage-5 reference image instead. Ask the user
who comes back, and name each one. The `--name` is what the image stage puts in its prompt,
so it must be the word the rules use for that character.

`character add` and `character describe` are the two ways to answer the same question for
**one** character, and supplying a photograph counts as the answer. `character describe` is
not a formality: it records that no photograph is coming, which is what lets the gate
distinguish a decision from an omission. Different characters in one project may answer
differently.

`project init` scaffolds `project.md` with `TODO(etap-0)` markers. **Replace every marker
with the approved decisions** and delete the leading quote block. Keep unresolved,
non-blocking matters in their own section and clearly marked as open.

The episode source keeps its bytes. `episode add` copies it and records its digest, so
the file name must start with the episode number and a separator — `01-tytul.md`. The
number decides the output directory and must be unique within the project.

For an existing project, reuse its rules and create only the new episode. Do not replace
approved material with a fresh template. If the user changes an input that a later stage
already consumed, say which results now need re-checking — do not regenerate them.

Model choice and API keys are not part of these decisions and never belong in
`project.md`, in a prompt or in any artifact.

## 4. Hand off

```sh
aimator check <project-id>
aimator approve <project-id> [--note "<co zostało przeczytane>"]
```

`check` passes when the rules carry no markers, the aspect ratio and the character basis
are set, the recorded digests still match and every episode has all five decisions. That is
a **file** check: it does not confirm that the rules make sense or that the ideas are good.

`approve` is where somebody says they do. Run it only after the user has read the rules and
said yes — never on your own initiative, and never to make a report look finished. It
refuses anything `check` rejects, and it binds the approval to the bytes as they stand,
including `project.md`, which acquires its digest at this moment and at no earlier one.
Editing an approved artifact afterwards revokes the approval, and `check` will say so.

Report what was created, what was reused, what is still open, and the exact next command.
Stage 0 ends there.
