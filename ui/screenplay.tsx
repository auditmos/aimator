import { type JSX, useCallback, useEffect, useMemo, useState } from "react";
import { INTENTS } from "../src/ui/commands.js";
import {
  Drift,
  NO_FLAGS,
  PaidCall,
  Problems,
  Review,
  RunOutput,
  SendFields,
  type SendFlags,
  useArtifactText,
} from "./panel";
import type { RunDone, ScreenplayStatus, StatusCell } from "./types";

/**
 * Stage 1, in one place: the verdict, the screenplay itself, and the one yes.
 *
 * Everything this panel shows was decided somewhere else. The verdict is the
 * object the ladder carried, which is `checkScreenplay`'s own; the text is the
 * bytes the resolver served; the words of a refusal are the CLI's. What this
 * file holds is stage 1's own arrangement and nothing that any other stage
 * repeats: the review, the drift, the two steps of a purchase and the bill are
 * in `panel.tsx`, because three text stages do them identically.
 */

interface PanelProps {
  readonly cell: StatusCell;
  readonly episodeId: string;
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  /** The last finished command, or nothing since this panel was opened. */
  readonly run: RunDone | null;
  readonly running: boolean;
}

export function ScreenplayPanel(props: PanelProps): JSX.Element {
  const { cell, episodeId, onRun, projectId, run, running } = props;
  const status = cell.status as ScreenplayStatus | null;
  const screenplay = useArtifactText(
    { artifact: "screenplay", episodeId, projectId, stage: "screenplay" },
    cell.state
  );
  const [flags, setFlags] = useState<SendFlags>(NO_FLAGS);
  const check = useMemo(
    () => INTENTS.checkScreenplay({ episodeId, projectId }),
    [episodeId, projectId]
  );
  const approve = useMemo(
    () => INTENTS.approveScreenplay({ episodeId, projectId }),
    [episodeId, projectId]
  );
  const preview = useMemo(
    () =>
      INTENTS.previewScreenplay({
        episodeId,
        maxOutputTokens: flags.tokens,
        model: flags.model,
        projectId,
        regenerate: flags.regenerate,
      }),
    [episodeId, flags, projectId]
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

  // Another episode's preview says nothing about this one, and its argv names
  // the episode it was built for, so it must not survive the switch.
  useEffect(() => setSent(null), [episodeId, projectId]);

  return (
    <section aria-labelledby="panel-title" className="panel">
      <h2 id="panel-title">
        Etap {cell.stage}: {cell.title}
      </h2>

      {status === null ? (
        <p className="panel-empty">Ten etap nie odpowiedział; drabina pokazuje powód.</p>
      ) : (
        <>
          <dl className="verdict">
            <div>
              <dt>Stan pliku</dt>
              <dd>{status.status}</dd>
            </div>
            <div>
              <dt>Zatwierdzony</dt>
              <dd>{status.approved ? "tak" : "nie"}</dd>
            </div>
            {status.verdict === null ? null : (
              <div>
                <dt>Walidacja</dt>
                <dd>
                  sceny: {status.verdict.scenes}, suma {status.verdict.durationSeconds} s,
                  najdłuższa {status.verdict.longestSceneSeconds} s
                </dd>
              </div>
            )}
          </dl>

          <Drift
            paths={status.inputsChanged}
            title="Dryf wejść: te pliki zmieniły się po napisaniu scenariusza"
          />
          <Problems problems={status.problems} />
        </>
      )}

      <Review
        approve={approve}
        check={check}
        note="„Zatwierdź” pojawia się dopiero, gdy check nie zgłasza problemów, a scenariusz czeka na przyjęcie. Tak samo odmówiłby terminal."
        onRun={startRun}
        running={running}
        status={status}
      />

      <PaidCall
        note="Etap 1 kupuje dokładnie jedno wywołanie tekstowe. „Generuj” niczego nie wysyła i nie czyta klucza: pokazuje cały prompt i rachunek. Dopiero „Kup” płaci, i płaci za to, co pokazał podgląd."
        onRun={startRun}
        preview={preview}
        projectRun={run}
        running={running}
        sent={sent}
      >
        <SendFields
          id="screenplay-send"
          modelPlaceholder="AIMATOR_SCREENPLAY_MODEL"
          onChange={setFlags}
          tokensPlaceholder="12000"
          value={flags}
        />
      </PaidCall>

      <RunOutput run={run} running={running} />

      <h3>Scenariusz</h3>
      {screenplay === null ? (
        <p className="panel-empty">Nie ma jeszcze pliku scenariusza.</p>
      ) : (
        <pre className="artifact-text">{screenplay}</pre>
      )}
    </section>
  );
}
