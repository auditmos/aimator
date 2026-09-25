import { type JSX, useCallback, useEffect, useMemo, useState } from "react";
import { INTENTS } from "../src/ui/commands.js";
import { Action, Field, RunOutput } from "./panel";
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
 * appears in the section that started it, because an answer at the foot of a
 * long page is an answer nobody sees.
 *
 * What is shown is `project show`, asked again whenever the workspace moves;
 * nothing here reads `project.json`.
 */

/** Which part of the screen started the last command, so its answer lands there. */
type Origin = "check" | "narrator" | "new-character" | `character:${string}`;

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
function useProjectOverview(projectId: string, revision: object | null): Shown {
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

  return entry.basis === "description" ? "z opisu w project.md" : "podstawa nierozstrzygnięta";
}

/** A command's answer, shown only in the section that asked for it. */
function Answer(props: {
  readonly here: boolean;
  readonly run: RunDone | null;
  readonly running: boolean;
}): JSX.Element | null {
  return props.here ? <RunOutput run={props.run} running={props.running} /> : null;
}

/** One member of the cast: who they are, what they are drawn from, and the two ways to decide it. */
function CharacterCard(props: {
  readonly entry: CastEntry;
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  readonly running: boolean;
}): JSX.Element {
  const { entry, onRun, projectId, running } = props;
  const [photo, setPhoto] = useState("");
  const sources = useMemo(
    () => INTENTS.addCharacterSources({ characterId: entry.id, projectId, sources: [photo] }),
    [entry.id, photo, projectId]
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
      {entry.sources.length === 0 ? null : (
        <ul className="cast-sources">
          {entry.sources.map((path) => (
            <li key={path}>
              <code>{path}</code>
            </li>
          ))}
        </ul>
      )}
      <div className="send">
        <Field
          id={`photo-${entry.id}`}
          label="Ścieżka do zdjęcia"
          onValue={setPhoto}
          placeholder={`/Users/ktos/Zdjecia/${entry.id}.png`}
          value={photo}
        />
      </div>
      <Action argv={sources} disabled={running} label="Dodaj zdjęcie" onRun={onRun} />
      <Action argv={describe} disabled={running} label="Buduj z opisu" onRun={onRun} />
    </article>
  );
}

/** A character the project has not named yet. */
function NewCharacter(props: {
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  readonly running: boolean;
}): JSX.Element {
  const { onRun, projectId, running } = props;
  const [characterId, setCharacterId] = useState("");
  const [name, setName] = useState("");
  const add = useMemo(
    () => INTENTS.addCharacter({ characterId, name, projectId }),
    [characterId, name, projectId]
  );

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
      <Action argv={add} disabled={running} label="Dopisz postać" onRun={onRun} />
    </div>
  );
}

/** Who reads the series: the voice now, and the one field that changes it. */
function NarratorForm(props: {
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  readonly running: boolean;
}): JSX.Element {
  const { onRun, projectId, running } = props;
  const [voiceId, setVoiceId] = useState("");
  const argv = useMemo(() => INTENTS.castNarrator({ projectId, voiceId }), [projectId, voiceId]);

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
      <Action argv={argv} disabled={running} label="Obsadź narratora" onRun={onRun} />
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
  const [origin, setOrigin] = useState<Origin | null>(null);
  const from = useCallback(
    (where: Origin) => (argv: readonly string[]) => {
      setOrigin(where);
      onRun(argv);
    },
    [onRun]
  );
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
          Każda powracająca postać, nie tylko główna. Każda potrzebuje podstawy: zdjęć albo opisu w{" "}
          <code>project.md</code>.
        </p>
        {shown.kind === "loading" ? <p className="panel-empty">Czytam projekt…</p> : null}
        {overview !== null && overview.cast.length === 0 ? (
          <p className="panel-empty">Obsada jest pusta: nikt jeszcze nie został wymieniony.</p>
        ) : null}
        {overview?.cast.map((entry) => (
          <div key={entry.id}>
            <CharacterCard
              entry={entry}
              onRun={from(`character:${entry.id}`)}
              projectId={projectId}
              running={running}
            />
            <Answer here={origin === `character:${entry.id}`} run={run} running={running} />
          </div>
        ))}
        <NewCharacter onRun={from("new-character")} projectId={projectId} running={running} />
        <Answer here={origin === "new-character"} run={run} running={running} />
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
        <NarratorForm onRun={from("narrator")} projectId={projectId} running={running} />
        <Answer here={origin === "narrator"} run={run} running={running} />
      </section>

      <section aria-labelledby="cast-check" className="panel">
        <h2 id="cast-check">Sprawdzenie etapu 0</h2>
        <p className="actions-note">
          Czy obsada, zasady w <code>project.md</code> i reszta etapu 0 już się zgadzają.
        </p>
        <Action argv={check} disabled={running} label="Sprawdź etap 0" onRun={from("check")} />
        <Answer here={origin === "check"} run={run} running={running} />
      </section>
    </div>
  );
}
