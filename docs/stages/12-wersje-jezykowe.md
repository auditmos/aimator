# Etap 12: wersje językowe

Usta postaci przestawione na język ust odcinka, czyli drugi język, w którym film dostaje
dialog. Etap pracuje **per tor i klip po klipie**: rozpoznaje twarze w przyjętym klipie,
zapisuje, która twarz jest którą postacią, i rusza usta każdej postaci mówiącej w kadrze
do jej przyjętych kwestii z [etapu 11](11-dialog.md). Klipy, w których nikt widoczny nie
mówi, przechodzą do wersji bez zmian. Na końcu składa z tego **dwa filmy na tor**: FINAL
w języku ust i FINAL w języku filmu, na jednym obrazie i z tą samą muzyką.

| | |
|---|---|
| **Wejście** | `lip-sync.json` odcinka, przyjęty przekład `dialogue.<kod>.md` i przyjęte kwestie `dialogue/<kod>/Dnn.wav` z [etapu 11](11-dialog.md), zatwierdzona `shot-list.md`, przyjęte klipy `<tor>/clips/Cnn.mp4` z [etapu 7](07-klipy.md); do filmów także przyjęte kwestie w języku filmu, przyjęte stemy i `mix.json` z [etapu 10](10-muzyka-i-efekty.md) |
| **Wyjście** | `<tor>/versions/faces/Cnn/faces.json`, obrazek każdej twarzy, `binding.json`, `<tor>/versions/clips/Cnn.mp4`, `<tor>/versions/episode.mp4` (obraz obu filmów), `<tor>/versions/<kod>.mp4` (film w każdym z dwóch języków), `<tor>/versions.stage.json`, `<tor>/runs/<runId>/` |
| **Bramka** | `lip-sync.json` z językiem i `--audio dialogue`; per klip: przyjęty klip, przyjęty przekład i przyjęte kwestie tego klipu, rozpoznane twarze i przypisanie każdej postaci mówiącej w kadrze; film: zgoda na każdy klip wersji, przyjęte kwestie swojego języka i przyjęte stemy |
| **Koszt** | rozpoznanie twarzy: jedno płatne wywołanie Kling na klip; lip-sync: jedno zadanie Kling na mówiącą postać, a każda kolejna postać w klipie dokłada jedno rozpoznanie; filmy: nic, składa je lokalny ffmpeg |

## Komendy

```bash
pnpm dev versions faces dzielna-ewa 01-burza --track seedream --artifact C01 --dry-run
pnpm dev versions faces dzielna-ewa 01-burza --track seedream --artifact C01
pnpm dev versions bind dzielna-ewa 01-burza --track seedream --artifact C01 --face 0=ewa,1=tata
pnpm dev versions lip-sync dzielna-ewa 01-burza --track seedream --dry-run
pnpm dev versions lip-sync dzielna-ewa 01-burza --track seedream --artifact C01
pnpm dev check dzielna-ewa 01-burza --stage versions --track seedream
pnpm dev approve dzielna-ewa 01-burza --stage versions --track seedream --artifact C01 \
  --note "usta trafiają w kwestie"
pnpm dev versions final dzielna-ewa 01-burza --track seedream --language en --dry-run
pnpm dev versions final dzielna-ewa 01-burza --track seedream --language en
pnpm dev versions final dzielna-ewa 01-burza --track seedream --language pl
pnpm dev approve dzielna-ewa 01-burza --stage versions --track seedream --artifact en \
  --checks animation,timing,acting,lip-sync,continuity
pnpm dev approve dzielna-ewa 01-burza --stage versions --track seedream --artifact pl
```

Każde polecenie przyjmuje `--dry-run` i `--json`; `versions faces`, `versions lip-sync`
i `versions final` także `--regenerate`. Klucz to `KLING_API_KEY`, a klip, którego Kling nie zna po
identyfikatorze, jest pożyczany z prywatnego bucketu R2 (`AIMATOR_LIPSYNC_BUCKET` i trzy
zmienne `R2_*`, [konfiguracja](../konfiguracja.md)). Podgląd nie czyta żadnego klucza.

## Bramka całego etapu

Etap wisi na jednej decyzji odcinka: w jakim języku ruszają się usta. Bez `lip-sync.json`
każde polecenie odmawia i podaje `episode lip-sync … --language <kod>`; przy `--none`
odmawia, bo odcinek nie dostaje drugiej wersji. Odcinek `dialogue-and-narration` dostaje
odmowę: narracja w drugim języku jest poza zakresem, a narrator w języku filmu nad
angielskimi ustami nie jest wersją. Odcinek bez dialogu nie ma czyich ust poruszyć.

## Które klipy

Zbiór jest **wyprowadzany, nigdy zapisywany**: lip-syncu potrzebuje klip, w którym leży
kwestia przekładu wypowiadana przez postać widoczną w ujęciu (`Cast`). Lista ujęć mówi, do
którego klipu należy ujęcie i kogo pokazuje, a przekład mówi, kto gdzie mówi. Kwestia
spoza kadru zostaje bez lip-syncu i trafia do meldunku (`·`), bo nie ma czyich ust
poruszyć. Klip bez widocznego mówiącego pada w `check` jako „bez zmian”.

## Twarze i przypisanie

`versions faces` rozpoznaje twarze w jednym przyjętym klipie jednym płatnym wywołaniem
i zapisuje `faces.json`: sesję, którą adresuje się zadanie lip-sync, oraz każdą twarz z jej
przedziałem w ms. Obok leży obrazek każdej twarzy, żeby człowiek widział, kogo przypisuje;
jego rozszerzenie to format, który oddał dostawca. Klip wyrenderowany przez Kling w ciągu
30 dni idzie po jego `video_id`, każdy inny po podpisanym adresie z prywatnego bucketu,
zabieranym po wywołaniu. Drugie rozpoznanie tego samego klipu to druga opłata, więc bez
`--regenerate` pada odmowa.

`versions bind` zapisuje w `binding.json`, która twarz jest którą postacią: `--face
0=ewa,1=tata`. **Zawsze jawnie, także przy jednej twarzy**: twarz to decyzja człowieka,
nigdy wniosek. Twarz, której rozpoznanie nie znalazło, postać spoza obsady i dwie twarze
jednej postaci to błąd. `binding.json` zapisuje sha256 `faces.json`, któremu odpowiada,
więc ponowne rozpoznanie cofa przypisanie, a ponowne wyrenderowanie klipu w etapie 7 cofa
rozpoznanie.

`check` pokazuje przy każdym klipie, co znaleziono i kogo przypisano: w tekście linia
`twarze: 0 (0–15000 ms); przypisanie: 0=ewa`, a w `--json` pola `faces` (id, przedział
i ścieżka obrazka) i `binding`, oba `null`, dopóki nie ma czego pokazać.

## Lip-sync i rachunek

Dostawca porusza **jedną twarz na zadanie**. Postać mówiąca w kadrze dostaje więc jedno
zadanie, a jej kwestie w tym klipie jadą jako jedna ścieżka: każda na swojej pozycji,
z ciszą pomiędzy, dopełniona do dwóch sekund. Pozycja to kotwica z planu przeliczona na zegar
filmu tego toru, a potem na czas lokalny klipu. Zadania biegną w kolejności pierwszej kwestii
każdej postaci. Drugie zadanie idzie na wyniku pierwszego: nowe rozpoznanie twarzy po jego
`video_id` otwiera nową sesję, a twarz to ta sama `face_id`, którą przypisał człowiek. Jeśli
w nowej sesji jej nie ma, pada odmowa.

```
Próba na sucho: nic nie zapisano, nic nie wysłano. Lip-sync dzielna-ewa/01-burza, tor seedream
  płatnych wywołań do wykonania, rozpoznań: 1, zadań lip-sync: 3
  C01:
      C01:ewa: ewa, twarz 0, od 1000 ms do 3000 ms, en:D01, planned
      C01: tata, twarz 1, od 11000 ms do 13000 ms, en:D02, planned
  C02:
      C02: tata, twarz 1, od 6000 ms do 8000 ms, en:D04, planned
  · en:D03: ewa mówi spoza kadru ujęcia U03, nie ma czyich ust poruszyć, kwestia zostaje bez lip-syncu
```

Wynik ostatniego zadania to `versions/clips/Cnn.mp4`; wynik każdego wcześniejszego leży
w `versions/clips/Cnn/<postać>.mp4`, bo kolejne zadanie jest adresowane właśnie nim. Klip
z nieprzyjętą kwestią, bez rozpoznanych twarzy albo bez przypisania czeka, a podgląd liczy
w rachunku tylko klipy gotowe. Polecenie bez `--dry-run` odmawia, dopóki choć jeden ze
wskazanych klipów czeka, i wymienia każdą przeszkodę; `--artifact` zawęża zakup do klipów
gotowych. Przerwane zadanie kończy ponowienie polecenia, bez drugiej opłaty.

## Dwa filmy: FINAL w języku ust i FINAL w języku filmu

`versions final … --language <kod>` niczego nie kupuje. Najpierw skleja **jeden obraz dla
obu filmów**, `versions/episode.mp4`: klipy w kolejności listy ujęć, wersję z lip-synciem
tam, gdzie twarz się ruszyła, przyjęty klip etapu 7 wszędzie indziej. To sam obraz, kopia
strumienia bez przekodowania; dźwięk, z którym wraca klip po lip-syncu, zostaje zdjęty.
Drugi film nie skleja obrazu od nowa, tylko kładzie się na tym samym pliku, więc oba filmy
nie różnią się ani jedną klatką. Obraz powstaje ponownie wyłącznie wtedy, gdy zmienił się
któryś jego klip.

Na obrazie leżą kwestie jednego języka i **te same** przyjęte stemy etapu 10, na poziomach
z `mix.json`, ze ściszaniem muzyki pod mową jak w pełnej ścieżce:

| `--language` | Plik | Mowa |
|---|---|---|
| język ust, np. `en` | `versions/en.mp4` | kwestie przekładu `en:Dnn`, także te spoza kadru |
| język filmu, np. `pl` | `versions/pl.mp4` | kwestie `Dnn` w języku filmu, czyli klasyczny dubbing: usta pasują do angielskiego |

Inny kod to odmowa. Film czeka na zgodę każdego klipu, który potrzebuje lip-syncu (odmowa
wymienia klip), na przyjęte klipy etapu 7 w pozostałych miejscach, na każdą kwestię swojego
języka i na każdy stem. Odmową są też:

- klipy obrazu o różnym kadrze, kodeku albo tempie klatek, czytanych z boksów MP4, bo kopia
  strumienia ich wymaga, a etap niczego nie przekodowuje;
- dwie wypowiedzi brzmiące naraz albo wypowiedź za końcem filmu, liczone na zegarze obrazu
  wersji. Poprawka to skrócenie kwestii w przekładzie (`dialogue translate --regenerate
  --instruction`) albo w skrypcie.

Podgląd (`--dry-run`) wypisuje klipy obrazu ze źródłem każdego, poziomy, każdy dźwięk
z sekundą planu i sekundą filmu oraz wszystkie przeszkody naraz. Gotowego filmu polecenie
nie składa ponownie bez `--regenerate`; z nim poprzedni film trafia najpierw do archiwum
próby. Potrzebny jest ffmpeg (`PATH` albo `AIMATOR_FFMPEG`). Odcinek z narratorem wersji nie
ma, więc nie ma też polskiego filmu z narracją w tym etapie: pełny polski film z narracją
to `mixed.mp4` etapu 10.

## Zgoda

`approve … --stage versions --track <tor> --artifact C01[,C02]` przyjmuje klip wersji,
związany z jego sha256 i ze wszystkim, z czego powstał: klipem, `faces.json`,
`binding.json` i nagraniem każdej kwestii. `--artifact` jest wymagane, bo każdy klip to
osobny osąd, czy usta trafiają w kwestie. Zmiana któregokolwiek wejścia cofa zgodę, a
`check` mówi, który plik się zmienił. Przyjmuje się wyłącznie klip, nigdy krok przed nim.

Film przyjmuje się po kodzie języka. **Film w języku ust wymaga checklisty**, bo to w nim
ruszono usta: `--checks animation,timing,acting,lip-sync,continuity` albo `--checks all`
(animacja, rozłożenie kwestii w czasie, gra postaci, usta na słowach, ciągłość między
klipami). Bez niej albo z niepełną listą `approve` odmawia i wymienia brakujące kryteria,
a lista trafia do `review.checks`. **Film w języku filmu przyjmuje się bez checklisty.**
Zgodę na film cofa zmiana obrazu, każdego jego klipu, kwestii, stemu i `mix.json`, także
takiego, który powstał dopiero po złożeniu filmu. `check` pokazuje stan obu filmów
(`film en: …`, `film pl: …`, w `--json` pole `finals`), a etap jest zatwierdzony dopiero
ze zgodą na każdy klip wersji i na oba filmy.

`reject … --stage versions --track <tor> --artifact C01 --note <uwaga>` zapisuje „nie” na
tych samych zasadach: `--artifact` jest wymagane i wskazuje wyłącznie klip wersji, nie
`faces:C01` (to, co znalazł dostawca), krok `C01:ewa`, film (`en`, `pl`) ani obraz
`episode`; film, który nie przechodzi oceny, zostaje bez zgody. Odrzucony klip kupuje się od
nowa przez `versions lip-sync … --artifact C01 --regenerate`; jeśli uwaga dotyczy tego, kto
jest kim, najpierw poprawia się przypisanie przez `versions bind`. Lip-sync uwagi nie czyta,
więc zostaje ona w rekordzie dla człowieka.

---

[← etap 11](11-dialog.md) · [README](../../README.md) · [pełny kontrakt](../pipeline.md)
