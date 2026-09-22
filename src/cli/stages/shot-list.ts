import { env } from "../../lib/env.js";
import { err, ok, type Result } from "../../lib/result.js";
import {
  approveShotList,
  checkShotList,
  generateShotList,
  type ShotListReport,
  type ShotListStatus,
} from "../../lib/shot-list/index.js";
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

/** Stage 3: the shot list, shared by both tracks and named by neither. */
export const USAGE = `Etap 3. Lista ujęć (płatny; wspólna dla obu torów, bez poziomu katalogu na tor):
  shot-list generate <id> <episode-id> [--model <id>] [--max-output-tokens <n>]
                                       [--dry-run] [--json] [--regenerate]`;

/** Which stage this file answers for, in the word `--stage` takes. */
const STAGE = "shot-list";

/**
 * The shot list is two to three times the length of the screenplay it plans:
 * every scene becomes several shots and every shot carries ten fields. A cap is
 * a ceiling rather than a creative decision, so unlike the model it has one.
 */
const DEFAULT_SHOT_LIST_MAX_OUTPUT_TOKENS = 24_000;

/**
 * `--dry-run` prints the prompt itself, not a byte count, the same promise
 * stage 1 makes, for the same reason: the preview exists so a person can read
 * what a paid call would send.
 */
function renderShotListGenerate(
  report: ShotListReport,
  projectId: string,
  episodeId: string,
  mode: "apply" | "dry-run"
): string {
  const lines =
    mode === "dry-run"
      ? [
          `Próba na sucho: nic nie zapisano, nic nie wysłano. Lista ujęć ${projectId}/${episodeId}`,
          `  płatnych wywołań do wykonania: ${report.paidCalls}`,
          "  OPENAI_API_KEY nie był czytany, bo próba na sucho nie sięga po sekrety; płatne wywołanie go wymaga",
        ]
      : [
          `Lista ujęć ${projectId}/${episodeId}, próba ${report.runId ?? ""}`,
          `  płatnych wywołań wykonanych: ${report.paidCalls}`,
        ];

  for (const path of report.created) {
    lines.push(`  + ${path}`);
  }

  if (report.verdict !== null) {
    const { verdict } = report;
    lines.push(
      `  ujęcia: ${verdict.shots.length} w ${verdict.scenes.length} scenach, klipy: ${verdict.clips.length}, suma ${verdict.durationSeconds} s, najdłuższy klip ${verdict.longestClipSeconds} s (limit ${verdict.maxClipSeconds} s)`
    );
    lines.push(
      `  obsada w kadrze: ${verdict.castSeen.length === 0 ? "nikt z obsady" : verdict.castSeen.join(", ")}`
    );
    lines.push("  ! pokrycie i sumy czasów się zgadzają; inscenizacja wymaga oceny człowieka");
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

function renderShotList(
  headline: string,
  status: ShotListStatus,
  projectId: string,
  episodeId: string,
  mode: "apply" | "dry-run"
): string {
  const lines = [mode === "dry-run" ? `Próba na sucho: nic nie zapisano. ${headline}` : headline];

  if (status.verdict !== null) {
    lines.push(
      `  ujęcia: ${status.verdict.shots.length}, klipy: ${status.verdict.clips.length}, suma ${status.verdict.durationSeconds} s`
    );
  }

  for (const problem of status.problems) {
    lines.push(`  ! ${problem}`);
  }

  if (status.status === "completed" && !status.approved && status.problems.length === 0) {
    lines.push(
      `  ! plik przeszedł walidację; to nie to samo co przyjęcie go przez człowieka: aimator approve ${projectId} ${episodeId} --stage shot-list`
    );
  }

  return lines.join("\n");
}

/** `--model` wins over the environment; neither has a default. */
function shotListModelOf(parsed: Parsed): Result<string | null> {
  const flag = parsed.values.model;
  const value = typeof flag === "string" ? flag : (env.AIMATOR_SHOTLIST_MODEL ?? null);

  if (value !== null && !MODEL_ID.test(value)) {
    return err(new UsageError(`niepoprawny identyfikator modelu "${value}"`));
  }

  return ok(value);
}

export async function runShotList(argv: readonly string[]): Promise<Result<string>> {
  if (argv[0] !== "generate") {
    return err(new UsageError(`nieznane polecenie: shot-list ${argv[0] ?? ""}`.trim()));
  }

  const parsed = parse(argv.slice(1), {
    json: { type: "boolean" },
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

  const model = shotListModelOf(parsed.data);
  const tokens = maxOutputTokensOf(parsed.data, DEFAULT_SHOT_LIST_MAX_OUTPUT_TOKENS);

  if (!model.ok) {
    return model;
  }
  if (!tokens.ok) {
    return tokens;
  }

  const mode = modeOf(parsed.data);
  // The key is read only on the paid path: a dry run must never need a secret.
  const result = await generateShotList({
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

  if (!result.ok) {
    return result;
  }

  // The stage is named by this command's own first word, so there is no
  // spelling of `--json` here that could hand a caller Polish sentences.
  return ok(
    parsed.data.values.json === true
      ? asJson("generate", STAGE, result.data)
      : renderShotListGenerate(result.data, projectId.data, episodeId.data, mode)
  );
}

/**
 * The stage-3 half of `check <id> <episode-id>`, in prose or as the object.
 *
 * What to print travels in rather than being defaulted, for stage 1's reason:
 * both callers sit in `check.ts`, the wide question renders prose and the
 * narrow one renders whichever the flag asked for.
 */
export async function checkShotListStage(
  scope: EpisodeScope,
  answer: Answer
): Promise<Result<string>> {
  const result = await checkShotList(scope);

  if (!result.ok) {
    return result;
  }

  return ok(
    answer === "json"
      ? asJson("check", STAGE, result.data)
      : renderShotList(
          `Odcinek "${scope.episodeId}", etap 3: ${result.data.status}${result.data.approved ? ", zatwierdzony" : ""}`,
          result.data,
          scope.projectId,
          scope.episodeId,
          "apply"
        )
  );
}

/** `approve --stage shot-list`: the whole plan, bound to its digest. */
export async function approveShotListStage(
  parsed: Parsed,
  approval: Approval
): Promise<Result<string>> {
  const episodeId = requirePositional(parsed, 1, "episode-id");

  if (!episodeId.ok) {
    return episodeId;
  }

  const result = await approveShotList({ ...approval, episodeId: episodeId.data });

  if (!result.ok) {
    return result;
  }

  return ok(
    approval.answer === "json"
      ? asJson("approve", STAGE, result.data)
      : renderShotList(
          `Lista ujęć odcinka "${episodeId.data}" zatwierdzona`,
          result.data,
          approval.projectId,
          episodeId.data,
          approval.mode
        )
  );
}
