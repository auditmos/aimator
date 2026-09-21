import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { err, ok, type Result } from "../lib/result.js";
import { unwrittenFields } from "./episode.js";
import { putMedia } from "./media.js";
import {
  type ReleaseTexts,
  type RenderedRelease,
  renderNotFound,
  renderPicker,
  renderRelease,
} from "./render.js";
import { type Release, releaseSchema } from "./schema.js";

/**
 * Builds the published site into `out/site`, and publishes a release's heavy
 * files to R2.
 *
 * The one thing this module is for: a release that has been published never
 * changes. Nothing reaches the public without being checked against the sha256
 * the registry recorded, so an export edited after publication fails instead of
 * replacing a file whose cache is a year long. That is the same bargain the
 * pipeline's stages make with `approve` — acceptance bound to bytes — read one
 * level up, where the bytes leave the machine.
 *
 * A release's bytes live in two places, split by what they are. **Text is
 * committed**: the episode's source file and each stage's document sit under
 * `site/`, because they are small, they are worth reading in a diff, and the
 * page quotes them rather than linking them. **Media go to R2**: films and
 * stills are streamed, not read, and a bucket is the only copy of them that
 * survives the laptop that made them.
 *
 * So `buildSite` needs nothing from `out/` at all — a fresh clone can rebuild
 * and redeploy the page while the films stay exactly where they were. Only
 * `publishMedia` reads the frozen exports, and only to put them in the bucket.
 *
 * Neither ever reads `AIMATOR_WORKSPACE`, which is what keeps rule 3 intact:
 * this module joins the repository's own paths and never the workspace's.
 */

const SITE_URL = "https://aimator.auditmos.com";
const REPOSITORY = "https://github.com/auditmos/aimator";
const TEXT_PREVIEW_LIMIT = 120_000;
/** Both titles open with the product name, so one prefix covers both languages. */
const TITLE_TAG = /<title([^>]*)>/;
const TITLE_PL = /<title[^>]*>aimator/;
const TITLE_EN = /data-en="aimator/;

/** Only this allowlist is published. Never the repo, `.env` or a workspace. */
const STATIC_FILES = [
  "_headers",
  "app.js",
  "assets",
  "documents",
  "lang.js",
  "llms.txt",
  "robots.txt",
  "sitemap.xml",
  "sources",
  "styles.css",
  "theme.js",
] as const;

const MARKDOWN_HEADER = [
  "# aimator by Auditmos",
  "",
  "A CLI that walks one person through producing a short animated episode.",
  "",
  "Eleven stages, each consuming only files earlier stages produced — never conversation context. One project can carry a complete set of assets on two image tracks, which yields two independent animations from one screenplay. Polish narration by default.",
  "",
  "## Changelog",
  "",
];

class SiteBuildError extends Error {
  readonly release: string;

  constructor(release: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SiteBuildError";
    this.release = release;
  }
}

async function checksum(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/** A registered file that is not on disk is a release fault, not a crash. */
async function fileSize(release: string, path: string, label: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    // biome-ignore lint/style/useErrorCause: SiteBuildError carries its cause as the third argument
    throw new SiteBuildError(release, `missing: ${label}`, { cause: error });
  }
}

/** Refuses any file whose bytes are not the ones the registry recorded. */
async function verify(release: string, path: string, label: string, expected: string) {
  await fileSize(release, path, label);
  if ((await checksum(path)) !== expected) {
    throw new SiteBuildError(
      release,
      `changed: ${label}. Preserve this release and register changed exports as a new version.`
    );
  }
}

/** A text file the page quotes: verified, size-bounded, read into the page. */
async function readVerified(release: string, path: string, label: string, expected: string) {
  await verify(release, path, label, expected);
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text) > TEXT_PREVIEW_LIMIT) {
    throw new SiteBuildError(release, `${label} exceeds the preview limit.`);
  }
  return text;
}

async function readRegistry(source: string): Promise<Release[]> {
  const names = (await readdir(join(source, "releases"))).filter((name) => name.endsWith(".json"));
  const releases: Release[] = [];
  for (const name of names) {
    // biome-ignore lint/performance/noAwaitInLoops: one registry file at a time, so the first bad one is the one named
    const text = await readFile(join(source, "releases", name), "utf8");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      // biome-ignore lint/style/useErrorCause: SiteBuildError carries its cause as the third argument
      throw new SiteBuildError(name, "release registry is not valid JSON.", { cause: error });
    }
    // Before the schema, deliberately: a frozen release carries `TODO` where a
    // commit hash or a date will go, and "must match /^[a-f0-9]{40}$/" is a
    // worse answer to "you have not written this yet" than saying so.
    const unwritten = unwrittenFields(raw);
    if (unwritten.length > 0) {
      throw new SiteBuildError(
        name,
        `pola jeszcze nienapisane: ${unwritten.join(", ")}. Wydanie zamrożone, ale nieopisane, nie jest wydaniem gotowym do publikacji.`
      );
    }
    const parsed = releaseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new SiteBuildError(
        name,
        `invalid release registry: ${parsed.error.issues[0]?.message}`
      );
    }
    releases.push(parsed.data);
  }
  if (releases.length === 0) {
    throw new SiteBuildError("*", "No releases to publish.");
  }
  releases.sort((a, b) => b.version.localeCompare(a.version, "en", { numeric: true }));
  return releases;
}

/** The frozen export directory a release names, checked before it is read. */
function exportDirectory(release: Release, root: string, target: string): string {
  const exports = resolve(root, release.sourceDirectory);
  const out = resolve(root, "out");
  if (
    !exports.startsWith(`${out}${sep}`) ||
    exports === target ||
    exports.startsWith(`${target}${sep}`)
  ) {
    throw new SiteBuildError(
      release.version,
      "Release source must be a frozen export directory inside out/."
    );
  }
  return exports;
}

interface MediaFile {
  /** Declared only by a film, whose size the page prints beside it. */
  readonly bytes?: number;
  readonly file: string;
  readonly sha256: string;
}

/** Every media file a release declares, film first, in the order it lists them. */
function mediaFiles(release: Release): MediaFile[] {
  const files: MediaFile[] = [];
  const tracks = new Set<string>();
  for (const track of release.tracks) {
    if (tracks.has(track.track)) {
      throw new SiteBuildError(release.version, `duplicate track: ${track.track}`);
    }
    tracks.add(track.track);
    files.push({ bytes: track.bytes, file: track.video, sha256: track.videoSha256 });
    const stills = new Set<string>();
    for (const still of track.stills) {
      if (stills.has(still.label)) {
        throw new SiteBuildError(release.version, `duplicate still: ${still.label}`);
      }
      stills.add(still.label);
      files.push({ file: still.file, sha256: still.sha256 });
    }
  }
  return files;
}

async function prepareRelease(
  release: Release,
  source: string,
  staging: string
): Promise<RenderedRelease> {
  if (release.repository !== REPOSITORY) {
    throw new SiteBuildError(release.version, "Release needs this repository's exact URL.");
  }
  // The episode's own input: the one file a release did not produce.
  const sourceText = await readVerified(
    release.version,
    join(source, "sources", release.version, release.source.filename),
    release.source.filename,
    release.source.sha256
  );

  const documents = new Map<string, string>();
  for (const document of release.documents) {
    documents.set(
      document.file,
      // biome-ignore lint/performance/noAwaitInLoops: one document at a time, in the order the registry lists them
      await readVerified(
        release.version,
        join(source, "documents", release.version, document.file),
        document.file,
        document.sha256
      )
    );
  }

  for (const track of release.tracks) {
    // A poster is committed beside the page; the film it stands for is in R2.
    // biome-ignore lint/performance/noAwaitInLoops: one track at a time
    await fileSize(
      release.version,
      join(staging, "assets", "releases", release.version, `${track.track}.jpg`),
      `${track.track}.jpg poster`
    );
  }
  // Media are not read here, but the registry that names them still has to
  // make sense before a page links to it.
  mediaFiles(release);

  const texts: ReleaseTexts = {
    documents,
    source: sourceText,
    sourceBytes: Buffer.byteLength(sourceText),
  };
  return renderRelease(release, texts);
}

function pageHtml(template: string, page: RenderedRelease, picker: string, url: string): string {
  return template
    .replaceAll('="./', '="/')
    .replaceAll(`${SITE_URL}/"`, `${url}"`)
    .replaceAll("#CURRENT_RELEASE", `#${page.anchor}`)
    .replace("<!-- RELEASE_PICKER -->", picker)
    .replace("<!-- RELEASES -->", page.html);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the build is one sequence; splitting it would hide the order it depends on
export async function buildSite(root: string): Promise<Result<string>> {
  const source = join(root, "site");
  const out = join(root, "out");
  await mkdir(out, { recursive: true });
  const staging = await mkdtemp(join(out, ".site-build-"));
  const target = join(out, "site");
  const previous = `${staging}-previous`;
  let movedPrevious = false;
  try {
    for (const file of STATIC_FILES) {
      // biome-ignore lint/performance/noAwaitInLoops: the allowlist is copied in its declared order
      await cp(join(source, file), join(staging, file), { recursive: true });
    }
    const releases = await readRegistry(source);
    const seen = new Set<string>();
    const pages: RenderedRelease[] = [];
    const markdown = [...MARKDOWN_HEADER];
    for (const release of releases) {
      if (seen.has(release.version)) {
        throw new SiteBuildError(release.version, "duplicate release version.");
      }
      seen.add(release.version);
      // biome-ignore lint/performance/noAwaitInLoops: releases are prepared in order, newest first
      const page = await prepareRelease(release, source, staging);
      pages.push(page);
      markdown.push(...page.markdown);
    }

    const template = await readFile(join(source, "index.html"), "utf8");
    if (!(template.includes("<!-- RELEASES -->") && template.includes("<!-- RELEASE_PICKER -->"))) {
      throw new SiteBuildError("*", "Release insertion point missing.");
    }
    if (!(TITLE_PL.test(template) && TITLE_EN.test(template))) {
      throw new SiteBuildError("*", "Title in both languages missing.");
    }
    for (const [index, page] of pages.entries()) {
      const picker = renderPicker(pages, page);
      const directory = join(staging, "releases", page.version);
      // biome-ignore lint/performance/noAwaitInLoops: one page written at a time
      await mkdir(directory, { recursive: true });
      const html = pageHtml(
        template,
        page,
        picker,
        `${SITE_URL}/releases/${page.version}/`
      ).replace(
        TITLE_TAG,
        (_, attributes: string) =>
          `<title${attributes.replace('data-en="', `data-en="v${page.version} · `)}>v${page.version} · `
      );
      await writeFile(join(directory, "index.html"), html);
      if (index === 0) {
        await writeFile(
          join(staging, "index.html"),
          pageHtml(template, page, picker, `${SITE_URL}/`)
        );
      }
    }

    const urls = [
      `<url><loc>${SITE_URL}/</loc></url>`,
      ...pages.map((page) => `<url><loc>${SITE_URL}/releases/${page.version}/</loc></url>`),
    ].join("");
    await writeFile(
      join(staging, "sitemap.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>\n`
    );
    await writeFile(join(staging, "index.md"), `${markdown.join("\n")}\n`);
    await writeFile(join(staging, "404.html"), renderNotFound());

    try {
      await rename(target, previous);
      movedPrevious = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    try {
      await rename(staging, target);
    } catch (error) {
      if (movedPrevious) {
        await rename(previous, target);
      }
      throw error;
    }
    if (movedPrevious) {
      await rm(previous, { recursive: true });
    }
    return ok(target);
  } catch (error) {
    if (error instanceof SiteBuildError) {
      return err(error);
    }
    throw error;
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
}

/**
 * Puts every registered release's media in the bucket, after checking each
 * file against the sha256 the registry recorded.
 *
 * `put` is the only operation, and it is deliberately the only one: a release
 * whose bytes verify can be re-published as often as you like and the object
 * never changes, so there is nothing here that could quietly replace a film.
 */
export async function publishMedia(
  root: string,
  put = putMedia
): Promise<Result<readonly string[]>> {
  const source = join(root, "site");
  const target = join(root, "out", "site");
  try {
    const published: string[] = [];
    for (const release of await readRegistry(source)) {
      const exports = exportDirectory(release, root, target);
      for (const { bytes, file, sha256 } of mediaFiles(release)) {
        const path = join(exports, file);
        // biome-ignore lint/performance/noAwaitInLoops: one file at a time, so the first changed one is the one named
        const size = await fileSize(release.version, path, file);
        if (bytes !== undefined && bytes !== size) {
          throw new SiteBuildError(
            release.version,
            `${file} is ${size} bytes; the registry says ${bytes}.`
          );
        }
        await verify(release.version, path, file, sha256);
        await put(release.version, file, path);
        published.push(`${release.version}/${file}`);
      }
    }
    return ok(published);
  } catch (error) {
    if (error instanceof SiteBuildError) {
      return err(error);
    }
    throw error;
  }
}

export { freezeRelease } from "./episode.js";
