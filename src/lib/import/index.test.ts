import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jpeg, png } from "../../test/fixture.js";
import { sha256Of } from "../artifact/index.js";
import { resolveWorkspace, type Workspace } from "../workspace.js";
import { addImport, listImports, showImport } from "./index.js";

/**
 * The import: a `.docx` turned into `material.md` and its images, waiting
 * beside the projects. The document is built here, part by part, so each test
 * says exactly which Word construct it is about.
 *
 * Assumptions it encodes, stated before the first test:
 *
 * - **Nothing the body says may be lost silently.** A construct the converter
 *   cannot place refuses the import and names the words it would have lost.
 * - **An image keeps its bytes**, and the same picture shown twice is one file.
 * - **Sections are derived from `material.md` as it is now**, never stored, so
 *   a hand edit moves them with it.
 * - **An import is never rewritten.** It is thrown away and made again.
 */

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

const RELATIONSHIP = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const IMAGE = png(4, 4, 1);
const PHOTO = jpeg(4, 4);

const t = (text: string): string => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const bold = (text: string): string =>
  `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
const p = (content: string, properties = ""): string =>
  `<w:p>${properties === "" ? "" : `<w:pPr>${properties}</w:pPr>`}${content}</w:p>`;
const style = (id: string): string => `<w:pStyle w:val="${id}"/>`;
const list = (numId: number, level = 0): string =>
  `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`;
const drawing = (inner: string): string =>
  `<w:r><w:drawing><wp:inline><a:graphic><a:graphicData>${inner}</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
const picture = (id: string): string =>
  drawing(`<pic:pic><pic:blipFill><a:blip r:embed="${id}"/></pic:blipFill></pic:pic>`);
const cell = (text: string): string => `<w:tc><w:tcPr/>${p(t(text))}</w:tc>`;

const STYLES = `<w:styles xmlns:w="w">
<w:style w:type="paragraph" w:styleId="Normalny"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Tytu"><w:name w:val="Title"/><w:basedOn w:val="Normalny"/></w:style>
<w:style w:type="paragraph" w:styleId="Nagwek1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="Nagwek2"><w:name w:val="heading 2"/></w:style>
<w:style w:type="paragraph" w:styleId="Listapunktowana"><w:name w:val="List Bullet"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>
</w:styles>`;

const NUMBERING = `<w:numbering xmlns:w="w">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

const RELS = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${RELATIONSHIP}/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="${RELATIONSHIP}/numbering" Target="numbering.xml"/>
<Relationship Id="rId10" Type="${RELATIONSHIP}/image" Target="media/image1.png"/>
<Relationship Id="rId11" Type="${RELATIONSHIP}/image" Target="media/image2.jpeg"/>
<Relationship Id="rId20" Type="${RELATIONSHIP}/hyperlink" Target="https://example.com/miko" TargetMode="External"/>
<Relationship Id="rId30" Type="${RELATIONSHIP}/header" Target="header1.xml"/>
</Relationships>`;

/** A zip, written the way Word writes one: XML deflated, pictures stored. */
function zip(
  files: Readonly<Record<string, Buffer | string>>,
  declared: Readonly<Record<string, number>> = {}
): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === "string" ? Buffer.from(content) : content;
    const method = typeof content === "string" ? 8 : 0;
    const packed = method === 8 ? deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    const entry = Buffer.alloc(46);

    local.writeUInt32LE(0x04_03_4b_50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(declared[name] ?? data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    entry.writeUInt32LE(0x02_01_4b_50, 0);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(declared[name] ?? data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  const count = Object.keys(files).length;

  end.writeUInt32LE(0x06_05_4b_50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

/**
 * A `.docx` around `body`, with styles, lists, two pictures, a link and a page
 * header. `document` replaces the whole main part, `declared` lies about sizes.
 */
function docx(
  body: string,
  overrides: {
    readonly declared?: Readonly<Record<string, number>>;
    readonly document?: string;
  } = {}
): Buffer {
  return zip(
    {
      "_rels/.rels": `<Relationships><Relationship Id="rId1" Type="${RELATIONSHIP}/officeDocument" Target="word/document.xml"/></Relationships>`,
      "[Content_Types].xml": "<Types/>",
      "word/_rels/document.xml.rels": RELS,
      "word/document.xml":
        overrides.document ??
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="w" xmlns:r="r"><w:body>${body}<w:sectPr/></w:body></w:document>`,
      "word/header1.xml": `<w:hdr xmlns:w="w">${p(t("Miko | 1"))}</w:hdr>`,
      "word/media/image1.png": IMAGE,
      "word/media/image2.jpeg": PHOTO,
      "word/numbering.xml": NUMBERING,
      "word/styles.xml": STYLES,
    },
    overrides.declared
  );
}

async function source(bytes: Buffer, name = "treatment.docx"): Promise<string> {
  const path = join(scratch, name);

  await writeFile(path, bytes);

  return path;
}

async function add(bytes: Buffer, importId = "miko"): Promise<ReturnType<typeof addImport>> {
  return addImport({ importId, mode: "apply", sourcePath: await source(bytes), workspace });
}

function errorOf(result: { readonly ok: boolean; readonly error?: Error }): string {
  return result.ok ? "" : (result.error?.message ?? "");
}

const TREATMENT = [
  p(t("FILM 3D • 240 s")),
  p(t("Miko &amp; skarb"), style("Tytu")),
  p(t("Postacie"), style("Nagwek1")),
  p(picture("rId10")),
  p(t("Pola"), style("Nagwek2")),
  p(bold("POLA:") + t(" Kupujemy wszystko?")),
  p(t("pierwszy"), list(1)),
  p(t("drugi"), list(1, 1)),
  p(t("krok"), list(2)),
  `<w:tbl><w:tr>${cell("Ujęcie")}${cell("Czas")}</w:tr><w:tr>${cell("01")}${cell("0:07 | ok")}</w:tr></w:tbl>`,
  p(t("Kadry: ") + picture("rId10") + picture("rId11")),
  p(t("# nie nagłówek")),
  p(`<w:hyperlink r:id="rId20">${t("strona")}</w:hyperlink>`),
  p(`${t("zostaje")}<w:del><w:r><w:delText>skreślone</w:delText></w:r></w:del>`),
  p(`${t("Linia")}<w:r><w:br/></w:r>${t("druga")}`),
  p(t("Plan"), style("Nagwek1")),
  p(t("Lista ze stylu"), style("Listapunktowana")),
].join("");

const MATERIAL = `FILM 3D • 240 s

# Miko & skarb

## Postacie

![I01](images/I01.png)

### Pola

**POLA:** Kupujemy wszystko?

- pierwszy
  - drugi
1. krok

| Ujęcie | Czas |
| --- | --- |
| 01 | 0:07 \\| ok |

Kadry: ![I01](images/I01.png)![I02](images/I02.jpg)

\\# nie nagłówek

[strona](https://example.com/miko)

zostaje

Linia
druga

## Plan

- Lista ze stylu
`;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aimator-import-"));
  root = join(scratch, "workspace");
  const resolved = resolveWorkspace(root);
  workspace = resolved.ok ? resolved.data : { root: "" };
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

describe("addImport", () => {
  it("writes the document as Markdown, its images beside it, in document order", async () => {
    const result = await add(docx(TREATMENT));

    expect(errorOf(result)).toBe("");
    expect(await readFile(join(root, "imports", "miko", "material.md"), "utf8")).toBe(MATERIAL);
  });

  it("keeps each image's bytes, and a picture shown twice is one file", async () => {
    const result = await add(docx(TREATMENT));
    const images = join(root, "imports", "miko", "images");

    expect((await readFile(join(images, "I01.png"))).equals(IMAGE)).toBe(true);
    expect((await readFile(join(images, "I02.jpg"))).equals(PHOTO)).toBe(true);
    expect(result.ok ? result.data.images : []).toEqual([
      {
        id: "I01",
        part: "word/media/image1.png",
        path: "imports/miko/images/I01.png",
        sections: ["T03", "T04"],
      },
      {
        id: "I02",
        part: "word/media/image2.jpeg",
        path: "imports/miko/images/I02.jpg",
        sections: ["T04"],
      },
    ]);
  });

  it("cuts the material at every heading, with what precedes the first one as its own section", async () => {
    const result = await add(docx(TREATMENT));

    expect(
      (result.ok ? result.data.sections : []).map(({ id, images, level, title }) => ({
        id,
        images,
        level,
        title,
      }))
    ).toEqual([
      { id: "T01", images: [], level: 0, title: null },
      { id: "T02", images: [], level: 1, title: "Miko & skarb" },
      { id: "T03", images: ["I01"], level: 2, title: "Postacie" },
      { id: "T04", images: ["I01", "I02"], level: 3, title: "Pola" },
      { id: "T05", images: [], level: 2, title: "Plan" },
    ]);
  });

  it("copies the document in and records where it came from, by digest", async () => {
    const bytes = docx(TREATMENT);
    const result = await add(bytes);
    const directory = join(root, "imports", "miko");
    const file = JSON.parse(await readFile(join(directory, "import.json"), "utf8"));
    const stage = JSON.parse(await readFile(join(directory, "import.stage.json"), "utf8"));

    expect(result.ok ? result.data.originPath : "").toBe(join(scratch, "treatment.docx"));
    expect((await readFile(join(directory, "source.docx"))).equals(bytes)).toBe(true);
    expect(file.source).toEqual({ path: "imports/miko/source.docx", sha256: sha256Of(bytes) });
    expect(stage.stage).toBe("import");
    expect(stage.artifacts.material.producer.kind).toBe("local");
    expect(stage.artifacts.material.inputs).toEqual([file.source]);
    expect(stage.artifacts.material.outputs).toContainEqual({
      path: "imports/miko/material.md",
      sha256: sha256Of(Buffer.from(MATERIAL)),
    });
  });

  it("says what it left out on purpose: page headers, comments, shapes with no picture", async () => {
    const result = await add(
      docx(p(`${t("Tekst")}<w:r><w:commentReference w:id="0"/></w:r>`) + p(drawing("<wps:wsp/>")))
    );

    expect(result.ok ? result.data.notices : []).toEqual([
      "pominięto nagłówek lub stopkę strony: „Miko | 1”",
      "pominięto komentarze recenzenta: 1",
      "pominięto obiekty bez obrazu (kształt, wykres): 1",
    ]);
  });

  it("refuses text it cannot place and names it, writing nothing", async () => {
    const box = drawing(
      `<wps:txbx><w:txbxContent>${p(t("Ukryty tekst"))}</w:txbxContent></wps:txbx>`
    );
    const result = await add(docx(p(t("Widoczny")) + p(box)));

    expect(errorOf(result)).toContain("„Ukryty tekst”");
    expect(existsSync(join(root, "imports"))).toBe(false);
  });

  it("refuses footnotes rather than dropping what they say", async () => {
    const result = await add(docx(p(`${t("Zdanie")}<w:r><w:footnoteReference w:id="1"/></w:r>`)));

    expect(errorOf(result)).toContain("przypisy (1)");
  });

  it("refuses a file that is not a .docx", async () => {
    expect(errorOf(await add(Buffer.from("zwykły tekst")))).toContain("to nie jest plik .docx");
    expect(errorOf(await add(zip({ "a.txt": "x" }), "zip"))).toContain(
      "nie zawiera części word/document.xml"
    );
  });

  it("refuses a damaged document instead of writing a damaged picture", async () => {
    const bytes = docx(TREATMENT);
    const at = bytes.indexOf(IMAGE);

    bytes.writeUInt8(255 - bytes.readUInt8(at + 40), at + 40);

    expect(errorOf(await add(bytes))).toContain("suma kontrolna części word/media/image1.png");
  });

  it("previews with --dry-run and writes nothing", async () => {
    const result = await addImport({
      importId: "miko",
      mode: "dry-run",
      sourcePath: await source(docx(TREATMENT)),
      workspace,
    });

    expect(result.ok ? result.data.created : []).toContain("imports/miko/material.md");
    expect(existsSync(join(root, "imports"))).toBe(false);
  });

  it("never rewrites an import, and refuses an id that could leave the directory", async () => {
    await add(docx(TREATMENT));

    expect(errorOf(await add(docx(TREATMENT)))).toContain("już istnieje");
    expect(errorOf(await add(docx(TREATMENT), "../miko"))).toContain('invalid import id "../miko"');
  });
});

/**
 * A document is somebody else's bytes. Each case here once took a pattern that
 * backtracks, or memory nothing capped, so a regression shows up as a timeout
 * or a crashed worker rather than a wrong answer.
 */
describe("addImport with a hostile document", () => {
  const RUN = 200_000;

  it("refuses an archive that would unpack beyond its limit, before unpacking anything", async () => {
    const bytes = zip(
      { "word/document.xml": "<w:document/>" },
      { "word/document.xml": 0xf0_00_00_00 }
    );

    expect(errorOf(await add(bytes))).toContain("nie rozpakowano niczego");
  });

  it("refuses an XML part too large to parse", async () => {
    const bytes = docx(TREATMENT, { declared: { "word/document.xml": 100 * 1024 * 1024 } });

    expect(errorOf(await add(bytes))).toContain("word/document.xml: część dokumentu jest za duża");
  });

  it("refuses a part with more nodes than it can hold", async () => {
    const document = `<w:document><w:body>${"<w:p/>".repeat(2_000_001)}</w:body></w:document>`;

    expect(errorOf(await add(docx("", { document })))).toContain("zbyt złożony");
  });

  it("refuses markup that never closes, in one pass", async () => {
    const opened = (tail: string): Buffer => docx("", { document: `<w:document><w:body>${tail}` });

    expect(errorOf(await add(opened("<a".repeat(RUN)), "a"))).toContain("znacznik bez >");
    expect(errorOf(await add(opened(`<!--${"-".repeat(RUN)}`), "b"))).toContain("<!-- bez -->");
    expect(errorOf(await add(opened(`<w:p ${"a".repeat(RUN)}>`), "c"))).toContain(
      "niepoprawny atrybut"
    );
    expect(errorOf(await add(opened('<!DOCTYPE x [<!ENTITY e "x">]>'), "d"))).toContain("DOCTYPE");
  });

  it("keeps long runs of spaces in headings and emphasis, without stalling", async () => {
    const spaces = " ".repeat(RUN);
    const result = await add(docx(p(t(`a${spaces}b`), style("Nagwek1")) + p(bold(`${spaces}x`))));

    expect(result.ok ? result.data.sections.map(({ title }) => title) : []).toEqual([
      `a${spaces}b`,
    ]);
    // Compared as a boolean: a failed match on two strings this long would
    // spend a minute in the diff, and read as the very stall it guards against.
    expect(
      (await readFile(join(root, "imports", "miko", "material.md"), "utf8")).endsWith("\n\n**x**\n")
    ).toBe(true);
  });

  it("keeps a reference to no character as it was written", async () => {
    await add(docx(p(t("&#99999999; i &amp;"))));

    expect(await readFile(join(root, "imports", "miko", "material.md"), "utf8")).toBe(
      "&#99999999; i &\n"
    );
  });
});

describe("showImport", () => {
  it("reads a material.md edited into a maze of half-written links, in one pass", async () => {
    await add(docx(TREATMENT));
    await appendFile(join(root, "imports", "miko", "material.md"), "![](".repeat(200_000));

    const shown = await showImport({ importId: "miko", workspace });

    expect(shown.ok ? shown.data.images.map(({ sections }) => sections) : []).toEqual([
      ["T03", "T04"],
      ["T04"],
    ]);
  });

  it("derives the sections from material.md as it is now, and says it was edited", async () => {
    await add(docx(TREATMENT));
    await appendFile(join(root, "imports", "miko", "material.md"), "\n## Dopisane\n\nTekst.\n");

    const shown = await showImport({ importId: "miko", workspace });

    expect(shown.ok ? shown.data.sections.map(({ title }) => title).at(-1) : "").toBe("Dopisane");
    expect(shown.ok ? shown.data.notices : []).toEqual([
      "imports/miko/material.md poprawiono ręcznie po imporcie; sekcje są liczone z obecnej treści",
    ]);
  });

  it("reports an image that went missing", async () => {
    await add(docx(TREATMENT));
    await rm(join(root, "imports", "miko", "images", "I02.jpg"));

    const shown = await showImport({ importId: "miko", workspace });

    expect(shown.ok ? shown.data.notices : []).toEqual(["brak obrazu imports/miko/images/I02.jpg"]);
  });

  it("refuses an import that does not exist, naming the command that makes one", async () => {
    expect(errorOf(await showImport({ importId: "miko", workspace }))).toContain(
      "aimator import add miko --source <plik.docx>"
    );
  });
});

describe("listImports", () => {
  it("lists the imports by id, skipping what could not be one", async () => {
    expect(await listImports(workspace)).toEqual([]);

    await add(docx(TREATMENT), "b");
    await add(docx(TREATMENT), "a");
    await mkdir(join(root, "imports", ".zapas"));
    await writeFile(join(root, "imports", "notatka.txt"), "x");

    expect(await listImports(workspace)).toEqual(["a", "b"]);
  });
});
