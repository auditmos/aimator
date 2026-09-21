import { effectLength, musicLength } from "../audio-model/index.js";
import { err, ok, type Result } from "../result.js";
import type { ShotList, ShotListShot } from "../shot-list/index.js";

/**
 * Internal to the sound-design module: the verdict on the cue sheet, pure and
 * offline.
 *
 * **This is where stage 10 parts company with stage 9, and the parting is not
 * a concession.** Stage 9's script is honest by construction: an utterance is
 * lifted, never invented, and the validator proves it by finding every
 * sentence word for word inside the shot it names. Nothing of the kind is
 * available here, and pretending otherwise would be worse than admitting it.
 * A music prompt is an **instruction**, which rule 9 writes in English; the
 * `Audio` prose it is written from is **material**, which rule 9 forbids
 * translating. So the sentence cannot be copied across in either direction,
 * and there is no verbatim match to look for.
 *
 * The precedent that does apply is **stage 4's**. That stage also writes
 * English instructions out of a Polish shot list, also sends the two side by
 * side in one bilingual request, and also judges its own answer with a
 * verdict that **never reads a prompt**, only the wiring around it. Stage 10
 * takes the same bargain:
 *
 * | proved here | left to the human |
 * |---|---|
 * | every cue names shots that exist | whether the English says what the Polish says |
 * | a cue's declared shots are exactly the shots its seconds cover | whether it is good music |
 * | the bed covers the film end to end, without gap or overlap | |
 * | every length is one the provider will render | |
 *
 * The second row is what carries the weight "lifted, not invented" carries one
 * stage up. It cannot prove faithfulness, but it proves the model walked the
 * whole plan: a shot silently dropped and a shot invented both come out as a
 * mismatch between what a cue claims and what its seconds actually cover.
 *
 * **Rule 9 is not enforced here, and that is the precedent rather than a
 * lapse.** The instruction tells the model to answer in English, exactly as
 * stage 4's does, and stage 4's validator does not check the language either,
 * it is the one that established "never reads a prompt". A check was tried and
 * removed: the only cheap test is for the film language's own letters, and a
 * Polish sentence can be written without a single one of them, so it would
 * have refused honest English quoting a name while letting pasted Polish
 * through. A guard that fails in both directions is worse than the human who
 * reads the sheet before a single second of audio is bought.
 */

const SECTIONS = ["Plan", "Music", "Effects", "Review"] as const;
const SECTION = /^##\s+(.+?)\s*$/;
const MUSIC_HEADING =
  /^###\s+(\S+)\s*\|\s*([^|]+?)\s*\|\s*(-?\d+(?:[.,]\d+)?)\s*-\s*(-?\d+(?:[.,]\d+)?)s\s*$/;
const EFFECT_HEADING =
  /^###\s+(\S+)\s*\|\s*(\S+)\s*\|\s*(-?\d+(?:[.,]\d+)?)s\s*\|\s*(-?\d+(?:[.,]\d+)?)s\s*$/;
const MUSIC_ID = /^M\d{2,}$/;
const EFFECT_ID = /^E\d{2,}$/;
const CODE_FENCE = /^\s*```/m;
const WHITESPACE = /\s+/g;
const SHOT_SEPARATOR = /\s*,\s*/;

/** One continuous stretch of score, and the one call that buys it. */
export interface MusicCue {
  /** Where it stops, in the seconds of the approved plan. Exclusive. */
  readonly end: number;
  readonly id: string;
  /** What the provider is rated on: the length of audio asked for. */
  readonly seconds: number;
  /** The shots this stretch covers, as the sheet declares them. */
  readonly shots: readonly string[];
  readonly start: number;
  /** The prompt itself, in English. Never read by this verdict. */
  readonly text: string;
}

/** One discrete sound, and the one call that buys it. */
export interface EffectCue {
  /** Where it begins, in the seconds of the approved plan. */
  readonly atSeconds: number;
  readonly id: string;
  readonly seconds: number;
  readonly shot: string;
  readonly text: string;
}

/** The sheet as data, what the buying and the mixing read instead of Markdown. */
export interface SoundDesignSheet {
  /** How many paid calls this sheet authorises. Printed beside the seconds. */
  readonly calls: number;
  readonly effects: readonly EffectCue[];
  readonly music: readonly MusicCue[];
  /** The whole bill, in the unit the provider actually rates: seconds of audio. */
  readonly totalSeconds: number;
}

interface ValidateInput {
  /** The approved plan. Every cue is measured against it and named out of it. */
  readonly shotList: ShotList;
  /** The sheet being judged. */
  readonly text: string;
}

class SoundDesignFormatError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`arkusz cue nie przechodzi walidacji:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "SoundDesignFormatError";
    this.problems = problems;
  }
}

function flatten(text: string): string {
  return text.replace(WHITESPACE, " ").trim();
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/**
 * The document's `## ` sections, in the order it wrote them.
 *
 * Parsed here rather than shared with stage 3 or stage 9, for the reason stage
 * 9 gives: three documents with three different section lists would share a
 * module whose whole content is one regular expression, which is the shallow
 * module `AGENTS.md` warns about.
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

/** The sheet, judged against the plan as it stands. */
export function validateSoundDesign(input: ValidateInput): Result<SoundDesignSheet> {
  const problems: string[] = [];

  if (CODE_FENCE.test(input.text)) {
    problems.push("dokument zawiera blok kodu, arkusz cue jest prozą i nagłówkami");
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
  const music = readMusic(found.get("Music") ?? "", input.shotList, problems);
  const effects = readEffects(found.get("Effects") ?? "", shots, input.shotList, problems);

  return problems.length > 0
    ? err(new SoundDesignFormatError(problems))
    : ok({
        calls: music.length + effects.length,
        effects,
        music,
        totalSeconds: round([...music, ...effects].reduce((total, cue) => total + cue.seconds, 0)),
      });
}

/** Which shots a stretch of the plan actually covers, in the plan's order. */
function shotsWithin(shotList: ShotList, start: number, end: number): readonly ShotListShot[] {
  return shotList.shots.filter((shot) => shot.start < end && shot.end > start);
}

function readMusic(body: string, shotList: ShotList, problems: string[]): readonly MusicCue[] {
  const blocks = splitBlocks(body);

  if (blocks.length === 0) {
    problems.push(
      'sekcja "Music" nie ma ani jednego cue, odcinek deklaruje muzykę, a arkusz bez niej jest brakiem, nie decyzją'
    );

    return [];
  }

  const cues: MusicCue[] = [];
  let covered = 0;

  for (const [index, block] of blocks.entries()) {
    const match = MUSIC_HEADING.exec(block.heading);

    if (match === null) {
      problems.push(
        `nagłówek "${block.heading.trim()}" nie ma kształtu "### M01 | U01,U02 | 0-30s"`
      );
      continue;
    }

    const [, id = "", listed = "", from = "", to = ""] = match;
    const expected = `M${String(index + 1).padStart(2, "0")}`;

    if (!MUSIC_ID.test(id)) {
      problems.push(`identyfikator "${id}" nie ma kształtu M01`);
      continue;
    }

    if (id !== expected) {
      problems.push(
        `cue ${id} stoi tam, gdzie oczekiwano ${expected}, numeracja biegnie po kolei od M01`
      );
    }

    const start = Number(from.replace(",", "."));
    const end = Number(to.replace(",", "."));

    // The bed tiles the film exactly, for the reason stage 3's clips tile it:
    // a gap is silence nobody asked for and an overlap is two pieces of music
    // playing at once, and neither is a decision anybody made.
    if (start !== covered) {
      problems.push(
        `${id} zaczyna się w ${start}s, a poprzedni podkład skończył się w ${covered}s, podkład kafeluje film bez dziur i bez zakładek`
      );
    }

    if (end <= start) {
      problems.push(`${id}: zakres ${start}-${end}s nie biegnie do przodu`);
      continue;
    }

    covered = end;

    const length = musicLength(round(end - start));

    if (!length.ok) {
      problems.push(`${id}: ${length.error.message}`);
      continue;
    }

    const cue: MusicCue = {
      end,
      id,
      seconds: length.data,
      shots: listed.split(SHOT_SEPARATOR).filter((one) => one !== ""),
      start,
      text: flatten(block.text),
    };

    checkShots(cue, shotsWithin(shotList, start, end), problems);
    checkText(cue.id, cue.text, problems);
    cues.push(cue);
  }

  if (cues.length > 0 && covered !== shotList.durationSeconds) {
    problems.push(
      `podkład kończy się w ${covered}s, a plan trwa ${shotList.durationSeconds}s, film bez muzyki na końcu jest ciszą, której nikt nie zamówił`
    );
  }

  return cues;
}

/**
 * Whether a cue names exactly the shots its seconds cover.
 *
 * This is the check that stands where stage 9's "lifted, never invented"
 * stands. It cannot read the prompt and does not try; what it proves is that
 * the model walked the whole plan, a shot it skipped and a shot it made up
 * both surface here as a disagreement between what the cue claims and what its
 * own seconds contain.
 */
function checkShots(cue: MusicCue, within: readonly ShotListShot[], problems: string[]): void {
  const actual = within.map((shot) => shot.id);
  const missing = actual.filter((id) => !cue.shots.includes(id));
  const invented = cue.shots.filter((id) => !actual.includes(id));

  if (missing.length > 0) {
    problems.push(
      `${cue.id} obejmuje ${cue.start}-${cue.end}s, więc leżą w nim ujęcia ${missing.join(", ")}, których nie wymienia, każde ujęcie ma być policzone, bo tylko to dowodzi, że model przeczytał cały plan`
    );
  }

  if (invented.length > 0) {
    problems.push(
      `${cue.id} wymienia ujęcia ${invented.join(", ")}, których nie ma w jego zakresie ${cue.start}-${cue.end}s`
    );
  }
}

function checkText(id: string, text: string, problems: string[]): void {
  if (text === "") {
    problems.push(`${id}: cue nie ma treści, nie ma czego zamówić`);
  }
}

function readEffects(
  body: string,
  shots: Map<string, ShotListShot>,
  shotList: ShotList,
  problems: string[]
): readonly EffectCue[] {
  const blocks = splitBlocks(body);

  if (blocks.length === 0) {
    problems.push(
      'sekcja "Effects" nie ma ani jednego cue, wszystkie cztery tryby dźwięku obejmują efekty, więc arkusz bez nich jest brakiem, nie decyzją'
    );

    return [];
  }

  const cues: EffectCue[] = [];
  let previous: EffectCue | null = null;

  for (const [index, block] of blocks.entries()) {
    const cue = readEffect(block, shots, shotList, index, problems);

    if (cue === null) {
      continue;
    }

    // Effects run forward like the film. Unlike speech they may overlap, two
    // things can happen at once, and only a narrator cannot talk over himself.
    if (previous !== null && cue.atSeconds < previous.atSeconds) {
      problems.push(
        `${cue.id}: zaczyna się w ${cue.atSeconds}s, czyli wcześniej niż ${previous.id} w ${previous.atSeconds}s, efekty biegną do przodu`
      );
    }

    cues.push(cue);
    previous = cue;
  }

  return cues;
}

function readEffect(
  block: Block,
  shots: Map<string, ShotListShot>,
  shotList: ShotList,
  index: number,
  problems: string[]
): EffectCue | null {
  const match = EFFECT_HEADING.exec(block.heading);

  if (match === null) {
    problems.push(`nagłówek "${block.heading.trim()}" nie ma kształtu "### E01 | U03 | 16s | 3s"`);

    return null;
  }

  const [, id = "", shotId = "", anchor = "", length = ""] = match;
  const expected = `E${String(index + 1).padStart(2, "0")}`;

  if (!EFFECT_ID.test(id)) {
    problems.push(`identyfikator "${id}" nie ma kształtu E01`);

    return null;
  }

  if (id !== expected) {
    problems.push(
      `cue ${id} stoi tam, gdzie oczekiwano ${expected}, numeracja biegnie po kolei od E01`
    );
  }

  const shot = shots.get(shotId);

  if (shot === undefined) {
    problems.push(`${id}: ujęcie "${shotId}" nie istnieje w zatwierdzonej liście ujęć`);

    return null;
  }

  const atSeconds = Number(anchor.replace(",", "."));
  const seconds = effectLength(round(Number(length.replace(",", "."))));

  // The anchor is a second of the approved plan, so it has to sit inside the
  // shot that claims it, the same rule stage 9 gives an utterance, and for
  // the same reason: an effect belongs to what is on screen when it happens.
  if (atSeconds < shot.start || atSeconds >= shot.end) {
    problems.push(
      `${id}: kotwica ${atSeconds}s leży poza ujęciem ${shotId} (${shot.start}-${shot.end}s)`
    );
  }

  if (!seconds.ok) {
    problems.push(`${id}: ${seconds.error.message}`);

    return null;
  }

  if (round(atSeconds + seconds.data) > shotList.durationSeconds) {
    problems.push(
      `${id}: kończy się w ${round(atSeconds + seconds.data)}s, a plan trwa ${shotList.durationSeconds}s, skróć efekt albo przesuń jego kotwicę`
    );
  }

  const text = flatten(block.text);

  checkText(id, text, problems);

  return { atSeconds, id, seconds: seconds.data, shot: shotId, text };
}
