import { type ChangeEvent, type JSX, useCallback, useEffect, useMemo, useState } from "react";
import { INTENTS } from "../src/ui/commands.js";
import {
  Action,
  artifactUrl,
  Drift,
  Field,
  PaidCall,
  Problems,
  RunOutput,
  type Unit,
} from "./panel";
import type { ArtifactStatus, CharacterStatus, RunDone, StatusCell } from "./types";

/**
 * Stage 2: the first panel where a person approves by **looking**.
 *
 * Every stage above this one produces text, so a terminal could show it and a
 * panel only arranged it better. A card, eight views and a hero cannot be read
 * out: approving an image in a terminal is approving a filename, which is the
 * gap this whole module exists to close. So the ten artifacts are drawn, each
 * beside its own state, and the checkbox that accepts one sits under it.
 *
 * It is also the first panel whose bill is a **set**. One command draws one
 * picture or eight, so the number is what a person reads before clicking, and
 * it counts what would actually be bought rather than what was asked for: the
 * views wait for an accepted card, so asking for the card and a view at once
 * is two artifacts and one purchase.
 *
 * The ten names are the stage's, never this file's. `check` reports all ten in
 * the order the stage draws them, so the panel lists what it was given; a copy
 * of the names here would drift the day somebody added a view.
 */

interface PanelProps {
  readonly cell: StatusCell;
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  readonly run: RunDone | null;
  readonly running: boolean;
}

/** An image stage's bill counts pictures, because pictures are the decision. */
const IMAGES: Unit = ["obraz", "obrazy", "obrazów"];

/** What the state of one picture means, in the word a person reads. */
const STATE: Record<ArtifactStatus["state"], string> = {
  absent: "jeszcze nie narysowany",
  completed: "narysowany, czeka na ocenę",
  submitted: "próba przerwana",
};

/** One of the ten: the picture, its state, and the box that chooses it. */
function Picture(props: {
  readonly characterId: string;
  readonly entry: ArtifactStatus;
  readonly onToggle: (artifact: string, chosen: boolean) => void;
  readonly projectId: string;
  readonly revision: string;
  readonly selected: boolean;
  readonly track: string;
}): JSX.Element {
  const { characterId, entry, onToggle, projectId, revision, selected, track } = props;
  const toggle = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onToggle(entry.artifact, event.target.checked),
    [entry.artifact, onToggle]
  );
  const source = `${artifactUrl({
    artifact: entry.artifact,
    characterId,
    projectId,
    stage: "character",
    track,
  })}&v=${encodeURIComponent(revision)}`;

  return (
    <li className="picture">
      <label className="field-check" htmlFor={`pick-${entry.artifact}`}>
        <input checked={selected} id={`pick-${entry.artifact}`} onChange={toggle} type="checkbox" />
        <code>{entry.artifact}</code>
      </label>
      {entry.verdict === null ? (
        <p className="picture-empty">{STATE[entry.state]}</p>
      ) : (
        // The dimensions come from what the stage measured in the bytes, so
        // the box is the right shape before the picture arrives. A number
        // typed here would be a second copy of the frame `lib/character` owns.
        <img
          alt={`${entry.artifact}, ${characterId}, ${track}`}
          height={entry.verdict.height}
          loading="lazy"
          src={source}
          width={entry.verdict.width}
        />
      )}
      <p className="picture-state">
        {entry.approved ? "zatwierdzony" : STATE[entry.state]} · {entry.note}
      </p>
    </li>
  );
}

export function CharacterPanel(props: PanelProps): JSX.Element {
  const { cell, onRun, projectId, run, running } = props;
  const status = cell.status as CharacterStatus | null;
  const characterId = cell.character ?? "";
  const track = cell.track ?? "";
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [model, setModel] = useState("");
  const [regenerate, setRegenerate] = useState(false);
  const [sent, setSent] = useState<readonly string[] | null>(null);
  const scope = useMemo(
    () => ({ artifacts: chosen, characterId, projectId, track }),
    [characterId, chosen, projectId, track]
  );
  const check = useMemo(
    () => INTENTS.checkCharacter({ characterId, projectId, track }),
    [characterId, projectId, track]
  );
  const approve = useMemo(() => INTENTS.approveCharacter(scope), [scope]);
  const preview = useMemo(
    () => INTENTS.previewCharacter({ ...scope, model, regenerate }),
    [model, regenerate, scope]
  );
  const startRun = useCallback(
    (argv: readonly string[]) => {
      setSent(argv);
      onRun(argv);
    },
    [onRun]
  );
  const toggle = useCallback((artifact: string, wanted: boolean) => {
    setChosen((current) =>
      wanted ? [...current, artifact] : current.filter((one) => one !== artifact)
    );
  }, []);
  const changeRegenerate = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setRegenerate(event.target.checked),
    []
  );

  // Another character's choice says nothing about this one, and the argv names
  // the character it was built for, so neither survives the switch.
  useEffect(() => {
    setChosen([]);
    setSent(null);
  }, [characterId, track]);

  /**
   * The same condition the CLI records under, read over a chosen set.
   *
   * Stage 2 accepts named pictures rather than a whole stage, so "Zatwierdź"
   * needs something chosen and every chosen one has to be a picture that
   * exists and nobody has accepted yet. An approval the terminal would refuse
   * is a click that teaches a person the screen lies.
   */
  const picked = (status?.artifacts ?? []).filter((one) => chosen.includes(one.artifact));
  const acceptable =
    picked.length > 0 && picked.every((one) => one.state === "completed" && !one.approved);

  return (
    <section aria-labelledby="character-title" className="panel">
      <h2 id="character-title">
        Etap {cell.stage}: {cell.title} · {track}
      </h2>

      {status === null ? (
        <p className="panel-empty">Ten etap nie odpowiedział; drabina pokazuje powód.</p>
      ) : (
        <>
          <dl className="verdict">
            <div>
              <dt>Postać</dt>
              <dd>
                {status.name} ({characterId})
              </dd>
            </div>
            <div>
              <dt>Zatwierdzona w całości</dt>
              <dd>{status.approved ? "tak" : "nie"}</dd>
            </div>
            <div>
              <dt>Dalej</dt>
              <dd>{status.nextStep}</dd>
            </div>
          </dl>

          <Drift
            paths={status.inputsChanged}
            title="Dryf wejść: te pliki zmieniły się po narysowaniu obrazów"
          />
          <Problems problems={status.problems} />

          <h3>Obrazy</h3>
          <p className="actions-note">
            Zaznacz te, których dotyczy akcja. Jedno kliknięcie to jedna komenda z listą
            <code>--artifact</code>, bo zatwierdzenie dwóch widoków to jedna decyzja, a nie dwie.
          </p>
          <ul className="pictures">
            {status.artifacts.map((entry) => (
              <Picture
                characterId={characterId}
                entry={entry}
                key={entry.artifact}
                onToggle={toggle}
                projectId={projectId}
                revision={cell.state}
                selected={chosen.includes(entry.artifact)}
                track={track}
              />
            ))}
          </ul>
        </>
      )}

      <Action argv={check} disabled={running} label="Sprawdź" onRun={startRun} />

      {acceptable ? (
        <Action argv={approve} disabled={running} label="Zatwierdź" onRun={startRun} primary />
      ) : (
        <p className="actions-note">
          „Zatwierdź” pojawia się, gdy zaznaczone są obrazy, które istnieją i czekają na przyjęcie.
          Tak samo odmówiłby terminal.
        </p>
      )}

      <PaidCall
        note="Bez zaznaczenia etap rysuje to, na co pozwalają bramki: najpierw kartę, potem osiem widoków, na końcu hero. „Generuj” niczego nie wysyła i nie czyta klucza: pokazuje każdy prompt i liczbę obrazów. Dopiero „Kup” płaci."
        onRun={startRun}
        preview={preview}
        projectRun={run}
        running={running}
        sent={sent}
        unit={IMAGES}
      >
        <div className="send">
          <Field
            id="character-model"
            label="Model"
            onValue={setModel}
            placeholder="AIMATOR_IMAGE_MODEL_*"
            value={model}
          />
          <label className="field-check" htmlFor="character-regenerate">
            <input
              checked={regenerate}
              id="character-regenerate"
              onChange={changeRegenerate}
              type="checkbox"
            />
            Nowa płatna próba zaznaczonych obrazów
          </label>
        </div>
      </PaidCall>

      <RunOutput run={run} running={running} />
    </section>
  );
}
