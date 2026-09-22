# Etap 9: narracja

Pierwszy etap, który kupuje od **dwóch dostawców**, i pierwszy, którego artefakty leżą na
**dwóch poziomach drzewa**: słowa są wspólne dla obu torów, miks jest per tor.

| | |
|---|---|
| **Wejście** | zatwierdzona `shot-list.md`, `narratorVoiceId` z `project.json`, `narration.json` (sposób czytania), a do miksu zatwierdzony `<tor>/episode.mp4` |
| **Wyjście** | `narration.md`, `narration/Nnn.wav`, `soundtrack.stage.json` (wspólne); `<tor>/narrated.mp4`, `<tor>/soundtrack.stage.json` |
| **Bramka** | zatwierdzony [etap 3](03-lista-ujec.md) i obsadzony głos; miks czeka na zatwierdzony [etap 8](08-montaz.md) |
| **Koszt** | płatny; rachunek liczy się w **znakach**, nie w wywołaniach |

## Komendy

```bash
pnpm dev narration generate dzielna-ewa 01-burza --dry-run
pnpm dev narration generate dzielna-ewa 01-burza          # najpierw sam skrypt
pnpm dev approve dzielna-ewa 01-burza --stage soundtrack --artifact script \
  --note "każde zdanie jest w swoim ujęciu"
pnpm dev narration generate dzielna-ewa 01-burza          # dopiero teraz kupuje kwestie
pnpm dev check dzielna-ewa 01-burza --stage soundtrack
pnpm dev approve dzielna-ewa 01-burza --stage soundtrack --artifact N01,N02,N03,N04
pnpm dev narration mix dzielna-ewa 01-burza --track gpt-image
pnpm dev approve dzielna-ewa 01-burza --stage soundtrack --track gpt-image
```

Dodatkowe flagi: `--model <id>`, `--voice-model <id>`, `--max-output-tokens <n>`,
`--artifact script|N01[,N02]`, `--regenerate`, `--json`.

## `--json`, czyli obiekt na dwóch poziomach

`narration generate`, `narration mix`, `narration direction`, `check --stage soundtrack`
i `approve --stage soundtrack` przyjmują `--json` i wypisują obiekt etapu zamiast zdań:
ten sam, który zwraca moduł, plus `command` i `stage`. `command` niesie **podpolecenie**
(`generate`, `mix`, `direction`), bo jeden etap piszą tutaj trzy gramatyki i jedno słowo
dla wszystkich odpowiadałoby zgadywaniem na pytanie „która komenda to zapisała".

Poziom rozstrzyga `--track`, i to nie jest zawężenie, tylko **wybór pytania**: bez flagi
`check` i `approve` odpowiadają o słowach, wspólnych dla obu torów; z flagą odpowiadają
o miksie tego toru. Dlatego zatwierdzenie skryptu i zatwierdzenie kwestii to dwie różne komendy
(`--artifact script` oraz `--artifact N01,N02`), a zatwierdzenie miksu trzecia.

Rachunek w obiekcie stoi w dwóch polach, `calls` i `characters`, i nigdy się ich nie
sumuje: dostawca liczy znaki, więc liczba wywołań przestaje tu być rachunkiem.
`contextCharacters` jest **obok** rachunku, nie w nim.

## Narracja jest podnoszona, nie pisana, i walidator to sprawdza

Słowa narratora powstały już w [etapie 1](01-scenariusz.md), a [etap 3](03-lista-ujec.md)
przeniósł je do pola `Audio` każdego ujęcia, gdzie siedzą w zdaniu opisującym też muzykę
i deszcz. Wyciąganie ich parserem byłoby parserem nad prozą, więc robi to model, a
walidator dowodzi, że podniesienie było podniesieniem: **tekst każdej kwestii musi wystąpić
co do słowa w ujęciu, które ta kwestia nazywa.**

Zdanie, którego lista ujęć nie zawiera, nie przechodzi, choćby czytało się lepiej. Jeśli
film ma powiedzieć coś nowego, poprawka należy do etapu 1.

## Głos to obsada, sposób czytania to reżyseria

`narratorVoiceId` mieszka w `project.json` obok postaci, bo lektor wraca między odcinkami;
obsadza go [etap 0](00-przygotowanie.md). To, *jak* on gra, mieszka w osobnym
`projects/<id>/narration.json`:

```bash
pnpm dev narration direction dzielna-ewa --stability 0.35 --style 0.4
```

Pozostałe flagi: `--speed <0.7-1.2>`, `--similarity <0-1>`, `--speaker-boost`, `--dry-run`.

To nie jest kaprys układu. `project.json` jest zapisanym wejściem niemal wszystkiego, więc
suwak, który ma się kręcić, unieważniałby zgody na bajty, których nie dotknął o ani jeden
bit. Tutaj unieważnia dokładnie te nagrania, które powstały pod starym brzmieniem.

Bez tej decyzji każde wywołanie szło na domyślnych ustawieniach dostawcy, czyli `stability 0.5`
i `style 0`, które sam dostawca opisuje jako skłonne do monotonii. Płaskie brzmienie nie
było wadą głosu, tylko brakiem miejsca na decyzję.

## Rachunek nie jest w wywołaniach

Dostawca liczy **znaki wejścia**, więc podgląd podaje jedno i drugie, per kwestia i łącznie.
Znaki kontekstu (`previous_text`/`next_text`) są liczone **obok** rachunku, nigdy w nim:
dostawca dokumentuje te parametry, ale nie mówi, czy je rozlicza, a narzędzie nie zgaduje
cudzymi pieniędzmi.

## Bajtami rządzi etap 8, umieszczeniem etap 7

Publikuje się to, co wróciło, bez rozciągania czasu i skracania pauzy. Ale kotwica
pochodzi z planu, który zatwierdził człowiek, więc kwestia nachodząca na następną albo
wychodząca poza koniec filmu jest **odmową**, nie zaokrągleniem.

Kotwica z planu nie jest sekundą filmu: klipy wróciły dłuższe, więc mikser przelicza jedno
na drugie i **melduje przesunięcie**.

`episode.mp4` nie jest dotykany. `narrated.mp4` to nowy plik, którego obraz jest kopią
strumieniową zatwierdzonego cięcia, klatka w klatkę.

## Gdzie kończy się ten etap

Narracja to nie cała ścieżka; muzykę i efekty dokłada [etap 10](10-muzyka-i-efekty.md),
więc ich brak jest tu meldowany, dokładnie jak cisza w etapie 8.

---

[← etap 8](08-montaz.md) · [README](../../README.md) ·
[etap 10: muzyka i efekty →](10-muzyka-i-efekty.md) · [pełny kontrakt](../pipeline.md)
