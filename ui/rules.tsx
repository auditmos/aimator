import { type ChangeEvent, type JSX, useCallback, useEffect, useMemo, useState } from "react";
import { INTENTS } from "../src/ui/commands.js";
import { useImports } from "./import";
import {
  asCalls,
  Block,
  NO_FLAGS,
  PaidCall,
  plural,
  SendFields,
  type SendFlags,
  useArtifactText,
} from "./panel";
import type { RunDone } from "./types";

/**
 * Stage 0's rules, `project.md`, on a screen of their own: the file as it lies
 * on disk, an editor for it, and the one purchase that can start it, a draft
 * from an import.
 *
 * The file is shown whole, with every line that still waits for a person
 * marked, because the marker is exactly what stage 0 counts. The draft is a
 * proposal like the grouping it reads: bought in the same two steps, and
 * never a yes, since the line saying a person approved the rules is the one
 * line a draft leaves open.
 *
 * The screen writes the file only through `project rules --text`, the whole
 * file every time, so what a terminal can do is still all it can do. Taking a
 * proposal, dropping the instructions at the top and filling the yes are
 * edits a person would make in any editor, offered as buttons beside the
 * lines they change.
 */

/** The block a purchase fills, named once: on the page and in the dock's button. */
const RULES = "Zasady (project.md)";

/** What stage 0 counts as unanswered; `template.ts` writes it, this screen only marks it. */
const MARKER = "TODO(etap-0)";

/** What a draft puts before a proposal: the marker, and the word for what follows. */
const PROPOSAL = `${MARKER} propozycja:`;

/** The scaffold's line for the yes, while nobody has written it. */
const APPROVED = `- Zatwierdzone przez użytkownika: ${MARKER}`;

/** What a button beside a line does to the file. */
type LineEdit = "accept" | "approve" | "unquote";

/** The edit a line offers, if any: a proposal to take, the quote to drop, the yes to write. */
function editOf(line: string, index: number, quoteAt: number): LineEdit | null {
  if (line.includes(PROPOSAL)) {
    return "accept";
  }

  if (line.startsWith(APPROVED)) {
    return "approve";
  }

  return index === quoteAt ? "unquote" : null;
}

const LABEL: Readonly<Record<LineEdit, string>> = {
  accept: "Przyjmij",
  approve: "Przyjmuję całość",
  unquote: "Usuń cytat",
};

/**
 * The file with one edit made. A proposal loses its marker and keeps its
 * text; the quote goes with the blank line after it; the yes says the whole
 * rules, today, which is the scope a person reading them all can give.
 */
function edited(lines: readonly string[], index: number, edit: LineEdit): string {
  const line = lines[index] ?? "";

  if (edit === "accept") {
    const taken = line.replace(`${PROPOSAL} `, "").replace(` ${PROPOSAL}`, "");

    return lines.map((one, at) => (at === index ? taken : one)).join("\n");
  }

  if (edit === "approve") {
    const today = new Date().toISOString().slice(0, 10);
    const yes = `- Zatwierdzone przez użytkownika: całość zasad (${today}).`;

    return lines.map((one, at) => (at === index ? yes : one)).join("\n");
  }

  let end = index;

  while (lines[end]?.startsWith(">")) {
    end += 1;
  }

  if (lines[end] === "") {
    end += 1;
  }

  return [...lines.slice(0, index), ...lines.slice(end)].join("\n");
}

function LineButton(props: {
  readonly disabled: boolean;
  readonly edit: LineEdit;
  readonly index: number;
  readonly onEdit: (index: number, edit: LineEdit) => void;
}): JSX.Element {
  const { disabled, edit, index, onEdit } = props;
  const click = useCallback(() => onEdit(index, edit), [edit, index, onEdit]);

  return (
    <button className="rules-edit" disabled={disabled} onClick={click} type="button">
      {LABEL[edit]}
    </button>
  );
}

/** `project.md` line by line, each line still waiting for a person marked, with its edit. */
function RulesText(props: {
  readonly onWrite: (text: string) => void;
  readonly running: boolean;
  readonly text: string;
}): JSX.Element {
  const { onWrite, running, text } = props;
  const lines = useMemo(() => text.split("\n"), [text]);
  const quoteAt = lines.findIndex((line) => line.startsWith(">"));
  const edit = useCallback(
    (index: number, kind: LineEdit) => onWrite(edited(lines, index, kind)),
    [lines, onWrite]
  );

  return (
    <pre className="artifact-text rules-text">
      {lines.map((line, index) => {
        const kind = editOf(line, index, quoteAt);

        return (
          <span className={line.includes(MARKER) ? "rules-open" : undefined} key={index}>
            {line}
            {kind === null ? null : (
              <>
                {" "}
                <LineButton disabled={running} edit={kind} index={index} onEdit={edit} />
              </>
            )}
            {index === lines.length - 1 ? "" : "\n"}
          </span>
        );
      })}
    </pre>
  );
}

/** The whole file in a field, saved as it stands or left as it was. */
function RulesEditor(props: {
  readonly onCancel: () => void;
  readonly onChange: (text: string) => void;
  readonly onSave: () => void;
  readonly running: boolean;
  readonly text: string;
}): JSX.Element {
  const { onCancel, onChange, onSave, running, text } = props;
  const change = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value),
    [onChange]
  );

  return (
    <div className="rules-editor">
      <textarea
        aria-label="Treść project.md"
        className="rules-field"
        onChange={change}
        rows={Math.max(12, text.split("\n").length + 2)}
        spellCheck={false}
        value={text}
      />
      <div className="actions">
        <button className="action action-primary" disabled={running} onClick={onSave} type="button">
          Zapisz
        </button>
        <button className="action" disabled={running} onClick={onCancel} type="button">
          Anuluj
        </button>
      </div>
    </div>
  );
}

/**
 * Which import a draft reads. Opens on the one there is when there is one;
 * among several, on none, because which material a series starts from is the
 * person's to say.
 */
function ImportPick(props: {
  readonly importId: string;
  readonly imports: readonly string[];
  readonly onPick: (importId: string) => void;
}): JSX.Element {
  const { importId, imports, onPick } = props;
  const choose = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => onPick(event.target.value),
    [onPick]
  );

  return (
    <div className="field">
      <label htmlFor="rules-import">Import z podziałem</label>
      <select id="rules-import" onChange={choose} value={importId}>
        {imports.length === 1 ? null : <option value="">nierozstrzygnięte</option>}
        {imports.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * How many lines still carry the marker, the one number this screen is for,
 * and the way to a proposal for each when there is an import to propose from.
 * `importId` is empty when there is nothing left to propose: once every field
 * has an answer, a second draft has nothing to add.
 */
function OpenCount(props: {
  readonly importId: string;
  readonly onPropose: () => void;
  readonly open: number;
  readonly running: boolean;
}): JSX.Element {
  const { importId, onPropose, open, running } = props;

  if (open === 0) {
    return (
      <div className="next-card next-card-done">
        <p className="next-label">Do uzupełnienia</p>
        <p className="next-what">Żaden wiersz nie ma już znacznika {MARKER}.</p>
      </div>
    );
  }

  return (
    <div className="next-card">
      <p className="next-label">Do uzupełnienia</p>
      <p className="next-what">
        <span className="rules-count">{open}</span>
        {plural(open, ["wiersz", "wiersze", "wierszy"]).slice(String(open).length)} ze znacznikiem{" "}
        {MARKER}
      </p>
      {importId === "" ? null : (
        <button
          className="action action-primary next-go"
          disabled={running}
          onClick={onPropose}
          type="button"
        >
          Zaproponuj odpowiedzi
        </button>
      )}
      <p className="next-terminal">
        Wyróżnione niżej. Etap 0 nie przejdzie, póki został choć jeden, także w cytacie na górze
        pliku. Przy propozycji jest „Przyjmij”, przy cytacie „Usuń cytat”, przy zatwierdzeniu
        „Przyjmuję całość”; resztę zmienisz w „Edytuj”.
        {importId === ""
          ? null
          : ` „Zaproponuj odpowiedzi” niczego nie kupuje: pokazuje rachunek i prompt szkicu z importu ${importId}, a płaci się dopiero przyciskiem „Kup” pod nimi.`}
      </p>
    </div>
  );
}

export function ProjectRules(props: {
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  /** Whatever moves when the workspace does; the file and the imports are re-read on it. */
  readonly revision: unknown;
  readonly run: RunDone | null;
  readonly running: boolean;
}): JSX.Element {
  const { onRun, projectId, revision, run, running } = props;
  const rules = useArtifactText({ artifact: "rules", projectId, stage: "prepare" }, revision);
  const listing = useImports(revision);
  const imports = useMemo(
    () =>
      listing === null || "error" in listing
        ? []
        : listing.imports.filter(({ grouped }) => grouped > 0).map(({ id }) => id),
    [listing]
  );
  const [picked, setPicked] = useState<string | null>(null);
  const importId = picked ?? (imports.length === 1 ? (imports[0] ?? "") : "");
  const [flags, setFlags] = useState<SendFlags>(NO_FLAGS);
  /** Grows each time the dock sends somebody to the rules a purchase wrote. */
  const [revealed, setRevealed] = useState(0);
  const result = useMemo(
    () => ({ reveal: () => setRevealed((count) => count + 1), title: RULES }),
    []
  );
  const preview = useMemo(
    () =>
      INTENTS.previewRulesDraft({
        importId,
        instruction: flags.instruction,
        maxOutputTokens: flags.tokens,
        model: flags.model,
        projectId,
        regenerate: flags.regenerate,
      }),
    [flags, importId, projectId]
  );
  /** The argv of the last command this screen started, whatever it was. */
  const [sent, setSent] = useState<readonly string[] | null>(null);
  const startRun = useCallback(
    (argv: readonly string[]) => {
      setSent(argv);
      onRun(argv);
    },
    [onRun]
  );
  const marked = rules === null ? [] : rules.split("\n").filter((line) => line.includes(MARKER));
  const open = marked.length;
  /** Fields with no answer at all: not a proposal, not the quote, not the yes. */
  const unanswered = marked.filter(
    (line) => !(line.includes(PROPOSAL) || line.startsWith(">") || line.startsWith(APPROVED))
  ).length;
  /** The file as the editor holds it, or nothing while the file is only read. */
  const [editing, setEditing] = useState<string | null>(null);
  /** The save that was sent, so the editor closes on its yes and not on another's. */
  const [saving, setSaving] = useState<readonly string[] | null>(null);
  const write = useCallback(
    (text: string) => startRun(INTENTS.writeRules({ projectId, text })),
    [projectId, startRun]
  );
  const edit = useCallback(() => setEditing(rules ?? ""), [rules]);
  const cancel = useCallback(() => setEditing(null), []);
  const save = useCallback(() => {
    if (editing === null) {
      return;
    }

    const argv = INTENTS.writeRules({ projectId, text: editing });

    setSaving(argv);
    startRun(argv);
  }, [editing, projectId, startRun]);

  useEffect(() => {
    if (saving !== null && sent === saving && !running && run?.ok === true) {
      setSaving(null);
      setEditing(null);
    }
  }, [run, running, saving, sent]);

  /** Grows each time the card sends somebody to the purchase; see `useRedraw`. */
  const [toBuy, setToBuy] = useState(0);
  /**
   * The card's way to a proposal for every open line: the free preview, run
   * from here, and the paid block opened where its bill and "Kup" stand. The
   * one click that costs money is still "Kup", under a bill somebody has read.
   */
  const propose = useCallback(() => {
    setToBuy((count) => count + 1);
    startRun(preview);
  }, [preview, startRun]);

  return (
    <div className="stage-body">
      {rules === null ? null : (
        <OpenCount
          importId={unanswered === 0 ? "" : importId}
          onPropose={propose}
          open={open}
          running={running}
        />
      )}
      <Block reveal={revealed} title={RULES}>
        <p className="actions-note">
          Plik leży w <code>projects/{projectId}/project.md</code>. Każdy zapis to{" "}
          <code>aimator project rules {projectId} --text …</code> z całym plikiem; zmiana po
          akceptacji etapu 0 ją unieważnia.
        </p>
        {rules === null ? <p className="panel-empty">Nie ma jeszcze pliku project.md.</p> : null}
        {rules !== null && editing === null ? (
          <>
            <div className="actions">
              <button className="action" disabled={running} onClick={edit} type="button">
                Edytuj
              </button>
            </div>
            <RulesText onWrite={write} running={running} text={rules} />
          </>
        ) : null}
        {editing === null ? null : (
          <RulesEditor
            onCancel={cancel}
            onChange={setEditing}
            onSave={save}
            running={running}
            text={editing}
          />
        )}
      </Block>

      {imports.length === 0 ? (
        <p className="actions-note">
          Szkic zasad czyta podział importu, a żaden import w katalogu roboczym go nie ma. Import i
          podział są na ekranie „Importuj materiał z Worda”.
        </p>
      ) : (
        <PaidCall
          note="Szkic kupuje dokładnie jedno wywołanie tekstowe. „Generuj” niczego nie wysyła i nie czyta klucza: pokazuje cały prompt i rachunek. Model czyta cały podział importu (odcinki tylko po to, co powraca, nigdy po fabułę), tytuł, proporcje i obsadę projektu, i odpowiada na każde pole project.md. Co mówi materiał, wpisuje; co tylko proponuje, stawia za „TODO(etap-0) propozycja:”, więc zostaje otwarte, dopóki tego nie przyjmiesz. Wiersz „Zatwierdzone przez użytkownika” zostaje Tobie. Szkic pisze tylko na nietknięty szkielet albo na własny nietknięty szkic, nigdy na Twoje poprawki."
          onRun={startRun}
          open={open > 0}
          preview={preview}
          projectRun={run}
          read={asCalls}
          result={result}
          reveal={toBuy}
          running={running}
          sent={sent}
        >
          <ImportPick importId={importId} imports={imports} onPick={setPicked} />
          <SendFields
            id="rules-send"
            instructionHint="Uwaga poprawia opublikowany szkic, zamiast pisać od zera: model dostaje ten sam prompt, obecny project.md i uwagę dosłownie. Puste pole to nowy szkic od zera. W obu przypadkach to nowa płatna próba."
            modelPlaceholder="AIMATOR_RULES_MODEL"
            onChange={setFlags}
            tokensPlaceholder="12000"
            value={flags}
          />
        </PaidCall>
      )}
    </div>
  );
}
