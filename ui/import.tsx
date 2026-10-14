import { type JSX, type SyntheticEvent, useCallback, useEffect, useMemo, useState } from "react";
import { INTENTS } from "../src/ui/commands.js";
import { stageName } from "./ladder";
import {
  Action,
  asCalls,
  Block,
  Field,
  Lightbox,
  NO_FLAGS,
  Notices,
  PaidCall,
  type Picture,
  plural,
  SendFields,
  type SendFlags,
  Zoomable,
} from "./panel";
import type { ImportListing, ImportOverview, Refusal, RunDone } from "./types";

/**
 * A Word document brought in before any project: the screen over `import`.
 *
 * An import sits beside the projects rather than inside one, and so does this
 * file: it is no stage, it has no cell on any ladder and nothing on it is
 * approved. What it shows is `import show`; what it does is `import add` and
 * the one paid `import group`, bought in the same two steps as every stage.
 * What the material becomes is stage 0's, so once a grouping is there the
 * next step is a new project, offered with the import's name and nothing more.
 */

/** One file of an import by what it is: `material`, `I01.png`, `character:miko`. */
function importUrl(importId: string, artifact: string): string {
  return `/api/import/${encodeURIComponent(importId)}/${encodeURIComponent(artifact)}`;
}

/** The block a purchase fills, named once: on the page and in the dock's button. */
const GROUPING = "Podział";

/** A picture beside its section's heading, cropped square: enough to tell two apart. */
const THUMB = 48;

/** The box a gallery picture holds before its bytes arrive and say their ratio. */
const PLACEHOLDER = 384;

/** The name the resolver serves a picture under: its file name, `I01.png`. */
function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * One answer of the server, asked again whenever `revision` moves.
 *
 * A failed read keeps the last answer rather than blanking it, for the reason
 * the cast screen does: an old answer is still the one somebody was reading.
 */
function useAnswer<Answer>(url: string, revision: unknown): Answer | Refusal | null {
  const [answer, setAnswer] = useState<Answer | Refusal | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch(url)
      .then(async (response) => (await response.json()) as Answer | Refusal)
      .then((body) => {
        if (!cancelled) {
          setAnswer(body);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [revision, url]);

  return answer;
}

/** `import list`, re-read whenever the workspace moves. */
export function useImports(revision: unknown): ImportListing | Refusal | null {
  return useAnswer<ImportListing>("/api/imports", revision);
}

/** The text of one file of an import, or nothing while there is none to show. */
function useImportText(importId: string, artifact: string, revision: unknown): string | null {
  const [text, setText] = useState<string | null>(null);
  const url = importUrl(importId, artifact);

  useEffect(() => {
    let cancelled = false;

    fetch(url)
      .then(async (response) => (response.ok ? await response.text() : null))
      .then((body) => {
        if (!cancelled) {
          setText(body);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [revision, url]);

  return text;
}

/**
 * The document a workspace does not hold yet, which is where an import starts.
 *
 * A path in a text field rather than an upload, for stage 0's reason: the
 * server takes no files from the browser, the CLI copies the document itself
 * and records where it came from. It hands back the identifier it created once
 * the CLI has said yes, and a refusal keeps the form as typed, its words in the dock.
 */
export function NewImport(props: {
  readonly onCreated: (importId: string) => void;
  readonly onRun: (argv: readonly string[]) => void;
  readonly run: RunDone | null;
  readonly running: boolean;
}): JSX.Element {
  const { onCreated, onRun, run, running } = props;
  const [importId, setImportId] = useState("");
  const [source, setSource] = useState("");
  /** The identifier that was sent, not the one in the field now; see `NewProject`. */
  const [submitted, setSubmitted] = useState<string | null>(null);
  const argv = useMemo(() => INTENTS.addImport({ importId, source }), [importId, source]);
  const submit = useCallback(
    (one: readonly string[]) => {
      setSubmitted(importId);
      onRun(one);
    },
    [importId, onRun]
  );

  useEffect(() => {
    if (submitted !== null && !running && run?.ok === true) {
      onCreated(submitted);
    }
  }, [onCreated, run, running, submitted]);

  return (
    <section aria-labelledby="new-import-title" className="panel">
      <h2 id="new-import-title">Nowy import</h2>
      <p className="actions-note">
        Kopiuje dokument Worda do <code>imports/&lt;id&gt;/</code> i zamienia go na{" "}
        <code>material.md</code>, a obrazy na <code>images/I01.png</code>… Za darmo i bez modelu.
        Import się nie nadpisuje: nowa próba to nowy identyfikator.
      </p>
      <div className="send">
        <Field
          id="import-id"
          label="Identyfikator"
          onValue={setImportId}
          placeholder="miko"
          value={importId}
        />
        <Field
          id="import-source"
          label="Dokument .docx (pełna ścieżka)"
          onValue={setSource}
          placeholder="/Users/ja/Documents/treatment.docx"
          value={source}
        />
      </div>
      <Action argv={argv} disabled={running} label="Importuj" onRun={submit} primary />
    </section>
  );
}

/** A section's heading the way `material.md` spells it, or where it stands. */
function headingOf(section: ImportOverview["sections"][number]): string {
  return section.title === null
    ? "(przed pierwszym nagłówkiem)"
    : `${"#".repeat(section.level)} ${section.title}`;
}

/**
 * The material as the CLI counts it: every section, how much it holds, and
 * the pictures it shows, small enough to tell one from another.
 */
function Sections(props: {
  readonly importId: string;
  readonly onShow: (id: string) => void;
  readonly report: ImportOverview;
}): JSX.Element {
  const { importId, onShow, report } = props;
  const files = new Map(report.images.map((one) => [one.id, fileName(one.path)]));

  return (
    <ol className="import-sections">
      {report.sections.map((section) => (
        <li key={section.id}>
          <code className="import-id">{section.id}</code>
          <span className="import-heading">{headingOf(section)}</span>
          <span className="import-size">{section.characters} zn.</span>
          {section.images.length === 0 ? null : (
            <span className="import-thumbs">
              {section.images.map((id) => (
                <Zoomable id={id} key={id} onShow={onShow}>
                  <img
                    alt={id}
                    height={THUMB}
                    loading="lazy"
                    src={importUrl(importId, files.get(id) ?? id)}
                    width={THUMB}
                  />
                </Zoomable>
              ))}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * One file of the grouping, read when somebody opens it.
 *
 * Lazily, because a grouping is a dozen files and nobody reads all of them at
 * once; the text is re-read on every opening, so a hand edit made in an
 * editor meanwhile is what shows.
 */
function GroupedFile(props: {
  readonly destination: string;
  readonly importId: string;
  readonly path: string;
}): JSX.Element {
  const { destination, importId, path } = props;
  const [opened, setOpened] = useState(0);
  const toggle = useCallback((event: SyntheticEvent<HTMLDetailsElement>) => {
    if (event.currentTarget.open) {
      setOpened((count) => count + 1);
    }
  }, []);

  return (
    <details className="grouped-file" onToggle={toggle}>
      <summary>
        <code>{destination}</code> <span className="grouped-path">{path}</span>
      </summary>
      {opened === 0 ? null : (
        <GroupedText destination={destination} importId={importId} opened={opened} />
      )}
    </details>
  );
}

function GroupedText(props: {
  readonly destination: string;
  readonly importId: string;
  readonly opened: number;
}): JSX.Element {
  const text = useImportText(props.importId, props.destination, props.opened);

  return text === null ? (
    <p className="panel-empty">Czytam plik…</p>
  ) : (
    <pre className="artifact-text">{text}</pre>
  );
}

/**
 * One import: where it stands, what it holds, and the one purchase it offers.
 *
 * Read in the order the CLI says it: the next step first, then the material,
 * its pictures and the grouping, and buying last, because by the time anybody
 * pays for a grouping they should have read what it will divide.
 */
export function ImportPanel(props: {
  readonly importId: string;
  /** Where a project starts from this import; the address is the app's to know. */
  readonly newProjectHref: string;
  readonly onRun: (argv: readonly string[]) => void;
  /** Whatever moves when the workspace does; the import is re-read on it. */
  readonly revision: unknown;
  readonly run: RunDone | null;
  readonly running: boolean;
}): JSX.Element {
  const { importId, newProjectHref, onRun, revision, run, running } = props;
  const answer = useAnswer<ImportOverview>(`/api/import/${encodeURIComponent(importId)}`, revision);
  const material = useImportText(importId, "material", revision);
  const [flags, setFlags] = useState<SendFlags>(NO_FLAGS);
  const [shown, setShown] = useState<string | null>(null);
  /** Grows each time the dock sends somebody to the grouping a purchase wrote. */
  const [revealed, setRevealed] = useState(0);
  const result = useMemo(
    () => ({ reveal: () => setRevealed((count) => count + 1), title: GROUPING }),
    []
  );
  const preview = useMemo(
    () =>
      INTENTS.previewGrouping({
        importId,
        instruction: flags.instruction,
        maxOutputTokens: flags.tokens,
        model: flags.model,
        regenerate: flags.regenerate,
      }),
    [flags, importId]
  );
  /** The argv of the last command this panel started, whatever it was. */
  const [sent, setSent] = useState<readonly string[] | null>(null);
  const startRun = useCallback(
    (argv: readonly string[]) => {
      setSent(argv);
      onRun(argv);
    },
    [onRun]
  );
  const report = answer === null || "error" in answer ? null : answer;
  const pictures = useMemo(
    () =>
      (report?.images ?? []).map(
        (one): Picture => ({
          caption:
            one.sections.length === 0 ? one.part : `${one.part} · w ${one.sections.join(", ")}`,
          id: one.id,
          url: importUrl(importId, fileName(one.path)),
        })
      ),
    [importId, report]
  );

  if (answer === null) {
    return <p className="empty">Czytam import…</p>;
  }

  if (report === null) {
    return (
      <p className="refusal" role="alert">
        {"error" in answer ? answer.error.message : ""}
      </p>
    );
  }

  return (
    <div className="stage-body">
      {report.grouped.length === 0 ? (
        <div className="next-card">
          <p className="next-label">Następny krok</p>
          <p className="next-what">{report.nextStep}</p>
        </div>
      ) : (
        <div className="next-card">
          <p className="next-label">Następny krok</p>
          <p className="next-what">
            <span className="next-stage">Etap 0</span> {stageName(0)}
          </p>
          <a className="action action-primary next-go" href={newProjectHref}>
            Załóż projekt z tego materiału
          </a>
          <p className="next-terminal">W terminalu: {report.nextStep}</p>
        </div>
      )}

      <Block title="Materiał">
        <dl className="verdict">
          <div>
            <dt>Dokument</dt>
            <dd>{report.originPath}</dd>
          </div>
          <div>
            <dt>Plik</dt>
            <dd>{report.material}</dd>
          </div>
          <div>
            <dt>Zawartość</dt>
            <dd>
              {plural(report.sections.length, ["sekcja", "sekcje", "sekcji"])},{" "}
              {plural(report.images.length, ["obraz", "obrazy", "obrazów"])}
            </dd>
          </div>
        </dl>
        <Notices notices={report.notices} />
        <Sections importId={importId} onShow={setShown} report={report} />
      </Block>

      <Block fold={false} title="Treść materiału">
        {material === null ? (
          <p className="panel-empty">Nie ma pliku materiału.</p>
        ) : (
          <pre className="artifact-text">{material}</pre>
        )}
      </Block>

      {report.images.length === 0 ? null : (
        <Block title="Obrazy">
          <ul className="pictures">
            {report.images.map((one) => (
              <li className="picture" key={one.id}>
                <p className="picture-name">
                  <code>{one.id}</code>
                </p>
                <Zoomable id={one.id} onShow={setShown}>
                  {/* Square until it loads: the import records no size, and
                      `height: auto` hands the picture its own ratio after. */}
                  <img
                    alt={one.id}
                    height={PLACEHOLDER}
                    loading="lazy"
                    src={importUrl(importId, fileName(one.path))}
                    width={PLACEHOLDER}
                  />
                </Zoomable>
                <p className="picture-state">
                  {one.part} ·{" "}
                  {one.sections.length === 0
                    ? "nie stoi w żadnej sekcji"
                    : `w ${one.sections.join(", ")}`}
                </p>
              </li>
            ))}
          </ul>
        </Block>
      )}

      <Block reveal={revealed} title={GROUPING}>
        {report.grouped.length === 0 ? (
          <p className="panel-empty">
            Materiał nie jest jeszcze podzielony. Podział kupuje się niżej, w „Generowanie
            (płatne)”.
          </p>
        ) : (
          <div className="grouped">
            {report.grouped.map((one) => (
              <GroupedFile
                destination={one.destination}
                importId={importId}
                key={one.destination}
                path={one.path}
              />
            ))}
          </div>
        )}
      </Block>

      <PaidCall
        note="Podział kupuje dokładnie jedno wywołanie tekstowe. „Generuj” niczego nie wysyła i nie czyta klucza: pokazuje cały prompt i rachunek. Model czyta tylko tekst sekcji, bez obrazów, i mówi tylko, dokąd idzie każda z nich; pliki podziału to te sekcje skopiowane dosłownie, a obraz idzie z sekcją, w której stoi. Nikt podziału nie zatwierdza: to propozycja dla /prepare-project."
        onRun={startRun}
        open={report.grouped.length === 0}
        preview={preview}
        projectRun={run}
        read={asCalls}
        result={result}
        running={running}
        sent={sent}
      >
        <SendFields
          id="import-send"
          instructionHint="Uwaga poprawia opublikowany podział, zamiast dzielić od zera: model dostaje ten sam prompt, poprzedni podział i uwagę dosłownie. Puste pole to nowy podział od zera. W obu przypadkach to nowa płatna próba."
          modelPlaceholder="AIMATOR_IMPORT_MODEL"
          onChange={setFlags}
          tokensPlaceholder="12000"
          value={flags}
        />
      </PaidCall>

      <Lightbox onShow={setShown} pictures={pictures} shown={shown} />
    </div>
  );
}
