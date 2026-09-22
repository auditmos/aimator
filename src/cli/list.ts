import { readdir } from "node:fs/promises";
import { ok, type Result } from "../lib/result.js";
import { episodePaths, projectPaths, projectsRoot, type Workspace } from "../lib/workspace.js";
import { parse, workspaceOf } from "./common.js";

/** The question asked before any id is known. */
export const USAGE = `  list [--json]
    Co w ogóle jest w katalogu roboczym: identyfikator każdego projektu i
    każdego odcinka pod nim, w kolejności alfabetycznej. Nic poza tym: tytuły,
    ustawienia i werdykty należą do etapów, które je zapisały, a status jest
    jedno wywołanie dalej. Niczego nie zapisuje i niczego nie wydaje.
    --json wypisuje ten sam obiekt, który renderuje tekst; odmowa zostaje
    w Result, dokładnie jak bez flagi.`;

interface ListedProject {
  readonly episodes: readonly string[];
  readonly id: string;
}

interface WorkspaceListing {
  /**
   * Which command wrote this object, and the only field `--json` adds here:
   * this one answers for the whole workspace, so it has no stage to name.
   */
  readonly command: "list";
  readonly projects: readonly ListedProject[];
  /** Which tree was read, because a workspace is chosen per shell. */
  readonly workspace: string;
}

/**
 * The directories under one path, sorted, and none where the path is absent.
 *
 * A workspace with no `projects/` directory is a workspace nobody has used
 * yet, which is a state rather than a failure to read it; anything else the
 * filesystem refuses travels on, because "empty" would be a lie about a
 * directory that exists and could not be opened.
 */
async function directories(path: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });

    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw cause;
  }
}

/**
 * What is in the workspace, read as directories rather than declared anywhere.
 *
 * A name that could not be a project id is not one: the id rules belong to the
 * layout module, so a stray directory is skipped by asking it rather than by
 * matching a pattern a second time here.
 */
async function listingOf(workspace: Workspace): Promise<WorkspaceListing> {
  const projects: ListedProject[] = [];

  for (const id of await directories(projectsRoot(workspace))) {
    const paths = projectPaths(workspace, id);

    if (!paths.ok) {
      continue;
    }

    // biome-ignore lint/performance/noAwaitInLoops: one directory per project
    const found = await directories(paths.data.episodes);

    projects.push({
      episodes: found.filter((episodeId) => episodePaths(paths.data, episodeId).ok),
      id,
    });
  }

  return { command: "list", projects, workspace: workspace.root };
}

/** The first thing a person can do with what is actually on disk. */
function nextOf(listing: WorkspaceListing): string {
  const withEpisode = listing.projects.find((project) => project.episodes.length > 0);

  if (withEpisode !== undefined) {
    return `aimator status ${withEpisode.id} ${withEpisode.episodes[0]}`;
  }

  const [first] = listing.projects;

  return first === undefined
    ? "aimator project init <id> --title <tytuł>"
    : `aimator episode add ${first.id} --source <NN-tytul.md>`;
}

function renderListing(listing: WorkspaceListing): string {
  const lines = [`Katalog roboczy: ${listing.workspace}`];

  if (listing.projects.length === 0) {
    lines.push("  Brak projektów.");
  }

  for (const project of listing.projects) {
    lines.push(`  ${project.id}`);
    lines.push(
      ...(project.episodes.length === 0
        ? ["    Brak odcinków."]
        : project.episodes.map((episodeId) => `    ${episodeId}`))
    );
  }

  lines.push(`Dalej: ${nextOf(listing)}`);

  return lines.join("\n");
}

/**
 * What is here, before anything is named.
 *
 * Every other command takes an id, which is the question after this one, and
 * until now the only way to answer this one was a file manager. A screen that
 * can answer something the terminal cannot is the second road this tool exists
 * not to build, so the answer is a command and the screen renders it.
 */
export async function runList(argv: readonly string[]): Promise<Result<string>> {
  const parsed = parse(argv, { json: { type: "boolean" } });

  if (!parsed.ok) {
    return parsed;
  }

  const workspace = workspaceOf(parsed.data);

  if (!workspace.ok) {
    return workspace;
  }

  const listing = await listingOf(workspace.data);

  return ok(
    parsed.data.values.json === true ? JSON.stringify(listing, null, 2) : renderListing(listing)
  );
}
