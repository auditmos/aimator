import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSite, publishMedia } from "./index.js";

/**
 * The build and the media publisher, tested through their entry. What every
 * case below is really about is the one promise this module makes: a published
 * release never changes. Both are therefore expected to refuse far more often
 * than they are expected to succeed.
 */

const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

const TEMPLATE = `<!doctype html>
<html lang="pl" data-theme="system" data-lang="pl">
  <head>
    <title data-en="aimator: film · Auditmos">aimator: film · Auditmos</title>
    <link rel="canonical" href="https://aimator.auditmos.com/">
  </head>
  <body>
    <a href="#CURRENT_RELEASE">start</a>
    <div><!-- RELEASE_PICKER --></div>
    <!-- RELEASES -->
  </body>
</html>
`;

/** Published whole, into a directory of its own, without any substitution. */
const PIPELINE_PAGE = `<!doctype html>
<html lang="pl" data-lang="pl">
  <head><title data-en="How it is made">Jak to powstaje</title></head>
  <body><svg viewBox="0 0 10 10"></svg></body>
</html>
`;

const VIDEO = Buffer.from("a finished film, in spirit");
const STILL = Buffer.from("a reference image, in spirit");
const DOCUMENT = "# Lista ujęć\n\nUjęcie 1.\n";
const SOURCE = "# Burza\n\nEwa boi się burzy.\n";

type Registry = Record<string, unknown>;

function registry(version: string): Registry {
  return {
    changes: ["Jedenaście etapów działa od końca do końca."],
    commit: "a".repeat(40),
    commitDate: "2026-09-20T18:27:01Z",
    date: "2026-09-21",
    description: "Ten sam scenariusz narysowały dwa modele obrazu.",
    documents: [
      {
        description: "Ujęcia i klipy.",
        file: "shot-list.md",
        label: "shot-list.md",
        sha256: sha(DOCUMENT),
        stage: 3,
      },
    ],
    episode: {
      aspectRatio: "16:9",
      audio: "narracja, muzyka i efekty",
      episode: "01, Burza",
      language: "pl",
      project: "Dzielna Ewa",
    },
    note: "Jeden odcinek, wyprodukowany we wrześniu.",
    repository: "https://github.com/auditmos/aimator",
    repositoryPrivate: true,
    source: {
      description: "Plik, od którego zaczyna się odcinek.",
      filename: "source.md",
      label: "source.md",
      language: "pl",
      sha256: sha(SOURCE),
    },
    sourceDirectory: `out/releases/${version}`,
    title: "Pierwszy odcinek przeszedł całą ścieżkę.",
    tracks: [
      {
        bytes: VIDEO.byteLength,
        durationSeconds: 90,
        height: 1080,
        label: "gpt-image",
        stills: [
          {
            file: "gpt-image-r01.jpg",
            height: 900,
            kind: "reference",
            label: "R01",
            sha256: sha(STILL),
            subject: "Ewa, evening appearance",
            width: 1600,
          },
        ],
        track: "gpt-image",
        video: "gpt-image-mixed.mp4",
        videoSha256: sha(VIDEO),
        width: 1920,
      },
    ],
    version,
  };
}

const roots: string[] = [];

/** The text a release publishes lives in the repository; its media do not. */
async function addRelease(root: string, version: string, overrides: Registry = {}) {
  const exports = join(root, "out", "releases", version);
  await mkdir(exports, { recursive: true });
  await writeFile(join(exports, "gpt-image-mixed.mp4"), VIDEO);
  await writeFile(join(exports, "gpt-image-r01.jpg"), STILL);
  await mkdir(join(root, "site", "documents", version), { recursive: true });
  await writeFile(join(root, "site", "documents", version, "shot-list.md"), DOCUMENT);
  await mkdir(join(root, "site", "sources", version), { recursive: true });
  await writeFile(join(root, "site", "sources", version, "source.md"), SOURCE);
  await mkdir(join(root, "site", "assets", "releases", version), { recursive: true });
  await writeFile(join(root, "site", "assets", "releases", version, "gpt-image.jpg"), STILL);
  await writeFile(
    join(root, "site", "releases", `${version}.json`),
    JSON.stringify({ ...registry(version), ...overrides })
  );
}

/** A repository with one release, plus a private file the build must not copy. */
async function repository(overrides: Registry = {}) {
  const root = await mkdtemp(join(tmpdir(), "aimator-site-"));
  roots.push(root);
  await mkdir(join(root, "site", "assets"), { recursive: true });
  await mkdir(join(root, "site", "releases"), { recursive: true });
  await writeFile(join(root, "site", "index.html"), TEMPLATE);
  await writeFile(join(root, "site", "jak-to-powstaje.html"), PIPELINE_PAGE);
  for (const file of [
    "styles.css",
    "theme.js",
    "lang.js",
    "app.js",
    "_headers",
    "robots.txt",
    "sitemap.xml",
    "llms.txt",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: the fixture writes its files in order
    await writeFile(join(root, "site", file), `/* ${file} */`);
  }
  await writeFile(join(root, ".env"), "AIMATOR_WORKSPACE=/secret");
  await writeFile(join(root, "site", "notes.txt"), "an operator's own notes");
  await addRelease(root, "0.1.0", overrides);
  return root;
}

async function published(root: string): Promise<string[]> {
  const out = join(root, "out", "site");
  const walk = async (directory: string, prefix: string): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true });
    const found: string[] = [];
    for (const entry of entries) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        // biome-ignore lint/performance/noAwaitInLoops: the published tree is walked in order
        found.push(...(await walk(join(directory, entry.name), `${path}/`)));
      } else {
        found.push(path);
      }
    }
    return found;
  };
  return (await walk(out, "")).sort();
}

/** A bucket that records what it was handed instead of uploading it. */
function uploader() {
  const put: string[] = [];
  return {
    put,
    upload: (version: string, file: string) => {
      put.push(`${version}/${file}`);
      return Promise.resolve();
    },
  };
}

const indexHtml = (root: string) => readFile(join(root, "out", "site", "index.html"), "utf8");

afterEach(async () => {
  for (const root of roots.splice(0)) {
    // biome-ignore lint/performance/noAwaitInLoops: temporary roots are removed one at a time
    await rm(root, { force: true, recursive: true });
  }
});

describe("buildSite", () => {
  it("should publish the allowlist and the release text, and nothing else", async () => {
    const root = await repository();

    const result = await buildSite(root);

    expect(result.ok).toBe(true);
    const files = await published(root);
    expect(files).toContain("styles.css");
    expect(files).toContain("sources/0.1.0/source.md");
    expect(files).toContain("documents/0.1.0/shot-list.md");
    expect(files).toContain("releases/0.1.0/index.html");
    // A page of its own, not a section of the front page and not a release.
    expect(files).toContain("jak-to-powstaje/index.html");
    expect(files).not.toContain("jak-to-powstaje.html");
    // The registry describes the release; it is not itself a published file.
    expect(files).not.toContain("releases/0.1.0.json");
    expect(files).not.toContain("notes.txt");
    expect(files.some((file) => file.includes(".env"))).toBe(false);
  });

  it("should leave the media out of the bundle entirely", async () => {
    const root = await repository();

    await buildSite(root);

    const files = await published(root);
    expect(files.some((file) => file.startsWith("media/"))).toBe(false);
    expect(files.some((file) => file.endsWith(".mp4"))).toBe(false);
    // The page still links them; the worker answers those paths from the bucket.
    expect(await indexHtml(root)).toContain("/media/0.1.0/gpt-image-mixed.mp4");
  });

  it("should build with no frozen exports on disk at all", async () => {
    const root = await repository();
    await rm(join(root, "out", "releases"), { force: true, recursive: true });

    const result = await buildSite(root);

    expect(result.ok).toBe(true);
    expect(await indexHtml(root)).toContain("Pierwszy odcinek przeszedł całą ścieżkę.");
  });

  it("should carry both languages, falling back to Polish where a release is untranslated", async () => {
    const root = await repository();

    await buildSite(root);

    const html = await indexHtml(root);
    expect(html).toContain('<span class="t" lang="pl">Pierwszy odcinek przeszedł całą ścieżkę.');
    expect(html).toContain('<span class="t" lang="en">Pierwszy odcinek przeszedł całą ścieżkę.');
  });

  it("should prefer the English translation where a release carries one", async () => {
    const root = await repository({ en: { title: "The first episode went the whole way." } });

    await buildSite(root);

    const html = await indexHtml(root);
    expect(html).toContain('<span class="t" lang="en">The first episode went the whole way.');
  });

  it("should escape text taken from the registry", async () => {
    const root = await repository({ title: '<script>alert("x")</script>' });

    await buildSite(root);

    const html = await indexHtml(root);
    expect(html).not.toContain('<script>alert("x")');
    expect(html).toContain("&lt;script&gt;");
  });

  it("should point the hero at the release it publishes", async () => {
    const root = await repository();

    await buildSite(root);

    expect(await indexHtml(root)).toContain('href="#release-0-1-0"');
  });

  it("should give every release its own page and mark the current one in the picker", async () => {
    const root = await repository();
    await addRelease(root, "0.2.0");

    await buildSite(root);

    const files = await published(root);
    expect(files).toContain("releases/0.1.0/index.html");
    expect(files).toContain("releases/0.2.0/index.html");
    // The newest release is the one the front page shows.
    expect(await indexHtml(root)).toContain('href="#release-0-2-0"');
    const older = await readFile(
      join(root, "out", "site", "releases", "0.1.0", "index.html"),
      "utf8"
    );
    expect(older).toContain('<a href="/releases/0.1.0/#changelog" aria-current="page">');
    // The version prefixes the title in both languages, not only the visible one.
    expect(older).toContain('data-en="v0.1.0 · aimator: film · Auditmos"');
    expect(older).toContain(">v0.1.0 · aimator: film · Auditmos</title>");
  });

  it("should refuse a stage document whose bytes changed", async () => {
    const root = await repository();
    await writeFile(join(root, "site", "documents", "0.1.0", "shot-list.md"), "# Inne ujęcia\n");

    const result = await buildSite(root);

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain("changed: shot-list.md");
  });

  it("should keep the previous build when a release stops validating", async () => {
    const root = await repository();
    await buildSite(root);
    await writeFile(join(root, "site", "sources", "0.1.0", "source.md"), "# Inna burza\n");

    const result = await buildSite(root);

    expect(result.ok ? "" : result.error.message).toContain("changed: source.md");
    expect(await indexHtml(root)).toContain("Pierwszy odcinek przeszedł całą ścieżkę.");
  });

  it("should report a registered document that is not on disk", async () => {
    const root = await repository();
    await rm(join(root, "site", "documents", "0.1.0", "shot-list.md"));

    const result = await buildSite(root);

    expect(result.ok ? "" : result.error.message).toBe("missing: shot-list.md");
  });

  it("should refuse a release whose prose nobody has written yet", async () => {
    const root = await repository({ note: "TODO", title: "TODO" });

    const result = await buildSite(root);

    const message = result.ok ? "" : result.error.message;
    expect(message).toContain("title");
    expect(message).toContain("note");
    // The word would otherwise have been published to the internet.
    expect(message).toContain("nienapisane");
  });

  it("should refuse a release that names another repository", async () => {
    const root = await repository({ repository: "https://github.com/someone/else" });

    const result = await buildSite(root);

    expect(result.ok ? "" : result.error.message).toContain("repository");
  });

  it("should write an English machine twin alongside the page", async () => {
    const root = await repository({ en: { description: "Two image models drew it." } });

    await buildSite(root);

    const markdown = await readFile(join(root, "out", "site", "index.md"), "utf8");
    expect(markdown).toContain("# aimator by Auditmos");
    expect(markdown).toContain("Two image models drew it.");
    expect(markdown).toContain("[View this release](/releases/0.1.0/)");
  });
});

describe("publishMedia", () => {
  it("should hand the bucket every media file the registry declares", async () => {
    const root = await repository();
    const bucket = uploader();

    const result = await publishMedia(root, bucket.upload);

    expect(result.ok).toBe(true);
    expect(bucket.put).toEqual(["0.1.0/gpt-image-mixed.mp4", "0.1.0/gpt-image-r01.jpg"]);
  });

  it("should never hand over a file whose bytes changed", async () => {
    const root = await repository();
    const bucket = uploader();
    // Same length as the registered film, so only the hash can tell them apart.
    const rerender = "A FINISHED FILM, IN SPIRIT";
    expect(rerender.length).toBe(VIDEO.byteLength);
    await writeFile(join(root, "out", "releases", "0.1.0", "gpt-image-mixed.mp4"), rerender);

    const result = await publishMedia(root, bucket.upload);

    expect(result.ok ? "" : result.error.message).toContain("changed: gpt-image-mixed.mp4");
    expect(bucket.put).toEqual([]);
  });

  it("should refuse a film whose declared size is not its real one", async () => {
    const tracks = registry("0.1.0").tracks as Record<string, unknown>[];
    const root = await repository({ tracks: [{ ...tracks[0], bytes: 99 }] });
    const bucket = uploader();

    const result = await publishMedia(root, bucket.upload);

    expect(result.ok ? "" : result.error.message).toContain("the registry says 99");
    expect(bucket.put).toEqual([]);
  });

  it("should report a registered media file that is not on disk", async () => {
    const root = await repository();
    const bucket = uploader();
    await rm(join(root, "out", "releases", "0.1.0", "gpt-image-r01.jpg"));

    const result = await publishMedia(root, bucket.upload);

    expect(result.ok ? "" : result.error.message).toBe("missing: gpt-image-r01.jpg");
    // The film before it was already handed over; the refusal stops the rest.
    expect(bucket.put).toEqual(["0.1.0/gpt-image-mixed.mp4"]);
  });

  it("should refuse a source directory that is not a frozen export", async () => {
    const root = await repository({ sourceDirectory: "site" });
    const bucket = uploader();

    const result = await publishMedia(root, bucket.upload);

    expect(result.ok ? "" : result.error.message).toContain("inside out/");
    expect(bucket.put).toEqual([]);
  });
});
