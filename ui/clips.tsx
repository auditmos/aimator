import { type ChangeEvent, type JSX, useCallback, useEffect, useMemo, useState } from "react";
import { INTENTS } from "../src/ui/commands.js";
import {
  Action,
  artifactUrl,
  type Billed,
  Block,
  Drift,
  Field,
  PaidCall,
  PickBox,
  type Priced,
  Problems,
  pickable,
  promptsOf,
  type Unit,
} from "./panel";
import type { ClipState, ClipsStatus, MediaReport, RunDone, StatusCell } from "./types";

/**
 * Stage 7: the first panel a person **watches**, and the first with two bills.
 *
 * Three things are its own and everything else is borrowed from the stages
 * above it.
 *
 * **Two media, one review.** A clip and the frame it starts on are bought by
 * two different models and accepted in one sitting, so they are one list with
 * a kind rather than two lists somebody would have to put back in order. That
 * is why the media element differs per row and the arrangement around it does
 * not.
 *
 * **Two bills, never added up.** An entry frame is an image and a clip is a
 * video, and they cost differently by an order of magnitude, so one total
 * would be a number nobody is billed. The preview prints both, in the stage's
 * own counting, which is the whole of the PRD's rule about units.
 *
 * **The chain is the blockade.** Everything above this waits on a stage or on
 * a sibling; here C02's entry frame waits for the accepted **end** of C01,
 * which waits for C01 itself, which waits for the opening frame. Every link is
 * a person saying yes, so the blocked rows are shown rather than hidden, each
 * carrying the stage's own sentence about which yes is missing.
 */

interface PanelProps {
  readonly cell: StatusCell;
  readonly episodeId: string;
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  readonly run: RunDone | null;
  readonly running: boolean;
}

/** The two things stage 7 buys, each counted in its own word. */
const FRAMES: Unit = ["klatka wejściowa", "klatki wejściowe", "klatek wejściowych"];
const VIDEOS: Unit = ["klip", "klipy", "klipów"];

/**
 * Stage 7's reading of its own report: two numbers, side by side.
 *
 * It lives here rather than in `panel.tsx` because it is the only stage that
 * counts this way. What is shared is the arrangement around a bill, which is
 * in `PaidCall`; what a stage is billed in is the stage's own answer.
 */
function asMedia(report: MediaReport): Priced {
  const billed: readonly Billed[] = [
    { count: report.paidImages, unit: FRAMES },
    { count: report.paidVideos, unit: VIDEOS },
  ];

  return { billed, prompts: promptsOf(report.artifacts) };
}

/** What the state of one link means, in the word a person reads. */
const LINK_STATE: Record<ClipState["state"], string> = {
  absent: "jeszcze nie powstał",
  completed: "gotowy, czeka na ocenę",
  submitted: "próba przerwana",
};

/**
 * The chain, row by row, with the bytes of each link in it.
 *
 * It is not `Gallery` and the difference is the stage rather than an
 * omission. A gallery shows pictures a stage measured, and takes the width and
 * height off that measurement; stage 7 records a clip's length and frame in
 * one sentence of its own and measures nothing a browser could use for a
 * layout, so the element here is sized by the page and the note is quoted. The
 * checkbox and the state line are the ten lines the two do share, which is one
 * copy short of the threshold this repository promotes at.
 */
function Reel(props: {
  readonly chosen: readonly string[];
  readonly items: readonly ClipState[];
  readonly onToggle: (id: string, wanted: boolean) => void;
  /** Whether an accepted link may be chosen; see `pickable`. */
  readonly unlocked: boolean;
  readonly urlOf: (id: string) => string;
}): JSX.Element {
  const { chosen, items, onToggle, unlocked, urlOf } = props;

  return (
    <ul className="reel">
      {items.map((item) => (
        <Link
          chosen={chosen.includes(item.id)}
          item={item}
          key={item.id}
          onToggle={onToggle}
          unlocked={unlocked}
          url={urlOf(item.id)}
        />
      ))}
    </ul>
  );
}

/**
 * The bytes of one link, in the element its medium is watched in.
 *
 * Neither carries dimensions, and that is the stage rather than an oversight.
 * What stage 7 measured about a clip and a frame is in `note`, as one sentence
 * a person reads; pulling numbers back out of it would be this client learning
 * the CLI's text format, which is the one thing `panel.tsx` says none of these
 * files may do. So the page sizes both, and the sentence stays a sentence.
 */
function Seen(props: { readonly item: ClipState; readonly url: string }): JSX.Element | null {
  const { item, url } = props;

  if (item.state === "absent") {
    return <p className="picture-empty">{LINK_STATE[item.state]}</p>;
  }

  if (item.kind === "entry-frame") {
    // biome-ignore lint/correctness/useImageSize: etap 7 nie podaje wymiarów w polu, tylko w zdaniu
    return <img alt={item.id} className="link-still" loading="lazy" src={url} />;
  }

  // biome-ignore lint/a11y/useMediaCaption: klip jest niemy, napisy to decyzja odcinka i etap 9
  return <video className="link-film" controls preload="metadata" src={url} />;
}

function Link(props: {
  readonly chosen: boolean;
  readonly item: ClipState;
  readonly onToggle: (id: string, wanted: boolean) => void;
  readonly unlocked: boolean;
  readonly url: string;
}): JSX.Element {
  const { chosen, item, onToggle, unlocked, url } = props;

  return (
    <li className={item.approved ? "link picture-approved" : "link"}>
      <PickBox
        approved={item.approved}
        boxId={`clip-${item.id}`}
        chosen={chosen}
        id={item.id}
        onToggle={onToggle}
        unlocked={unlocked}
      />
      <Seen item={item} url={url} />
      <p className="picture-state">
        {item.approved ? "zatwierdzony" : LINK_STATE[item.state]} · {item.note}
      </p>
    </li>
  );
}

export function ClipsPanel(props: PanelProps): JSX.Element {
  const { cell, episodeId, onRun, projectId, run, running } = props;
  const status = cell.status as ClipsStatus | null;
  const track = cell.track ?? "";
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [imageModel, setImageModel] = useState("");
  const [videoModel, setVideoModel] = useState("");
  const [regenerate, setRegenerate] = useState(false);
  /** Republishing rewrites accepted clips on purpose, so it unlocks them too. */
  const [reopen, setReopen] = useState(false);
  const [sent, setSent] = useState<readonly string[] | null>(null);
  const unlocked = regenerate || reopen;
  const selected = useMemo(
    () => pickable(status?.artifacts ?? [], chosen, unlocked),
    [chosen, status, unlocked]
  );
  const scope = useMemo(
    () => ({ artifacts: selected, episodeId, projectId, track }),
    [episodeId, projectId, selected, track]
  );
  const check = useMemo(
    () => INTENTS.checkClips({ episodeId, projectId, track }),
    [episodeId, projectId, track]
  );
  const approve = useMemo(() => INTENTS.approveClips(scope), [scope]);
  const republish = useMemo(() => INTENTS.republishClips(scope), [scope]);
  const preview = useMemo(
    () => INTENTS.previewClips({ ...scope, imageModel, regenerate, videoModel }),
    [imageModel, regenerate, scope, videoModel]
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
  const changeReopen = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setReopen(event.target.checked),
    []
  );
  const urlOf = useCallback(
    (artifact: string) =>
      `${artifactUrl({ artifact, episodeId, projectId, stage: "clips", track })}&v=${encodeURIComponent(cell.state)}`,
    [cell.state, episodeId, projectId, track]
  );

  useEffect(() => {
    setChosen([]);
    setSent(null);
  }, [episodeId, track]);

  const artifacts = status?.artifacts ?? [];
  const picked = artifacts.filter((one) => selected.includes(one.id));
  const acceptable =
    picked.length > 0 && picked.every((one) => one.state === "completed" && !one.approved);
  // A republication rewrites a record out of its own archive, and an entry
  // frame has none to rewrite: it was published exactly as the image model
  // drew it. The CLI refuses the mixed case with a sentence; the button simply
  // does not offer it.
  const republishable = picked.length > 0 && picked.every((one) => one.kind === "clip");
  const drifted = [...new Set(artifacts.flatMap((one) => one.inputsChanged))];

  return (
    <section aria-labelledby="clips-title" className="panel">
      <h2 id="clips-title">
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
            <Drift paths={drifted} title="Wejścia zmieniły się po tej próbie:" />
          </Block>
          <Block
            hint={
              <>
                Klip czeka na klatkę, od której się zaczyna, a klatka wejściowa na zatwierdzoną
                końcówkę klipu przed nią. Pod każdym ogniwem stoi jego stan w słowach etapu, więc
                zablokowane mówi, czyjej zgody brakuje. Zaznaczenie kilku daje jedną komendę z listą{" "}
                <code>--artifact</code>.
              </>
            }
            title="Łańcuch"
          >
            <Reel
              chosen={selected}
              items={artifacts}
              onToggle={toggle}
              unlocked={unlocked}
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
            „Zatwierdź” pojawia się, gdy zaznaczone ogniwa istnieją i czekają na przyjęcie. Tak samo
            odmówiłby terminal.
          </p>
        )}
      </Block>

      <PaidCall
        note="Dwa płatne wywołania w jednym poleceniu, liczone osobno: klatkę wejściową rysuje model obrazowy tego toru, klip renderuje jeden model wideo dla obu torów. Bez zaznaczenia etap kupuje to, na co pozwala łańcuch; zaznaczenie zablokowanego ogniwa to pytanie „dlaczego jeszcze nie”. „Generuj” niczego nie wysyła i nie czyta kluczy; dopiero „Kup” płaci."
        onRun={startRun}
        open={cell.state === "ready"}
        preview={preview}
        projectRun={run}
        read={asMedia}
        running={running}
        sent={sent}
      >
        <div className="send">
          <Field
            id="clips-image-model"
            label="Model obrazowy"
            onValue={setImageModel}
            placeholder="AIMATOR_IMAGE_MODEL_*"
            value={imageModel}
          />
          <Field
            id="clips-video-model"
            label="Model wideo"
            onValue={setVideoModel}
            placeholder="AIMATOR_VIDEO_MODEL"
            value={videoModel}
          />
          <label className="field-check" htmlFor="clips-regenerate">
            <input
              checked={regenerate}
              id="clips-regenerate"
              onChange={changeRegenerate}
              type="checkbox"
            />
            Nowa płatna próba zaznaczonych ogniw
          </label>
        </div>
      </PaidCall>

      <Block
        fold={false}
        hint={
          <>
            Jedyna komenda tego ekranu, która zapisuje, nie płacąc: publikuje zaznaczone klipy
            jeszcze raz z ich własnego archiwum, nie wysyłając niczego i nie czytając klucza. Cofa
            przy tym ocenę, więc wymaga wskazania celu. Klatki wejściowej nie dotyczy: ta została
            opublikowana dokładnie tak, jak narysował ją model.
          </>
        }
        title="Publikacja z archiwum (bez płacenia)"
      >
        <div className="send">
          <label className="field-check" htmlFor="clips-reopen">
            <input checked={reopen} id="clips-reopen" onChange={changeReopen} type="checkbox" />
            Pozwól wybrać zatwierdzone klipy (publikacja cofa ich ocenę)
          </label>
        </div>
        {republishable ? (
          <Action argv={republish} disabled={running} label="Opublikuj ponownie" onRun={startRun} />
        ) : (
          <p className="actions-note">
            „Opublikuj ponownie” pojawia się, gdy zaznaczone są same klipy.
          </p>
        )}
      </Block>
    </section>
  );
}
