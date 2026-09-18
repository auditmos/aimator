import { userInfo } from "node:os";
import { type ParseArgsConfig, parseArgs } from "node:util";
import { env } from "./lib/env.js";
import {
  addCharacterSources,
  addEpisode,
  approveStage0,
  checkStage0,
  initProject,
  type Stage0Report,
  setCharacterBasis,
  setEpisodeSettings,
} from "./lib/project/index.js";
import { err, ok, type Result } from "./lib/result.js";
import {
  approveScreenplay,
  checkScreenplay,
  generateScreenplay,
  type ScreenplayReport,
  type ScreenplayStatus,
} from "./lib/screenplay/index.js";
import { resolveWorkspace, type Workspace } from "./lib/workspace.js";

const USAGE = `Usage: aimator <command>

Etap 0 — przygotowanie projektu i odcinka:
  project init <id> --title <tytuł> [--aspect-ratio <w:h>] [--character <podstawa>]
  character add <id> --source <plik> [--source <plik>...]
  character describe <id>
  episode add <id> --source <NN-tytul.md> [--duration <s>] [--audio <tryb>]
                   [--language <kod>] [--subtitles <kod|none>] [--nature <rodzaj>]
  episode set <id> <episode-id> [te same flagi decyzji]

Etap 1 — scenariusz (jedyne polecenie, które wydaje pieniądze):
  screenplay generate <id> <episode-id> [--model <id>] [--max-output-tokens <n>]
                                        [--dry-run] [--regenerate]

Wspólne:
  check <id> [<episode-id>]
  approve <id> [<episode-id>] [--stage prepare|screenplay]
               [--note <uzasadnienie>] [--reviewer <kto>]

  --audio      music-and-effects | dialogue | narration | dialogue-and-narration
  --nature     law-or-idea | synopsis | screenplay
  --character  photographs | description — skąd etap postaci bierze wygląd
  --stage      zakres akceptacji; domyślnie prepare (etap 0)

Globalne:
  --workspace <ścieżka>  katalog artefaktów (domyślnie AIMATOR_WORKSPACE)
  --dry-run              pokaż, co powstanie, nie zapisuj niczego
  --help                 ten komunikat

Etap 1 odmawia płatnego wywołania, dopóki etap 0 tego projektu i odcinka nie ma
review.status = "approved". Nic nie ponawia się samo; nową płatną próbę zaczyna
wyłącznie --regenerate, zachowując poprzedni wynik.`;

const DEFAULT_MAX_OUTPUT_TOKENS = 12_000;
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;

const SETTINGS_OPTIONS = {
  audio: { type: "string" },
  duration: { type: "string" },
  language: { type: "string" },
  nature: { type: "string" },
  subtitles: { type: "string" },
} as const satisfies ParseArgsConfig["options"];

const COMMON_OPTIONS = {
  "dry-run": { type: "boolean" },
  workspace: { type: "string" },
} as const satisfies ParseArgsConfig["options"];

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

interface Parsed {
  readonly positionals: readonly string[];
  readonly values: Record<string, boolean | string | string[] | undefined>;
}

function parse(argv: readonly string[], options: ParseArgsConfig["options"]): Result<Parsed> {
  try {
    const { positionals, values } = parseArgs({
      allowPositionals: true,
      args: [...argv],
      options: { ...COMMON_OPTIONS, ...options },
      strict: true,
    });

    return ok({ positionals, values });
  } catch (cause) {
    return err(new UsageError(cause instanceof Error ? cause.message : String(cause)));
  }
}

function requireFlag(parsed: Parsed, name: string): Result<string> {
  const value = parsed.values[name];

  return typeof value === "string" && value !== ""
    ? ok(value)
    : err(new UsageError(`brakuje wymaganej flagi --${name}`));
}

function requirePositional(parsed: Parsed, index: number, label: string): Result<string> {
  const value = parsed.positionals[index];

  return value === undefined ? err(new UsageError(`brakuje argumentu <${label}>`)) : ok(value);
}

function workspaceOf(parsed: Parsed): Result<Workspace> {
  const flag = parsed.values.workspace;

  return resolveWorkspace(typeof flag === "string" ? flag : env.AIMATOR_WORKSPACE);
}

function modeOf(parsed: Parsed): "apply" | "dry-run" {
  return parsed.values["dry-run"] === true ? "dry-run" : "apply";
}

function basisOf(raw: unknown): Result<"description" | "photographs" | null> {
  if (raw === undefined) {
    return ok(null);
  }

  return raw === "description" || raw === "photographs"
    ? ok(raw)
    : err(new UsageError(`--character "${String(raw)}" — dozwolone: photographs, description`));
}

/** Who ran the command. An approval with no name attached is worth nothing. */
function reviewerOf(parsed: Parsed): string {
  const flag = parsed.values.reviewer;

  return typeof flag === "string" && flag !== "" ? flag : userInfo().username;
}

/** Only the flags the user actually passed become decisions; the rest stay undecided. */
function settingsOf(parsed: Parsed): Record<string, number | string> {
  const patch: Record<string, number | string> = {};
  const { duration } = parsed.values;
  const pairs = [
    ["audio", parsed.values.audio],
    ["language", parsed.values.language],
    ["sourceNature", parsed.values.nature],
    ["subtitles", parsed.values.subtitles],
  ] as const;

  if (typeof duration === "string") {
    patch.durationSeconds = Number(duration);
  }

  for (const [key, value] of pairs) {
    if (typeof value === "string") {
      patch[key] = value;
    }
  }

  return patch;
}

function render(headline: string, report: Stage0Report, mode: "apply" | "dry-run"): string {
  const lines = [mode === "dry-run" ? `Próba na sucho — nic nie zapisano. ${headline}` : headline];

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
    lines.push("  ! pliki przeszły walidację — to nie to samo co przyjęcie ich przez człowieka");
  }

  lines.push(`Dalej: ${report.nextStep}`);

  return lines.join("\n");
}

/**
 * `--dry-run` prints the prompt itself, not a byte count. The whole point of
 * the preview is to let a person read what a paid call would send.
 */
function renderGenerate(
  report: ScreenplayReport,
  projectId: string,
  episodeId: string,
  mode: "apply" | "dry-run"
): string {
  const lines =
    mode === "dry-run"
      ? [
          `Próba na sucho — nic nie zapisano, nic nie wysłano. Scenariusz ${projectId}/${episodeId}`,
          `  wymagane co najmniej ${report.minimumScenes} scen, każda 1–15 s, suma dokładnie równa durationSeconds`,
          "  OPENAI_API_KEY nie był czytany — próba na sucho nie sięga po sekrety; płatne wywołanie go wymaga",
        ]
      : [`Scenariusz ${projectId}/${episodeId} — próba ${report.runId ?? ""}`];

  for (const path of report.created) {
    lines.push(`  + ${path}`);
  }

  if (report.verdict !== null) {
    lines.push(
      `  sceny: ${report.verdict.scenes}, suma ${report.verdict.durationSeconds} s, najdłuższa ${report.verdict.longestSceneSeconds} s`
    );
    lines.push("  ! struktura i suma czasów się zgadzają — fabuła wymaga oceny człowieka");
  }

  for (const problem of report.problems) {
    lines.push(`  ! ${problem}`);
  }

  lines.push(`Dalej: ${report.nextStep}`);

  if (report.prompt !== null) {
    lines.push("", "--- prompt wysłany do modelu (dokładnie ten tekst) ---", report.prompt);
  }

  return lines.join("\n");
}

function renderScreenplay(
  headline: string,
  status: ScreenplayStatus,
  projectId: string,
  episodeId: string,
  mode: "apply" | "dry-run"
): string {
  const lines = [mode === "dry-run" ? `Próba na sucho — nic nie zapisano. ${headline}` : headline];

  if (status.verdict !== null) {
    lines.push(
      `  sceny: ${status.verdict.scenes}, suma ${status.verdict.durationSeconds} s, najdłuższa ${status.verdict.longestSceneSeconds} s`
    );
  }

  for (const problem of status.problems) {
    lines.push(`  ! ${problem}`);
  }

  if (status.status === "completed" && !status.approved && status.problems.length === 0) {
    lines.push(
      `  ! plik przeszedł walidację — to nie to samo co przyjęcie go przez człowieka: aimator approve ${projectId} ${episodeId} --stage screenplay`
    );
  }

  return lines.join("\n");
}

async function runProject(argv: readonly string[]): Promise<Result<string>> {
  if (argv[0] !== "init") {
    return err(new UsageError(`nieznane polecenie: project ${argv[0] ?? ""}`.trim()));
  }

  const parsed = parse(argv.slice(1), {
    "aspect-ratio": { type: "string" },
    character: { type: "string" },
    title: { type: "string" },
  });

  if (!parsed.ok) {
    return parsed;
  }

  const projectId = requirePositional(parsed.data, 0, "project-id");
  const title = requireFlag(parsed.data, "title");
  const workspace = workspaceOf(parsed.data);

  if (!projectId.ok) {
    return projectId;
  }
  if (!title.ok) {
    return title;
  }
  if (!workspace.ok) {
    return workspace;
  }

  const ratio = parsed.data.values["aspect-ratio"];
  const basis = basisOf(parsed.data.values.character);

  if (!basis.ok) {
    return basis;
  }

  const mode = modeOf(parsed.data);
  const result = await initProject({
    aspectRatio: typeof ratio === "string" ? ratio : null,
    characterBasis: basis.data,
    mode,
    projectId: projectId.data,
    title: title.data,
    workspace: workspace.data,
  });

  return result.ok
    ? ok(render(`Utworzono projekt "${projectId.data}"`, result.data, mode))
    : result;
}

async function runCharacterAdd(parsed: Parsed): Promise<Result<string>> {
  const projectId = requirePositional(parsed, 0, "project-id");
  const workspace = workspaceOf(parsed);
  const sources = parsed.values.source;

  if (!projectId.ok) {
    return projectId;
  }
  if (!workspace.ok) {
    return workspace;
  }
  if (!Array.isArray(sources) || sources.length === 0) {
    return err(new UsageError("brakuje wymaganej flagi --source"));
  }

  const mode = modeOf(parsed);
  const result = await addCharacterSources({
    mode,
    projectId: projectId.data,
    sourcePaths: sources,
    workspace: workspace.data,
  });

  return result.ok ? ok(render("Materiały postaci", result.data, mode)) : result;
}

async function runCharacterDescribe(parsed: Parsed): Promise<Result<string>> {
  const projectId = requirePositional(parsed, 0, "project-id");
  const workspace = workspaceOf(parsed);

  if (!projectId.ok) {
    return projectId;
  }
  if (!workspace.ok) {
    return workspace;
  }

  const mode = modeOf(parsed);
  const result = await setCharacterBasis({
    basis: "description",
    mode,
    projectId: projectId.data,
    workspace: workspace.data,
  });

  return result.ok
    ? ok(render("Postać powstaje z opisu w project.md, bez zdjęć", result.data, mode))
    : result;
}

async function runCharacter(argv: readonly string[]): Promise<Result<string>> {
  const [action] = argv;

  if (action !== "add" && action !== "describe") {
    return err(new UsageError(`nieznane polecenie: character ${action ?? ""}`.trim()));
  }

  const parsed = parse(
    argv.slice(1),
    action === "add" ? { source: { multiple: true, type: "string" } } : {}
  );

  if (!parsed.ok) {
    return parsed;
  }

  return action === "add"
    ? await runCharacterAdd(parsed.data)
    : await runCharacterDescribe(parsed.data);
}

async function runApprove(argv: readonly string[]): Promise<Result<string>> {
  const parsed = parse(argv, {
    note: { type: "string" },
    reviewer: { type: "string" },
    stage: { type: "string" },
  });

  if (!parsed.ok) {
    return parsed;
  }

  const projectId = requirePositional(parsed.data, 0, "project-id");
  const workspace = workspaceOf(parsed.data);

  if (!projectId.ok) {
    return projectId;
  }
  if (!workspace.ok) {
    return workspace;
  }

  const { note, stage } = parsed.data.values;
  const mode = modeOf(parsed.data);
  const approval = {
    mode,
    note: typeof note === "string" ? note : null,
    projectId: projectId.data,
    reviewer: reviewerOf(parsed.data),
    workspace: workspace.data,
  };

  if (stage === undefined || stage === "prepare") {
    const result = await approveStage0(approval);

    return result.ok
      ? ok(render(`Etap 0 projektu "${projectId.data}" zatwierdzony`, result.data, mode))
      : result;
  }

  if (stage !== "screenplay") {
    return err(new UsageError(`--stage "${String(stage)}" — dozwolone: prepare, screenplay`));
  }

  const episodeId = requirePositional(parsed.data, 1, "episode-id");

  if (!episodeId.ok) {
    return episodeId;
  }

  const result = await approveScreenplay({ ...approval, episodeId: episodeId.data });

  return result.ok
    ? ok(
        renderScreenplay(
          `Scenariusz odcinka "${episodeId.data}" zatwierdzony`,
          result.data,
          projectId.data,
          episodeId.data,
          mode
        )
      )
    : result;
}

async function runScreenplay(argv: readonly string[]): Promise<Result<string>> {
  if (argv[0] !== "generate") {
    return err(new UsageError(`nieznane polecenie: screenplay ${argv[0] ?? ""}`.trim()));
  }

  const parsed = parse(argv.slice(1), {
    "max-output-tokens": { type: "string" },
    model: { type: "string" },
    regenerate: { type: "boolean" },
  });

  if (!parsed.ok) {
    return parsed;
  }

  const projectId = requirePositional(parsed.data, 0, "project-id");
  const episodeId = requirePositional(parsed.data, 1, "episode-id");
  const workspace = workspaceOf(parsed.data);

  if (!projectId.ok) {
    return projectId;
  }
  if (!episodeId.ok) {
    return episodeId;
  }
  if (!workspace.ok) {
    return workspace;
  }

  const model = modelOf(parsed.data);
  const tokens = maxOutputTokensOf(parsed.data);

  if (!model.ok) {
    return model;
  }
  if (!tokens.ok) {
    return tokens;
  }

  const mode = modeOf(parsed.data);
  // The key is read only on the paid path: a dry run must never need a secret.
  const result = await generateScreenplay({
    apiKey: mode === "dry-run" ? null : (env.OPENAI_API_KEY ?? null),
    episodeId: episodeId.data,
    fetch,
    maxOutputTokens: tokens.data,
    mode,
    model: model.data,
    projectId: projectId.data,
    regenerate: parsed.data.values.regenerate === true,
    workspace: workspace.data,
  });

  return result.ok ? ok(renderGenerate(result.data, projectId.data, episodeId.data, mode)) : result;
}

/** `--model` wins over the environment; neither has a default. */
function modelOf(parsed: Parsed): Result<string | null> {
  const flag = parsed.values.model;
  const value = typeof flag === "string" ? flag : (env.AIMATOR_SCREENPLAY_MODEL ?? null);

  if (value !== null && !MODEL_ID.test(value)) {
    return err(new UsageError(`niepoprawny identyfikator modelu "${value}"`));
  }

  return ok(value);
}

function maxOutputTokensOf(parsed: Parsed): Result<number> {
  const flag = parsed.values["max-output-tokens"];

  if (typeof flag !== "string") {
    return ok(DEFAULT_MAX_OUTPUT_TOKENS);
  }

  const value = Number(flag);

  return Number.isSafeInteger(value) && value >= 256 && value <= 100_000
    ? ok(value)
    : err(new UsageError("--max-output-tokens: liczba całkowita od 256 do 100000"));
}

async function runEpisodeAdd(parsed: Parsed): Promise<Result<string>> {
  const projectId = requirePositional(parsed, 0, "project-id");
  const source = requireFlag(parsed, "source");
  const workspace = workspaceOf(parsed);

  if (!projectId.ok) {
    return projectId;
  }
  if (!source.ok) {
    return source;
  }
  if (!workspace.ok) {
    return workspace;
  }

  const mode = modeOf(parsed);
  const result = await addEpisode({
    mode,
    projectId: projectId.data,
    settings: settingsOf(parsed),
    sourcePath: source.data,
    workspace: workspace.data,
  });

  return result.ok ? ok(render("Dodano odcinek", result.data, mode)) : result;
}

async function runEpisodeSet(parsed: Parsed): Promise<Result<string>> {
  const projectId = requirePositional(parsed, 0, "project-id");
  const episodeId = requirePositional(parsed, 1, "episode-id");
  const workspace = workspaceOf(parsed);

  if (!projectId.ok) {
    return projectId;
  }
  if (!episodeId.ok) {
    return episodeId;
  }
  if (!workspace.ok) {
    return workspace;
  }

  const mode = modeOf(parsed);
  const result = await setEpisodeSettings({
    episodeId: episodeId.data,
    mode,
    projectId: projectId.data,
    settings: settingsOf(parsed),
    workspace: workspace.data,
  });

  return result.ok
    ? ok(render(`Ustawienia odcinka "${episodeId.data}"`, result.data, mode))
    : result;
}

async function runEpisode(argv: readonly string[]): Promise<Result<string>> {
  const [action] = argv;

  if (action !== "add" && action !== "set") {
    return err(new UsageError(`nieznane polecenie: episode ${action ?? ""}`.trim()));
  }

  const parsed = parse(argv.slice(1), {
    ...SETTINGS_OPTIONS,
    ...(action === "add" ? { source: { type: "string" as const } } : {}),
  });

  if (!parsed.ok) {
    return parsed;
  }

  return action === "add" ? await runEpisodeAdd(parsed.data) : await runEpisodeSet(parsed.data);
}

async function runCheck(argv: readonly string[]): Promise<Result<string>> {
  const parsed = parse(argv, {});

  if (!parsed.ok) {
    return parsed;
  }

  const projectId = requirePositional(parsed.data, 0, "project-id");
  const workspace = workspaceOf(parsed.data);

  if (!projectId.ok) {
    return projectId;
  }
  if (!workspace.ok) {
    return workspace;
  }

  const result = await checkStage0({ projectId: projectId.data, workspace: workspace.data });

  if (!result.ok) {
    return result;
  }

  const stage0 = render(`Projekt "${projectId.data}" — etap 0 gotowy`, result.data, "apply");
  const [, episodeId] = parsed.data.positionals;

  if (episodeId === undefined) {
    return ok(stage0);
  }

  // Naming an episode widens the check to its stage 1. Nothing is written —
  // a check reports drift, it never records it.
  const stage1 = await checkScreenplay({
    episodeId,
    projectId: projectId.data,
    workspace: workspace.data,
  });

  return stage1.ok
    ? ok(
        `${stage0}\n${renderScreenplay(
          `Odcinek "${episodeId}" — etap 1: ${stage1.data.status}${stage1.data.approved ? ", zatwierdzony" : ""}`,
          stage1.data,
          projectId.data,
          episodeId,
          "apply"
        )}`
      )
    : stage1;
}

/**
 * argv in, outcome out. Filesystem effects live in lib/project; streams and
 * exit codes live in bin.ts — which is what keeps this testable by calling a
 * function instead of spawning a process.
 */
export async function run(argv: string[]): Promise<Result<string>> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help") {
    return ok(USAGE);
  }

  if (command === "project") {
    return await runProject(rest);
  }

  if (command === "character") {
    return await runCharacter(rest);
  }

  if (command === "episode") {
    return await runEpisode(rest);
  }

  if (command === "screenplay") {
    return await runScreenplay(rest);
  }

  if (command === "check") {
    return await runCheck(rest);
  }

  if (command === "approve") {
    return await runApprove(rest);
  }

  return err(new UsageError(`unknown command: ${command}`));
}
