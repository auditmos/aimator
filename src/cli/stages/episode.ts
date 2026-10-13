import type { ParseArgsConfig } from "node:util";
import {
  addEpisode,
  type EpisodeOverview,
  setEpisodeSettings,
  showEpisode,
} from "../../lib/project/index.js";
import { err, ok, type Result } from "../../lib/result.js";
import {
  answerFlag,
  answerStage0,
  modeOf,
  type Parsed,
  parse,
  requireFlag,
  requirePositional,
  UsageError,
  workspaceOf,
} from "../common.js";

/** Stage 0's episode half: the five production settings, stored or undecided. */
export const USAGE = `  episode add <id> --source <NN-tytul.md> [--duration <s>] [--audio <tryb>]
                   [--language <kod>] [--subtitles <kod|none>] [--nature <rodzaj>]
                   [--max-clip <s>] [--json]
  episode add <id> --idea "<tekst>" --episode <NN-slug> [te same flagi decyzji] [--json]
    Pomysł wpisany w poleceniu zamiast pliku. --episode niesie to, co nazwa
    pliku bez .md: numer i slug. source.md to tekst pomysłu.
  episode set <id> <episode-id> [te same flagi decyzji] [--json]
  episode show <id> <episode-id> [--json]
    Co odcinek trzyma: plik źródłowy, skąd go skopiowano, i sześć decyzji,
    nierozstrzygnięte nazwane wprost. Opis, nie werdykt: czy to wystarcza,
    mówi check. Niczego nie zapisuje i niczego nie wydaje.`;

const SETTINGS_OPTIONS = {
  audio: { type: "string" },
  duration: { type: "string" },
  language: { type: "string" },
  "max-clip": { type: "string" },
  nature: { type: "string" },
  subtitles: { type: "string" },
} as const satisfies ParseArgsConfig["options"];

/** Only the flags the user actually passed become decisions; the rest stay undecided. */
function settingsOf(parsed: Parsed): Record<string, number | string> {
  const patch: Record<string, number | string> = {};
  const { duration } = parsed.values;
  const maxClip = parsed.values["max-clip"];
  const pairs = [
    ["audio", parsed.values.audio],
    ["language", parsed.values.language],
    ["sourceNature", parsed.values.nature],
    ["subtitles", parsed.values.subtitles],
  ] as const;

  if (typeof duration === "string") {
    patch.durationSeconds = Number(duration);
  }

  if (typeof maxClip === "string") {
    patch.maxClipSeconds = Number(maxClip);
  }

  for (const [key, value] of pairs) {
    if (typeof value === "string") {
      patch[key] = value;
    }
  }

  return patch;
}

/**
 * Where the episode's source comes from: `--source`, or `--idea` with the
 * number and slug a file's name would have carried, in `--episode`.
 */
function sourceOf(
  parsed: Parsed
): Result<{ readonly episodeId: string; readonly idea: string } | { readonly sourcePath: string }> {
  const { episode, idea, source: path } = parsed.values;

  if (typeof idea !== "string") {
    if (episode !== undefined) {
      return err(
        new UsageError(
          "--episode nadaje numer pomysłowi z --idea; przy --source numer i slug są w nazwie pliku"
        )
      );
    }

    const source = requireFlag(parsed, "source");

    return source.ok ? ok({ sourcePath: source.data }) : source;
  }

  if (path !== undefined) {
    return err(
      new UsageError(
        "--source i --idea wykluczają się: odcinek ma jedno źródło, plik albo pomysł wpisany w poleceniu"
      )
    );
  }

  if (idea.trim() === "") {
    return err(new UsageError("--idea jest pusty: pomysł na odcinek musi mieć treść"));
  }

  const episodeId = requireFlag(parsed, "episode");

  return episodeId.ok ? ok({ episodeId: episodeId.data, idea }) : episodeId;
}

async function runEpisodeAdd(parsed: Parsed): Promise<Result<string>> {
  const projectId = requirePositional(parsed, 0, "project-id");
  const source = sourceOf(parsed);
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
    ...source.data,
    workspace: workspace.data,
  });

  return result.ok
    ? ok(answerStage0(answerFlag(parsed), "episode add", "Dodano odcinek", result.data, mode))
    : result;
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
    ? ok(
        answerStage0(
          answerFlag(parsed),
          "episode set",
          `Ustawienia odcinka "${episodeId.data}"`,
          result.data,
          mode
        )
      )
    : result;
}

/** A decision as a person reads it, or the word for one nobody has made. */
function decided(value: number | string | null, unit = ""): string {
  return value === null ? "nierozstrzygnięte" : `${value}${unit}`;
}

function renderEpisode(overview: EpisodeOverview): string {
  const { settings } = overview;

  return [
    `Odcinek "${overview.episodeId}" (nr ${overview.number}) w projekcie "${overview.projectId}"`,
    `  Źródło: ${overview.source.path}`,
    overview.source.originPath === null
      ? "    pomysł wpisany w poleceniu"
      : `    skopiowane z: ${overview.source.originPath}`,
    `  Rodzaj źródła: ${decided(settings.sourceNature)}`,
    `  Długość: ${decided(settings.durationSeconds, " s")}`,
    `  Dźwięk: ${decided(settings.audio)}`,
    `  Język: ${decided(settings.language)}`,
    `  Napisy: ${decided(settings.subtitles)}`,
    `  Najdłuższy klip: ${decided(settings.maxClipSeconds, " s")}`,
  ].join("\n");
}

/**
 * What the episode holds, read back without judging it.
 *
 * `project show` one level down, for the same reason it exists: `episode set`
 * writes the decisions and `check` judges them, and nothing said what they
 * currently were, so a screen editing them started from empty fields. Under
 * `--json` it is `showEpisode`'s object plus the field that names the command.
 */
async function runEpisodeShow(argv: readonly string[]): Promise<Result<string>> {
  const parsed = parse(argv, { json: { type: "boolean" } });

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

  const result = await showEpisode({
    episodeId: episodeId.data,
    projectId: projectId.data,
    workspace: workspace.data,
  });

  if (!result.ok) {
    return result;
  }

  return ok(
    answerFlag(parsed.data) === "json"
      ? JSON.stringify({ command: "episode show", ...result.data }, null, 2)
      : renderEpisode(result.data)
  );
}

export async function runEpisode(argv: readonly string[]): Promise<Result<string>> {
  const [action] = argv;

  if (action === "show") {
    return runEpisodeShow(argv.slice(1));
  }

  if (action !== "add" && action !== "set") {
    return err(new UsageError(`nieznane polecenie: episode ${action ?? ""}`.trim()));
  }

  const parsed = parse(argv.slice(1), {
    ...SETTINGS_OPTIONS,
    json: { type: "boolean" },
    ...(action === "add"
      ? {
          episode: { type: "string" as const },
          idea: { type: "string" as const },
          source: { type: "string" as const },
        }
      : {}),
  });

  if (!parsed.ok) {
    return parsed;
  }

  return action === "add" ? await runEpisodeAdd(parsed.data) : await runEpisodeSet(parsed.data);
}
