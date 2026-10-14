import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { docx } from "../../test/fixture.js";
import { run } from "../index.js";

/**
 * `import`: a document brought in before any project exists. What converting
 * means is `lib/import`'s and tested there; this holds the command to the two
 * promises every command here makes:
 *
 * - **`--json` prints the module's own object**, with the subcommand in
 *   `command`, so a screen and an agent read what the terminal prints.
 * - **A refusal stays in `Result`**, with or without `--json`.
 */

let root = "";
let scratch = "";
let source = "";

async function cli(...argv: readonly string[]): Promise<{ ok: boolean; text: string }> {
  const result = await run([...argv, "--workspace", root]);

  return result.ok ? { ok: true, text: result.data } : { ok: false, text: result.error.message };
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aimator-cli-import-"));
  root = join(scratch, "workspace");
  source = join(scratch, "treatment.docx");
  await writeFile(
    source,
    docx('<w:p><w:pPr><w:pStyle w:val="Nagwek1"/></w:pPr><w:r><w:t>Pola</w:t></w:r></w:p>')
  );
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

describe("import add", () => {
  it("prints the import as the module reports it, with --json", async () => {
    const added = await cli("import", "add", "miko", "--source", source, "--json");
    const report = JSON.parse(added.text);

    expect(report.command).toBe("import add");
    expect(report.importId).toBe("miko");
    expect(report.sections).toEqual([
      { characters: 0, id: "T01", images: [], level: 1, title: "Pola" },
    ]);
    expect(existsSync(join(root, "imports", "miko", "material.md"))).toBe(true);
  });

  it("names what is missing from the command line", async () => {
    expect(await cli("import", "add", "miko")).toEqual({
      ok: false,
      text: "brakuje wymaganej flagi --source",
    });
    expect(await cli("import", "add", "--source", source)).toEqual({
      ok: false,
      text: "brakuje argumentu <id>",
    });
  });

  it("keeps a refusal in Result, with --json too", async () => {
    await writeFile(source, "zwykły tekst");

    const refused = await cli("import", "add", "miko", "--source", source, "--json");

    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("to nie jest plik .docx");
  });
});

describe("import show of a material that writes to the terminal", () => {
  it("prints its control characters as text, not as commands", async () => {
    await cli("import", "add", "miko", "--source", source);
    // OSC 0 retitles the window, CSI 2J clears the screen, U+009B is CSI in 8 bits.
    await writeFile(
      join(root, "imports", "miko", "material.md"),
      "# Pola\u001b]0;pwned\u0007\u001b[2J\u009b31m\n"
    );

    const shown = await cli("import", "show", "miko");

    expect(shown.text).toContain("# Pola\\u001b]0;pwned\\u0007\\u001b[2J\\u009b31m  0 zn.");
    expect(shown.text).not.toContain("\u001b");
    expect(shown.text).not.toContain("\u009b");
  });
});

describe("import show and list", () => {
  it("prints an import and the list of them, with --json", async () => {
    await cli("import", "add", "miko", "--source", source);

    const shown = JSON.parse((await cli("import", "show", "miko", "--json")).text);
    const listed = JSON.parse((await cli("import", "list", "--json")).text);

    expect(shown.command).toBe("import show");
    expect(shown.material).toBe("imports/miko/material.md");
    expect(listed).toEqual({
      command: "import list",
      imports: [{ grouped: 0, id: "miko" }],
      workspace: root,
    });
  });

  it("says so when there is nothing to list", async () => {
    expect((await cli("import", "list")).text).toContain("Brak importów.");
  });

  it("refuses a subcommand it does not have", async () => {
    expect(await cli("import", "sort", "miko")).toEqual({
      ok: false,
      text: "nieznane polecenie: import sort",
    });
    const bare = await run(["import"]);

    expect(bare.ok ? "" : bare.error.message).toBe("nieznane polecenie: import");
  });
});

describe("import group", () => {
  beforeEach(async () => {
    await cli("import", "add", "miko", "--source", source);
  });

  it("prints the bill and the exact prompt as the module reports them, with --json", async () => {
    const shown = await cli(
      "import",
      "group",
      "miko",
      "--model",
      "gpt-test",
      "--dry-run",
      "--json"
    );
    const report = JSON.parse(shown.text);

    expect(report.command).toBe("import group");
    expect(report.paidCalls).toBe(1);
    expect(report.prompt).toContain("<<< T01\n# Pola\n\n>>> T01");
    expect(existsSync(join(root, "imports", "miko", "grouped"))).toBe(false);
  });

  it("refuses flags that contradict each other before anything is read", async () => {
    expect(await cli("import", "group", "miko", "--regenerate", "--republish")).toEqual({
      ok: false,
      text: "--regenerate i --republish wykluczają się: pierwsze płaci za nową odpowiedź, drugie publikuje zapisaną",
    });
    expect((await cli("import", "group", "miko", "--instruction", "Krócej.")).text).toBe(
      "--instruction poprawia opublikowaną wersję, a to nowa płatna próba: wymaga --regenerate"
    );
    expect((await cli("import", "group", "miko", "--model", "zły model")).text).toBe(
      'niepoprawny identyfikator modelu "zły model"'
    );
  });
});
