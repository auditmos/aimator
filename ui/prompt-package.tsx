import { type JSX, useCallback, useEffect, useMemo, useState } from "react";
import { commandLine, INTENTS } from "../src/ui/commands.js";
import {
  artifactUrl,
  asCalls,
  Block,
  Drift,
  Lightbox,
  NO_FLAGS,
  PaidCall,
  type Picture,
  Problems,
  Review,
  SendFields,
  type SendFlags,
  useArtifactText,
  Zoomable,
} from "./panel";
import type {
  PlannedArtifact,
  PromptPackageStatus,
  Refusal,
  RunDone,
  SendPlan,
  StatusCell,
} from "./types";

/**
 * Stage 4: the package both tracks read, reviewed as what it will send.
 *
 * What a person approves here is a plan for every future paid picture and
 * clip: which images each one carries, in which order, and the text around
 * them. A graph of ids is not something anybody can judge, so the panel shows
 * the plan the way the sender will compose it, one call at a time: the
 * attachments as pictures, numbered `Image N` in the order the request carries
 * them, beside the whole prompt that addresses them by that number. That is
 * rule 8 on screen, and `prompt-package show` is the only place it becomes
 * visible before anything is sent.
 *
 * It asks for a **track** although the package names none, because what
 * `hero:ewa` and `R01` become is decided at the sender, per track. The plan is
 * read, never run: it is free and writes nothing, so it arrives over a plain
 * GET and is asked again whenever the ladder moves, rather than passing
 * through the dock like a command somebody chose to execute.
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

/** What each kind of future call is, in the words of the ladder. */
const KIND: Record<string, string> = {
  clip: "klip",
  "entry-frame": "klatka wejściowa",
  opening: "klatka otwarcia",
  reference: "referencja",
};

/** The two shapes of attachment id whose file the sender picks per track. */
const HERO = /^hero:(.+)$/;
const REFERENCE = /^R\d+$/;
const END = /^end:/;

type Read<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "shown"; readonly value: T };

/**
 * One `prompt-package show`, asked again whenever `revision` changes.
 *
 * A failed read keeps nothing stale on screen for a different question: the
 * answer is tied to the URL that asked it, so switching tracks never shows
 * the other track's plan under this one's name while the new one loads.
 */
function useSendPlan(url: string, revision: object | null): Read<SendPlan> {
  const [read, setRead] = useState<{ readonly url: string; readonly read: Read<SendPlan> }>({
    read: { kind: "loading" },
    url,
  });

  useEffect(() => {
    // Nothing to read against before the ladder has answered once.
    if (revision === null) {
      return;
    }

    let cancelled = false;

    fetch(url)
      .then(async (response) => (await response.json()) as SendPlan | Refusal)
      .then((body) => {
        if (!cancelled) {
          setRead({
            read:
              "error" in body
                ? { kind: "refused", message: body.error.message }
                : { kind: "shown", value: body },
            url,
          });
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [revision, url]);

  return read.url === url ? read.read : { kind: "loading" };
}

/**
 * Where an attachment's bytes are served, or nothing.
 *
 * The ids are the ones `--artifact` already takes at each stage that draws
 * them, so this is the same address the stage's own panel shows the picture
 * under. `end:Cnn` has none: its file is whatever the video provider returned,
 * and the resolver deliberately refuses to guess an extension.
 */
function attachmentUrl(
  id: string,
  axes: { readonly episodeId: string; readonly projectId: string; readonly track: string },
  sha256: string | null
): string | null {
  const { episodeId, projectId, track } = axes;
  const hero = HERO.exec(id);
  const url = ((): string | null => {
    if (hero?.[1] !== undefined) {
      return artifactUrl({
        artifact: "hero",
        characterId: hero[1],
        projectId,
        stage: "character",
        track,
      });
    }
    if (id === "opening-frame") {
      return artifactUrl({ artifact: id, episodeId, projectId, stage: "opening-frame", track });
    }
    if (id.startsWith("entry:")) {
      return artifactUrl({ artifact: id, episodeId, projectId, stage: "clips", track });
    }

    return REFERENCE.test(id)
      ? artifactUrl({ artifact: id, episodeId, projectId, stage: "references", track })
      : null;
  })();

  // The digest is the cache key: a redrawn picture is a new address.
  return url === null ? null : `${url}&v=${sha256 ?? "none"}`;
}

/**
 * `end:Cnn`, shown as the clip it is the last frame of, stopped at its end.
 *
 * The frame itself has no address the resolver will build (see
 * `attachmentUrl`), but the clip it was cut from does, and a media fragment
 * past the clip's length lands on its last frame, which is the picture the
 * next entry frame is told to reproduce.
 */
function EndOf(props: {
  readonly axes: { readonly episodeId: string; readonly projectId: string; readonly track: string };
  readonly id: string;
  readonly seconds: number | null;
}): JSX.Element {
  const { axes, id, seconds } = props;
  const clip = id.replace(END, "");

  if (seconds === null || clip === id) {
    return <p className="picture-empty">ostatnia klatka poprzedniego klipu</p>;
  }

  const url = artifactUrl({ artifact: clip, ...axes, stage: "clips" });

  return <video className="attached-video" muted preload="auto" src={`${url}#t=${seconds}`} />;
}

/** One call of the plan: its attachments as pictures, then the whole prompt. */
function Call(props: {
  readonly artifact: PlannedArtifact;
  readonly episodeId: string;
  readonly projectId: string;
  readonly revision: object | null;
  readonly clipSeconds: ReadonlyMap<string, number>;
  readonly subject: string | null;
  readonly track: string;
}): JSX.Element {
  const { artifact, clipSeconds, episodeId, projectId, revision, subject, track } = props;
  const [shown, setShown] = useState<string | null>(null);
  const query = new URLSearchParams({ artifact: artifact.name, track });
  const whole = useSendPlan(
    `/api/send-plan/${projectId}/${episodeId}?${query.toString()}`,
    revision
  );
  const text =
    whole.kind === "shown"
      ? (whole.value.artifacts.find((one) => one.name === artifact.name)?.text ?? null)
      : null;
  const attached = useMemo(
    () =>
      artifact.attachments.map((one, index) => ({
        ...one,
        label: `Image ${index + 1}`,
        url: attachmentUrl(one.id, { episodeId, projectId, track }, one.sha256),
      })),
    [artifact, episodeId, projectId, track]
  );
  const pictures = useMemo(
    () =>
      attached.flatMap((one): Picture[] =>
        one.url === null
          ? []
          : [
              {
                caption: `${one.label} · ${one.role} · ${STATE[one.state]}`,
                id: one.id,
                url: one.url,
              },
            ]
      ),
    [attached]
  );
  const argv = INTENTS.showSendPlan({ artifact: artifact.name, episodeId, projectId, track });

  return (
    <div className="call">
      <p className="call-name">
        <code>{artifact.name}</code> {KIND[artifact.kind] ?? artifact.kind}
        {artifact.seconds === null ? null : <span> · {artifact.seconds} s</span>}
        {subject === null ? null : <span> · {subject}</span>}
        <span
          className={artifact.blockers.length === 0 ? "state state-ready" : "state state-blocked"}
        >
          {artifact.blockers.length === 0 ? "gotowy do wysłania" : "zablokowany"}
        </span>
      </p>
      <Problems problems={artifact.blockers} />

      <h4 className="call-heading">Załączniki, w kolejności wysyłki</h4>
      <ol className="attached">
        {attached.map((one) => (
          <li
            className={one.state === "approved" ? "attached-one" : "attached-one attached-open"}
            key={one.id}
          >
            <p className="attached-label">
              <strong>{one.label}</strong> = <code>{one.id}</code>
            </p>
            {one.url === null ? (
              <EndOf
                axes={{ episodeId, projectId, track }}
                id={one.id}
                seconds={clipSeconds.get(one.id.replace(END, "")) ?? null}
              />
            ) : (
              <Zoomable id={one.id} onShow={setShown}>
                {/* biome-ignore lint/correctness/useImageSize: plan wysyłki nie podaje wymiarów załącznika */}
                <img alt={one.id} loading="lazy" src={one.url} />
              </Zoomable>
            )}
            <p className="picture-state">
              {STATE[one.state]} · {one.role}
            </p>
          </li>
        ))}
      </ol>
      <Lightbox onShow={setShown} pictures={pictures} shown={shown} />

      <h4 className="call-heading">Prompt, dokładnie tak, jak poleci</h4>
      {whole.kind === "refused" ? (
        <p className="refusal" role="alert">
          {whole.message}
        </p>
      ) : null}
      {text === null ? (
        <p className="panel-empty">
          {whole.kind === "loading" ? "Składam prompt…" : "Bez tekstu."}
        </p>
      ) : (
        <pre className="artifact-text call-text">{text}</pre>
      )}
      <code className="command">{commandLine(argv)}</code>
    </div>
  );
}

/**
 * The plan of one track, one call at a time.
 *
 * The calls are listed in the order the pipeline buys them, grouped by what
 * they are, and one is open at a time: twenty-two prompts of thirteen
 * thousand characters each are a document nobody reads, while one of them
 * beside its pictures is a decision somebody can make.
 */
function PlanReview(props: {
  readonly episodeId: string;
  readonly projectId: string;
  readonly revision: object | null;
  readonly subjects: ReadonlyMap<string, string>;
}): JSX.Element {
  const { episodeId, projectId, revision, subjects } = props;
  const [track, setTrack] = useState<string>(TRACKS[0]);
  const [chosen, setChosen] = useState<string | null>(null);
  const plan = useSendPlan(
    `/api/send-plan/${projectId}/${episodeId}?${new URLSearchParams({ track }).toString()}`,
    revision
  );
  const artifacts = plan.kind === "shown" ? plan.value.artifacts : [];
  const open = artifacts.find((one) => one.name === chosen) ?? artifacts[0];
  /** How long each clip is planned to run, which is where its last frame sits. */
  const clipSeconds = useMemo(
    () =>
      new Map(
        artifacts.flatMap((one) => (one.seconds === null ? [] : [[one.name, one.seconds] as const]))
      ),
    [artifacts]
  );
  const groups = useMemo(
    () =>
      [
        ["Referencje", artifacts.filter((one) => one.kind === "reference")],
        ["Kadry i klipy", artifacts.filter((one) => one.kind !== "reference")],
      ] as const,
    [artifacts]
  );
  const pick = useCallback((name: string) => () => setChosen(name), []);
  const pickTrack = useCallback((one: string) => () => setTrack(one), []);

  return (
    <div className="plan-review">
      <div className="plan-row">
        <span className="plan-row-label">Tor</span>
        {TRACKS.map((one) => (
          <button
            aria-pressed={one === track}
            className="plan-chip"
            key={one}
            onClick={pickTrack(one)}
            type="button"
          >
            {one}
          </button>
        ))}
      </div>

      {plan.kind === "loading" ? <p className="panel-empty">Czytam plan wysyłki…</p> : null}
      {plan.kind === "refused" ? (
        <p className="refusal" role="alert">
          {plan.message}
        </p>
      ) : null}
      {plan.kind === "shown" ? (
        <>
          <p className="actions-note">
            Kadr {plan.value.size} ({plan.value.aspectRatio}), najwyżej {plan.value.limit}{" "}
            załączników na wywołanie.
          </p>
          {plan.value.problems.length === 0 ? null : (
            <details className="prompt">
              <summary>Co jeszcze blokuje wysyłkę ({plan.value.problems.length})</summary>
              <Problems problems={plan.value.problems} />
            </details>
          )}
          {groups.map(([label, members]) =>
            members.length === 0 ? null : (
              <div className="plan-row" key={label}>
                <span className="plan-row-label">{label}</span>
                {members.map((one) => (
                  <button
                    aria-pressed={one.name === open?.name}
                    className={
                      one.blockers.length === 0 ? "plan-chip" : "plan-chip plan-chip-blocked"
                    }
                    key={one.name}
                    onClick={pick(one.name)}
                    type="button"
                  >
                    {one.name}
                  </button>
                ))}
              </div>
            )
          )}
          {open === undefined ? null : (
            <Call
              artifact={open}
              clipSeconds={clipSeconds}
              episodeId={episodeId}
              key={`${track}-${open.name}`}
              projectId={projectId}
              revision={revision}
              subject={subjects.get(open.name) ?? null}
              track={track}
            />
          )}
        </>
      ) : null}
    </div>
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
  /** What the manifest says each reference is, beside the call that draws it. */
  const subjects = useMemo(
    () => new Map((status?.verdict?.references ?? []).map((one) => [one.id, one.subject])),
    [status]
  );

  useEffect(() => setSent(null), [episodeId, projectId]);

  return (
    <section aria-labelledby="package-title" className="panel">
      <h2 id="package-title">
        Etap {cell.stage}: {cell.title}
      </h2>

      {status === null ? (
        <p className="panel-empty">Ten etap nie odpowiedział; drabina pokazuje powód.</p>
      ) : (
        <Block title="Stan">
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

          <Drift
            paths={status.inputsChanged}
            title="Dryf wejść: te pliki zmieniły się po napisaniu pakietu"
          />
          <Problems problems={status.problems} />
        </Block>
      )}

      <Block
        hint={
          <>
            Pakiet to plan każdego przyszłego płatnego obrazu i klipu, wspólny dla obu torów.
            Wybierz wywołanie i sprawdź dwie rzeczy: czy załączniki to właściwe obrazy we właściwej
            kolejności, i czy prompt, który odwołuje się do nich jako <code>Image 1</code>,{" "}
            <code>Image 2</code>…, opisuje to, co ma powstać. Klip dostaje tylko swoją klatkę
            wejściową, więc referencje do klipu ocenia się przy jego <code>entry:</code>. Załącznik,
            którego jeszcze nie ma, powstanie w etapie 5 lub później. Nic tu nie płaci, a
            zatwierdzenie tylko otwiera etap 5.
          </>
        }
        title="Pakiet: co poleci do modelu"
      >
        {status?.status === "completed" ? (
          <PlanReview
            episodeId={episodeId}
            projectId={projectId}
            revision={cell.status}
            subjects={subjects}
          />
        ) : (
          <p className="panel-empty">Nie ma jeszcze pakietu do przejrzenia.</p>
        )}
        {manifest === null ? null : (
          <details className="prompt">
            <summary>Manifest (surowy plik)</summary>
            <pre className="artifact-text">{manifest}</pre>
          </details>
        )}
      </Block>

      <Block className="block-decision" title="Decyzja">
        <Review
          approve={approve}
          check={check}
          note="„Zatwierdź” pojawia się dopiero, gdy check nie zgłasza problemów, a pakiet czeka na przyjęcie. Tak samo odmówiłby terminal."
          onRun={startRun}
          running={running}
          status={status}
        />
      </Block>

      <PaidCall
        note="Etap 4 kupuje dokładnie jedno wywołanie tekstowe. „Generuj” niczego nie wysyła i nie czyta klucza: pokazuje cały prompt i rachunek. Dopiero „Kup” płaci, i płaci za to, co pokazał podgląd."
        onRun={startRun}
        open={cell.state === "ready"}
        preview={preview}
        projectRun={run}
        read={asCalls}
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
    </section>
  );
}
