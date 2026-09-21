import { env } from "../../lib/env.js";
import { err, ok, type Result } from "../../lib/result.js";
import {
  approveScreenplay,
  checkScreenplay,
  generateScreenplay,
  type ScreenplayReport,
  type ScreenplayStatus,
} from "../../lib/screenplay/index.js";
import {
  type Answer,
  type Approval,
  asJson,
  type EpisodeScope,
  MODEL_ID,
  maxOutputTokensOf,
  modeOf,
  type Parsed,
  parse,
  requirePositional,
  UsageError,
  workspaceOf,
} from "../common.js";

/** Stage 1: the screenplay, the first command that spends money. */
export const USAGE = `Etap 1. Scenariusz (płatny):
  screenplay generate <id> <episode-id> [--model <id>] [--max-output-tokens <n>]
                                        [--dry-run] [--regenerate]`;

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
          `Próba na sucho: nic nie zapisano, nic nie wysłano. Scenariusz ${projectId}/${episodeId}`,
          `  wymagane co najmniej ${report.minimumScenes} scen, każda 1–15 s, suma dokładnie równa durationSeconds`,
          "  OPENAI_API_KEY nie był czytany, bo próba na sucho nie sięga po sekrety; płatne wywołanie go wymaga",
        ]
      : [`Scenariusz ${projectId}/${episodeId}, próba ${report.runId ?? ""}`];

  for (const path of report.created) {
    lines.push(`  + ${path}`);
  }

  if (report.verdict !== null) {
    lines.push(
      `  sceny: ${report.verdict.scenes}, suma ${report.verdict.durationSeconds} s, najdłuższa ${report.verdict.longestSceneSeconds} s`
    );
    lines.push("  ! struktura i suma czasów się zgadzają; fabuła wymaga oceny człowieka");
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
  const lines = [mode === "dry-run" ? `Próba na sucho: nic nie zapisano. ${headline}` : headline];

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
      `  ! plik przeszedł walidację; to nie to samo co przyjęcie go przez człowieka: aimator approve ${projectId} ${episodeId} --stage screenplay`
    );
  }

  return lines.join("\n");
}

export async function runScreenplay(argv: readonly string[]): Promise<Result<string>> {
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

/** Which stage this file answers for, in the word `--stage` takes. */
const STAGE = "screenplay";

/**
 * The stage-1 half of `check <id> <episode-id>`, in prose or as the object.
 *
 * The answer is chosen by the caller rather than defaulted, because both
 * callers are in the same file one screen up: the wide check renders prose,
 * `--stage screenplay` renders whichever the flag asked for, and a default
 * would decide for the next caller silently.
 */
export async function checkScreenplayStage(
  scope: EpisodeScope,
  answer: Answer
): Promise<Result<string>> {
  const result = await checkScreenplay(scope);

  if (!result.ok) {
    return result;
  }

  return ok(
    answer === "json"
      ? asJson("check", STAGE, result.data)
      : renderScreenplay(
          `Odcinek "${scope.episodeId}", etap 1: ${result.data.status}${result.data.approved ? ", zatwierdzony" : ""}`,
          result.data,
          scope.projectId,
          scope.episodeId,
          "apply"
        )
  );
}

/**
 * `approve --stage screenplay`: the whole result, bound to its digest.
 *
 * What to print travels in the approval, beside who accepted and in which
 * mode, because `approve` settles it once for eleven stages: the spellings
 * `--json` cannot answer are refused before any stage is reached.
 */
export async function approveScreenplayStage(
  parsed: Parsed,
  approval: Approval
): Promise<Result<string>> {
  const episodeId = requirePositional(parsed, 1, "episode-id");

  if (!episodeId.ok) {
    return episodeId;
  }

  const result = await approveScreenplay({ ...approval, episodeId: episodeId.data });

  if (!result.ok) {
    return result;
  }

  return ok(
    approval.answer === "json"
      ? asJson("approve", STAGE, result.data)
      : renderScreenplay(
          `Scenariusz odcinka "${episodeId.data}" zatwierdzony`,
          result.data,
          approval.projectId,
          episodeId.data,
          approval.mode
        )
  );
}
