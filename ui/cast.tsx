import { type ChangeEvent, type JSX, useCallback, useEffect, useMemo, useState } from "react";
import { INTENTS } from "../src/ui/commands.js";
import { type ImportedCharacter, useImportedCharacters } from "./import";
import { Action, artifactUrl, Field, Lightbox, type Picture, useOwnRun, Zoomable } from "./panel";
import type { CastEntry, ProjectOverview, Refusal, RunDone } from "./types";

/**
 * The cast and the narrator, which belong to the project rather than to any
 * episode of it.
 *
 * Both recur between episodes, which is exactly why they live in
 * `project.json`, so they are set where the project is and not inside one
 * episode's stage-0 panel, where a fresh project could not reach them before
 * it had an episode.
 *
 * The screen is three sections because it answers three questions: who is in
 * the series and what each of them is drawn from, who reads it, and whether
 * stage 0 now holds. Each character is a card of its own with its own
 * actions, so adding a photograph is done on the character it belongs to
 * rather than by typing its identifier into a second form. A command's answer
 * appears in the dock at the bottom of the window, as on every other screen,
 * because an answer at the foot of a long page is an answer nobody sees.
 *
 * What is shown is `project show`, asked again whenever the workspace moves;
 * nothing here reads `project.json`.
 */

type Shown =
  | { readonly kind: "loading" }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "shown"; readonly overview: ProjectOverview };

/**
 * `project show`, asked again whenever the workspace moves.
 *
 * A failed read keeps the last answer rather than blanking it, for the reason
 * the ladder does: an old answer is still the answer somebody was reading.
 */
export function useProjectOverview(projectId: string, revision: object | null): Shown {
  const [shown, setShown] = useState<Shown>({ kind: "loading" });

  useEffect(() => {
    // Nothing to read against before the workspace has answered once.
    if (revision === null) {
      return;
    }

    let cancelled = false;

    fetch(`/api/project/${encodeURIComponent(projectId)}`)
      .then(async (response) => (await response.json()) as ProjectOverview | Refusal)
      .then((body) => {
        if (cancelled) {
          return;
        }

        setShown(
          "error" in body
            ? { kind: "refused", message: body.error.message }
            : { kind: "shown", overview: body }
        );
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [projectId, revision]);

  return shown;
}

/** Where one character is drawn from, in the words `project show` uses. */
function basisOf(entry: CastEntry): string {
  if (entry.basis === "photographs") {
    return `ze zdjęć (${entry.sources.length})`;
  }

  if (entry.basis === "design") {
    return `z projektu postaci (${entry.sources.length})`;
  }

  return entry.basis === "description" ? "z opisu w project.md" : "podstawa nierozstrzygnięta";
}

/**
 * The images a character is drawn from, as pictures rather than paths.
 *
 * Either basis is a decision about a look, and a list of file names asks a
 * person to approve a look they cannot see. Each is served by the resolver
 * under the name the command kept, opens on the whole window like every other
 * picture here, and keeps its name underneath, which is also what stands in
 * for an image the browser cannot show.
 *
 * They are in the order stage 2 attaches them, by recorded path, and the first
 * is marked: it is the primary one, the image that wins wherever the others
 * disagree, so which file sorts first is a decision worth seeing.
 */
function Sources(props: { readonly entry: CastEntry; readonly projectId: string }): JSX.Element {
  const { entry, projectId } = props;
  const [shown, setShown] = useState<string | null>(null);
  const pictures = useMemo<readonly Picture[]>(
    () =>
      [...entry.sources]
        .sort((left, right) => left.localeCompare(right))
        .map((path) => {
          const name = path.split("/").at(-1) ?? path;

          return {
            caption: entry.name,
            id: name,
            url: artifactUrl({
              artifact: name,
              characterId: entry.id,
              projectId,
              stage: "prepare",
            }),
          };
        }),
    [entry, projectId]
  );
  const primary = entry.basis === "design" ? "główny" : "główne";

  return (
    <>
      <ul className="cast-photos">
        {pictures.map((picture, index) => (
          <li key={picture.id}>
            <Zoomable id={picture.id} onShow={setShown}>
              <img alt={picture.id} height={112} loading="lazy" src={picture.url} width={112} />
            </Zoomable>
            <code title={picture.id}>{picture.id}</code>
            {index === 0 && pictures.length > 1 ? (
              <span className="cast-primary">{primary}</span>
            ) : null}
          </li>
        ))}
      </ul>
      <Lightbox onShow={setShown} pictures={pictures} shown={shown} />
    </>
  );
}

/** One member of the cast: who they are, what they are drawn from, and the three ways to decide it. */
function CharacterCard(props: {
  readonly entry: CastEntry;
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  readonly run: RunDone | null;
  readonly running: boolean;
}): JSX.Element {
  const { entry, onRun, projectId, run, running } = props;
  const [path, setPath] = useState("");
  const [replace, setReplace] = useState(false);
  const images = useMemo(
    () => ({ characterId: entry.id, projectId, replace, sources: [path] }),
    [entry.id, path, projectId, replace]
  );
  const design = useMemo(() => INTENTS.designCharacter(images), [images]);
  const photos = useMemo(() => INTENTS.addCharacterSources(images), [images]);
  // Once copied in, the images are shown above the field, and the path left
  // in it would only copy the same files again; a replacement left ticked
  // would make the next addition one too.
  const add = useOwnRun({
    onRun,
    run,
    running,
    succeeded: () => {
      setPath("");
      setReplace(false);
    },
  });
  const changeReplace = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setReplace(event.target.checked),
    []
  );
  const describe = useMemo(
    () => INTENTS.describeCharacter({ characterId: entry.id, projectId }),
    [entry.id, projectId]
  );

  return (
    <article aria-labelledby={`character-${entry.id}`} className="cast-card">
      <header className="cast-card-head">
        <h3 id={`character-${entry.id}`}>{entry.name}</h3>
        <code className="cast-id">{entry.id}</code>
        <span className={entry.basis === null ? "cast-basis cast-undecided" : "cast-basis"}>
          {basisOf(entry)}
        </span>
      </header>
      {entry.sources.length === 0 ? null : <Sources entry={entry} projectId={projectId} />}
      <div className="send">
        <Field
          id={`images-${entry.id}`}
          label="Ścieżka do pliku albo katalogu"
          onValue={setPath}
          placeholder={`/Users/ktos/Projekty/${entry.id}/`}
          value={path}
        />
        <label className="field-check" htmlFor={`replace-${entry.id}`}>
          <input
            checked={replace}
            id={`replace-${entry.id}`}
            onChange={changeReplace}
            type="checkbox"
          />
          Zastąp obecne obrazy
        </label>
      </div>
      <Action argv={design} disabled={running} label="Dodaj projekt postaci" onRun={add} />
      <Action argv={photos} disabled={running} label="Dodaj zdjęcie" onRun={add} />
      <Action argv={describe} disabled={running} label="Buduj z opisu" onRun={onRun} />
    </article>
  );
}

/**
 * One character a grouping found: the id is its file's name and stays so, the
 * name is the one its file writes. Only a name the file no longer writes is
 * asked for; another spelling is what "Dopisz postać" below is for.
 */
function ImportedRow(props: {
  readonly character: ImportedCharacter;
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  readonly running: boolean;
  /** Among several imports, which one found it. */
  readonly source: boolean;
}): JSX.Element {
  const { character, onRun, projectId, running, source } = props;
  const [name, setName] = useState(character.name ?? "");
  const add = useMemo(
    () => INTENTS.addCharacter({ characterId: character.characterId, name, projectId }),
    [character.characterId, name, projectId]
  );

  return (
    <li>
      <div className="cast-imported-who">
        {character.name === null ? (
          <Field
            id={`imported-${character.importId}-${character.characterId}`}
            label="Nazwa"
            onValue={setName}
            value={name}
          />
        ) : (
          <strong>{character.name}</strong>
        )}
        <code className="cast-id">{character.characterId}</code>
        {source ? <span className="cast-id">z importu {character.importId}</span> : null}
      </div>
      <Action argv={add} disabled={running} label="Dodaj do obsady" onRun={onRun} />
    </li>
  );
}

/**
 * The characters the grouped imports found, each one click from the cast.
 *
 * Being in a grouping is not being cast: a character seen once is a stage-5
 * reference rather than a member, so nothing is taken in wholesale and each is
 * added by its own button. Who is cast already is left out by id, which is
 * what `character new` would refuse on.
 */
function ImportedCast(props: {
  readonly cast: readonly CastEntry[];
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  readonly revision: object | null;
  readonly running: boolean;
}): JSX.Element | null {
  const { cast, onRun, projectId, revision, running } = props;
  const found = useImportedCharacters(revision);

  if (found.length === 0) {
    return null;
  }

  const left = found.filter(({ characterId }) => !cast.some(({ id }) => id === characterId));
  const several = new Set(found.map(({ importId }) => importId)).size > 1;

  return (
    <div className="cast-new">
      <h3>Z podziału importu</h3>
      <p className="actions-note">
        Do obsady trafia tylko postać, która wraca; widziana raz to referencja etapu 5. Imię jest
        przepisane z pliku podziału. Podstawę (projekt postaci, zdjęcia albo opis) wybierasz potem
        na karcie postaci. Obraz kilku postaci naraz nie jest podstawą żadnej z nich.
      </p>
      {left.length === 0 ? (
        <p className="panel-empty">Każda postać z podziału jest już w obsadzie.</p>
      ) : (
        <ul className="cast-imported">
          {left.map((character) => (
            <ImportedRow
              character={character}
              key={`${character.importId}/${character.characterId}`}
              onRun={onRun}
              projectId={projectId}
              running={running}
              source={several}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A character the project has not named yet.
 *
 * The fields empty themselves once the CLI has said yes, because the name
 * they still held was then a character that already exists, and sending it
 * again is only a refusal waiting to happen. A refusal leaves them as typed,
 * so the mistake can be corrected rather than retyped.
 */
function NewCharacter(props: {
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  readonly run: RunDone | null;
  readonly running: boolean;
}): JSX.Element {
  const { onRun, projectId, run, running } = props;
  const [characterId, setCharacterId] = useState("");
  const [name, setName] = useState("");
  const add = useMemo(
    () => INTENTS.addCharacter({ characterId, name, projectId }),
    [characterId, name, projectId]
  );
  const submit = useOwnRun({
    onRun,
    run,
    running,
    succeeded: () => {
      setCharacterId("");
      setName("");
    },
  });

  return (
    <div className="cast-new">
      <h3>Dopisz postać</h3>
      <div className="send">
        <Field
          id="new-character"
          label="Identyfikator postaci"
          onValue={setCharacterId}
          placeholder="ewa"
          value={characterId}
        />
        <Field
          id="new-character-name"
          label="Nazwa"
          onValue={setName}
          placeholder="Ewa"
          value={name}
        />
      </div>
      <Action argv={add} disabled={running} label="Dopisz postać" onRun={submit} />
    </div>
  );
}

/**
 * Who reads the series: the one field that changes it.
 *
 * It empties once the voice is cast, because the voice then stands above it
 * as "Obecny głos" and a second copy in the field reads as an unsaved change.
 */
function NarratorForm(props: {
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  readonly run: RunDone | null;
  readonly running: boolean;
}): JSX.Element {
  const { onRun, projectId, run, running } = props;
  const [voiceId, setVoiceId] = useState("");
  const argv = useMemo(() => INTENTS.castNarrator({ projectId, voiceId }), [projectId, voiceId]);
  const cast = useOwnRun({ onRun, run, running, succeeded: () => setVoiceId("") });

  return (
    <>
      <div className="send">
        <Field
          id="narrator-voice"
          label="Identyfikator głosu"
          onValue={setVoiceId}
          placeholder="21m00Tcm4TlvDq8ikWAM"
          value={voiceId}
        />
      </div>
      <Action argv={argv} disabled={running} label="Obsadź narratora" onRun={cast} />
    </>
  );
}

export function ProjectCast(props: {
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  /**
   * Changes whenever the workspace does. The workspace stream pushes a fresh
   * listing on every change under it, so a character added here, or by an
   * agent in a terminal, is re-read without this screen knowing which file
   * moved.
   */
  readonly revision: object | null;
  readonly run: RunDone | null;
  readonly running: boolean;
}): JSX.Element {
  const { onRun, projectId, revision, run, running } = props;
  const shown = useProjectOverview(projectId, revision);
  const check = useMemo(() => INTENTS.checkPrepare({ projectId }), [projectId]);
  const overview = shown.kind === "shown" ? shown.overview : null;

  return (
    <div className="sections">
      {shown.kind === "refused" ? (
        <p className="refusal" role="alert">
          {shown.message}
        </p>
      ) : null}

      <section aria-labelledby="cast-people" className="panel">
        <h2 id="cast-people">Postacie</h2>
        <p className="actions-note">
          Każda powracająca postać, nie tylko główna. Każda potrzebuje podstawy: projektu postaci
          (własnych obrazów już w stylu serii, które etap postaci odwzorowuje wiernie), zdjęć
          prawdziwej osoby (przenoszonych do stylu serii) albo opisu w <code>project.md</code>.
          Projekt i zdjęcia jednej postaci się nie mieszają; „Zastąp obecne obrazy” zamienia całą
          listę, także jeden rodzaj na drugi. Ścieżka może wskazać katalog: wchodzą obrazy PNG, JPEG
          i WebP leżące wprost w nim, według nazwy, a pierwszy z nich jest główny.
        </p>
        {shown.kind === "loading" ? <p className="panel-empty">Czytam projekt…</p> : null}
        {overview !== null && overview.cast.length === 0 ? (
          <p className="panel-empty">Obsada jest pusta: nikt jeszcze nie został wymieniony.</p>
        ) : null}
        {overview?.cast.map((entry) => (
          <div key={entry.id}>
            <CharacterCard
              entry={entry}
              onRun={onRun}
              projectId={projectId}
              run={run}
              running={running}
            />
          </div>
        ))}
        {overview === null ? null : (
          <ImportedCast
            cast={overview.cast}
            onRun={onRun}
            projectId={projectId}
            revision={revision}
            running={running}
          />
        )}
        <NewCharacter onRun={onRun} projectId={projectId} run={run} running={running} />
      </section>

      <section aria-labelledby="cast-narrator" className="panel">
        <h2 id="cast-narrator">Narrator</h2>
        <dl className="verdict">
          <div>
            <dt>Obecny głos</dt>
            <dd>{overview === null ? "…" : (overview.narratorVoiceId ?? "nieobsadzony")}</dd>
          </div>
        </dl>
        <p className="actions-note">
          Potrzebny tylko wtedy, gdy film ma narrację: bramkuje wyłącznie etap 9.
        </p>
        <NarratorForm onRun={onRun} projectId={projectId} run={run} running={running} />
      </section>

      <section aria-labelledby="cast-check" className="panel">
        <h2 id="cast-check">Sprawdzenie etapu 0</h2>
        <p className="actions-note">
          Czy obsada, zasady w <code>project.md</code> i reszta etapu 0 już się zgadzają.
        </p>
        <Action argv={check} disabled={running} label="Sprawdź etap 0" onRun={onRun} />
      </section>
    </div>
  );
}
