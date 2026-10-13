import {
  approveDialogue,
  checkDialogue,
  type DialogueReport,
  type DialogueStatus,
  generateDialogue,
} from "../../lib/dialogue/index.js";
import { env } from "../../lib/env.js";
import { err, ok, type Result } from "../../lib/result.js";
import {
  type Answer,
  type Approval,
  asJson,
  correctionLines,
  type EpisodeScope,
  instructionOf,
  MODEL_ID,
  maxOutputTokensOf,
  modeOf,
  type Parsed,
  parse,
  referenceIdsOf,
  requirePositional,
  UsageError,
  workspaceOf,
} from "../common.js";

/** Which stage this file answers for, in the word `--stage` takes. */
const STAGE = "dialogue";

/** Stage 11: the lines the characters speak, shared by both tracks. */
export const USAGE = `Etap 11. Dialog (płatny; skrypt wspólny dla obu torów):
  dialogue generate <id> <episode-id> [--model <id>] [--max-output-tokens <n>]
                    [--dry-run] [--json] [--regenerate [--instruction <uwaga>]]
    Podnosi skrypt dialogu z zatwierdzonej listy ujęć: kto, w którym ujęciu
    i od której sekundy planu. Kwestii nie pisze: etap 3 zapisał każdą jako
    <id>: "…", a walidator sprawdza w obie strony, że żadnej nie wymyślono
    i żadnej nie pominięto. Tylko przy --audio dialogue albo
    dialogue-and-narration; w innym trybie odcinek nie ma dialogu.
    Model: --model albo AIMATOR_DIALOGUE_MODEL.`;

/**
 * The script is a list of short lines under four-field headings, well under
 * what a shot list needs. A ceiling rather than a creative decision.
 */
const DEFAULT_DIALOGUE_MAX_OUTPUT_TOKENS = 8000;

/** `--model` wins over the environment; neither has a default. */
function dialogueModelOf(parsed: Parsed): Result<string | null> {
  const flag = parsed.values.model;
  const value = typeof flag === "string" ? flag : (env.AIMATOR_DIALOGUE_MODEL ?? null);

  if (value !== null && !MODEL_ID.test(value)) {
    return err(new UsageError(`niepoprawny identyfikator modelu "${value}"`));
  }

  return ok(value);
}

/**
 * `--dry-run` prints the prompt itself, the promise every text stage makes: the
 * preview exists so a person can read what a paid call would send.
 */
function renderGenerate(
  report: DialogueReport,
  projectId: string,
  episodeId: string,
  mode: "apply" | "dry-run"
): string {
  const lines =
    mode === "dry-run"
      ? [
          `Próba na sucho: nic nie zapisano, nic nie wysłano. Dialog ${projectId}/${episodeId}`,
          `  płatnych wywołań do wykonania: ${report.paidCalls}`,
        ]
      : [
          `Dialog ${projectId}/${episodeId}, próba ${report.runId ?? ""}`,
          `  płatnych wywołań wykonanych: ${report.paidCalls}`,
        ];

  lines.push(...correctionLines(report.correction));

  for (const path of report.created) {
    lines.push(`  + ${path}`);
  }

  for (const line of report.verdict?.lines ?? []) {
    lines.push(`      ${line.id}: ${line.shot}, ${line.cast}, ${line.atSeconds}s planu`);
  }

  for (const problem of report.problems) {
    lines.push(`  ! ${problem}`);
  }

  for (const notice of report.notices) {
    lines.push(`  · ${notice}`);
  }

  lines.push(`Dalej: ${report.nextStep}`);

  if (report.prompt !== null) {
    lines.push("", "--- prompt wysłany do modelu (dokładnie ten tekst) ---", report.prompt);
  }

  return lines.join("\n");
}

function renderStatus(headline: string, status: DialogueStatus): string {
  const { script } = status;
  const lines = [
    headline,
    `  script: ${script.approved ? "zatwierdzony" : script.state}, ${script.note}`,
  ];

  for (const line of status.lines) {
    lines.push(`      ${line.id}: ${line.shot}, ${line.cast}, ${line.atSeconds}s planu`);
  }

  for (const problem of status.problems) {
    lines.push(`  ! ${problem}`);
  }

  for (const notice of status.notices) {
    lines.push(`  · ${notice}`);
  }

  lines.push(`Dalej: ${status.nextStep}`);

  return lines.join("\n");
}

async function runDialogueGenerate(argv: readonly string[]): Promise<Result<string>> {
  const parsed = parse(argv, {
    instruction: { type: "string" },
    json: { type: "boolean" },
    "max-output-tokens": { type: "string" },
    model: { type: "string" },
    regenerate: { type: "boolean" },
  });

  if (!parsed.ok) {
    return parsed;
  }

  const instruction = instructionOf(parsed.data);
  const projectId = requirePositional(parsed.data, 0, "project-id");
  const episodeId = requirePositional(parsed.data, 1, "episode-id");
  const workspace = workspaceOf(parsed.data);
  const model = dialogueModelOf(parsed.data);
  const tokens = maxOutputTokensOf(parsed.data, DEFAULT_DIALOGUE_MAX_OUTPUT_TOKENS);

  if (!instruction.ok) {
    return instruction;
  }
  if (!projectId.ok) {
    return projectId;
  }
  if (!episodeId.ok) {
    return episodeId;
  }
  if (!workspace.ok) {
    return workspace;
  }
  if (!model.ok) {
    return model;
  }
  if (!tokens.ok) {
    return tokens;
  }

  const mode = modeOf(parsed.data);
  // The key is read only on the paid path: a dry run must never need a secret.
  const result = await generateDialogue({
    apiKey: mode === "dry-run" ? null : (env.OPENAI_API_KEY ?? null),
    episodeId: episodeId.data,
    fetch,
    instruction: instruction.data,
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

  return ok(
    parsed.data.values.json === true
      ? asJson("generate", STAGE, result.data)
      : renderGenerate(result.data, projectId.data, episodeId.data, mode)
  );
}

export async function runDialogue(argv: readonly string[]): Promise<Result<string>> {
  if (argv[0] === "generate") {
    return await runDialogueGenerate(argv.slice(1));
  }

  return err(new UsageError(`nieznane polecenie: dialogue ${argv[0] ?? ""}`.trim()));
}

/** `check --stage dialogue`: the script, judged against the plan as it stands. */
export async function checkDialogueStage(
  scope: EpisodeScope,
  answer: Answer
): Promise<Result<string>> {
  const result = await checkDialogue(scope);

  if (!result.ok) {
    return result;
  }

  return ok(
    answer === "json"
      ? asJson("check", STAGE, result.data)
      : renderStatus(
          `Odcinek "${scope.episodeId}", etap 11, dialog${result.data.approved ? ", zatwierdzony" : ""}`,
          result.data
        )
  );
}

/** `approve --stage dialogue --artifact script`: a human read the script. */
export async function approveDialogueStage(
  parsed: Parsed,
  approval: Approval
): Promise<Result<string>> {
  const episodeId = requirePositional(parsed, 1, "episode-id");

  if (!episodeId.ok) {
    return episodeId;
  }

  const result = await approveDialogue({
    ...approval,
    artifacts: referenceIdsOf(parsed),
    episodeId: episodeId.data,
  });

  if (!result.ok) {
    return result;
  }

  return ok(
    approval.answer === "json"
      ? asJson("approve", STAGE, result.data)
      : renderStatus(`Odcinek "${episodeId.data}", zatwierdzono skrypt dialogu`, result.data)
  );
}
