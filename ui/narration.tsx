import { type ChangeEvent, type JSX, useCallback, useEffect, useMemo, useState } from "react";
import { INTENTS } from "../src/ui/commands.js";
import {
  Action,
  artifactUrl,
  type Billed,
  Block,
  Drift,
  Field,
  NO_FLAGS,
  Notices,
  PaidCall,
  PickAll,
  PickBox,
  type Priced,
  Problems,
  pickable,
  SendFields,
  type SendFlags,
  type Unit,
  useArtifactText,
} from "./panel";
import type {
  LineState,
  MixReport,
  MixStatus,
  NarrationReport,
  NarrationStatus,
  RunDone,
  StatusCell,
} from "./types";

/**
 * Stage 9: one stage, **two panels**, because its artifacts live at two levels.
 *
 * The words are shared by both tracks: a voice reading a sentence has no idea
 * which of the two films it will sit over, so the script and every recording
 * are bought once and reviewed once. The mix is per track, because only the
 * mix is timed against a particular cut, and the two cuts came back with
 * different drift. So `--track` is not a narrowing here but the choice of
 * question, and a single panel would have had to pretend one of the two.
 *
 * Three things are this panel's own.
 *
 * **The bill stops being the call count.** Every stage above this one is
 * billed per call; this provider charges for the characters of the text it is
 * handed, so both numbers stand beside the button that spends, and the
 * continuity characters stand *beside* the bill rather than in it, because the
 * provider does not say whether it charges for them.
 *
 * **Approving means listening.** A recording judged by its file name is the
 * gap this whole screen exists to close, exactly as it was for an image at
 * stage 2, so every bought line is an audio element with its own checkbox.
 *
 * **Direction is a form, and it is here rather than in stage 0.** How the
 * narrator reads is dialled in by ear over several attempts. Beside the voice
 * in `project.json` it would have been a recorded input of nearly every
 * artifact in the workspace, so moving it a tenth would have lapsed approvals
 * on bytes it never touched. The voice is casting; the reading is direction.
 */

interface PanelProps {
  readonly cell: StatusCell;
  readonly episodeId: string;
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  readonly run: RunDone | null;
  readonly running: boolean;
}

/** The three units stage 9 counts in, none of which is ever added to another. */
const TEXT_CALLS: Unit = [
  "płatne wywołanie tekstowe",
  "płatne wywołania tekstowe",
  "płatnych wywołań tekstowych",
];
const SPOKEN: Unit = ["kwestia", "kwestie", "kwestii"];
const CHARACTERS: Unit = ["znak", "znaki", "znaków"];

/** What the state of one reviewed thing means, in the word a person reads. */
const LINE_STATE: Record<LineState["state"], string> = {
  absent: "jeszcze nie powstała",
  completed: "gotowa, czeka na ocenę",
  submitted: "próba przerwana",
};

/**
 * Stage 9's reading of its own report, which is **two readings under one flag**.
 *
 * The same command does two different purchases and the report says which:
 * until the script exists and a human has accepted it, what would be bought is
 * one text call; afterwards it is the lines that yes authorised, billed in
 * characters. Printing the speech bill during the first phase would have shown
 * a person `0` beside a button that was about to spend.
 */
function asVoice(report: NarrationReport): Priced {
  const prompts =
    report.prompt === null
      ? []
      : [{ label: "Prompt, który poleci do modelu tekstowego", text: report.prompt }];

  if (report.script.state === "planned" || report.script.state === "blocked") {
    return {
      aside: report.script.note,
      billed: [{ count: report.script.state === "planned" ? 1 : 0, unit: TEXT_CALLS }],
      prompts,
    };
  }

  const billed: readonly Billed[] = [
    { count: report.calls, unit: SPOKEN },
    { count: report.characters, unit: CHARACTERS },
  ];

  return {
    ...(report.contextCharacters === 0
      ? {}
      : {
          aside: `Obok rachunku, nie w nim: ${report.contextCharacters} znaków kontekstu (previous_text/next_text). Dostawca dokumentuje te parametry i nie mówi, czy je rozlicza, więc narzędzie nie zgaduje cudzymi pieniędzmi.`,
        }),
    billed,
    prompts,
  };
}

/** One bought line, listened to rather than looked at, with its own checkbox. */
function Heard(props: {
  readonly chosen: boolean;
  readonly item: LineState;
  readonly onToggle: (id: string, wanted: boolean) => void;
  /** Whether an accepted line may be chosen; see `pickable`. */
  readonly unlocked: boolean;
  readonly url: string;
}): JSX.Element {
  const { chosen, item, onToggle, unlocked, url } = props;

  return (
    <li className={item.approved ? "link picture-approved" : "link"}>
      <PickBox
        approved={item.approved}
        boxId={`line-${item.id}`}
        chosen={chosen}
        id={item.id}
        onToggle={onToggle}
        unlocked={unlocked}
      />
      {item.state === "absent" ? (
        <p className="picture-empty">{LINE_STATE[item.state]}</p>
      ) : (
        // biome-ignore lint/a11y/useMediaCaption: kwestia JEST tekstem, który stoi obok niej w skrypcie
        <audio className="line-audio" controls preload="metadata" src={url} />
      )}
      <p className="picture-state">
        {item.approved ? "zatwierdzona" : LINE_STATE[item.state]} · {item.note} · {item.characters}{" "}
        znaków
        {item.seconds === null ? "" : ` · ${item.seconds}s`}
      </p>
    </li>
  );
}

/** How the narrator of this series reads: five knobs, none of them a default. */
interface DeliveryForm {
  readonly similarity: string;
  readonly speakerBoost: boolean;
  readonly speed: string;
  readonly stability: string;
  readonly style: string;
}

const NO_DELIVERY: DeliveryForm = {
  similarity: "",
  speakerBoost: false,
  speed: "",
  stability: "",
  style: "",
};

export function NarrationPanel(props: PanelProps): JSX.Element {
  const { cell, episodeId, onRun, projectId, run, running } = props;
  const status = cell.status as NarrationStatus | null;
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [flags, setFlags] = useState<SendFlags>(NO_FLAGS);
  const [voiceModel, setVoiceModel] = useState("");
  const [delivery, setDelivery] = useState<DeliveryForm>(NO_DELIVERY);
  const [sent, setSent] = useState<readonly string[] | null>(null);
  const scope = useMemo(() => ({ episodeId, projectId }), [episodeId, projectId]);
  // An accepted kwestia stays ticked and locked unless a new paid attempt is what
  // is being chosen for.
  const selected = useMemo(
    () => pickable(status?.lines ?? [], chosen, flags.regenerate),
    [chosen, flags.regenerate, status]
  );
  const check = useMemo(() => INTENTS.checkNarration(scope), [scope]);
  const approveScript = useMemo(() => INTENTS.approveNarrationScript(scope), [scope]);
  const approveLines = useMemo(
    () => INTENTS.approveNarrationLines({ ...scope, artifacts: selected }),
    [scope, selected]
  );
  const preview = useMemo(
    () =>
      INTENTS.previewNarration({
        ...scope,
        artifacts: selected,
        maxOutputTokens: flags.tokens,
        model: flags.model,
        regenerate: flags.regenerate,
        voiceModel,
      }),
    [flags, scope, selected, voiceModel]
  );
  const direct = useMemo(
    () => INTENTS.directNarrator({ ...delivery, projectId }),
    [delivery, projectId]
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
  const changeBoost = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setDelivery((current) => ({ ...current, speakerBoost: event.target.checked })),
    []
  );
  const changeStability = useCallback(
    (stability: string) => setDelivery((current) => ({ ...current, stability })),
    []
  );
  const changeStyle = useCallback(
    (style: string) => setDelivery((current) => ({ ...current, style })),
    []
  );
  const changeSpeed = useCallback(
    (speed: string) => setDelivery((current) => ({ ...current, speed })),
    []
  );
  const changeSimilarity = useCallback(
    (similarity: string) => setDelivery((current) => ({ ...current, similarity })),
    []
  );
  const urlOf = useCallback(
    (artifact: string) =>
      `${artifactUrl({ artifact, episodeId, projectId, stage: "soundtrack" })}&v=${encodeURIComponent(cell.state)}`,
    [cell.state, episodeId, projectId]
  );

  useEffect(() => {
    setChosen([]);
    setSent(null);
  }, [episodeId]);

  const script = useArtifactText(
    { artifact: "script", episodeId, projectId, stage: "soundtrack" },
    cell.state
  );
  const lines = status?.lines ?? [];
  const picked = lines.filter((one) => selected.includes(one.id));
  const scriptAcceptable =
    status !== null && status.script.state === "completed" && !status.script.approved;
  const linesAcceptable =
    picked.length > 0 && picked.every((one) => one.state === "completed" && !one.approved);
  const drifted = [
    ...new Set([...(status?.script.inputsChanged ?? []), ...lines.flatMap((o) => o.inputsChanged)]),
  ];

  return (
    <section aria-labelledby="narration-title" className="panel">
      <h2 id="narration-title">
        Etap {cell.stage}: {cell.title}
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
                <dt>Cały skrypt</dt>
                <dd>{status.totalCharacters} znaków</dd>
              </div>
              <div>
                <dt>Dalej</dt>
                <dd>{status.nextStep}</dd>
              </div>
            </dl>

            <Problems problems={status.problems} />
            <Notices notices={status.notices} />
            <Drift paths={drifted} title="Wejścia zmieniły się po tej próbie:" />
          </Block>

          <Block
            hint={
              <>
                Narracja jest <strong>podnoszona, nie pisana</strong>: każde zdanie musi wystąpić co
                do słowa w polu <code>Audio</code> ujęcia, które nazywa, a walidator to sprawdza.
                Jeśli film ma powiedzieć coś nowego, poprawka należy do etapu 1, nie tutaj.
                Zatwierdzenie skryptu jest osobną decyzją od zatwierdzenia nagrań i to ono otwiera
                zakup.
              </>
            }
            title="Skrypt narracji"
          >
            <p className="picture-state">
              {status.script.approved ? "zatwierdzony" : LINE_STATE[status.script.state]} ·{" "}
              {status.script.note}
            </p>
            {script === null ? null : <pre className="artifact-text">{script}</pre>}
          </Block>

          <Block
            hint={
              <>
                Kwestie są <strong>wspólne dla obu torów</strong>: głos czytający zdanie nie wie,
                nad którym filmem usiądzie. Odsłuchaj i zaznacz; zaznaczenie kilku daje jedną
                komendę z listą <code>--artifact</code>.
              </>
            }
            title="Nagrania"
          >
            <PickAll
              chosen={selected}
              id="line-all"
              items={lines}
              onChoose={setChosen}
              unlocked={flags.regenerate}
            />
            <ul className="reel">
              {lines.map((item) => (
                <Heard
                  chosen={selected.includes(item.id)}
                  item={item}
                  key={item.id}
                  onToggle={toggle}
                  unlocked={flags.regenerate}
                  url={urlOf(item.id)}
                />
              ))}
            </ul>
          </Block>
        </>
      )}

      {/* Two yeses live in this stage, the script's and the recordings', and
          both belong where the decision is rather than beside what they are
          about, so the one bar that follows the page carries both. */}
      <Block className="block-decision" title="Decyzja">
        <Action argv={check} disabled={running} label="Sprawdź" onRun={startRun} />
        {scriptAcceptable ? (
          <Action
            argv={approveScript}
            disabled={running}
            label="Zatwierdź skrypt"
            onRun={startRun}
            primary
          />
        ) : null}
        {linesAcceptable ? (
          <Action
            argv={approveLines}
            disabled={running}
            label="Zatwierdź kwestie"
            onRun={startRun}
            primary
          />
        ) : null}
        {scriptAcceptable || linesAcceptable ? null : (
          <p className="actions-note">
            „Zatwierdź skrypt” pojawia się, gdy skrypt istnieje i czeka na przyjęcie; „Zatwierdź
            kwestie”, gdy zaznaczone nagrania istnieją i czekają na przyjęcie. Tak samo odmówiłby
            terminal.
          </p>
        )}
      </Block>

      <PaidCall
        note="Jedno polecenie, dwa zakupy, a raport mówi który: dopóki skryptu nie ma, kupuje się jedno wywołanie tekstowe; po jego zatwierdzeniu kupuje się kwestie, które ta zgoda otworzyła. Dostawca mowy liczy ZNAKI, nie wywołania, więc rachunek podaje jedno i drugie. „Generuj” niczego nie wysyła i nie czyta kluczy; dopiero „Kup” płaci."
        onRun={startRun}
        open={cell.state === "ready"}
        preview={preview}
        projectRun={run}
        read={asVoice}
        running={running}
        sent={sent}
      >
        <SendFields
          id="narration"
          modelPlaceholder="AIMATOR_NARRATION_MODEL"
          onChange={setFlags}
          tokensPlaceholder="12000"
          value={flags}
        />
        <div className="send">
          <Field
            id="narration-voice-model"
            label="Model mowy"
            onValue={setVoiceModel}
            placeholder="AIMATOR_VOICE_MODEL"
            value={voiceModel}
          />
        </div>
      </PaidCall>

      <Block
        fold={false}
        hint={
          <>
            Głos to <strong>obsada</strong> i mieszka w <code>project.json</code> od etapu 0; to,
            jak on gra, to <strong>reżyseria</strong> i mieszka w pliku, który należy do tego etapu.
            Nie jest to kaprys układu: <code>project.json</code> jest zapisanym wejściem niemal
            wszystkiego w katalogu roboczym, więc suwak, który ma się kręcić, unieważniałby zgody na
            bajty, których nie dotknął o ani jeden bit. Tutaj unieważnia dokładnie te nagrania,
            które powstały pod starym brzmieniem. Puste pole to brak decyzji, nie zero: flaga wtedy
            nie pada i zostaje to, co ustawiono ostatnio.
          </>
        }
        title="Reżyseria: jak narrator czyta"
      >
        <div className="send">
          <Field
            id="narration-stability"
            label="stability (niżej = szerszy zakres emocji)"
            onValue={changeStability}
            placeholder="0.5"
            value={delivery.stability}
          />
          <Field
            id="narration-style"
            label="style (wyżej = mocniejszy charakter)"
            onValue={changeStyle}
            placeholder="0"
            value={delivery.style}
          />
          <Field
            id="narration-speed"
            label="speed (poniżej 1 zwalnia)"
            onValue={changeSpeed}
            placeholder="1"
            value={delivery.speed}
          />
          <Field
            id="narration-similarity"
            label="similarity"
            onValue={changeSimilarity}
            placeholder="0.75"
            value={delivery.similarity}
          />
          <label className="field-check" htmlFor="narration-boost">
            <input
              checked={delivery.speakerBoost}
              id="narration-boost"
              onChange={changeBoost}
              type="checkbox"
            />
            speaker-boost
          </label>
        </div>
        <Action argv={direct} disabled={running} label="Zapisz reżyserię" onRun={startRun} />
      </Block>
    </section>
  );
}

/** Where each accepted line landed on this track's own clock, after a mix. */
function Placement(props: { readonly report: MixReport }): JSX.Element {
  const { report } = props;

  return (
    <>
      <dl className="verdict">
        <div>
          <dt>Silnik</dt>
          <dd>{report.engine ?? "nieustalony"}</dd>
        </div>
        <div>
          <dt>Film trwa</dt>
          <dd>{report.actualSeconds}s</dd>
        </div>
      </dl>
      <ul className="cut">
        {report.lines.map((line) => (
          <li key={line.id}>
            <code>{line.id}</code> · plan {line.plannedSeconds}s → film {line.atSeconds}s ·{" "}
            {line.seconds}s
          </li>
        ))}
      </ul>
      <Problems problems={report.problems} />
      <Notices notices={report.notices} />
    </>
  );
}

export function MixPanel(props: PanelProps): JSX.Element {
  const { cell, episodeId, onRun, projectId, run, running } = props;
  const status = cell.status as MixStatus | null;
  const track = cell.track ?? "";
  const [regenerate, setRegenerate] = useState(false);
  const [sent, setSent] = useState<readonly string[] | null>(null);
  const [placement, setPlacement] = useState<MixReport | null>(null);
  const scope = useMemo(() => ({ episodeId, projectId, track }), [episodeId, projectId, track]);
  const check = useMemo(() => INTENTS.checkMix(scope), [scope]);
  const approve = useMemo(() => INTENTS.approveMix(scope), [scope]);
  const mix = useMemo(() => INTENTS.mixNarration({ ...scope, regenerate }), [regenerate, scope]);
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

  /** Where the lines landed, read out of the report the last mix answered with. */
  useEffect(() => {
    if (sent === null || !(sent.includes("mix") && run?.ok === true)) {
      setPlacement(null);

      return;
    }

    try {
      setPlacement(JSON.parse(run.data) as MixReport);
    } catch {
      setPlacement(null);
    }
  }, [run, sent]);

  useEffect(() => {
    setSent(null);
    setPlacement(null);
  }, [episodeId, track]);

  const narrated = status?.artifact ?? null;
  const acceptable = narrated !== null && narrated.state === "completed" && !narrated.approved;
  const film = `${artifactUrl({ artifact: "narrated", episodeId, projectId, stage: "soundtrack", track })}&v=${encodeURIComponent(cell.state)}`;

  return (
    <section aria-labelledby="mix-title" className="panel">
      <h2 id="mix-title">
        Etap {cell.stage}: {cell.title} · {track}
      </h2>

      {status === null || narrated === null ? (
        <p className="panel-empty">Ten etap nie odpowiedział; drabina pokazuje powód.</p>
      ) : (
        <>
          <Block title="Stan">
            <dl className="verdict">
              <div>
                <dt>Zatwierdzony</dt>
                <dd>{status.approved ? "tak" : "nie"}</dd>
              </div>
              <div>
                <dt>Dalej</dt>
                <dd>{status.nextStep}</dd>
              </div>
            </dl>

            <Problems problems={status.problems} />
            <Notices notices={status.notices} />
            <Drift paths={narrated.inputsChanged} title="Wejścia zmieniły się po tym miksie:" />
          </Block>

          <Block
            hint={
              <>
                <code>episode.mp4</code> nie jest dotykany: to nowy plik, którego obraz jest kopią
                strumieniową zatwierdzonego cięcia, klatka w klatkę. Odsłuchaj, gdzie narrator
                siedzi wobec obrazu: kotwice pochodzą z planu, a klipy wróciły z dryfem, więc to
                jedyne miejsce, w którym słychać, co z tego wyszło.
              </>
            }
            title="Film z narracją"
          >
            {narrated.state === "absent" ? (
              <p className="picture-empty">{LINE_STATE[narrated.state]}</p>
            ) : (
              // biome-ignore lint/a11y/useMediaCaption: napisy to decyzja odcinka z etapu 0, nie tego panelu
              <video className="link-film" controls preload="metadata" src={film} />
            )}
            <p className="picture-state">
              {narrated.approved ? "zatwierdzony" : LINE_STATE[narrated.state]} · {narrated.note}
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
            „Zatwierdź” pojawia się, gdy miks istnieje i czeka na przyjęcie. Tak samo odmówiłby
            terminal.
          </p>
        )}
      </Block>

      <Block
        fold={cell.state === "ready"}
        hint={
          <>
            Ta połowa etapu <strong>niczego nie kupuje</strong>: kładzie przyjęte kwestie na
            zatwierdzonym <code>episode.mp4</code>, jednym poleceniem i bez rachunku. Potrzebuje{" "}
            <code>ffmpeg</code> na tej maszynie, tak jak etap 8. Kwestia, która nachodziłaby na
            następną albo nie mieści się w filmie, jest <strong>odmową</strong>, nie przesunięciem:
            kotwica pochodzi z planu, który zatwierdził człowiek. Kotwica z planu nie jest sekundą
            filmu: klipy wróciły dłuższe, więc mikser przelicza jedno na drugie i melduje
            przesunięcie.
          </>
        }
        title="Miks (bez płacenia)"
      >
        <div className="send">
          <label className="field-check" htmlFor="mix-regenerate">
            <input
              checked={regenerate}
              id="mix-regenerate"
              onChange={changeRegenerate}
              type="checkbox"
            />
            Ponowny miks gotowego filmu
          </label>
        </div>
        <Action argv={mix} disabled={running} label="Zmiksuj" onRun={startRun} primary />

        {placement === null ? null : <Placement report={placement} />}
      </Block>
    </section>
  );
}
