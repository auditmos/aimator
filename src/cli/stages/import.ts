import { addImport, type ImportReport, listImports, showImport } from "../../lib/import/index.js";
import { err, ok, type Result } from "../../lib/result.js";
import {
  answerFlag,
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
export const USAGE = `Import materiału (darmowy; przed etapem 0, nie zakłada projektu):
  import add <id> --source <plik.docx> [--json]
    Kopiuje dokument Worda do imports/<id>/ i zamienia go na material.md:
    nagłówki, akapity, pogrubienia, listy, tabele, a obrazy jako images/I01.png
    w bajtach, w których dokument je trzymał, w miejscu, w którym stały.
    Fragment tekstu, którego konwerter nie umie umieścić (np. pole tekstowe,
    przypis), odrzuca cały import, zanim cokolwiek zapisze. Import się nie
    nadpisuje: nowa próba to nowy identyfikator.
  import show <id> [--json]
    Sekcje T01… liczone z nagłówków obecnego material.md, więc ręczna poprawka
    je przelicza, obrazy i sekcje, które je pokazują, oraz uwagi: co konwersja
    pominęła i co zmieniono ręcznie. Niczego nie zapisuje.
  import list [--json]
    Identyfikatory importów w katalogu roboczym. Niczego nie zapisuje.`;

/** Copies and converts: the one subcommand that writes. */
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
      ...(imports.length === 0 ? ["  Brak importów."] : imports.map((id) => `  ${id}`)),
      `Dalej: ${first === undefined ? "aimator import add <id> --source <plik.docx>" : `aimator import show ${first}`}`,
    ].join("\n")
  );
}

/** The material, its sections and pictures, what was left out, and what next. */
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
  lines.push(...report.notices.map((notice) => `  · ${notice}`));
  lines.push(`Dalej: ${report.nextStep}`);

  return lines;
}

export async function runImport(argv: readonly string[]): Promise<Result<string>> {
  const [action] = argv;

  if (action !== "add" && action !== "show" && action !== "list") {
    return err(new UsageError(`nieznane polecenie: import ${action ?? ""}`.trim()));
  }

  const parsed = parse(argv.slice(1), {
    json: { type: "boolean" },
    ...(action === "add" ? { source: { type: "string" as const } } : {}),
  });

  if (!parsed.ok) {
    return parsed;
  }

  if (action === "add") {
    return await runImportAdd(parsed.data);
  }

  return action === "show" ? await runImportShow(parsed.data) : await runImportList(parsed.data);
}
