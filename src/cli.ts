import { type ParseArgsConfig, parseArgs } from "node:util";
import { env } from "./lib/env.js";
import {
  addCharacterSources,
  addEpisode,
  checkStage0,
  initProject,
  type Stage0Report,
  setEpisodeSettings,
} from "./lib/project/index.js";
import { err, ok, type Result } from "./lib/result.js";
import { resolveWorkspace, type Workspace } from "./lib/workspace.js";

const USAGE = `Usage: aimator <command>

Etap 0 — przygotowanie projektu i odcinka:
  project init <id> --title <tytuł> [--aspect-ratio <w:h>]
  character add <id> --source <plik> [--source <plik>...]
  episode add <id> --source <NN-tytul.md> [--duration <s>] [--audio <tryb>]
                   [--language <kod>] [--subtitles <kod|none>] [--nature <rodzaj>]
  episode set <id> <episode-id> [te same flagi decyzji]
  check <id>

  --audio    music-and-effects | dialogue | narration | dialogue-and-narration
  --nature   law-or-idea | synopsis | screenplay

Globalne:
  --workspace <ścieżka>  katalog artefaktów (domyślnie AIMATOR_WORKSPACE)
  --dry-run              pokaż, co powstanie, nie zapisuj niczego
  --help                 ten komunikat`;

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

  lines.push(`Dalej: ${report.nextStep}`);

  return lines.join("\n");
}

async function runProject(argv: readonly string[]): Promise<Result<string>> {
  if (argv[0] !== "init") {
    return err(new UsageError(`nieznane polecenie: project ${argv[0] ?? ""}`.trim()));
  }

  const parsed = parse(argv.slice(1), {
    "aspect-ratio": { type: "string" },
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
  const mode = modeOf(parsed.data);
  const result = await initProject({
    aspectRatio: typeof ratio === "string" ? ratio : null,
    mode,
    projectId: projectId.data,
    title: title.data,
    workspace: workspace.data,
  });

  return result.ok
    ? ok(render(`Utworzono projekt "${projectId.data}"`, result.data, mode))
    : result;
}

async function runCharacter(argv: readonly string[]): Promise<Result<string>> {
  if (argv[0] !== "add") {
    return err(new UsageError(`nieznane polecenie: character ${argv[0] ?? ""}`.trim()));
  }

  const parsed = parse(argv.slice(1), { source: { multiple: true, type: "string" } });

  if (!parsed.ok) {
    return parsed;
  }

  const projectId = requirePositional(parsed.data, 0, "project-id");
  const workspace = workspaceOf(parsed.data);
  const sources = parsed.data.values.source;

  if (!projectId.ok) {
    return projectId;
  }
  if (!workspace.ok) {
    return workspace;
  }
  if (!Array.isArray(sources) || sources.length === 0) {
    return err(new UsageError("brakuje wymaganej flagi --source"));
  }

  const mode = modeOf(parsed.data);
  const result = await addCharacterSources({
    mode,
    projectId: projectId.data,
    sourcePaths: sources,
    workspace: workspace.data,
  });

  return result.ok ? ok(render("Materiały postaci", result.data, mode)) : result;
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

  return result.ok
    ? ok(render(`Projekt "${projectId.data}" — etap 0 gotowy`, result.data, "apply"))
    : result;
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

  if (command === "check") {
    return await runCheck(rest);
  }

  return err(new UsageError(`unknown command: ${command}`));
}
