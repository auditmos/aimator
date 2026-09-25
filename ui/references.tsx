import { type ChangeEvent, type JSX, useCallback, useEffect, useMemo, useState } from "react";
import { INTENTS } from "../src/ui/commands.js";
import { Action, artifactUrl, asImages, Block, Field, Gallery, PaidCall, Problems } from "./panel";
import type { ReferencesStatus, RunDone, StatusCell } from "./types";

/**
 * Stage 5: the first stage whose gate is a **graph**, and on this track alone.
 *
 * Everything above it waits on a stage. A reference waits on a sibling: R04 is
 * composed from R03, so it cannot be bought until a person has accepted R03
 * **here**, and accepting it on the other track says nothing. That is why the
 * blocked ones are shown rather than hidden, with the reason the stage gives,
 * which names the reference they are waiting for: a cell that only said
 * "blocked" would leave a person with no next move.
 *
 * The rest is stage 2's arrangement one row down, because it is the same
 * question: several pictures, a choice over them, one command per decision.
 */

interface PanelProps {
  readonly cell: StatusCell;
  readonly episodeId: string;
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  readonly run: RunDone | null;
  readonly running: boolean;
}

export function ReferencesPanel(props: PanelProps): JSX.Element {
  const { cell, episodeId, onRun, projectId, run, running } = props;
  const status = cell.status as ReferencesStatus | null;
  const track = cell.track ?? "";
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [model, setModel] = useState("");
  const [regenerate, setRegenerate] = useState(false);
  const [sent, setSent] = useState<readonly string[] | null>(null);
  const scope = useMemo(
    () => ({ artifacts: chosen, episodeId, projectId, track }),
    [chosen, episodeId, projectId, track]
  );
  const check = useMemo(
    () => INTENTS.checkReferences({ episodeId, projectId, track }),
    [episodeId, projectId, track]
  );
  const approve = useMemo(() => INTENTS.approveReferences(scope), [scope]);
  const preview = useMemo(
    () => INTENTS.previewReferences({ ...scope, model, regenerate }),
    [model, regenerate, scope]
  );
  const startRun = useCallback(
    (argv: readonly string[]) => {
      setSent(argv);
      onRun(argv);
    },
    [onRun]
  );
  const toggle = useCallback((id: string, wanted: boolean) => {
    setChosen((current) => (wanted ? [...current, id] : current.filter((one) => one !== id)));
  }, []);
  const changeRegenerate = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setRegenerate(event.target.checked),
    []
  );
  const urlOf = useCallback(
    (artifact: string) =>
      `${artifactUrl({ artifact, episodeId, projectId, stage: "references", track })}&v=${encodeURIComponent(cell.state)}`,
    [cell.state, episodeId, projectId, track]
  );

  useEffect(() => {
    setChosen([]);
    setSent(null);
  }, [episodeId, track]);

  const picked = (status?.artifacts ?? []).filter((one) => chosen.includes(one.id));
  const acceptable =
    picked.length > 0 && picked.every((one) => one.state === "completed" && !one.approved);

  return (
    <section aria-labelledby="references-title" className="panel">
      <h2 id="references-title">
        Etap {cell.stage}: {cell.title} · {track}
      </h2>

      {status === null ? (
        <p className="panel-empty">Ten etap nie odpowiedział; drabina pokazuje powód.</p>
      ) : (
        <>
          <Block title="Stan">
            <dl className="verdict">
              <div>
                <dt>Zatwierdzone w całości</dt>
                <dd>{status.approved ? "tak" : "nie"}</dd>
              </div>
              <div>
                <dt>Dalej</dt>
                <dd>{status.nextStep}</dd>
              </div>
            </dl>

            <Problems problems={status.problems} />
          </Block>
          <Block
            hint={
              <>
                Pod każdą stoi jej stan w słowach etapu: referencja zależna mówi, na którą czeka, bo
                to jest decyzja, którą trzeba podjąć wcześniej. Zaznaczenie kilku daje jedną komendę
                z listą <code>--artifact</code>.
              </>
            }
            title="Referencje"
          >
            <Gallery
              chosen={chosen}
              idPrefix="reference"
              items={status.artifacts}
              onToggle={toggle}
              urlOf={urlOf}
            />
          </Block>
        </>
      )}

      <Block className="block-decision" title="Decyzja">
        <Action argv={check} disabled={running} label="Sprawdź" onRun={startRun} />

        {acceptable ? (
          <Action argv={approve} disabled={running} label="Zatwierdź" onRun={startRun} primary />
        ) : (
          <p className="actions-note">
            „Zatwierdź” pojawia się, gdy zaznaczone są referencje, które istnieją i czekają na
            przyjęcie. Tak samo odmówiłby terminal.
          </p>
        )}
      </Block>

      <PaidCall
        note="Bez zaznaczenia etap rysuje wszystkie referencje, których zależności są już zatwierdzone na tym torze. Zaznaczenie zablokowanej to pytanie „dlaczego jeszcze nie”: podgląd odpowie zerem i powodem. „Generuj” niczego nie wysyła i nie czyta klucza; dopiero „Kup” płaci."
        onRun={startRun}
        open={cell.state === "ready"}
        preview={preview}
        projectRun={run}
        read={asImages}
        running={running}
        sent={sent}
      >
        <div className="send">
          <Field
            id="references-model"
            label="Model"
            onValue={setModel}
            placeholder="AIMATOR_IMAGE_MODEL_*"
            value={model}
          />
          <label className="field-check" htmlFor="references-regenerate">
            <input
              checked={regenerate}
              id="references-regenerate"
              onChange={changeRegenerate}
              type="checkbox"
            />
            Nowa płatna próba zaznaczonych referencji
          </label>
        </div>
      </PaidCall>
    </section>
  );
}
