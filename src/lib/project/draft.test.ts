import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { docx } from "../../test/fixture.js";
import { addImport, groupImport } from "../import/index.js";
import { resolveWorkspace, type Workspace } from "../workspace.js";
import { checkStage0, draftRules, initProject } from "./index.js";

/**
 * `project.md` drafted from an import's grouping, through the module entry.
 * What is asserted is that the model only fills fields: the document is the
 * scaffold's, the provenance is the code's, approval stays a person's, and
 * nobody's hand edit is ever written over.
 */

const API_KEY = "sk-test-0123456789";

const MATERIAL = [
  "# Miko i skarb na talerzu",
  "",
  "Seria o jedzeniu, które ma wartość. Dla dzieci 4–9 lat.",
  "",
  "## Styl",
  "",
  "Animacja 3D, miętowa lodówka, ciepłe światło.",
  "",
  "## Miko",
  "",
  "Miko to solenizant w błękitnej bluzie.",
  "",
  "## Odcinek: Pola",
  "",
  "Miko idzie na pole i znajduje skarb.",
  "",
].join("\n");

const GROUPING = {
  characters: [{ id: "miko", name: "Miko" }],
  sections: [
    { id: "T01", routes: ["series"] },
    { id: "T02", routes: ["style"] },
    { id: "T03", routes: ["character:miko"] },
    { id: "T04", routes: ["episode:01-pola"] },
  ],
};

/** What the material settles, and what the model only proposes. */
function said(text: string): { grounded: boolean; text: string } {
  return { grounded: true, text };
}

function proposed(text: string): { grounded: boolean; text: string } {
  return { grounded: false, text };
}

const ANSWER = {
  alwaysNever: proposed("none"),
  audience: said("Dzieci 4–9 lat, ciepło i z humorem."),
  cast: proposed("brak stałej obsady"),
  continuity: proposed("Kuchnia i lodówka zawsze te same."),
  episodeRule: proposed("Jeden odcinek, jedno odkrycie o jedzeniu."),
  linework: proposed("no outlines, soft rounded edges"),
  opening: proposed("brak dodatkowych ograniczeń"),
  openQuestions: proposed("Brak"),
  palette: proposed("mint #A8E6CF, cream #FFF5E1"),
  proportions: proposed("głowa do ciała 1:3"),
  props: proposed("brak"),
  protagonist: proposed("Miko, uczestnik wydarzeń."),
  relations: proposed("Dzieci tej samej wielkości głowy."),
  scenery: proposed("- Kuchnia: kremowa, słoneczna.\n- Lodówka: miętowa."),
  styleLine: said("stylized 3D CGI, soft rounded shapes, warm pastel palette, warm kitchen light"),
  theme: said("Jedzenie ma wartość."),
  traits: said("- Miko: błękitna bluza, beżowe spodnie.\n- Pola: żółta sukienka."),
  world: proposed("Współczesna polska kuchnia."),
};

/** The line the code writes, never the model: when, by what, from which parts. */
const PROVENANCE =
  /- Przygotowano: \d{4}-\d{2}-\d{2}, szkic modelu gpt-test z importu „miko” \(series, style, postacie: 1, odcinki: 1\)\. Propozycja do przeczytania i poprawy, nie decyzja\.\n/;

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };
let calls = 0;

function completion(answer: unknown): typeof fetch {
  const body = JSON.stringify({
    id: "resp_1",
    model: "gpt-test",
    output: [
      {
        content: [{ text: JSON.stringify(answer), type: "output_text" }],
        role: "assistant",
        type: "message",
      },
    ],
    status: "completed",
  });

  return (() => {
    calls += 1;
    return Promise.resolve(
      new Response(body, { headers: { "x-request-id": "req_1" }, status: 200 })
    );
  }) as unknown as typeof fetch;
}

/** An import of `MATERIAL`, grouped by `GROUPING`, and the project `miko` beside it. */
async function prepare(grouped = true): Promise<void> {
  const path = join(scratch, "miko.docx");

  await writeFile(path, docx("<w:p><w:r><w:t>x</w:t></w:r></w:p>"));
  await addImport({ importId: "miko", mode: "apply", sourcePath: path, workspace });
  await writeFile(join(root, "imports", "miko", "material.md"), MATERIAL);

  if (grouped) {
    await groupImport({
      apiKey: API_KEY,
      fetch: completion(GROUPING),
      importId: "miko",
      maxOutputTokens: 16_000,
      mode: "apply",
      model: "gpt-test",
      regenerate: false,
      republish: false,
      workspace,
    });
  }

  await initProject({
    aspectRatio: "16:9",
    mode: "apply",
    projectId: "miko",
    title: "Miko",
    workspace,
  });
  calls = 0;
}

async function draft(
  overrides: Partial<Parameters<typeof draftRules>[0]> = {}
): ReturnType<typeof draftRules> {
  return await draftRules({
    apiKey: API_KEY,
    fetch: completion(ANSWER),
    importId: "miko",
    maxOutputTokens: 16_000,
    mode: "apply",
    model: "gpt-test",
    projectId: "miko",
    regenerate: false,
    republish: false,
    workspace,
    ...overrides,
  });
}

function rules(): Promise<string> {
  return readFile(join(root, "projects", "miko", "project.md"), "utf8");
}

function errorOf(result: { readonly ok: boolean; readonly error?: Error }): string {
  return result.ok ? "" : (result.error?.message ?? "");
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aimator-draft-"));
  root = join(scratch, "workspace");
  const resolved = resolveWorkspace(root);
  workspace = resolved.ok ? resolved.data : { root: "" };
  calls = 0;
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

describe("draftRules", () => {
  it("previews the prompt and a bill of one call with --dry-run, sending and writing nothing", async () => {
    await prepare();
    const scaffold = await rules();
    const result = await draft({ apiKey: null, mode: "dry-run" });

    expect(result.ok ? result.data.paidCalls : null).toBe(1);
    expect(result.ok ? result.data.problems : null).toEqual([]);
    expect(result.ok ? result.data.prompt : "").toContain("<<< series\n# Miko i skarb na talerzu");
    expect(result.ok ? result.data.prompt : "").toContain(
      "<<< character:miko\n## Miko\n\nMiko to solenizant w błękitnej bluzie.\n>>> character:miko"
    );
    // What recurs is learnt from an episode too; its plot is forbidden by the task.
    expect(result.ok ? result.data.prompt : "").toContain("<<< episode:01-pola\n");
    expect(result.ok ? result.data.prompt : "").toContain(
      "# The project\n\n- Title: Miko\n- Frame aspect ratio: 16:9\n- Cast: nobody declared yet\n"
    );
    expect(calls).toBe(0);
    expect(await rules()).toBe(scaffold);
    expect(existsSync(join(root, "projects", "miko", "rules.stage.json"))).toBe(false);
  });

  it("fills what the material says, keeps each proposal behind its marker, and leaves the yes", async () => {
    await prepare();
    const result = await draft();
    const text = await rules();

    expect(calls).toBe(1);
    expect(text).toContain("- Temat projektu: Jedzenie ma wartość.\n");
    expect(text).toContain(
      "- Stałe cechy wyglądu i stroju:\n  - Miko: błękitna bluza, beżowe spodnie.\n  - Pola: żółta sukienka.\n"
    );
    expect(text).toContain(
      "## Style Bible\n\n- Style line: stylized 3D CGI, soft rounded shapes, warm pastel palette, warm kitchen light\n"
    );
    expect(text).toContain(
      "- Zasada odcinka: TODO(etap-0) propozycja: Jeden odcinek, jedno odkrycie o jedzeniu.\n"
    );
    expect(text).toContain(
      "- Powracająca sceneria: TODO(etap-0) propozycja:\n  - Kuchnia: kremowa, słoneczna.\n  - Lodówka: miętowa.\n"
    );
    expect(text).toMatch(PROVENANCE);
    expect(text).toContain("- Zatwierdzone przez użytkownika: TODO(etap-0) zakres decyzji.");
    expect(result.ok ? result.data.left : []).toContain("Zasada odcinka");
    expect(result.ok ? result.data.left : []).toContain("Zatwierdzone przez użytkownika");
    expect(result.ok ? result.data.left : []).not.toContain("Temat projektu");
    expect(result.ok ? result.data.created : []).toContain("projects/miko/project.md");

    // Still a proposal: stage 0 refuses while a marker is left.
    expect(errorOf(await checkStage0({ projectId: "miko", workspace }))).toContain("TODO(etap-0)");
  });

  it("records the draft beside stage 0, never in it, with what it read", async () => {
    await prepare();
    const before = await readFile(join(root, "projects", "miko", "prepare.stage.json"), "utf8");

    await draft();
    const record = JSON.parse(
      await readFile(join(root, "projects", "miko", "rules.stage.json"), "utf8")
    );

    expect(record.stage).toBe("rules");
    expect(record.artifacts.rules.inputs.map(({ path }: { path: string }) => path)).toEqual([
      "projects/miko/project.json",
      "imports/miko/grouped/series.md",
      "imports/miko/grouped/style.md",
      "imports/miko/grouped/characters/miko.md",
      "imports/miko/grouped/episodes/01-pola.md",
    ]);
    expect(record.artifacts.rules.outputs.map(({ path }: { path: string }) => path)).toEqual([
      "projects/miko/project.md",
    ]);
    expect(await readdir(join(root, "projects", "miko", "runs"))).toHaveLength(1);
    expect(await readFile(join(root, "projects", "miko", "prepare.stage.json"), "utf8")).toBe(
      before
    );
  });

  it("never writes over a hand edit, but replaces its own untouched draft under --regenerate", async () => {
    await prepare();
    await draft();

    const again = await draft({
      fetch: completion({ ...ANSWER, theme: said("Drugi szkic.") }),
      regenerate: true,
    });

    expect(again.ok).toBe(true);
    expect(await rules()).toContain("- Temat projektu: Drugi szkic.\n");

    await writeFile(join(root, "projects", "miko", "project.md"), "# Miko\n\nMoje zasady.\n");
    calls = 0;

    expect(errorOf(await draft({ regenerate: true }))).toContain(
      "projects/miko/project.md poprawiono ręcznie, a szkic nadpisałby tę pracę"
    );
    expect(calls).toBe(0);
    expect(await rules()).toBe("# Miko\n\nMoje zasady.\n");
  });

  it("refuses an answer that would break the document or pass for a person's, writing nothing", async () => {
    await prepare();
    const scaffold = await rules();
    const result = await draft({
      fetch: completion({
        ...ANSWER,
        opening: proposed("  "),
        theme: proposed("TODO(etap-0) do ustalenia"),
        world: said("Kuchnia\n## Nowa sekcja"),
      }),
    });

    expect(errorOf(result)).toContain("pole opening jest puste");
    expect(errorOf(result)).toContain("pole theme zawiera znacznik TODO(etap-0)");
    expect(errorOf(result)).toContain("pole world zawiera nagłówek");
    expect(await rules()).toBe(scaffold);
  });

  it("refuses without a grouping to read, a model or a key, naming each", async () => {
    await prepare(false);
    const preview = await draft({ apiKey: null, mode: "dry-run", model: null });

    expect(preview.ok ? preview.data.problems : []).toEqual([
      'import "miko" nie ma podziału, a szkic czyta podział: aimator import group miko --dry-run',
      "brak modelu tekstowego, wskaż go przez --model <id> albo AIMATOR_RULES_MODEL",
    ]);
    expect(preview.ok ? preview.data.paidCalls : null).toBe(0);
    expect(errorOf(await draft({ apiKey: null }))).toContain("brak OPENAI_API_KEY");
    expect(calls).toBe(0);
  });

  it("refuses a project or an import that does not exist", async () => {
    await prepare();

    expect(errorOf(await draft({ projectId: "brak" }))).toContain('projekt "brak" nie istnieje');
    expect(errorOf(await draft({ importId: "brak" }))).toContain('import "brak" nie istnieje');
  });
});
