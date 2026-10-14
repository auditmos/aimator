# Stage 0 from an import

Loaded when the user brings a Word document (a treatment, a series bible) or names an import.
What an import is, what it writes and what it refuses: [docs/import.md](../../../../docs/import.md).
The words for it are in [the glossary](../../../../docs/slownik.md#import).

An import is **material, not decisions**. Conversion copied the document; the grouping, if
somebody bought one, only said which section goes where. Nobody decided anything in
`imports/`, so whatever you carry into `project.md` from it is a proposal the user confirms,
exactly like a suggestion of your own. Material stays in its author's language (rule 9).

## Read it before you ask

```sh
aimator import list --json                # the imports, and the workspace root
aimator import show <import-id> --json    # sections, images, grouped files, notices
```

Paths in `show` are relative to the root `list` names. Read `material.md` and every grouped
file as files. Tell the user every notice: a part conversion left out, a hand edit, a grouping
older than the material. A document not imported yet is free to bring in: name
`aimator import add <import-id> --source <plik.docx>`. A conversion error is fixed by the user
in `material.md`, before any grouping; never edit anything under `imports/` yourself.

## The grouping is paid

An empty `grouped` means nobody bought one. **Never buy it**: name
`aimator import group <import-id> --dry-run`, as you would a voice sample. The interview works
from `material.md` alone; a grouping only saves reading it.

## What each grouped file proposes

- `series.md`: the premise, the world, the tone and the audience.
- `style.md`: the look. The Style Bible is still written from the user's answers to the
  questions of section 2, in English; the material only suggests them, and a studio, film or
  artist name in it still never enters the file.
- `characters/<id>.md`: one recurring character each. The id came from a heading
  (`tata-miko-poli-i-tosi`), so propose a short id and a `--name`; the user decides both. The
  roster is the user's: someone the grouping missed may still recur, and someone it found may not.
- `episodes/NN-slug.md`: one episode's source each, its number and slug a proposal. Once the
  user confirms them, `episode add <project-id> --source <root>/imports/<import-id>/grouped/episodes`
  adds every file there at once. Another number or slug means the user saves the file under
  that name elsewhere. An episode file links its pictures (storyboards); the copy in the project
  does not carry them, and stage 1 reads text alone.
- `other.md`: what the grouping could not place. Read it with the user; nothing in it vanishes
  unmentioned.

## Pictures

A picture in the material shows what somebody drew or chose; it decides nothing. Look at it
before you speak about it, and use it only where the user says so. Each one lies at
`<root>/imports/<import-id>/images/I01.png`, under the id `show` gives it:

- a character's look: `character add <project-id> <character-id> --source <picture>`, which
  makes photographs that character's basis. A picture of several characters is a source for
  each one only when the user says it is;
- a style image: `project style <project-id> --source <picture>`, which takes PNG alone.
