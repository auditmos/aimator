# Etap 11: dialog

Kwestie, które mówią postacie, w języku filmu. Etap ma dwie połowy, tak jak etap 9: najpierw
**skrypt**, czyli które kwestie, kto je mówi, w którym ujęciu i od której sekundy planu;
potem **kwestie**, każda kupiona głosem swojej postaci. Przyjęte kwestie kładzie w filmie
miks [etapu 10](10-muzyka-i-efekty.md).

| | |
|---|---|
| **Wejście** | zatwierdzona `shot-list.md` z kwestiami zapisanymi jako `<id>: "…"`, `project.json`, `project.md`, `episode.json`, a do kwestii `characters/<c>/voices/<język filmu>/voice.json` każdej mówiącej postaci; do przekładu `lip-sync.json` |
| **Wyjście** | `dialogue.md`, `dialogue/<język>/Dnn.wav`, `dialogue.<język ust>.md`, `dialogue.stage.json`, `runs/<runId>/` (wspólne dla obu torów) |
| **Bramka** | zatwierdzony [etap 3](03-lista-ujec.md) i `--audio dialogue` albo `dialogue-and-narration`; kwestie czekają na przyjęty skrypt i przyjętą próbkę głosu swojej postaci; przekład na przyjęty skrypt i decyzję o języku ust; kwestie w drugim języku na przyjęty przekład i przyjętą próbkę głosu w tym języku |
| **Koszt** | skrypt i przekład: po jednym płatnym wywołaniu tekstowym; kwestie: jedno wywołanie mowy na kwestię, rachunek liczy się w **znakach** |

## Komendy

```bash
pnpm dev dialogue generate dzielna-ewa 01-burza --dry-run
pnpm dev dialogue generate dzielna-ewa 01-burza          # najpierw sam skrypt
pnpm dev check dzielna-ewa 01-burza --stage dialogue
pnpm dev approve dzielna-ewa 01-burza --stage dialogue --artifact script \
  --note "każda kwestia jest w swoim ujęciu"
pnpm dev dialogue generate dzielna-ewa 01-burza --dry-run  # rachunek kwestii
pnpm dev dialogue generate dzielna-ewa 01-burza          # dopiero teraz kupuje kwestie
pnpm dev approve dzielna-ewa 01-burza --stage dialogue --artifact D01,D02,D03
pnpm dev dialogue generate dzielna-ewa 01-burza --regenerate --artifact D03
pnpm dev episode lip-sync dzielna-ewa 01-burza --language en
pnpm dev dialogue translate dzielna-ewa 01-burza --dry-run   # okna czasu w prompcie
pnpm dev dialogue translate dzielna-ewa 01-burza
pnpm dev approve dzielna-ewa 01-burza --stage dialogue --artifact script-en
pnpm dev dialogue generate dzielna-ewa 01-burza --language en --dry-run
pnpm dev dialogue generate dzielna-ewa 01-burza --language en
pnpm dev approve dzielna-ewa 01-burza --stage dialogue --artifact en:D01,en:D02,en:D03
```

Dodatkowe flagi: `--model <id>`, `--voice-model <id>`, `--max-output-tokens <n>`
(domyślnie 8 000), `--artifact script|D01[,D02]`, `--language <kod>`, `--regenerate`,
`--instruction <uwaga>` (tylko razem z `--regenerate --artifact script`), `--json`.
`--language` z językiem ust kupuje kwestie przekładu, a nie języka filmu
([Kwestie w drugim języku](#kwestie-w-drugim-języku)); bez niej albo z językiem filmu
wszystko działa jak dotąd.

`dialogue translate` przyjmuje `--model <id>`, `--max-output-tokens <n>`, `--regenerate`,
`--instruction <uwaga>` (tylko z `--regenerate`), `--dry-run` i `--json`; nie ma
`--artifact`, bo przekład odcinka jest jeden.

Trzy modele, trzy zmienne, bez wartości domyślnych ([konfiguracja](../konfiguracja.md)):

- skrypt podnosi `--model` albo `AIMATOR_DIALOGUE_MODEL`, własna zmienna, nie ta od
  narracji: dwa miejsca wywołania, więc wybór modelu, który podnosi narrację, nie może po
  cichu wybrać modelu, który podnosi dialog;
- kwestie czyta `--voice-model` albo `AIMATOR_DIALOGUE_VOICE_MODEL`, ta sama zmienna co
  próbki głosów postaci, bo próbka istnieje po to, żeby brzmieć tak, jak zabrzmią kwestie;
- przekład pisze `--model` polecenia `dialogue translate` albo `AIMATOR_TRANSLATION_MODEL`,
  własna zmienna, bo podnoszenie kwestii z listy ujęć i przepisywanie ich w innym języku pod
  okno czasu to dwa różne zadania.

`--regenerate` po powstaniu skryptu wymaga adresata, z powodu etapu 9: `--artifact script`
podnosi skrypt od nowa, `--artifact D03` kupuje jedną kwestię jeszcze raz. Druga próba to
druga opłata, więc bez nazwy pada odmowa. `--instruction` poprawia sam skrypt, bo kwestię
kupuje się z jego własnych słów; przy `--artifact D01` to błąd użycia.

## `--json`

`dialogue generate`, `check --stage dialogue` i `approve --stage dialogue` przyjmują
`--json` i wypisują obiekt, który zwraca moduł etapu, plus `command` i `stage`. Raport
`generate` niesie rachunek w dwóch polach, `paidCalls` i `characters`, i nigdy się ich nie
sumuje: przy skrypcie `paidCalls` to jeden albo zero, przy kwestiach liczba wywołań mowy,
a `characters` to znaki, które dostawca policzy. `lines` mówi, co ten przebieg robi
z każdą kwestią: `planned`, `blocked` z powodem, `skipped`, `published` albo `resumed`.

Obiekt `check` niesie `approved` całego etapu, czyli skryptu **i** każdej kwestii, obok
`script.approved`, które dotyczy samego skryptu. Pole `translation` opisuje przekład:
`null`, dopóki odcinek nie wskazał języka ust, a potem `id` (`script-en`), `language`,
`state`, `approved`, `inputsChanged` i `lines`, czyli kwestie drugiego języka, każda ze
swoim `key` (`en:D01`) i własną zgodą. `approved` całego etapu go nie obejmuje: to język
filmu, a drugi język ma własne zgody. Każda kwestia, w obu językach, niesie `key`, czyli
to, co podaje się w `--artifact`. `dialogue translate --json` wypisuje raport tego samego
kształtu co `generate`, z `command: "translate"`.

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

## Kwestie: zakup i rachunek

Po przyjętym skrypcie to samo `dialogue generate` przestaje podnosić i zaczyna kupować:
**jedno wywołanie mowy na kwestię**, w kolejności skryptu, głosem postaci, która ją mówi,
w języku filmu z `episode.json`. Głos to `voiceId` z
`characters/<c>/voices/<język>/voice.json`, obsadzony i wysłuchany w
[etapie 0](00-przygotowanie.md). Nagranie trafia do `dialogue/<język>/Dnn.wav` pod
odcinkiem, wspólne dla obu torów, bo głos czytający kwestię nie wie, nad którym filmem
usiądzie. Poziom języka jest po to, żeby ten sam skrypt kupiony w drugim języku nie
nadpisał pierwszego.

ElevenLabs rozlicza **znaki, nie wywołania**, więc podgląd podaje jedno i drugie, per
kwestia i łącznie, i nigdy ich nie sumuje:

```
Próba na sucho: nic nie zapisano, nic nie wysłano. Dialog dzielna-ewa/01-burza
  płatnych wywołań do wykonania: 3
  znaków do rozliczenia: 63
      D01: ewa, planned, gotowa do kupienia, 26 znaków
      D02: ewa, planned, gotowa do kupienia, 19 znaków
      D03: tata, planned, gotowa do kupienia, 18 znaków
```

Kwestia jedzie bez kontekstu sąsiadów (`previous_text`, `next_text`), inaczej niż zdanie
narratora: ten kontekst służy jednemu głosowi ciągnącemu akapit, a kwestia przed tą jest
zwykle kogoś innego. Sposób czytania to domyślne ustawienia dostawcy, wysłane jawnie, te
same, na których przyjęto próbkę: kwestia ma brzmieć jak głos, który ktoś usłyszał.

Bajty są publikowane **tak, jak przyszły**: bez rozciągania i bez przyspieszania. Gdzie
kwestia usiądzie w filmie i co, jeśli nachodzi na następną, rozstrzyga miks, nie zakup
([W pełnej ścieżce](#w-pełnej-ścieżce)).

Przerwana próba zostawia rekord `submitted` przy tej jednej kwestii. Powtórzenie polecenia
dokańcza ją z nagrania zapisanego w `runs/<runId>/`, **bez drugiej opłaty**. Nową płatną
próbę zaczyna wyłącznie `--regenerate --artifact Dnn`.

## Bramka

Skrypt:

- Lista ujęć musi być zatwierdzona, bo każda kwestia z niej pochodzi.
- Odcinek musi mieć dialog: przy `--audio narration` albo `music-and-effects` pada odmowa
  „ten odcinek nie ma dialogu”.
- Lista ujęć zatwierdzona, zanim etap 3 zaczął przypisywać kwestie, nie ma ani jednej.
  Etap 11 odmawia wtedy i wskazuje `shot-list generate --regenerate`, zamiast kupować skrypt,
  który powie, że nie ma czego podnosić.

Kwestie:

- Skrypt musi mieć ważną zgodę. Skrypt poprawiony ręcznie po zgodzie albo taki, którego lista
  ujęć się zmieniła, nie otwiera zakupu, dopóki ktoś go nie przyjmie ponownie.
- Głos każdej postaci jest **bramką tylko jej kwestii**. Postać bez `voice.json` w języku
  filmu albo bez przyjętej próbki dostaje `blocked` z powodem i poleceniem, które go usuwa,
  a kwestie pozostałych postaci są kupowane. Próbka przeczytana głosem, który potem
  zmieniono, nie liczy się jako przyjęta.

## Zgoda

`approve --stage dialogue` wymaga `--artifact`, z powodu etapu 9: przyjęcie skryptu
otwiera kupowanie każdej jego kwestii, a przyjęcie kwestii otwiera miks, więc zgoda, której
nikt nie nazwał, wydałaby pieniądze, na które nikt się nie zgodził.

- `--artifact script` przyjmuje skrypt. `dialogue.md` można poprawić ręcznie: `check` mówi
  wtedy „poprawiony ręcznie po generacji”, a `approve` przyjmuje poprawkę, o ile dalej
  przechodzi walidację względem listy ujęć.
- `--artifact D01,D02` przyjmuje kwestie, każdą osobno, związane z bajtami nagrania.
- `--artifact script-en` przyjmuje przekład, a `--artifact en:D01` kwestię w drugim języku,
  każdą osobno i bez ruszania `D01`.

Kwestia zapisuje **dokładnie dwa wejścia**: `dialogue.md` i `voice.json` swojej postaci
w tym języku. `project.json` nim nie jest, więc zmiana narratora nie cofa żadnej kwestii.
Zmiana głosu `ewa` cofa zgody na kwestie `ewa` i nie rusza kwestii `tata`. Zgody na
kwestię przeczytaną głosem, którego już nie ma, nie da się wydać ponownie: to nagranie
kogoś innego, więc `approve` odmawia i wskazuje `--regenerate --artifact Dnn`.

„Nie” ma te same zakresy: `reject … --stage dialogue --artifact <klucz> --note <uwaga>`
też wymaga `--artifact`, bo „nie” o skrypcie, przekładzie i każdej kwestii naraz to
decyzja, której nikt nie podjął. Odrzucony skrypt poprawia według uwagi
`dialogue generate --regenerate --artifact script`, a odrzucony przekład
`dialogue translate --regenerate`. Odrzuconą kwestię kupuje się od nowa w jej języku
(`--artifact D01` albo `--language en --artifact en:D01`); model mowy uwagi nie czyta, więc
zostaje ona w rekordzie dla człowieka.

## Drugi język: skrypt pod lip-sync

Wersja z ustami w drugim języku zaczyna się od zatwierdzanego tekstu, nie od nagrania. Język
ust to decyzja odcinka z [etapu 0](00-przygotowanie.md#sześć-decyzji-odcinka),
`episode lip-sync <id> <episode-id> --language en` albo `--none`, zapisana w
`lip-sync.json` obok `episode.json`, a nie w nim. Bez tego pliku przekład czeka (reguła 7),
przy `none` odmawia, bo drugiej wersji nie będzie, a język równy językowi filmu jest błędem
już przy zapisie.

`dialogue translate` kupuje **jedno wywołanie tekstowe** i publikuje `dialogue.en.md` obok
`dialogue.md`, z rekordem `script-en` w tym samym `dialogue.stage.json`. Czeka na
**przyjęty** skrypt w języku filmu: tłumaczy się to, co ktoś zatwierdził.

To **jedyne świadome tłumaczenie materiału w potoku**. Reguła 9 zabrania przekładać to, z
czego pracuje model, bo przekład byłby drugą wersją tej samej prawdy. Tutaj druga wersja
jest dokładnie tym, czego potrzeba, więc powstaje jako **nowy artefakt z własną zgodą**,
a nie jako przekodowanie źródła. Reszta reguły 9 obowiązuje: zadanie jest po angielsku,
a `project.md` i `dialogue.md` jadą w prompcie dosłownie.

Każda kwestia idzie z **oknem czasu**, w sekundach planu: od jej kotwicy do następnej
kwestii albo do końca ujęcia, co nastąpi wcześniej. Okno jest wyprowadzane z `dialogue.md`
i listy ujęć, nigdy zapisywane. Prompt każe pisać krótko i naturalnie, a gdy wierny
przekład się nie mieści, skrócić go z zachowaniem sensu: nic dalej nie przyspieszy kwestii.

```
- D01 | U01 | ewa: 2-10s of the plan, 8s
- D02 | U03 | ewa: 16-20s of the plan, 4s
- D03 | U04 | tata: 22-30s of the plan, 8s
```

Wynik ma sekcje `Lines` i `Review` i **te same nagłówki**, `### D01 | U03 | ewa | 7s`, z
przetłumaczonym tekstem pod każdym. Walidacja jest strukturalna i działa 1:1 względem
przyjętego skryptu: te same identyfikatory w tej samej kolejności, te same ujęcia, postacie
i kotwice, żadnej brakującej ani dopisanej, każda z tekstem. Odpowiedź, która tego nie
spełnia, zostaje w `runs/<runId>/response.json`, a `dialogue.en.md` nie powstaje. Czy
przekład jest **wierny**, walidator nie wie, więc ocenia to człowiek przy `approve`.

```bash
pnpm dev approve dzielna-ewa 01-burza --stage dialogue --artifact script-en
```

Przekład zapisuje cztery wejścia: `project.md`, `shot-list.md` (końce ujęć wyznaczają okna),
`dialogue.md` i `lip-sync.json`. Zmiana któregokolwiek cofa jego zgodę, a `check` mówi,
który plik się zmienił; zmiana `dialogue.md` cofa ją także wtedy, gdy to tylko ręczna
poprawka skryptu. `episode.json` wejściem nie jest, bo każda jego zmiana cofa już zgodę na
tłumaczony skrypt. Zgoda na przekład liczy się wyłącznie razem z ważną zgodą na skrypt,
który tłumaczy. `dialogue.en.md` można poprawić ręcznie; `approve --artifact script-en`
przyjmuje poprawkę, o ile dalej przechodzi walidację.

## Kwestie w drugim języku

`dialogue generate --language en` kupuje kwestie z przyjętego `dialogue.en.md` tak, jak bez
tej flagi kupuje się je z `dialogue.md`: **jedno wywołanie mowy na kwestię**, ten sam model
mowy i ten sam rachunek w wywołaniach i znakach. Różnią się trzy rzeczy:

- głos to `characters/<c>/voices/en/voice.json`, obsadzony i wysłuchany w
  [etapie 0](00-przygotowanie.md) osobno dla angielskiego;
- nagranie trafia do `dialogue/en/Dnn.wav`, obok `dialogue/pl/`, nie zamiast niego;
- klucz rekordu to `en:D01`, bo `D01` zajmuje kwestia w języku filmu, a oba rekordy
  dzielą `dialogue.stage.json`. Ten klucz podaje się w `--artifact` przy `approve`
  i przy `--regenerate`: `--artifact en:D03`.

```
Próba na sucho: nic nie zapisano, nic nie wysłano. Dialog dzielna-ewa/01-burza
  płatnych wywołań do wykonania: 3
  znaków do rozliczenia: 64
      en:D01: ewa, planned, gotowa do kupienia, 25 znaków
      en:D02: ewa, planned, gotowa do kupienia, 19 znaków
      en:D03: tata, planned, gotowa do kupienia, 20 znaków
```

Bramka: przyjęty `script-en`, czyli przekład z ważną zgodą, i przyjęta próbka angielskiego
głosu każdej mówiącej postaci. Jak w języku filmu, **głos jest bramką tylko kwestii swojej
postaci**: `tata` bez przyjętej próbki EN czeka, a kwestie `ewa` są kupowane. Język, którego
`lip-sync.json` nie wskazuje, to odmowa: kwestie kupuje się w języku ust, bo dla nich
istnieje druga wersja.

Kwestia EN zapisuje dokładnie dwa wejścia, `dialogue.en.md` i `voices/en/voice.json` swojej
postaci, więc ręczna poprawka przekładu cofa zgody na kwestie EN i nie rusza polskich, a
zgoda na `en:D01` nie dotyka `D01`. Gdzie kwestia EN usiądzie i co, jeśli nachodzi na
następną, sprawdza etap 12 na zegarze swojego toru, nie zakup.

## W pełnej ścieżce

Kwestie nie mają własnego miksu. Gdy każda ma ważną zgodę, `sound-design mix` z
[etapu 10](10-muzyka-i-efekty.md#kwestie-postaci-w-pełnej-ścieżce) kładzie je w
`<tor>/mixed.mp4` jako mowę, obok narracji, muzyki i efektów, a podkład ustępuje pod nimi
jak pod lektorem. Tak powstaje pełny polski film z dialogiem, na każdym torze osobno.

Kotwica kwestii to sekunda planu; miks przelicza ją na zegar filmu tego toru, bo klipy
wróciły z dryfem. Dwie wypowiedzi, które brzmiałyby naraz, dwie kwestie albo kwestia
i narracja, oraz wypowiedź kończąca się po filmie to **odmowa** z obiema nazwami i poprawką:
krótsza kwestia w scenariuszu albo przesunięta kotwica w `dialogue.md`. Miks nic nie
kosztuje, więc powtórzenie po poprawce jest darmowe.

---

[← etap 10](10-muzyka-i-efekty.md) · [README](../../README.md) · [pełny kontrakt](../pipeline.md)
