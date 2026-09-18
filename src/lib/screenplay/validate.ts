import type { EpisodeSettings } from "../project/index.js";
import { err, ok, type Result } from "../result.js";

/**
 * Internal to the screenplay module: the structural verdict on a draft.
 *
 * Pure and offline on purpose. This is the half of stage 1 that has to be
 * right before any money is spent, and it is also the half that decides
 * whether a paid response may be published at all — so it must be runnable
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

/** A Markdown bullet is presentation; the field name is the contract. */
const FIELDS = [
  { label: "Action", pattern: /^(?:- )?Action:([^\r\n]*)\r?$/gm },
  { label: "Audio", pattern: /^(?:- )?Audio:([^\r\n]*)\r?$/gm },
  { label: "Text", pattern: /^(?:- )?Text:([^\r\n]*)\r?$/gm },
  { label: "End state", pattern: /^(?:- )?End state:([^\r\n]*)\r?$/gm },
] as const;

export interface ScreenplayVerdict {
  readonly durationSeconds: number;
  readonly longestSceneSeconds: number;
  readonly maxSceneSeconds: number;
  readonly minimumScenes: number;
  readonly scenes: number;
}

class ScreenplayFormatError extends Error {
  readonly rule: string;

  constructor(rule: string, message: string) {
    super(message);
    this.name = "ScreenplayFormatError";
    this.rule = rule;
  }
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

function sectionBounds(text: string): Result<readonly { end: number; start: number }[]> {
  const headings = [...text.matchAll(SECTION_HEADING)];
  const names = headings.map((heading) => (heading[1] ?? "").trim());

  if (names.join("|") !== SECTIONS.join("|")) {
    return err(
      new ScreenplayFormatError(
        "sections",
        `scenariusz ma niepoprawne sekcje albo ich kolejność — wymagane dokładnie, w tej kolejności: ${SECTIONS.join(", ")}`
      )
    );
  }

  const bounds = headings.map((heading, index) => ({
    end: headings[index + 1]?.index ?? text.length,
    start: (heading.index ?? 0) + (heading[0]?.length ?? 0),
  }));

  for (const [index, bound] of bounds.entries()) {
    if (text.slice(bound.start, bound.end).trim() === "") {
      return err(
        new ScreenplayFormatError("empty-section", `pusta sekcja: ${SECTIONS[index] ?? ""}`)
      );
    }
  }

  return ok(bounds);
}

function readScenes(sceneText: string): Result<readonly Scene[]> {
  const headings = [...sceneText.matchAll(SCENE_HEADING)];
  const all = sceneText.match(ANY_SCENE_HEADING) ?? [];

  if (headings.length === 0 || all.length !== headings.length) {
    return err(
      new ScreenplayFormatError(
        "scene-heading",
        "brak scen albo niepoprawny nagłówek sceny — wymagany format: ### S01 | 15s | miejsce i pora dnia"
      )
    );
  }

  const scenes = headings.map((heading, index) => ({
    body: sceneText.slice(
      (heading.index ?? 0) + (heading[0]?.length ?? 0),
      headings[index + 1]?.index ?? sceneText.length
    ),
    id: heading[1] ?? "",
    number: Number(heading[1]),
    seconds: Number(heading[2]),
  }));

  for (const [index, scene] of scenes.entries()) {
    if (scene.number !== index + 1) {
      return err(
        new ScreenplayFormatError(
          "scene-order",
          `sceny muszą mieć kolejne numery od S01 — napotkano S${scene.id} na pozycji ${index + 1}`
        )
      );
    }

    if (scene.seconds > MAX_SCENE_SECONDS) {
      return err(
        new ScreenplayFormatError(
          "scene-length",
          `scena S${scene.id}: ${scene.seconds}s przekracza twardy limit ${MAX_SCENE_SECONDS}s na scenę`
        )
      );
    }
  }

  return ok(scenes);
}

/** Returns whether this scene carries on-screen text. */
function readFields(scene: Scene, settings: EpisodeSettings): Result<boolean> {
  let onScreenText = false;

  for (const field of FIELDS) {
    const matches = [...scene.body.matchAll(field.pattern)];
    const value = (matches[0]?.[1] ?? "").trim();

    // An empty duplicate must not pass, so empty occurrences are counted too.
    if (matches.length !== 1 || value === "") {
      return err(
        new ScreenplayFormatError(
          "scene-field",
          `scena S${scene.id}: wymagane dokładnie jedno niepuste pole ${field.label}`
        )
      );
    }

    if (field.label !== "Text" || NO_TEXT.test(value)) {
      continue;
    }

    if (settings.subtitles === "none") {
      return err(
        new ScreenplayFormatError(
          "subtitles",
          `scena S${scene.id}: tekst ekranowy mimo subtitles=none — jedyna dozwolona wartość pola Text to "none"`
        )
      );
    }

    onScreenText = true;
  }

  return ok(onScreenText);
}

/**
 * The structural contract, checked against the episode's own decisions.
 *
 * Deliberately says nothing about quality: a draft that passes every rule
 * here is a correctly shaped draft and nothing more, which is why approval
 * is a separate command rather than a consequence of this function.
 */
export function validateScreenplay(
  text: string,
  settings: EpisodeSettings
): Result<ScreenplayVerdict> {
  if (text.trim().startsWith("```")) {
    return err(
      new ScreenplayFormatError(
        "code-fence",
        "scenariusz jest opakowany blokiem kodu — oczekiwano samego dokumentu Markdown"
      )
    );
  }

  const bounds = sectionBounds(text);

  if (!bounds.ok) {
    return bounds;
  }

  const section = bounds.data[SCENES_INDEX];
  const scenes = readScenes(text.slice(section?.start ?? 0, section?.end ?? text.length));

  if (!scenes.ok) {
    return scenes;
  }

  let onScreenText = false;

  for (const scene of scenes.data) {
    const fields = readFields(scene, settings);

    if (!fields.ok) {
      return fields;
    }

    onScreenText = onScreenText || fields.data;
  }

  const total = scenes.data.reduce((sum, scene) => sum + scene.seconds, 0);
  const required = minimumScenes(settings.durationSeconds);

  // The scene minimum is arithmetic rather than a rule of its own: with every
  // scene capped, a correct total cannot be reached by too few scenes. It is
  // named here because it tells the reader what a fix has to look like.
  if (total !== settings.durationSeconds) {
    return err(
      new ScreenplayFormatError(
        "total-duration",
        `suma czasów scen: ${total}s; wymagane dokładnie ${settings.durationSeconds}s, czyli co najmniej ${required} ${scenesWord(required)} po maks. ${MAX_SCENE_SECONDS}s`
      )
    );
  }

  if (settings.subtitles !== "none" && !onScreenText) {
    return err(
      new ScreenplayFormatError(
        "subtitles",
        `żadna scena nie ma tekstu ekranowego mimo zamówionych napisów (subtitles=${settings.subtitles})`
      )
    );
  }

  return ok({
    durationSeconds: total,
    longestSceneSeconds: Math.max(...scenes.data.map((scene) => scene.seconds)),
    maxSceneSeconds: MAX_SCENE_SECONDS,
    minimumScenes: required,
    scenes: scenes.data.length,
  });
}
