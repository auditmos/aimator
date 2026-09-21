import type { Release, ReleaseStill, ReleaseTrack } from "./schema.js";

/**
 * The page's markup. Every value that reaches it is escaped here rather than
 * at its source, so a release registry is ordinary data and never a way to put
 * markup on the page.
 *
 * One page carries both languages at once: `both` emits the Polish text and
 * the English text side by side, and `styles.css` hides whichever one
 * `lang.js` did not select. The choice therefore lands before the first paint.
 */

const ESCAPES: Record<string, string> = {
  "'": "&#39;",
  '"': "&quot;",
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);

const both = (pl: string, en: string): string =>
  `<span class="t" lang="pl">${escapeHtml(pl)}</span><span class="t" lang="en">${escapeHtml(en)}</span>`;

const duration = (seconds: number): string => {
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
};

const megabytes = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;

const DATE_OPTIONS = {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
} as const;

const STILL_GROUPS = [
  { en: "Opening frame", kind: "opening-frame", pl: "Klatka otwarcia" },
  { en: "References", kind: "reference", pl: "Referencje" },
  { en: "Characters", kind: "character", pl: "Postacie" },
] as const;

export interface ReleaseTexts {
  /** Every document's frozen text, keyed by its file name. */
  readonly documents: ReadonlyMap<string, string>;
  readonly source: string;
  readonly sourceBytes: number;
}

export interface RenderedRelease {
  readonly anchor: string;
  readonly html: string;
  /** The English machine twin, as the lines it contributes to `index.md`. */
  readonly markdown: readonly string[];
  readonly version: string;
}

/** Streamed from the bucket by the worker. */
const mediaUrl = (version: string, file: string): string => `/media/${version}/${file}`;
/** Served straight from the deployed assets: a stage document is small text. */
const documentUrl = (version: string, file: string): string => `/documents/${version}/${file}`;

const sourceUrl = (release: Release): string =>
  `/sources/${release.version}/${release.source.filename}`;

function renderStill(release: Release, track: ReleaseTrack, still: ReleaseStill): string {
  const url = mediaUrl(release.version, still.file);
  const alt = `${still.label} — ${still.subject}`;
  return `<li><figure><a href="${url}"><img src="${url}" width="${still.width}" height="${still.height}" loading="lazy" alt="${escapeHtml(alt)}, ${escapeHtml(track.label)}"></a>
    <figcaption><strong>${escapeHtml(still.label)}</strong> · ${escapeHtml(still.subject)}<br>JPEG · ${still.width} × ${still.height}</figcaption></figure></li>`;
}

function renderStillGroups(release: Release, track: ReleaseTrack): string {
  return STILL_GROUPS.map((group) => {
    const stills = track.stills.filter((still) => still.kind === group.kind);
    if (stills.length === 0) {
      return "";
    }
    const wide = group.kind === "opening-frame" ? ' class="stills still-wide"' : ' class="stills"';
    return `<details><summary>${both(`${group.pl} (${stills.length})`, `${group.en} (${stills.length})`)}<span class="sr-only">, ${escapeHtml(track.label)}</span></summary>
      <ul${wide}>${stills.map((still) => renderStill(release, track, still)).join("")}</ul></details>`;
  }).join("");
}

function renderTrack(release: Release, track: ReleaseTrack): string {
  const id = `${release.version.replaceAll(".", "-")}-${track.track}`;
  const videoUrl = mediaUrl(release.version, track.video);
  const posterUrl = `/assets/releases/${release.version}/${track.track}.jpg`;
  const forTrack = `<span class="sr-only">, ${escapeHtml(track.label)}</span>`;
  const audio = both(release.episode.audio, release.en?.episode?.audio ?? release.episode.audio);
  return `<article class="track" data-track="${escapeHtml(track.track)}" aria-labelledby="track-${id}">
    <div class="asset-heading"><h4 id="track-${id}">${escapeHtml(track.label)}</h4><span class="asset-kind">${duration(track.durationSeconds)} · ${audio}</span></div>
    <div class="player"><video controls playsinline preload="none" poster="${posterUrl}" width="${track.width}" height="${track.height}" src="${videoUrl}" aria-label="${escapeHtml(release.episode.episode)}, ${escapeHtml(track.label)}" data-label-en="${escapeHtml(release.episode.episode)}, ${escapeHtml(track.label)}"><p>${both("Twoja przeglądarka nie odtworzy tego filmu.", "Your browser cannot play this video.")} <a href="${videoUrl}">${both("Otwórz plik MP4", "Open the MP4")}</a>.</p></video></div>
    <p class="media-error" role="status" hidden>${both("Nie udało się wczytać filmu. Skorzystaj z linku do MP4 poniżej albo odśwież stronę.", "The video could not load. Try the MP4 link below or reload the page.")}</p>
    <div class="asset-download"><a href="${videoUrl}" download>${both("Pobierz film", "Download video")}${forTrack}</a><span class="asset-meta">MP4 · ${track.width} × ${track.height} · ${megabytes(track.bytes)}</span></div>
    ${renderStillGroups(release, track)}
  </article>`;
}

function renderDocuments(release: Release, texts: ReleaseTexts): string {
  const translated = release.en?.documents ?? [];
  const entries = release.documents.map((document, index) => {
    const text = texts.documents.get(document.file) ?? "";
    const url = documentUrl(release.version, document.file);
    const description = translated[index]?.description ?? document.description;
    return `<article>
      <div class="document-heading"><h5>${escapeHtml(document.label)}</h5><span class="document-meta">${both(`etap ${document.stage}`, `stage ${document.stage}`)} · ${escapeHtml(document.file)} · ${(Buffer.byteLength(text) / 1000).toFixed(1)} KB</span></div>
      <p class="document-description">${both(document.description, description)}</p>
      <details><summary>${both("Przeczytaj", "Read")}<span class="sr-only">, ${escapeHtml(document.label)}</span></summary><div class="asset-download"><a href="${url}" download>${both("Pobierz Markdown", "Download Markdown")}<span class="sr-only">, ${escapeHtml(document.label)}</span></a></div><pre class="document-copy" lang="${escapeHtml(release.episode.language)}">${escapeHtml(text)}</pre></details>
    </article>`;
  });
  return `<section class="documents" aria-labelledby="documents-${release.version.replaceAll(".", "-")}">
    <h4 id="documents-${release.version.replaceAll(".", "-")}">${both("Dokumenty etapów", "Stage documents")}</h4>
    <p>${both("Tekstowa strona produkcji. Te pliki są wspólne dla obu torów — opisują historię, a nie obrazy.", "The production's text side. These files are shared by both tracks: they describe the story, not the pictures.")}</p>
    ${entries.join("")}</section>`;
}

export function renderRelease(release: Release, texts: ReleaseTexts): RenderedRelease {
  const anchor = `release-${release.version.replaceAll(".", "-")}`;
  const day = new Date(`${release.date}T12:00:00Z`);
  const en = release.en ?? {};
  const commitUrl = `${release.repository}/commit/${release.commit}`;
  const download = release.source.filename.endsWith(".md") ? "Markdown" : "TXT";
  const privateNote = release.repositoryPrivate
    ? ` ${both("· Repozytorium prywatne; wymagany dostęp.", "· Private repository; access required.")}`
    : "";
  const [first] = release.tracks;
  const length = first ? duration(first.durationSeconds) : "";

  const html = `<article class="release" id="${anchor}" aria-labelledby="${anchor}-title">
    <div class="release-rail"><a class="version" href="#${anchor}">v${escapeHtml(release.version)}</a><time class="release-date" datetime="${escapeHtml(release.date)}">${both(day.toLocaleDateString("pl-PL", DATE_OPTIONS), day.toLocaleDateString("en-GB", DATE_OPTIONS))}</time></div>
    <div class="release-content"><h3 id="${anchor}-title">${both(release.title, en.title ?? release.title)}</h3><p class="release-intro">${both(release.description, en.description ?? release.description)}</p>
      <p class="source-meta">${escapeHtml(release.episode.project)} · ${escapeHtml(release.episode.episode)} · ${escapeHtml(release.episode.aspectRatio)} · ${length} · ${escapeHtml(release.episode.language.toUpperCase())}</p>
      <details class="release-details"><summary>${both("Co zawiera to wydanie", "What’s in this release")}</summary><ul class="release-changes">${release.changes.map((change, index) => `<li>${both(change, en.changes?.[index] ?? change)}</li>`).join("")}</ul>
      <p class="release-note">${both(release.note, en.note ?? release.note)}<br>${both("Wersja kodu:", "Code baseline:")} <a href="${commitUrl}">commit ${release.commit.slice(0, 7)}</a>${privateNote}</p></details>
      <section class="source-document" aria-labelledby="${anchor}-source-title">
        <div class="source-heading"><h4 id="${anchor}-source-title">${both("Plik źródłowy odcinka", "Episode source file")}</h4><a href="${sourceUrl(release)}" download>${both(`Pobierz ${download}`, `Download ${download}`)}</a></div>
        <p class="source-meta">${escapeHtml(release.source.label)} · ${escapeHtml(release.source.language.toUpperCase())} · ${(texts.sourceBytes / 1000).toFixed(1)} KB</p><p class="source-description">${both(release.source.description, en.source?.description ?? release.source.description)}</p>
        <details><summary>${both("Przeczytaj plik źródłowy", "Read the source file")}</summary><pre class="source-copy" lang="${escapeHtml(release.source.language)}">${escapeHtml(texts.source)}</pre></details>
      </section>
      <fieldset class="track-gallery"><legend>${both("Obejrzyj film", "Watch the film")}</legend>
        <p class="gallery-note">${both("Jeden scenariusz, dwa tory obrazu, dwa filmy. Wybierz model, który je narysował.", "One screenplay, two image tracks, two films. Pick the model that drew one.")}</p>
        <div class="track-options">${release.tracks.map((track, index) => `<input class="sr-only" type="radio" name="track-${anchor}" id="choose-${anchor}-${escapeHtml(track.track)}" value="${escapeHtml(track.track)}"${index === 0 ? " checked" : ""}><label for="choose-${anchor}-${escapeHtml(track.track)}">${escapeHtml(track.label)}</label>`).join("")}</div>
        <div class="tracks">${release.tracks.map((track) => renderTrack(release, track)).join("\n")}</div></fieldset>
      ${renderDocuments(release, texts)}
    </div></article>`;

  const markdown = [
    `### ${release.version} · ${release.date}`,
    "",
    en.title ?? release.title,
    "",
    en.description ?? release.description,
    "",
    `Episode: ${release.episode.project} · ${release.episode.episode} · ${release.episode.aspectRatio} · ${length} · ${release.episode.language.toUpperCase()}.`,
    "",
    ...release.changes.map((change, index) => `- ${en.changes?.[index] ?? change}`),
    "",
    en.note ?? release.note,
    "",
    `Source baseline: [${release.commit.slice(0, 7)}](${commitUrl})${release.repositoryPrivate ? " (private repository; access required)" : ""}.`,
    "",
    `Episode source file: [${release.source.label}](${sourceUrl(release)}). ${en.source?.description ?? release.source.description}`,
    "",
    ...release.tracks.map(
      (track) =>
        `- ${track.label}: [Film](${mediaUrl(release.version, track.video)}) (${duration(track.durationSeconds)}, ${track.width} × ${track.height}, ${megabytes(track.bytes)}), ${track.stills.length} stills.`
    ),
    "",
    ...release.documents.map(
      (document, index) =>
        `- Stage ${document.stage} — ${document.label}: [${document.file}](${documentUrl(release.version, document.file)}). ${release.en?.documents?.[index]?.description ?? document.description}`
    ),
    "",
    `[View this release](/releases/${release.version}/)`,
    "",
  ];

  return { anchor, html, markdown, version: release.version };
}

/**
 * Real links: the picker works with the keyboard, with browser history and
 * with JavaScript disabled, because each release is its own address.
 */
export function renderPicker(pages: readonly RenderedRelease[], current: RenderedRelease): string {
  const latest = pages[0] === current ? ` ${both("· Najnowsza", "· Latest")}` : "";
  // `nav a` is inline-flex, and a flex container drops the whitespace between
  // its items. Each link therefore carries its whole label in one span per
  // language instead of leaning on a space next to them.
  const option = (version: string, first: boolean) =>
    first ? both(`v${version} · Najnowsza`, `v${version} · Latest`) : `v${escapeHtml(version)}`;
  const links = pages
    .map((page, position) => {
      const selected = page.version === current.version;
      const mark = selected
        ? `<span class="sr-only">${both(", wybrane", ", selected")}</span>`
        : "";
      return `<a href="/releases/${page.version}/#changelog"${selected ? ' aria-current="page"' : ""}>${option(page.version, position === 0)}${mark}</a>`;
    })
    .join("");
  return `<details class="release-picker"><summary>${both("Wersja", "Version")} <strong>v${escapeHtml(current.version)}</strong>${latest}</summary><nav aria-label="Wybierz wydanie" data-label-en="Choose a release">${links}</nav></details>`;
}

export function renderNotFound(): string {
  return `<!doctype html><html lang="pl" data-lang="pl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title data-en="Page not found · Auditmos">Nie znaleziono strony · Auditmos</title><link rel="stylesheet" href="/styles.css"><script src="/theme.js"></script><script src="/lang.js"></script><main class="wrap hero"><h1>${both("Nie znaleziono strony.", "Page not found.")}</h1><p>${both("Ten adres nie odpowiada żadnej stronie ani plikowi wydania.", "This address does not match a page or release asset.")}</p><a href="/">${both("Wróć do aimatora", "Return to aimator")}</a></main></html>`;
}
