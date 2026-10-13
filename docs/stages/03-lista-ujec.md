# Etap 3: lista ujęć

Rozbija scenariusz na sceny, ujęcia i klipy, czyli na plan, z którego powstanie film.
Pierwszy artefakt **wspólny dla obu torów**, więc nie ma w nim poziomu katalogu na tor.

| | |
|---|---|
| **Wejście** | `project.json`, `project.md`, `episode.json`, zatwierdzony `screenplay.md` |
| **Wyjście** | `shot-list.md`, `shot-list.stage.json`, `runs/<runId>/` |
| **Bramka** | zatwierdzony [etap 1](01-scenariusz.md) **i** podjęta decyzja `--max-clip` |
| **Koszt** | jedno płatne wywołanie tekstowe |

Nie zależy od [etapu 2](02-postac.md): nazywa postacie identyfikatorami z obsady, a nie
ich obrazami; te są potrzebne dopiero w [etapie 4](04-pakiet-promptow.md).

## Komendy

```bash
pnpm dev shot-list generate dzielna-ewa 01-burza --dry-run
pnpm dev shot-list generate dzielna-ewa 01-burza
pnpm dev check dzielna-ewa 01-burza
pnpm dev approve dzielna-ewa 01-burza --stage shot-list --note "plan trzyma się kupy"
```

Dodatkowe flagi: `--model <id>`, `--max-output-tokens <n>` (domyślnie 24 000), `--json`,
`--regenerate`, `--instruction <uwaga>` (tylko razem z `--regenerate`).

`--regenerate --instruction "Wydłuż U02, resztę zostaw."` poprawia opublikowany
`shot-list.md` zamiast pisać nowy: model dostaje ten sam prompt, poprzednią wersję i uwagę
dosłownie, a poprzednia wersja z `previous/shot-list.md` staje się wejściem próby. Szczegóły
na stronie [etapu 1](01-scenariusz.md#poprawka-z-uwagą); to nadal nowa płatna próba.

## Etap 3 jako obiekt

`--json` wypisuje **obiekt, który zwraca moduł etapu**, bez osobnego formatu, plus pola
`command` i `stage`:

```bash
pnpm dev check dzielna-ewa 01-burza --stage shot-list --json
pnpm dev approve dzielna-ewa 01-burza --stage shot-list --json
pnpm dev shot-list generate dzielna-ewa 01-burza --dry-run --json
```

`--stage shot-list` zawęża `check` do tego etapu. Bez tej flagi `check <id> <episode-id>`
skleja werdykty etapów 0, 1, 3 i 4 w jeden tekst, którego nie da się rozłożyć z powrotem:
dobre pytanie dla człowieka przy terminalu, nieczytelne dla panelu.

Raport `generate` niesie `paidCalls`, czyli **rachunek w wywołaniach**. Zawsze jeden albo
zero, i właśnie dlatego wart wypisania: pytanie przed kliknięciem brzmi „czy to zaraz kupi
listę ujęć, czy powie, że nie może". Tekst drukuje tę samą liczbę
(`płatnych wywołań do wykonania`), a [panel etapu 3](../ui.md) stawia ją obok przycisku,
który płaci, zamiast szukać jej w polskim zdaniu.

Jeśli `--max-clip` nie zostało jeszcze podjęte w [etapie 0](00-przygotowanie.md), zrób to
teraz, bo bez tej liczby promptu nie da się złożyć:

```bash
pnpm dev episode set dzielna-ewa 01-burza --max-clip 6
```

## Model

`--model <id>`, a bez tej flagi `AIMATOR_SHOTLIST_MODEL`, osobna zmienna, nie ta od
scenariusza. Wspólna znaczyłaby, że wybór modelu do etapu 1 po cichu wybrał też model do
etapu 3, a tego nikt nie zdecydował.

## Trzy jednostki, nigdy utożsamiane

| Jednostka | Czym jest |
|---|---|
| **scena** | ciągła jednostka miejsca i czasu; pochodzi ze scenariusza i nie jest przenumerowywana |
| **ujęcie** | jedno spojrzenie kamery |
| **klip** | jedna planowana generacja wideo, obejmująca jedno lub więcej kolejnych ujęć |

## Co sprawdza walidacja

- cztery sekcje `Plan`, `Clips`, `Shots`, `Review`, w tej kolejności, żadna pusta;
- klipy numerowane kolejno od `C01`, każdy nie dłuższy niż `maxClipSeconds`, kafelkujące
  odcinek **bez dziur**; pierwszy ma `Reference: opening-frame`, każdy kolejny
  `previous-end-frame` albo `new-scene-frame`;
- ujęcia numerowane kolejno od `U01`, każde zaczynające się dokładnie tam, gdzie skończyło
  się poprzednie, i sumujące się dokładnie do `durationSeconds`;
- każde ujęcie w **dokładnie jednej scenie i jednym klipie**, mieszczące się w granicach obu;
- dziesięć pól ujęcia, każde dokładnie raz i niepuste: `Purpose`, `Frame`, `Action`,
  `Expression`, `Camera`, `Cast`, `Audio`, `Text`, `Start state`, `End state`;
- tekst ekranowy **przeniesiony, nie wymyślony**: ujęcie nie może mieć napisu, którego
  jego scena nie miała;
- kwestie postaci zapisane jako `<id>: "…"` tylko w trybach z dialogiem i tylko
  identyfikatorami obsady.

## Kwestie postaci mają mówiącego

Przy `--audio dialogue` albo `dialogue-and-narration` każda kwestia postaci ze scenariusza
trafia do pola `Audio` ujęcia, w którym pada, w postaci identyfikator, dwukropek i kwestia
w prostym cudzysłowie:

```markdown
- Audio: Deszcz o szybę; ewa: "Tato, czy burza już idzie?"
```

Dosłownie ze scenariusza i w języku filmu. Z tego zapisu etap 11 podnosi
skrypt dialogu i dowodzi, że niczego nie wymyślił ani nie pominął; z prozy nie da się
wyczytać, kto mówi. Narrator pisze dalej prozą (`narrator: „…”`), bo
[etap 9](09-narracja.md) sprawdza go po samym tekście.

Walidacja odmawia, gdy identyfikator nie należy do obsady, i gdy taki zapis pojawia się
w odcinku z `--audio narration` albo `music-and-effects`, bo ten film nie ma dialogu.
Listy zatwierdzone wcześniej zostają, jak są; nowy zapis dostają przy `--regenerate`.

## Poprawka ręczna

`shot-list.md` można poprawić wprost w pliku, jak [scenariusz](01-scenariusz.md#poprawka-ręczna).
Poprawka, która dalej przechodzi walidację względem scenariusza w obecnym kształcie, jest
wygaśnięciem zgody, nie błędem. `check` mówi „poprawiony ręcznie po generacji”, a `--json`
wymienia plik w `amended`. `aimator approve <id> <episode-id> --stage shot-list` przepina
hash i dopisuje wpis w `amendments`. Poprawka, która łamie plan (na przykład ujęcia
przestają sumować się do `durationSeconds`), daje błąd walidatora, a `approve` odmawia.

Kaskada działa w obie strony bez nowego kodu. Poprawiony scenariusz cofa zgodę na listę ujęć
przez `inputsChanged`, bo lista zapisała jego hash jako wejście. Poprawiona lista ujęć cofa
w ten sam sposób zgodę na [pakiet promptów](04-pakiet-promptow.md).

## `Cast` wiąże ujęcie z postacią

Każde ujęcie wymienia widoczne postacie **identyfikatorami obsady** (`ewa`, `tata`) albo
`none`. Proza pól opisowych używa imion i odmienia je naturalnie, i właśnie dlatego imię
nie może być wiązaniem: „Ewy" i „Ewie" to ten sam człowiek, a dopasowywanie tego w tekście
byłoby zgadywaniem. Identyfikator jest jedyną drogą, którą etap 4 dojdzie od ujęcia do
zatwierdzonego `hero.png`.

Postać widziana raz nie należy do obsady: opisuje ją `Frame` i `Action`, a obrazem staje
się w [etapie 5](05-referencje.md).

## Nie ma `shot-list.json`

`validateShotList` rozbiera dokument w trakcie walidacji i zwraca to, co rozebrał: ujęcia,
klipy, sceny, czasy i obsadę, więc etap 4 czyta je jako dane. Drugi plik dałby odcinkowi
dwie wersje tej samej prawdy, a po pierwszej ręcznej poprawce rozjechałyby się.

---

[← etap 2](02-postac.md) · [README](../../README.md) ·
[etap 4: pakiet promptów →](04-pakiet-promptow.md) · [pełny kontrakt](../pipeline.md)
