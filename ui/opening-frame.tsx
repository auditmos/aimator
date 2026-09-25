import { type ChangeEvent, type JSX, useCallback, useEffect, useMemo, useState } from "react";
import { INTENTS } from "../src/ui/commands.js";
import {
  Action,
  artifactUrl,
  asImages,
  Block,
  Field,
  Gallery,
  PaidCall,
  Problems,
  Said,
} from "./panel";
import type { OpeningFrameStatus, RunDone, StatusCell } from "./types";

/**
 * Stage 6: the first frame of the film, and the panel with no choice in it.
 *
 * There is exactly one artifact here, so there is nothing to select and no
 * `--artifact` anywhere: not on "Zatwierdź", not on a new paid attempt. That
 * is not a relaxation of stage 5's rule but the same rule read correctly.
 * Stage 5 demands the flag because it has several candidates and accepting the
 * wrong one buys an image; here the command already says which stage and which
 * track, and a flag with one legal value is ceremony standing where a decision
 * used to be.
 *
 * Its gate is the other thing worth seeing: this frame waits for the
 * references the package named for it, accepted **on this track**, so a person
 * reading zero in the bill is reading which yes is still missing.
 */

interface PanelProps {
  readonly cell: StatusCell;
  readonly episodeId: string;
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  readonly run: RunDone | null;
  readonly running: boolean;
}

export function OpeningFramePanel(props: PanelProps): JSX.Element {
  const { cell, episodeId, onRun, projectId, run, running } = props;
  const status = cell.status as OpeningFrameStatus | null;
  const track = cell.track ?? "";
  const [model, setModel] = useState("");
  const [regenerate, setRegenerate] = useState(false);
  const [sent, setSent] = useState<readonly string[] | null>(null);
  const scope = useMemo(() => ({ episodeId, projectId, track }), [episodeId, projectId, track]);
  const check = useMemo(() => INTENTS.checkOpeningFrame(scope), [scope]);
  const approve = useMemo(() => INTENTS.approveOpeningFrame(scope), [scope]);
  const preview = useMemo(
    () => INTENTS.previewOpeningFrame({ ...scope, model, regenerate }),
    [model, regenerate, scope]
  );
  const startRun = useCallback(
    (argv: readonly string[]) => {
      setSent(argv);
      onRun(argv);
    },
    [onRun]
  );
  const changeRegenerate = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setRegenerate(event.target.checked),
    []
  );
  const urlOf = useCallback(
    (artifact: string) =>
      `${artifactUrl({ artifact, episodeId, projectId, stage: "opening-frame", track })}&v=${encodeURIComponent(cell.state)}`,
    [cell.state, episodeId, projectId, track]
  );

  useEffect(() => setSent(null), [episodeId, track]);

  const frame = status?.artifact ?? null;
  const acceptable = frame !== null && frame.state === "completed" && !frame.approved;

  return (
    <section aria-labelledby="opening-title" className="panel">
      <h2 id="opening-title">
        Etap {cell.stage}: {cell.title} · {track}
      </h2>

      {status === null || frame === null ? (
        <p className="panel-empty">Ten etap nie odpowiedział; drabina pokazuje powód.</p>
      ) : (
        <>
          <Block title="Stan">
            <dl className="verdict">
              <div>
                <dt>Zatwierdzona</dt>
                <dd>{status.approved ? "tak" : "nie"}</dd>
              </div>
              <div>
                <dt>Dalej</dt>
                <dd>
                  <Said text={status.nextStep} />
                </dd>
              </div>
            </dl>

            <Problems problems={status.problems} />
          </Block>
          <Block
            hint={
              <>
                Jeden artefakt, więc nie ma czego zaznaczać: <code>--artifact</code> nie pojawia się
                tu w żadnej komendzie, nawet przy nowej płatnej próbie.
              </>
            }
            title="Klatka otwarcia"
          >
            <Gallery
              chosen={[]}
              idPrefix="opening"
              items={[frame]}
              onToggle={null}
              unlocked={false}
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
            „Zatwierdź” pojawia się, gdy klatka istnieje i czeka na przyjęcie. Tak samo odmówiłby
            terminal.
          </p>
        )}
      </Block>

      <PaidCall
        note="Dokładnie jedno wywołanie, i tylko wtedy, gdy referencje, które pakiet wpisał tej klatce, są zatwierdzone na tym torze. „Generuj” niczego nie wysyła i nie czyta klucza: pokazuje prompt i rachunek, który jest zerem albo jedynką. Dopiero „Kup” płaci."
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
            id="opening-model"
            label="Model"
            onValue={setModel}
            placeholder="AIMATOR_IMAGE_MODEL_*"
            value={model}
          />
          <label className="field-check" htmlFor="opening-regenerate">
            <input
              checked={regenerate}
              id="opening-regenerate"
              onChange={changeRegenerate}
              type="checkbox"
            />
            Nowa płatna próba tej klatki
          </label>
        </div>
      </PaidCall>
    </section>
  );
}
