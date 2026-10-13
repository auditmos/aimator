import { err, ok, type Result } from "../result.js";
import type { ShotList, ShotListShot } from "../shot-list/index.js";

/**
 * Internal to the dialogue module: the verdict on the script, pure and offline.
 *
 * Stage 9's rule, made complete. A narrator's sentence sits in prose, so stage
 * 9 can prove a line was lifted and never that none was left behind. A
 * character's line does not: stage 3 writes it as `<cast-id>: "<line>"` and
 * `validateShotList` hands it over as data, so this verdict runs both ways.
 * Every line of the script is one the plan attributes to that character in
 * that shot, and every line the plan attributes is in the script exactly once.
 *
 * What the model adds is what no approved artifact holds: an id per line and
 * the second of the plan it begins at.
 */

const SECTIONS = ["Plan", "Lines", "Review"] as const;
const HEADING = /^###\s+(\S+)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(-?\d+(?:[.,]\d+)?)s\s*$/;
const SECTION = /^##\s+(.+?)\s*$/;
const LINE_ID = /^D\d{2,}$/;
const CODE_FENCE = /^\s*```/m;
const WHITESPACE = /\s+/g;

/** One line a character speaks, and where on the plan's timeline it starts. */
export interface DialogueLine {
  /** Where this line begins, in the seconds of the approved plan. */
  readonly atSeconds: number;
  /** The cast id of who speaks it. */
  readonly cast: string;
  readonly id: string;
  /** Whether the speaker is in the shot's `Cast`; lip-sync needs a face. */
  readonly onScreen: boolean;
  /** The shot whose `Audio` attributes this line. */
  readonly shot: string;
  /** The line, verbatim, in the film's own language. */
  readonly text: string;
}

/** The script as data, what the buying will read instead of Markdown. */
export interface DialogueScript {
  /** Every line in the order they are spoken, which is the order of the film. */
  readonly lines: readonly DialogueLine[];
  /**
   * What the script says without refusing: a speaker heard from off screen,
   * whom lip-sync will pass over because there is no face to move.
   */
  readonly notices: readonly string[];
}

interface ValidateInput {
  /** The roster's ids: who may speak at all. */
  readonly cast: readonly string[];
  /** The approved plan. Every anchor lands in it and every line comes from it. */
  readonly shotList: ShotList;
  /** The script being judged. */
  readonly text: string;
}

class DialogueFormatError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[], what = "skrypt dialogu") {
    super(`${what} nie przechodzi walidacji:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "DialogueFormatError";
    this.problems = problems;
  }
}

/** Which of the expected `## ` sections are missing, empty or out of order. */
function sectionProblems(
  found: ReadonlyMap<string, string>,
  expected: readonly string[]
): readonly string[] {
  const problems: string[] = [];
  const order = [...found.keys()].filter((name) => expected.includes(name));

  for (const [index, name] of expected.entries()) {
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

  return problems;
}

/** Whitespace collapsed, so a line wrapped at a different column still matches. */
function flatten(text: string): string {
  return text.replace(WHITESPACE, " ").trim();
}

/** The document's `## ` sections, in the order it wrote them. */
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

/** One line of the plan, the identity both directions of the check compare. */
function keyOf(shot: string, cast: string, text: string): string {
  return `${shot}|${cast}|${flatten(text)}`;
}

/**
 * The script, judged against the plan as it stands. Parses as it validates and
 * returns what it parsed, for the reason stage 3 gives about a second file.
 */
export function validateDialogue(input: ValidateInput): Result<DialogueScript> {
  const problems: string[] = [];

  if (CODE_FENCE.test(input.text)) {
    problems.push("dokument zawiera blok kodu, skrypt dialogu jest prozą i nagłówkami");
  }

  const found = sections(input.text);

  problems.push(...sectionProblems(found, SECTIONS));

  const shots = new Map(input.shotList.shots.map((one) => [one.id, one]));
  const lines = readLines(found.get("Lines") ?? "", { cast: input.cast, problems, shots });

  problems.push(...omitted(input.shotList, lines));

  return problems.length > 0
    ? err(new DialogueFormatError(problems))
    : ok({
        lines,
        notices: lines
          .filter((line) => !line.onScreen)
          .map(
            (line) =>
              `${line.id}: ${line.cast} mówi spoza kadru ${line.shot} (głos zza kadru), lip-sync tę kwestię pominie`
          ),
      });
}

/**
 * The other direction: every line the plan attributes, and how often the
 * script says it. A line said twice is as wrong as one never said, because the
 * film would hear it twice.
 */
function omitted(plan: ShotList, lines: readonly DialogueLine[]): readonly string[] {
  const planned = new Map<string, number>();

  for (const shot of plan.shots) {
    for (const line of shot.lines) {
      const key = keyOf(shot.id, line.cast, line.text);
      planned.set(key, (planned.get(key) ?? 0) + 1);
    }
  }

  const problems: string[] = [];
  const said = new Map<string, number>();

  // Counted in the script's order, so the repeat named is the later one. A line
  // the plan does not hold is invented rather than repeated, and `readLine`
  // has already said so.
  for (const line of lines) {
    const key = keyOf(line.shot, line.cast, line.text);
    const allowed = planned.get(key);
    const count = (said.get(key) ?? 0) + 1;

    said.set(key, count);

    if (allowed !== undefined && count > allowed) {
      problems.push(`${line.id}: kwestia powtórzona, w ujęciu ${line.shot} pada raz`);
    }
  }

  const found = new Map<string, number>();

  for (const shot of plan.shots) {
    for (const line of shot.lines) {
      const key = keyOf(shot.id, line.cast, line.text);
      const occurrence = (found.get(key) ?? 0) + 1;

      found.set(key, occurrence);

      if (occurrence > (said.get(key) ?? 0)) {
        problems.push(
          `${shot.id}: pominięto kwestię ${line.cast}: "${line.text}", skrypt podnosi każdą przypisaną kwestię listy ujęć dokładnie raz`
        );
      }
    }
  }

  return problems;
}

interface Context {
  readonly cast: readonly string[];
  readonly problems: string[];
  readonly shots: Map<string, ShotListShot>;
}

function readLines(body: string, context: Context): readonly DialogueLine[] {
  const lines: DialogueLine[] = [];
  let previous: DialogueLine | null = null;

  for (const [index, block] of splitBlocks(body).entries()) {
    const line = readLine(block, index, context);

    if (line === null) {
      continue;
    }

    // Dialogue runs forward, like the film: a line out of order would start
    // before the one it answers.
    if (previous !== null && line.atSeconds <= previous.atSeconds) {
      context.problems.push(
        `${line.id}: zaczyna się w ${line.atSeconds}s, czyli nie później niż ${previous.id} w ${previous.atSeconds}s, dialog biegnie do przodu`
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

function readLine(block: Block, index: number, context: Context): DialogueLine | null {
  const { problems } = context;
  const match = HEADING.exec(block.heading);

  if (match === null) {
    problems.push(`nagłówek "${block.heading.trim()}" nie ma kształtu "### D01 | U01 | ewa | 0s"`);

    return null;
  }

  const [, id = "", shotId = "", cast = "", anchor = ""] = match;
  const expected = `D${String(index + 1).padStart(2, "0")}`;

  if (!LINE_ID.test(id)) {
    problems.push(`identyfikator "${id}" nie ma kształtu D01`);

    return null;
  }

  if (id !== expected) {
    problems.push(
      `kwestia ${id} stoi tam, gdzie oczekiwano ${expected}, numeracja biegnie po kolei od D01`
    );
  }

  const shot = context.shots.get(shotId);

  if (shot === undefined) {
    problems.push(`${id}: ujęcie "${shotId}" nie istnieje w zatwierdzonej liście ujęć`);

    return null;
  }

  const atSeconds = Number(anchor.replace(",", "."));

  // The end is exclusive: a line beginning on the frame a shot hands over
  // belongs to the next one.
  if (atSeconds < shot.start || atSeconds >= shot.end) {
    problems.push(
      `${id}: kotwica ${atSeconds}s leży poza ujęciem ${shotId} (${shot.start}-${shot.end}s)`
    );
  }

  if (!context.cast.includes(cast)) {
    problems.push(
      `${id}: "${cast}" nie jest identyfikatorem obsady, dozwolone: ${context.cast.join(", ")}`
    );
  }

  const text = flatten(block.text);
  const attributed = shot.lines.filter((one) => flatten(one.text) === text);

  // The rule the module stands on, in its two failures: words the shot does
  // not attribute at all, and words it attributes to somebody else.
  if (attributed.length === 0) {
    problems.push(
      `${id}: tej kwestii nie ma w ujęciu ${shotId}, dialog jest podnoszony z zatwierdzonej listy ujęć, nigdy dopisywany; jeśli postać ma powiedzieć coś nowego, poprawka należy do etapu 1`
    );
  } else if (!attributed.some((one) => one.cast === cast)) {
    problems.push(
      `${id}: w ujęciu ${shotId} tę kwestię mówi ${attributed.map((one) => one.cast).join(", ")}, nie ${cast}`
    );
  }

  return { atSeconds, cast, id, onScreen: shot.cast.includes(cast), shot: shotId, text };
}

const TRANSLATION_SECTIONS = ["Lines", "Review"] as const;

interface TranslationInput {
  /** The accepted script in the film's language: what every block must match. */
  readonly source: readonly DialogueLine[];
  /** The translation being judged. */
  readonly text: string;
}

/**
 * The second-language script, judged against the accepted one, one to one.
 *
 * Purely structural, and on purpose: the same ids, shots, speakers and anchors,
 * none missing, none added, each with text. Whether the words are faithful is
 * not something a validator can know, so a human answers it at `approve`.
 * Each line keeps its source's `onScreen`, because who has a face to move does
 * not change with the language.
 */
export function validateTranslation(input: TranslationInput): Result<DialogueScript> {
  const problems: string[] = [];

  if (CODE_FENCE.test(input.text)) {
    problems.push("dokument zawiera blok kodu, przekład jest prozą i nagłówkami");
  }

  const found = sections(input.text);

  problems.push(...sectionProblems(found, TRANSLATION_SECTIONS));

  const source = new Map(input.source.map((line) => [line.id, line]));
  const lines: DialogueLine[] = [];

  for (const block of splitBlocks(found.get("Lines") ?? "")) {
    const line = readTranslatedLine(block, source, problems);

    if (line === null) {
      continue;
    }

    if (lines.some((one) => one.id === line.id)) {
      problems.push(`${line.id}: kwestia powtórzona, w skrypcie pada raz`);
      continue;
    }

    lines.push(line);
  }

  problems.push(...unmatched(input.source, lines));

  return problems.length > 0
    ? err(new DialogueFormatError(problems, "przekład skryptu dialogu"))
    : ok({ lines, notices: [] });
}

/** One translated block, checked against the line it claims to translate. */
function readTranslatedLine(
  block: Block,
  source: ReadonlyMap<string, DialogueLine>,
  problems: string[]
): DialogueLine | null {
  const match = HEADING.exec(block.heading);

  if (match === null) {
    problems.push(`nagłówek "${block.heading.trim()}" nie ma kształtu "### D01 | U01 | ewa | 0s"`);

    return null;
  }

  const [, id = "", shot = "", cast = "", anchor = ""] = match;
  const original = source.get(id);

  if (original === undefined) {
    problems.push(`${id}: takiej kwestii nie ma w dialogue.md, przekład niczego nie dopisuje`);

    return null;
  }

  const atSeconds = Number(anchor.replace(",", "."));
  const text = flatten(block.text);

  // A translation changes the words and nothing else: where a line sits and
  // who says it were accepted with the source, and lip-sync reads them.
  if (shot !== original.shot) {
    problems.push(
      `${id}: ujęcie ${shot}, w skrypcie ${original.shot}; przekład nie przenosi kwestii`
    );
  }

  if (cast !== original.cast) {
    problems.push(
      `${id}: mówi ${cast}, w skrypcie ${original.cast}; przekład nie zmienia mówiącego`
    );
  }

  if (atSeconds !== original.atSeconds) {
    problems.push(
      `${id}: kotwica ${atSeconds}s, w skrypcie ${original.atSeconds}s; przekład nie przesuwa kwestii`
    );
  }

  if (text === "") {
    problems.push(`${id}: pod nagłówkiem nie ma tekstu`);
  }

  return { ...original, text };
}

/** Every source line the translation left out, and an order it did not keep. */
function unmatched(
  source: readonly DialogueLine[],
  lines: readonly DialogueLine[]
): readonly string[] {
  const missing = source.filter((line) => !lines.some((one) => one.id === line.id));

  if (missing.length > 0) {
    return missing.map(
      (line) =>
        `brakuje ${line.id} (${line.shot}, ${line.cast}), przekład ma każdą kwestię skryptu dokładnie raz`
    );
  }

  const order = lines.map((one) => one.id).join(",");

  return order === source.map((one) => one.id).join(",")
    ? []
    : ["kwestie stoją w innej kolejności niż w dialogue.md"];
}
