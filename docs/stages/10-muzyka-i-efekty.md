# Etap 10: muzyka i efekty

Pisze arkusz cue, kupuje podkład i efekty, i składa `<tor>/mixed.mp4`, czyli film ze
wszystkim: obrazem, narracją, kwestiami postaci, muzyką i efektami.

| | |
|---|---|
| **Wejście** | zatwierdzona `shot-list.md`, `mix.json` (poziomy), a do miksu zatwierdzony `<tor>/episode.mp4`, przy narracji zatwierdzony `<tor>/narrated.mp4` i przyjęte kwestie [etapu 9](09-narracja.md), przy dialogu przyjęte kwestie [etapu 11](11-dialog.md) |
| **Wyjście** | `sound-design.md`, `sound/Mnn.mp3`, `sound/Enn.mp3`, `sound-design.stage.json` (wspólne); `<tor>/mixed.mp4`, `<tor>/sound-design.stage.json` |
| **Bramka** | zatwierdzony [etap 3](03-lista-ujec.md); miks czeka na zgodę na `narrated.mp4` (z narracją) i na każdą kwestię dialogu (z dialogiem) |
| **Koszt** | płatny; rachunek liczy się w **sekundach dźwięku**, nie w wywołaniach |

## Komendy

```bash
pnpm dev sound-design generate dzielna-ewa 01-burza --dry-run
pnpm dev sound-design generate dzielna-ewa 01-burza      # jedno wywołanie TEKSTOWE
pnpm dev approve dzielna-ewa 01-burza --stage sound-design --artifact cues
pnpm dev sound-design generate dzielna-ewa 01-burza --dry-run   # TU pojawia się rachunek
pnpm dev sound-design generate dzielna-ewa 01-burza      # kupuje podkład i efekty
pnpm dev check dzielna-ewa 01-burza --stage sound-design
pnpm dev approve dzielna-ewa 01-burza --stage sound-design --artifact M01,E01,E02
pnpm dev sound-design mix dzielna-ewa 01-burza --track gpt-image
pnpm dev approve dzielna-ewa 01-burza --stage sound-design --track gpt-image
```

Dodatkowe flagi: `--model <id>`, `--music-model <id>`, `--effects-model <id>`,
`--max-output-tokens <n>`, `--artifact cues|M01[,E02]`, `--regenerate`, `--instruction <uwaga>`,
`--json`.

`--regenerate --artifact cues --instruction "<uwaga>"` poprawia opublikowany
`sound-design.md` zamiast pisać arkusz od nowa, a poprzednia wersja z
`previous/sound-design.md` staje się wejściem próby. Uwaga ma jednego adresata, arkusz:
podkład i efekt kupuje się z jego własnych wierszy, więc `--instruction` przy
`--artifact M01` to błąd użycia. Szczegóły na stronie [etapu 1](01-scenariusz.md#poprawka-z-uwagą).

## `--json`, czyli obiekt na dwóch poziomach

`sound-design generate`, `sound-design mix`, `sound-design levels`,
`check --stage sound-design` i `approve --stage sound-design` przyjmują `--json` i
wypisują obiekt etapu zamiast zdań: ten sam, który zwraca moduł, plus `command` i `stage`.
`command` niesie **podpolecenie** (`generate`, `mix`, `levels`), bo jeden etap piszą tutaj
trzy gramatyki, tak samo jak w [etapie 9](09-narracja.md).

Poziom rozstrzyga `--track`, i to nie jest zawężenie, tylko **wybór pytania**: bez flagi
`check` i `approve` odpowiadają o arkuszu i stemach, wspólnych dla obu torów; z flagą
odpowiadają o pełnej ścieżce tego toru.

Rachunek w obiekcie stoi w dwóch polach, `calls` i `seconds`, i nigdy się ich nie sumuje:
dostawca wycenia **za minutę wygenerowanego dźwięku**, więc jedno wywołanie na
trzydziestosekundowy podkład i jedno na trzysekundowy grzmot to ta sama liczba wywołań
i nic podobnego do tej samej kwoty.

Tym etapem lista się domyka: `--json` mają już wszystkie komendy wszystkich etapów.

## Poziomy

```bash
pnpm dev sound-design levels dzielna-ewa --music-db -22 --duck-db -12
```

Pozostałe flagi: `--effects-db <n>`, `--duck-release <ms>`, `--dry-run`, `--json`.

Mieszkają w `projects/<id>/mix.json`, a nie w `project.json`, bo suwak unieważniałby zgody
na bajty, których nie dotknął, i nie w `narration.json`, bo głośność podkładu nie mówi nic
o tym, jak narrator czytał, więc nie może unieważniać nagrań. Wartości startowe są, bo
**tej decyzji nie da się podjąć, zanim się ją usłyszy**; jadą do silnika jawnie i lądują
w archiwum.

## Wiersz 10 się zmienił i jest to zapisane

Kontrakt mówił, że muzyka i efekty są *wejściem* wnoszonym przez człowieka, i sam
przyznawał, że nie rozstrzyga, skąd się biorą. Tak się go nie da zbudować: wciąganie
cudzych plików do katalogu roboczego ma monopol [etapu 0](00-przygotowanie.md), więc
„wnosi człowiek" było przepisaniem etapu 0 pod inną nazwą.

Stemy kupuje więc ten etap, od ElevenLabs, co nie jest czwartym dostawcą, tylko czwartym
i piątym miejscem wywołania u dostawcy, którego potok już ma na mowę.

## Nie ma tu reguły „podnoszone, nie pisane" i nie da się jej mieć

Prompt muzyczny jest **instrukcją**, więc reguła 9 każe pisać go po angielsku; pole
`Audio`, z którego powstaje, jest **materiałem** po polsku, którego reguła 9 zabrania
tłumaczyć. Przepisanie jest zakazane z obu stron. Precedensem jest więc
[etap 4](04-pakiet-promptow.md), nie 9: **werdykt okablowania, który nigdy nie czyta
promptu**.

| co udowadnia walidator | co zostaje człowiekowi |
|---|---|
| każdy cue nazywa ujęcia, które istnieją | czy angielski opisuje polską prozę |
| **ujęcia cue to dokładnie te, które leżą w jego sekundach** | czy to jest dobra muzyka |
| podkład kafelkuje film od 0 do końca planu, bez dziur | |
| każda długość jest taka, jaką dostawca zrenderuje | |

Drugi wiersz niesie ciężar, który piętro wyżej niesie podnoszenie: wierności nie dowodzi,
ale dowodzi, że model przeszedł **cały plan**: ujęcie pominięte i ujęcie wymyślone
wychodzą tak samo.

## Poprawka ręczna

`sound-design.md` można poprawić wprost w pliku, na przykład przeredagować opis podkładu.
Poprawka jest wygaśnięciem zgody, nie błędem. `check` mówi „poprawiony ręcznie po
generacji”, a `--json` wymienia plik w `amended`. Werdykt okablowania obowiązuje dalej:
poprawka, po której podkład nie kafelkuje filmu albo cue nazywa nie te ujęcia, dostaje
odmowę walidatora. `approve --stage sound-design --artifact cues` przyjmuje poprawkę,
przepina hash i dopisuje wpis w `amendments`, jak przy
[scenariuszu](01-scenariusz.md#poprawka-ręczna). Każdy stem zapisuje hash arkusza, z którego
go kupiono, więc stemy kupione ze starego arkusza tracą zgodę.

## Rachunek jest w sekundach

Cennik dostawcy wygląda na sprzeczny: tabela podaje cenę za minutę, a FAQ mówi „per
generation". To odpowiedzi na dwa pytania: tabela podaje jednostkę **stawki**, FAQ
**moment naliczenia**. Wniosek jest twardy: `--regenerate` to **druga pełna opłata**, nie
dopłata, i raport mówi to tam, gdzie ktoś przeczyta.

## Składa z `episode.mp4`, nie z `narrated.mp4`

Miksowanie na narracji kodowałoby mowę drugi raz i czyniłoby ducking nieuczciwym, bo głos
byłby już w sygnale, pod który muzyka ma ustępować.

`narrated.mp4` nie jest ani nadpisywany, ani unieważniany; staje się przyjętym produktem
pośrednim, a etap 10 bramkuje od **zgody** na niego, bo to jedyny dowód, że narracja siedzi
we właściwym miejscu nad tym filmem. Ta bramka obowiązuje wyłącznie w trybach z narratorem,
`narration` i `dialogue-and-narration`: film samego dialogu nie ma czego czekać od etapu 9.

## Kwestie postaci w pełnej ścieżce

W trybach `dialogue` i `dialogue-and-narration` miks kładzie przyjęte kwestie
[etapu 11](11-dialog.md) jako kolejny stem mowy, obok narracji, a nie jako drugi miks.
Silnik dostaje je w tej samej liście mowy co narratora, więc podkład ustępuje pod kwestią
postaci tak samo jak pod lektorem.

- **Bramka:** każda kwestia skryptu dialogu z ważną zgodą. Odmowa wymienia każdą brakującą,
  z powodem: niekupiona albo bez zgody. `check --stage sound-design --track <tor>` mówi to
  samo, zanim ktoś spróbuje miksu.
- **Umieszczenie:** kotwica z planu przeliczona na zegar filmu tego toru, tą samą
  arytmetyką co narracja etapu 9 (`lib/timeline`). Kwestia startuje tam, gdzie wypada jej
  sekunda planu po dryfie klipów.
- **Odmowa:** gdy **dowolne** dwie wypowiedzi brzmiałyby naraz, dwie kwestie albo kwestia
  i narracja, komunikat podaje obie nazwy i obie sekundy. Gdy wypowiedź kończy się po
  filmie, też. Poprawka to krótsza kwestia tam, gdzie powstała (scenariusz, etap 1) albo
  przesunięta kotwica w jej skrypcie; nagrań nikt nie przyspiesza ani nie przycina.

Dopóki kwestie nie są wszystkie przyjęte, `check --stage sound-design` melduje, że pełna
ścieżka nie położy mowy postaci. Gdy są, meldunek znika.

## Odmowa i meldunek to dwie różne rzeczy

Efekt wychodzący poza koniec filmu jest **odmową** (zderzenie, precedens etapu 7). Podkład
kończący się przed filmem jest **meldunkiem** (dziura, precedens etapu 8): klipy wróciły
dłuższe niż plan, a odmowa z powodu, którego nikt niżej nie naprawi, byłaby odmową bez
wyjścia.

## Gdzie kończy się ten etap

`mixed.mp4` jest ostatnim plikiem, jaki produkuje ten proces: film z obrazem, narracją,
kwestiami postaci, podkładem i efektami. Proces obsługuje w całości wszystkie cztery tryby
dźwięku: `music-and-effects`, `narration`, `dialogue` i `dialogue-and-narration`.

---

[← etap 9](09-narracja.md) · [README](../../README.md) ·
[etap 11: dialog →](11-dialog.md) · [pełny kontrakt](../pipeline.md)
