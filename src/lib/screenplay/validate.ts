import type { EpisodeSettings } from "../project/index.js";
import { err, ok, type Result } from "../result.js";

/**
 * Internal to the screenplay module: the structural verdict on a draft.
 *
 * Pure and offline on purpose. This is the half of stage 1 that has to be
 * right before any money is spent, and it is also the half that decides
 * whether a paid response may be published at all, so it must be runnable
 * against a file that already exists, with no network anywhere near it.
 *
 * Structure only. Whether the story is any good is a separate question that
 * no regular expression gets to answer.
 */

const MAX_SCENE_SECONDS = 15;

const SECTIONS = [
  "Premise",
  "Logline",
  "Synopsis",
  "Beats",
  "Characters and locations",
  "Scenes",
  "Review",
] as const;

const SCENES_INDEX = SECTIONS.indexOf("Scenes");

/**
 * What "this scene has no on-screen text" is allowed to look like.
 *
 * A model writing prose ends a sentence with a full stop, and `none.` is
 * punctuation rather than text on screen. An exact match threw away a paid
 * response that had obeyed the rule in all eight scenes. Still narrow: a
 * translated "brak" stays a failure, because the output contract says this
 * one word stays English.
 */
const NO_TEXT = /^none[.;]?$/i;

const SECTION_HEADING = /^## (.+)\r?$/gm;
const SCENE_HEADING = /^### S(\d{2,}) \| ([1-9]\d*)s \| (.+)\r?$/gm;
const ANY_SCENE_HEADING = /^### /gm;

const TEXT_FIELD = /^(?:- )?Text:([^\r\n]*)\r?$/gm;

/** A Markdown bullet is presentation; the field name is the contract. */
const FIELDS = [
  { label: "Action", pattern: /^(?:- )?Action:([^\r\n]*)\r?$/gm },
  { label: "Audio", pattern: /^(?:- )?Audio:([^\r\n]*)\r?$/gm },
  { label: "Text", pattern: TEXT_FIELD },
  { label: "End state", pattern: /^(?:- )?End state:([^\r\n]*)\r?$/gm },
] as const;

export interface ScreenplayVerdict {
  readonly durationSeconds: number;
  readonly longestSceneSeconds: number;
  readonly maxSceneSeconds: number;
  readonly minimumScenes: number;
  readonly scenes: number;
}

/**
 * One scene as a later stage reads it: its id, where it sits on the episode
 * timeline, and whether it carries on-screen text.
 *
 * Exported because stage 3 has to place every shot inside a scene, and a second
 * regular expression for the same heading format in another module is a pair of
 * parsers that can disagree about what a screenplay says.
 */
export interface ScreenplayScene {
  readonly end: number;
  readonly hasText: boolean;
  readonly id: string;
  readonly seconds: number;
  readonly start: number;
}

/**
 * Every structural problem one reading of a draft found, in the order found.
 *
 * One problem per round trip turned fixing a draft by hand into a loop of edit
 * and rerun, so the verdict collects whatever the document still lets it read.
 * The message is the problems joined, which is why a draft with one problem
 * reads exactly as it always did.
 */
class ScreenplayFormatError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(problems.join("; "));
    this.name = "ScreenplayFormatError";
    this.problems = problems;
  }
}

type Verdict<T> = Result<T, ScreenplayFormatError>;

function reject(problems: readonly string[]): Verdict<never> {
  return err(new ScreenplayFormatError(problems));
}

interface Scene {
  readonly body: string;
  readonly id: string;
  readonly number: number;
  readonly seconds: number;
}

/** How many scenes the duration needs once no scene may exceed the limit. */
export function minimumScenes(durationSeconds: number): number {
  return Math.ceil(durationSeconds / MAX_SCENE_SECONDS);
}

function scenesWord(count: number): string {
  const unit = count % 10;
  const teen = count % 100;

  if (count === 1) {
    return "scena";
  }

  return unit >= 2 && unit <= 4 && !(teen >= 12 && teen <= 14) ? "sceny" : "scen";
}

/**
 * The Scenes section, and every other section left empty.
 *
 * A wrong set or order of sections ends the reading, because nothing says
 * where the scenes begin; so does an empty Scenes section, which has nothing
 * to read. Any other empty section is a problem the scenes can be read past.
 */
function readSections(
  text: string
): Verdict<{ readonly empty: readonly string[]; readonly scenes: string }> {
  const headings = [...text.matchAll(SECTION_HEADING)];
  const names = headings.map((heading) => (heading[1] ?? "").trim());

  if (names.join("|") !== SECTIONS.join("|")) {
    return reject([
      `scenariusz ma niepoprawne sekcje albo ich kolejność, wymagane dokładnie, w tej kolejności: ${SECTIONS.join(", ")}`,
    ]);
  }

  const bodies = headings.map((heading, index) =>
    text.slice(
      (heading.index ?? 0) + (heading[0]?.length ?? 0),
      headings[index + 1]?.index ?? text.length
    )
  );
  const empty = bodies.flatMap((body, index) =>
    body.trim() === "" ? [`pusta sekcja: ${SECTIONS[index] ?? ""}`] : []
  );
  const scenes = bodies[SCENES_INDEX] ?? "";

  return scenes.trim() === "" ? reject(empty) : ok({ empty, scenes });
}

/** The scenes under well-formed headings; one heading that is not ends the reading. */
function readScenes(sceneText: string): Verdict<readonly Scene[]> {
  const headings = [...sceneText.matchAll(SCENE_HEADING)];
  const all = sceneText.match(ANY_SCENE_HEADING) ?? [];

  if (headings.length === 0 || all.length !== headings.length) {
    return reject([
      "brak scen albo niepoprawny nagłówek sceny, wymagany format: ### S01 | 15s | miejsce i pora dnia",
    ]);
  }

  return ok(
    headings.map((heading, index) => ({
      body: sceneText.slice(
        (heading.index ?? 0) + (heading[0]?.length ?? 0),
        headings[index + 1]?.index ?? sceneText.length
      ),
      id: heading[1] ?? "",
      number: Number(heading[1]),
      seconds: Number(heading[2]),
    }))
  );
}

/** What one scene's heading says wrong: its place in the sequence, its length. */
function headingProblems(scene: Scene, index: number): readonly string[] {
  return [
    ...(scene.number === index + 1
      ? []
      : [`sceny muszą mieć kolejne numery od S01, napotkano S${scene.id} na pozycji ${index + 1}`]),
    ...(scene.seconds > MAX_SCENE_SECONDS
      ? [
          `scena S${scene.id}: ${scene.seconds}s przekracza twardy limit ${MAX_SCENE_SECONDS}s na scenę`,
        ]
      : []),
  ];
}

/** One scene's fields: what is wrong with them, and whether it carries on-screen text. */
function readFields(
  scene: Scene,
  settings: EpisodeSettings
): { readonly onScreenText: boolean; readonly problems: readonly string[] } {
  const problems: string[] = [];
  let onScreenText = false;

  for (const field of FIELDS) {
    const matches = [...scene.body.matchAll(field.pattern)];
    const value = (matches[0]?.[1] ?? "").trim();

    // An empty duplicate must not pass, so empty occurrences are counted too.
    if (matches.length !== 1 || value === "") {
      problems.push(`scena S${scene.id}: wymagane dokładnie jedno niepuste pole ${field.label}`);
    } else if (field.label === "Text" && !NO_TEXT.test(value)) {
      if (settings.subtitles === "none") {
        problems.push(
          `scena S${scene.id}: tekst ekranowy mimo subtitles=none, jedyna dozwolona wartość pola Text to "none"`
        );
      } else {
        onScreenText = true;
      }
    }
  }

  return { onScreenText, problems };
}

/**
 * The scenes of an approved screenplay, placed on the episode timeline.
 *
 * Scene 1 starts at second 0 and each scene begins where the previous one
 * ended: the screenplay's own durations are the timeline, which is what lets
 * stage 3 check that its shots cover the episode without inventing a second
 * source of truth about when anything happens.
 */
export function readScreenplayScenes(
  text: string
): Result<readonly ScreenplayScene[], ScreenplayFormatError> {
  const sections = readSections(text);

  if (!sections.ok) {
    return sections;
  }

  const scenes = readScenes(sections.data.scenes);

  if (!scenes.ok) {
    return reject([...sections.data.empty, ...scenes.error.problems]);
  }

  const problems = [...sections.data.empty, ...scenes.data.flatMap(headingProblems)];
  const placed: ScreenplayScene[] = [];
  let cursor = 0;

  for (const scene of scenes.data) {
    const matches = [...scene.body.matchAll(TEXT_FIELD)];
    const value = (matches[0]?.[1] ?? "").trim();

    if (matches.length !== 1 || value === "") {
      problems.push(`scena S${scene.id}: wymagane dokładnie jedno niepuste pole Text`);
    }

    placed.push({
      end: cursor + scene.seconds,
      hasText: !NO_TEXT.test(value),
      id: `S${scene.id}`,
      seconds: scene.seconds,
      start: cursor,
    });
    cursor += scene.seconds;
  }

  return problems.length === 0 ? ok(placed) : reject(problems);
}

/**
 * The structural contract, checked against the episode's own decisions.
 *
 * Deliberately says nothing about quality: a draft that passes every rule
 * here is a correctly shaped draft and nothing more, which is why approval
 * is a separate command rather than a consequence of this function.
 *
 * It names every problem it can read, scene by scene, rather than the first;
 * a code fence, a wrong section order or a broken scene heading still ends
 * the reading, because nothing after it would be read correctly.
 */
export function validateScreenplay(
  text: string,
  settings: EpisodeSettings
): Result<ScreenplayVerdict, ScreenplayFormatError> {
  if (text.trim().startsWith("```")) {
    return reject(["scenariusz jest opakowany blokiem kodu, oczekiwano samego dokumentu Markdown"]);
  }

  const sections = readSections(text);

  if (!sections.ok) {
    return sections;
  }

  const scenes = readScenes(sections.data.scenes);

  if (!scenes.ok) {
    return reject([...sections.data.empty, ...scenes.error.problems]);
  }

  const problems = [...sections.data.empty];
  let onScreenText = false;

  for (const [index, scene] of scenes.data.entries()) {
    const fields = readFields(scene, settings);

    problems.push(...headingProblems(scene, index), ...fields.problems);
    onScreenText = onScreenText || fields.onScreenText;
  }

  const total = scenes.data.reduce((sum, scene) => sum + scene.seconds, 0);
  const required = minimumScenes(settings.durationSeconds);

  // The scene minimum is arithmetic rather than a rule of its own: with every
  // scene capped, a correct total cannot be reached by too few scenes. It is
  // named here because it tells the reader what a fix has to look like.
  if (total !== settings.durationSeconds) {
    problems.push(
      `suma czasów scen: ${total}s; wymagane dokładnie ${settings.durationSeconds}s, czyli co najmniej ${required} ${scenesWord(required)} po maks. ${MAX_SCENE_SECONDS}s`
    );
  }

  if (settings.subtitles !== "none" && !onScreenText) {
    problems.push(
      `żadna scena nie ma tekstu ekranowego mimo zamówionych napisów (subtitles=${settings.subtitles})`
    );
  }

  return problems.length === 0
    ? ok({
        durationSeconds: total,
        longestSceneSeconds: Math.max(...scenes.data.map((scene) => scene.seconds)),
        maxSceneSeconds: MAX_SCENE_SECONDS,
        minimumScenes: required,
        scenes: scenes.data.length,
      })
    : reject(problems);
}
