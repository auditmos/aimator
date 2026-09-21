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
import { basename, join, resolve, sep } from "node:path";
import { err, ok, type Result } from "../lib/result.js";
import {
  type ReleaseTexts,
  type RenderedRelease,
  renderNotFound,
  renderPicker,
  renderRelease,
} from "./render.js";
import { type Release, releaseSchema } from "./schema.js";

/**
 * Builds the published site into `out/site`.
 *
 * The one thing this module is for: a release that has been published never
 * changes. Every file it copies is checked against the sha256 the registry
 * recorded, so an export edited after publication fails the build instead of
 * replacing an asset whose cache is a year long. That is the same bargain the
 * pipeline's stages make with `approve` — acceptance is bound to bytes — read
 * one level up, where the bytes leave the machine.
 *
 * It never reads `AIMATOR_WORKSPACE`. A release names a frozen export
 * directory inside `out/`, which is what lets the site be rebuilt from the
 * repository after the workspace has moved on to the next episode.
 */

const SITE_URL = "https://aimator.auditmos.com";
const REPOSITORY = "https://github.com/auditmos/aimator";
/** Cloudflare Static Assets refuses a file above this bound. Fail before upload. */
const FILE_LIMIT = 25 * 1024 * 1024;
const SOURCE_PREVIEW_LIMIT = 120_000;
/** Both titles open with the product name, so one prefix covers both languages. */
const TITLE_TAG = /<title([^>]*)>/;
const TITLE_PL = /<title[^>]*>aimator/;
const TITLE_EN = /data-en="aimator/;

/** Only this allowlist is published. Never the repo, `.env` or a workspace. */
const STATIC_FILES = [
  "_headers",
  "app.js",
  "assets",
  "lang.js",
  "llms.txt",
  "robots.txt",
  "sitemap.xml",
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
async function fileSize(release: Release, path: string, label: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    // biome-ignore lint/style/useErrorCause: SiteBuildError carries its cause as the third argument
    throw new SiteBuildError(release.version, `missing: ${label}`, { cause: error });
  }
}

/**
 * Copies one frozen file into the staging tree, refusing anything whose bytes
 * are not the ones the registry recorded.
 */
async function freeze(
  release: Release,
  from: string,
  to: string,
  file: string,
  expected: string
): Promise<number> {
  if (file !== basename(file)) {
    throw new SiteBuildError(release.version, `Unsafe asset filename: ${file}`);
  }
  const path = join(from, file);
  const size = await fileSize(release, path, file);
  if (size > FILE_LIMIT) {
    throw new SiteBuildError(
      release.version,
      `${file} exceeds 25 MiB; move release media to R2 before publishing.`
    );
  }
  if ((await checksum(path)) !== expected) {
    throw new SiteBuildError(
      release.version,
      `changed: ${file}. Preserve this release and register changed exports as a new version.`
    );
  }
  await cp(path, join(to, file));
  return size;
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

async function prepareRelease(
  release: Release,
  source: string,
  staging: string,
  root: string,
  target: string,
  mediaSizes: Record<string, number>
): Promise<RenderedRelease> {
  if (release.repository !== REPOSITORY) {
    throw new SiteBuildError(release.version, "Release needs this repository's exact URL.");
  }
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

  // The episode's own input, frozen beside the registry rather than in out/:
  // it is the one file a release did not produce, and the page shows it.
  const sourceDocument = join(source, "sources", release.version, release.source.filename);
  await fileSize(release, sourceDocument, release.source.filename);
  if ((await checksum(sourceDocument)) !== release.source.sha256) {
    throw new SiteBuildError(release.version, "source document changed.");
  }
  const sourceText = await readFile(sourceDocument, "utf8");
  const sourceBytes = Buffer.byteLength(sourceText);
  if (sourceBytes > SOURCE_PREVIEW_LIMIT) {
    throw new SiteBuildError(release.version, "Source document exceeds the preview limit.");
  }
  const publicSource = join(staging, "sources", release.version);
  await mkdir(publicSource, { recursive: true });
  await writeFile(join(publicSource, release.source.filename), sourceText);

  const media = join(staging, "media", release.version);
  await mkdir(media, { recursive: true });
  const record = (file: string, size: number) => {
    mediaSizes[`/media/${release.version}/${file}`] = size;
  };

  const tracks = new Set<string>();
  for (const track of release.tracks) {
    if (tracks.has(track.track)) {
      throw new SiteBuildError(release.version, `duplicate track: ${track.track}`);
    }
    tracks.add(track.track);
    // A poster is committed beside the page, not frozen with the export.
    const poster = join(staging, "assets", "releases", release.version, `${track.track}.jpg`);
    // biome-ignore lint/performance/noAwaitInLoops: the allowlist is copied in its declared order
    await fileSize(release, poster, `${track.track}.jpg poster`);
    const bytes = await freeze(release, exports, media, track.video, track.videoSha256);
    if (bytes !== track.bytes) {
      throw new SiteBuildError(
        release.version,
        `${track.video} is ${bytes} bytes; the registry says ${track.bytes}.`
      );
    }
    record(track.video, bytes);
    const stills = new Set<string>();
    for (const still of track.stills) {
      if (stills.has(still.label)) {
        throw new SiteBuildError(release.version, `duplicate still: ${still.label}`);
      }
      stills.add(still.label);
      // biome-ignore lint/performance/noAwaitInLoops: one track's film is frozen at a time
      record(still.file, await freeze(release, exports, media, still.file, still.sha256));
    }
  }

  const documents = new Map<string, string>();
  for (const document of release.documents) {
    // biome-ignore lint/performance/noAwaitInLoops: one still at a time, so the first changed file is the one named
    record(document.file, await freeze(release, exports, media, document.file, document.sha256));
    documents.set(document.file, await readFile(join(media, document.file), "utf8"));
  }

  const texts: ReleaseTexts = { documents, source: sourceText, sourceBytes };
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
      // biome-ignore lint/performance/noAwaitInLoops: one document at a time, in the order the registry lists them
      await cp(join(source, file), join(staging, file), { recursive: true });
    }
    const releases = await readRegistry(source);
    const seen = new Set<string>();
    const mediaSizes: Record<string, number> = {};
    const pages: RenderedRelease[] = [];
    const markdown = [...MARKDOWN_HEADER];
    for (const release of releases) {
      if (seen.has(release.version)) {
        throw new SiteBuildError(release.version, "duplicate release version.");
      }
      seen.add(release.version);
      // biome-ignore lint/performance/noAwaitInLoops: releases are prepared in order, newest first
      const page = await prepareRelease(release, source, staging, root, target, mediaSizes);
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
    await writeFile(join(staging, "media-index.json"), JSON.stringify(mediaSizes));
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
