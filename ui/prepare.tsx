import { type JSX, useMemo, useState } from "react";
import { INTENTS } from "../src/ui/commands.js";
import { Action, Field, Problems, RunOutput } from "./panel";
import type { RunDone, Stage0Report, StatusCell } from "./types";

/**
 * Stage 0, which is the one stage a person writes rather than buys.
 *
 * It is also the only panel that has to exist **before** there is anything to
 * show: a workspace with no project in it has no ladder, so the first form
 * here stands on its own and every other one appears once a project does. That
 * is not a special case bolted on, it is what stage 0 is: the place an empty
 * directory becomes a series.
 *
 * The file field is a **path**, typed or pasted out of Finder, and it travels
 * to `--source` exactly as it was written. The PRD refused an upload for one
 * reason and it is recorded in `episode.json`: the archive stores where a file
 * came from, and bytes handed over by a browser would have made that a
 * temporary directory, turning "skąd to jest" into a question with no answer.
 *
 * Nothing here decides anything. The verdict is the report the ladder carried,
 * the refusals are the CLI's own sentences, and "Zatwierdź" appears under the
 * same condition the CLI records under: files that hold together, and nobody
 * having said yes to them yet.
 */

interface PrepareProps {
  /** The ladder's stage-0 cell, or nothing at all in an empty workspace. */
  readonly cell: StatusCell | null;
  readonly episodeId: string | null;
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string | null;
  readonly run: RunDone | null;
  readonly running: boolean;
}

/** The six decisions of an episode, held as the strings somebody typed. */
interface Settings {
  readonly audio: string;
  readonly duration: string;
  readonly language: string;
  readonly maxClip: string;
  readonly nature: string;
  readonly subtitles: string;
}

const EMPTY: Settings = {
  audio: "",
  duration: "",
  language: "",
  maxClip: "",
  nature: "",
  subtitles: "",
};

/** The project a workspace does not have yet, which is where everything starts. */
function NewProject(props: {
  readonly onRun: (argv: readonly string[]) => void;
  readonly running: boolean;
}): JSX.Element {
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [aspectRatio, setAspectRatio] = useState("");
  const argv = useMemo(
    () => INTENTS.initProject({ aspectRatio, projectId, title }),
    [aspectRatio, projectId, title]
  );

  return (
    // Addressable, because the picker's "+ Nowy projekt" opens the whole
    // stage-0 panel and this is the form it meant.
    <div id="prepare-new-project">
      <h3>Nowy projekt</h3>
      <p className="actions-note">
        Zakłada katalog serii i szkielet <code>project.md</code>. Zasady wspólne uzupełnia się potem
        w tym pliku ręcznie: to jedyny artefakt tego narzędzia pisany przez człowieka.
      </p>
      <div className="send">
        <Field
          id="prepare-project"
          label="Identyfikator"
          onValue={setProjectId}
          placeholder="dzielna-ewa"
          value={projectId}
        />
        <Field
          id="prepare-title"
          label="Tytuł"
          onValue={setTitle}
          placeholder="Dzielna Ewa"
          value={title}
        />
        <Field
          id="prepare-ratio"
          label="Proporcje"
          onValue={setAspectRatio}
          placeholder="16:9"
          value={aspectRatio}
        />
      </div>
      <Action argv={argv} disabled={props.running} label="Załóż projekt" onRun={props.onRun} />
    </div>
  );
}

/** The cast, one entry at a time, each with a basis of its own. */
function Cast(props: {
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  readonly running: boolean;
}): JSX.Element {
  const { onRun, projectId, running } = props;
  const [characterId, setCharacterId] = useState("");
  const [name, setName] = useState("");
  const [photo, setPhoto] = useState("");
  const add = useMemo(
    () => INTENTS.addCharacter({ characterId, name, projectId }),
    [characterId, name, projectId]
  );
  const sources = useMemo(
    () => INTENTS.addCharacterSources({ characterId, projectId, sources: [photo] }),
    [characterId, photo, projectId]
  );
  const describe = useMemo(
    () => INTENTS.describeCharacter({ characterId, projectId }),
    [characterId, projectId]
  );

  return (
    <>
      <h3>Obsada</h3>
      <p className="actions-note">
        Obsada jest decyzją, nie wnioskiem: wymień każdą powracającą postać. Twarz widziana raz to
        referencja etapu 5, nie postać. Każda ma własną podstawę, zdjęcia albo opis w{" "}
        <code>project.md</code>, bo pusty katalog na zdjęcia nie odróżnia „świadomie bez zdjęć” od
        „jeszcze nie dodałem”.
      </p>
      <div className="send">
        <Field
          id="prepare-character"
          label="Identyfikator postaci"
          onValue={setCharacterId}
          placeholder="ewa"
          value={characterId}
        />
        <Field id="prepare-name" label="Nazwa" onValue={setName} placeholder="Ewa" value={name} />
      </div>
      <Action argv={add} disabled={running} label="Dopisz postać" onRun={onRun} />

      <div className="send">
        <Field
          id="prepare-photo"
          label="Ścieżka do zdjęcia"
          onValue={setPhoto}
          placeholder="/Users/ktos/Zdjecia/ewa.png"
          value={photo}
        />
      </div>
      <Action argv={sources} disabled={running} label="Dodaj zdjęcie" onRun={onRun} />
      <Action argv={describe} disabled={running} label="Buduj z opisu" onRun={onRun} />
    </>
  );
}

/** Who reads the series, which is casting and recurs between episodes. */
function Narrator(props: {
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  readonly running: boolean;
}): JSX.Element {
  const [voiceId, setVoiceId] = useState("");
  const argv = useMemo(
    () => INTENTS.castNarrator({ projectId: props.projectId, voiceId }),
    [props.projectId, voiceId]
  );

  return (
    <>
      <h3>Narrator</h3>
      <p className="actions-note">
        Głos jest obsadą, nie konfiguracją: powraca między odcinkami, więc mieszka w{" "}
        <code>project.json</code> obok postaci. Bramkuje wyłącznie etap 9; film bez narracji nigdy
        nie musi tej decyzji podejmować.
      </p>
      <div className="send">
        <Field
          id="prepare-voice"
          label="Identyfikator głosu"
          onValue={setVoiceId}
          placeholder="21m00Tcm4TlvDq8ikWAM"
          value={voiceId}
        />
      </div>
      <Action argv={argv} disabled={props.running} label="Obsadź narratora" onRun={props.onRun} />
    </>
  );
}

/**
 * The episode: its source file, and the six decisions it carries.
 *
 * One set of fields serves both actions, because they are one set of
 * decisions: `episode add` takes them for an episode that does not exist yet
 * and `episode set` takes the same six for one that does. A field left empty
 * is not spelled at all, so "zapisz" changes what was typed and leaves the
 * rest exactly as it was.
 */
function Episode(props: {
  readonly episodeId: string | null;
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  readonly running: boolean;
}): JSX.Element {
  const { episodeId, onRun, projectId, running } = props;
  const [source, setSource] = useState("");
  const [settings, setSettings] = useState<Settings>(EMPTY);
  const change = useMemo(
    () => ({
      audio: (audio: string) => setSettings((one) => ({ ...one, audio })),
      duration: (duration: string) => setSettings((one) => ({ ...one, duration })),
      language: (language: string) => setSettings((one) => ({ ...one, language })),
      maxClip: (maxClip: string) => setSettings((one) => ({ ...one, maxClip })),
      nature: (nature: string) => setSettings((one) => ({ ...one, nature })),
      subtitles: (subtitles: string) => setSettings((one) => ({ ...one, subtitles })),
    }),
    []
  );
  const add = useMemo(
    () => INTENTS.addEpisode({ ...settings, projectId, source }),
    [projectId, settings, source]
  );
  const set = useMemo(
    () => INTENTS.setEpisode({ ...settings, episodeId: episodeId ?? "", projectId }),
    [episodeId, projectId, settings]
  );

  return (
    <div id="prepare-episode">
      <h3>Odcinek</h3>
      <p className="actions-note">
        Plik podaje się <strong>ścieżką</strong>, wklejoną z Findera; trafia do{" "}
        <code>--source</code> bez zmian, więc <code>episode.json</code> zapisuje prawdziwe
        pochodzenie pliku. Numer i identyfikator odcinka biorą się z jego nazwy (
        <code>NN-tytul.md</code>). Pięć decyzji blokuje bramkę, <code>--max-clip</code> jest
        wymagany dopiero przez etap 3. Pole zostawione puste znaczy „nierozstrzygnięte”, nigdy zero.
      </p>
      <div className="send">
        <Field
          id="prepare-source"
          label="Ścieżka do pliku źródłowego"
          onValue={setSource}
          placeholder="/Users/ktos/Filmy/01-burza.md"
          value={source}
        />
      </div>
      <div className="send">
        <Field
          id="prepare-duration"
          label="Długość (s)"
          onValue={change.duration}
          placeholder="60"
          value={settings.duration}
        />
        <Field
          id="prepare-audio"
          label="Dźwięk"
          onValue={change.audio}
          placeholder="narration"
          value={settings.audio}
        />
        <Field
          id="prepare-language"
          label="Język"
          onValue={change.language}
          placeholder="pl"
          value={settings.language}
        />
        <Field
          id="prepare-subtitles"
          label="Napisy"
          onValue={change.subtitles}
          placeholder="none"
          value={settings.subtitles}
        />
        <Field
          id="prepare-nature"
          label="Rodzaj źródła"
          onValue={change.nature}
          placeholder="law-or-idea"
          value={settings.nature}
        />
        <Field
          id="prepare-max-clip"
          label="Najdłuższy klip (s)"
          onValue={change.maxClip}
          placeholder="6"
          value={settings.maxClip}
        />
      </div>
      <Action argv={add} disabled={running} label="Dodaj odcinek" onRun={onRun} />
      {episodeId === null ? null : (
        <Action argv={set} disabled={running} label="Zapisz decyzje odcinka" onRun={onRun} />
      )}
    </div>
  );
}

export function PreparePanel(props: PrepareProps): JSX.Element {
  const { cell, episodeId, onRun, projectId, run, running } = props;
  const report = (cell?.status ?? null) as Stage0Report | null;
  const check = useMemo(
    () => (projectId === null ? null : INTENTS.checkPrepare({ projectId })),
    [projectId]
  );
  const approve = useMemo(
    () => (projectId === null ? null : INTENTS.approvePrepare({ projectId })),
    [projectId]
  );
  // The same condition the CLI records under. `problems` is deliberately not
  // part of it: stage 0 reports "no episode yet" and "the rules changed after
  // the last yes" without refusing, and both are things a person answers by
  // approving rather than reasons to hide the button.
  const acceptable = report?.ready === true && !report.approved;

  return (
    <section aria-labelledby="prepare-title" className="panel">
      <h2 id="prepare-title">Etap 0: przygotowanie</h2>

      {projectId === null ? (
        <p className="panel-empty">
          W katalogu roboczym nie ma jeszcze projektu. Zacznij od założenia go; reszta etapu 0
          pojawi się razem z nim.
        </p>
      ) : (
        <>
          {report === null ? (
            <p className="panel-empty">Ten etap nie odpowiedział; drabina pokazuje powód.</p>
          ) : (
            <>
              <dl className="verdict">
                <div>
                  <dt>Pliki się zgadzają</dt>
                  <dd>{report.ready ? "tak" : "nie"}</dd>
                </div>
                <div>
                  <dt>Zatwierdzony</dt>
                  <dd>{report.approved ? "tak" : "nie"}</dd>
                </div>
                <div>
                  <dt>Dalej</dt>
                  <dd>{report.nextStep}</dd>
                </div>
              </dl>
              <Problems problems={report.problems} />
            </>
          )}

          {check === null ? null : (
            <Action argv={check} disabled={running} label="Sprawdź" onRun={onRun} />
          )}

          {acceptable && approve !== null ? (
            <Action argv={approve} disabled={running} label="Zatwierdź" onRun={onRun} primary />
          ) : (
            <p className="actions-note">
              „Zatwierdź” pojawia się dopiero, gdy <code>check</code> przepuszcza pliki, a nikt ich
              jeszcze nie przyjął. Tak samo odmówiłby terminal.
            </p>
          )}
        </>
      )}

      <NewProject onRun={onRun} running={running} />

      {projectId === null ? null : (
        <>
          <Cast onRun={onRun} projectId={projectId} running={running} />
          <Narrator onRun={onRun} projectId={projectId} running={running} />
          <Episode episodeId={episodeId} onRun={onRun} projectId={projectId} running={running} />
        </>
      )}

      <RunOutput run={run} running={running} />
    </section>
  );
}
