import { type JSX, useCallback, useEffect, useMemo, useState } from "react";
import { commandLine, INTENTS } from "../src/ui/commands.js";
import type { RunDone, ScreenplayStatus, StatusCell } from "./types";

/**
 * Stage 1, in one place: the verdict, the screenplay itself, and the one yes.
 *
 * Everything this panel shows was decided somewhere else. The verdict is the
 * object the ladder carried, which is `checkScreenplay`'s own; the text is the
 * bytes the resolver served; the words of a refusal are the CLI's. What the
 * panel adds is the arrangement, and one rule about the button: **"Zatwierdź"
 * appears only where `check` reports nothing to fix**, because an approval the
 * CLI would refuse is a click that teaches a person the screen lies.
 *
 * Under every button stands the command it runs. That is not decoration: the
 * same pipeline is driven from a terminal and by agents, so a person reading
 * this screen should be able to paste what it does and get what it did.
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

/** The screenplay's bytes, re-read whenever the stage says it moved. */
function useScreenplay(projectId: string, episodeId: string, state: string): string | null {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/artifact/${projectId}/${episodeId}/screenplay/screenplay`)
      .then(async (response) => (response.ok ? await response.text() : null))
      .then((body) => {
        if (!cancelled) {
          setText(body);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setText(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [episodeId, projectId, state]);

  return text;
}

function Command(props: { readonly argv: readonly string[] }): JSX.Element {
  return <code className="command">{commandLine(props.argv)}</code>;
}

export function ScreenplayPanel(props: PanelProps): JSX.Element {
  const { cell, episodeId, onRun, projectId, run, running } = props;
  const status = cell.status as ScreenplayStatus | null;
  const screenplay = useScreenplay(projectId, episodeId, cell.state);
  const check = useMemo(
    () => INTENTS.checkScreenplay({ episodeId, projectId }),
    [episodeId, projectId]
  );
  const approve = useMemo(
    () => INTENTS.approveScreenplay({ episodeId, projectId }),
    [episodeId, projectId]
  );
  const runCheck = useCallback(() => onRun(check), [check, onRun]);
  const runApprove = useCallback(() => onRun(approve), [approve, onRun]);
  // The same condition the CLI applies before it records anything: a file that
  // validates, a person who has not said yes yet, and nothing to fix first.
  const acceptable =
    status !== null &&
    status.status === "completed" &&
    !status.approved &&
    status.problems.length === 0;

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

          {status.inputsChanged.length === 0 ? null : (
            <div className="drift" role="alert">
              <p className="drift-title">
                Dryf wejść: te pliki zmieniły się po napisaniu scenariusza
              </p>
              <ul>
                {status.inputsChanged.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {status.problems.map((problem) => (
            <p className="problem" key={problem}>
              {problem}
            </p>
          ))}
        </>
      )}

      <div className="actions">
        <button className="action" disabled={running} onClick={runCheck} type="button">
          Sprawdź
        </button>
        <Command argv={check} />
      </div>

      {acceptable ? (
        <div className="actions">
          <button
            className="action action-primary"
            disabled={running}
            onClick={runApprove}
            type="button"
          >
            Zatwierdź
          </button>
          <Command argv={approve} />
        </div>
      ) : (
        <p className="actions-note">
          „Zatwierdź” pojawia się dopiero, gdy <code>check</code> nie zgłasza problemów, a
          scenariusz czeka na przyjęcie. Tak samo odmówiłby terminal.
        </p>
      )}

      {running ? <p className="run-pending">Komenda w toku…</p> : null}

      {run === null ? null : (
        <pre className={run.ok ? "run-output" : "run-output run-refused"}>
          {run.ok ? run.data : run.error.message}
        </pre>
      )}

      <h3>Scenariusz</h3>
      {screenplay === null ? (
        <p className="panel-empty">Nie ma jeszcze pliku scenariusza.</p>
      ) : (
        <pre className="artifact-text">{screenplay}</pre>
      )}
    </section>
  );
}
