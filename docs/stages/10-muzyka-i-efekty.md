# Etap 10: muzyka i efekty

Ostatni zaimplementowany etap. Pisze arkusz cue, kupuje podkład i efekty, i składa
`<tor>/mixed.mp4`, czyli film ze wszystkim.

| | |
|---|---|
| **Wejście** | zatwierdzona `shot-list.md`, `mix.json` (poziomy), a do miksu zatwierdzony `<tor>/episode.mp4`, zatwierdzony `<tor>/narrated.mp4` i przyjęte kwestie [etapu 9](09-narracja.md) |
| **Wyjście** | `sound-design.md`, `sound/Mnn.mp3`, `sound/Enn.mp3`, `sound-design.stage.json` (wspólne); `<tor>/mixed.mp4`, `<tor>/sound-design.stage.json` |
| **Bramka** | zatwierdzony [etap 3](03-lista-ujec.md); miks czeka na zgodę na `narrated.mp4` |
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
`--max-output-tokens <n>`, `--artifact cues|M01[,E02]`, `--regenerate`.

## Poziomy

```bash
pnpm dev sound-design levels dzielna-ewa --music-db -22 --duck-db -12
```

Pozostałe flagi: `--effects-db <n>`, `--duck-release <ms>`, `--dry-run`.

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
we właściwym miejscu nad tym filmem.

## Odmowa i meldunek to dwie różne rzeczy

Efekt wychodzący poza koniec filmu jest **odmową** (zderzenie, precedens etapu 7). Podkład
kończący się przed filmem jest **meldunkiem** (dziura, precedens etapu 8): klipy wróciły
dłuższe niż plan, a odmowa z powodu, którego nikt niżej nie naprawi, byłaby odmową bez
wyjścia.

## Gdzie kończy się ten etap

`mixed.mp4` jest ostatnim plikiem, jaki produkuje ten proces: film z obrazem, narracją,
podkładem i efektami. Tryby dźwięku, które proces obsługuje w całości, to
`music-and-effects` i `narration`; przy każdym innym `check` wypisuje, czego w miksie nie
ma, zamiast milczeć.

---

[← etap 9](09-narracja.md) · [README](../../README.md) · [pełny kontrakt](../pipeline.md)
