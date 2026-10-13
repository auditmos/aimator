---
name: prepare-project
description: Run stage 0 of the animation pipeline — establish a project's shared creative rules, its cast including the narrator's voice when an episode narrates, and an episode's five production settings, then save them as the artifacts every later stage consumes. Use whenever someone wants to start a new animated project or series, add an episode to an existing one, or asks to "przygotuj projekt", "nowa seria", "nowy odcinek", "etap 0", "przygotowanie serii i odcinka". Also use when a later stage refuses because stage 0 is incomplete. Not for generating a screenplay, images, clips or the final cut — those are later stages and they call paid APIs.
---

# Stage 0 — prepare a project and an episode

A guided preparation step: you ask for creative decisions and save the approved ones.
**Nothing here calls a paid API.** Talk to the user in their language; these instructions
stay in English. Never hand-write a JSON file: the CLI computes their digests and provenance.
**You author exactly one file by hand: `project.md`.**

## 1. Read before you ask

```sh
aimator list --json                                     # projects and their episodes
aimator project show <project-id> --json                # cast, narrator, style images
aimator episode show <project-id> <episode-id> --json   # source and its six decisions
aimator check <project-id> --stage prepare --json       # the verdict on stage 0 alone
```

None of these writes anything. `show` is a description: an undecided field comes back as
`null`, a question to ask and never a value to fill in. `check` is the verdict, and its
`problems` are your agenda. Keep `--stage prepare`: with an episode id and no flag, `check`
glues stages 0, 1, 3 and 4. Read `project.md` and the episode's `source.md` as files, but
never the JSON files: the commands above are the contract that reads them. Borrow nothing
from another project or conversation, and if the project or the episode source is unnamed, ask.

## 2. Collect decisions

Summarise what is already decided, then ask only about what is missing or contradictory, in
small groups. Label every suggestion a proposal: one written into `project.md` as though the
user had answered it is the failure this stage exists to prevent. For a new project:

1. the premise, and what a single episode tells relative to the others;
2. the shared world, period, tone and audience;
3. the protagonist's role, every recurring character, the source of each one's look
   (**photographs** or **the description** in `project.md`, never a default), the Style Bible;
4. the aspect ratio, any opening composition, and what stays constant between scenes;
5. any other binding creative constraint.

When the conversation reaches the look of the series, read [docs/styl.md](../../../docs/styl.md)
and ask its questions rather than recite its method. Before naming a style or cast concept,
read [docs/slownik.md](../../../docs/slownik.md) and use its word, in conversation and in the
file. Before writing the Style Bible, read [its section](../../../docs/stages/00-przygotowanie.md#style-bible).
**Never record a studio, film or artist name**: it reaches the image provider verbatim.

<important if="a character's look comes from photographs">
Record them with `character add`. Nobody has inspected them yet: never write that anyone did.
</important>

<important if="a character's look comes from the description">
Record it with `character describe`: the prose in `project.md` is all the character stage gets.
</important>

Before writing `project.md`, check that each of these is closed in it, or sits in its open
section with a sentence saying the character stage will invent it differently every run:

- the roster holds every recurring character, under the word the rules use for it;
- every character has figure proportions, never confused with the aspect ratio, and a
  recurring wardrobe; one drawn from the description also has a face and a body;
- every recurring prop has shape, size against a character, material, colour and wear, and
  every recurring setting its fixed furnishings, palette and light, or the row says „brak";
- across characters: relative scale, whether their heads match, what is drawn the same on all;
- no entry is only named, and nothing on the list belongs to this episode alone.

When the conversation reaches an episode, read [the table of its
decisions](../../../docs/stages/00-przygotowanie.md#sześć-decyzji-odcinka) and establish each.
An idea alone is a valid source: the story is stage 1's job. If the user wants sound no
`--audio` mode covers, say so; never map it onto the nearest one. `--subtitles` is decided
apart from `--language`, and in a speechless film `none` also rules out title cards.

Once the Style Bible is settled, ask about style images, a project decision that stages 5 to 7
wait for; read [what each answer means](../../../docs/stages/00-przygotowanie.md#obrazy-stylu) first.

<important if="an episode's audio is narration or dialogue-and-narration">
**Who reads the series is casting**, recorded once per project as `narratorVoiceId`. Ask for
the provider's voice id and record it verbatim; never invent one or pick a default. How the
narrator reads is stage 9's direction, not yours. `aimator check` passes without a voice, so
if it is missing, say so in your report, or the user meets it several paid stages later.
</important>

## 3. Save

```sh
aimator project init <project-id> --title "<tytuł>" --aspect-ratio 16:9
aimator character new <project-id> <character-id> --name "<nazwa>"
aimator character add <project-id> <character-id> --source <zdjęcie> [--source <zdjęcie>...]
aimator character describe <project-id> <character-id>
aimator project style <project-id> --source <obraz.png>   # or --generated --count <n>, or --none
aimator episode add <project-id> --source <NN-tytul.md>
aimator episode set <project-id> <episode-id> --duration 60 --audio music-and-effects \
  --language pl --subtitles pl --nature law-or-idea --max-clip 6
aimator project voice <project-id> --voice-id <id głosu>   # only when an episode narrates
```

`--dry-run` shows what any of them would write. `episode set` changes only the flags it is
given, so pass exactly what the user changed, then read the result back with `show`.

`project init` scaffolds `project.md` with `TODO(etap-0)` markers: replace each with an
approved decision, delete the leading quote block, and keep what is open in its own section.
An episode source's file name starts with its number, unique in the project: `01-tytul.md`.
Model choice and API keys never belong in `project.md`, in a prompt or in any artifact.

<important if="the project already exists">
Reuse its rules and create only the new episode; never replace approved material with a
fresh template. If the user changes an input a later stage already consumed, read [the
contract](../../../docs/pipeline.md) and say which results need re-checking; regenerate none.
</important>

## 4. Hand off

Run `check` again, then `aimator approve <project-id> [--note "<co zostało przeczytane>"]`.
A pass is a file check, not a verdict on the rules. **Run `approve` only after the user has
read the rules and said yes**, never on your own initiative or to make a report look done.
It binds the yes to the bytes, so a later edit to `project.md` revokes it: tell the user the
rules they approved changed and must be read again, and never re-approve to clear the lapse.

Report what was created, what was reused, what is still open, and the exact next command.
Stage 0 ends there.
