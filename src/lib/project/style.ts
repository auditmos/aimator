import {
  exists,
  type RecordedFile,
  readDigest,
  readJson,
  sha256Of,
  toWorkspacePath,
  type WriteOp,
} from "../artifact/index.js";
import { err, ok, type Result } from "../result.js";
import { type ProjectPaths, styleSource, type Workspace } from "../workspace.js";
import { type StyleFile, styleFileSchema } from "./schema.js";

/**
 * Internal to the project module: the style frames, stage 0's decision about
 * which images show every film frame its medium, line, palette and light.
 *
 * It is stage 0's because bringing files in from outside the workspace is
 * stage 0's monopoly, so an image somebody supplies is an output of this stage
 * like a character's photograph is. It is not in `project.json` because that
 * file is a recorded input of nearly every artifact, and a style frame is an
 * input of film frames alone: where a decision lives decides what changing it
 * invalidates.
 */

/** What somebody decided, in the shape the command carries it. */
export type StyleDecision =
  | { readonly basis: "none" }
  | { readonly basis: "supplied"; readonly sourcePaths: readonly string[] };

/** A PNG's first eight bytes. Anything else would be misnamed by `Snn.png`. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class StyleInputError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "StyleInputError";
    this.field = field;
  }
}

/** `style.json` as it stands, or `null` when nobody has decided yet. */
export async function readStyleFile(path: string): Promise<Result<StyleFile | null>> {
  return (await exists(path)) ? await readJson(path, styleFileSchema) : ok(null);
}

interface StylePlan {
  /** The images to copy in, each under the id it is given here. */
  readonly copies: readonly WriteOp[];
  readonly created: readonly string[];
  readonly file: StyleFile;
  /** Images brought again whose bytes are already recorded, by recorded path. */
  readonly reused: readonly string[];
}

function styleId(index: number): string {
  return `S${String(index + 1).padStart(2, "0")}`;
}

/**
 * The new `style.json` and the copies that make it true.
 *
 * Images already recorded stay, whatever the new basis: they are stage 0's
 * outputs and their digests are verified like any other. Deciding "none" only
 * stops them being attached. An image brought twice is one image, compared by
 * digest, as a character's photographs are.
 */
export async function planStyle(
  workspace: Workspace,
  project: ProjectPaths,
  current: StyleFile | null,
  decision: StyleDecision
): Promise<Result<StylePlan>> {
  const sources = [...(current?.sources ?? [])];

  if (decision.basis === "none") {
    return ok({
      copies: [],
      created: [],
      file: { basis: "none", schemaVersion: 1, sources },
      reused: [],
    });
  }

  const copies: WriteOp[] = [];
  const created: string[] = [];
  const reused: string[] = [];
  const digests = await Promise.all(decision.sourcePaths.map((path) => readDigest(path)));

  for (const [index, sourcePath] of decision.sourcePaths.entries()) {
    const digest = digests[index];

    if (digest === undefined || !digest.ok) {
      return digest ?? err(new StyleInputError("source", `nie można odczytać ${sourcePath}`));
    }

    if (!digest.data.bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      return err(
        new StyleInputError(
          "source",
          `${sourcePath} nie jest plikiem PNG, a obraz stylu trafia do katalogu roboczego jako Snn.png; zapisz go jako PNG`
        )
      );
    }

    const already = sources.find((one) => one.sha256 === digest.data.sha256);

    if (already !== undefined) {
      reused.push(already.path);
      continue;
    }

    const id = styleId(sources.length);
    const destination = styleSource(project, id);

    if (!destination.ok) {
      return destination;
    }

    const path = toWorkspacePath(workspace.root, destination.data);

    sources.push({ id, originPath: sourcePath, path, sha256: digest.data.sha256 });
    copies.push({ from: sourcePath, kind: "copy", to: destination.data });
    created.push(path);
  }

  return ok({ copies, created, file: { basis: "supplied", schemaVersion: 1, sources }, reused });
}

/** What stage 0 records for the style: `style.json` and every image it names. */
export function styleOutputs(
  workspace: Workspace,
  project: ProjectPaths,
  file: StyleFile,
  text: string
): readonly RecordedFile[] {
  return [
    { path: toWorkspacePath(workspace.root, project.style), sha256: sha256Of(Buffer.from(text)) },
    ...file.sources.map((one) => ({ path: one.path, sha256: one.sha256 })),
  ];
}
