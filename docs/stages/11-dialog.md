# Etap 11: dialog

Kwestie, które mówią postacie, w języku filmu. Dziś etap kupuje **skrypt**: które kwestie,
kto je mówi, w którym ujęciu i od której sekundy planu. Nagrania kwestii to jego następny
krok i jeszcze nie istnieją.

| | |
|---|---|
| **Wejście** | zatwierdzona `shot-list.md` z kwestiami zapisanymi jako `<id>: "…"`, `project.json`, `project.md`, `episode.json` |
| **Wyjście** | `dialogue.md`, `dialogue.stage.json`, `runs/<runId>/` (wspólne dla obu torów) |
| **Bramka** | zatwierdzony [etap 3](03-lista-ujec.md) i `--audio dialogue` albo `dialogue-and-narration` |
| **Koszt** | jedno płatne wywołanie tekstowe |

## Komendy

```bash
pnpm dev dialogue generate dzielna-ewa 01-burza --dry-run
pnpm dev dialogue generate dzielna-ewa 01-burza
pnpm dev check dzielna-ewa 01-burza --stage dialogue
pnpm dev approve dzielna-ewa 01-burza --stage dialogue --artifact script \
  --note "każda kwestia jest w swoim ujęciu"
```

Dodatkowe flagi: `--model <id>`, `--max-output-tokens <n>` (domyślnie 8 000),
`--regenerate`, `--instruction <uwaga>` (tylko razem z `--regenerate`), `--json`.

Model to `--model` albo `AIMATOR_DIALOGUE_MODEL`, własna zmienna, nie ta od narracji: dwa
miejsca wywołania, więc wybór modelu, który podnosi narrację, nie może po cichu wybrać
modelu, który podnosi dialog. Wartości domyślnej nie ma ([konfiguracja](../konfiguracja.md)).

## `--json`

`dialogue generate`, `check --stage dialogue` i `approve --stage dialogue` przyjmują
`--json` i wypisują obiekt, który zwraca moduł etapu, plus `command` i `stage`. Raport
`generate` niesie `paidCalls`: jeden albo zero, a zero to odpowiedź zablokowanej bramki.

## Skąd się biorą kwestie

Kwestii ten etap nie pisze. Napisał je [etap 1](01-scenariusz.md), a
[etap 3](03-lista-ujec.md#kwestie-postaci-mają-mówiącego) zapisał każdą w polu `Audio`
ujęcia, w którym pada, z mówiącym przed nią:

```markdown
- Audio: Deszcz o szybę; ewa: "Tato, czy burza już idzie?"
```

Model przepisuje je do skryptu i dokłada tylko to, czego nie ma żaden zatwierdzony
artefakt: identyfikator kwestii i sekundę planu, od której się zaczyna.

```markdown
### D01 | U01 | ewa | 2s

Tato, czy burza już idzie?
```

## Co sprawdza walidacja, w obie strony

Narrację [etap 9](09-narracja.md) sprawdza tylko w jedną stronę, bo zdanie narratora siedzi
w prozie. Kwestia postaci ma mówiącego, więc tutaj sprawdzane są obie:

- sekcje `Plan`, `Lines`, `Review`, w tej kolejności, żadna pusta, bez bloku kodu;
- kwestie numerowane kolejno od `D01` i ułożone według kotwic;
- ujęcie istnieje, a kotwica mieści się w nim;
- postać jest w obsadzie, a tekst występuje dosłownie w `Audio` tego ujęcia **jako kwestia
  tej postaci**; te same słowa przypisane komuś innemu to odmowa;
- każda przypisana kwestia listy ujęć jest w skrypcie **dokładnie raz**: pominięta to
  odmowa z nazwą ujęcia i kwestii, powtórzona też.

Odpowiedź, która nie przechodzi walidacji, zostaje w `runs/<runId>/response.json`, a
`dialogue.md` nie powstaje. To błąd formatu wyniku, nie powód do `--regenerate`.

Postać, której nie ma w `Cast` ujęcia, mówi zza kadru. To **meldunek**, nie odmowa:
kwestia jest prawdziwa, tylko lip-sync nie będzie miał czyich ust poruszyć.

## Bramka

- Lista ujęć musi być zatwierdzona, bo każda kwestia z niej pochodzi.
- Odcinek musi mieć dialog: przy `--audio narration` albo `music-and-effects` pada odmowa
  „ten odcinek nie ma dialogu”.
- Lista ujęć zatwierdzona, zanim etap 3 zaczął przypisywać kwestie, nie ma ani jednej.
  Etap 11 odmawia wtedy i wskazuje `shot-list generate --regenerate`, zamiast kupować skrypt,
  który powie, że nie ma czego podnosić.

Głosy postaci, czyli `characters/<c>/voices/<język>/voice.json` z
[etapu 0](00-przygotowanie.md), nie są bramką skryptu. Będą bramką kupowania kwestii.

## Zgoda

`approve --stage dialogue` wymaga `--artifact script`, z powodu etapu 9: przyjęcie skryptu
otworzy kupowanie każdej jego kwestii, a zgoda, której nikt nie nazwał, wydałaby pieniądze,
na które nikt się nie zgodził. `dialogue.md` można poprawić ręcznie: `check` mówi wtedy
„poprawiony ręcznie po generacji”, a `approve` przyjmuje poprawkę, o ile dalej przechodzi
walidację względem listy ujęć.

---

[← etap 10](10-muzyka-i-efekty.md) · [README](../../README.md) · [pełny kontrakt](../pipeline.md)
