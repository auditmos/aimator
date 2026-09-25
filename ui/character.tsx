import { type ChangeEvent, type JSX, useCallback, useEffect, useMemo, useState } from "react";
import { INTENTS } from "../src/ui/commands.js";
import {
  Action,
  artifactUrl,
  asImages,
  Block,
  Drift,
  Field,
  Gallery,
  PaidCall,
  PickAll,
  Problems,
  pickable,
  Redraw,
  Said,
  useRedraw,
} from "./panel";
import type { CharacterStatus, RunDone, StatusCell } from "./types";

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

export function CharacterPanel(props: PanelProps): JSX.Element {
  const { cell, onRun, projectId, run, running } = props;
  const status = cell.status as CharacterStatus | null;
  const characterId = cell.character ?? "";
  const track = cell.track ?? "";
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [model, setModel] = useState("");
  const [regenerate, setRegenerate] = useState(false);
  const [sent, setSent] = useState<readonly string[] | null>(null);
  /** The stage's word for a picture is `artifact`; the gallery's is `id`. */
  const drawn = useMemo(
    () => (status?.artifacts ?? []).map((one) => ({ ...one, id: one.artifact })),
    [status]
  );
  // An accepted picture stays ticked and locked unless a new paid attempt is
  // what is being chosen for.
  const selected = useMemo(() => pickable(drawn, chosen, regenerate), [chosen, drawn, regenerate]);
  const scope = useMemo(
    () => ({ artifacts: selected, characterId, projectId, track }),
    [characterId, projectId, selected, track]
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
  /** The same preview with a new paid attempt on, whatever the checkbox says now. */
  const again = useMemo(
    () => INTENTS.previewCharacter({ ...scope, model, regenerate: true }),
    [model, scope]
  );
  const startRun = useCallback(
    (argv: readonly string[]) => {
      setSent(argv);
      onRun(argv);
    },
    [onRun]
  );
  const { redraw, reveal } = useRedraw(startRun, setRegenerate);
  const toggle = useCallback((artifact: string, wanted: boolean) => {
    setChosen((current) =>
      wanted ? [...current, artifact] : current.filter((one) => one !== artifact)
    );
  }, []);
  const changeRegenerate = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setRegenerate(event.target.checked),
    []
  );
  const urlOf = useCallback(
    (artifact: string) =>
      `${artifactUrl({ artifact, characterId, projectId, stage: "character", track })}&v=${encodeURIComponent(cell.state)}`,
    [cell.state, characterId, projectId, track]
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
  const picked = drawn.filter((one) => selected.includes(one.id));
  const acceptable =
    picked.length > 0 && picked.every((one) => one.state === "completed" && !one.approved);
  // Only what exists can be drawn again; a view nobody drew yet needs no
  // "again", and the preview would only answer zero.
  const redrawable = picked.length > 0 && picked.every((one) => one.state === "completed");

  return (
    <section aria-labelledby="character-title" className="panel">
      <h2 id="character-title">
        Etap {cell.stage}: {cell.title} · {track}
      </h2>

      {status === null ? (
        <p className="panel-empty">Ten etap nie odpowiedział; drabina pokazuje powód.</p>
      ) : (
        <>
          <Block title="Stan">
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
                <dd>
                  <Said text={status.nextStep} />
                </dd>
              </div>
            </dl>

            <Drift
              paths={status.inputsChanged}
              title="Dryf wejść: te pliki zmieniły się po narysowaniu obrazów"
            />
            <Problems problems={status.problems} />
          </Block>
          <Block
            hint={
              <>
                Zaznacz te, których dotyczy akcja. Jedno kliknięcie to jedna komenda z listą{" "}
                <code>--artifact</code>, bo zatwierdzenie dwóch widoków to jedna decyzja, a nie
                dwie.
              </>
            }
            title="Obrazy"
          >
            <PickAll
              chosen={selected}
              id="character-all"
              items={drawn}
              onChoose={setChosen}
              unlocked={regenerate}
            />
            <Gallery
              chosen={selected}
              idPrefix="character"
              items={drawn}
              onToggle={toggle}
              unlocked={regenerate}
              urlOf={urlOf}
            />
          </Block>
        </>
      )}

      <Block className="block-decision" title="Decyzja">
        <Action argv={check} disabled={running} label="Sprawdź" onRun={startRun} />

        {acceptable ? (
          <Action argv={approve} disabled={running} label="Zatwierdź" onRun={startRun} primary />
        ) : null}
        {redrawable ? (
          <Redraw argv={again} count={picked.length} onRedraw={redraw} running={running} />
        ) : (
          <p className="actions-note">
            Zaznacz obrazy, żeby je zatwierdzić albo narysować ponownie. Tak samo odmówiłby
            terminal.
          </p>
        )}
      </Block>

      <PaidCall
        note="Bez zaznaczenia etap rysuje to, na co pozwalają bramki: najpierw kartę, potem osiem widoków, na końcu hero. „Generuj” niczego nie wysyła i nie czyta klucza: pokazuje każdy prompt i liczbę obrazów. Dopiero „Kup” płaci."
        onRun={startRun}
        open={cell.state === "ready"}
        preview={preview}
        projectRun={run}
        read={asImages}
        reveal={reveal}
        running={running}
        sent={sent}
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
    </section>
  );
}
