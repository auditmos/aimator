import { type JSX, useCallback, useEffect, useMemo, useState } from "react";
import { INTENTS } from "../src/ui/commands.js";
import {
  asCalls,
  Block,
  Drift,
  NO_FLAGS,
  PaidCall,
  Problems,
  Review,
  SendFields,
  type SendFlags,
  useArtifactText,
} from "./panel";
import type { RunDone, ShotListStatus, StatusCell } from "./types";

/**
 * Stage 3: the plan every image and every clip below it is drawn from.
 *
 * The one thing worth saying on screen that no other text stage says is the
 * three units this pipeline never lets collapse into each other: a scene is a
 * place and a time, a shot is one look of the camera, and a clip is one paid
 * video generation. The verdict counts all three, and the panel prints them as
 * three numbers rather than as "length", because a plan that adds up in
 * seconds and not in clips is a plan that fails one row down.
 *
 * Everything else is the shared arrangement: the review, the drift, the two
 * steps of a purchase and the bill in calls.
 */

interface PanelProps {
  readonly cell: StatusCell;
  readonly episodeId: string;
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  readonly run: RunDone | null;
  readonly running: boolean;
}

export function ShotListPanel(props: PanelProps): JSX.Element {
  const { cell, episodeId, onRun, projectId, run, running } = props;
  const status = cell.status as ShotListStatus | null;
  const shotList = useArtifactText(
    { artifact: "shot-list", episodeId, projectId, stage: "shot-list" },
    cell.state
  );
  const [flags, setFlags] = useState<SendFlags>(NO_FLAGS);
  const check = useMemo(
    () => INTENTS.checkShotList({ episodeId, projectId }),
    [episodeId, projectId]
  );
  const approve = useMemo(
    () => INTENTS.approveShotList({ episodeId, projectId }),
    [episodeId, projectId]
  );
  const preview = useMemo(
    () =>
      INTENTS.previewShotList({
        episodeId,
        maxOutputTokens: flags.tokens,
        model: flags.model,
        projectId,
        regenerate: flags.regenerate,
      }),
    [episodeId, flags, projectId]
  );
  const [sent, setSent] = useState<readonly string[] | null>(null);
  const startRun = useCallback(
    (argv: readonly string[]) => {
      setSent(argv);
      onRun(argv);
    },
    [onRun]
  );

  useEffect(() => setSent(null), [episodeId, projectId]);

  return (
    <section aria-labelledby="shot-list-title" className="panel">
      <h2 id="shot-list-title">
        Etap {cell.stage}: {cell.title}
      </h2>

      {status === null ? (
        <p className="panel-empty">Ten etap nie odpowiedział; drabina pokazuje powód.</p>
      ) : (
        <Block title="Stan">
          <dl className="verdict">
            <div>
              <dt>Stan pliku</dt>
              <dd>{status.status}</dd>
            </div>
            <div>
              <dt>Zatwierdzona</dt>
              <dd>{status.approved ? "tak" : "nie"}</dd>
            </div>
            {status.verdict === null ? null : (
              <>
                <div>
                  <dt>Trzy jednostki</dt>
                  <dd>
                    sceny: {status.verdict.scenes.length}, ujęcia: {status.verdict.shots.length},
                    klipy: {status.verdict.clips.length}
                  </dd>
                </div>
                <div>
                  <dt>Czas</dt>
                  <dd>
                    suma {status.verdict.durationSeconds} s, najdłuższy klip{" "}
                    {status.verdict.longestClipSeconds} s (limit {status.verdict.maxClipSeconds} s)
                  </dd>
                </div>
                <div>
                  <dt>Obsada w kadrze</dt>
                  <dd>
                    {status.verdict.castSeen.length === 0
                      ? "nikt z obsady"
                      : status.verdict.castSeen.join(", ")}
                  </dd>
                </div>
              </>
            )}
          </dl>

          <Drift
            paths={status.inputsChanged}
            title="Dryf wejść: te pliki zmieniły się po napisaniu listy ujęć"
          />
          <Problems problems={status.problems} />
        </Block>
      )}

      <Block title="Lista ujęć">
        {shotList === null ? (
          <p className="panel-empty">Nie ma jeszcze pliku listy ujęć.</p>
        ) : (
          <pre className="artifact-text">{shotList}</pre>
        )}
      </Block>

      <Block className="block-decision" title="Decyzja">
        <Review
          approve={approve}
          check={check}
          note="„Zatwierdź” pojawia się dopiero, gdy check nie zgłasza problemów, a lista ujęć czeka na przyjęcie. Tak samo odmówiłby terminal."
          onRun={startRun}
          running={running}
          status={status}
        />
      </Block>

      <PaidCall
        note="Etap 3 kupuje dokładnie jedno wywołanie tekstowe. „Generuj” niczego nie wysyła i nie czyta klucza: pokazuje cały prompt i rachunek. Dopiero „Kup” płaci, i płaci za to, co pokazał podgląd."
        onRun={startRun}
        open={cell.state === "ready"}
        preview={preview}
        projectRun={run}
        read={asCalls}
        running={running}
        sent={sent}
      >
        <SendFields
          id="shot-list-send"
          modelPlaceholder="AIMATOR_SHOTLIST_MODEL"
          onChange={setFlags}
          tokensPlaceholder="24000"
          value={flags}
        />
      </PaidCall>
    </section>
  );
}
