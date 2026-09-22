import { type ChangeEvent, type JSX, useCallback, useEffect, useMemo, useState } from "react";
import { INTENTS } from "../src/ui/commands.js";
import {
  Action,
  Drift,
  Field,
  NO_FLAGS,
  PaidCall,
  Problems,
  Review,
  RunOutput,
  SendFields,
  type SendFlags,
  useArtifactText,
} from "./panel";
import type { PlannedArtifact, PromptPackageStatus, RunDone, SendPlan, StatusCell } from "./types";

/**
 * Stage 4: the package both tracks read, and the free preview of a send.
 *
 * This is the first panel that asks which **track** it is talking about, and
 * the reason is the stage's own shape rather than a screen's. The package
 * names no track: it carries `hero:ewa` and `R01`, and what file those become
 * is decided at the sender, per track. `prompt-package show` is where that
 * resolution first happens, so it is where rule 8 first becomes visible: a
 * prompt is text **plus ordered attachments addressed by position**, and this
 * is the only place a person can read that order before anything is sent.
 *
 * The panel numbers the attachments itself, `Image N = <id> — <rola>`, which
 * is why `show` asks for the object rather than the sentence. Everything else
 * here is the arrangement the three text stages share.
 */

interface PanelProps {
  readonly cell: StatusCell;
  readonly episodeId: string;
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  readonly run: RunDone | null;
  readonly running: boolean;
}

/** The two productions, in the words `--track` takes. */
const TRACKS = ["gpt-image", "seedream"] as const;

/** What the state of one attachment means, in the word a person reads. */
const STATE: Record<PlannedArtifact["attachments"][number]["state"], string> = {
  absent: "jeszcze nie istnieje",
  approved: "zatwierdzony",
  changed: "zmieniony poza narzędziem",
  pending: "czeka na ocenę",
};

/** One future paid call: what it is, what it carries, and what stops it. */
function Planned(props: { readonly artifact: PlannedArtifact }): JSX.Element {
  const { artifact } = props;

  return (
    <li className="planned">
      <p className="planned-name">
        <code>{artifact.name}</code> ({artifact.kind})
        {artifact.seconds === null ? null : <span> · {artifact.seconds} s</span>}
        <span
          className={artifact.blockers.length === 0 ? "state state-ready" : "state state-blocked"}
        >
          {artifact.blockers.length === 0 ? "gotowy" : "zablokowany"}
        </span>
      </p>
      <ol className="attachments">
        {artifact.attachments.map((attachment, index) => (
          <li key={attachment.id}>
            <code>
              Image {index + 1} = {attachment.id}
            </code>{" "}
            — {attachment.role}
            <span className="attachment-state">
              {STATE[attachment.state]} · <code>{attachment.path}</code>
            </span>
          </li>
        ))}
      </ol>
      <Problems problems={artifact.blockers} />
      {artifact.text === null ? null : <pre className="artifact-text">{artifact.text}</pre>}
    </li>
  );
}

/**
 * The send plan of one track, read whole and for free.
 *
 * It runs a command like every other button here, so its answer arrives on the
 * same stream: what is on screen is what the last `show` returned, and the
 * argv under the button is the one a person could paste.
 */
function Sending(props: {
  readonly episodeId: string;
  readonly onRun: (argv: readonly string[]) => void;
  readonly plan: SendPlan | null;
  readonly projectId: string;
  readonly running: boolean;
}): JSX.Element {
  const { episodeId, onRun, plan, projectId, running } = props;
  const [track, setTrack] = useState<string>(TRACKS[0]);
  const [artifact, setArtifact] = useState("");
  const argv = useMemo(
    () => INTENTS.showSendPlan({ artifact, episodeId, projectId, track }),
    [artifact, episodeId, projectId, track]
  );
  const chooseTrack = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => setTrack(event.target.value),
    []
  );

  return (
    <>
      <h3>Plan wysyłki</h3>
      <p className="actions-note">
        Darmowe. Pokazuje dokładnie to, co poleci do modelu obrazu albo wideo na tym torze:
        załączniki w kolejności, w jakiej żądanie poniesie bajty, adresowane po pozycji. Pakiet jest
        jeden dla obu torów, więc plan jest pierwszym miejscem, w którym <code>hero:ewa</code>{" "}
        zamienia się w plik. Bez wskazania artefaktu to sam plan; z nim dochodzi cały złożony tekst.
      </p>
      <div className="send">
        <div className="field">
          <label htmlFor="plan-track">Tor</label>
          <select id="plan-track" onChange={chooseTrack} value={track}>
            {TRACKS.map((one) => (
              <option key={one} value={one}>
                {one}
              </option>
            ))}
          </select>
        </div>
        <Field
          id="plan-artifact"
          label="Artefakt"
          onValue={setArtifact}
          placeholder="opening-frame"
          value={artifact}
        />
      </div>
      <Action argv={argv} disabled={running} label="Pokaż plan wysyłki" onRun={onRun} />

      {plan === null ? null : (
        <>
          <dl className="verdict">
            <div>
              <dt>Tor</dt>
              <dd>{plan.track}</dd>
            </div>
            <div>
              <dt>Kadr</dt>
              <dd>
                {plan.size} ({plan.aspectRatio})
              </dd>
            </div>
            <div>
              <dt>Limit referencji</dt>
              <dd>{plan.limit}</dd>
            </div>
          </dl>
          <Problems problems={plan.problems} />
          <ol className="plan">
            {plan.artifacts.map((one) => (
              <Planned artifact={one} key={one.name} />
            ))}
          </ol>
        </>
      )}
    </>
  );
}

export function PromptPackagePanel(props: PanelProps): JSX.Element {
  const { cell, episodeId, onRun, projectId, run, running } = props;
  const status = cell.status as PromptPackageStatus | null;
  const manifest = useArtifactText(
    { artifact: "manifest", episodeId, projectId, stage: "prompt-package" },
    cell.state
  );
  const [flags, setFlags] = useState<SendFlags>(NO_FLAGS);
  const [plan, setPlan] = useState<SendPlan | null>(null);
  const check = useMemo(
    () => INTENTS.checkPromptPackage({ episodeId, projectId }),
    [episodeId, projectId]
  );
  const approve = useMemo(
    () => INTENTS.approvePromptPackage({ episodeId, projectId }),
    [episodeId, projectId]
  );
  const preview = useMemo(
    () =>
      INTENTS.previewPromptPackage({
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

  /** The plan on screen is the one the last `show` answered with, or none. */
  useEffect(() => {
    if (sent === null || !(sent.includes("show") && run?.ok === true)) {
      setPlan(null);

      return;
    }

    try {
      setPlan(JSON.parse(run.data) as SendPlan);
    } catch {
      setPlan(null);
    }
  }, [run, sent]);

  return (
    <section aria-labelledby="package-title" className="panel">
      <h2 id="package-title">
        Etap {cell.stage}: {cell.title}
      </h2>

      {status === null ? (
        <p className="panel-empty">Ten etap nie odpowiedział; drabina pokazuje powód.</p>
      ) : (
        <>
          <dl className="verdict">
            <div>
              <dt>Stan plików</dt>
              <dd>{status.status}</dd>
            </div>
            <div>
              <dt>Zatwierdzony</dt>
              <dd>{status.approved ? "tak" : "nie"}</dd>
            </div>
            {status.verdict === null ? null : (
              <>
                <div>
                  <dt>Graf</dt>
                  <dd>
                    referencje: {status.verdict.references.length}, klipy:{" "}
                    {status.verdict.clips.length}
                  </dd>
                </div>
                <div>
                  <dt>Obrazy postaci</dt>
                  <dd>
                    {status.verdict.heroes.length === 0 ? "brak" : status.verdict.heroes.join(", ")}
                  </dd>
                </div>
              </>
            )}
          </dl>

          {status.verdict === null ? null : (
            <ul className="references">
              {status.verdict.references.map((one) => (
                <li key={one.id}>
                  <code>{one.id}</code> ({one.kind}) {one.subject}
                  {one.dependsOn.length === 0 ? null : <span> ← {one.dependsOn.join(", ")}</span>}
                </li>
              ))}
            </ul>
          )}

          <Drift
            paths={status.inputsChanged}
            title="Dryf wejść: te pliki zmieniły się po napisaniu pakietu"
          />
          <Problems problems={status.problems} />
        </>
      )}

      <Review
        approve={approve}
        check={check}
        note="„Zatwierdź” pojawia się dopiero, gdy check nie zgłasza problemów, a pakiet czeka na przyjęcie. Tak samo odmówiłby terminal."
        onRun={startRun}
        running={running}
        status={status}
      />

      <Sending
        episodeId={episodeId}
        onRun={startRun}
        plan={plan}
        projectId={projectId}
        running={running}
      />

      <PaidCall
        note="Etap 4 kupuje dokładnie jedno wywołanie tekstowe. „Generuj” niczego nie wysyła i nie czyta klucza: pokazuje cały prompt i rachunek. Dopiero „Kup” płaci, i płaci za to, co pokazał podgląd."
        onRun={startRun}
        preview={preview}
        projectRun={run}
        running={running}
        sent={sent}
      >
        <SendFields
          id="package-send"
          modelPlaceholder="AIMATOR_PROMPTS_MODEL"
          onChange={setFlags}
          tokensPlaceholder="32000"
          value={flags}
        />
      </PaidCall>

      <RunOutput run={run} running={running} />

      <h3>Manifest</h3>
      {manifest === null ? (
        <p className="panel-empty">Nie ma jeszcze pliku pakietu.</p>
      ) : (
        <pre className="artifact-text">{manifest}</pre>
      )}
    </section>
  );
}
