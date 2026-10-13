import {
  approveDialogue,
  checkDialogue,
  type DialogueReport,
  type DialogueStatus,
  generateDialogue,
  translateDialogue,
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
export const USAGE = `Etap 11. Dialog (płatny; skrypt i kwestie wspólne dla obu torów):
  dialogue generate <id> <episode-id> [--model <id>] [--voice-model <id>]
                    [--max-output-tokens <n>] [--artifact script|D01[,D02]]
                    [--language <kod>] [--dry-run] [--json]
                    [--regenerate [--instruction <uwaga>]]
    Podnosi skrypt dialogu z zatwierdzonej listy ujęć: kto, w którym ujęciu
    i od której sekundy planu. Kwestii nie pisze: etap 3 zapisał każdą jako
    <id>: "…", a walidator sprawdza w obie strony, że żadnej nie wymyślono
    i żadnej nie pominięto. Tylko przy --audio dialogue albo
    dialogue-and-narration; w innym trybie odcinek nie ma dialogu.
    Po przyjętym skrypcie kupuje kwestie w języku filmu, każdą głosem jej
    postaci; postać bez przyjętej próbki głosu czeka, reszta jest kupowana.
    ElevenLabs rozlicza ZNAKI, nie wywołania, więc podgląd podaje jedno i drugie.
    Model skryptu: --model albo AIMATOR_DIALOGUE_MODEL; model mowy:
    --voice-model albo AIMATOR_DIALOGUE_VOICE_MODEL.
    --instruction poprawia sam skrypt, więc idzie wyłącznie z --artifact script.
    --language <kod> kupuje kwestie w języku ust, z przyjętego przekładu
    (dialogue translate), głosami tego języka, pod kluczami <kod>:D01, do
    dialogue/<kod>/; --artifact en:D01[,en:D02] przy --regenerate.
  dialogue translate <id> <episode-id> [--model <id>] [--max-output-tokens <n>]
                     [--dry-run] [--json] [--regenerate [--instruction <uwaga>]]
    Tłumaczy przyjęty skrypt na język ust z episode lip-sync jednym płatnym
    wywołaniem tekstowym i publikuje dialogue.<język>.md z tymi samymi
    nagłówkami. Każda kwestia idzie z oknem czasu, od kotwicy do następnej
    kwestii albo końca ujęcia, i ma się w nim zmieścić. Walidator sprawdza 1:1
    kwestie, ujęcia, postacie i kotwice; wierność ocenia człowiek przy
    approve --artifact script-<język>. Model: --model albo
    AIMATOR_TRANSLATION_MODEL.`;

/**
 * The script is a list of short lines under four-field headings, well under
 * what a shot list needs. A ceiling rather than a creative decision.
 */
const DEFAULT_DIALOGUE_MAX_OUTPUT_TOKENS = 8000;

/** A model flag wins over the environment; neither has a default. */
function modelOf(flag: unknown, fallback: string | undefined): Result<string | null> {
  const value = typeof flag === "string" ? flag : (fallback ?? null);

  if (value !== null && !MODEL_ID.test(value)) {
    return err(new UsageError(`niepoprawny identyfikator modelu "${value}"`));
  }

  return ok(value);
}

/**
 * `--dry-run` prints the prompt itself, the promise every text stage makes: the
 * preview exists so a person can read what a paid call would send. Once the
 * script is accepted the bill is two numbers, calls and characters, per line
 * and in total, because the speech provider charges for the characters.
 */
function renderGenerate(
  report: DialogueReport,
  scope: { readonly episodeId: string; readonly projectId: string; readonly what: string },
  mode: "apply" | "dry-run"
): string {
  const speaking = report.lines.length > 0;
  const named = `${scope.what} ${scope.projectId}/${scope.episodeId}`;
  const lines =
    mode === "dry-run"
      ? [
          `Próba na sucho: nic nie zapisano, nic nie wysłano. ${named}`,
          `  płatnych wywołań do wykonania: ${report.paidCalls}`,
        ]
      : [
          `${named}${report.runId === null ? "" : `, próba ${report.runId}`}`,
          `  płatnych wywołań wykonanych: ${report.paidCalls}`,
        ];

  if (speaking) {
    lines.push(`  znaków do rozliczenia: ${report.characters}`);
  }

  lines.push(...correctionLines(report.correction));

  for (const path of report.created) {
    lines.push(`  + ${path}`);
  }

  for (const line of report.verdict?.lines ?? []) {
    lines.push(`      ${line.id}: ${line.shot}, ${line.cast}, ${line.atSeconds}s planu`);
  }

  for (const line of report.lines) {
    lines.push(
      `      ${line.id}: ${line.cast}, ${line.state}, ${line.note}, ${line.characters} znaków${line.seconds === null ? "" : `, ${line.seconds}s`}`
    );
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
  const { script, translation } = status;
  const row = (line: DialogueStatus["lines"][number]): string =>
    `      ${line.key}: ${line.shot}, ${line.cast}, ${line.atSeconds}s planu, ${line.approved ? "zatwierdzona" : line.state}, ${line.note}`;
  // Each script above its own lines: the film's language, then the second.
  const lines = [
    headline,
    `  script: ${script.approved ? "zatwierdzony" : script.state}, ${script.note}`,
    ...status.lines.map(row),
    ...(translation === null
      ? []
      : [
          `  ${translation.id}: ${translation.approved ? "zatwierdzony" : translation.state}, ${translation.note}`,
          ...translation.lines.map(row),
        ]),
  ];

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
    artifact: { type: "string" },
    instruction: { type: "string" },
    json: { type: "boolean" },
    language: { type: "string" },
    "max-output-tokens": { type: "string" },
    model: { type: "string" },
    regenerate: { type: "boolean" },
    "voice-model": { type: "string" },
  });

  if (!parsed.ok) {
    return parsed;
  }

  const artifacts = referenceIdsOf(parsed.data);
  const instruction = instructionOf(parsed.data);
  const projectId = requirePositional(parsed.data, 0, "project-id");
  const episodeId = requirePositional(parsed.data, 1, "episode-id");
  const workspace = workspaceOf(parsed.data);
  const model = modelOf(parsed.data.values.model, env.AIMATOR_DIALOGUE_MODEL);
  const voiceModel = modelOf(parsed.data.values["voice-model"], env.AIMATOR_DIALOGUE_VOICE_MODEL);
  const tokens = maxOutputTokensOf(parsed.data, DEFAULT_DIALOGUE_MAX_OUTPUT_TOKENS);

  if (!instruction.ok) {
    return instruction;
  }

  // A note is read by a text model, and here only the script is written by
  // one: a line is bought from the script's own words, never from a note.
  if (instruction.data !== null && artifacts.join(",") !== "script") {
    return err(
      new UsageError("--instruction poprawia skrypt, więc ma jednego adresata: --artifact script")
    );
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
  if (!voiceModel.ok) {
    return voiceModel;
  }
  if (!tokens.ok) {
    return tokens;
  }

  const mode = modeOf(parsed.data);
  // Keys are read only on the paid path: a dry run must never need a secret.
  const result = await generateDialogue({
    apiKey: mode === "dry-run" ? null : (env.OPENAI_API_KEY ?? null),
    artifacts,
    episodeId: episodeId.data,
    fetch,
    instruction: instruction.data,
    language: typeof parsed.data.values.language === "string" ? parsed.data.values.language : null,
    maxOutputTokens: tokens.data,
    mode,
    model: model.data,
    projectId: projectId.data,
    regenerate: parsed.data.values.regenerate === true,
    voiceKey: mode === "dry-run" ? null : (env.ELEVENLABS_API_KEY ?? null),
    voiceModel: voiceModel.data,
    workspace: workspace.data,
  });

  if (!result.ok) {
    return result;
  }

  return ok(
    parsed.data.values.json === true
      ? asJson("generate", STAGE, result.data)
      : renderGenerate(
          result.data,
          { episodeId: episodeId.data, projectId: projectId.data, what: "Dialog" },
          mode
        )
  );
}

/**
 * The script in the language of the mouths. One artifact per episode, so no
 * `--artifact`: a flag with one legal value is ceremony, stage 6's reason.
 */
async function runDialogueTranslate(argv: readonly string[]): Promise<Result<string>> {
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
  const model = modelOf(parsed.data.values.model, env.AIMATOR_TRANSLATION_MODEL);
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
  const result = await translateDialogue({
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
      ? asJson("translate", STAGE, result.data)
      : renderGenerate(
          result.data,
          { episodeId: episodeId.data, projectId: projectId.data, what: "Przekład dialogu" },
          mode
        )
  );
}

export async function runDialogue(argv: readonly string[]): Promise<Result<string>> {
  if (argv[0] === "generate") {
    return await runDialogueGenerate(argv.slice(1));
  }

  if (argv[0] === "translate") {
    return await runDialogueTranslate(argv.slice(1));
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

/** `approve --stage dialogue`: a human read the script or its translation, or heard lines. */
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
      : renderStatus(
          `Odcinek "${episodeId.data}", etap 11, zatwierdzono: ${referenceIdsOf(parsed).join(", ")}`,
          result.data
        )
  );
}
