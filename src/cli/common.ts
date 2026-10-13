import { userInfo } from "node:os";
import { type ParseArgsConfig, parseArgs } from "node:util";
import type { Correction } from "../lib/artifact/index.js";
import { CHECKS, type Check, type Checklist } from "../lib/checklist.js";
import { env } from "../lib/env.js";
import type { Stage0Report } from "../lib/project/index.js";
import { err, ok, type Result } from "../lib/result.js";
import {
  type ImageTrack,
  imageTracks,
  resolveWorkspace,
  type Workspace,
} from "../lib/workspace.js";

/**
 * What every command needs and no stage owns.
 *
 * A stage file brings its usage fragment, its flags, its dispatch and its
 * renderers; the grammar underneath them is one implementation here. The rule
 * is the one AGENTS.md states for `src/lib`: a piece two stages copy is
 * promoted rather than duplicated, because three copies make an invariant into
 * a coincidence.
 */

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface Parsed {
  readonly positionals: readonly string[];
  readonly values: Record<string, boolean | string | string[] | undefined>;
}

/** An episode, and where it lives. What a text stage's check is asked about. */
export interface EpisodeScope {
  readonly episodeId: string;
  readonly projectId: string;
  readonly workspace: Workspace;
}

/** `-22`, `-0.5`, `-.5`: a value, never an option, this CLI declares no numeric ones. */
const NEGATIVE_NUMBER = /^-(?:\d|\.\d)/;

/**
 * Joins a negative number onto the option it belongs to.
 *
 * `parseArgs` treats every token starting with `-` as an option, so
 * `--music-db -22` leaves the flag without a value and fails as "ambiguous".
 * That is deliberate on Node's side and not configurable, but here it breaks
 * the **ordinary** case rather than an edge one: a bed sits *under* a voice, so
 * every decibel this CLI takes is normally negative, and the `--music-db=-22`
 * spelling that does work is a trap rather than an interface.
 *
 * The rewrite is narrow on purpose. It fires only when the option is declared
 * to take a value **and** the next token is a number with a leading minus,
 * which no option here can be, so nothing ambiguous is being guessed at.
 * Everything else travels through untouched: positive numbers, boolean flags,
 * the joined spelling, and anything past `--`.
 */
function joinNegatives(
  argv: readonly string[],
  options: ParseArgsConfig["options"]
): readonly string[] {
  const joined: string[] = [];
  let at = 0;

  while (at < argv.length) {
    const token = argv[at] ?? "";

    // Past the terminator nothing is an option, so nothing is rewritten.
    if (token === "--") {
      joined.push(...argv.slice(at));

      return joined;
    }

    const name = token.startsWith("--") && !token.includes("=") ? token.slice(2) : null;
    const next = argv[at + 1];
    const takesValue = name !== null && options?.[name]?.type === "string";

    if (takesValue && next !== undefined && NEGATIVE_NUMBER.test(next)) {
      joined.push(`${token}=${next}`);
      at += 2;
      continue;
    }

    joined.push(token);
    at += 1;
  }

  return joined;
}

const COMMON_OPTIONS = {
  "dry-run": { type: "boolean" },
  workspace: { type: "string" },
} as const satisfies ParseArgsConfig["options"];

export function parse(
  argv: readonly string[],
  options: ParseArgsConfig["options"]
): Result<Parsed> {
  const merged = { ...COMMON_OPTIONS, ...options };

  try {
    const { positionals, values } = parseArgs({
      allowPositionals: true,
      args: [...joinNegatives(argv, merged)],
      options: merged,
      strict: true,
    });

    return ok({ positionals, values });
  } catch (cause) {
    return err(new UsageError(cause instanceof Error ? cause.message : String(cause)));
  }
}

export function requireFlag(parsed: Parsed, name: string): Result<string> {
  const value = parsed.values[name];

  return typeof value === "string" && value !== ""
    ? ok(value)
    : err(new UsageError(`brakuje wymaganej flagi --${name}`));
}

export function requirePositional(parsed: Parsed, index: number, label: string): Result<string> {
  const value = parsed.positionals[index];

  return value === undefined ? err(new UsageError(`brakuje argumentu <${label}>`)) : ok(value);
}

export function workspaceOf(parsed: Parsed): Result<Workspace> {
  const flag = parsed.values.workspace;

  return resolveWorkspace(typeof flag === "string" ? flag : env.AIMATOR_WORKSPACE);
}

export function modeOf(parsed: Parsed): "apply" | "dry-run" {
  return parsed.values["dry-run"] === true ? "dry-run" : "apply";
}

/** Prose for a person, or the stage's own object for anything that parses. */
export type Answer = "json" | "text";

/**
 * Which stages `check` and `approve` can answer as an object.
 *
 * It grew one stage at a time, with that stage's panel, which is the order the
 * whole screen was built in, and stage 10 is the last of them: every
 * implemented stage is now here. The set stays, because the list is still what
 * the flag needs. `check` without `--stage` glues four stages into one string
 * for a person at a terminal, and there is no object for that, which is what
 * the refusal below is about now that no stage is waiting its turn. The set is
 * here rather than in either command because both take the flag and both owe
 * the same answer to "which spellings work", and two lists would disagree the
 * day one grew.
 */
const JSON_STAGES = [
  "prepare",
  "screenplay",
  "shot-list",
  "prompt-package",
  "character",
  "references",
  "opening-frame",
  "clips",
  "assembly",
  "soundtrack",
  "sound-design",
  "dialogue",
  "versions",
  "style",
  "voice",
] as const;

/**
 * What to print, refusing the spellings that would print the wrong thing.
 *
 * `--json` over a question no stage owns cannot quietly fall back to prose: a
 * caller that asked for JSON and got Polish sentences has been lied to by a
 * flag the usage text promised. The question without `--stage` is exactly
 * that: four stages glued into one string, which reads well at a terminal and
 * cannot be read back apart. So the flag refuses, and names the spellings that
 * work, exactly as an unknown `--stage` already does.
 */
export function answerOf(parsed: Parsed, fallback: string | null = null): Result<Answer> {
  if (parsed.values.json !== true) {
    return ok("text");
  }

  const { stage } = parsed.values;
  // Which stage an absent `--stage` means, when it means one. `approve` has an
  // answer and says so in brackets in the usage text; `check` has none. The
  // flag decides how an answer is printed and must not also decide what the
  // command means, or one spelling works at a terminal and refuses in a panel.
  const named = typeof stage === "string" ? stage : fallback;

  return named !== null && JSON_STAGES.some((name) => name === named)
    ? ok("json")
    : err(
        new UsageError(
          `--json wypisuje obiekt jednego etapu, więc wymaga jednego z: ${JSON_STAGES.map((name) => `--stage ${name}`).join(", ")}`
        )
      );
}

/**
 * What a command that names its own stage was asked to print.
 *
 * There is no refusal here and there cannot be one, for the reason
 * `answerOf` has both: `check` and `approve` answer for eleven stages, so they
 * have to reject a `--stage` whose object does not exist yet, while a command
 * whose first word *is* its stage can only ever print its own report.
 */
export function answerFlag(parsed: Parsed): Answer {
  return parsed.values.json === true ? "json" : "text";
}

/**
 * A stage's object, printed as it is, with the fields that say where it is from.
 *
 * No format is designed here and none may be: what `--json` promises is the
 * object the stage module already returns, so a caller reading the browser and
 * a caller reading the terminal are reading one contract. `command` and
 * `stage` are the two words a cross-stage command has to add, because `check`
 * answers for eleven stages and the answer has to say which one it is.
 */
export function asJson(command: string, stage: string, data: object): string {
  return JSON.stringify({ command, stage, ...data }, null, 2);
}

/** Who ran the command. An approval with no name attached is worth nothing. */
export function reviewerOf(parsed: Parsed): string {
  const flag = parsed.values.reviewer;

  return typeof flag === "string" && flag !== "" ? flag : userInfo().username;
}

export const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;

const DEFAULT_MAX_OUTPUT_TOKENS = 12_000;

export function maxOutputTokensOf(
  parsed: Parsed,
  fallback = DEFAULT_MAX_OUTPUT_TOKENS
): Result<number> {
  const flag = parsed.values["max-output-tokens"];

  if (typeof flag !== "string") {
    return ok(fallback);
  }

  const value = Number(flag);

  return Number.isSafeInteger(value) && value >= 256 && value <= 100_000
    ? ok(value)
    : err(new UsageError("--max-output-tokens: liczba całkowita od 256 do 100000"));
}

/**
 * `--instruction`: a person's note on the published version, or `null`.
 *
 * The note corrects a version that already exists, and correcting it is a new
 * paid attempt like any other, so it rides on `--regenerate` rather than
 * implying one: a flag that quietly bought a second result would be the one
 * road to a charge nobody wrote down.
 */
export function instructionOf(parsed: Parsed): Result<string | null> {
  const flag = parsed.values.instruction;

  if (typeof flag !== "string") {
    return ok(null);
  }

  if (flag.trim() === "") {
    return err(new UsageError("--instruction: uwaga nie może być pusta"));
  }

  return parsed.values.regenerate === true
    ? ok(flag)
    : err(
        new UsageError(
          "--instruction poprawia opublikowaną wersję, a to nowa płatna próba: wymaga --regenerate"
        )
      );
}

/**
 * `--instruction` on a command that can buy several images at once.
 *
 * A note is written about one image, so it names exactly one: sent to several,
 * it would ask each of them to change something only one was looked at for.
 */
export function singleInstructionOf(
  parsed: Parsed,
  artifacts: readonly string[]
): Result<string | null> {
  const instruction = instructionOf(parsed);

  if (!instruction.ok || instruction.data === null || artifacts.length <= 1) {
    return instruction;
  }

  return err(
    new UsageError(
      `--instruction ma jednego adresata, a --artifact wskazuje ${artifacts.length}: ${artifacts.join(", ")}`
    )
  );
}

/** An optional number flag. Absent means "leave this one as it was". */
export function numberFlag(parsed: Parsed, name: string): Result<number | null> {
  const raw = parsed.values[name];

  if (typeof raw !== "string") {
    return ok(null);
  }

  const value = Number(raw.replace(",", "."));

  return Number.isFinite(value)
    ? ok(value)
    : err(new UsageError(`--${name}: "${raw}" nie jest liczbą`));
}

const TRACKS = new Set<string>(imageTracks);

/** The track is never guessed: the two cost money separately. */
export function trackOf(parsed: Parsed): Result<ImageTrack> {
  const flag = parsed.values.track;

  return typeof flag === "string" && TRACKS.has(flag)
    ? ok(flag as ImageTrack)
    : err(new UsageError(`--track, dozwolone: ${imageTracks.join(", ")}`));
}

/**
 * `--checks`: `all`, the criteria named, or `null` when the flag is absent.
 *
 * A name outside the vocabulary is refused here rather than ignored, because a
 * misspelt `anatmy` would otherwise surface as "anatomy is missing" one step
 * later, which blames the person for a check they did.
 */
export function checksOf(parsed: Parsed): Result<Checklist | null> {
  const flag = parsed.values.checks;

  if (typeof flag !== "string") {
    return ok(null);
  }

  return flag.trim() === "all" ? ok("all") : criteriaOf("checks", flag, " albo all");
}

/**
 * `--fail`: the QC criteria a rejection names as failed, or `null` when absent.
 * A list only: "everything failed" is a note, not a criterion.
 */
export function failedOf(parsed: Parsed): Result<readonly Check[] | null> {
  const flag = parsed.values.fail;

  return typeof flag === "string" ? criteriaOf("fail", flag, "") : ok(null);
}

/** A comma list from the QC vocabulary, in vocabulary order; anything else is refused. */
function criteriaOf(name: string, flag: string, also: string): Result<readonly Check[]> {
  const names = flag
    .split(",")
    .map((one) => one.trim())
    .filter((one) => one !== "");
  const unknown = names.filter((one) => !CHECKS.some((check) => check === one));

  return unknown.length > 0
    ? err(
        new UsageError(`--${name} "${unknown.join(", ")}", dozwolone: ${CHECKS.join(", ")}${also}`)
      )
    : ok(CHECKS.filter((check) => names.includes(check)));
}

/**
 * Where the note an attempt corrects by came from, said before the prompt that
 * carries it: a rejection's note travels without anybody typing it this time,
 * so the preview is the one place a person can see that it will.
 */
export function correctionLines(correction: Correction | null): readonly string[] {
  if (correction === null) {
    return [];
  }

  return correction.source === "rejection"
    ? [
        `  uwaga z odrzucenia ${correction.from ?? ""} (review.note); jawne --instruction ma pierwszeństwo`,
      ]
    : ["  uwaga z --instruction"];
}

/** Reference ids, as `--artifact` writes them: `R01` or `R01,R02`. */
export function referenceIdsOf(parsed: Parsed): readonly string[] {
  const flag = parsed.values.artifact;

  return typeof flag === "string"
    ? flag
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id !== "")
    : [];
}

export function keyFor(track: ImageTrack): string | undefined {
  return track === "gpt-image" ? env.OPENAI_API_KEY : env.BYTEPLUS_MODELARK;
}

/** `--model` wins over the environment; neither has a default. */
export function imageModelOf(parsed: Parsed, track: ImageTrack): Result<string | null> {
  const flag = parsed.values.model;
  const fallback =
    track === "gpt-image"
      ? (env.AIMATOR_IMAGE_MODEL_GPT_IMAGE ?? null)
      : (env.AIMATOR_IMAGE_MODEL_SEEDREAM ?? null);
  const value = typeof flag === "string" ? flag : fallback;

  if (value !== null && !MODEL_ID.test(value)) {
    return err(new UsageError(`niepoprawny identyfikator modelu "${value}"`));
  }

  return ok(value);
}

/** Who is accepting what, and where. The stage decides the rest. */
export interface Approval {
  /** Prose or the stage's object; refused before this record is built. */
  readonly answer: Answer;
  /** `--checks`: only frames ready for animation are accepted against one. */
  readonly checks: Checklist | null;
  readonly mode: "apply" | "dry-run";
  readonly note: string | null;
  readonly projectId: string;
  readonly reviewer: string;
  readonly workspace: Workspace;
}

/**
 * Stage 0's word for itself, in the spelling `--stage` takes.
 *
 * One stage written by seven commands, which is why it is a constant here
 * rather than a literal in each of the three files that write it: `project`,
 * `episode` and `character` are three grammars, and what they produce is one
 * artifact with one contract.
 */
const PREPARE = "prepare";

/**
 * A stage-0 command's answer: the shared report, as prose or as the object.
 *
 * `command` is two words here where stage 1's is one, and the difference is
 * not an inconsistency. A stage-1 object is written by `screenplay generate`,
 * so `stage` and `command` spell the invocation between them; stage 0 is
 * written by `character add` and by `episode add`, and a field saying `add`
 * for both would answer "which command wrote this" with a guess.
 */
export function answerStage0(
  answer: Answer,
  command: string,
  headline: string,
  report: Stage0Report,
  mode: "apply" | "dry-run"
): string {
  return answer === "json"
    ? asJson(command, PREPARE, report)
    : renderStage0(headline, report, mode);
}

function renderStage0(headline: string, report: Stage0Report, mode: "apply" | "dry-run"): string {
  const lines = [mode === "dry-run" ? `Próba na sucho: nic nie zapisano. ${headline}` : headline];

  for (const path of report.created) {
    lines.push(`  + ${path}`);
  }

  for (const path of report.reused) {
    lines.push(`  = ${path}`);
  }

  for (const problem of report.problems) {
    lines.push(`  ! ${problem}`);
  }

  if (report.ready && !report.approved) {
    lines.push("  ! pliki przeszły walidację; to nie to samo co przyjęcie ich przez człowieka");
  }

  lines.push(`Dalej: ${report.nextStep}`);

  return lines.join("\n");
}
