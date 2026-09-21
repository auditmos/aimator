import type { ParseArgsConfig } from "node:util";
import {
  approveCharacter,
  CHARACTER_ARTIFACTS,
  type CharacterArtifact,
  type CharacterReport,
  type CharacterStatus,
  checkCharacter,
  generateCharacter,
  isCharacterArtifact,
} from "../../lib/character/index.js";
import { addCharacter, addCharacterSources, setCharacterBasis } from "../../lib/project/index.js";
import { err, ok, type Result } from "../../lib/result.js";
import type { Workspace } from "../../lib/workspace.js";
import {
  type Approval,
  imageModelOf,
  keyFor,
  modeOf,
  type Parsed,
  parse,
  renderStage0,
  requireFlag,
  requirePositional,
  trackOf,
  UsageError,
  workspaceOf,
} from "../common.js";

/**
 * The cast, declared one entry at a time, which is a stage-0 decision.
 *
 * It sits in this file rather than beside the project's own commands because
 * the `character` command is one grammar with four subcommands, and splitting
 * it by stage would put its dispatch across a module boundary. The usage text
 * is what knows about stages, so the fragment goes to stage 0's block and the
 * one below to stage 2's.
 */
export const CAST_USAGE = `  character new <id> <character-id> --name <nazwa>
  character add <id> <character-id> --source <plik> [--source <plik>...]
  character describe <id> <character-id>`;

/** Stage 2: the card, the eight views and the hero, per track. */
export const USAGE = `Etap 2. Postać (płatny; niezależny od etapu 1, może biec równolegle):
  character generate <id> <character-id> --track <gpt-image|seedream>
                     [--artifact card|hero|<widok>,...] [--model <id>]
                     [--dry-run] [--regenerate]`;

/** Project id, character id and the workspace, what every cast command needs. */
function castScope(
  parsed: Parsed
): Result<{ characterId: string; projectId: string; workspace: Workspace }> {
  const projectId = requirePositional(parsed, 0, "project-id");
  const characterId = requirePositional(parsed, 1, "character-id");
  const workspace = workspaceOf(parsed);

  if (!projectId.ok) {
    return projectId;
  }
  if (!characterId.ok) {
    return characterId;
  }
  if (!workspace.ok) {
    return workspace;
  }

  return ok({
    characterId: characterId.data,
    projectId: projectId.data,
    workspace: workspace.data,
  });
}

async function runCharacterNew(parsed: Parsed): Promise<Result<string>> {
  const scope = castScope(parsed);
  const name = requireFlag(parsed, "name");

  if (!scope.ok) {
    return scope;
  }
  if (!name.ok) {
    return name;
  }

  const mode = modeOf(parsed);
  const result = await addCharacter({ ...scope.data, mode, name: name.data });

  return result.ok
    ? ok(renderStage0(`Postać "${name.data}" dopisana do obsady`, result.data, mode))
    : result;
}

async function runCharacterAdd(parsed: Parsed): Promise<Result<string>> {
  const scope = castScope(parsed);
  const sources = parsed.values.source;

  if (!scope.ok) {
    return scope;
  }
  if (!Array.isArray(sources) || sources.length === 0) {
    return err(new UsageError("brakuje wymaganej flagi --source"));
  }

  const mode = modeOf(parsed);
  const result = await addCharacterSources({ ...scope.data, mode, sourcePaths: sources });

  return result.ok
    ? ok(renderStage0(`Materiały postaci "${scope.data.characterId}"`, result.data, mode))
    : result;
}

async function runCharacterDescribe(parsed: Parsed): Promise<Result<string>> {
  const scope = castScope(parsed);

  if (!scope.ok) {
    return scope;
  }

  const mode = modeOf(parsed);
  const result = await setCharacterBasis({ ...scope.data, basis: "description", mode });

  return result.ok
    ? ok(
        renderStage0(
          `Postać "${scope.data.characterId}" powstaje z opisu w project.md, bez zdjęć`,
          result.data,
          mode
        )
      )
    : result;
}

const CHARACTER_OPTIONS = {
  add: { source: { multiple: true, type: "string" } },
  describe: {},
  generate: {
    artifact: { type: "string" },
    model: { type: "string" },
    regenerate: { type: "boolean" },
    track: { type: "string" },
  },
  new: { name: { type: "string" } },
} as const satisfies Record<string, ParseArgsConfig["options"]>;

export async function runCharacter(argv: readonly string[]): Promise<Result<string>> {
  const [action] = argv;

  if (action !== "add" && action !== "describe" && action !== "new" && action !== "generate") {
    return err(new UsageError(`nieznane polecenie: character ${action ?? ""}`.trim()));
  }

  const parsed = parse(argv.slice(1), CHARACTER_OPTIONS[action]);

  if (!parsed.ok) {
    return parsed;
  }

  if (action === "new") {
    return await runCharacterNew(parsed.data);
  }

  if (action === "generate") {
    return await runCharacterGenerate(parsed.data);
  }

  return action === "add"
    ? await runCharacterAdd(parsed.data)
    : await runCharacterDescribe(parsed.data);
}

/** `--artifact` accepts the same words the stage file uses as keys. */
function artifactsOf(parsed: Parsed): Result<readonly CharacterArtifact[]> {
  const flag = parsed.values.artifact;

  if (typeof flag !== "string") {
    return ok([]);
  }

  const names = flag.split(",").map((name) => name.trim());
  const known = names.filter((name) => isCharacterArtifact(name));
  const unknown = names.filter((name) => !isCharacterArtifact(name));

  return unknown.length === 0
    ? ok(known)
    : err(
        new UsageError(
          `--artifact "${unknown.join(", ")}", dozwolone: ${CHARACTER_ARTIFACTS.join(", ")}`
        )
      );
}

async function runCharacterGenerate(parsed: Parsed): Promise<Result<string>> {
  const scope = castScope(parsed);
  const track = trackOf(parsed);
  const artifacts = artifactsOf(parsed);

  if (!scope.ok) {
    return scope;
  }
  if (!track.ok) {
    return track;
  }
  if (!artifacts.ok) {
    return artifacts;
  }

  const model = imageModelOf(parsed, track.data);

  if (!model.ok) {
    return model;
  }

  const mode = modeOf(parsed);
  // The key is read only on the paid path: a dry run must never need a secret.
  const result = await generateCharacter({
    apiKey: mode === "dry-run" ? null : (keyFor(track.data) ?? null),
    artifacts: artifacts.data,
    characterId: scope.data.characterId,
    fetch,
    mode,
    model: model.data,
    projectId: scope.data.projectId,
    regenerate: parsed.values.regenerate === true,
    track: track.data,
    workspace: scope.data.workspace,
  });

  return result.ok ? ok(renderCharacter(result.data, scope.data, mode)) : result;
}

/**
 * `--dry-run` prints every prompt in full, not a byte count. On a stage that
 * spends money ten times over, the point of a preview is to let a person read
 * what would be sent.
 */
function renderCharacter(
  report: CharacterReport,
  scope: { characterId: string; projectId: string },
  mode: "apply" | "dry-run"
): string {
  const headline = `Postać "${report.name}" (${scope.characterId}), tor ${report.track}`;
  const lines = [
    mode === "dry-run"
      ? `Próba na sucho: nic nie zapisano, nic nie wysłano. ${headline}`
      : headline,
  ];

  for (const outcome of report.artifacts) {
    lines.push(`  ${outcome.artifact}: ${outcome.state}, ${outcome.note}`);

    for (const reference of outcome.references) {
      lines.push(`      ← ${reference.path}  ${reference.sha256.slice(0, 12)}`);
    }
  }

  for (const path of report.created) {
    lines.push(`  + ${path}`);
  }

  for (const problem of report.problems) {
    lines.push(`  ! ${problem}`);
  }

  if (report.created.length > 0) {
    lines.push("  ! obrazy przeszły walidację; to nie to samo co przyjęcie ich przez człowieka");
  }

  lines.push(`Dalej: ${report.nextStep}`);

  for (const outcome of report.artifacts) {
    if (outcome.prompt !== null) {
      lines.push(
        "",
        `--- prompt dla ${outcome.artifact} (dokładnie ten tekst) ---`,
        outcome.prompt
      );
    }
  }

  return lines.join("\n");
}

function renderCharacterStatus(headline: string, status: CharacterStatus): string {
  const lines = [headline];

  for (const entry of status.artifacts) {
    const mark = entry.approved ? "zatwierdzony" : entry.state;
    lines.push(`  ${entry.artifact}: ${mark}, ${entry.note}`);
  }

  for (const problem of status.problems) {
    lines.push(`  ! ${problem}`);
  }

  lines.push(`Dalej: ${status.nextStep}`);

  return lines.join("\n");
}

/**
 * `check --stage character` reports one character on one track. It writes
 * nothing, like every other check: drift is reported, never recorded.
 */
export async function checkCharacterStage(
  parsed: Parsed,
  projectId: string,
  workspace: Workspace
): Promise<Result<string>> {
  const characterId = requirePositional(parsed, 1, "character-id");
  const track = trackOf(parsed);

  if (!characterId.ok) {
    return characterId;
  }
  if (!track.ok) {
    return track;
  }

  const result = await checkCharacter({
    characterId: characterId.data,
    projectId,
    track: track.data,
    workspace,
  });

  return result.ok
    ? ok(
        renderCharacterStatus(
          `Postać "${result.data.name}" (${characterId.data}), tor ${track.data}, etap 2${result.data.approved ? ", zatwierdzony w całości" : ""}`,
          result.data
        )
      )
    : result;
}

export async function approveCharacterStage(
  parsed: Parsed,
  approval: Approval
): Promise<Result<string>> {
  const characterId = requirePositional(parsed, 1, "character-id");
  const track = trackOf(parsed);
  const artifacts = artifactsOf(parsed);

  if (!characterId.ok) {
    return characterId;
  }
  if (!track.ok) {
    return track;
  }
  if (!artifacts.ok) {
    return artifacts;
  }

  const result = await approveCharacter({
    ...approval,
    artifacts: artifacts.data,
    characterId: characterId.data,
    track: track.data,
  });

  return result.ok
    ? ok(
        renderCharacterStatus(
          `Postać "${characterId.data}" na torze ${track.data}, zatwierdzono: ${artifacts.data.join(", ")}`,
          result.data
        )
      )
    : result;
}
