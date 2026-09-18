import type { CastMember, ShotListSettings } from "../project/index.js";
import { err, ok, type Result } from "../result.js";
import { readScreenplayScenes, type ScreenplayScene } from "../screenplay/index.js";

/**
 * Internal to the shot-list module: the structural verdict on a plan, and the
 * plan itself as data.
 *
 * Pure and offline. It is the half of stage 3 that decides whether a paid
 * response may be published at all, so it must be runnable against a file that
 * already exists with no network anywhere near it.
 *
 * It parses as it validates, and returns what it parsed. That is deliberate:
 * stage 4 has to read shots and clips out of the shot list, and this function
 * already knows every identifier, boundary and cast binding in the document.
 * Writing a second machine-readable file beside `shot-list.md` would give the
 * episode two versions of the same truth, and the one a human edits during
 * review is the one the other would stop matching.
 *
 * Structure only. Whether the staging is any good is a separate question that
 * no regular expression gets to answer.
 */

const SECTIONS = ["Plan", "Clips", "Shots", "Review"] as const;

const CLIPS_INDEX = SECTIONS.indexOf("Clips");
const SHOTS_INDEX = SECTIONS.indexOf("Shots");

/**
 * What a first clip may be seeded from, and what a later one may. These are
 * requirements the later stages have to satisfy, not claims that any image
 * exists yet.
 */
const FIRST_REFERENCE = "opening-frame";
const LATER_REFERENCES = ["previous-end-frame", "new-scene-frame"] as const;

/** Same tolerance stage 1 grants: `none.` is punctuation, not on-screen text. */
const NOTHING = /^none[.;]?$/i;

const SECTION_HEADING = /^## (.+)\r?$/gm;
const ANY_ITEM_HEADING = /^### /gm;
const CLIP_HEADING = /^### C(\d{2,}) \| (\d+)-(\d+)s\r?$/gm;
const SHOT_HEADING = /^### U(\d{2,}) \| S(\d{2,}) \| C(\d{2,}) \| (\d+)-(\d+)s\r?$/gm;
const SHOT_LIST = /^U\d{2,}(?:,\s*U\d{2,})*$/;
const CAST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const COMMA = /,\s*/;

const CLIP_FIELDS = ["Shots", "Reference", "Continuity"] as const;
const SHOT_FIELDS = [
  "Purpose",
  "Frame",
  "Action",
  "Expression",
  "Camera",
  "Cast",
  "Audio",
  "Text",
  "Start state",
  "End state",
] as const;

/** One clip: the unit stage 7 will generate as a single video. */
export interface ShotListClip {
  readonly end: number;
  readonly id: string;
  readonly reference: string;
  /** The shot ids the clip declares, in order. */
  readonly shots: readonly string[];
  readonly start: number;
}

/** One shot: a camera view inside exactly one scene and exactly one clip. */
export interface ShotListShot {
  /** Cast ids visible in this shot, in roster order. Empty means nobody. */
  readonly cast: readonly string[];
  readonly clip: string;
  readonly end: number;
  readonly hasText: boolean;
  readonly id: string;
  readonly scene: string;
  readonly start: number;
}

/**
 * The plan as data — what stage 4 reads instead of parsing Markdown again.
 *
 * `scenes` comes from the screenplay rather than from the shot list: the shot
 * list is checked against the screenplay's timeline, it does not restate it.
 */
export interface ShotList {
  /** Cast ids that appear in at least one shot, in roster order. Reported. */
  readonly castSeen: readonly string[];
  readonly clips: readonly ShotListClip[];
  readonly durationSeconds: number;
  readonly longestClipSeconds: number;
  readonly maxClipSeconds: number;
  readonly scenes: readonly ScreenplayScene[];
  readonly shots: readonly ShotListShot[];
}

interface ValidateInput {
  readonly cast: readonly CastMember[];
  /** `screenplay.md`, verbatim. Its scenes are the timeline. */
  readonly screenplay: string;
  readonly settings: ShotListSettings;
  /** The shot list being judged. */
  readonly text: string;
}

class ShotListFormatError extends Error {
  readonly rule: string;

  constructor(rule: string, message: string) {
    super(message);
    this.name = "ShotListFormatError";
    this.rule = rule;
  }
}

function fail(rule: string, message: string): Result<never> {
  return err(new ShotListFormatError(rule, message));
}

interface Item {
  readonly body: string;
  readonly head: RegExpExecArray;
}

/** The bodies of the four required sections, in order. */
function sections(text: string): Result<readonly string[]> {
  const headings = [...text.matchAll(SECTION_HEADING)];
  const names = headings.map((heading) => (heading[1] ?? "").trim());

  if (names.join("|") !== SECTIONS.join("|")) {
    return fail(
      "sections",
      `lista ujęć ma niepoprawne sekcje albo ich kolejność — wymagane dokładnie, w tej kolejności: ${SECTIONS.join(", ")}`
    );
  }

  const bodies = headings.map((heading, index) =>
    text.slice(
      (heading.index ?? 0) + (heading[0]?.length ?? 0),
      headings[index + 1]?.index ?? text.length
    )
  );

  for (const [index, body] of bodies.entries()) {
    if (body.trim() === "") {
      return fail("empty-section", `pusta sekcja: ${SECTIONS[index] ?? ""}`);
    }
  }

  return ok(bodies);
}

/**
 * Every `### ` heading in a section, parsed. An item that does not match the
 * expected shape is a failure rather than a skipped line: a heading the parser
 * silently ignored would be a shot nobody planned and nobody noticed.
 */
function items(
  body: string,
  pattern: RegExp,
  kind: string,
  shape: string
): Result<readonly Item[]> {
  const matches = [...body.matchAll(pattern)];
  const all = body.match(ANY_ITEM_HEADING) ?? [];

  if (matches.length === 0 || matches.length !== all.length) {
    return fail(
      "item-heading",
      `brak pozycji albo niepoprawny nagłówek: ${kind} — wymagany format: ${shape}`
    );
  }

  return ok(
    matches.map((head, index) => ({
      body: body.slice(
        (head.index ?? 0) + (head[0]?.length ?? 0),
        matches[index + 1]?.index ?? body.length
      ),
      head,
    }))
  );
}

/**
 * A Markdown bullet is presentation; the field name is the contract.
 *
 * The patterns are built once, from the label lists themselves, so the document
 * and the parser cannot name a field differently.
 */
const FIELD_PATTERNS = new Map<string, RegExp>(
  [...CLIP_FIELDS, ...SHOT_FIELDS].map((label) => [
    label,
    new RegExp(`^(?:- )?${label}:([^\\r\\n]*)\\r?$`, "gm"),
  ])
);

function fields<Label extends string>(
  body: string,
  labels: readonly Label[],
  context: string
): Result<Record<Label, string>> {
  const found = {} as Record<Label, string>;

  for (const label of labels) {
    const pattern = FIELD_PATTERNS.get(label);
    const matches = pattern === undefined ? [] : [...body.matchAll(pattern)];
    const value = (matches[0]?.[1] ?? "").trim();

    // An empty duplicate must not pass, so empty occurrences are counted too.
    if (matches.length !== 1 || value === "") {
      return fail("field", `${context}: wymagane dokładnie jedno niepuste pole ${label}`);
    }

    found[label] = value;
  }

  return ok(found);
}

function readClips(body: string, maxClipSeconds: number): Result<readonly ShotListClip[]> {
  const parsed = items(body, CLIP_HEADING, "klipy", "### C01 | 0-10s");

  if (!parsed.ok) {
    return parsed;
  }

  const clips: ShotListClip[] = [];

  for (const [index, item] of parsed.data.entries()) {
    const id = `C${item.head[1] ?? ""}`;
    const start = Number(item.head[2]);
    const end = Number(item.head[3]);

    if (Number(item.head[1]) !== index + 1) {
      return fail(
        "clip-order",
        `klipy muszą mieć kolejne numery od C01 — napotkano ${id} na pozycji ${index + 1}`
      );
    }

    if (end <= start) {
      return fail("clip-time", `${id}: koniec ${end}s nie jest po początku ${start}s`);
    }

    if (end - start > maxClipSeconds) {
      return fail(
        "clip-length",
        `${id}: ${end - start}s przekracza maksymalny planowany klip tego odcinka (${maxClipSeconds}s)`
      );
    }

    const read = fields(item.body, CLIP_FIELDS, id);

    if (!read.ok) {
      return read;
    }

    const shots = read.data.Shots;
    const reference = read.data.Reference;

    if (!SHOT_LIST.test(shots)) {
      return fail("clip-shots", `${id}: pole Shots musi być listą identyfikatorów, np. U01,U02`);
    }

    const allowed: readonly string[] = index === 0 ? [FIRST_REFERENCE] : LATER_REFERENCES;

    if (!allowed.includes(reference)) {
      return fail(
        "clip-reference",
        `${id}: Reference "${reference}" — dozwolone tutaj: ${allowed.join(", ")}`
      );
    }

    clips.push({ end, id, reference, shots: shots.split(COMMA), start });
  }

  return ok(clips);
}

/** The cast ids one shot declares, checked against the roster. */
function readCast(
  value: string,
  roster: readonly CastMember[],
  context: string
): Result<readonly string[]> {
  if (NOTHING.test(value)) {
    return ok([]);
  }

  const names = value.split(COMMA).map((name) => name.trim());
  const seen = new Set<string>();

  for (const name of names) {
    if (!(CAST_ID.test(name) && roster.some((member) => member.id === name))) {
      return fail(
        "cast",
        `${context}: "${name}" nie jest identyfikatorem obsady — dozwolone: ${roster.map((member) => member.id).join(", ")} albo none`
      );
    }

    if (seen.has(name)) {
      return fail("cast", `${context}: "${name}" wymieniony dwa razy w jednym ujęciu`);
    }

    seen.add(name);
  }

  // Roster order, so two shots holding the same people read the same way.
  return ok(roster.filter((member) => seen.has(member.id)).map((member) => member.id));
}

interface ShotContext {
  readonly cast: readonly CastMember[];
  readonly clips: readonly ShotListClip[];
  readonly scenes: readonly ScreenplayScene[];
  readonly settings: ShotListSettings;
}

/** Where one shot claims to sit: its own identifiers and its own bounds. */
interface ShotHeading {
  readonly clipId: string;
  readonly end: number;
  readonly id: string;
  readonly sceneId: string;
  readonly start: number;
}

/**
 * The heading of one shot, checked for its own numbering and against the shot
 * before it. `cursor` is where the previous shot ended.
 */
function readShotHeading(item: Item, index: number, cursor: number): Result<ShotHeading> {
  const id = `U${item.head[1] ?? ""}`;
  const start = Number(item.head[4]);
  const end = Number(item.head[5]);

  if (Number(item.head[1]) !== index + 1) {
    return fail(
      "shot-order",
      `ujęcia muszą mieć kolejne numery od U01 — napotkano ${id} na pozycji ${index + 1}`
    );
  }

  if (end <= start) {
    return fail("shot-time", `${id}: koniec ${end}s nie jest po początku ${start}s`);
  }

  // Every shot begins where the previous one ended: that single comparison is
  // what forbids a gap, an overlap and a reordering all at once.
  if (start !== cursor) {
    return fail(
      "shot-coverage",
      `${id}: zaczyna się w ${start}s, a poprzednie ujęcie skończyło się w ${cursor}s — luka, nakładka albo przestawienie`
    );
  }

  return ok({
    clipId: `C${item.head[3] ?? ""}`,
    end,
    id,
    sceneId: `S${item.head[2] ?? ""}`,
    start,
  });
}

/** The scene a shot names, and whether the shot really fits inside it. */
function shotScene(head: ShotHeading, context: ShotContext): Result<ScreenplayScene> {
  const scene = context.scenes.find((entry) => entry.id === head.sceneId);

  if (scene === undefined) {
    return fail("shot-scene", `${head.id}: scenariusz nie ma sceny ${head.sceneId}`);
  }

  if (head.start < scene.start || head.end > scene.end) {
    return fail(
      "shot-scene",
      `${head.id}: ${head.start}-${head.end}s leży poza sceną ${head.sceneId} (${scene.start}-${scene.end}s)`
    );
  }

  const clip = context.clips.find((entry) => entry.id === head.clipId);

  if (clip === undefined) {
    return fail("shot-clip", `${head.id}: nie ma klipu ${head.clipId}`);
  }

  if (head.start < clip.start || head.end > clip.end) {
    return fail(
      "shot-clip",
      `${head.id}: ${head.start}-${head.end}s leży poza klipem ${head.clipId} (${clip.start}-${clip.end}s)`
    );
  }

  return ok(scene);
}

/** The body of one shot: its ten fields, its cast and its on-screen text. */
function readShotBody(
  item: Item,
  head: ShotHeading,
  scene: ScreenplayScene,
  context: ShotContext
): Result<ShotListShot> {
  const read = fields(item.body, SHOT_FIELDS, head.id);

  if (!read.ok) {
    return read;
  }

  const cast = readCast(read.data.Cast, context.cast, head.id);

  if (!cast.ok) {
    return cast;
  }

  const hasText = !NOTHING.test(read.data.Text);

  if (hasText && context.settings.subtitles === "none") {
    return fail(
      "text",
      `${head.id}: tekst ekranowy mimo subtitles=none — jedyna dozwolona wartość pola Text to "none"`
    );
  }

  if (hasText && !scene.hasText) {
    return fail(
      "text",
      `${head.id}: tekst ekranowy, którego scena ${head.sceneId} nie miała — etap 3 przenosi napisy ze scenariusza, nie wymyśla nowych`
    );
  }

  return ok({
    cast: cast.data,
    clip: head.clipId,
    end: head.end,
    hasText,
    id: head.id,
    scene: head.sceneId,
    start: head.start,
  });
}

function readShots(body: string, context: ShotContext): Result<readonly ShotListShot[]> {
  const parsed = items(body, SHOT_HEADING, "ujęcia", "### U01 | S01 | C01 | 0-5s");

  if (!parsed.ok) {
    return parsed;
  }

  const shots: ShotListShot[] = [];
  let cursor = 0;

  for (const [index, item] of parsed.data.entries()) {
    const head = readShotHeading(item, index, cursor);

    if (!head.ok) {
      return head;
    }

    const scene = shotScene(head.data, context);

    if (!scene.ok) {
      return scene;
    }

    const shot = readShotBody(item, head.data, scene.data, context);

    if (!shot.ok) {
      return shot;
    }

    cursor = head.data.end;
    shots.push(shot.data);
  }

  return ok(shots);
}

/** Clips must tile the episode, and each must hold exactly the shots it declares. */
function checkClipCoverage(
  clips: readonly ShotListClip[],
  shots: readonly ShotListShot[]
): Result<true> {
  let cursor = 0;

  for (const clip of clips) {
    const assigned = shots.filter((shot) => shot.clip === clip.id);
    const [first] = assigned;
    const last = assigned.at(-1);

    if (clip.start !== cursor) {
      return fail(
        "clip-coverage",
        `${clip.id}: zaczyna się w ${clip.start}s, a poprzedni klip skończył się w ${cursor}s`
      );
    }

    if (first === undefined || last === undefined) {
      return fail("clip-coverage", `${clip.id}: żadne ujęcie nie należy do tego klipu`);
    }

    if (first.start !== clip.start || last.end !== clip.end) {
      return fail(
        "clip-coverage",
        `${clip.id}: ujęcia pokrywają ${first.start}-${last.end}s zamiast ${clip.start}-${clip.end}s`
      );
    }

    if (assigned.map((shot) => shot.id).join(",") !== clip.shots.join(",")) {
      return fail(
        "clip-shots",
        `${clip.id}: pole Shots mówi ${clip.shots.join(",")}, a do klipu należą ${assigned.map((shot) => shot.id).join(",")}`
      );
    }

    cursor = clip.end;
  }

  return ok(true);
}

/**
 * The structural contract, checked against the screenplay and the episode's own
 * decisions — and the plan, returned as data.
 *
 * Deliberately says nothing about quality: a plan that passes every rule here
 * is a correctly shaped plan and nothing more, which is why approval is a
 * separate command rather than a consequence of this function.
 */
export function validateShotList(input: ValidateInput): Result<ShotList> {
  if (input.text.trim().startsWith("```")) {
    return fail(
      "code-fence",
      "lista ujęć jest opakowana blokiem kodu — oczekiwano samego dokumentu Markdown"
    );
  }

  const scenes = readScreenplayScenes(input.screenplay);

  if (!scenes.ok) {
    return scenes;
  }

  const bodies = sections(input.text);

  if (!bodies.ok) {
    return bodies;
  }

  const clips = readClips(bodies.data[CLIPS_INDEX] ?? "", input.settings.maxClipSeconds);

  if (!clips.ok) {
    return clips;
  }

  const shots = readShots(bodies.data[SHOTS_INDEX] ?? "", {
    cast: input.cast,
    clips: clips.data,
    scenes: scenes.data,
    settings: input.settings,
  });

  if (!shots.ok) {
    return shots;
  }

  const total = shots.data.at(-1)?.end ?? 0;

  if (total !== input.settings.durationSeconds) {
    return fail(
      "total-duration",
      `suma czasów ujęć: ${total}s; wymagane dokładnie ${input.settings.durationSeconds}s, czyli tyle, ile trwają sceny scenariusza`
    );
  }

  const covered = checkClipCoverage(clips.data, shots.data);

  if (!covered.ok) {
    return covered;
  }

  // Full scene coverage needs no check of its own: the shots are contiguous
  // from second 0 to the episode's end and each one lies inside the scene it
  // names, so a scene with no shot is arithmetically impossible. What is not
  // implied is the text rule — a scene's caption can be dropped on the way in.
  for (const scene of scenes.data) {
    const assigned = shots.data.filter((shot) => shot.scene === scene.id);

    if (scene.hasText && !assigned.some((shot) => shot.hasText)) {
      return fail(
        "text",
        `${scene.id}: scena ma tekst ekranowy, którego nie niesie żadne jej ujęcie — napis zniknąłby z odcinka`
      );
    }
  }

  const seen = new Set(shots.data.flatMap((shot) => shot.cast));

  return ok({
    castSeen: input.cast.filter((member) => seen.has(member.id)).map((member) => member.id),
    clips: clips.data,
    durationSeconds: total,
    longestClipSeconds: Math.max(...clips.data.map((clip) => clip.end - clip.start)),
    maxClipSeconds: input.settings.maxClipSeconds,
    scenes: scenes.data,
    shots: shots.data,
  });
}
