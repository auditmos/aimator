import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { docx } from "../../test/fixture.js";
import { sha256Of } from "../artifact/index.js";
import { resolveWorkspace, type Workspace } from "../workspace.js";
import { addImport, groupImport } from "./index.js";

/**
 * Grouping: the one paid step of an import, through the module entry. The
 * model only routes, so what is asserted is that the files are the material,
 * copied, and that every answer the validator can refuse is refused before a
 * file is written.
 */

const API_KEY = "sk-test-0123456789";

const MATERIAL = [
  "Wstęp bez nagłówka.",
  "",
  "# Miko i skarb na talerzu",
  "",
  "Seria o jedzeniu, które ma wartość.",
  "",
  "## Styl",
  "",
  "Plastelina, ciepłe światło.",
  "",
  "## Miko",
  "",
  "Miko to ciekawski kot.",
  "",
  "![I01](images/I01.png)",
  "",
  "## Odcinek: Pola",
  "",
  "Miko idzie na pole.",
  "",
  "## Odcinek: Sad",
  "",
  "Jabłka w sadzie.",
  "",
  "## Budżet",
  "",
  "Sto złotych.",
  "",
].join("\n");

const ANSWER = {
  characters: [{ id: "miko", name: "Miko" }],
  sections: [
    { id: "T01", routes: ["other"] },
    { id: "T02", routes: ["series"] },
    { id: "T03", routes: ["style"] },
    { id: "T04", routes: ["character:miko", "series"] },
    { id: "T05", routes: ["episode:01-pola"] },
    { id: "T06", routes: ["episode:02-sad"] },
    { id: "T07", routes: ["other"] },
  ],
};

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };
let calls = 0;

function completion(answer: unknown): typeof fetch {
  const body = JSON.stringify({
    id: "resp_grouping_1",
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

/** An import whose `material.md` is `MATERIAL`, with one picture, `I01`. */
async function prepare(importId = "miko"): Promise<void> {
  const path = join(scratch, `${importId}.docx`);
  const picture = `<w:r><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId10"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

  await writeFile(path, docx(`<w:p><w:r><w:t>x</w:t></w:r>${picture}</w:p>`));
  await addImport({ importId, mode: "apply", sourcePath: path, workspace });
  await writeFile(join(root, "imports", importId, "material.md"), MATERIAL);
}

async function group(
  overrides: Partial<Parameters<typeof groupImport>[0]> = {}
): ReturnType<typeof groupImport> {
  return await groupImport({
    apiKey: API_KEY,
    fetch: completion(ANSWER),
    importId: "miko",
    maxOutputTokens: 16_000,
    mode: "apply",
    model: "gpt-test",
    regenerate: false,
    republish: false,
    workspace,
    ...overrides,
  });
}

function grouped(...segments: string[]): string {
  return join(root, "imports", "miko", "grouped", ...segments);
}

function errorOf(result: { readonly ok: boolean; readonly error?: Error }): string {
  return result.ok ? "" : (result.error?.message ?? "");
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aimator-group-"));
  root = join(scratch, "workspace");
  const resolved = resolveWorkspace(root);
  workspace = resolved.ok ? resolved.data : { root: "" };
  calls = 0;
  await prepare();
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

describe("groupImport", () => {
  it("previews the exact prompt and a bill of one call with --dry-run, sending and writing nothing", async () => {
    const result = await group({ apiKey: null, mode: "dry-run" });
    const report = result.ok ? result.data : null;

    expect(report?.paidCalls).toBe(1);
    expect(report?.ready).toBe(true);
    expect(report?.nextStep).toBe("aimator import group miko");
    expect(report?.prompt).toContain(
      "<<< T04\n## Miko\n\nMiko to ciekawski kot.\n\n![I01](images/I01.png)\n\n>>> T04"
    );
    expect(report?.prompt).toContain("<<< T01\nWstęp bez nagłówka.\n\n>>> T01");
    expect(calls).toBe(0);
    expect(existsSync(grouped())).toBe(false);
  });

  it("copies each section verbatim into the files its routes name, in document order", async () => {
    const result = await group();

    expect(result.ok ? result.data.files : []).toEqual([
      {
        destination: "series",
        path: "imports/miko/grouped/series.md",
        sections: ["T02", "T04"],
      },
      { destination: "style", path: "imports/miko/grouped/style.md", sections: ["T03"] },
      {
        destination: "character:miko",
        path: "imports/miko/grouped/characters/miko.md",
        sections: ["T04"],
      },
      {
        destination: "episode:01-pola",
        path: "imports/miko/grouped/episodes/01-pola.md",
        sections: ["T05"],
      },
      {
        destination: "episode:02-sad",
        path: "imports/miko/grouped/episodes/02-sad.md",
        sections: ["T06"],
      },
      { destination: "other", path: "imports/miko/grouped/other.md", sections: ["T01", "T07"] },
    ]);
    expect(calls).toBe(1);
    expect(await readFile(grouped("series.md"), "utf8")).toBe(
      "# Miko i skarb na talerzu\n\nSeria o jedzeniu, które ma wartość.\n\n## Miko\n\nMiko to ciekawski kot.\n\n![I01](../images/I01.png)\n"
    );
    expect(await readFile(grouped("characters", "miko.md"), "utf8")).toBe(
      "## Miko\n\nMiko to ciekawski kot.\n\n![I01](../../images/I01.png)\n"
    );
    expect(await readFile(grouped("other.md"), "utf8")).toBe(
      "Wstęp bez nagłówka.\n\n## Budżet\n\nSto złotych.\n"
    );
  });

  it("records the material it read by digest, and archives the run beside the import", async () => {
    await group();

    const stage = JSON.parse(await readFile(grouped("import.stage.json"), "utf8"));
    const record = stage.artifacts.grouping;

    expect(stage.stage).toBe("import");
    expect(record.status).toBe("completed");
    expect(record.inputs).toEqual([
      { path: "imports/miko/material.md", sha256: sha256Of(Buffer.from(MATERIAL)) },
    ]);
    expect(await readdir(join(root, "imports", "miko", "runs"))).toEqual([record.runId]);
    expect(existsSync(join(root, "imports", "miko", "import.lock"))).toBe(false);
  });

  it("refuses every answer that routes outside the material, writing nothing to grouped/", async () => {
    const cases: readonly [string, typeof ANSWER, string][] = [
      [
        "a",
        { ...ANSWER, sections: [...ANSWER.sections, { id: "T99", routes: ["series"] }] },
        "sekcji T99 nie ma w materiale",
      ],
      [
        "b",
        { ...ANSWER, sections: ANSWER.sections.slice(1) },
        "bez przydziału zostały sekcje: T01",
      ],
      [
        "c",
        {
          ...ANSWER,
          sections: [{ id: "T01", routes: ["other", "series"] }, ...ANSWER.sections.slice(1)],
        },
        "przydział other stoi sam",
      ],
      [
        "d",
        { ...ANSWER, sections: [{ id: "T01", routes: ["scene"] }, ...ANSWER.sections.slice(1)] },
        'nieznany przydział "scene"',
      ],
      [
        "e",
        {
          ...ANSWER,
          sections: [{ id: "T01", routes: ["character:tata"] }, ...ANSWER.sections.slice(1)],
        },
        'postaci "tata", której nie zadeklarowano',
      ],
      [
        "f",
        { ...ANSWER, characters: [{ id: "miko", name: "Mikołaj" }] },
        'imienia "Mikołaj" (postać "miko") nie ma w żadnej sekcji',
      ],
      [
        "g",
        {
          ...ANSWER,
          sections: ANSWER.sections.map((section) =>
            section.id === "T05" ? { id: "T05", routes: ["episode:02-pola"] } : section
          ),
        },
        '"02-pola" pojawia się jako 01',
      ],
    ];

    for (const [importId, answer, reason] of cases) {
      // biome-ignore lint/performance/noAwaitInLoops: one import per answer, in order
      await prepare(importId);

      const result = await group({ fetch: completion(answer), importId });

      expect(errorOf(result)).toContain(reason);
      expect(errorOf(result)).toContain(`imports/${importId}/runs/`);
      expect(existsSync(join(root, "imports", importId, "grouped", "series.md"))).toBe(false);
    }
  });

  it("never pays twice: a finished grouping is replaced only by --regenerate", async () => {
    await group();

    const again = await group();

    expect(errorOf(again)).toContain("podział materiału już istnieje (imports/miko/grouped)");
    expect(calls).toBe(1);
  });

  it("sweeps a file the new grouping no longer writes, and keeps the old one in the run", async () => {
    await group();

    const merged = {
      ...ANSWER,
      sections: ANSWER.sections.map((section) =>
        section.id === "T06" ? { id: "T06", routes: ["episode:01-pola"] } : section
      ),
    };
    const result = await group({ fetch: completion(merged), regenerate: true });

    expect(result.ok ? result.data.files.map(({ destination }) => destination) : []).toContain(
      "episode:01-pola"
    );
    expect(existsSync(grouped("episodes", "02-sad.md"))).toBe(false);
    expect(await readFile(grouped("episodes", "01-pola.md"), "utf8")).toBe(
      "## Odcinek: Pola\n\nMiko idzie na pole.\n\n## Odcinek: Sad\n\nJabłka w sadzie.\n"
    );
    expect(calls).toBe(2);
  });

  it("refuses to pay without a model or a key, and to republish over a hand edit", async () => {
    expect(errorOf(await group({ apiKey: null, model: null }))).toEqual(
      [
        "grupowanie importu nie może wykonać płatnego wywołania:",
        "  - brak modelu tekstowego, wskaż go przez --model <id> albo AIMATOR_IMPORT_MODEL",
        "  - brak OPENAI_API_KEY w środowisku lub .env",
      ].join("\n")
    );

    await group();
    await writeFile(grouped("style.md"), "Poprawione ręcznie.\n");

    expect(errorOf(await group({ republish: true }))).toContain(
      "pliki poprawione ręcznie i nadpisał tę pracę: imports/miko/grouped/style.md"
    );
    expect(calls).toBe(1);
  });

  describe("with its record edited to name files outside grouped/", () => {
    const SECRET = "sekret spoza importu";

    beforeEach(async () => {
      await group();
      await mkdir(join(root, "projects"), { recursive: true });
      await writeFile(join(scratch, "outside.txt"), SECRET);
      await writeFile(join(root, "projects", "keep.md"), SECRET);
    });

    async function tamper(paths: readonly string[]): Promise<void> {
      const file = grouped("import.stage.json");
      const stage = JSON.parse(await readFile(file, "utf8"));

      stage.artifacts.grouping.outputs.push(
        ...paths.map((path) => ({ path, sha256: sha256Of(Buffer.from(SECRET)) }))
      );
      await writeFile(file, JSON.stringify(stage));
    }

    it("removes nothing it did not write there, and says the record was edited", async () => {
      await tamper(["../outside.txt", "projects/keep.md"]);

      const result = await group({ regenerate: true });

      expect(errorOf(result)).toContain(
        "imports/miko/grouped/import.stage.json wymienia pliki spoza imports/miko/grouped/: ../outside.txt, projects/keep.md"
      );
      expect(calls).toBe(1);
      expect(existsSync(join(scratch, "outside.txt"))).toBe(true);
      expect(existsSync(join(root, "projects", "keep.md"))).toBe(true);
    });

    it("sends the model nothing it did not write there", async () => {
      await tamper(["imports/miko/../../../outside.txt", "imports/miko/../../projects/keep.md"]);

      const bodies: string[] = [];
      const send = completion(ANSWER);
      const capture = ((url: string, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ""));
        return send(url, init);
      }) as unknown as typeof fetch;

      await group({ fetch: capture, instruction: "Postaw Miko w stylu.", regenerate: true });

      expect(bodies.join("")).not.toContain(SECRET);
    });
  });

  it("refuses an import that does not exist, naming the command that makes one", async () => {
    expect(errorOf(await group({ importId: "brak" }))).toBe(
      'import "brak" nie istnieje: aimator import add brak --source <plik.docx>'
    );
  });
});
