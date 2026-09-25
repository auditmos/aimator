import { type ChangeEvent, type JSX, useCallback, useEffect, useMemo, useState } from "react";
import { INTENTS } from "../src/ui/commands.js";
import { Action, artifactUrl, Block, Drift, Notices, Problems, Said } from "./panel";
import type { AssemblyReport, AssemblyStatus, CutState, RunDone, StatusCell } from "./types";

/**
 * Stage 8: the first panel with **no bill and no „Kup”**.
 *
 * Every panel above this one is arranged around a purchase: two steps, a
 * number beside the button that spends, and a prompt to read before anything
 * goes out. None of that exists here, because this stage reaches no provider
 * at all. What it needs is a program on this machine, and when that program is
 * missing the CLI refuses rather than re-encoding, so the whole of what this
 * screen owes is one button and the words the terminal would have printed.
 *
 * Two things it does show that no panel above it does.
 *
 * **The cut plan, derived and never stored.** There is no `edit-plan.json` and
 * there will not be one: the order, the seconds and the tiling live in the
 * approved shot list already, and a second file holding the same truth would
 * drift from it at the first hand correction. So the plan on screen is the one
 * the stage derived for this run, read out of its own report, which is why a
 * free dry run exists at all here: a preview with no bill still answers what
 * would be cut, in what order, and how far the clips that came back drifted.
 *
 * **Silence as a notice rather than an obstacle.** The episode declared a
 * sound mode in stage 0 and nothing at this row produces a soundtrack, so the
 * cut is silent and says so at every check. Painting that as a problem would
 * make a finished, accepted film look like a blocked cell, which is exactly
 * the distinction `problems` and `notices` exist to keep.
 */

interface PanelProps {
  readonly cell: StatusCell;
  readonly episodeId: string;
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  readonly run: RunDone | null;
  readonly running: boolean;
}

/** What the state of the one cut means, in the word a person reads. */
const CUT_STATE: Record<CutState["state"], string> = {
  absent: "jeszcze nie zmontowany",
  completed: "gotowy, czeka na ocenę",
};

/** What one link of the cut says: what was ordered, and what came back. */
function Cut(props: { readonly plan: AssemblyReport }): JSX.Element {
  const { plan } = props;

  return (
    <>
      <dl className="verdict">
        <div>
          <dt>Silnik</dt>
          <dd>{plan.engine ?? "nieustalony"}</dd>
        </div>
        <div>
          <dt>Plan</dt>
          <dd>{plan.plannedSeconds}s</dd>
        </div>
        <div>
          <dt>Klipy</dt>
          <dd>{plan.actualSeconds}s</dd>
        </div>
      </dl>
      <ul className="cut">
        {plan.cut.map((clip) => (
          <li key={clip.id}>
            <code>{clip.id}</code> · plan {clip.plannedSeconds}s · wynik {clip.seconds ?? "?"}s
          </li>
        ))}
      </ul>
      <Problems problems={plan.problems} />
      <Notices notices={plan.notices} />
    </>
  );
}

export function AssemblyPanel(props: PanelProps): JSX.Element {
  const { cell, episodeId, onRun, projectId, run, running } = props;
  const status = cell.status as AssemblyStatus | null;
  const track = cell.track ?? "";
  const [dryRun, setDryRun] = useState(true);
  const [regenerate, setRegenerate] = useState(false);
  const [sent, setSent] = useState<readonly string[] | null>(null);
  const [plan, setPlan] = useState<AssemblyReport | null>(null);
  const scope = useMemo(() => ({ episodeId, projectId, track }), [episodeId, projectId, track]);
  const check = useMemo(() => INTENTS.checkAssembly(scope), [scope]);
  const approve = useMemo(() => INTENTS.approveAssembly(scope), [scope]);
  const assemble = useMemo(
    () => INTENTS.assembleEpisode({ ...scope, dryRun, regenerate }),
    [dryRun, regenerate, scope]
  );
  const startRun = useCallback(
    (argv: readonly string[]) => {
      setSent(argv);
      onRun(argv);
    },
    [onRun]
  );
  const changeDryRun = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setDryRun(event.target.checked),
    []
  );
  const changeRegenerate = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setRegenerate(event.target.checked),
    []
  );

  /**
   * The plan the last cut command answered with, whichever mode it ran in.
   *
   * A dry run and a real cut report the same arithmetic, so both are read; a
   * `check` or an approval is not, because neither carries a cut. Everything
   * this reads comes out of the report's own fields, which is the one thing a
   * panel is allowed to do with an answer: arrange it, never re-derive it.
   */
  useEffect(() => {
    if (sent === null || !(sent.includes("assembly") && run?.ok === true)) {
      setPlan(null);

      return;
    }

    try {
      setPlan(JSON.parse(run.data) as AssemblyReport);
    } catch {
      setPlan(null);
    }
  }, [run, sent]);

  useEffect(() => {
    setSent(null);
    setPlan(null);
  }, [episodeId, track]);

  const cut = status?.artifact ?? null;
  const acceptable = cut !== null && cut.state === "completed" && !cut.approved;
  const film = `${artifactUrl({ artifact: "episode", episodeId, projectId, stage: "assembly", track })}&v=${encodeURIComponent(cell.state)}`;

  return (
    <section aria-labelledby="assembly-title" className="panel">
      <h2 id="assembly-title">
        Etap {cell.stage}: {cell.title} · {track}
      </h2>

      {status === null || cut === null ? (
        <p className="panel-empty">Ten etap nie odpowiedział; drabina pokazuje powód.</p>
      ) : (
        <>
          <Block title="Stan">
            <dl className="verdict">
              <div>
                <dt>Przyjęty w całości</dt>
                <dd>{status.approved ? "tak" : "nie"}</dd>
              </div>
              <div>
                <dt>Długość</dt>
                <dd>{cut.seconds === null ? "—" : `${cut.seconds}s`}</dd>
              </div>
              <div>
                <dt>Dalej</dt>
                <dd>
                  <Said text={status.nextStep} />
                </dd>
              </div>
            </dl>

            <Problems problems={status.problems} />
            <Notices notices={status.notices} />
            <Drift paths={cut.inputsChanged} title="Wejścia zmieniły się po tym cięciu:" />
          </Block>

          <Block
            hint={
              <>
                Ocena całości to nie powtórka ocen klipów: tamte mówią, że każde ujęcie jest dobre,
                ta mówi, że <strong>te klipy w tej kolejności to film</strong>. Rytm przez cięcia,
                ciągłość na szwach i rzeczywista długość istnieją wyłącznie w całości, więc obejrzyj
                ją w całości. Film jest niemy z założenia; dźwięk dokłada etap poniżej.
              </>
            }
            title="Cały odcinek"
          >
            {cut.state === "absent" ? (
              <p className="picture-empty">{CUT_STATE.absent}</p>
            ) : (
              // biome-ignore lint/a11y/useMediaCaption: cięcie jest nieme, napisy to decyzja odcinka i etap 9
              <video className="link-film" controls preload="metadata" src={film} />
            )}
            <p className="picture-state">
              {cut.approved ? "zatwierdzony" : CUT_STATE[cut.state]} · {cut.note}
            </p>
          </Block>
        </>
      )}

      <Block className="block-decision" title="Decyzja">
        <Action argv={check} disabled={running} label="Sprawdź" onRun={startRun} />

        {acceptable ? (
          <Action argv={approve} disabled={running} label="Zatwierdź" onRun={startRun} primary />
        ) : (
          <p className="actions-note">
            „Zatwierdź” pojawia się, gdy cięcie istnieje i czeka na przyjęcie. Tak samo odmówiłby
            terminal.
          </p>
        )}
      </Block>

      <Block
        fold={cell.state === "ready"}
        hint={
          <>
            Jedyny etap, który <strong>niczego nie kupuje</strong>, więc nie ma tu rachunku, nie ma
            dwóch kroków i nie ma przycisku „Kup”: jest jeden przycisk. Nie ma też modelu ani
            klucza, bo nic nie leci do dostawcy; potrzebny jest <code>ffmpeg</code> na tej maszynie
            (PATH albo <code>AIMATOR_FFMPEG</code>), a gdy go nie ma, etap odmawia zamiast
            przekodowywać, i tę odmowę zobaczysz słowo w słowo taką, jaką wypisałby terminal.
            <br />
            <br />
            Plan cięcia jest wyprowadzony z <strong>zatwierdzonej listy ujęć</strong> w chwili
            wywołania i nigdzie nie zapisany: drugi plik trzymający tę samą prawdę rozjechałby się z
            nią przy pierwszej poprawce ręcznej. Jeśli plan jest zły, poprawka należy do etapu 3.
            Klipy nie wracają co do sekundy, a montaż skleja to, co wróciło, i melduje różnicę,
            nigdy nie przycina.
          </>
        }
        title="Montaż (bez płacenia)"
      >
        <div className="send">
          <label className="field-check" htmlFor="assembly-dry-run">
            <input checked={dryRun} id="assembly-dry-run" onChange={changeDryRun} type="checkbox" />
            Próba na sucho: pokaż plan cięcia, nie zapisuj niczego
          </label>
          <label className="field-check" htmlFor="assembly-regenerate">
            <input
              checked={regenerate}
              id="assembly-regenerate"
              onChange={changeRegenerate}
              type="checkbox"
            />
            Ponowne cięcie gotowego montażu, zachowując poprzedni
          </label>
        </div>

        <Action
          argv={assemble}
          disabled={running}
          label={dryRun ? "Pokaż plan cięcia" : "Zmontuj"}
          onRun={startRun}
          primary={!dryRun}
        />

        {plan === null ? (
          <p className="actions-note">
            Plan pokazuje „Pokaż plan cięcia”. To wywołanie jest darmowe i przy próbie na sucho nie
            zapisuje niczego.
          </p>
        ) : (
          <Cut plan={plan} />
        )}
      </Block>
    </section>
  );
}
