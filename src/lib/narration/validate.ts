import { err, ok, type Result } from "../result.js";
import type { ShotList, ShotListShot } from "../shot-list/index.js";
import { billedCharacters, utteranceLength } from "../voice-model/index.js";

/**
 * Internal to the narration module: the verdict on the script, pure and offline.
 *
 * One rule here is the whole reason stage 9 has a script at all, and it is
 * worth stating before the rest: **an utterance is lifted, never invented.**
 * Every line's text has to occur, word for word, inside the shot it names.
 *
 * That is what makes the script a derivation rather than a second version of
 * the same truth. The narrator's sentences already exist — stage 1's prompt
 * asks for them in the film's language whenever the episode's sound mode
 * permits speech, and stage 3 carries them into each shot's `Audio` prose. What
 * does not exist is any machine-readable form of them: they sit in a sentence
 * that also describes the music, the rain and the thunder, and pulling them out
 * with a parser would be a parser over prose — the thing stage 3 refused when
 * it made cast ids the binding instead of names, and stage 4 refused when it
 * put the dependency graph in JSON instead of in sentences.
 *
 * So a model does the lifting, because reading prose is what a model is for,
 * and this function proves the lift was a lift. A sentence the shot list does
 * not contain fails here, which means stage 9 cannot put words in the film that
 * nobody approved — and an edited shot list stops the script validating rather
 * than silently disagreeing with it.
 *
 * What the model genuinely adds is the part no approved artifact holds: an id
 * per utterance, and the second of the plan each one is anchored at. That is
 * the same thing stage 4's manifest adds over the shot list, one level down.
 */

const SECTIONS = ["Plan", "Lines", "Review"] as const;
const HEADING = /^###\s+(\S+)\s*\|\s*(\S+)\s*\|\s*(-?\d+(?:[.,]\d+)?)s\s*$/;
const SECTION = /^##\s+(.+?)\s*$/;
const UTTERANCE_ID = /^N\d{2,}$/;
const CODE_FENCE = /^\s*```/m;
const WHITESPACE = /\s+/g;

/** One thing the narrator says, and where on the plan's timeline it starts. */
export interface NarrationLine {
  /** Where this line begins, in the seconds of the approved plan. */
  readonly atSeconds: number;
  /** What the provider bills for this line. */
  readonly characters: number;
  readonly id: string;
  /** The shot whose `Audio` this sentence was lifted out of. */
  readonly shot: string;
  /** The sentence, verbatim, in the film's own language. */
  readonly text: string;
}

/** The script as data — what the buying and the mixing read instead of Markdown. */
export interface NarrationScript {
  /** Every line in the order they are spoken, which is the order of the film. */
  readonly lines: readonly NarrationLine[];
  /** The whole bill, in the unit the provider actually charges. */
  readonly totalCharacters: number;
}

interface ValidateInput {
  /** The approved plan. Every anchor lands in it and every sentence comes from it. */
  readonly shotList: ShotList;
  /** The script being judged. */
  readonly text: string;
}

class NarrationFormatError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `skrypt narracji nie przechodzi walidacji:\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "NarrationFormatError";
    this.problems = problems;
  }
}

/** Whitespace collapsed, so a line wrapped at a different column still matches. */
function flatten(text: string): string {
  return text.replace(WHITESPACE, " ").trim();
}

/**
 * The document's `## ` sections, in the order it wrote them.
 *
 * Parsed here rather than shared with stage 3: the two documents have different
 * sections and a shared splitter would be a module whose whole content is one
 * regular expression, which is the shallow module `AGENTS.md` warns about.
 */
function sections(text: string): Map<string, string> {
  const found = new Map<string, string>();
  let current: string | null = null;
  let body: string[] = [];

  for (const line of text.split("\n")) {
    const heading = SECTION.exec(line);

    if (heading === null) {
      body.push(line);
      continue;
    }

    if (current !== null) {
      found.set(current, body.join("\n"));
    }

    current = heading[1] ?? "";
    body = [];
  }

  if (current !== null) {
    found.set(current, body.join("\n"));
  }

  return found;
}

/**
 * The script, judged against the plan as it stands.
 *
 * It parses as it validates and returns what it parsed, for the reason stage 3
 * gives: a `narration.json` beside the file a human corrects would be two
 * versions of one truth, and the one that gets corrected is the other one.
 */
export function validateNarration(input: ValidateInput): Result<NarrationScript> {
  const problems: string[] = [];

  if (CODE_FENCE.test(input.text)) {
    problems.push("dokument zawiera blok kodu — skrypt narracji jest prozą i nagłówkami");
  }

  const found = sections(input.text);
  const order = [...found.keys()].filter((name) => SECTIONS.includes(name as "Plan"));

  for (const [index, name] of SECTIONS.entries()) {
    const body = found.get(name);

    if (body === undefined) {
      problems.push(`brak sekcji "${name}"`);
    } else if (flatten(body) === "") {
      problems.push(`sekcja "${name}" jest pusta`);
    }

    if (order[index] !== undefined && order[index] !== name) {
      problems.push(`sekcja "${order[index]}" stoi tam, gdzie oczekiwano "${name}"`);
    }
  }

  const shots = new Map(input.shotList.shots.map((one) => [one.id, one]));
  const lines = readLines(found.get("Lines") ?? "", shots, problems);

  return problems.length > 0
    ? err(new NarrationFormatError(problems))
    : ok({
        lines,
        totalCharacters: lines.reduce((total, line) => total + line.characters, 0),
      });
}

function readLines(
  body: string,
  shots: Map<string, ShotListShot>,
  problems: string[]
): readonly NarrationLine[] {
  const blocks = splitBlocks(body);

  if (blocks.length === 0) {
    problems.push(
      'sekcja "Lines" nie ma ani jednej kwestii — odcinek z narracją, w którym narrator nic nie mówi, nie jest decyzją, tylko brakiem'
    );

    return [];
  }

  const lines: NarrationLine[] = [];
  let previous: NarrationLine | null = null;

  for (const [index, block] of blocks.entries()) {
    const line = readLine(block, shots, index, problems);

    if (line === null) {
      continue;
    }

    // Narration runs forward, like the film. Two lines out of order would mean
    // a mix whose second sentence starts before its first, which no arithmetic
    // downstream can straighten out.
    if (previous !== null && line.atSeconds <= previous.atSeconds) {
      problems.push(
        `${line.id}: zaczyna się w ${line.atSeconds}s, czyli nie później niż ${previous.id} w ${previous.atSeconds}s — narracja biegnie do przodu`
      );
    }

    lines.push(line);
    previous = line;
  }

  return lines;
}

interface Block {
  readonly heading: string;
  readonly text: string;
}

function splitBlocks(body: string): readonly Block[] {
  const blocks: Block[] = [];
  let heading: string | null = null;
  let text: string[] = [];

  for (const line of body.split("\n")) {
    if (line.startsWith("### ")) {
      if (heading !== null) {
        blocks.push({ heading, text: text.join("\n") });
      }

      heading = line;
      text = [];
      continue;
    }

    if (heading !== null) {
      text.push(line);
    }
  }

  if (heading !== null) {
    blocks.push({ heading, text: text.join("\n") });
  }

  return blocks;
}

function readLine(
  block: Block,
  shots: Map<string, ShotListShot>,
  index: number,
  problems: string[]
): NarrationLine | null {
  const match = HEADING.exec(block.heading);

  if (match === null) {
    problems.push(`nagłówek "${block.heading.trim()}" nie ma kształtu "### N01 | U01 | 0s"`);

    return null;
  }

  const [, id = "", shotId = "", anchor = ""] = match;
  const expected = `N${String(index + 1).padStart(2, "0")}`;

  if (!UTTERANCE_ID.test(id)) {
    problems.push(`identyfikator "${id}" nie ma kształtu N01`);

    return null;
  }

  if (id !== expected) {
    problems.push(
      `kwestia ${id} stoi tam, gdzie oczekiwano ${expected} — numeracja biegnie po kolei od N01`
    );
  }

  const shot = shots.get(shotId);

  if (shot === undefined) {
    problems.push(`${id}: ujęcie "${shotId}" nie istnieje w zatwierdzonej liście ujęć`);

    return null;
  }

  const atSeconds = Number(anchor.replace(",", "."));

  // The anchor is a second of the approved plan, so it has to be inside the
  // shot that claims it. The end is exclusive: a line beginning on the frame a
  // shot hands over belongs to the next one.
  if (atSeconds < shot.start || atSeconds >= shot.end) {
    problems.push(
      `${id}: kotwica ${atSeconds}s leży poza ujęciem ${shotId} (${shot.start}-${shot.end}s)`
    );
  }

  const text = flatten(block.text);
  const length = utteranceLength(text);

  if (!length.ok) {
    problems.push(`${id}: ${length.error.message}`);

    return null;
  }

  // The rule this whole module stands on. A sentence the plan does not contain
  // is a sentence nobody approved, and the remedy is upstream: stage 1 writes
  // what the narrator says, stage 9 only decides which of it is spoken when.
  if (!flatten(shot.text).includes(text)) {
    problems.push(
      `${id}: tej kwestii nie ma w ujęciu ${shotId} — narracja jest podnoszona z zatwierdzonej listy ujęć, nigdy dopisywana; jeśli scenariusz ma powiedzieć coś nowego, poprawka należy do etapu 1`
    );
  }

  return {
    atSeconds,
    characters: billedCharacters(text),
    id,
    shot: shotId,
    text,
  };
}
