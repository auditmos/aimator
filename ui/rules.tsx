import { type ChangeEvent, type JSX, useCallback, useMemo, useState } from "react";
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
 * on disk, and the one purchase that can start it, a draft from an import.
 *
 * The file is shown whole, with every line that still waits for a person
 * marked, because the marker is exactly what stage 0 counts. The draft is a
 * proposal like the grouping it reads: bought in the same two steps, and
 * never a yes, since the line saying a person approved the rules is the one
 * line a draft leaves open.
 */

/** The block a purchase fills, named once: on the page and in the dock's button. */
const RULES = "Zasady (project.md)";

/** What stage 0 counts as unanswered; `template.ts` writes it, this screen only marks it. */
const MARKER = "TODO(etap-0)";

/** `project.md` line by line, each line still waiting for a person marked. */
function RulesText(props: { readonly text: string }): JSX.Element {
  const lines = props.text.split("\n");

  return (
    <pre className="artifact-text rules-text">
      {lines.map((line, index) => (
        <span className={line.includes(MARKER) ? "rules-open" : undefined} key={index}>
          {line}
          {index === lines.length - 1 ? "" : "\n"}
        </span>
      ))}
    </pre>
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
  const open =
    rules === null ? 0 : rules.split("\n").filter((line) => line.includes(MARKER)).length;
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
        <div className={open === 0 ? "next-card next-card-done" : "next-card"}>
          <p className="next-label">Do uzupełnienia</p>
          {open === 0 ? (
            <p className="next-what">Żaden wiersz nie ma już znacznika {MARKER}.</p>
          ) : (
            <p className="next-what">
              <span className="rules-count">{open}</span>
              {plural(open, ["wiersz", "wiersze", "wierszy"]).slice(String(open).length)} ze
              znacznikiem {MARKER}
            </p>
          )}
          {open === 0 || importId === "" ? null : (
            <button
              className="action action-primary next-go"
              disabled={running}
              onClick={propose}
              type="button"
            >
              Zaproponuj odpowiedzi
            </button>
          )}
          {open === 0 ? null : (
            <p className="next-terminal">
              Wyróżnione niżej. Etap 0 nie przejdzie, póki został choć jeden, także w cytacie na
              górze pliku, który po uzupełnieniu się usuwa.
              {importId === ""
                ? null
                : ` „Zaproponuj odpowiedzi” niczego nie kupuje: pokazuje rachunek i prompt szkicu z importu ${importId}, a płaci się dopiero przyciskiem „Kup” pod nimi.`}
            </p>
          )}
        </div>
      )}
      <Block reveal={revealed} title={RULES}>
        <p className="actions-note">
          Plik leży w <code>projects/{projectId}/project.md</code> i poprawia się go w edytorze.
        </p>
        {rules === null ? (
          <p className="panel-empty">Nie ma jeszcze pliku project.md.</p>
        ) : (
          <RulesText text={rules} />
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
