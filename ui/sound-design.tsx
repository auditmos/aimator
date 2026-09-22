import { type ChangeEvent, type JSX, useCallback, useEffect, useMemo, useState } from "react";
import { INTENTS } from "../src/ui/commands.js";
import {
  Action,
  artifactUrl,
  type Billed,
  Drift,
  Field,
  NO_FLAGS,
  Notices,
  PaidCall,
  type Priced,
  Problems,
  RunOutput,
  SendFields,
  type SendFlags,
  type Unit,
  useArtifactText,
} from "./panel";
import type {
  CueState,
  MasterReport,
  MasterStatus,
  RunDone,
  SoundDesignReport,
  SoundDesignStatus,
  StatusCell,
} from "./types";

/**
 * Stage 10: one stage, **two panels**, for stage 9's reason one row down.
 *
 * A bed has no idea which of the two films it will sit under, so the cue sheet
 * and every stem are bought once and reviewed once; only the full mix is timed
 * against a particular cut, and the two cuts came back with different drift.
 * So `--track` is the choice of question here as well, and one panel would
 * have had to pretend one of the two.
 *
 * Three things are this panel's own.
 *
 * **The bill is seconds.** Stage 9 already stopped the count of calls from
 * being the bill; here it is wrong for a second reason. This provider rates
 * per minute of generated audio, so one call for a thirty-second bed and one
 * for a three-second thunderclap are the same count and nothing like the same
 * money. And it charges at **generation** rather than at download, which makes
 * a second attempt a second full charge, said beside the button that makes it.
 *
 * **Approving means listening, in MP3.** Neither of the two endpoints offers
 * any other container, so the bytes are `audio/mpeg` rather than the WAV a
 * spoken line comes back as. What does not change is why they are on screen:
 * a bed judged by its file name is a bed nobody judged.
 *
 * **Levels are a form, and they are here rather than in stage 9.** How loud
 * the bed sits under a narrator says nothing about how that narrator read, so
 * moving a fader must not lapse a recording. Delivery is a recorded input of
 * the bought recordings; levels are a recorded input of the mix. Two knobs,
 * two scopes, two files.
 */

interface PanelProps {
  readonly cell: StatusCell;
  readonly episodeId: string;
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  readonly run: RunDone | null;
  readonly running: boolean;
}

/** The three units stage 10 counts in, none of which is ever added to another. */
const TEXT_CALLS: Unit = [
  "płatne wywołanie tekstowe",
  "płatne wywołania tekstowe",
  "płatnych wywołań tekstowych",
];
const AUDIO_CALLS: Unit = [
  "płatne wywołanie audio",
  "płatne wywołania audio",
  "płatnych wywołań audio",
];
const SECONDS: Unit = ["sekunda dźwięku", "sekundy dźwięku", "sekund dźwięku"];

/**
 * What the state of one bought stem means, in the word a person reads.
 *
 * Stage 9's table says the same three things about a recording and cannot be
 * shared with this one: a `kwestia` is feminine in Polish and a `podkład` is
 * not, so the two tables differ in every entry. Promoting an arrangement whose
 * every word is the caller's would be a widened interface bought with nothing.
 */
const CUE_STATE: Record<CueState["state"], string> = {
  absent: "jeszcze nie powstał",
  completed: "gotowy, czeka na ocenę",
  submitted: "próba przerwana",
};

/**
 * Stage 10's reading of its own report, which is **two readings under one flag**.
 *
 * The same command does two different purchases and the report says which:
 * until the cue sheet exists and a human has accepted it, what would be bought
 * is one text call; afterwards it is the stems that yes authorised, rated in
 * seconds. Printing the audio bill during the first phase would have shown a
 * person `0` beside a button that was about to spend.
 */
function asSound(report: SoundDesignReport): Priced {
  const prompts =
    report.prompt === null
      ? []
      : [{ label: "Prompt, który poleci do modelu tekstowego", text: report.prompt }];

  if (report.sheet.state === "planned" || report.sheet.state === "blocked") {
    return {
      aside: report.sheet.note,
      billed: [{ count: report.sheet.state === "planned" ? 1 : 0, unit: TEXT_CALLS }],
      prompts,
    };
  }

  const billed: readonly Billed[] = [
    { count: report.calls, unit: AUDIO_CALLS },
    { count: report.seconds, unit: SECONDS },
  ];

  return {
    aside:
      "Dostawca wycenia za minutę wygenerowanego dźwięku i nalicza przy GENERACJI, nie przy pobraniu: nowa próba tego samego cue to druga pełna opłata, nie dopłata.",
    billed,
    prompts,
  };
}

/** One bought stem, listened to rather than looked at, with its own checkbox. */
function Stem(props: {
  readonly chosen: boolean;
  readonly item: CueState;
  readonly onToggle: (id: string, wanted: boolean) => void;
  readonly url: string;
}): JSX.Element {
  const { chosen, item, onToggle, url } = props;
  const boxId = `stem-${item.id}`;
  const toggle = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onToggle(item.id, event.target.checked),
    [item.id, onToggle]
  );

  return (
    <li className="link">
      <label className="field-check" htmlFor={boxId}>
        <input checked={chosen} id={boxId} onChange={toggle} type="checkbox" />
        <code>{item.id}</code>
      </label>
      {item.state === "absent" ? (
        <p className="picture-empty">{CUE_STATE[item.state]}</p>
      ) : (
        // biome-ignore lint/a11y/useMediaCaption: stem jest dźwiękiem bez mowy, a jego opis stoi obok, w arkuszu cue
        <audio className="line-audio" controls preload="metadata" src={url} />
      )}
      {/* The length is deliberately not repeated after the note: what this
          stage writes there is already "zamówiono 30s, wróciło 29.989s", which
          is the comparison worth reading, and a bare number after it would be
          the same fact said twice and half as usefully. */}
      <p className="picture-state">
        {item.approved ? "zatwierdzony" : CUE_STATE[item.state]} · {item.note}
      </p>
    </li>
  );
}

/** How loud this series sits: four faders, none of them a decision yet. */
interface LevelsForm {
  readonly duckDb: string;
  readonly duckRelease: string;
  readonly effectsDb: string;
  readonly musicDb: string;
}

const NO_LEVELS: LevelsForm = { duckDb: "", duckRelease: "", effectsDb: "", musicDb: "" };

export function SoundDesignPanel(props: PanelProps): JSX.Element {
  const { cell, episodeId, onRun, projectId, run, running } = props;
  const status = cell.status as SoundDesignStatus | null;
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [flags, setFlags] = useState<SendFlags>(NO_FLAGS);
  const [musicModel, setMusicModel] = useState("");
  const [effectsModel, setEffectsModel] = useState("");
  const [levels, setLevels] = useState<LevelsForm>(NO_LEVELS);
  const [sent, setSent] = useState<readonly string[] | null>(null);
  const scope = useMemo(() => ({ episodeId, projectId }), [episodeId, projectId]);
  const check = useMemo(() => INTENTS.checkSoundDesign(scope), [scope]);
  const approveSheet = useMemo(() => INTENTS.approveCueSheet(scope), [scope]);
  const approveStems = useMemo(
    () => INTENTS.approveStems({ ...scope, artifacts: chosen }),
    [chosen, scope]
  );
  const preview = useMemo(
    () =>
      INTENTS.previewSoundDesign({
        ...scope,
        artifacts: chosen,
        effectsModel,
        maxOutputTokens: flags.tokens,
        model: flags.model,
        musicModel,
        regenerate: flags.regenerate,
      }),
    [chosen, effectsModel, flags, musicModel, scope]
  );
  const setMix = useMemo(() => INTENTS.setLevels({ ...levels, projectId }), [levels, projectId]);
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
  const changeMusicDb = useCallback(
    (musicDb: string) => setLevels((current) => ({ ...current, musicDb })),
    []
  );
  const changeEffectsDb = useCallback(
    (effectsDb: string) => setLevels((current) => ({ ...current, effectsDb })),
    []
  );
  const changeDuckDb = useCallback(
    (duckDb: string) => setLevels((current) => ({ ...current, duckDb })),
    []
  );
  const changeDuckRelease = useCallback(
    (duckRelease: string) => setLevels((current) => ({ ...current, duckRelease })),
    []
  );
  const urlOf = useCallback(
    (artifact: string) =>
      `${artifactUrl({ artifact, episodeId, projectId, stage: "sound-design" })}&v=${encodeURIComponent(cell.state)}`,
    [cell.state, episodeId, projectId]
  );

  useEffect(() => {
    setChosen([]);
    setSent(null);
  }, [episodeId]);

  const sheet = useArtifactText(
    { artifact: "cues", episodeId, projectId, stage: "sound-design" },
    cell.state
  );
  const cues = status?.cues ?? [];
  const picked = cues.filter((one) => chosen.includes(one.id));
  const sheetAcceptable =
    status !== null && status.sheet.state === "completed" && !status.sheet.approved;
  const stemsAcceptable =
    picked.length > 0 && picked.every((one) => one.state === "completed" && !one.approved);
  const drifted = [
    ...new Set([...(status?.sheet.inputsChanged ?? []), ...cues.flatMap((o) => o.inputsChanged)]),
  ];

  return (
    <section aria-labelledby="sound-design-title" className="panel">
      <h2 id="sound-design-title">
        Etap {cell.stage}: {cell.title}
      </h2>

      {status === null ? (
        <p className="panel-empty">Ten etap nie odpowiedział; drabina pokazuje powód.</p>
      ) : (
        <>
          <dl className="verdict">
            <div>
              <dt>Zatwierdzone w całości</dt>
              <dd>{status.approved ? "tak" : "nie"}</dd>
            </div>
            <div>
              <dt>Cały arkusz</dt>
              <dd>{status.totalSeconds}s dźwięku</dd>
            </div>
            <div>
              <dt>Dalej</dt>
              <dd>{status.nextStep}</dd>
            </div>
          </dl>

          <Problems problems={status.problems} />
          <Notices notices={status.notices} />
          <Drift paths={drifted} title="Wejścia zmieniły się po tej próbie:" />

          <h3>Arkusz cue</h3>
          <p className="actions-note">
            Tutaj <strong>nie ma</strong> reguły „podnoszone, nie pisane" i nie da się jej mieć:
            prompt muzyczny jest instrukcją, więc idzie po angielsku, a pole <code>Audio</code>, z
            którego powstaje, jest polskim materiałem, którego nie wolno tłumaczyć. Walidator
            sprawdza więc <strong>okablowanie</strong>: czy ujęcia cue to dokładnie te, które leżą w
            jego sekundach, czy podkład kafelkuje film bez dziur i czy każda długość jest taka, jaką
            dostawca zrenderuje. Czy angielski opisuje polską prozę — zostaje człowiekowi, tutaj,
            przed zakupem.
          </p>
          <p className="picture-state">
            {status.sheet.approved ? "zatwierdzony" : CUE_STATE[status.sheet.state]} ·{" "}
            {status.sheet.note}
          </p>
          {sheet === null ? null : <pre className="artifact-text">{sheet}</pre>}

          {sheetAcceptable ? (
            <Action
              argv={approveSheet}
              disabled={running}
              label="Zatwierdź arkusz"
              onRun={startRun}
              primary
            />
          ) : (
            <p className="actions-note">
              „Zatwierdź arkusz” pojawia się, gdy arkusz istnieje i czeka na przyjęcie. To ta zgoda
              otwiera zakup stemów.
            </p>
          )}

          <h3>Stemy</h3>
          <p className="actions-note">
            Podkład i efekty są <strong>wspólne dla obu torów</strong>: grzmot nie wie, nad którym
            filmem usiądzie. Odsłuchaj i zaznacz; zaznaczenie kilku daje jedną komendę z listą{" "}
            <code>--artifact</code>.
          </p>
          <ul className="reel">
            {cues.map((item) => (
              <Stem
                chosen={chosen.includes(item.id)}
                item={item}
                key={item.id}
                onToggle={toggle}
                url={urlOf(item.id)}
              />
            ))}
          </ul>

          {stemsAcceptable ? (
            <Action
              argv={approveStems}
              disabled={running}
              label="Zatwierdź stemy"
              onRun={startRun}
              primary
            />
          ) : (
            <p className="actions-note">
              „Zatwierdź stemy” pojawia się, gdy zaznaczone stemy istnieją i czekają na przyjęcie.
              Tak samo odmówiłby terminal.
            </p>
          )}
        </>
      )}

      <Action argv={check} disabled={running} label="Sprawdź" onRun={startRun} />

      <PaidCall
        note="Jedno polecenie, dwa zakupy, a raport mówi który: dopóki arkusza nie ma, kupuje się jedno wywołanie tekstowe; po jego zatwierdzeniu — stemy, które ta zgoda otworzyła. Dostawca wycenia SEKUNDY dźwięku, nie wywołania, więc rachunek podaje jedno i drugie. „Generuj” niczego nie wysyła i nie czyta kluczy; dopiero „Kup” płaci."
        onRun={startRun}
        preview={preview}
        projectRun={run}
        read={asSound}
        running={running}
        sent={sent}
      >
        <SendFields
          id="sound-design"
          modelPlaceholder="AIMATOR_SOUND_MODEL"
          onChange={setFlags}
          tokensPlaceholder="12000"
          value={flags}
        />
        <div className="send">
          <Field
            id="sound-design-music-model"
            label="Model muzyki"
            onValue={setMusicModel}
            placeholder="AIMATOR_MUSIC_MODEL"
            value={musicModel}
          />
          <Field
            id="sound-design-effects-model"
            label="Model efektów"
            onValue={setEffectsModel}
            placeholder="AIMATOR_EFFECTS_MODEL"
            value={effectsModel}
          />
        </div>
      </PaidCall>

      <h3>Poziomy: jak głośno to siedzi</h3>
      <p className="actions-note">
        To, jak narrator <strong>czyta</strong>, mieszka w pliku etapu 9; to, jak głośno pod nim
        siedzi podkład, mieszka w pliku tego etapu, w <code>mix.json</code>. Nie jest to kaprys
        układu: głośność muzyki nie mówi nic o tym, jak ktoś przeczytał zdanie, więc zmiana miksu
        nie może unieważniać nagrania, którego nie dotknęła. Unieważnia dokładnie miks. Wartości
        startowe są tylko tutaj i mają własne uzasadnienie:{" "}
        <strong>tej decyzji nie da się podjąć, zanim się ją usłyszy</strong>, a miks nic nie
        kosztuje. Puste pole to brak decyzji, nie zero: flaga wtedy nie pada i zostaje to, co
        ustawiono ostatnio.
      </p>
      <div className="send">
        <Field
          id="sound-design-music-db"
          label="music-db (niżej = podkład dalej)"
          onValue={changeMusicDb}
          placeholder="-18"
          value={levels.musicDb}
        />
        <Field
          id="sound-design-effects-db"
          label="effects-db (efekty mają być słyszalne)"
          onValue={changeEffectsDb}
          placeholder="-10"
          value={levels.effectsDb}
        />
        <Field
          id="sound-design-duck-db"
          label="duck-db (o tyle podkład ustępuje pod mową)"
          onValue={changeDuckDb}
          placeholder="-12"
          value={levels.duckDb}
        />
        <Field
          id="sound-design-duck-release"
          label="duck-release w ms (jak szybko wraca)"
          onValue={changeDuckRelease}
          placeholder="400"
          value={levels.duckRelease}
        />
      </div>
      <Action argv={setMix} disabled={running} label="Zapisz poziomy" onRun={startRun} />

      <RunOutput run={run} running={running} />
    </section>
  );
}

/** Where every sound landed on this track's own clock, after a full mix. */
function Placement(props: { readonly report: MasterReport }): JSX.Element {
  const { report } = props;
  const { levels } = report;

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
        <div>
          <dt>Poziomy</dt>
          <dd>
            music {levels.musicDb} dB · efekty {levels.effectsDb} dB · ducking {levels.duckDb} dB /{" "}
            {levels.duckReleaseMs} ms
          </dd>
        </div>
      </dl>
      <ul className="cut">
        {report.sounds.map((sound) => (
          <li key={`${sound.kind}-${sound.id}`}>
            <code>{sound.id}</code> ({sound.kind}) · plan {sound.plannedSeconds}s → film{" "}
            {sound.atSeconds}s · {sound.seconds}s
          </li>
        ))}
      </ul>
      <Problems problems={report.problems} />
      <Notices notices={report.notices} />
    </>
  );
}

export function MasterPanel(props: PanelProps): JSX.Element {
  const { cell, episodeId, onRun, projectId, run, running } = props;
  const status = cell.status as MasterStatus | null;
  const track = cell.track ?? "";
  const [regenerate, setRegenerate] = useState(false);
  const [sent, setSent] = useState<readonly string[] | null>(null);
  const [placement, setPlacement] = useState<MasterReport | null>(null);
  const scope = useMemo(() => ({ episodeId, projectId, track }), [episodeId, projectId, track]);
  const check = useMemo(() => INTENTS.checkMaster(scope), [scope]);
  const approve = useMemo(() => INTENTS.approveMaster(scope), [scope]);
  const mix = useMemo(() => INTENTS.mixSoundDesign({ ...scope, regenerate }), [regenerate, scope]);
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

  /** Where the sounds landed, read out of the report the last mix answered with. */
  useEffect(() => {
    if (sent === null || !(sent.includes("mix") && run?.ok === true)) {
      setPlacement(null);

      return;
    }

    try {
      setPlacement(JSON.parse(run.data) as MasterReport);
    } catch {
      setPlacement(null);
    }
  }, [run, sent]);

  useEffect(() => {
    setSent(null);
    setPlacement(null);
  }, [episodeId, track]);

  const mixed = status?.artifact ?? null;
  const acceptable = mixed !== null && mixed.state === "completed" && !mixed.approved;
  const film = `${artifactUrl({ artifact: "mixed", episodeId, projectId, stage: "sound-design", track })}&v=${encodeURIComponent(cell.state)}`;

  return (
    <section aria-labelledby="master-title" className="panel">
      <h2 id="master-title">
        Etap {cell.stage}: {cell.title} · {track}
      </h2>

      {status === null || mixed === null ? (
        <p className="panel-empty">Ten etap nie odpowiedział; drabina pokazuje powód.</p>
      ) : (
        <>
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
          <Drift paths={mixed.inputsChanged} title="Wejścia zmieniły się po tym miksie:" />

          <h3>Film ze wszystkim</h3>
          <p className="actions-note">
            To ostatni plik, jaki ten proces produkuje. Powstaje z <code>episode.mp4</code> i
            bezstratnych stemów, <strong>nie</strong> z <code>narrated.mp4</code>: dzięki temu mowa
            koduje się dokładnie raz, a muzyka w ogóle może ustąpić pod głosem.{" "}
            <code>narrated.mp4</code> zostaje nietknięty i dalej jest jedynym miejscem, gdzie
            słychać samo umieszczenie narracji.
          </p>
          {mixed.state === "absent" ? (
            <p className="picture-empty">{CUE_STATE[mixed.state]}</p>
          ) : (
            // biome-ignore lint/a11y/useMediaCaption: napisy to decyzja odcinka z etapu 0, nie tego panelu
            <video className="link-film" controls preload="metadata" src={film} />
          )}
          <p className="picture-state">
            {mixed.approved ? "zatwierdzony" : CUE_STATE[mixed.state]} · {mixed.note}
          </p>
        </>
      )}

      <Action argv={check} disabled={running} label="Sprawdź" onRun={startRun} />

      {acceptable ? (
        <Action argv={approve} disabled={running} label="Zatwierdź" onRun={startRun} primary />
      ) : (
        <p className="actions-note">
          „Zatwierdź” pojawia się, gdy pełna ścieżka istnieje i czeka na przyjęcie. Tak samo
          odmówiłby terminal.
        </p>
      )}

      <h3>Miks</h3>
      <p className="actions-note">
        Ta połowa etapu <strong>niczego nie kupuje</strong>: składa obraz, mowę i stemy jednym
        poleceniem i bez rachunku. Potrzebuje <code>ffmpeg</code> na tej maszynie, tak jak etapy 8 i
        9. Efekt, który wychodzi poza koniec filmu, jest <strong>odmową</strong>, bo to zderzenie;
        podkład, który kończy się przed nim, jest <strong>meldunkiem</strong>, bo to dryf klipów,
        którego nikt niżej nie naprawi.
      </p>
      <div className="send">
        <label className="field-check" htmlFor="master-regenerate">
          <input
            checked={regenerate}
            id="master-regenerate"
            onChange={changeRegenerate}
            type="checkbox"
          />
          Ponowny miks gotowego filmu
        </label>
      </div>
      <Action argv={mix} disabled={running} label="Zmiksuj" onRun={startRun} primary />

      {placement === null ? null : (
        <>
          <h3>Gdzie wylądowały dźwięki</h3>
          <p className="actions-note">
            Kotwica z planu nie jest sekundą filmu: klipy wróciły dłuższe, więc mikser przelicza
            jedno na drugie i melduje przesunięcie.
          </p>
          <Placement report={placement} />
        </>
      )}

      <RunOutput run={run} running={running} />
    </section>
  );
}
