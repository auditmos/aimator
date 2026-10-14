import { env } from "../../lib/env.js";
import {
  addImport,
  type GroupReport,
  groupImport,
  type ImportReport,
  listImports,
  showImport,
} from "../../lib/import/index.js";
import { err, ok, type Result } from "../../lib/result.js";
import {
  answerFlag,
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

/**
 * A document brought in before any project exists: converted, never decided.
 *
 * Not a numbered stage, so its block says where it sits rather than opening
 * with `Etap N.`. It writes under `imports/`, beside `projects/`, so nothing it
 * does can lapse an approval, and what becomes of the material is stage 0's.
 */
export const USAGE = `Import materiału (przed etapem 0, nie zakłada projektu; płatne jest tylko group):
  import add <id> --source <plik.docx> [--json]
    Kopiuje dokument Worda do imports/<id>/ i zamienia go na material.md:
    nagłówki, akapity, pogrubienia, listy, tabele, a obrazy jako images/I01.png
    w bajtach, w których dokument je trzymał, w miejscu, w którym stały.
    Fragment tekstu, którego konwerter nie umie umieścić (np. pole tekstowe,
    przypis), odrzuca cały import, zanim cokolwiek zapisze. Import się nie
    nadpisuje: nowa próba to nowy identyfikator.
  import group <id> [--model <id>] [--max-output-tokens <n>] [--dry-run] [--json]
               [--regenerate [--instruction <uwaga>]]
               [--republish]   ← publikuje zapisaną odpowiedź, nic nie wysyła
    Jedno płatne wywołanie modelu tekstowego (AIMATOR_IMPORT_MODEL): model mówi
    tylko, dokąd idzie każda sekcja (seria, styl, postać, odcinek albo reszta),
    a imports/<id>/grouped/** to te sekcje skopiowane dosłownie. Obraz idzie
    z sekcją, w której stoi. Nikt podziału nie zatwierdza: to propozycja, którą
    skill /prepare-project czyta razem z człowiekiem.
  import show <id> [--json]
    Sekcje T01… liczone z nagłówków obecnego material.md, więc ręczna poprawka
    je przelicza, obrazy i sekcje, które je pokazują, pliki podziału oraz
    uwagi: co konwersja pominęła i co zmieniono ręcznie. Niczego nie zapisuje.
  import list [--json]
    Importy w katalogu roboczym, każdy z liczbą plików podziału: import
    podzielony jest gotowy do etapu 0. Niczego nie zapisuje.`;

/** Copies and converts: free, and nothing in it is a decision. */
async function runImportAdd(parsed: Parsed): Promise<Result<string>> {
  const importId = requirePositional(parsed, 0, "id");
  const source = requireFlag(parsed, "source");
  const workspace = workspaceOf(parsed);

  if (!importId.ok) {
    return importId;
  }
  if (!source.ok) {
    return source;
  }
  if (!workspace.ok) {
    return workspace;
  }

  const mode = modeOf(parsed);
  const result = await addImport({
    importId: importId.data,
    mode,
    sourcePath: source.data,
    workspace: workspace.data,
  });

  if (!result.ok) {
    return result;
  }

  if (answerFlag(parsed) === "json") {
    return ok(JSON.stringify({ command: "import add", ...result.data }, null, 2));
  }

  const headline = `Import "${result.data.importId}" z ${result.data.originPath}`;

  return ok(
    [
      mode === "dry-run" ? `Próba na sucho: nic nie zapisano. ${headline}` : headline,
      ...result.data.created.map((path) => `  + ${path}`),
      ...renderContents(result.data),
    ].join("\n")
  );
}

/** `--model` wins over the environment; neither has a default. */
function importModelOf(parsed: Parsed): Result<string | null> {
  const flag = parsed.values.model;
  const value = typeof flag === "string" ? flag : (env.AIMATOR_IMPORT_MODEL ?? null);

  if (value !== null && !MODEL_ID.test(value)) {
    return err(new UsageError(`niepoprawny identyfikator modelu "${value}"`));
  }

  return ok(value);
}

/** The one paid subcommand: a bill and the prompt first, then one call. */
async function runImportGroup(parsed: Parsed): Promise<Result<string>> {
  const instruction = instructionOf(parsed);
  const importId = requirePositional(parsed, 0, "id");
  const workspace = workspaceOf(parsed);
  const model = importModelOf(parsed);
  const tokens = maxOutputTokensOf(parsed);

  if (!instruction.ok) {
    return instruction;
  }
  if (!importId.ok) {
    return importId;
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

  if (parsed.values.regenerate === true && parsed.values.republish === true) {
    return err(
      new UsageError(
        "--regenerate i --republish wykluczają się: pierwsze płaci za nową odpowiedź, drugie publikuje zapisaną"
      )
    );
  }

  const mode = modeOf(parsed);
  // The key is read only on the paid path: a dry run must never need a secret.
  const result = await groupImport({
    apiKey: mode === "dry-run" ? null : (env.OPENAI_API_KEY ?? null),
    fetch,
    importId: importId.data,
    instruction: instruction.data,
    maxOutputTokens: tokens.data,
    mode,
    model: model.data,
    regenerate: parsed.values.regenerate === true,
    republish: parsed.values.republish === true,
    workspace: workspace.data,
  });

  if (!result.ok) {
    return result;
  }

  return ok(
    answerFlag(parsed) === "json"
      ? JSON.stringify({ command: "import group", ...result.data }, null, 2)
      : renderGroup(result.data, mode)
  );
}

/** The bill and the prompt before a call; the files and their sections after it. */
function renderGroup(report: GroupReport, mode: "apply" | "dry-run"): string {
  const lines =
    mode === "dry-run"
      ? [
          `Próba na sucho: nic nie zapisano, nic nie wysłano. Podział importu "${report.importId}"`,
          `  płatnych wywołań do wykonania: ${report.paidCalls}`,
          "  OPENAI_API_KEY nie był czytany, bo próba na sucho nie sięga po sekrety; płatne wywołanie go wymaga",
          "  obrazy nie są wysyłane: model czyta tylko tekst, a obraz idzie z sekcją, w której stoi",
        ]
      : [
          `Podział importu "${report.importId}", próba ${report.runId ?? ""}`,
          `  płatnych wywołań wykonanych: ${report.paidCalls}`,
        ];

  lines.push(...correctionLines(report.correction));
  lines.push(
    ...report.files.map(
      (file) => `  + ${file.path}  ${file.destination}: ${file.sections.join(", ")}`
    )
  );
  lines.push(...report.problems.map((problem) => `  ! ${problem}`));
  lines.push(`Dalej: ${report.nextStep}`);

  if (report.prompt !== null) {
    lines.push("", "--- prompt wysłany do modelu (dokładnie ten tekst) ---", report.prompt);
  }

  return lines.join("\n");
}

async function runImportShow(parsed: Parsed): Promise<Result<string>> {
  const importId = requirePositional(parsed, 0, "id");
  const workspace = workspaceOf(parsed);

  if (!importId.ok) {
    return importId;
  }
  if (!workspace.ok) {
    return workspace;
  }

  const result = await showImport({ importId: importId.data, workspace: workspace.data });

  if (!result.ok) {
    return result;
  }

  return ok(
    answerFlag(parsed) === "json"
      ? JSON.stringify({ command: "import show", ...result.data }, null, 2)
      : [
          `Import "${result.data.importId}" z ${result.data.originPath}`,
          ...renderContents(result.data),
        ].join("\n")
  );
}

async function runImportList(parsed: Parsed): Promise<Result<string>> {
  const workspace = workspaceOf(parsed);

  if (!workspace.ok) {
    return workspace;
  }

  const imports = await listImports(workspace.data);

  if (answerFlag(parsed) === "json") {
    return ok(
      JSON.stringify({ command: "import list", imports, workspace: workspace.data.root }, null, 2)
    );
  }

  const [first] = imports;

  return ok(
    [
      `Importy w ${workspace.data.root}:`,
      ...(imports.length === 0
        ? ["  Brak importów."]
        : imports.map(({ grouped, id }) =>
            grouped === 0
              ? `  ${id}  niepodzielony`
              : `  ${id}  podzielony (plików: ${grouped}), gotowy do etapu 0`
          )),
      `Dalej: ${first === undefined ? "aimator import add <id> --source <plik.docx>" : `aimator import show ${first.id}`}`,
    ].join("\n")
  );
}

/** The material, its sections and pictures, the grouping, what was left out, and what next. */
function renderContents(report: ImportReport): string[] {
  const lines = [`Materiał: ${report.material}`, `Sekcje (${report.sections.length}):`];

  for (const section of report.sections) {
    const heading =
      section.title === null
        ? "(przed pierwszym nagłówkiem)"
        : `${"#".repeat(section.level)} ${section.title}`;
    const images = section.images.length === 0 ? "" : `  ${section.images.join(", ")}`;

    lines.push(`  ${section.id}  ${heading}  ${section.characters} zn.${images}`);
  }

  lines.push(`Obrazy (${report.images.length}):`);
  lines.push(
    ...report.images.map(
      (image) =>
        `  ${image.id}  ${image.path}  ← ${image.part}${image.sections.length === 0 ? "" : `  w ${image.sections.join(", ")}`}`
    )
  );

  if (report.grouped.length > 0) {
    lines.push(
      `Podział (${report.grouped.length}):`,
      ...report.grouped.map(
        ({ destination, name, path }) =>
          `  ${path}  ${destination}${name === null ? "" : `  „${name}”`}`
      )
    );
  }

  lines.push(...report.notices.map((notice) => `  · ${notice}`));
  lines.push(`Dalej: ${report.nextStep}`);

  return lines;
}

/** The flags `import group` takes beyond the common ones. */
const GROUP_OPTIONS = {
  instruction: { type: "string" },
  "max-output-tokens": { type: "string" },
  model: { type: "string" },
  regenerate: { type: "boolean" },
  republish: { type: "boolean" },
} as const;

export async function runImport(argv: readonly string[]): Promise<Result<string>> {
  const [action] = argv;

  if (action !== "add" && action !== "group" && action !== "show" && action !== "list") {
    return err(new UsageError(`nieznane polecenie: import ${action ?? ""}`.trim()));
  }

  const parsed = parse(argv.slice(1), {
    json: { type: "boolean" },
    ...(action === "add" ? { source: { type: "string" as const } } : {}),
    ...(action === "group" ? GROUP_OPTIONS : {}),
  });

  if (!parsed.ok) {
    return parsed;
  }

  if (action === "add") {
    return await runImportAdd(parsed.data);
  }

  if (action === "group") {
    return await runImportGroup(parsed.data);
  }

  return action === "show" ? await runImportShow(parsed.data) : await runImportList(parsed.data);
}
