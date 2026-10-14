import { dirname, relative, sep } from "node:path";
import { z } from "zod";
import { exists, readDigest, readJson, sha256Schema } from "../artifact/index.js";
import { err, ok, type Result } from "../result.js";
import { type ImportPaths, type Workspace, workspacePath } from "../workspace.js";

/**
 * Internal to the import module: an import as it lies on disk, read the same
 * way by the command that shows it and the one that groups it.
 *
 * The sections are **derived, never stored**: they are the headings of
 * `material.md`, read on every call, so a person who fixes the Markdown by hand
 * fixes the sections with it, and there is no second file to drift.
 */

/**
 * Both patterns read a file a person may have edited, so neither may
 * backtrack: no lazy group before a run that can match the same characters,
 * and no class that runs across the next `[` or `(`. The title is trimmed in
 * code rather than by a trailing `[ \t]*$`.
 */
const HEADING = /^(#{1,6})[ \t]+(.*)$/;
const IMAGE_LINK = /!\[[^[\]]*\]\(([^()\s]+)\)/g;

export const importFileSchema = z.strictObject({
  id: z.string().min(1),
  /** Each image in the order the document first showed it, and where it lives now. */
  images: z.array(
    z.strictObject({ id: z.string().min(1), part: z.string().min(1), path: z.string().min(1) })
  ),
  /** What the conversion left out on purpose, said again by every `show`. */
  omitted: z.array(z.string()),
  originPath: z.string().min(1),
  schemaVersion: z.literal(1),
  source: z.strictObject({ path: z.string().min(1), sha256: sha256Schema }),
});

export type ImportFile = z.infer<typeof importFileSchema>;

/** One piece of the material between two headings, `T01` in document order. */
export interface ImportSection {
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

/** A section with its words: what grouping sends and copies, and `show` does not print. */
export interface MaterialSection extends ImportSection {
  /** The section as `material.md` holds it, heading line included. */
  readonly text: string;
}

/** The import as it is on disk now. */
export interface StoredImport {
  readonly file: ImportFile;
  readonly material: { readonly sha256: string; readonly text: string };
  readonly sections: readonly MaterialSection[];
}

export class ImportError extends Error {
  readonly reason: "already-exists" | "empty-source" | "missing-import";

  constructor(reason: ImportError["reason"], message: string) {
    super(message);
    this.name = "ImportError";
    this.reason = reason;
  }
}

/** `import.json` and `material.md`, and the sections read off the latter. */
export async function readImport(
  workspace: Workspace,
  paths: ImportPaths,
  importId: string
): Promise<Result<StoredImport>> {
  if (!(await exists(paths.file))) {
    return err(
      new ImportError(
        "missing-import",
        `import "${importId}" nie istnieje: aimator import add ${importId} --source <plik.docx>`
      )
    );
  }

  const file = await readJson(paths.file, importFileSchema);

  if (!file.ok) {
    return file;
  }

  const material = await readDigest(paths.material);

  if (!material.ok) {
    return material;
  }

  const text = material.data.bytes.toString("utf8");

  return ok({
    file: file.data,
    material: { sha256: material.data.sha256, text },
    sections: sectionsOf(workspace, paths, file.data, text),
  });
}

/** A link as a file at `from` writes it: relative to its own directory, with `/`. */
export function linkFrom(from: string, file: string): string {
  return relative(dirname(from), file).split(sep).join("/");
}

/**
 * `text` copied out of `material.md` into the file at `to`, with every link to
 * one of this import's images pointing where it pointed before. Nothing else
 * changes, so the copy stays the material, word for word.
 */
export function relink(
  workspace: Workspace,
  paths: ImportPaths,
  file: ImportFile,
  text: string,
  to: string
): string {
  return text.replace(IMAGE_LINK, (whole, link: string) => {
    const image = file.images.find(
      (one) => linkFrom(paths.material, workspacePath(workspace, one.path)) === link
    );

    return image === undefined
      ? whole
      : whole.slice(0, whole.length - link.length - 1) +
          `${linkFrom(to, workspacePath(workspace, image.path))})`;
  });
}

/** Which image a Markdown link in `material.md` points at, if it is one of this import's. */
function imageAt(
  workspace: Workspace,
  paths: ImportPaths,
  file: ImportFile,
  link: string
): string | null {
  return (
    file.images.find(
      (image) => linkFrom(paths.material, workspacePath(workspace, image.path)) === link
    )?.id ?? null
  );
}

/**
 * The material cut at every heading. What stands before the first one is a
 * section of its own, with no title, so the opening lines of a document are
 * never folded silently into its first chapter.
 */
export function sectionsOf(
  workspace: Workspace,
  paths: ImportPaths,
  file: ImportFile,
  markdown: string
): MaterialSection[] {
  const sections: { level: number; lines: string[]; title: string | null }[] = [];

  for (const line of markdown.split("\n")) {
    const heading = HEADING.exec(line);
    const current = sections.at(-1);

    if (heading !== null) {
      sections.push({
        level: heading[1]?.length ?? 1,
        lines: [line],
        title: (heading[2] ?? "").trim(),
      });
    } else if (current === undefined) {
      sections.push({ level: 0, lines: [line], title: null });
    } else {
      current.lines.push(line);
    }
  }

  return sections
    .filter((section) => section.title !== null || section.lines.join("").trim() !== "")
    .map((section, index) => {
      const text = section.lines.join("\n");
      const body = (section.title === null ? section.lines : section.lines.slice(1)).join("\n");
      const images = [...text.matchAll(IMAGE_LINK)]
        .map((match) => imageAt(workspace, paths, file, match[1] ?? ""))
        .filter((id) => id !== null);

      return {
        characters: body.trim().length,
        id: `T${String(index + 1).padStart(2, "0")}`,
        images,
        level: section.level,
        text,
        title: section.title,
      };
    });
}
