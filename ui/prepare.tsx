import { type JSX, useCallback, useEffect, useMemo, useState } from "react";
import { INTENTS } from "../src/ui/commands.js";
import { Action, Block, Field, Problems, Said, useArtifactText, useOwnRun } from "./panel";
import type { EpisodeOverview, Refusal, RunDone, Stage0Report, StatusCell } from "./types";

/**
 * Stage 0, which is the one stage a person writes rather than buys.
 *
 * Its questions are asked at three levels, and each is answered where it
 * belongs rather than all in one panel: `NewProject` before there is a
 * project, `ProjectCast` (in `cast.tsx`) for what recurs across episodes, and
 * `NewEpisode` before there is an episode. What is left in the panel is what
 * belongs to an episode that exists: the rules and the source a person
 * approves by reading, the decisions as they stand, and the verdict.
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
  /** Where the project's cast is set; the address is the app's to know. */
  readonly castHref: string;
  /** The ladder's stage-0 cell, or nothing when the ladder itself was refused. */
  readonly cell: StatusCell | null;
  readonly episodeId: string;
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
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

/**
 * The project a workspace does not have yet, which is where everything starts.
 *
 * It is a screen of its own rather than a form inside stage 0's panel, because
 * that panel answers about a project and this one is asked before there is
 * one. What it hands back is the identifier it created, and only once the CLI
 * has said yes: the screen then moves into that project, and a refusal stays
 * here, under the form, in the terminal's words.
 */
export function NewProject(props: {
  readonly onCreated: (projectId: string) => void;
  readonly onRun: (argv: readonly string[]) => void;
  readonly run: RunDone | null;
  readonly running: boolean;
}): JSX.Element {
  const { onCreated, onRun, run, running } = props;
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [aspectRatio, setAspectRatio] = useState("");
  /**
   * The identifier that was actually sent, not the one in the field now.
   *
   * Somebody may edit the field while the command runs, and the project that
   * exists afterwards is the one the argv named.
   */
  const [submitted, setSubmitted] = useState<string | null>(null);
  const argv = useMemo(
    () => INTENTS.initProject({ aspectRatio, projectId, title }),
    [aspectRatio, projectId, title]
  );
  const submit = useCallback(
    (one: readonly string[]) => {
      setSubmitted(projectId);
      onRun(one);
    },
    [onRun, projectId]
  );

  useEffect(() => {
    if (submitted !== null && !running && run?.ok === true) {
      onCreated(submitted);
    }
  }, [onCreated, run, running, submitted]);

  return (
    <section aria-labelledby="new-project-title" className="panel">
      <h2 id="new-project-title">Nowy projekt</h2>
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
      <Action argv={argv} disabled={running} label="Załóż projekt" onRun={submit} primary />
    </section>
  );
}

/**
 * The six fields over the decisions they start from, and one setter per field.
 *
 * What somebody typed is kept apart from `base`, the decisions as the episode
 * holds them now, so a value changed in a terminal meanwhile still shows in
 * every field nobody here touched. `changed` is what a command should carry:
 * only the fields that differ from `base`, because a field sent unchanged is
 * a decision nobody made on this screen.
 */
function useSettings(base: Settings): {
  readonly change: Record<keyof Settings, (value: string) => void>;
  readonly changed: Settings;
  readonly dirty: boolean;
  readonly reset: () => void;
  readonly settings: Settings;
} {
  const [edits, setEdits] = useState<Partial<Settings>>({});
  const change = useMemo(
    () => ({
      audio: (audio: string) => setEdits((one) => ({ ...one, audio })),
      duration: (duration: string) => setEdits((one) => ({ ...one, duration })),
      language: (language: string) => setEdits((one) => ({ ...one, language })),
      maxClip: (maxClip: string) => setEdits((one) => ({ ...one, maxClip })),
      nature: (nature: string) => setEdits((one) => ({ ...one, nature })),
      subtitles: (subtitles: string) => setEdits((one) => ({ ...one, subtitles })),
    }),
    []
  );
  const reset = useCallback(() => setEdits({}), []);
  const settings = useMemo(() => ({ ...base, ...edits }), [base, edits]);
  const changed = useMemo(() => {
    const only = (key: keyof Settings): string =>
      settings[key] === base[key] ? "" : settings[key];

    return {
      audio: only("audio"),
      duration: only("duration"),
      language: only("language"),
      maxClip: only("maxClip"),
      nature: only("nature"),
      subtitles: only("subtitles"),
    };
  }, [base, settings]);
  const dirty = Object.values(changed).some((value) => value !== "");

  return { change, changed, dirty, reset, settings };
}

/**
 * `episode show`, asked again whenever `revision` moves.
 *
 * A failed read keeps the last answer rather than blanking it, for the reason
 * the cast screen does: an old answer is still the answer somebody was reading.
 */
function useEpisodeOverview(
  projectId: string,
  episodeId: string,
  revision: unknown
): EpisodeOverview | null {
  const [shown, setShown] = useState<EpisodeOverview | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/episode/${encodeURIComponent(projectId)}/${encodeURIComponent(episodeId)}`)
      .then(async (response) => (await response.json()) as EpisodeOverview | Refusal)
      .then((body) => {
        if (!(cancelled || "error" in body)) {
          setShown(body);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [episodeId, projectId, revision]);

  return shown;
}

/** A decision as the field holds it: the value as a string, undecided as empty. */
function asFields(settings: EpisodeOverview["settings"]): Settings {
  const text = (value: number | string | null): string => (value === null ? "" : String(value));

  return {
    audio: text(settings.audio),
    duration: text(settings.durationSeconds),
    language: text(settings.language),
    maxClip: text(settings.maxClipSeconds),
    nature: text(settings.sourceNature),
    subtitles: text(settings.subtitles),
  };
}

/** The names of the decisions, in the words the fields use. */
const DECISION_LABELS: Record<keyof EpisodeOverview["settings"], string> = {
  audio: "Dźwięk",
  durationSeconds: "Długość",
  language: "Język",
  maxClipSeconds: "Najdłuższy klip",
  sourceNature: "Rodzaj źródła",
  subtitles: "Napisy",
};

/** Which decisions nobody has made, named, in the order the fields stand. */
function undecided(settings: EpisodeOverview["settings"]): readonly string[] {
  return (Object.keys(DECISION_LABELS) as (keyof EpisodeOverview["settings"])[])
    .filter((key) => settings[key] === null)
    .map((key) => DECISION_LABELS[key]);
}

/**
 * The six decisions of an episode, as fields.
 *
 * One set of fields serves both actions, because they are one set of
 * decisions: `episode add` takes them for an episode that does not exist yet
 * and `episode set` takes the same six for one that does. A field left empty
 * is not spelled at all, so "zapisz" changes what was typed and leaves the
 * rest exactly as it was.
 */
function SettingsFields(props: {
  readonly change: Record<keyof Settings, (value: string) => void>;
  readonly settings: Settings;
}): JSX.Element {
  const { change, settings } = props;

  return (
    <div className="send">
      <Field
        id="episode-duration"
        label="Długość (s)"
        onValue={change.duration}
        placeholder="60"
        value={settings.duration}
      />
      <Field
        id="episode-audio"
        label="Dźwięk"
        onValue={change.audio}
        placeholder="narration"
        value={settings.audio}
      />
      <Field
        id="episode-language"
        label="Język"
        onValue={change.language}
        placeholder="pl"
        value={settings.language}
      />
      <Field
        id="episode-subtitles"
        label="Napisy"
        onValue={change.subtitles}
        placeholder="none"
        value={settings.subtitles}
      />
      <Field
        id="episode-nature"
        label="Rodzaj źródła"
        onValue={change.nature}
        placeholder="law-or-idea"
        value={settings.nature}
      />
      <Field
        id="episode-max-clip"
        label="Najdłuższy klip (s)"
        onValue={change.maxClip}
        placeholder="6"
        value={settings.maxClip}
      />
    </div>
  );
}

const SETTINGS_NOTE =
  "Pięć decyzji blokuje bramkę, --max-clip jest wymagany dopiero przez etap 3. Pole zostawione puste znaczy „nierozstrzygnięte”, nigdy zero.";

/**
 * The decisions of the episode on screen, as they stand, changed in place.
 *
 * The fields start from what `episode show` says the episode holds, so the
 * form is also the only place the decisions are read; a form of empty fields
 * over values nobody could see asked a person to retype what they could not
 * check. What somebody typed is cleared once the CLI has said yes to this
 * form's own command, because the episode then holds it and the fresh read
 * says so; a refusal leaves it as typed.
 */
function Episode(props: {
  readonly episodeId: string;
  readonly onRun: (argv: readonly string[]) => void;
  /** Open while stage 0 still wants something; folded once it has its yes. */
  readonly open: boolean;
  readonly overview: EpisodeOverview | null;
  readonly projectId: string;
  readonly run: RunDone | null;
  readonly running: boolean;
}): JSX.Element {
  const { episodeId, onRun, open, overview, projectId, run, running } = props;
  const base = useMemo(() => (overview === null ? EMPTY : asFields(overview.settings)), [overview]);
  const { change, changed, dirty, reset, settings } = useSettings(base);
  const set = useMemo(
    () => INTENTS.setEpisode({ ...changed, episodeId, projectId }),
    [changed, episodeId, projectId]
  );
  const submit = useOwnRun({ onRun, run, running, succeeded: reset });
  const missing = overview === null ? [] : undecided(overview.settings);

  return (
    <Block fold={open} hint={SETTINGS_NOTE} title="Decyzje odcinka">
      {overview === null ? (
        <p className="panel-empty">Czytam decyzje odcinka…</p>
      ) : (
        <p className="actions-note">
          {missing.length === 0
            ? "Wszystkie decyzje są podjęte. Zmień pole i zapisz, a zapisze się tylko ta zmiana."
            : `Nierozstrzygnięte: ${missing.join(", ")}.`}
        </p>
      )}
      <SettingsFields change={change} settings={settings} />
      <Action
        argv={set}
        disabled={running || !dirty}
        label="Zapisz decyzje odcinka"
        onRun={submit}
      />
    </Block>
  );
}

/**
 * An episode the project does not have yet: its source file and its six
 * decisions.
 *
 * It is a screen of its own, the way a new project is, because it is asked
 * before there is an episode to be in. The identifier comes from the source's
 * file name and the CLI is what reads it, so this screen does not guess: it
 * remembers which episodes the project had when the command was sent, and the
 * one that appears in the listing afterwards is the one it created.
 */
export function NewEpisode(props: {
  readonly episodes: readonly string[];
  readonly onCreated: (episodeId: string) => void;
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  readonly run: RunDone | null;
  readonly running: boolean;
}): JSX.Element {
  const { episodes, onCreated, onRun, projectId, run, running } = props;
  const [source, setSource] = useState("");
  const { change, settings } = useSettings(EMPTY);
  /** The episodes that existed when the command was sent, or null before. */
  const [known, setKnown] = useState<readonly string[] | null>(null);
  const add = useMemo(
    () => INTENTS.addEpisode({ ...settings, projectId, source }),
    [projectId, settings, source]
  );
  const submit = useCallback(
    (one: readonly string[]) => {
      setKnown(episodes);
      onRun(one);
    },
    [episodes, onRun]
  );

  useEffect(() => {
    if (known === null || running || run?.ok !== true) {
      return;
    }

    const fresh = episodes.find((one) => !known.includes(one));

    if (fresh !== undefined) {
      onCreated(fresh);
    }
  }, [episodes, known, onCreated, run, running]);

  return (
    <section aria-labelledby="new-episode-title" className="panel">
      <h2 id="new-episode-title">Nowy odcinek</h2>
      <p className="actions-note">
        Plik podaje się <strong>ścieżką</strong>, wklejoną z Findera; trafia do{" "}
        <code>--source</code> bez zmian, więc <code>episode.json</code> zapisuje prawdziwe
        pochodzenie pliku. Numer i identyfikator odcinka biorą się z jego nazwy (
        <code>NN-tytul.md</code>).
      </p>
      <div className="send">
        <Field
          id="episode-source"
          label="Ścieżka do pliku źródłowego"
          onValue={setSource}
          placeholder="/Users/ktos/Filmy/01-burza.md"
          value={source}
        />
      </div>
      <p className="actions-note">{SETTINGS_NOTE}</p>
      <SettingsFields change={change} settings={settings} />
      <Action argv={add} disabled={running} label="Dodaj odcinek" onRun={submit} primary />
    </section>
  );
}

export function PreparePanel(props: PrepareProps): JSX.Element {
  const { castHref, cell, episodeId, onRun, projectId, run, running } = props;
  const report = (cell?.status ?? null) as Stage0Report | null;
  const check = useMemo(() => INTENTS.checkPrepare({ projectId }), [projectId]);
  const approve = useMemo(() => INTENTS.approvePrepare({ projectId }), [projectId]);
  // `project.md` is written by hand, in an editor, so it can change while the
  // cell's state stands still. The cell is a fresh object on every push of the
  // ladder, which arrives whenever the workspace moves; with no ladder, the
  // last finished command is the only sign that anything did.
  const revision = cell ?? run;
  const rules = useArtifactText({ artifact: "rules", projectId, stage: "prepare" }, revision);
  const source = useArtifactText(
    { artifact: "source", episodeId, projectId, stage: "prepare" },
    revision
  );
  const overview = useEpisodeOverview(projectId, episodeId, revision);
  // The same condition the CLI records under. `problems` is deliberately not
  // part of it: stage 0 reports "no episode yet" and "the rules changed after
  // the last yes" without refusing, and both are things a person answers by
  // approving rather than reasons to hide the button.
  const acceptable = report?.ready === true && !report.approved;
  const lapsed = acceptable ? report.changedSinceApproval : [];
  const open = report?.approved !== true;

  return (
    <section aria-labelledby="prepare-title" className="panel">
      <h2 id="prepare-title">Etap 0: przygotowanie</h2>

      <Block title="Stan">
        {report === null ? (
          <p className="panel-empty">Ten etap nie odpowiedział; powód stoi wyżej.</p>
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
                <dd>
                  <Said text={report.nextStep} />
                </dd>
              </div>
            </dl>
            <Problems problems={report.problems} />
          </>
        )}
        <p className="actions-note">
          Obsada i narrator należą do projektu, nie do odcinka, więc ustawia się je na{" "}
          <a href={castHref}>ekranie obsady projektu</a>.
        </p>
      </Block>

      <Block fold={open} title="Zasady projektu">
        {rules === null ? (
          <p className="panel-empty">Nie ma jeszcze pliku project.md.</p>
        ) : (
          <pre className="artifact-text">{rules}</pre>
        )}
        <p className="actions-note">
          Jedyny plik tego narzędzia pisany ręcznie; zmienia się go w edytorze, a ten blok czyta go
          na nowo przy każdej zmianie w katalogu roboczym.
        </p>
      </Block>

      <Block fold={false} title="Źródło odcinka">
        {overview === null ? null : (
          <dl className="verdict">
            <div>
              <dt>Numer</dt>
              <dd>{overview.number}</dd>
            </div>
            <div>
              <dt>Skopiowane z</dt>
              <dd>
                <code>{overview.source.originPath}</code>
              </dd>
            </div>
          </dl>
        )}
        {source === null ? (
          <p className="panel-empty">Nie ma jeszcze pliku źródłowego.</p>
        ) : (
          <pre className="artifact-text">{source}</pre>
        )}
      </Block>

      <Episode
        episodeId={episodeId}
        onRun={onRun}
        open={open}
        overview={overview}
        projectId={projectId}
        run={run}
        running={running}
      />

      <Block className="block-decision" title="Decyzja">
        {lapsed.length > 0 ? (
          <p className="actions-note decision-why">
            Pliki się zgadzają, ale po akceptacji zmienił się{" "}
            {lapsed.map((path) => path.split("/").at(-1)).join(", ")}, więc wcześniejsza zgoda
            wygasła. Przeczytaj zasady jeszcze raz w bloku „Zasady projektu” i jeśli nadal się
            zgadzają, zatwierdź ponownie. Nic nie zostanie wygenerowane ani kupione.
          </p>
        ) : null}
        <Action argv={check} disabled={running} label="Sprawdź" onRun={onRun} />

        {acceptable ? (
          <Action argv={approve} disabled={running} label="Zatwierdź" onRun={onRun} primary />
        ) : (
          <p className="actions-note">
            „Zatwierdź” pojawia się dopiero, gdy <code>check</code> przepuszcza pliki, a nikt ich
            jeszcze nie przyjął. Tak samo odmówiłby terminal.
          </p>
        )}
      </Block>
    </section>
  );
}
