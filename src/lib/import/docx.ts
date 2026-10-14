import { posix } from "node:path";
import { err, ok, type Result } from "../result.js";
import {
  child,
  descendants,
  elements,
  ownText,
  parseXml,
  type XmlElement,
  XmlError,
} from "./xml.js";
import { type Archive, ArchiveError, openArchive, readEntry } from "./zip.js";

/**
 * Internal to the import module: a `.docx` read as what it is, a zip of XML,
 * and written out as Markdown with its images beside it.
 *
 * No dependency, because a treatment uses a small part of the format:
 * headings, paragraphs, lists, tables, emphasis and pictures. What the walker
 * does not understand is refused rather than dropped. Every `w:t` in the body
 * has to come out the other end, and `unread` is the check that it did: a text
 * box, a footnote or a construct nobody taught this file stops the import with
 * the words it would have lost, instead of a document that is quietly shorter.
 */

/** A part of the document as XML; the parsed tree is many times this. */
const MAX_XML_BYTES = 64 * 1024 * 1024;
const HEADING_STYLE = /^heading (\d)$/i;
const FILE_EXTENSION = /\.([A-Za-z0-9]{1,5})$/;
const OFF = new Set(["0", "false", "off"]);

export interface DocxImage {
  readonly bytes: Buffer;
  /** The format it arrived in, read off its first bytes where they say. */
  readonly extension: string;
  readonly id: string;
  /** Its name inside the document, `word/media/image1.png`. */
  readonly part: string;
}

export interface DocxConversion {
  readonly images: readonly DocxImage[];
  readonly markdown: string;
  /** What was left out on purpose: page headers, comments, shapes with no picture. */
  readonly notices: readonly string[];
}

/** How `material.md` refers to an image, which only the layout module may say. */
type ImageLink = (id: string, extension: string) => string;

class DocxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocxError";
  }
}

interface Relationship {
  readonly external: boolean;
  readonly target: string;
  readonly type: string;
}

interface Style {
  readonly basedOn: string | undefined;
  readonly name: string;
  readonly numbering: ListReference | undefined;
  readonly outline: number | undefined;
}

interface ListReference {
  readonly level: number;
  readonly numId: string;
}

type Inline =
  | {
      readonly bold: boolean;
      readonly italic: boolean;
      readonly kind: "text";
      readonly text: string;
    }
  | { readonly kind: "markup"; readonly text: string };

type Block =
  | { readonly kind: "heading"; readonly level: number; readonly text: string }
  | {
      readonly depth: number;
      readonly kind: "item";
      readonly ordered: boolean;
      readonly text: string;
    }
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "table"; readonly rows: readonly (readonly string[])[] };

/** Everything one conversion reads from and writes into, threaded through the walk. */
interface Walk {
  readonly archive: Archive;
  readonly consumed: Set<XmlElement>;
  readonly counts: { comments: number; footnotes: number; objects: number };
  readonly images: Map<string, DocxImage>;
  readonly link: ImageLink;
  readonly lists: (reference: ListReference) => boolean | undefined;
  readonly part: string;
  readonly relationships: ReadonlyMap<string, Relationship>;
  readonly styles: ReadonlyMap<string, Style>;
}

/**
 * The document as Markdown, plus every image it embeds, in order of first
 * appearance. Nothing is written here: the caller decides where it goes.
 */
export function convertDocx(bytes: Buffer, link: ImageLink): Result<DocxConversion> {
  try {
    return ok(convert(openArchive(bytes), link));
  } catch (cause) {
    if (cause instanceof DocxError || cause instanceof ArchiveError || cause instanceof XmlError) {
      return err(cause);
    }

    if (cause instanceof RangeError || (cause as NodeJS.ErrnoException).code?.startsWith("Z_")) {
      return err(new DocxError("plik .docx jest uszkodzony albo zbyt złożony, by go przeczytać"));
    }

    throw cause;
  }
}

function convert(archive: Archive, link: ImageLink): DocxConversion {
  const part = mainPart(archive);
  const relationships = readRelationships(archive, part);
  const styles = readStyles(archive, related(relationships, "styles"));
  const walk: Walk = {
    archive,
    consumed: new Set(),
    counts: { comments: 0, footnotes: 0, objects: 0 },
    images: new Map(),
    link,
    lists: readNumbering(archive, related(relationships, "numbering")),
    part,
    relationships,
    styles,
  };
  const body = child(parseXml(readText(archive, part), part), "w:body");

  if (body === undefined) {
    throw new DocxError(`${part}: dokument nie ma treści (brak w:body)`);
  }

  const blocks = blocksOf(body, walk);
  const lost = unread(body, walk.consumed);

  if (lost.length > 0) {
    throw new DocxError(
      `konwerter nie umie przeczytać ${lost.length} fragmentów tekstu (np. pola tekstowego), a nic nie może zginąć po cichu: ${lost
        .slice(0, 3)
        .map((text) => `„${text}”`)
        .join(", ")}`
    );
  }

  if (walk.counts.footnotes > 0) {
    throw new DocxError(
      `dokument ma przypisy (${walk.counts.footnotes}), których konwerter jeszcze nie przenosi; przenieś ich treść do tekstu i zaimportuj ponownie`
    );
  }

  return {
    images: [...walk.images.values()],
    markdown: markdownOf(blocks),
    notices: noticesOf(walk),
  };
}

function noticesOf(walk: Walk): string[] {
  const notices = pageFurniture(walk);

  if (walk.counts.comments > 0) {
    notices.push(`pominięto komentarze recenzenta: ${walk.counts.comments}`);
  }

  if (walk.counts.objects > 0) {
    notices.push(`pominięto obiekty bez obrazu (kształt, wykres): ${walk.counts.objects}`);
  }

  return notices;
}

/** Page headers and footers repeat on every page and are not material, but they are said. */
function pageFurniture(walk: Walk): string[] {
  const texts = new Set<string>();

  for (const relationship of walk.relationships.values()) {
    const kind = kindOf(relationship.type);

    if ((kind === "header" || kind === "footer") && walk.archive.entries.has(relationship.target)) {
      const xml = parseXml(readText(walk.archive, relationship.target), relationship.target);
      const text = wordText(xml).trim();

      if (text !== "") {
        texts.add(text.length > 80 ? `${text.slice(0, 80)}…` : text);
      }
    }
  }

  return [...texts].map((text) => `pominięto nagłówek lub stopkę strony: „${text}”`);
}

function readText(archive: Archive, name: string): string {
  return readEntry(archive, name, MAX_XML_BYTES).toString("utf8");
}

// ---------------------------------------------------------------- the parts

/** The main document's part name, read from the package's own relationships. */
function mainPart(archive: Archive): string {
  const fallback = "word/document.xml";

  if (!archive.entries.has("_rels/.rels")) {
    return fallback;
  }

  const rels = parseXml(readText(archive, "_rels/.rels"), "_rels/.rels");
  const main = elements(rels).find(
    (rel) => kindOf(rel.attributes.get("Type") ?? "") === "officeDocument"
  );
  const target = main?.attributes.get("Target");

  return target === undefined ? fallback : resolvePart("", target);
}

function readRelationships(archive: Archive, part: string): Map<string, Relationship> {
  const name = posix.join(posix.dirname(part), "_rels", `${posix.basename(part)}.rels`);
  const relationships = new Map<string, Relationship>();

  if (!archive.entries.has(name)) {
    return relationships;
  }

  for (const rel of elements(parseXml(readText(archive, name), name))) {
    const id = rel.attributes.get("Id");
    const target = rel.attributes.get("Target");
    const external = rel.attributes.get("TargetMode") === "External";

    if (id !== undefined && target !== undefined) {
      relationships.set(id, {
        external,
        target: external ? target : resolvePart(posix.dirname(part), target),
        type: rel.attributes.get("Type") ?? "",
      });
    }
  }

  return relationships;
}

/**
 * `styles` out of `…/relationships/styles`. Read off the end, because Strict
 * OOXML spells the same relationships under another namespace.
 */
function kindOf(type: string): string {
  return type.slice(type.lastIndexOf("/") + 1);
}

function resolvePart(base: string, target: string): string {
  return target.startsWith("/")
    ? posix.normalize(target.slice(1))
    : posix.normalize(posix.join(base, target));
}

function related(relationships: ReadonlyMap<string, Relationship>, kind: string): string | null {
  for (const relationship of relationships.values()) {
    if (kindOf(relationship.type) === kind && !relationship.external) {
      return relationship.target;
    }
  }

  return null;
}

function readStyles(archive: Archive, part: string | null): Map<string, Style> {
  const styles = new Map<string, Style>();

  if (part === null || !archive.entries.has(part)) {
    return styles;
  }

  for (const style of elements(parseXml(readText(archive, part), part), "w:style")) {
    const id = style.attributes.get("w:styleId");
    const properties = child(style, "w:pPr");
    const outline = child(properties, "w:outlineLvl")?.attributes.get("w:val");

    if (id !== undefined) {
      styles.set(id, {
        basedOn: child(style, "w:basedOn")?.attributes.get("w:val"),
        name: child(style, "w:name")?.attributes.get("w:val") ?? id,
        numbering: listReference(properties),
        outline: outline === undefined ? undefined : Number(outline),
      });
    }
  }

  return styles;
}

/** Whether a list level counts (`1.`) or marks (`-`), from `numbering.xml`. */
function readNumbering(
  archive: Archive,
  part: string | null
): (reference: ListReference) => boolean | undefined {
  if (part === null || !archive.entries.has(part)) {
    return () => undefined;
  }

  const numbering = parseXml(readText(archive, part), part);
  const formats = new Map<string, string>();
  const abstracts = new Map<string, string>();

  for (const abstract of elements(numbering, "w:abstractNum")) {
    for (const level of elements(abstract, "w:lvl")) {
      formats.set(
        `${abstract.attributes.get("w:abstractNumId")}:${level.attributes.get("w:ilvl")}`,
        child(level, "w:numFmt")?.attributes.get("w:val") ?? "bullet"
      );
    }
  }

  for (const num of elements(numbering, "w:num")) {
    abstracts.set(
      num.attributes.get("w:numId") ?? "",
      child(num, "w:abstractNumId")?.attributes.get("w:val") ?? ""
    );
  }

  return (reference) => {
    const format = formats.get(`${abstracts.get(reference.numId)}:${reference.level}`);

    return format === undefined ? undefined : format !== "bullet";
  };
}

// ---------------------------------------------------------------- the body

function blocksOf(container: XmlElement, walk: Walk): Block[] {
  const blocks: Block[] = [];

  for (const node of elements(container)) {
    switch (node.name) {
      case "w:p": {
        const block = paragraph(node, walk);

        if (block !== null) {
          blocks.push(block);
        }

        break;
      }
      case "w:tbl": {
        const rows = elements(node, "w:tr").map((row) =>
          elements(row, "w:tc").map((cell) => cellText(cell, walk))
        );

        if (rows.some((row) => row.length > 0)) {
          blocks.push({ kind: "table", rows });
        }

        break;
      }
      case "w:sdt":
        blocks.push(...blocksOf(child(node, "w:sdtContent") ?? node, walk));
        break;
      case "mc:AlternateContent":
        blocks.push(...blocksOf(child(node, "mc:Choice") ?? node, walk));
        break;
      case "w:customXml":
      case "w:ins":
      case "w:moveTo":
        blocks.push(...blocksOf(node, walk));
        break;
      default:
        break;
    }
  }

  return blocks;
}

function paragraph(node: XmlElement, walk: Walk): Block | null {
  const properties = child(node, "w:pPr");
  const level = headingLevel(properties, walk.styles);
  const text = render(inlinesOf(node, walk), level === undefined).trim();

  if (text === "") {
    return null;
  }

  if (level !== undefined) {
    return { kind: "heading", level, text: oneLine(text) };
  }

  const list = listReference(properties) ?? styleList(properties, walk.styles);
  const ordered = list === undefined || list.numId === "0" ? undefined : walk.lists(list);

  return ordered === undefined || list === undefined
    ? { kind: "paragraph", text }
    : { depth: list.level, kind: "item", ordered, text };
}

/**
 * 0 for a title, n for `heading n`, from the paragraph's own outline level or
 * its style, following the style's `basedOn` the way Word does. Matched on the
 * style's English name, because the id is localised: `Nagwek1` in Polish Word.
 */
function headingLevel(
  properties: XmlElement | undefined,
  styles: ReadonlyMap<string, Style>
): number | undefined {
  const outline = child(properties, "w:outlineLvl")?.attributes.get("w:val");

  if (outline !== undefined && Number(outline) < 9) {
    return Number(outline) + 1;
  }

  let id = child(properties, "w:pStyle")?.attributes.get("w:val");

  for (let depth = 0; id !== undefined && depth < 10; depth += 1) {
    const style = styles.get(id);

    if (style === undefined) {
      return;
    }

    if (style.name.toLowerCase() === "title") {
      return 0;
    }

    const heading = HEADING_STYLE.exec(style.name);

    if (heading !== null) {
      return Number(heading[1]);
    }

    if (style.outline !== undefined && style.outline < 9) {
      return style.outline + 1;
    }

    id = style.basedOn;
  }
}

function listReference(properties: XmlElement | undefined): ListReference | undefined {
  const numbering = child(properties, "w:numPr");
  const numId = child(numbering, "w:numId")?.attributes.get("w:val");

  return numId === undefined
    ? undefined
    : { level: Number(child(numbering, "w:ilvl")?.attributes.get("w:val") ?? 0), numId };
}

function styleList(
  properties: XmlElement | undefined,
  styles: ReadonlyMap<string, Style>
): ListReference | undefined {
  const id = child(properties, "w:pStyle")?.attributes.get("w:val");

  return id === undefined ? undefined : styles.get(id)?.numbering;
}

function cellText(cell: XmlElement, walk: Walk): string {
  const parts: string[] = [];

  for (const node of elements(cell)) {
    if (node.name === "w:tbl") {
      for (const row of elements(node, "w:tr")) {
        parts.push(...elements(row, "w:tc").map((inner) => cellText(inner, walk)));
      }
    } else {
      parts.push(...blocksOf({ ...node, children: [node] }, walk).map(blockText));
    }
  }

  return parts
    .filter((part) => part !== "")
    .join("<br>")
    .replaceAll("|", "\\|")
    .replaceAll("\n", "<br>");
}

function blockText(block: Block): string {
  return block.kind === "table" ? block.rows.map((row) => row.join(" ")).join(" ") : block.text;
}

function inlinesOf(container: XmlElement, walk: Walk): Inline[] {
  const inlines: Inline[] = [];

  for (const node of elements(container)) {
    switch (node.name) {
      case "w:r":
        inlines.push(...runInlines(node, walk));
        break;
      case "w:hyperlink":
        inlines.push(...hyperlink(node, walk));
        break;
      case "w:sdt":
        inlines.push(...inlinesOf(child(node, "w:sdtContent") ?? node, walk));
        break;
      case "mc:AlternateContent":
        inlines.push(...inlinesOf(child(node, "mc:Choice") ?? node, walk));
        break;
      case "w:bdo":
      case "w:customXml":
      case "w:dir":
      case "w:fldSimple":
      case "w:ins":
      case "w:moveTo":
      case "w:smartTag":
        inlines.push(...inlinesOf(node, walk));
        break;
      default:
        break;
    }
  }

  return inlines;
}

function hyperlink(node: XmlElement, walk: Walk): Inline[] {
  const inner = inlinesOf(node, walk);
  const id = node.attributes.get("r:id");
  const target = id === undefined ? undefined : walk.relationships.get(id);

  if (target === undefined || !target.external) {
    return inner;
  }

  return [{ kind: "markup", text: `[${render(inner, false)}](${target.target})` }];
}

function runInlines(run: XmlElement, walk: Walk): Inline[] {
  const properties = child(run, "w:rPr");

  return runContent(
    run,
    { bold: isOn(child(properties, "w:b")), italic: isOn(child(properties, "w:i")) },
    walk
  );
}

function runContent(
  container: XmlElement,
  format: { readonly bold: boolean; readonly italic: boolean },
  walk: Walk
): Inline[] {
  const inlines: Inline[] = [];
  const text = (value: string): void => {
    inlines.push({ ...format, kind: "text", text: value });
  };

  for (const node of elements(container)) {
    switch (node.name) {
      case "w:t":
        walk.consumed.add(node);
        text(ownText(node));
        break;
      case "w:tab":
        text("\t");
        break;
      case "w:br":
      case "w:cr":
        if (
          node.attributes.get("w:type") !== "page" &&
          node.attributes.get("w:type") !== "column"
        ) {
          text("\n");
        }

        break;
      case "w:noBreakHyphen":
        text("-");
        break;
      case "mc:AlternateContent":
        inlines.push(...runContent(child(node, "mc:Choice") ?? node, format, walk));
        break;
      case "w:drawing":
      case "w:pict":
        inlines.push(...pictures(node, walk));
        break;
      default:
        countReference(node.name, walk);
        break;
    }
  }

  return inlines;
}

function countReference(name: string, walk: Walk): void {
  if (name === "w:footnoteReference" || name === "w:endnoteReference") {
    walk.counts.footnotes += 1;
  } else if (name === "w:commentReference") {
    walk.counts.comments += 1;
  }
}

function isOn(toggle: XmlElement | undefined): boolean {
  return toggle !== undefined && !OFF.has(toggle.attributes.get("w:val") ?? "true");
}

/** The images one drawing shows, as Markdown; a drawing with none is counted. */
function pictures(node: XmlElement, walk: Walk): Inline[] {
  const references = descendants(node)
    .map(pictureReference)
    .filter((id) => id !== undefined);

  if (references.length === 0) {
    walk.counts.objects += 1;
  }

  return references.map((id) => ({ kind: "markup", text: picture(id, walk) }));
}

/** A DrawingML picture names its bytes on `a:blip`, a legacy VML one on `v:imagedata`. */
function pictureReference(element: XmlElement): string | undefined {
  if (element.name === "a:blip") {
    return element.attributes.get("r:embed") ?? element.attributes.get("r:link");
  }

  return element.name === "v:imagedata" ? element.attributes.get("r:id") : undefined;
}

function picture(id: string, walk: Walk): string {
  const relationship = walk.relationships.get(id);

  if (relationship === undefined) {
    throw new DocxError(`${walk.part}: obraz wskazuje na nieistniejącą relację ${id}`);
  }

  if (relationship.external) {
    return `![obraz zewnętrzny](${relationship.target})`;
  }

  const known = walk.images.get(relationship.target);
  const image = known ?? newImage(relationship.target, walk);

  walk.images.set(relationship.target, image);

  return `![${image.id}](${walk.link(image.id, image.extension)})`;
}

function newImage(part: string, walk: Walk): DocxImage {
  const bytes = readEntry(walk.archive, part);

  return {
    bytes,
    extension: extensionOf(bytes, part),
    id: `I${String(walk.images.size + 1).padStart(2, "0")}`,
    part,
  };
}

function extensionOf(bytes: Buffer, part: string): string {
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
    return "png";
  }

  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return "jpg";
  }

  if (bytes.toString("latin1", 0, 4) === "GIF8") {
    return "gif";
  }

  if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") {
    return "webp";
  }

  return FILE_EXTENSION.exec(part)?.[1]?.toLowerCase() ?? "bin";
}

// ---------------------------------------------------------------- Markdown

function render(inlines: readonly Inline[], emphasis: boolean): string {
  const merged: Inline[] = [];

  for (const inline of inlines) {
    const last = merged.at(-1);

    if (
      inline.kind === "text" &&
      last?.kind === "text" &&
      last.bold === inline.bold &&
      last.italic === inline.italic
    ) {
      merged[merged.length - 1] = { ...last, text: last.text + inline.text };
    } else {
      merged.push(inline);
    }
  }

  return merged
    .map((inline) => (inline.kind === "text" && emphasis ? emphasise(inline) : inline.text))
    .join("");
}

/**
 * Emphasis around the words, never around the spaces beside them. Cut with
 * `trim` rather than a pattern: `(\s*)$` after a lazy core is quadratic on a
 * long run of spaces, and the run is somebody else's.
 */
function emphasise(inline: Extract<Inline, { kind: "text" }>): string {
  const marker = `${inline.bold ? "**" : ""}${inline.italic ? "*" : ""}`;
  const start = inline.text.length - inline.text.trimStart().length;
  const core = inline.text.trim();

  return marker === "" || core === ""
    ? inline.text
    : `${inline.text.slice(0, start)}${marker}${core}${marker}${inline.text.slice(start + core.length)}`;
}

/** A heading on one line: whatever surrounds a break becomes one space. */
function oneLine(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ");
}

function markdownOf(blocks: readonly Block[]): string {
  // A document with a title puts it at `#` and its headings one level below.
  const shift = blocks.some((block) => block.kind === "heading" && block.level === 0) ? 1 : 0;
  let out = "";
  let previous: Block["kind"] | null = null;

  for (const block of blocks) {
    if (previous !== null) {
      out += previous === "item" && block.kind === "item" ? "\n" : "\n\n";
    }

    out += blockMarkdown(block, shift);
    previous = block.kind;
  }

  return out === "" ? "" : `${out}\n`;
}

function blockMarkdown(block: Block, shift: number): string {
  switch (block.kind) {
    case "heading":
      return `${"#".repeat(Math.min(6, Math.max(1, block.level + shift)))} ${block.text}`;
    case "item": {
      const indent = "  ".repeat(block.depth);
      const marker = block.ordered ? "1." : "-";

      return `${indent}${marker} ${block.text.replaceAll("\n", `\n${indent}  `)}`;
    }
    case "table": {
      const width = block.rows.reduce((widest, row) => Math.max(widest, row.length), 0);
      const lines = block.rows.map(
        (row) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`
      );

      lines.splice(1, 0, `|${" --- |".repeat(width)}`);

      return lines.join("\n");
    }
    default:
      // A line that opens with `#` would read back as a heading, so a section.
      return block.text
        .split("\n")
        .map((line) => (line.startsWith("#") ? `\\${line}` : line))
        .join("\n");
  }
}

// ---------------------------------------------------------------- the guard

/** The text of every `w:t` under `node`, in document order. */
function wordText(node: XmlElement): string {
  return node.name === "w:t" ? ownText(node) : elements(node).map(wordText).join("");
}

/**
 * Every `w:t` the walk did not consume, outside what is deleted (`w:del`,
 * `w:moveFrom`) or a second rendering of the same thing (`mc:Fallback`).
 */
function unread(node: XmlElement, consumed: ReadonlySet<XmlElement>): string[] {
  const lost: string[] = [];

  for (const element of elements(node)) {
    if (element.name === "w:t") {
      const text = ownText(element);

      if (!consumed.has(element) && text.trim() !== "") {
        lost.push(text);
      }
    } else if (
      element.name !== "w:del" &&
      element.name !== "w:moveFrom" &&
      element.name !== "mc:Fallback"
    ) {
      lost.push(...unread(element, consumed));
    }
  }

  return lost;
}
