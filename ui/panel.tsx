import { type ChangeEvent, type JSX, useCallback, useEffect, useMemo, useState } from "react";
import { buyScreenplay, commandLine, INTENTS, type Preview } from "../src/ui/commands.js";
import type { GenerateReport, RunDone, ScreenplayStatus, StatusCell } from "./types";

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
 *
 * The paid half is two steps and never one. "Generuj" runs the same command
 * with `--dry-run`, which by contract reads no secret and sends nothing, and
 * what comes back is the whole send: the prompt to read and the bill in calls.
 * Only then does "Kup" exist, and what it runs is that preview with the dry
 * run taken off, so the send a person read and the send they pay for are one
 * array. There is no threshold and no cheap case: a step somebody skips is a
 * step that is not there.
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

/**
 * The bill, in words. Stage 1's is only ever zero or one.
 *
 * Polish counts in three forms and this says two of them, which is the whole
 * range this stage can produce: it buys one call or it tells you it cannot.
 * A stage that draws six images needs the third form, and will need it in its
 * own panel, where the number it prints is its own.
 */
function bill(calls: number): string {
  return calls === 1 ? "1 płatne wywołanie" : `${calls} płatnych wywołań`;
}

/** A dry run that came back, beside the object it came back with. */
interface Previewed {
  readonly report: GenerateReport;
  readonly send: Preview;
}

interface PaidCallProps {
  readonly episodeId: string;
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  readonly projectRun: RunDone | null;
  readonly running: boolean;
  /** The argv of the last command the panel started, whatever it was. */
  readonly sent: readonly string[] | null;
}

/**
 * The one dangerous button on this screen, and the step that has to precede it.
 *
 * It is a component of its own because the two steps are one piece of
 * behaviour: which flags go out, what came back, and whether "Kup" may exist
 * at all are the same question asked three times. The preview it holds is
 * derived from what the panel last sent and what came back under that run's
 * identifier, never from a flag set on the way out, because the answer arrives
 * on a stream this panel shares with the ladder and with the terminal.
 */
function PaidCall(props: PaidCallProps): JSX.Element {
  const { episodeId, onRun, projectId, projectRun, running, sent } = props;
  const [model, setModel] = useState("");
  const [tokens, setTokens] = useState("");
  const [regenerate, setRegenerate] = useState(false);
  const [previewed, setPreviewed] = useState<Previewed | null>(null);
  const preview = useMemo(
    () =>
      INTENTS.previewScreenplay({
        episodeId,
        maxOutputTokens: tokens,
        model,
        projectId,
        regenerate,
      }),
    [episodeId, model, projectId, regenerate, tokens]
  );

  /**
   * "Kup" exists for exactly one dry run: the one whose answer is on screen.
   *
   * Anything else this panel starts takes it away again, including a second
   * dry run while it is still in flight, because two steps are only two if the
   * second one is about the first.
   */
  useEffect(() => {
    if (sent === null || !(sent.includes("--dry-run") && projectRun?.ok === true)) {
      setPreviewed(null);

      return;
    }

    try {
      setPreviewed({
        report: JSON.parse(projectRun.data) as GenerateReport,
        send: { argv: sent, runId: projectRun.runId },
      });
    } catch {
      setPreviewed(null);
    }
  }, [projectRun, sent]);

  const runPreview = useCallback(() => onRun(preview), [onRun, preview]);
  const runBuy = useCallback(() => {
    if (previewed !== null) {
      onRun(buyScreenplay(previewed.send));
    }
  }, [onRun, previewed]);
  const changeModel = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setModel(event.target.value),
    []
  );
  const changeTokens = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setTokens(event.target.value),
    []
  );
  const changeRegenerate = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setRegenerate(event.target.checked),
    []
  );

  return (
    <>
      <h3>Płatne wywołanie</h3>
      <p className="actions-note">
        Etap 1 kupuje dokładnie jedno wywołanie tekstowe. „Generuj” niczego nie wysyła i nie czyta
        klucza: pokazuje cały prompt i rachunek. Dopiero „Kup” płaci, i płaci za to, co pokazał
        podgląd.
      </p>
      <div className="send">
        <div className="field">
          <label htmlFor="send-model">Model</label>
          <input
            id="send-model"
            onChange={changeModel}
            placeholder="AIMATOR_SCREENPLAY_MODEL"
            type="text"
            value={model}
          />
        </div>
        <div className="field">
          <label htmlFor="send-tokens">Limit tokenów</label>
          <input
            id="send-tokens"
            inputMode="numeric"
            onChange={changeTokens}
            placeholder="12000"
            type="text"
            value={tokens}
          />
        </div>
        <label className="field-check" htmlFor="send-regenerate">
          <input
            checked={regenerate}
            id="send-regenerate"
            onChange={changeRegenerate}
            type="checkbox"
          />
          Nowa płatna próba, zachowując poprzednią
        </label>
      </div>

      <div className="actions">
        <button className="action" disabled={running} onClick={runPreview} type="button">
          Generuj
        </button>
        <Command argv={preview} />
      </div>

      {previewed === null ? (
        <p className="actions-note">
          „Kup” pojawia się dopiero po podglądzie, zawsze, także gdy wywołanie jest jedno. Bez niego
          nic nie wychodzi do modelu.
        </p>
      ) : (
        <Bought onBuy={runBuy} previewed={previewed} running={running} />
      )}
    </>
  );
}

/** What a finished dry run says, and the button it may or may not unlock. */
function Bought(props: {
  readonly onBuy: () => void;
  readonly previewed: Previewed;
  readonly running: boolean;
}): JSX.Element {
  const { report, send } = props.previewed;

  return (
    <>
      <p className="bill">Do kupienia: {bill(report.paidCalls)}</p>

      {report.problems.map((problem) => (
        <p className="problem" key={problem}>
          {problem}
        </p>
      ))}

      {report.paidCalls === 0 ? null : (
        <div className="actions">
          <button
            className="action action-primary"
            disabled={props.running}
            onClick={props.onBuy}
            type="button"
          >
            Kup
          </button>
          <Command argv={buyScreenplay(send)} />
        </div>
      )}

      {report.prompt === null ? null : (
        <>
          <h3>Prompt, który poleci do modelu</h3>
          <pre className="artifact-text">{report.prompt}</pre>
        </>
      )}
    </>
  );
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
  /** The argv of the last command this panel started, whatever it was. */
  const [sent, setSent] = useState<readonly string[] | null>(null);
  const startRun = useCallback(
    (argv: readonly string[]) => {
      setSent(argv);
      onRun(argv);
    },
    [onRun]
  );
  const runCheck = useCallback(() => startRun(check), [check, startRun]);
  const runApprove = useCallback(() => startRun(approve), [approve, startRun]);

  // Another episode's preview says nothing about this one, and its argv names
  // the episode it was built for, so it must not survive the switch.
  useEffect(() => setSent(null), [episodeId, projectId]);

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

      <PaidCall
        episodeId={episodeId}
        onRun={startRun}
        projectId={projectId}
        projectRun={run}
        running={running}
        sent={sent}
      />

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
