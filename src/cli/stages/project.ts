import { type CastVoice, voicesOf } from "../../lib/character-voice/index.js";
import { env } from "../../lib/env.js";
import {
  approveStage0,
  type CastEntry,
  checkStage0,
  draftRules,
  initProject,
  type ProjectOverview,
  type RulesDraftReport,
  setNarratorVoice,
  setStyle,
  showProject,
  writeRules,
} from "../../lib/project/index.js";
import { err, ok, type Result } from "../../lib/result.js";
import type { Workspace } from "../../lib/workspace.js";
import {
  type Answer,
  type Approval,
  answerFlag,
  answerStage0,
  correctionLines,
  instructionOf,
  MODEL_ID,
  maxOutputTokensOf,
  modeOf,
  type Parsed,
  parse,
  requireFlag,
  requirePositional,
  UsageError,
  workspaceOf,
} from "../common.js";

/** Stage 0's project half: the rules a series shares, and who narrates it. */
export const USAGE = `  project init <id> --title <tytuł> [--aspect-ratio <w:h>] [--json]
  project draft <id> --import <id-importu> [--model <id>] [--max-output-tokens <n>]
                [--dry-run] [--json] [--regenerate [--instruction <uwaga>]]
                [--republish]   ← publikuje zapisaną odpowiedź, nic nie wysyła
    Jedno płatne wywołanie modelu tekstowego (AIMATOR_RULES_MODEL): szkic
    project.md z całego podziału importu (odcinki po to, co powraca, nigdy po
    fabułę) i z tytułu, proporcji i obsady projektu. Model odpowiada na każde
    pole: co mówi materiał, jest wpisane; co tylko proponuje, stoi za
    "TODO(etap-0) propozycja:" i blokuje etap 0, dopóki ktoś tego nie przyjmie.
    Plik składa kod i sam wpisuje, skąd szkic pochodzi; "Zatwierdzone przez
    użytkownika" zostaje człowiekowi. Pisze tylko na nietknięty szkielet albo na
    własny nietknięty szkic.
  project rules <id> --text <treść> [--json]
    Zapisuje project.md dokładnie tym tekstem: zapis edytora, w tym lokalnego
    UI. Niczego nie ocenia, bo zasady ocenia check, a w połowie pisany plik to
    zwykły stan; odmawia tylko pustego. Zmiana po akceptacji ją unieważnia.
  project show <id> [--json]
    Co projekt trzyma: tytuł, proporcje, narratora i obsadę, każdą postać z
    podstawą (zdjęcia albo opis w project.md) i zdjęciami. Opis, nie werdykt:
    czy to wystarcza, mówi check. Niczego nie zapisuje i niczego nie wydaje.
  project voice <id> --voice-id <id głosu> [--json]
    Obsadza narratora serii. Głos jest obsadą, nie konfiguracją: powraca między
    odcinkami, więc mieszka w project.json obok postaci, a nie w zmiennej, która
    dałaby drugiemu odcinkowi innego lektora bez śladu na dysku. Bramkuje sam
    etap 9, film bez narracji nigdy nie musi tej decyzji podejmować.
  project style <id> --source <plik.png> [--source <plik.png>...] [--json]
  project style <id> --generated --count <1-4> [--json]
  project style <id> --none [--json]
    Obrazy stylu: PNG kopiowane do style/sources/Snn.png, generowane z Style
    Bible osobno na każdym torze (style generate, liczba bez wartości
    domyślnej) albo jawne "bez obrazów stylu". Decyzja mieszka w style.json, nie
    w project.json, więc jej zmiana cofa zgody wyłącznie na kadry. Wymagają jej
    dopiero etapy 5, 6 i 7, które dołączają obrazy stylu po załącznikach treści,
    jako style:Snn.`;

/**
 * Casts the narrator. A stage-0 command because a voice recurs between episodes
 * exactly as a character does, which is the one criterion that decides whether
 * a decision belongs to the project rather than to an episode or a shell.
 */
async function runProjectVoice(argv: readonly string[]): Promise<Result<string>> {
  const parsed = parse(argv, { json: { type: "boolean" }, "voice-id": { type: "string" } });

  if (!parsed.ok) {
    return parsed;
  }

  const projectId = requirePositional(parsed.data, 0, "project-id");
  const voiceId = requireFlag(parsed.data, "voice-id");
  const workspace = workspaceOf(parsed.data);

  if (!projectId.ok) {
    return projectId;
  }
  if (!voiceId.ok) {
    return voiceId;
  }
  if (!workspace.ok) {
    return workspace;
  }

  const mode = modeOf(parsed.data);
  const result = await setNarratorVoice({
    mode,
    projectId: projectId.data,
    voiceId: voiceId.data,
    workspace: workspace.data,
  });

  return result.ok
    ? ok(
        answerStage0(
          answerFlag(parsed.data),
          "project voice",
          `Narratorem projektu "${projectId.data}" jest głos ${voiceId.data}`,
          result.data,
          mode
        )
      )
    : result;
}

type StyleDecision = Parameters<typeof setStyle>[0]["decision"];

/**
 * The one answer a `project style` call carries. Two at once, or none, is a
 * decision nobody made; `--generated` without `--count` is half of one, because
 * how many images a track draws is decided, never defaulted.
 */
function styleDecisionOf(parsed: Parsed): Result<StyleDecision> {
  const { count, generated, none, source } = parsed.values;
  const sources = Array.isArray(source) ? source.filter((one) => typeof one === "string") : [];
  const answers = [sources.length > 0, none === true, generated === true].filter(Boolean);

  if (answers.length !== 1) {
    return err(
      new UsageError(
        "project style przyjmuje dokładnie jedną decyzję: --source <plik.png> [--source <plik.png>...], --none albo --generated --count <1-4>"
      )
    );
  }

  if (generated !== true) {
    if (count !== undefined) {
      return err(new UsageError("--count należy do --generated: liczy obrazy stylu na tor"));
    }

    return ok(none === true ? { basis: "none" } : { basis: "supplied", sourcePaths: sources });
  }

  if (typeof count !== "string") {
    return err(
      new UsageError(
        "--generated wymaga --count <1-4>: liczba obrazów stylu na tor to decyzja bez wartości domyślnej"
      )
    );
  }

  const decided = Number(count);

  return Number.isInteger(decided)
    ? ok({ basis: "generated", count: decided })
    : err(new UsageError(`--count: "${count}" nie jest liczbą całkowitą`));
}

/** What the command just decided, as the headline of its report. */
function styleHeadline(projectId: string, decision: StyleDecision): string {
  if (decision.basis === "generated") {
    return `Obrazy stylu projektu "${projectId}" powstają z Style Bible, ${decision.count} na tor`;
  }

  return decision.basis === "supplied"
    ? `Obrazy stylu projektu "${projectId}" są wnoszone`
    : `Projekt "${projectId}" nie ma obrazów stylu`;
}

/** Decides the style frames: brought in, generated per track, or none. */
async function runProjectStyle(argv: readonly string[]): Promise<Result<string>> {
  const parsed = parse(argv, {
    count: { type: "string" },
    generated: { type: "boolean" },
    json: { type: "boolean" },
    none: { type: "boolean" },
    source: { multiple: true, type: "string" },
  });

  if (!parsed.ok) {
    return parsed;
  }

  const projectId = requirePositional(parsed.data, 0, "project-id");
  const workspace = workspaceOf(parsed.data);
  const decision = styleDecisionOf(parsed.data);

  if (!projectId.ok) {
    return projectId;
  }
  if (!workspace.ok) {
    return workspace;
  }
  if (!decision.ok) {
    return decision;
  }

  const mode = modeOf(parsed.data);
  const result = await setStyle({
    decision: decision.data,
    mode,
    projectId: projectId.data,
    workspace: workspace.data,
  });

  return result.ok
    ? ok(
        answerStage0(
          answerFlag(parsed.data),
          "project style",
          styleHeadline(projectId.data, decision.data),
          result.data,
          mode
        )
      )
    : result;
}

/** Where the style frames come from, in the words a person decides it in. */
function styleOf(style: ProjectOverview["style"]): string {
  if (style.basis === "supplied") {
    return `wnoszone (${style.images})`;
  }

  if (style.basis === "generated") {
    return `generowane z Style Bible (${style.images} na tor)`;
  }

  return style.basis === "none" ? "bez obrazów stylu" : "nierozstrzygnięte";
}

/** Where one character is drawn from, in the words a person decides it in. */
function basisOf(entry: CastEntry): string {
  if (entry.basis === "photographs") {
    return `ze zdjęć (${entry.sources.length})`;
  }

  return entry.basis === "description" ? "z opisu w project.md" : "podstawa nierozstrzygnięta";
}

/** Where a sample stands, in the words a person decides what to buy in. */
function sampleOf(voice: CastVoice): string {
  if (voice.approved) {
    return "zatwierdzona";
  }

  if (voice.sample === "completed") {
    return "czeka na ocenę";
  }

  return voice.sample === "submitted" ? "nieukończona" : "brak";
}

function renderProject(overview: ProjectOverview, voices: readonly CastVoice[]): string {
  const idWidth = Math.max(0, ...overview.cast.map((entry) => entry.id.length));
  const nameWidth = Math.max(0, ...overview.cast.map((entry) => entry.name.length));
  const lines = [
    `Projekt "${overview.projectId}": ${overview.title}`,
    `  Proporcje: ${overview.aspectRatio ?? "nierozstrzygnięte"}`,
    `  Narrator: ${overview.narratorVoiceId ?? "nieobsadzony"}`,
    `  Obrazy stylu: ${styleOf(overview.style)}`,
  ];

  if (overview.cast.length === 0) {
    lines.push("  Obsada: pusta");
  } else {
    lines.push("  Obsada:");
    lines.push(
      ...overview.cast.flatMap((entry) => [
        `    ${entry.id.padEnd(idWidth)}  ${entry.name.padEnd(nameWidth)}  ${basisOf(entry)}`,
        ...voices
          .filter((voice) => voice.characterId === entry.id)
          .map(
            (voice) =>
              `      głos ${voice.language}: ${voice.voiceId ?? "nieobsadzony"}, próbka: ${sampleOf(voice)}`
          ),
      ])
    );
  }

  return lines.join("\n");
}

/**
 * What the project holds, read back without judging it.
 *
 * Every other stage-0 command writes and reports what it changed; none said
 * what the project now is, so the cast could be read only by opening
 * `project.json`, which a screen over this CLI must never do. Under `--json`
 * it is `showProject`'s object plus the field that names the command, the
 * shape `list` has, because this too answers about no stage.
 */
async function runProjectShow(argv: readonly string[]): Promise<Result<string>> {
  const parsed = parse(argv, { json: { type: "boolean" } });

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

  const scope = { projectId: projectId.data, workspace: workspace.data };
  const result = await showProject(scope);

  if (!result.ok) {
    return result;
  }

  // The voices are not in `project.json`, so they come from their own module
  // and sit beside the project's object rather than inside it.
  const voices = await voicesOf(scope);

  if (!voices.ok) {
    return voices;
  }

  return ok(
    answerFlag(parsed.data) === "json"
      ? JSON.stringify({ command: "project show", ...result.data, voices: voices.data }, null, 2)
      : renderProject(result.data, voices.data)
  );
}

/** `--model` wins over the environment; neither has a default. */
function rulesModelOf(parsed: Parsed): Result<string | null> {
  const flag = parsed.values.model;
  const value = typeof flag === "string" ? flag : (env.AIMATOR_RULES_MODEL ?? null);

  if (value !== null && !MODEL_ID.test(value)) {
    return err(new UsageError(`niepoprawny identyfikator modelu "${value}"`));
  }

  return ok(value);
}

/** The one paid subcommand of a project: a bill and the prompt first, then one call. */
async function runProjectDraft(argv: readonly string[]): Promise<Result<string>> {
  const parsed = parse(argv, {
    import: { type: "string" },
    instruction: { type: "string" },
    json: { type: "boolean" },
    "max-output-tokens": { type: "string" },
    model: { type: "string" },
    regenerate: { type: "boolean" },
    republish: { type: "boolean" },
  });

  if (!parsed.ok) {
    return parsed;
  }

  const projectId = requirePositional(parsed.data, 0, "project-id");
  const importId = requireFlag(parsed.data, "import");
  const instruction = instructionOf(parsed.data);
  const workspace = workspaceOf(parsed.data);
  const model = rulesModelOf(parsed.data);
  const tokens = maxOutputTokensOf(parsed.data);

  if (!projectId.ok) {
    return projectId;
  }
  if (!importId.ok) {
    return importId;
  }
  if (!instruction.ok) {
    return instruction;
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

  if (parsed.data.values.regenerate === true && parsed.data.values.republish === true) {
    return err(
      new UsageError(
        "--regenerate i --republish wykluczają się: pierwsze płaci za nową odpowiedź, drugie publikuje zapisaną"
      )
    );
  }

  const mode = modeOf(parsed.data);
  // The key is read only on the paid path: a dry run must never need a secret.
  const result = await draftRules({
    apiKey: mode === "dry-run" ? null : (env.OPENAI_API_KEY ?? null),
    fetch,
    importId: importId.data,
    instruction: instruction.data,
    maxOutputTokens: tokens.data,
    mode,
    model: model.data,
    projectId: projectId.data,
    regenerate: parsed.data.values.regenerate === true,
    republish: parsed.data.values.republish === true,
    workspace: workspace.data,
  });

  if (!result.ok) {
    return result;
  }

  return ok(
    answerFlag(parsed.data) === "json"
      ? JSON.stringify({ command: "project draft", ...result.data }, null, 2)
      : renderDraft(result.data, mode)
  );
}

/** The bill and the prompt before a call; the file and what is left of it after. */
function renderDraft(report: RulesDraftReport, mode: "apply" | "dry-run"): string {
  const what = `projektu "${report.projectId}" z importu "${report.importId}"`;
  const lines =
    mode === "dry-run"
      ? [
          `Próba na sucho: nic nie zapisano, nic nie wysłano. Szkic zasad ${what}`,
          `  płatnych wywołań do wykonania: ${report.paidCalls}`,
          "  OPENAI_API_KEY nie był czytany, bo próba na sucho nie sięga po sekrety; płatne wywołanie go wymaga",
        ]
      : [
          `Szkic zasad ${what}, próba ${report.runId ?? ""}`,
          `  płatnych wywołań wykonanych: ${report.paidCalls}`,
          `  + ${report.rules}`,
          `  zostało do uzupełnienia (${report.left.length}): ${report.left.join(", ")}`,
        ];

  lines.push(...correctionLines(report.correction));
  lines.push(...report.problems.map((problem) => `  ! ${problem}`));
  lines.push(`Dalej: ${report.nextStep}`);

  if (report.prompt !== null) {
    lines.push("", "--- prompt wysłany do modelu (dokładnie ten tekst) ---", report.prompt);
  }

  return lines.join("\n");
}

/** The editor's save: the whole file, as typed. */
async function runProjectRules(argv: readonly string[]): Promise<Result<string>> {
  const parsed = parse(argv, { json: { type: "boolean" }, text: { type: "string" } });

  if (!parsed.ok) {
    return parsed;
  }

  const projectId = requirePositional(parsed.data, 0, "project-id");
  const { text } = parsed.data.values;
  const workspace = workspaceOf(parsed.data);

  if (!projectId.ok) {
    return projectId;
  }
  if (typeof text !== "string") {
    return err(new UsageError("brak --text: project rules zapisuje project.md podanym tekstem"));
  }
  if (!workspace.ok) {
    return workspace;
  }

  const mode = modeOf(parsed.data);
  const result = await writeRules({
    mode,
    projectId: projectId.data,
    text,
    workspace: workspace.data,
  });

  return result.ok
    ? ok(
        answerStage0(
          answerFlag(parsed.data),
          "project rules",
          `Zapisano zasady projektu "${projectId.data}"`,
          result.data,
          mode
        )
      )
    : result;
}

export async function runProject(argv: readonly string[]): Promise<Result<string>> {
  if (argv[0] === "draft") {
    return runProjectDraft(argv.slice(1));
  }

  if (argv[0] === "rules") {
    return runProjectRules(argv.slice(1));
  }

  if (argv[0] === "voice") {
    return runProjectVoice(argv.slice(1));
  }

  if (argv[0] === "show") {
    return runProjectShow(argv.slice(1));
  }

  if (argv[0] === "style") {
    return runProjectStyle(argv.slice(1));
  }

  if (argv[0] !== "init") {
    return err(new UsageError(`nieznane polecenie: project ${argv[0] ?? ""}`.trim()));
  }

  // No `--character` here on purpose: the cast is declared by `character new`,
  // one entry at a time. A flag accepted and discarded would let somebody
  // believe they had named a character when nothing was written.
  const parsed = parse(argv.slice(1), {
    "aspect-ratio": { type: "string" },
    json: { type: "boolean" },
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
    ? ok(
        answerStage0(
          answerFlag(parsed.data),
          "project init",
          `Utworzono projekt "${projectId.data}"`,
          result.data,
          mode
        )
      )
    : result;
}

/**
 * `check` with no `--stage`, and `--stage prepare`: whether stage 0 is ready,
 * and whether it is accepted.
 *
 * What to print travels in rather than being defaulted, for the reason stage 1
 * gives: both callers are in `check.ts`, the wide question renders prose and
 * the narrow one renders whichever the flag asked for, and a default would
 * decide for the next caller silently.
 */
export async function checkPrepareStage(
  projectId: string,
  workspace: Workspace,
  answer: Answer
): Promise<Result<string>> {
  const result = await checkStage0({ projectId, workspace });

  return result.ok
    ? ok(
        answerStage0(answer, "check", `Projekt "${projectId}", etap 0 gotowy`, result.data, "apply")
      )
    : result;
}

/** `approve` with no `--stage`, and `--stage prepare`: the default acceptance. */
export async function approvePrepareStage(approval: Approval): Promise<Result<string>> {
  const result = await approveStage0(approval);

  return result.ok
    ? ok(
        answerStage0(
          approval.answer,
          "approve",
          `Etap 0 projektu "${approval.projectId}" zatwierdzony`,
          result.data,
          approval.mode
        )
      )
    : result;
}
