import { dirname, relative, sep } from "node:path";
import { z } from "zod";
import {
  applyWrites,
  emptyStage,
  exists,
  listDirectory,
  localProducer,
  newRecord,
  type RecordedFile,
  readDigest,
  readJson,
  type StageFile,
  serialize,
  sha256Of,
  sha256Schema,
  stageFileSchema,
  toWorkspacePath,
  type WriteMode,
  type WriteOp,
} from "../artifact/index.js";
import { err, ok, type Result } from "../result.js";
import {
  type ImportPaths,
  importImage,
  importPaths,
  importsRoot,
  type Workspace,
  workspacePath,
} from "../workspace.js";
import { convertDocx, type DocxConversion } from "./docx.js";

/**
 * An import: a document somebody brought, converted and waiting beside the
 * projects. It never creates one and decides nothing: the conversion is
 * deterministic and free, the material stays in the words it was written in,
 * and what becomes of it is stage 0's, which `/prepare-project` runs.
 *
 * The sections are **derived, never stored**: they are the headings of
 * `material.md`, read on every call, so a person who fixes the Markdown by hand
 * fixes the sections with it, and there is no second file to drift.
 */

/** The engine that wrote the bytes, and the version that decides whether it would again. */
const CONVERTER = "docx-markdown 1";
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*$/;
const IMAGE_LINK = /!\[[^\]]*\]\(([^)\s]+)\)/g;

const importFileSchema = z.strictObject({
  id: z.string().min(1),
  /** Each image in the order the document first showed it, and where it lives now. */
  images: z.array(
    z.strictObject({ id: z.string().min(1), part: z.string().min(1), path: z.string().min(1) })
  ),
  originPath: z.string().min(1),
  schemaVersion: z.literal(1),
  source: z.strictObject({ path: z.string().min(1), sha256: sha256Schema }),
});

type ImportFile = z.infer<typeof importFileSchema>;

interface ImportInput {
  readonly importId: string;
  readonly workspace: Workspace;
}

interface AddImportInput extends ImportInput {
  readonly mode: WriteMode;
  readonly sourcePath: string;
}

/** One piece of the material between two headings, `T01` in document order. */
interface ImportSection {
  /** How much text it holds, so an empty heading can be told from a chapter. */
  readonly characters: number;
  readonly id: string;
  /** Which images it shows, `I01`, in the order it shows them. */
  readonly images: readonly string[];
  /** 1 to 6 for a heading, 0 for what stands before the first one. */
  readonly level: number;
  /** Null for what stands before the first heading. */
  readonly title: string | null;
}

interface ImportImage {
  readonly id: string;
  /** Its name inside the document, `word/media/image1.png`. */
  readonly part: string;
  /** Workspace-relative. */
  readonly path: string;
  /** The sections that show it; an image a hand edit removed shows in none. */
  readonly sections: readonly string[];
}

/** What one import holds, the same object whether it was just written or read back. */
interface ImportReport {
  /** What this call wrote, workspace-relative; empty when it only read. */
  readonly created: readonly string[];
  readonly images: readonly ImportImage[];
  readonly importId: string;
  /** `material.md`, workspace-relative. */
  readonly material: string;
  readonly nextStep: string;
  /** What was left out of the material on purpose, and what changed since. */
  readonly notices: readonly string[];
  readonly originPath: string;
  readonly sections: readonly ImportSection[];
}

class ImportError extends Error {
  readonly reason: "already-exists" | "empty-source" | "missing-import";

  constructor(reason: ImportError["reason"], message: string) {
    super(message);
    this.name = "ImportError";
    this.reason = reason;
  }
}

/**
 * Copies a `.docx` in and converts it: `material.md`, the images beside it in
 * the bytes the document held, and the record of both. A new id every time;
 * an import is never rewritten, it is thrown away and made again.
 */
export async function addImport(input: AddImportInput): Promise<Result<ImportReport>> {
  const paths = importPaths(input.workspace, input.importId);

  if (!paths.ok) {
    return paths;
  }

  if (await exists(paths.data.root)) {
    return err(
      new ImportError(
        "already-exists",
        `import "${input.importId}" już istnieje; import się nie nadpisuje, wybierz inny identyfikator`
      )
    );
  }

  const source = await readDigest(input.sourcePath);

  if (!source.ok) {
    return source;
  }

  if (source.data.bytes.byteLength === 0) {
    return err(new ImportError("empty-source", `plik ${input.sourcePath} jest pusty`));
  }

  const conversion = convertDocx(source.data.bytes, (id, extension) => {
    const file = importImage(paths.data, id, extension);

    return file.ok ? linkFrom(paths.data, file.data) : "";
  });

  if (!conversion.ok) {
    return conversion;
  }

  const planned = planImport(input, paths.data, source.data.sha256, conversion.data);

  if (!planned.ok) {
    return planned;
  }

  const written = await applyWrites(planned.data.ops, input.mode);

  return written.ok
    ? ok(
        reportOf(input, paths.data, planned.data.file, conversion.data.markdown, {
          created: written.data.map((path) => toWorkspacePath(input.workspace.root, path)),
          notices: conversion.data.notices,
        })
      )
    : written;
}

/** The import as it is on disk now, sections read off the current `material.md`. */
export async function showImport(input: ImportInput): Promise<Result<ImportReport>> {
  const paths = importPaths(input.workspace, input.importId);

  if (!paths.ok) {
    return paths;
  }

  if (!(await exists(paths.data.file))) {
    return err(
      new ImportError(
        "missing-import",
        `import "${input.importId}" nie istnieje: aimator import add ${input.importId} --source <plik.docx>`
      )
    );
  }

  const file = await readJson(paths.data.file, importFileSchema);
  const stage = await readJson(paths.data.stage, stageFileSchema);
  const material = await readDigest(paths.data.material);

  if (!file.ok) {
    return file;
  }

  if (!stage.ok) {
    return stage;
  }

  if (!material.ok) {
    return material;
  }

  return ok(
    reportOf(input, paths.data, file.data, material.data.bytes.toString("utf8"), {
      created: [],
      notices: await drift(input.workspace, paths.data, file.data, {
        material: material.data.sha256,
        stage: stage.data,
      }),
    })
  );
}

/** The imports in the workspace, by id; a directory that could not be one is skipped. */
export async function listImports(workspace: Workspace): Promise<readonly string[]> {
  const listing = await listDirectory(importsRoot(workspace));

  return (listing?.others ?? []).filter((id) => importPaths(workspace, id).ok);
}

interface PlannedImport {
  readonly file: ImportFile;
  readonly ops: readonly WriteOp[];
}

function planImport(
  input: AddImportInput,
  paths: ImportPaths,
  sourceSha: string,
  conversion: DocxConversion
): Result<PlannedImport> {
  const { root } = input.workspace;
  const ops: WriteOp[] = [{ from: input.sourcePath, kind: "copy", to: paths.source }];
  const images: ImportFile["images"][number][] = [];
  const outputs: RecordedFile[] = [];

  for (const image of conversion.images) {
    const path = importImage(paths, image.id, image.extension);

    if (!path.ok) {
      return path;
    }

    ops.push({ bytes: image.bytes, kind: "bytes", to: path.data });
    images.push({ id: image.id, part: image.part, path: toWorkspacePath(root, path.data) });
    outputs.push({ path: toWorkspacePath(root, path.data), sha256: sha256Of(image.bytes) });
  }

  const file: ImportFile = {
    id: input.importId,
    images,
    originPath: input.sourcePath,
    schemaVersion: 1,
    source: { path: toWorkspacePath(root, paths.source), sha256: sourceSha },
  };
  const fileText = serialize(file);
  const stage: StageFile = {
    ...emptyStage("import"),
    artifacts: {
      material: newRecord({
        inputs: [file.source],
        outputs: [
          {
            path: toWorkspacePath(root, paths.material),
            sha256: sha256Of(Buffer.from(conversion.markdown)),
          },
          { path: toWorkspacePath(root, paths.file), sha256: sha256Of(Buffer.from(fileText)) },
          ...outputs,
        ],
        producer: localProducer(CONVERTER),
      }),
    },
  };

  ops.push(
    { kind: "text", text: conversion.markdown, to: paths.material },
    { kind: "text", text: fileText, to: paths.file },
    { kind: "text", text: serialize(stage), to: paths.stage }
  );

  return ok({ file, ops });
}

function reportOf(
  input: ImportInput,
  paths: ImportPaths,
  file: ImportFile,
  markdown: string,
  extra: { readonly created: readonly string[]; readonly notices: readonly string[] }
): ImportReport {
  const sections = sectionsOf(markdown, (link) => imageAt(input.workspace, paths, file, link));

  return {
    created: extra.created,
    images: file.images.map((image) => ({
      ...image,
      sections: sections.filter((section) => section.images.includes(image.id)).map(({ id }) => id),
    })),
    importId: input.importId,
    material: toWorkspacePath(input.workspace.root, paths.material),
    nextStep: `aimator import show ${input.importId}`,
    notices: extra.notices,
    originPath: file.originPath,
    sections,
  };
}

/** Which image a Markdown link in `material.md` points at, if it is one of this import's. */
function imageAt(
  workspace: Workspace,
  paths: ImportPaths,
  file: ImportFile,
  link: string
): string | null {
  return (
    file.images.find((image) => linkFrom(paths, workspacePath(workspace, image.path)) === link)
      ?.id ?? null
  );
}

/** A link as `material.md` writes it: relative to its own directory, with `/`. */
function linkFrom(paths: ImportPaths, file: string): string {
  return relative(dirname(paths.material), file).split(sep).join("/");
}

/**
 * The material cut at every heading. What stands before the first one is a
 * section of its own, with no title, so the opening lines of a document are
 * never folded silently into its first chapter.
 */
function sectionsOf(markdown: string, imageOf: (link: string) => string | null): ImportSection[] {
  const sections: { level: number; lines: string[]; title: string | null }[] = [];

  for (const line of markdown.split("\n")) {
    const heading = HEADING.exec(line);
    const current = sections.at(-1);

    if (heading !== null) {
      sections.push({ level: heading[1]?.length ?? 1, lines: [line], title: heading[2] ?? "" });
    } else if (current === undefined) {
      sections.push({ level: 0, lines: [line], title: null });
    } else {
      current.lines.push(line);
    }
  }

  return sections
    .filter((section) => section.title !== null || section.lines.join("").trim() !== "")
    .map((section, index) => {
      const body = (section.title === null ? section.lines : section.lines.slice(1)).join("\n");
      const images = [...section.lines.join("\n").matchAll(IMAGE_LINK)]
        .map((match) => imageOf(match[1] ?? ""))
        .filter((id) => id !== null);

      return {
        characters: body.trim().length,
        id: `T${String(index + 1).padStart(2, "0")}`,
        images,
        level: section.level,
        title: section.title,
      };
    });
}

/** What changed since the import was written: a hand edit, or a file gone missing. */
async function drift(
  workspace: Workspace,
  paths: ImportPaths,
  file: ImportFile,
  current: { readonly material: string; readonly stage: StageFile }
): Promise<string[]> {
  const recorded = current.stage.artifacts.material?.outputs ?? [];
  const material = toWorkspacePath(workspace.root, paths.material);
  const notices: string[] = [];

  if (recorded.find((output) => output.path === material)?.sha256 !== current.material) {
    notices.push(`${material} poprawiono ręcznie po imporcie; sekcje są liczone z obecnej treści`);
  }

  for (const image of file.images) {
    // biome-ignore lint/performance/noAwaitInLoops: a handful of images, reported in order
    if (!(await exists(workspacePath(workspace, image.path)))) {
      notices.push(`brak obrazu ${image.path}`);
    }
  }

  return notices;
}
