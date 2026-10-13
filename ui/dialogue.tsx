import {
  type ChangeEvent,
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { INTENTS } from "../src/ui/commands.js";
import {
  Action,
  Amended,
  artifactUrl,
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
  Reject,
  Said,
  SendFields,
  type SendFlags,
  type Unit,
  useArtifactText,
} from "./panel";
import { useEpisodeOverview } from "./prepare";
import type {
  DialogueLineState,
  DialogueReport,
  DialogueScriptState,
  DialogueStatus,
  RunDone,
  StatusCell,
} from "./types";

/**
 * Stage 11: the lines the characters speak, shared by both tracks, and the
 * same script once more in the language the mouths will move in.
 *
 * It is stage 9's panel with a second language in it, and three things are
 * its own.
 *
 * **One choice, one yes.** The CLI takes the script, the translation and the
 * lines of both languages in one `--artifact` list, and each key still names
 * exactly one decision, so the panel has one selection across all four lists
 * and one "Zatwierdź" over it, with "Odrzuć…" beside it. Stage 9 kept the
 * script's yes on a button of its own because its CLI asked for it apart.
 *
 * **Three purchases behind one block.** The script and the film's lines are one
 * command, as at stage 9; the translation is a text call of its own; the lines
 * of the mouths are the first command again under `--language`. They are one
 * paid block with a choice of what to buy rather than three, because "Kup" is
 * derived from the last preview, and three blocks would each have offered to
 * buy the others' previews.
 *
 * **A line is read with its words beside it.** A recording is accepted by
 * listening to it, and here what it should say is a sentence in a shot the
 * plan put a character in, so the sentence, the speaker and the second it
 * starts stand above the player.
 */

interface PanelProps {
  readonly cell: StatusCell;
  readonly episodeId: string;
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  readonly run: RunDone | null;
  readonly running: boolean;
}

/** The three units stage 11 counts in, none of which is ever added to another. */
const TEXT_CALLS: Unit = [
  "płatne wywołanie tekstowe",
  "płatne wywołania tekstowe",
  "płatnych wywołań tekstowych",
];
const SPOKEN: Unit = ["kwestia", "kwestie", "kwestii"];
const CHARACTERS: Unit = ["znak", "znaki", "znaków"];

/** What the state of a script means, in the word a person reads. */
const SCRIPT_STATE: Record<DialogueScriptState["state"], string> = {
  absent: "jeszcze nie powstał",
  completed: "gotowy, czeka na ocenę",
  submitted: "próba przerwana",
};

/** And of a line, which Polish counts as feminine. */
const LINE_STATE: Record<DialogueLineState["state"], string> = {
  absent: "jeszcze nie powstała",
  completed: "gotowa, czeka na ocenę",
  submitted: "próba przerwana",
};

/** What the paid block buys this time; see the file's comment. */
type Purchase = "film" | "mouths" | "translation";

/**
 * What to offer first: the film's side until it is accepted, then the
 * translation until that is, then the lines of the mouths. Only a default; a
 * person's own choice wins until they open another episode.
 */
function suggested(status: DialogueStatus | null): Purchase {
  const translation = status?.translation ?? null;

  if (status === null || translation === null || !status.approved) {
    return "film";
  }

  return translation.approved ? "mouths" : "translation";
}

/**
 * Stage 11's reading of its own report, which is two readings under one shape.
 *
 * A text call, the script's or the translation's, carries the prompt and no
 * lines, and is billed in calls. A purchase of lines carries the lines and is
 * billed in calls **and** characters, because the speech provider charges for
 * the characters; printing only the calls would put a number nobody is billed
 * beside the button that spends.
 */
export function asDialogue(report: DialogueReport): Priced {
  const prompts =
    report.prompt === null
      ? []
      : [{ label: "Prompt, który poleci do modelu tekstowego", text: report.prompt }];

  if (report.lines.length === 0) {
    return { billed: [{ count: report.paidCalls, unit: TEXT_CALLS }], prompts };
  }

  return {
    billed: [
      { count: report.paidCalls, unit: SPOKEN },
      { count: report.characters, unit: CHARACTERS },
    ],
    prompts,
  };
}

/** Anything this stage reviews, under the key `--artifact` names it by. */
interface Part {
  readonly approved: boolean;
  readonly id: string;
  readonly inputsChanged: readonly string[];
  readonly state: DialogueScriptState["state"];
}

/** A line under its record key, which is what `pickable` and `PickAll` read as `id`. */
function keyed(lines: readonly DialogueLineState[]): readonly DialogueLineState[] {
  return lines.map((line) => ({ ...line, id: line.key }));
}

/** The script, its lines, and the translation with its lines, in the order they are read. */
function partsOf(status: DialogueStatus | null): readonly Part[] {
  if (status === null) {
    return [];
  }

  const { translation } = status;

  return [
    status.script,
    ...keyed(status.lines),
    ...(translation === null ? [] : [translation, ...keyed(translation.lines)]),
  ];
}

/** What the paid block is told, kept per purchase so one model never leaks into another. */
interface PurchaseForm {
  /** A person's own choice of what to buy; null follows `suggested`. */
  readonly choice: Purchase | null;
  readonly film: SendFlags;
  /** A new paid attempt at lines of the mouths, which carry no note to correct by. */
  readonly mouthsAgain: boolean;
  readonly translation: SendFlags;
  /** One model for the lines of both languages: one call site, one variable. */
  readonly voiceModel: string;
}

const NO_FORM: PurchaseForm = {
  choice: null,
  film: NO_FLAGS,
  mouthsAgain: false,
  translation: NO_FLAGS,
  voiceModel: "",
};

/**
 * What is bought this time. The lines of the mouths need the language of the
 * mouths, so without a translation the choice falls back to the film's side.
 */
function purchaseOf(form: PurchaseForm, status: DialogueStatus | null): Purchase {
  if (form.choice === "mouths" && (status?.translation ?? null) === null) {
    return "film";
  }

  return form.choice ?? suggested(status);
}

/**
 * Whether an accepted part may be chosen: only for a new paid attempt, and
 * only the attempt of the purchase on screen.
 */
function unlockedBy(purchase: Purchase, form: PurchaseForm): boolean {
  if (purchase === "film") {
    return form.film.regenerate;
  }

  return purchase === "translation" ? form.translation.regenerate : form.mouthsAgain;
}

/**
 * The preview of the purchase on screen. Each one carries the chosen parts it
 * can buy and nothing else: the film's script and lines, or the lines of the
 * mouths; the translation is one per episode and takes none.
 */
function previewOf(input: {
  readonly form: PurchaseForm;
  readonly purchase: Purchase;
  readonly scope: { readonly episodeId: string; readonly projectId: string };
  readonly selected: readonly string[];
  readonly status: DialogueStatus | null;
}): readonly string[] {
  const { form, purchase, scope, selected, status } = input;
  const translation = status?.translation ?? null;

  if (purchase === "translation") {
    return INTENTS.previewTranslation({
      ...scope,
      instruction: form.translation.instruction,
      maxOutputTokens: form.translation.tokens,
      model: form.translation.model,
      regenerate: form.translation.regenerate,
    });
  }

  if (purchase === "mouths") {
    const keys = keyed(translation?.lines ?? []).map((line) => line.id);

    return INTENTS.previewDialogue({
      ...scope,
      artifacts: selected.filter((key) => keys.includes(key)),
      instruction: "",
      language: translation?.language ?? "",
      maxOutputTokens: "",
      model: "",
      regenerate: form.mouthsAgain,
      voiceModel: form.voiceModel,
    });
  }

  const keys = status === null ? [] : [status.script.id, ...status.lines.map((line) => line.key)];

  return INTENTS.previewDialogue({
    ...scope,
    artifacts: selected.filter((key) => keys.includes(key)),
    instruction: form.film.instruction,
    language: "",
    maxOutputTokens: form.film.tokens,
    model: form.film.model,
    regenerate: form.film.regenerate,
    voiceModel: form.voiceModel,
  });
}

/** One line, read and listened to, with its own checkbox under its record key. */
function Spoken(props: {
  readonly chosen: boolean;
  readonly item: DialogueLineState;
  readonly onToggle: (id: string, wanted: boolean) => void;
  /** Whether an accepted line may be chosen; see `pickable`. */
  readonly unlocked: boolean;
  /** Null while the film's language is not known yet, so there is no file to name. */
  readonly url: string | null;
}): JSX.Element {
  const { chosen, item, onToggle, unlocked, url } = props;

  return (
    <li className={item.approved ? "link picture-approved" : "link"}>
      <PickBox
        approved={item.approved}
        boxId={`dialogue-line-${item.key.replace(":", "-")}`}
        chosen={chosen}
        id={item.key}
        onToggle={onToggle}
        unlocked={unlocked}
      />
      <p className="picture-name">„{item.text}”</p>
      <p className="picture-state">
        {item.cast} · {item.shot} · od {item.atSeconds}s planu
        {item.onScreen ? "" : " · spoza kadru"}
      </p>
      {item.state === "absent" || url === null ? (
        <p className="picture-empty">{LINE_STATE[item.state]}</p>
      ) : (
        // biome-ignore lint/a11y/useMediaCaption: kwestia JEST tekstem, który stoi nad nią
        <audio className="line-audio" controls preload="metadata" src={url} />
      )}
      {/* The note already says how long a bought line runs, so `seconds` is not repeated. */}
      <p className="picture-state">
        {item.approved ? "zatwierdzona" : LINE_STATE[item.state]} · {item.note}
      </p>
    </li>
  );
}

/** One language's lines: "select all" over them, which chooses within this list only. */
function LinesBlock(props: {
  readonly chosen: readonly string[];
  /** What stands where the lines will be, before the script they come from validates. */
  readonly empty: string;
  readonly hint: ReactNode;
  readonly id: string;
  readonly items: readonly DialogueLineState[];
  readonly onChoose: (keys: readonly string[], within: readonly string[]) => void;
  readonly onToggle: (id: string, wanted: boolean) => void;
  readonly title: string;
  readonly unlocked: boolean;
  readonly urlOf: (key: string) => string | null;
}): JSX.Element {
  const { chosen, id, items, onChoose, onToggle, unlocked, urlOf } = props;
  const list = useMemo(() => keyed(items), [items]);
  const choose = useCallback(
    (keys: readonly string[]) =>
      onChoose(
        keys,
        list.map((item) => item.id)
      ),
    [list, onChoose]
  );

  return (
    <Block hint={props.hint} title={props.title}>
      {items.length === 0 ? (
        <p className="picture-empty">{props.empty}</p>
      ) : (
        <>
          <PickAll chosen={chosen} id={id} items={list} onChoose={choose} unlocked={unlocked} />
          <ul className="reel">
            {items.map((item) => (
              <Spoken
                chosen={chosen.includes(item.key)}
                item={item}
                key={item.key}
                onToggle={onToggle}
                unlocked={unlocked}
                url={urlOf(item.key)}
              />
            ))}
          </ul>
        </>
      )}
    </Block>
  );
}

/** The script, or its translation: its own box, its state, and its words to read. */
function ScriptBlock(props: {
  /** Corrected by hand and not accepted since; the script alone can be. */
  readonly amended: boolean;
  readonly boxId: string;
  readonly chosen: boolean;
  readonly hint: ReactNode;
  readonly item: DialogueScriptState;
  readonly onToggle: (id: string, wanted: boolean) => void;
  readonly text: string | null;
  readonly title: string;
  readonly unlocked: boolean;
}): JSX.Element {
  const { item } = props;

  return (
    <Block hint={props.hint} title={props.title}>
      {item.state === "completed" ? (
        <PickBox
          approved={item.approved}
          boxId={props.boxId}
          chosen={props.chosen}
          id={item.id}
          onToggle={props.onToggle}
          unlocked={props.unlocked}
        />
      ) : null}
      <p className="picture-state">
        {item.approved ? "zatwierdzony" : SCRIPT_STATE[item.state]} · {item.note}
        {props.amended ? " · poprawiony ręcznie, czeka na przyjęcie" : ""}
      </p>
      {props.text === null ? null : <pre className="artifact-text">{props.text}</pre>}
    </Block>
  );
}

/** Where the stage stands as a whole, and what it says without being asked. */
function DialogueState(props: {
  readonly drifted: readonly string[];
  readonly status: DialogueStatus;
}): JSX.Element {
  const { status } = props;
  const { translation } = status;

  return (
    <Block title="Stan">
      <dl className="verdict">
        <div>
          <dt>Język filmu zatwierdzony w całości</dt>
          <dd>{status.approved ? "tak" : "nie"}</dd>
        </div>
        <div>
          <dt>Przekład</dt>
          <dd>
            {translation === null
              ? "odcinek nie wskazuje drugiego języka"
              : `${translation.language}, ${translation.approved ? "zatwierdzony" : SCRIPT_STATE[translation.state]}`}
          </dd>
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
      <Drift paths={props.drifted} title="Wejścia zmieniły się po tej próbie:" />
      <Amended paths={status.amended} />
    </Block>
  );
}

/** What the paid block is told: which purchase, and that purchase's own flags. */
function PurchaseFields(props: {
  readonly form: PurchaseForm;
  readonly onForm: (change: (form: PurchaseForm) => PurchaseForm) => void;
  readonly purchase: Purchase;
  /** Whether the episode has a translation, and so a language of the mouths to buy in. */
  readonly translated: boolean;
}): JSX.Element {
  const { form, onForm, purchase } = props;
  const choose = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const choice = event.target.value as Purchase;

      onForm((current) => ({ ...current, choice }));
    },
    [onForm]
  );
  const changeVoice = useCallback(
    (voiceModel: string) => onForm((current) => ({ ...current, voiceModel })),
    [onForm]
  );
  const changeAgain = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const mouthsAgain = event.target.checked;

      onForm((current) => ({ ...current, mouthsAgain }));
    },
    [onForm]
  );
  const changeFilm = useCallback(
    (film: SendFlags) => onForm((current) => ({ ...current, film })),
    [onForm]
  );
  const changeTranslation = useCallback(
    (translation: SendFlags) => onForm((current) => ({ ...current, translation })),
    [onForm]
  );

  return (
    <>
      <div className="send">
        <div className="field">
          <label htmlFor="dialogue-purchase">Co kupić</label>
          <select id="dialogue-purchase" onChange={choose} value={purchase}>
            <option value="film">skrypt i kwestie w języku filmu</option>
            <option value="translation">przekład skryptu na język ust</option>
            <option disabled={!props.translated} value="mouths">
              kwestie w języku ust
            </option>
          </select>
        </div>
        {purchase === "translation" ? null : (
          <Field
            id="dialogue-voice-model"
            label="Model mowy"
            onValue={changeVoice}
            placeholder="AIMATOR_DIALOGUE_VOICE_MODEL"
            value={form.voiceModel}
          />
        )}
        {purchase === "mouths" ? (
          <label className="field-check" htmlFor="dialogue-mouths-regenerate">
            <input
              checked={form.mouthsAgain}
              id="dialogue-mouths-regenerate"
              onChange={changeAgain}
              type="checkbox"
            />
            Nowa płatna próba zaznaczonych kwestii
          </label>
        ) : null}
      </div>
      {purchase === "film" ? (
        <SendFields
          id="dialogue"
          instructionHint="Uwaga poprawia sam skrypt, więc działa tylko z zaznaczonym skryptem i niczym więcej (--artifact script). Kwestie kupuje się potem z jego słów, nigdy z uwagi. Bez uwagi nowa próba odrzuconego skryptu poprawia go według powodu odrzucenia. To nowa płatna próba."
          modelPlaceholder="AIMATOR_DIALOGUE_MODEL"
          onChange={changeFilm}
          tokensPlaceholder="8000"
          value={form.film}
        />
      ) : null}
      {purchase === "translation" ? (
        <SendFields
          id="dialogue-translation"
          instructionHint="Uwaga poprawia przekład: model dostaje ten sam prompt, poprzedni przekład i uwagę dosłownie. Bez uwagi nowa próba odrzuconego przekładu poprawia go według powodu odrzucenia. To nowa płatna próba."
          modelPlaceholder="AIMATOR_TRANSLATION_MODEL"
          onChange={changeTranslation}
          tokensPlaceholder="8000"
          value={form.translation}
        />
      ) : null}
    </>
  );
}

export function DialoguePanel(props: PanelProps): JSX.Element {
  const { cell, episodeId, onRun, projectId, run, running } = props;
  const status = cell.status as DialogueStatus | null;
  const translation = status?.translation ?? null;
  const film = useEpisodeOverview(projectId, episodeId, cell.state)?.settings.language ?? null;
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [form, setForm] = useState<PurchaseForm>(NO_FORM);
  const [sent, setSent] = useState<readonly string[] | null>(null);
  const purchase = purchaseOf(form, status);
  // An accepted part stays ticked and locked unless a new paid attempt is
  // what is being chosen for, in the purchase on screen.
  const unlocked = unlockedBy(purchase, form);
  const scope = useMemo(() => ({ episodeId, projectId }), [episodeId, projectId]);
  const parts = useMemo(() => partsOf(status), [status]);
  const selected = useMemo(() => pickable(parts, chosen, unlocked), [chosen, parts, unlocked]);
  const check = useMemo(() => INTENTS.checkDialogue(scope), [scope]);
  const approve = useMemo(
    () => INTENTS.approveDialogue({ ...scope, artifacts: selected }),
    [scope, selected]
  );
  const rejection = useCallback(
    (note: string) => INTENTS.rejectDialogue({ ...scope, artifacts: selected, note }),
    [scope, selected]
  );
  const preview = useMemo(
    () => previewOf({ form, purchase, scope, selected, status }),
    [form, purchase, scope, selected, status]
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
  // "Select all" over one list leaves what is chosen in the others alone.
  const chooseWithin = useCallback((keys: readonly string[], within: readonly string[]) => {
    setChosen((current) => [...current.filter((one) => !within.includes(one)), ...keys]);
  }, []);
  const urlOf = useCallback(
    (artifact: string) =>
      `${artifactUrl({ artifact, episodeId, projectId, stage: "dialogue" })}&v=${encodeURIComponent(cell.state)}`,
    [cell.state, episodeId, projectId]
  );
  // The film's lines are keyed `D01` but live under a directory named for the
  // film's language, which is how the resolver is asked for them.
  const filmUrlOf = useCallback(
    (key: string) => (film === null ? null : urlOf(`${film}:${key}`)),
    [film, urlOf]
  );

  useEffect(() => {
    setChosen([]);
    setForm(NO_FORM);
    setSent(null);
  }, [episodeId]);

  // Read again on every push of the ladder rather than on a change of state: a
  // script corrected by hand changes its words and leaves the cell in review.
  const script = useArtifactText(
    { artifact: "script", episodeId, projectId, stage: "dialogue" },
    cell
  );
  // A hook is always called, so with no translation it reads the script again
  // and the text is never shown, rather than asking for a file nobody named.
  const translated = useArtifactText(
    { artifact: translation?.id ?? "script", episodeId, projectId, stage: "dialogue" },
    cell
  );
  const picked = parts.filter((one) => selected.includes(one.id));
  const acceptable =
    picked.length > 0 && picked.every((one) => one.state === "completed" && !one.approved);

  return (
    <section aria-labelledby="dialogue-title" className="panel">
      <h2 id="dialogue-title">
        Etap {cell.stage}: {cell.title}
      </h2>

      {status === null ? (
        <p className="panel-empty">Ten etap nie odpowiedział; drabina pokazuje powód.</p>
      ) : (
        <>
          <DialogueState
            drifted={[...new Set(parts.flatMap((one) => one.inputsChanged))]}
            status={status}
          />

          <ScriptBlock
            amended={status.amended.length > 0}
            boxId="dialogue-script"
            chosen={selected.includes(status.script.id)}
            hint={
              <>
                Dialog jest <strong>podnoszony, nie pisany</strong>: etap 3 zapisał każdą kwestię w
                polu <code>Audio</code> ujęcia jako <code>postać: "…"</code>, a walidator sprawdza w
                obie strony, że żadnej nie wymyślono i żadnej nie pominięto. Jeśli postać ma
                powiedzieć coś innego, poprawka należy do etapu 3, nie tutaj. Zatwierdzenie skryptu
                otwiera kupowanie kwestii.
              </>
            }
            item={status.script}
            onToggle={toggle}
            text={script}
            title="Skrypt dialogu"
            unlocked={unlocked}
          />

          <LinesBlock
            chosen={selected}
            empty="Kwestie pojawią się, gdy skrypt przejdzie walidację."
            hint={
              <>
                Kwestie są <strong>wspólne dla obu torów</strong> i każda jest czytana głosem swojej
                postaci w języku filmu; postać bez przyjętej próbki głosu czeka, reszta jest
                kupowana. Odsłuchaj i zaznacz; kilka zaznaczonych to jedna komenda z listą{" "}
                <code>--artifact</code>.
              </>
            }
            id="dialogue-lines-all"
            items={status.lines}
            onChoose={chooseWithin}
            onToggle={toggle}
            title={film === null ? "Kwestie" : `Kwestie (${film})`}
            unlocked={unlocked}
            urlOf={filmUrlOf}
          />

          {translation === null ? null : (
            <>
              <ScriptBlock
                amended={false}
                boxId="dialogue-translation"
                chosen={selected.includes(translation.id)}
                hint={
                  <>
                    Jedyny zamierzony przekład materiału w tym potoku: osobny plik z własną zgodą,
                    nie przeróbka skryptu. Każda kwestia idzie z oknem czasu, od swojej kotwicy do
                    następnej kwestii albo końca ujęcia, i ma się w nim zmieścić. Walidator sprawdza
                    1:1 kwestie, ujęcia, postacie i kotwice; wierność ocenia człowiek, tutaj.
                  </>
                }
                item={translation}
                onToggle={toggle}
                text={translated}
                title={`Przekład na ${translation.language}`}
                unlocked={unlocked}
              />

              <LinesBlock
                chosen={selected}
                empty="Kwestie pojawią się, gdy przekład przejdzie walidację."
                hint={
                  <>
                    Kwestie w języku ust czyta się z przyjętego przekładu, głosami postaci w tym
                    języku, i to do nich etap 12 ruszy ustami. Każda ma własną zgodę, osobną od
                    zgody na przekład.
                  </>
                }
                id="dialogue-mouths-all"
                items={translation.lines}
                onChoose={chooseWithin}
                onToggle={toggle}
                title={`Kwestie w języku ust (${translation.language})`}
                unlocked={unlocked}
                urlOf={urlOf}
              />
            </>
          )}
        </>
      )}

      <Block className="block-decision" title="Decyzja">
        <Action argv={check} disabled={running} label="Sprawdź" onRun={startRun} />

        {acceptable ? (
          <>
            <Action argv={approve} disabled={running} label="Zatwierdź" onRun={startRun} primary />
            <Reject
              again="Nowa płatna próba skryptu albo przekładu bez własnej uwagi poprawi według niego; uwaga wpisana przy niej ma pierwszeństwo. Kwestii model mowy nie czyta: tam powód zostaje w ocenie, a nowa próba kupuje nagranie od nowa."
              argvOf={rejection}
              criteria={[]}
              id="dialogue-reject"
              onRun={startRun}
              run={run}
              running={running}
            />
          </>
        ) : (
          <p className="actions-note">
            Zaznacz skrypt, przekład albo kwestie, które istnieją i czekają na przyjęcie, żeby je
            zatwierdzić albo odrzucić; kilka zaznaczonych to jedna komenda. Tak samo odmówiłby
            terminal.
          </p>
        )}
      </Block>

      <PaidCall
        note="Trzy zakupy w jednym bloku, a pole „Co kupić” mówi który. Skrypt i kwestie w języku filmu to jedno polecenie, a raport mówi, co kupi: dopóki skryptu nie ma, jedno wywołanie tekstowe; po jego zatwierdzeniu kwestie, które ta zgoda otworzyła. Przekład to osobne wywołanie tekstowe, na język z decyzji odcinka (lip-sync.json). Kwestie w języku ust czyta się z przyjętego przekładu. Dostawca mowy liczy ZNAKI, nie wywołania, więc rachunek podaje jedno i drugie. Bez zaznaczenia kupuje się wszystko, na co pozwalają bramki. „Generuj” niczego nie wysyła i nie czyta kluczy; dopiero „Kup” płaci."
        onRun={startRun}
        open={cell.state === "ready"}
        preview={preview}
        projectRun={run}
        read={asDialogue}
        running={running}
        sent={sent}
      >
        <PurchaseFields
          form={form}
          onForm={setForm}
          purchase={purchase}
          translated={translation !== null}
        />
      </PaidCall>
    </section>
  );
}
