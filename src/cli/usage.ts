import { USAGE as APPROVE } from "./approve.js";
import { USAGE as CHECK } from "./check.js";
import { USAGE as LIST } from "./list.js";
import { USAGE as ASSEMBLY } from "./stages/assembly.js";
import { CAST_USAGE as CAST, USAGE as CHARACTER } from "./stages/character.js";
import { USAGE as CLIPS } from "./stages/clips.js";
import { USAGE as EPISODE } from "./stages/episode.js";
import { USAGE as NARRATION } from "./stages/narration.js";
import { USAGE as OPENING_FRAME } from "./stages/opening-frame.js";
import { USAGE as PROJECT } from "./stages/project.js";
import { USAGE as PROMPT_PACKAGE } from "./stages/prompt-package.js";
import { USAGE as REFERENCES } from "./stages/references.js";
import { USAGE as SCREENPLAY } from "./stages/screenplay.js";
import { USAGE as SHOT_LIST } from "./stages/shot-list.js";
import { USAGE as SOUND_DESIGN } from "./stages/sound-design.js";
import { USAGE as STATUS } from "./status.js";

/** The glossary of the flags several stages share. */
const FLAGS = `  --audio      music-and-effects | dialogue | narration | dialogue-and-narration
  --nature     law-or-idea | synopsis | screenplay
  --max-clip   najdłuższy planowany klip w sekundach (1–60); decyzja odcinka bez
               wartości domyślnej, wymagana dopiero przez etap 3
  --stage      zakres akceptacji; domyślnie prepare (etap 0)
  --track      tor modelu obrazowego; bez wartości domyślnej, bo każdy kosztuje osobno
  --artifact   card, hero albo nazwa widoku: front, slight-left, slight-right,
               three-quarter-left, three-quarter-right, profile-left,
               profile-right, rear`;

/** Why the cast is typed out rather than inferred from a screenplay. */
const CAST_NOTE = `Obsada jest jawną decyzją: wymień każdą powracającą postać przez "character new".
Postać widziana raz to referencja etapu 5, nie postać. Każda ma własną podstawę,
zdjęcia ("character add") albo opis w project.md ("character describe").`;

/** What every command accepts, whichever stage it belongs to. */
const GLOBAL = `Globalne:
  --workspace <ścieżka>  katalog artefaktów (domyślnie AIMATOR_WORKSPACE)
  --dry-run              pokaż, co powstanie, nie zapisuj niczego
  --help                 ten komunikat`;

/** The gates, said once, because every stage's refusal points back at them. */
const GATES = `Etapy 1 i 2 odmawiają płatnego wywołania, dopóki etap 0 nie ma review.status =
"approved". W etapie 2 osiem widoków czeka na zatwierdzoną kartę, a hero na
zatwierdzone widoki. Etap 3 czeka na zatwierdzony scenariusz i nie zależy od
etapu 2. Etap 4 czeka na zatwierdzoną listę ujęć i na zatwierdzony hero.png
każdej postaci, którą lista ujęć stawia w kadrze, na obu torach naraz, bo
pakiet jest jeden dla obu. Nic nie ponawia się samo; nową płatną próbę zaczyna
wyłącznie --regenerate, zachowując poprzedni wynik.`;

/**
 * One text, assembled from the fragments the stages own.
 *
 * `docs.test.ts` parses commands and flags out of `--help`, so this is a
 * contract rather than a greeting: a stage that grows a flag writes it in its
 * own file and the composition here does not change. Stage 0's block is the
 * one with three authors, because the `character` command straddles it and
 * stage 2, and a command is one file even when its subcommands are not one
 * stage.
 */
export const USAGE = [
  "Usage: aimator <command>",
  ["Etap 0. Przygotowanie projektu i odcinka:", PROJECT, CAST, EPISODE].join("\n"),
  SCREENPLAY,
  CHARACTER,
  SHOT_LIST,
  PROMPT_PACKAGE,
  REFERENCES,
  OPENING_FRAME,
  CLIPS,
  ASSEMBLY,
  NARRATION,
  SOUND_DESIGN,
  ["Wspólne:", LIST, STATUS, CHECK, APPROVE].join("\n"),
  FLAGS,
  CAST_NOTE,
  GLOBAL,
  GATES,
].join("\n\n");
