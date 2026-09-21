# Kontrakt etapów

Ten dokument opisuje **stan bieżący** kontraktu, w czasie teraźniejszym. Nie ma tu
wpisów z datami, sekcji „zmiany" ani dziennika postępów: zmiana kontraktu to przepisanie
tego pliku, a historię trzyma `git log`. Stan konkretnej produkcji czyta się z plików
`*.stage.json` w katalogu roboczym, nigdy z dokumentu.

## Układ katalogów

Artefakty leżą poza repozytorium, w katalogu z `AIMATOR_WORKSPACE`.

```
$AIMATOR_WORKSPACE/
└── projects/<project-id>/
    ├── project.json                  identyfikator, tytuł, proporcje, obsada
    ├── project.md                    zasady wspólne, jedyny plik pisany ręcznie
    ├── narration.json                jak narrator CZYTA (etap 9), osobno od project.json,
    │                                 bo to suwak, a project.json jest wejściem wszystkiego
    ├── mix.json                      jak głośno siedzi podkład i jak ustępuje pod mową
    │                                 (etap 10), osobno od narration.json, bo unieważnia
    │                                 miks, a nie nagrania
    ├── prepare.stage.json
    ├── characters/<character-id>/
    │   ├── sources/                  zdjęcia użytkownika (etap 0)
    │   ├── gpt-image/                card.png, views/, hero.png,
    │   │                             character.stage.json, character.lock, runs/
    │   └── seedream/                 to samo, niezależnie
    └── episodes/<episode-id>/
        ├── source.md                 kopia bajtowa źródła (etap 0)
        ├── episode.json              decyzje odcinka
        ├── prepare.stage.json
        ├── screenplay.md             ┐
        ├── screenplay.stage.json     │
        ├── shot-list.md              │ etapy tekstowe, wspólne dla obu torów
        ├── shot-list.stage.json      │
        ├── prompt-package.json       │
        ├── prompt-package.stage.json │
        ├── prompts/                  ┘ opening-frame.md, references/, clips/, entry-frames/
        ├── narration.md               ┐ etap 9: słowa wspólne dla obu torów
        ├── narration/Nnn.wav          │ jedna kupiona wypowiedź na plik
        ├── soundtrack.stage.json      ┘ rekord skryptu i każdej kwestii
        ├── sound-design.md            ┐ etap 10: arkusz cue PO ANGIELSKU, wspólny
        ├── sound/Mnn.mp3              │ podkład; jedno wywołanie na plik
        ├── sound/Enn.mp3              │ efekty; jedno wywołanie na plik
        ├── sound-design.stage.json    ┘ rekord arkusza i każdego stemu
        ├── sound-design.lock
        ├── runs/<runId>/             archiwum prób etapów tekstowych;
        │                             previous/ tylko przy --regenerate
        ├── gpt-image/                ┐ references/Rxx.png, references.stage.json,
        └── seedream/                 ┘ references.lock, opening-frame.png,
                                        opening-frame.stage.json, opening-frame.lock,
                                        clips/Cxx.mp4, frames/Cxx/entry.png,
                                        frames/Cxx/end.jpg (format dostawcy),
                                        clips.stage.json, clips.lock,
                                        episode.mp4, assembly.stage.json,
                                        assembly.lock, narrated.mp4,
                                        soundtrack.stage.json, soundtrack.lock,
                                        mixed.mp4, sound-design.stage.json,
                                        sound-design.lock, runs/
```

Cztery reguły, które ten układ egzekwuje:

1. **Tor modelu to poziom katalogu, nigdy prefiks nazwy.** Nie ma `byteplus-images/`
   obok `references/`; jest `gpt-image/references/` i `seedream/references/`. Izolacja
   torów jest darmowa, więc nie trzeba nigdy doklejać równoległego drzewa.
2. **Postać też jest poziomem katalogu**, z tego samego powodu. `characters/ewa/`
   i `characters/tata/` nie wiedzą o sobie nawzajem, a każda postać ma własne `sources/`,
   własną podstawę i własny plik etapu na każdym torze.
3. **Etapy tekstowe są wspólne, a obrazowe i wideo idą per tor.** Scenariusz, lista ujęć
   i pakiet promptów opisują historię, nie obrazy. Rozejście zaczyna się przy pierwszym
   obrazie i kończy dwiema niezależnymi animacjami z tej samej historii.
4. **Ścieżki zna wyłącznie `src/lib/workspace.ts`.** Żaden inny moduł nie składa ścieżek.

Katalog powstaje dopiero wtedy, gdy jakiś etap do niego pisze; dotyczy to zarówno torów
modelowych, jak i `characters/<id>/sources/` czy `episodes/`. Pusty katalog jest obietnicą,
której narzędzie nie dotrzymuje.

**Zasady projektu są wejściem każdego etapu.** `project.json` i `project.md` leżą poza
tabelą poniżej, bo czyta je wszystko: proporcje obrazu, podstawa postaci i zasady wspólne
nie mają innej drogi do etapów, które ich potrzebują. Oba są artefaktami etapu 0, więc
reguła „każdy etap konsumuje wyłącznie artefakty wcześniejszych etapów" pozostaje spełniona.

## Plik etapu

Jeden plik na etap, `<etap>.stage.json`, na tym poziomie katalogu, do którego etap pisze.
Jeden kształt dla wszystkich etapów. Klucz `artifacts` pozwala objąć zbiór wyników
(R01–R10, C01–C06) bez mnożenia plików.

```jsonc
{
  "version": 1,
  "stage": "prepare",
  "artifacts": {
    "episode": {
      "runId": "20260917T170233Z-a1b2c3d4",
      "status": "completed",
      "jobId": null,
      "producedAt": "2026-09-17T17:02:33.412Z",
      "producer": {
        "kind": "manual",
        "tool": "aimator",
        "endpoint": null,
        "model": null,
        "promptVersion": null
      },
      "inputs": [],
      "outputs": [
        { "path": "projects/demo/episodes/01-tytul/source.md", "sha256": "6ba5…" },
        { "path": "projects/demo/episodes/01-tytul/episode.json", "sha256": "4ab1…" }
      ],
      "review": { "status": "pending", "reviewer": null, "reviewedAt": null, "note": null },
      "needsReview": []
    }
  }
}
```

`stage` przyjmuje nazwę dowolnego etapu z tabeli poniżej i wyznacza nazwę pliku.
`status` opisuje próbę, nie ocenę: `submitted` zapisuje się **przed** płatnym POST-em,
`completed` dopiero wtedy, gdy wynik przeszedł walidację i został opublikowany. Rekord
etapu ręcznego jest ukończony z konstrukcji, bo nie stoi za nim żadne wywołanie.
`producer` przy etapie płatnym zapisuje endpoint, identyfikator modelu i **jawną wersję
promptu**, nie hash pliku źródłowego, bo hash zmienia się od przeformatowania komentarza
i nie mówi nic o tym, czy instrukcja się zmieniła.

Ścieżki w artefaktach są **względne wobec katalogu roboczego**, więc całe drzewo można
przenieść. `originPath` w `project.json` i `episode.json` jest bezwzględny, bo wskazuje
plik spoza katalogu roboczego; to jedyne miejsce, gdzie ma to sens.

`project.json` i `episode.json` trzymają wyłącznie treść; pochodzenie i ocena są w pliku
etapu. `project.md` nie ma hasha od chwili `init`, bo pisze go wtedy człowiek i hash pustego
szkieletu byłby z założenia nieaktualny; dostaje go dopiero przy `aimator approve`, czyli
w momencie, w którym ktoś przyjmuje zasady w takim kształcie, w jakim leżą. Od tej chwili
każda edycja `project.md` unieważnia akceptację i `check` to zgłasza, ale **nie jest to
błąd walidacji**, tylko wygaśnięcie zgody, dokładnie jak przy zmianie decyzji odcinka.
Pliki nadal się zgadzają, po prostu tych bajtów nikt jeszcze nie przyjął, więc `approve`
działa i zapisuje nowy hash. Gdyby liczyć to jako błąd walidacji, `approve` odmawiałby
w jedynym miejscu, które potrafi tę sytuację naprawić, i projekt zostawałby zablokowany
na zawsze. Każdy etap zapisuje hashe swoich własnych wejść w chwili, gdy je konsumuje.

## Niezmienniki

Obowiązują we wszystkich etapach.

- **Ocena kreatywna jest osobna od walidacji.** Plik, który powstał, nie jest plikiem
  przyjętym. Przejście walidacji nie jest akceptacją; akceptację zapisuje wyłącznie jawne
  `aimator approve`, z zakresem etapu w `--stage`, nigdy polecenie kontrolne.
- **Akceptacja jest związana z bajtami.** `review.status` dotyczy konkretnych
  `outputs[].sha256`. Zmiana pliku unieważnia akceptację; nie ma sposobu, by przeniosła
  się na inny wynik. Ponowny zapis pliku etapu przywraca `pending` i mówi o tym wprost.
- **Nie akceptuje się tego, co nie przechodzi walidacji.** `approve` odmawia, dopóki hashe
  **wyników** się nie zgadzają, dokument nie przechodzi walidacji strukturalnej albo brakuje
  decyzji: akceptacja zapisana na zepsutym pochodzeniu byłaby kłamstwem, któremu kolejne
  etapy zaufałyby.
- **Rozjazd wejścia to wygaśnięcie zgody, nie błąd walidacji.** Zapisane wejście, którego
  bajty się zmieniły, unieważnia akceptację i `check` to zgłasza, ale wynik nie jest
  zepsuty, tylko nieprzeczytany dla tych wejść, a od czytania jest człowiek. `approve`
  przepisuje wtedy hashe wejść i zapisuje akceptację, dokładnie jak przy `project.md`
  edytowanym po etapie 0. Gdyby liczyć to jako błąd walidacji, `approve` odmawiałby
  w jedynym miejscu, które potrafi tę sytuację naprawić, a jedyną drogą dalej byłoby
  kupienie drugiego wyniku, żeby powiedzieć to samo. Zmiana, która naprawdę coś znaczy, i
  tak nie przejdzie: scenariusz waliduje się wtedy wobec nowych decyzji odcinka, a lista
  ujęć wobec scenariusza w takim kształcie, w jakim leży, więc wcześniej wywraca się na
  walidacji strukturalnej.
- **`needsReview` nigdy nie czyści się samo.** Wpisuje go etap zależny w chwili
  uruchomienia. `check` tylko raportuje rozjazd; polecenie kontrolne niczego nie zapisuje.
- **Stan `submitted` zapisuje się przed płatnym POST-em.** Przerwana próba zostawia więc
  ślad mówiący, że opłata mogła już paść, zamiast wyglądać na niebyłą. Czy da się ją
  wznowić bez drugiej opłaty, zależy od dostawcy: tam, gdzie zadanie jest przechowywane,
  wznawia się przez zapisany identyfikator; tam, gdzie nie jest, jak przy `store: false`
  w etapie 1, odpowiedź istnieje tylko wtedy, gdy zdążyła trafić na dysk, a poza tym
  jedyną drogą dalej jest jawne `--regenerate`. Narzędzie mówi to wprost, zamiast
  milcząco płacić drugi raz.
- **Nic nie ponawia się automatycznie.** Nową płatną próbę zaczyna wyłącznie jawne
  `--regenerate`, zachowując poprzedni wynik.
- **Każde polecenie zapisujące ma `--dry-run`**: pełna walidacja, bez sieci, sekretów
  i zapisów.
- **Każdy etap konsumuje wyłącznie artefakty wytworzone przez wcześniejsze etapy**, nigdy
  kontekstu rozmowy ani ponownego odczytu surowego opisu. Ustawienia podróżują razem
  z artefaktem, żeby następny etap miał kompletne wejście.
- **Instrukcja dla modelu jest po angielsku; materiał, z którego model ma pracować, zostaje
  w języku, w którym go napisano.** Decyduje rola tekstu, nie to, kto go czyta. Instrukcją
  jest zadanie etapu i każdy artefakt, który sam jest promptem, czyli całe `prompts/**`
  razem z etykietami `subject`, bo te trafiają do modelu w liście załączników. Materiałem
  są `project.md`, `source.md`, `screenplay.md` i `shot-list.md`: wklejane **dosłownie**,
  nigdy tłumaczone, bo ich hashe są zapisane, a przekład byłby drugą wersją tej samej
  prawdy. Żądanie bywa więc dwujęzyczne i tak ma być. Wynik etapu, który jest treścią
  filmu (scenariusz, lista ujęć), idzie w `language`; wynik etapu, który jest instrukcją
  (pakiet promptów), idzie po angielsku, bo modele obrazu i wideo są trenowane
  przytłaczająco na angielskich promptach, a `language` opisuje film, nie rozmowę
  z narzędziem.
- **Prompt do modelu obrazu albo wideo to tekst **wraz z** uporządkowanymi załącznikami,
  a tekst adresuje je **pozycją w tej liście**, nigdy nazwą pliku, nigdy wewnętrznym
  identyfikatorem, nigdy ścieżką.** API tych dostawców przyjmuje referencje obrazowe i to
  jest właściwy sposób ich użycia; prompt, który opisuje załącznik słowami zamiast go
  dołączyć, wyrzuca połowę tego, za co się płaci. Stąd dwie strony jednej umowy:
  **etap składający** wypisuje przed zadaniem listę `Image N = <identyfikator> — <rola>`,
  w dokładnie tej kolejności, w jakiej żądanie niesie bajty, i **etap planujący** może
  w prozie użyć identyfikatora wyłącznie takiego, który w tej liście wystąpi. Lista jest
  generowana przy wywołaniu, nigdy przechowywana: różni się per tor i per podstawa, a
  zapisana rozjechałaby się z pozycją, którą żądanie faktycznie niesie. Identyfikator
  rozwiązuje się na plik dopiero u składającego: `hero:<id>` na
  `characters/<id>/<tor>/hero.png`, `Rnn` na `<tor>/references/Rnn.png`, i to jest cały
  powód, dla którego pakiet promptów może być wspólny dla obu torów.
- **Archiwum próby nie kopiuje wejść.** `runs/<runId>/` przechowuje tylko to, czego nie
  da się odtworzyć: wysłany request, dokładny prompt, odpowiedź, wynik walidacji, status
  HTTP i identyfikator zadania. Wejścia są referowane przez ścieżkę i sha256. Poprzedni
  wynik kopiuje się wyłącznie przy `--regenerate`.

## Etapy

| Etap | Konsumuje | Produkuje | Bramka | Stan |
|---|---|---|---|---|
| 0 przygotowanie | pomysł użytkownika, plik źródłowy odcinka, zdjęcia postaci | `project.md`, `project.json`, `source.md`, `episode.json`, `character/sources/` | `aimator check`, potem `aimator approve` | **zaimplementowany** |
| 1 scenariusz | `project.json`, `project.md`, `source.md`, `episode.json` | `screenplay.md`, `screenplay.stage.json`, `runs/<runId>/` | zatwierdzony etap 0 przed wywołaniem; potem `aimator check`, `aimator approve … --stage screenplay` | **zaimplementowany** |
| 2 postać | `project.json`, `project.md` i, przy podstawie `photographs`, `characters/<id>/sources/` | `card.png` → 8 widoków → `hero.png`, `character.stage.json`, `runs/<runId>/`, per postać i per tor | zatwierdzony etap 0 przed wywołaniem; potem ocena każdego obrazu z osobna | **zaimplementowany** |
| 3 lista ujęć | `project.json`, `project.md`, `episode.json`, zatwierdzony `screenplay.md` | `shot-list.md`, `shot-list.stage.json`, `runs/<runId>/` | zatwierdzony etap 1 przed wywołaniem; potem `aimator check`, `aimator approve … --stage shot-list` | **zaimplementowany** |
| 4 pakiet promptów | `project.json`, `project.md`, `episode.json`, zatwierdzony `shot-list.md`, zatwierdzony `hero.png` **każdej postaci w kadrze, na obu torach** | `prompt-package.json`, `prompts/**`, `prompt-package.stage.json`, `runs/<runId>/` | zatwierdzony etap 3 i zatwierdzone hero przed wywołaniem; potem `aimator check`, `aimator approve … --stage prompt-package` | **zaimplementowany** |
| 5 obrazy referencyjne | `project.json`, `project.md`, zatwierdzony `prompt-package.json` i `prompts/references/Rxx.md`, zatwierdzone zależności `dependsOn` **na tym torze** | `<tor>/references/Rxx.png`, `<tor>/references.stage.json`, `<tor>/runs/<runId>/` | zatwierdzony etap 4 i zatwierdzone `dependsOn` przed wywołaniem; potem ocena każdego obrazu z osobna | **zaimplementowany** |
| 6 klatka otwarcia | `project.json`, `project.md`, zatwierdzony `prompt-package.json` i `prompts/opening-frame.md`, zatwierdzona `shot-list.md`, zatwierdzone `opening.referenceIds` **na tym torze** | `<tor>/opening-frame.png`, `<tor>/opening-frame.stage.json`, `<tor>/runs/<runId>/` | zatwierdzony etap 4 i zatwierdzone `opening.referenceIds` przed wywołaniem; potem ocena kadru | **zaimplementowany** |
| 7 klipy | `project.json`, `project.md`, zatwierdzony `prompt-package.json` z `prompts/clips/Cnn.md` i `prompts/entry-frames/Cnn.md`, zatwierdzona `shot-list.md`, zatwierdzona klatka, od której klip się zaczyna, i, przy `previous-end-frame`, zatwierdzona końcówka poprzednika **na tym torze** | `<tor>/clips/Cxx.mp4`, `<tor>/frames/Cxx/entry.png`, `<tor>/frames/Cxx/end.jpg` (format oddaje dostawca), `<tor>/clips.stage.json`, `<tor>/runs/<runId>/` | zatwierdzony etap 4 i zatwierdzona klatka wejściowa albo końcówka poprzednika przed wywołaniem; potem ocena klipu i klatek z osobna | **zaimplementowany** |
| 8 montaż | zatwierdzona `shot-list.md`, zatwierdzone klipy **na tym torze** | `<tor>/episode.mp4`, `<tor>/assembly.stage.json`, `<tor>/runs/<runId>/` | zatwierdzony każdy klip przed sklejeniem; potem ocena całości | **zaimplementowany** |
| 9 dźwięk | zatwierdzona `shot-list.md`, `narratorVoiceId` z `project.json`, `narration.json` (sposób czytania), a do miksu zatwierdzony `<tor>/episode.mp4` | `narration.md`, `narration/Nnn.wav`, `soundtrack.stage.json` (wspólne); `<tor>/narrated.mp4`, `<tor>/soundtrack.stage.json` | zatwierdzony etap 3 i obsadzony głos przed wywołaniem; potem ocena skryptu, ocena każdej kwestii, ocena odsłuchu całości per tor | **zaimplementowany** |
| 10 muzyka i efekty | zatwierdzona `shot-list.md`, `mix.json` (poziomy), a do miksu zatwierdzony `<tor>/episode.mp4`, zatwierdzony `<tor>/narrated.mp4` i przyjęte kwestie etapu 9 | `sound-design.md`, `sound/Mnn.mp3`, `sound/Enn.mp3`, `sound-design.stage.json` (wspólne); `<tor>/mixed.mp4`, `<tor>/sound-design.stage.json` | zatwierdzony etap 3 przed wywołaniem; potem ocena arkusza, ocena każdego stemu, ocena odsłuchu całości per tor | **zaimplementowany** |
| 11 dialog | zatwierdzona `shot-list.md`, głos każdej postaci z `project.json` | kwestie postaci, dosypywane do miksu etapu 10 | ocena każdej kwestii | niezaimplementowany |

**Wiersz 10 zmienił się przy implementacji i to jest zapisane tutaj, a nie przemilczane.**
Mówił, że muzyka i efekty są **wejściem** wnoszonym przez człowieka, i sam przyznawał, że
nie rozstrzyga, skąd się biorą. Nie da się go tak zbudować: wciąganie cudzych plików do
katalogu roboczego ma monopol etapu 0, więc „wnosi człowiek" było przepisaniem etapu 0 pod
inną nazwą, a nie wierszem 10. Stemy kupuje więc etap 10, z ElevenLabs, co nie jest
czwartym dostawcą, tylko **czwartym i piątym miejscem wywołania u dostawcy, którego potok
już ma** na mowę. Dostawców dalej jest trzech: OpenAI, BytePlus, ElevenLabs.

Etap 11 jest **zadeklarowanym kontraktem**, nie działającym kodem, dokładnie tak, jak
wiersz etapu 9, a potem 10, istniał zanim powstał. Wiersz istnieje po to, żeby mowa postaci
wpięła się w ustalony układ zamiast wymyślać własny: kupowana wspólnie dla obu torów jak
narracja, i lądująca w miksie etapu 10 jako kolejny stem, a nie jako drugi miks.

Czego ten wiersz nie rozstrzyga: **skąd bierze się głos każdej postaci.** `project.json`
trzyma dziś `narratorVoiceId` i nic więcej, a obsadzenie dziesięciu postaci to dziesięć
decyzji, których nikt jeszcze nie podjął. Reguła 7 obowiązuje: brak odpowiedzi nie udaje
odpowiedzi, więc dialogi są **nieobecne**, a ich brak jest raportowany przy każdym `check`
i przy każdej generacji etapu 10, ale wyłącznie w dwóch trybach, które go deklarują.

Etap 2 nie zależy od etapu 1 i może biec równolegle: postać opisuje projekt, nie odcinek.
Jedyne, co je wiąże, to wspólna bramka etapu 0. Etap 3 też nie zależy od etapu 2; nazywa
postacie identyfikatorami z **obsady etapu 0**, a nie ich obrazami; te są potrzebne dopiero
w etapie 4.

## Etap 0: szczegóły

Jedyny etap, który legalnie wciąga materiał spoza katalogu roboczego. Właśnie dlatego
kopiuje te bajty do środka i zapisuje ich hash: od tego miejsca każdy etap konsumuje
artefakt wytworzony przez poprzedni.

Przed etapem 0 może odbyć się sesja rozwinięcia pomysłu (skill `develop-series`). **Nie
jest etapem i nie ma własnego pliku stanu**, bo nie wytwarza artefaktu; kończy się
przekazaniem decyzji do etapu 0, który jako jedyny je zapisuje. Nie dodawaj
`develop.stage.json`.

Dwie decyzje projektu, obie jawne, obie bez wartości domyślnej:

| Pole | Wartość |
|---|---|
| `aspectRatio` | np. `16:9`; po powstaniu obrazów nie da się zmienić bez ich unieważnienia |
| `characters` | obsada: każda powracająca postać z własnym identyfikatorem, nazwą i podstawą |
| `narratorVoiceId` | głos narratora serii; bramkuje wyłącznie etap 9 |

**Obsada jest decyzją, nie wnioskiem.** Pusta obsada znaczy „nikt nie powiedział, kto
występuje w tej serii", i bramka blokuje. Nie ma tu wartości domyślnej, bo projekt bez
zadeklarowanej postaci znaczył kiedyś „dokładnie jedna, bezimienna", i właśnie ten cichy
domysł sprawiał, że seria opisująca dwie osoby produkowała jedną, a którą, rozstrzygał
model. Kryterium jest powracalność: postać, której tożsamość musi przetrwać między
odcinkami, należy do obsady; twarz widziana raz to referencja etapu 5.

Nazwa postaci nie jest ozdobą: to ona trafia do promptu etapu 2 i to jej model szuka
w zasadach projektu.

Każda postać ma **własną podstawę**, więc projekt może budować jedną z fotografii, a resztę
z zapisanych zasad. Podstawa istnieje, bo puste `characters/<id>/sources/` nie odróżnia
„świadomie bez zdjęć" od „jeszcze nie dodane". Przy `photographs` bramka blokuje, dopóki
nie ma ani jednego zdjęcia tej postaci. Przy `description` jedynym wejściem etapu postaci
jest opis wyglądu w `project.md`, i wtedy to on musi być konkretny, bo nic dalej go nie
uzupełni. Dodanie zdjęcia przez `character add` samo w sobie jest deklaracją i przestawia
podstawę tej postaci na `photographs`.

Plik `project.json` sprzed obsady czyta się jako **pustą obsadę**, nie jako jedną bezimienną
postać: zapisana w nim podstawa opisywała kogoś, kogo nikt nie nazwał, więc przeniesienie
jej na pierwszą zadeklarowaną osobę byłoby wymyśleniem odpowiedzi. Plik, który trzyma już
zdjęcia, jest odrzucany wprost: te bajty należą do konkretnego człowieka, a narzędzie nie
wie, do którego.

Decyzje odcinka, wszystkie jawne, żadna z domyślną wartością:

| Pole | Wartość | Bramkuje |
|---|---|---|
| `durationSeconds` | liczba całkowita 1–3600 | etap 0 |
| `audio` | `music-and-effects`, `dialogue`, `narration`, `dialogue-and-narration`; wszystkie zawierają muzykę i efekty | etap 0 |
| `language` | kod języka scenariusza i wypowiedzi; wymagany także w filmie bez mowy. **Nie jest językiem instrukcji dla modelu**, bo te są po angielsku, zobacz niezmiennik wyżej | etap 0 |
| `subtitles` | kod języka albo `none`; niezależny od `language` | etap 0 |
| `sourceNature` | `law-or-idea`, `synopsis`, `screenplay`; etap 1 rozgałęzia się na tym polu | etap 0 |
| `maxClipSeconds` | liczba całkowita 1–60: najdłuższy klip, jaki etap 3 może zaplanować | etap 3 |

**Każdy etap bramkuje te decyzje, które sam konsumuje.** Pięć pierwszych blokuje etap 0,
więc i etapy 1 i 2. `maxClipSeconds` blokuje wyłącznie etap 3, a jest przechowywane
w `episode.json`, a nie podawane flagą, bo `check` musi umieć **ponownie** zwalidować listę
ujęć offline, długo po poleceniu, które ją wytworzyło; limit żyjący tylko we fladze
trzeba by wpisywać drugi raz, a limit żyjący tylko w archiwum próby zamieniłby archiwum
w stan. Jest per odcinek, nie per tor, bo oba tory planują z jednej listy ujęć, więc liczba
jest dokładnie jedna. To plan montażowy: prawdziwy limit dostawcy wideo nie jest sprawdzony
przed etapem 7.

Świeży `episode.json` ma wszystkie sześć jako `null` i jest celowo niegotowy do generacji.
Gotowość jest **wyliczana**, nie deklarowana: nie ma pola `status`, które plik mógłby
podać niezgodnie z prawdą. `check` przepuszcza, gdy `project.md` nie zawiera już żadnego
`TODO(etap-0)`, proporcje są ustalone, obsada jest niepusta i każda postać ma ustaloną
podstawę wraz z materiałem, którego ta podstawa wymaga, hashe wyników (projektu i odcinków)
zgadzają się, i żadne z pięciu pól bramkowanych przez etap 0 nie jest `null`.

**Projekt bez odcinka przechodzi.** Etap 2 nie czyta żadnego odcinka, a otwiera go
akceptacja samego projektu. Odmowa zatwierdzenia obsady, dopóki nie istnieje odcinek,
trzymałaby etap postaci zakładnikiem pliku, którego nigdy nie otwiera. `check` mówi
wprost, że odcinka jeszcze nie ma i że czeka na niego etap 1, ale nie blokuje.

`check` niczego nie zapisuje i niczego nie przyjmuje. Etap 0 kończy `aimator approve
<project-id>`, które powtarza całą weryfikację, dopisuje hash `project.md` i ustawia
`review.status` na `approved` we wszystkich plikach etapu (projektu i każdego odcinka),
razem z tym, kto i kiedy to zrobił. Dopiero wtedy `check` odsyła do etapu 1.

## Etap 1: szczegóły

Pierwszy etap, który wydaje pieniądze, i jedyny, którego wynik jest tekstem napisanym
przez model. Konsumuje wyłącznie artefakty etapu 0 (zasady projektu i proporcje obrazu
z `project.json` i `project.md`, źródło i pięć decyzji z `source.md` i `episode.json`)
i zapisuje hash każdego z nich w chwili, gdy je czyta.

**Bramka przed wydaniem pieniędzy.** `screenplay generate` odmawia płatnego wywołania,
dopóki `prepare.stage.json` projektu **i** odcinka nie mają `review.status = "approved"`,
a hashe ich wyników się zgadzają. Edycja `project.md` po akceptacji unieważnia ją
arytmetycznie i etap 1 znów blokuje. `--dry-run` tej bramki nie omija: raportuje ją jako
przeszkodę, ale i tak pokazuje prompt, bo po to jest podgląd.

**Skąd bierze się model.** `--model <id>`, a bez tej flagi `AIMATOR_SCREENPLAY_MODEL`.
Wartości domyślnej nie ma i nie będzie: model, którego nikt nie wybrał, nie jest decyzją.
Klucz czytany jest wyłącznie na ścieżce płatnej, z `OPENAI_API_KEY`; `--dry-run` nie
sięga po sekret ani po sieć.

**Archiwum próby.** `episodes/<id>/runs/<runId>/` trzyma `prompt.md`, `request.json`,
`response.json`, `transport.json`, `run.json` i `validation.json`, czyli to, czego nie da
się odtworzyć. Wejścia są w `run.json` referowane ścieżką i sha256, nigdy kopiowane. Jeden
katalog `runs/` na odcinek wystarczy wszystkim etapom tekstowym, bo `runId` jest unikalny
i prefiksowany czasem. Poprzedni scenariusz trafia do `previous/screenplay.md` nowej próby
wyłącznie przy `--regenerate`.

**Wywołanie idzie z `store: false`**, więc dostawca nic nie przechowuje i przerwanej próby
nie da się odpytać po identyfikatorze. Rekord ze statusem `submitted` bez zapisanej
odpowiedzi jest więc ślepym zaułkiem: `check` mówi wprost, że próba mogła zostać
rozliczona, i jedyną drogą dalej jest `--regenerate`. Nic nie ponawia się samo.

**Walidacja strukturalna.** Siedem sekcji w ustalonej kolejności, żadnej pustej, nagłówki
`### S01 | 15s | miejsce i pora dnia` numerowane kolejno od S01, każda scena 1–15 s, suma
czasów dokładnie równa `durationSeconds`, w każdej scenie dokładnie jedno niepuste pole
Action, Audio, Text i End state. Przy `subtitles: none` każde pole Text musi brzmieć
`none`; przy zamówionych napisach co najmniej jedno nie może. Minimalna liczba scen,
`ceil(durationSeconds / 15)`, jest **raportowana, nie sprawdzana osobno**, bo przy twardym
limicie sceny poprawna suma nie da się osiągnąć mniejszą liczbą scen.

**Walidacja to nie akceptacja.** Wynik, który przeszedł walidację, ma
`review.status = "pending"`. Przyjmuje go dopiero
`aimator approve <project-id> <episode-id> --stage screenplay`, i tylko wtedy, gdy hash
`screenplay.md` się zgadza i dokument nadal przechodzi walidację wobec decyzji odcinka
w takim kształcie, w jakim leżą.

Rozjazd wejścia etapu 0 unieważnia akceptację, ale jej nie blokuje: `approve` przepisuje
wtedy hashe wejść i zapisuje nową zgodę; zobacz niezmiennik o wygaśnięciu zgody. Scenariusz
jest bowiem ponownie walidowany wobec **bieżących** decyzji, więc zmiana, która naprawdę coś
dla niego znaczy (inne `durationSeconds`, inne `subtitles`), wywraca się na walidacji, a nie
przechodzi tylnymi drzwiami. `aimator check <project-id> <episode-id>` sprawdza to samo i nie
zapisuje niczego; rozjazd wejść raportuje, a `needsReview` wpisze dopiero etap zależny
w chwili uruchomienia.

## Etap 2: szczegóły

Pierwszy etap obrazowy i pierwszy, który rozgałęzia się na dwa tory modelowe. Konsumuje
wyłącznie artefakty etapu 0 (proporcje i obsadę z `project.json`, zasady z `project.md`,
a przy podstawie `photographs` zdjęcia z `characters/<id>/sources/`), i zapisuje hash
każdego z nich w chwili, gdy je czyta. **Nie zależy od etapu 1** i może biec równolegle.

Jedno polecenie, `character generate <project-id> <character-id> --track <tor>`, produkuje
w tej kolejności `card.png`, osiem widoków i `hero.png`. Nie ma osobnych poleceń per tor
ani per widok: tor jest poziomem katalogu, a osiem widoków to osiem rekordów w jednym
pliku etapu.

**Trzy bramki, jedna za drugą.** Płatne wywołanie odmawia, dopóki `prepare.stage.json`
projektu nie ma `review.status = "approved"` i hashe jego wyników się zgadzają. Osiem
widoków odmawia, dopóki `card.png` nie jest **zatwierdzona**, nie „poprawna", tylko
przyjęta przez człowieka. `hero.png` odmawia, dopóki nie są zatwierdzone wszystkie osiem.
Walidacja nie otwiera żadnej z tych bramek. `--dry-run` ich nie omija: raportuje je jako
przeszkody, ale i tak pokazuje każdy prompt w całości.

**Bez flag polecenie robi następny krok i przestaje.** Bramki sprawiają, że wykonalny jest
zawsze dokładnie jeden etap sekwencji, więc `character generate` nie próbuje wydać budżetu
całego etapu za jednym razem. `--artifact card|hero|<widok>[,...]` zawęża przebieg, a
`--regenerate` **wymaga** jawnego `--artifact`: nowa opłata ma adresata.

**Skąd bierze się model.** `--model <id>`, a bez tej flagi `AIMATOR_IMAGE_MODEL_GPT_IMAGE`
albo `AIMATOR_IMAGE_MODEL_SEEDREAM`. Jedna zmienna na tor, żeby oba dało się puścić z jednej
powłoki; wartości domyślnej nie ma i nie będzie. Endpoint nie jest decyzją użytkownika, więc
jest stałą toru, przy czym gpt-image rozgałęzia go na `/v1/images/edits` i
`/v1/images/generations`, bo postać rysowana z opisu nie ma czego edytować. Klucz czytany
jest wyłącznie na ścieżce płatnej: `OPENAI_API_KEY` albo `BYTEPLUS_MODELARK`. Generowanie
obrazów na BytePlus idzie zwykłym tokenem, podpis `AccessKey`/`Secret` obsługuje ich
bibliotekę materiałów, do której ten etap nie sięga.

**Prompty są stałymi w `src/lib/character/prompt.ts`, z jawną wersją.** Niosą rzemiosło:
kartę o dziewięciu komórkach w siatce 3 × 3, dyscyplinę obrotówki, kryteria spójności między
widokami, reguły alfy i wyprowadzenie hero z zatwierdzonej karty oraz ośmiu zatwierdzonych
widoków. **Nie niosą kierunku artystycznego.** Medium, stylizacja, proporcje, paleta i strój
pochodzą z `project.md`, a prompt mówi o tym wprost; inaczej seria płaska 2D odziedziczyłaby
fotorealizm po produkcji, dla której te prompty pierwotnie powstały.

**Rozróżnienie podstawy.** Przy `photographs` obraz 1 jest głównym źródłem tożsamości,
kolejne zdjęcia to materiał pomocniczy na inne kąty, a przy sprzeczności wygrywa obraz 1.
Przy `description` nie ma żadnej referencji: prompt mówi modelowi, że opis w zasadach jest
jedynym wejściem, jakie ten etap dostanie, i że decyzje podjęte na karcie obowiązują
wszystkie późniejsze obrazy.

**Plan referencji.** Karta: wszystkie zdjęcia albo nic. Widok: zdjęcie główne, karta,
pozostałe zdjęcia. Hero: zdjęcie główne, karta, osiem widoków, pozostałe zdjęcia, przy czym
tor seedream przyjmuje najwyżej dziesięć referencji, więc jego hero kończy się na widokach.
To jest **zapisany krótszy plan**, nie ciche obcięcie dłuższego. Przekroczenie limitu przez
samą liczbę zdjęć jest odmową: użytkownik, który dostarczył dwanaście fotografii, nie prosił
narzędzia o wybranie dziesięciu.

**Archiwum próby.** `characters/<id>/<tor>/runs/<runId>/` trzyma `prompt.md`, `request.json`,
`response.json`, `transport.json`, `run.json`, `validation.json` i, na torze seedream,
`original.png`, czyli dokładnie to, co dostawca zwrócił. `request.json` niesie prompt
i ustawienia, ale **nigdy bajtów referencji**: te są wejściami, identyfikowanymi ścieżką
i sha256. Hero na torze seedream wiózłby inaczej dziesięć PNG-ów w base64 na każdą próbę.
Poprzedni wynik trafia do `previous.png` wyłącznie przy `--regenerate`.

**Wznowienie bez drugiej opłaty.** Rekord `submitted` bez zapisanej odpowiedzi to ślepy
zaułek, który otwiera tylko `--regenerate`. Ale odpowiedź, która zdążyła trafić na dysk,
jest już opłacona: gpt-image niesie bajty w treści odpowiedzi, seedream adres ważny 24 h.
W obu wypadkach powtórzenie tego samego polecenia dokańcza próbę bez wysyłania czegokolwiek.
Nic nie ponawia się samo.

**Walidacja obrazu jest czysta i offline.** Sprawdza sygnaturę PNG, kompletność bloków
i zgodność wymiarów z żądaniem; obraz w złym rozmiarze nie jest publikowany ani skalowany.
Kanał alfa jest **raportowany, nie egzekwowany**: seedream nie ma przełącznika tła, więc
przezroczystość widoku jest proszona wyłącznie w promptcie, a jej brak to uwaga dla
oceniającego, nie powód do wyrzucenia obrazu, za który już zapłacono.

**Brak alfy na torze seedream nie blokuje niczego dalej, i to jest rozstrzygnięcie, nie
przeoczenie.** Żaden etap nie kompozytuje widoku: widoki są wejściem, z którego etap 2
rysuje `hero.png`, a od etapu 4 w dół referencją jest wyłącznie `hero.png`, czyli obraz, który
i tak ma tło. Etapy 5–7 dołączają referencje do żądania generacji, a nie wklejają ich do
kadru, i oba tory przyjmują nieprzezroczysty PNG. Dlatego nie ma osobnego kroku wycinania
tła i nie rezygnujemy z seedream dla widoków: automatyczne przetworzenie obrazu po ocenie
podmieniłoby bajty, które ktoś przyjął, na bajty, których nie przyjął nikt, a to łamie
niezmiennik o akceptacji związanej z bajtami. Gdyby któryś z późniejszych etapów naprawdę
potrzebował wycinanki, będzie to jego własny, jawny i oceniany krok, nie cicha poprawka
dopisana wstecz do etapu 2.

**Komplet dziesięciu artefaktów obowiązuje każdą postać obsady, bez wyjątku dla
drugoplanowych.** Kryterium wejścia do obsady jest jedno: tożsamość musi przetrwać między
odcinkami, więc nie ma drugiego kryterium, po którym można by komuś odjąć widoki; „mniej
ważna postać" nie jest zapisaną decyzją i nie ma pola, które by ją niosło. Osiem widoków
nie jest zresztą wejściem żadnego późniejszego etapu: są wejściem `hero.png`, a hero postaci
drugoplanowej jest dokładnie tak samo nośny co hero głównej, bo etap 4 przypisuje go do
każdego kadru, w którym lista ujęć ją stawia. Tańszy poziom dla postaci epizodycznej już
istnieje i nazywa się referencją etapu 5.

**Akceptacja dotyczy jednego obrazu naraz.** `aimator approve <project-id> <character-id>
--stage character --track <tor> --artifact <klucz>[,...]` odmawia bez jawnego wskazania, co
jest przyjmowane: przyjęcie karty uruchamia osiem płatnych wywołań, więc musi być czymś,
co ktoś napisał, a nie skutkiem ubocznym przyjęcia czegoś innego. `aimator check
<project-id> <character-id> --stage character --track <tor>` sprawdza to samo i nie zapisuje
niczego.

Ramki są stałymi toru, nie decyzją: karta 1920×1920, widok 1536×1536, hero 1536×2304.
Żadna z nich nie jest `aspectRatio` projektu, ten rządzi kadrem filmu od etapu 5, a karta
postaci w 16:9 zmarnowałaby większość siebie.

## Etap 3: szczegóły

Pierwszy etap tekstowy po scenariuszu i pierwszy artefakt **wspólny dla obu torów
obrazowych**, nie ma w nim poziomu katalogu na tor. `shot-list.md` leży bezpośrednio pod
odcinkiem, obok scenariusza, bo opisuje historię, a nie obrazy; rozejście torów zaczyna
się dopiero przy pierwszym obrazie odcinka.

Konsumuje zatwierdzony `screenplay.md` oraz te artefakty etapu 0, które czyta każdy etap:
zasady i proporcje z `project.json` i `project.md`, decyzje odcinka z `episode.json`.
**Nie konsumuje `source.md`**: etap 1 już zaadaptował źródło, więc etap 3 ani go nie czyta,
ani nie wysyła, a zapisanie hasha bajtów, których nikt nie wysłał, opisywałoby pytanie,
którego nie zadano. **Nie zależy od etapu 2**: nazywa postacie identyfikatorami z obsady,
a obrazy postaci są wejściem etapu 4.

**Bramka przed wydaniem pieniędzy.** `shot-list generate` odmawia płatnego wywołania,
dopóki `screenplay.stage.json` tego odcinka nie ma `review.status = "approved"`. Ta jedna
bramka obejmuje też etap 0: `project.md`, `project.json` i `episode.json` są zapisanymi
wejściami etapu 1, więc ich edycja unieważnia jego akceptację arytmetycznie i etap 3
blokuje bez osobnej reguły. Druga przeszkoda to brak decyzji `maxClipSeconds`.
`--dry-run` żadnej z nich nie omija: raportuje je jako przeszkody i i tak pokazuje prompt,
bo po to jest podgląd. Bez `maxClipSeconds` promptu nie da się złożyć, więc podgląd mówi
to wprost, zamiast pokazać tekst z wymyśloną liczbą.

**Skąd bierze się model.** `--model <id>`, a bez tej flagi `AIMATOR_SHOTLIST_MODEL`.
Osobna zmienna, nie ta od scenariusza: wspólna znaczyłaby, że wybór modelu do etapu 1 po
cichu wybrał też model do etapu 3, a tego nikt nie zdecydował. Wartości domyślnej nie ma.
Limit tokenów ma domyślną 24 000: to sufit bezpieczeństwa, nie decyzja kreatywna, a lista
ujęć jest dwa do trzech razy dłuższa niż scenariusz, który planuje.

**Trzy jednostki, nigdy utożsamiane.** Scena jest ciągłą jednostką miejsca i czasu i
pochodzi ze scenariusza. Ujęcie to jedno spojrzenie kamery. Klip to jedna planowana
generacja wideo, obejmująca jedno lub więcej kolejnych ujęć. Etap 3 nie przenumerowuje ani
nie scala scen scenariusza.

**Co sprawdza walidacja**, czysto i offline, jak w etapie 1:

- cztery sekcje `Plan`, `Clips`, `Shots`, `Review`, w tej kolejności, żadna pusta, bez
  bloku kodu;
- klipy numerowane kolejno od `C01`, każdy nie dłuższy niż `maxClipSeconds`, kafelkujące
  odcinek bez dziur, z polem `Shots` zgadzającym się co do znaku z ujęciami, które do nich
  należą; pierwszy klip ma `Reference: opening-frame`, każdy kolejny
  `previous-end-frame` albo `new-scene-frame`;
- ujęcia numerowane kolejno od `U01`, każde zaczynające się dokładnie tam, gdzie skończyło
  się poprzednie (jedno porównanie zakazujące naraz dziury, nakładki i przestawienia)
  i sumujące się dokładnie do `durationSeconds`;
- każde ujęcie w **dokładnie jednej scenie i jednym klipie**, mieszczące się w granicach
  obu; pełne pokrycie każdej sceny wynika z tego arytmetycznie i nie jest osobną regułą;
- dziesięć pól ujęcia, każde dokładnie raz i niepuste: `Purpose`, `Frame`, `Action`,
  `Expression`, `Camera`, `Cast`, `Audio`, `Text`, `Start state`, `End state`;
- tekst ekranowy **przeniesiony, nie wymyślony**: ujęcie nie może mieć napisu, którego jego
  scena nie miała, przy `subtitles: none` każde `Text` brzmi `none`, a scena, która miała
  napis, nie może stracić go w żadnym ze swoich ujęć.

**`Cast` wiąże ujęcie z postacią.** Każde ujęcie wymienia widoczne postacie
**identyfikatorami obsady** (`ewa`, `tata`) z zamkniętego słownika podanego w promptcie,
albo `none`. Proza pól opisowych używa imion i odmienia je naturalnie, i właśnie dlatego
imię nie może być wiązaniem: „Ewy" i „Ewie" to ten sam człowiek, a dopasowywanie tego
w tekście byłoby zgadywaniem. Identyfikator jest jedyną drogą, którą etap 4 dojdzie od
ujęcia do zatwierdzonego `hero.png`. Postać widziana raz nie należy do obsady: opisuje ją
`Frame` i `Action`, a obrazem staje się w etapie 5.

**Maszynowa postać listy ujęć to parser, nie drugi plik.** `validateShotList` rozbiera
dokument w trakcie walidacji i zwraca to, co rozebrał, ujęcia, klipy, sceny, czasy
i obsadę, więc etap 4 czyta je jako dane przez wejście modułu. Zapis `shot-list.json`
obok `shot-list.md` dałby odcinkowi dwie wersje tej samej prawdy, a po pierwszej ręcznej
poprawce w ocenie kreatywnej rozjechałyby się, przy czym poprawiany jest ten plik, który
człowiek czyta.

**Archiwum próby** trafia do tego samego `episodes/<id>/runs/<runId>/`, co etap 1, `runId`
jest unikalny, a `run.json` zapisuje, którego etapu dotyczy. Wejścia są referowane ścieżką
i sha256, nigdy kopiowane; poprzednia lista ujęć trafia do `previous/shot-list.md` wyłącznie
przy `--regenerate`. Wywołanie idzie ze `store: false`, więc obowiązuje ta sama zasada, co
w etapie 1: rekord `submitted` bez zapisanej odpowiedzi otwiera wyłącznie `--regenerate`,
a odpowiedź, która zdążyła trafić na dysk, jest już opłacona i powtórzenie polecenia
dokańcza z niej próbę bez wysyłania czegokolwiek. Odmowa 4xx nie została rozliczona
i wolno ją powtórzyć zwykłym przebiegiem.

**Walidacja to nie akceptacja.** Wynik, który przeszedł walidację, ma
`review.status = "pending"`. Przyjmuje go dopiero
`aimator approve <project-id> <episode-id> --stage shot-list`, i tylko wtedy, gdy hash
`shot-list.md` się zgadza i plan nadal przechodzi walidację wobec scenariusza w takim
kształcie, w jakim leży.

Rozjazd wejścia działa tu tak samo jak w etapie 1: unieważnia akceptację, `approve`
przepisuje hashe i zapisuje nową zgodę. Zabezpieczeniem jest to, że lista ujęć waliduje się
wobec **bieżącego** scenariusza, więc scenariusz, któremu naprawdę zmienił się kształt
(inny czas sceny, inna scena), zostawia ujęcia poza granicami i walidacja odmawia.
`aimator check <project-id> <episode-id>` sprawdza to samo dla etapów 1 i 3 naraz i nie
zapisuje niczego.

## Etap 4: szczegóły

Pierwszy etap, który łączy tor tekstowy z obrazowym: wynik jest tekstem, ale bramka pyta
o obraz. Konsumuje zatwierdzony `shot-list.md` oraz te artefakty etapu 0, które czyta każdy
etap: zasady i proporcje z `project.json` i `project.md`, decyzje odcinka z `episode.json`.
**Nie konsumuje `source.md` ani `screenplay.md`**: lista ujęć już je zaadaptowała, a zapisanie
hasha bajtów, których nikt nie wysłał, opisywałoby pytanie, którego nie zadano.

**Pakiet jest wspólny dla obu torów, a bramka pyta o oba.** `prompt-package.json` i `prompts/`
leżą bezpośrednio pod odcinkiem, bez poziomu katalogu na tor, i nic w nich nie nazywa toru:
kadr przypisuje sobie identyfikatory `hero:<id>` i `Rnn`, a w jaki plik się one zamieniają,
rozstrzyga dopiero etap, który je dołącza: `characters/<id>/<tor>/hero.png` albo
`episodes/<id>/<tor>/references/Rnn.png`. To jest cały powód, dla którego jeden manifest
obsługuje dwie produkcje. Ponieważ obsługuje obie, obie muszą być gotowe: płatne wywołanie
odmawia, dopóki każda postać, którą lista ujęć stawia w kadrze, nie ma zatwierdzonego
`hero.png` **na torze gpt-image i na torze seedream**. Wspólny artefakt, którego bramkę
spełnił jeden tor, byłby planem, na który połowa potoku nie zapracowała. Alternatywa, czyli
zapis w pakiecie, wobec którego toru był sprawdzany, jest tym samym błędem co prefiks
nazwy zamiast poziomu katalogu, tylko piętro wyżej.

Bramka pyta o postacie **w kadrze**, nie o całą obsadę: `castSeen` z listy ujęć mówi, kto
w tym odcinku występuje, a hero postaci, której pakiet nigdy nie wymieni, nie jest jego
wejściem. To ta sama zasada, co „projekt bez odcinka przechodzi": etap nie jest zakładnikiem
pliku, którego nie otwiera.

**Obrazy postaci są zapisanym wejściem, choć nie są wysyłane.** Do modelu idzie to samo, z
czego te obrazy powstały: `project.md`. Dołączenie hero jednego toru uczyniłoby plan drugiego
toru pochodną tamtego rysunku. Hashe jednak są zapisane, bo to, co ten etap z nich konsumuje,
to dokładnie fakt „te bajty niosą zgodę człowieka", czyli to, na czym stoi bramka. Dzięki
temu hero narysowany ponownie po wydaniu pakietu jest rozjazdem wejścia: `check` go zgłasza,
a `approve` przepisuje hashe i zapisuje nową zgodę.

**Skąd bierze się model.** `--model <id>`, a bez tej flagi `AIMATOR_PROMPTS_MODEL`, czyli własna
zmienna, jak przy każdym innym płatnym wywołaniu. Wartości domyślnej nie ma. Limit tokenów ma
domyślną 32 000: pakiet to jedna instrukcja na referencję, na klip i na klatkę wejściową,
więc jest najdłuższą odpowiedzią, o jaką prosi którykolwiek etap tekstowy. To sufit
bezpieczeństwa, nie decyzja kreatywna.

**Odpowiedź ma wymuszony schemat.** Wywołanie idzie z `text.format: json_schema`, `strict`,
bo wynikiem nie jest dokument czytany od góry do dołu, tylko graf zależności i około
dwudziestu osobnych instrukcji; tablica jest jednoznaczna tam, gdzie pole Markdown po
przecinkach byłoby parserem nad prozą. Schemat JSON powstaje z tego samego schematu Zod,
którym etap potem sprawdza manifest; drugi, ręcznie utrzymywany opis tego samego kształtu
rozjechałby się z tym, którego nikt nie uruchamia.

### Dwa pliki, dwie prawdy, zero pokrycia

`prompts/**` to **jeden plik na jedno przyszłe płatne wywołanie**:
`opening-frame.md`, `references/Rnn.md`, `clips/Cnn.md` i `entry-frames/Cnn.md`, ta ostatnia
dla każdego klipu poza pierwszym, bo klatką wejściową C01 jest klatka otwarcia. Każdy z nich
niesie **wyłącznie kierunek twórczy dla tego jednego kadru**: nagłówek i prozę. To jest plik,
który człowiek czyta i poprawia przy ocenie, i to jego wysyła etap 5, 6 albo 7.

`prompt-package.json` to **okablowanie**: identyfikatory, `kind`, jednoliniowy `subject`,
`dependsOn`, `referenceIds` każdego kadru i własna ocena modelu w polu `review`. Graf zapisany
prozą jest grafem, którego nikt nie sprawdzi, więc mieszka tu, a nie w promptach.

**Proza promptu adresuje załączniki identyfikatorem, bo składający obiecuje go wypisać.**
`prompts/references/R03.md` wolno napisać „zachować tożsamość zabawki z R02", a
`prompts/clips/C03.md`, „hero:ewa i hero:tata określają postacie we wspólnej skali",
ponieważ niezmiennik o prompcie z załącznikami zobowiązuje etap wysyłający do
poprzedzenia zadania listą `Image N = <identyfikator> — <rola>`. Bez tej obietnicy
identyfikator w prozie byłby napisem, którego model obrazu nie ma jak rozwiązać, a etap
planujący nie miałby jak wskazać konkretnego z dwóch podobnych załączników. Odwrotna
droga, czyli proza opisująca załącznik słowami („referencja salonu"), traci precyzję dokładnie
tam, gdzie referencji tego samego rodzaju jest więcej niż jedna.

Dlatego w promptcie etapu 4 ta umowa jest **wypisana modelowi wprost**, razem z przykładem
listy, którą zobaczy odbiorca. Model, który nie wie, jak jego identyfikator wygląda po
drugiej stronie, pisze na ślepo, i to była jedyna przyczyna, dla której `prompts/**`
mogło zawierać identyfikator nieznaczący nic dla modelu obrazu.

Żaden z tych plików nie trzyma tego, co mówi drugi, i **żaden nie trzyma kopii listy ujęć**.
Prompt nie powtarza czasów, akcji, dźwięku ani tekstu ekranowego, i nie wylicza swoich
referencji: numerowany blok referencji, zasady projektu i dosłowne ujęcia z listy dokleja
etap wysyłający, w chwili wysyłki, czytając listę przez `validateShotList`. Dokładnie tak,
jak `character/prompt.ts` numeruje referencje przy wywołaniu zamiast przechowywać listę,
która kiedyś opisze pozycję nieistniejącą w żądaniu. Rozstrzygnięcie z etapu 3 obowiązuje
tu bez zmian: dwa pliki opisujące tę samą prawdę rozjeżdżają się przy pierwszej ręcznej
poprawce, a poprawiany jest ten, który człowiek czyta.

Zabezpieczeniem jest to, że **wszystkie te pliki są wynikami związanymi z hashem**. Ręczna
edycja promptu albo manifestu wywraca `check` i blokuje `approve`, więc rozjazd między nimi
nie może być cichy. Pakiet nie jest jednym dokumentem właśnie dlatego, że jednostka, którą
człowiek przyjmuje, musi być jednostką, którą etap wysyła; jeden dokument znaczyłby albo
wysyłanie całości przy każdym wywołaniu, albo krojenie prozy parserem.

`--regenerate`, który planuje mniej referencji niż poprzedni pakiet, **usuwa osierocone pliki
promptów**, ale wyłącznie te, które ten etap sam zapisał jako swoje wyniki. `prompts/` czyta
się jako listę tego, czego odcinek jeszcze potrzebuje, a `R07.md` po pakiecie bez R07 opisywałby
obraz, na który już nic nie wskazuje.

### Skąd bierze się graf `dependsOn`

Graf ma dwie połowy i tylko jedna jest zapisana.

**Łańcuch klipów nie jest zapisany.** Że C03 kontynuuje końcówkę C02, mówi pole `Reference`
listy ujęć, a `validateShotList` zwraca je jako dane. Jest więc wyliczany przy każdym odczycie,
bo jest wnioskiem z pliku, który już istnieje i który człowiek poprawia, przepisany do pakietu
stałby się drugą wersją tej samej prawdy i rozjechałby się przy pierwszej takiej poprawce.

**Zależności obrazów referencyjnych są zapisane**, bo nie da się ich wyprowadzić: to, że
klatka otwarcia potrzebuje obrazu Ewy, układu salonu i alpaki, a alpaka nie potrzebuje niczego
poza stylem, jest decyzją twórczą, której żaden parser nie odtworzy z listy ujęć. Zapisane są
`references[].dependsOn`, `opening.referenceIds` i `clips[].referenceIds`, same identyfikatory,
nigdy ścieżki, właśnie po to, żeby rozwiązywały się per tor.

Różnica wobec parsera listy ujęć jest więc prosta: parser odpowiada „co mówi lista ujęć",
a pakiet „co ktoś zdecydował, czego lista ujęć nie mówi".

**Walidacja grafu** jest czysta, offline i uruchamiana ponownie przy każdym `check`, wobec
listy ujęć w takim kształcie, w jakim leży:

- referencje numerowane kolejno od `R01`, `kind` z zamkniętego zbioru `character`, `location`,
  `prop`, `subject` jednoliniowy i niepusty;
- `dependsOn` niepuste, bez powtórzeń, i wskazujące wyłącznie `hero:<id>` albo referencję
  o niższym numerze. Acykliczność wynika z tej reguły, a nie z osobnego przeszukiwania: cykl
  nie da się zapisać, więc nie ma go czego szukać;
- klipy pakietu to dokładnie klipy listy ujęć, w tej samej kolejności;
- każdy kadr niesie `hero:<id>` **każdej postaci, którą lista ujęć stawia w jego ujęciach**,
  i co najmniej jedną referencję `location`. Pierwsza reguła jest właściwym wiązaniem etapu 4
  z etapem 3; druga jest wnioskiem z produkcji źródłowej: zbliżenie samo nie ustawi szerszego
  kadru, więc kadr bez przestrzeni nie ma do czego się rozszerzyć;
- każda referencja jest osiągalna: coś od niej zależy albo któryś kadr ją przypisuje.
  Referencja, na którą nic nie wskazuje, to obraz, za który etap 5 zapłaciłby bez odbiorcy.

### Kto nazywa referencje nieosobowe

Lista ujęć nazywa identyfikatorami wyłącznie obsadę. Alpaka, salon i niska kanapa istnieją
tylko w prozie pól `Frame`, `Action` i `Start state`, a etap 5 produkuje ponumerowane `Rxx.png`,
więc ktoś musi je nazwać i policzyć. Robi to **model w etapie 4**, a człowiek przyjmuje tę listę;
ocena pakietu jest głównie oceną właśnie jej.

Reguła 7 tego nie łamie. Mówi ona, że decyzja bez wartości domyślnej jest przechowywana, a nie
zgadywana, i każda decyzja, z której ta lista powstaje, **jest** przechowywana: alpaka jest
opisana w `project.md` jako stały rekwizyt, salon, niska kanapa, okno i oś kamery są ustalone
w zatwierdzonym scenariuszu i w sekcji `Plan` zatwierdzonej listy ujęć, a wieczorny komplet
Ewy jest jednym z dwóch kompletów zapisanych w zasadach. „Jakie referencje nieosobowe ma ten
odcinek" jest więc **wnioskiem z zapisanych decyzji**, nie nową decyzją, tak samo jak
scenariusz jest wnioskiem ze źródła. Czego reguła 7 zabrania, to żeby brak odpowiedzi udawał
odpowiedź, i tego tu nie ma: pusta lista referencji nie przechodzi walidacji, a referencja
opisująca coś, czego żaden zatwierdzony artefakt nie wspomina, jest tym, co ocenia człowiek
przed `approve`.

Postać widziana raz też jest taką referencją, nie członkiem obsady; kryterium jest
powracalność, a tańszy poziom dla epizodu to właśnie `Rxx`.

**Walidacja to nie akceptacja.** Wynik, który przeszedł walidację, ma `review.status = "pending"`.
Przyjmuje go dopiero `aimator approve <project-id> <episode-id> --stage prompt-package`, i tylko
wtedy, gdy hashe manifestu i wszystkich plików promptów się zgadzają, a graf nadal waliduje się
wobec bieżącej listy ujęć. Rozjazd wejścia działa jak w etapach 1 i 3: unieważnia akceptację,
`approve` przepisuje hashe i zapisuje nową zgodę. `aimator check <project-id> <episode-id>`
sprawdza to samo dla etapów 1, 3 i 4 naraz i nie zapisuje niczego.

**Archiwum próby** trafia do tego samego `episodes/<id>/runs/<runId>/`, co etapy 1 i 3.
Wejścia są referowane ścieżką i sha256, nigdy kopiowane; poprzedni pakiet (manifest razem
z całym drzewem `prompts/`) trafia do `previous/` wyłącznie przy `--regenerate`, pod własnymi
nazwami. Wywołanie idzie ze `store: false`, więc obowiązuje ta sama zasada, co wyżej: rekord
`submitted` bez zapisanej odpowiedzi otwiera wyłącznie `--regenerate`, a odpowiedź, która
zdążyła trafić na dysk, jest już opłacona i powtórzenie polecenia dokańcza z niej próbę bez
wysyłania czegokolwiek. Odmowa 4xx nie została rozliczona i wolno ją powtórzyć zwykłym
przebiegiem.

**Republikacja z opłaconego archiwum.** `--republish` publikuje jeszcze raz odpowiedź
zapisaną w `runs/<runId>/response.json`, **nie wysyłając niczego i nie wymagając ani modelu,
ani klucza**. Zachowuje `runId` i `producer` poprzedniej próby, bo to jest ta sama próba;
zmieniło się coś po stronie narzędzia, a nowy identyfikator i nowa data opisywałyby pracę,
której nikt nie wykonał. Odmawia, gdy próba nie zachowała odpowiedzi albo gdy wejście się
rozjechało; `--regenerate` i `--republish` wykluczają się wzajemnie.

Istnieje, bo kontrakt mówi już, że kupiona odpowiedź musi dać się ponownie wyprowadzić za
darmo, inaczej błąd walidatora byłby płatny. Ta zasada działała wyłącznie dla rekordu
`submitted`. Błąd **renderera** wychodzi na jaw dopiero po publikacji, przy rekordzie
`completed`, i jedyną drogą była druga opłata za identyczną odpowiedź. To ta sama zasada,
rozciągnięta na pomyłki, które widać o krok później. Flagę niosą wyłącznie etapy z własnym
rendererem: etapy 1 i 3 publikują dokładnie to, co zwrócił model, więc nie mają czego
naprawiać po stronie publikacji.

## Etap 5: szczegóły

Pierwszy etap, w którym tory naprawdę się rozchodzą: jeden pakiet, dwa niezależne zestawy
obrazów, dwie osobne oceny. Konsumuje zatwierdzony `prompt-package.json` razem z plikiem
`prompts/references/Rxx.md` tej referencji, zasady i proporcje z `project.json`
i `project.md`, oraz zatwierdzone obrazy, od których dana referencja zależy, **na tym
torze**. Nie konsumuje `shot-list.md`: referencja nie jest kadrem filmu, więc nie ma
ujęcia, które można by do niej dołączyć, a zapisanie hasha bajtów, których nikt nie wysłał,
opisywałoby pytanie, którego nie zadano.

**Bramka jest wewnątrz własnego zestawu wyników** i to jest nowe. Płatne wywołanie odmawia,
dopóki `prompt-package.stage.json` nie ma `review.status = "approved"`, a każda pozycja
`dependsOn` danej referencji nie jest zatwierdzona na tym torze: `hero:<id>`
w `character.stage.json` tej postaci, `Rnn` w pliku etapu tego odcinka i toru. R04 czeka
więc na R03, a R06 na R01 i R02. Narysowanie referencji nie otwiera nic; otwiera dopiero
jej przyjęcie przez człowieka. `--dry-run` bramki nie omija: raportuje ją jako przeszkodę
i i tak pokazuje prompt w całości.

**Jedno polecenie rysuje wszystkie gotowe referencje**, w kolejności manifestu, jedno
płatne wywołanie naraz, a seria zatrzymuje się na pierwszym błędzie z zachowaniem
wcześniejszych wyników. Etap 2 robił jeden krok na uruchomienie, ale to był **skutek**, nie
zasada: jego bramki zostawiały dokładnie jeden wykonalny artefakt. Tutaj graf ma kilka
niezależnych korzeni, więc skopiowanie skutku zamiast powodu znaczyłoby odmowę wykonania
pracy, o której narzędzie wie, że jest dozwolona, i zmuszałoby do wpisywania tego samego
polecenia kilka razy. Bezpieczeństwo niosą inne rzeczy: osobny rekord i osobne `submitted`
na każdy obraz, oraz raport, który **podaje liczbę płatnych wywołań, zanim je wykona**.
`--artifact R01,R02` zawęża przebieg, a `--regenerate` **wymaga** jawnego `--artifact`.

**Plik etapu to `references.stage.json`, jeden na tor**, na poziomie katalogu toru, z jednym
rekordem na referencję pod kluczem `R01`…`Rnn`. Klucz `artifacts` istnieje właśnie po to,
żeby objąć zbiór wyników bez mnożenia plików, dokładnie tak, jak etap 2 trzyma dziesięć
obrazów postaci. Nie ma tu `references-state.json` ani `downstream-status.json`.

**Ramka jest wyliczana z `aspectRatio` i jest ta sama na obu torach.** Nie wynika z `kind`:
`kind` opisuje krawędź grafu, a nie płótno, więc człowiek przyjmujący „prop" nie
przyjmował proporcji obrazu. Nie jest też osobną decyzją, bo `aspectRatio` już nią jest;
brakuje do niej wyłącznie arytmetyki, a arytmetyka nie jest decyzją. Narzędzie bierze
**największy** kadr o dokładnie tej proporcji, którego oba boki są wielokrotnością 16
i który mieści się w limitach **obu** torów; dla `16:9` wychodzi 2816×1584. Największy,
bo referencję rysuje się raz, a czyta ją każde późniejsze wywołanie, które ją dołącza:
rozdzielczości oddanej tutaj nie da się odzyskać niżej, a modelowi, który chce mniej
pikseli, zawsze można dać mniej. Proporcję, której żaden tor nie renderuje, narzędzie
odrzuca, zamiast zaokrąglić ją do takiej, którą renderuje. Jedna ramka na oba tory jest
tym, co sprawia, że dwa wyniki dają się porównać. Referencje są nieprzezroczyste: żaden
późniejszy etap nie kompozytuje referencji, tylko dołącza ją do generacji.

**Przekroczenie limitu referencji toru jest odmową przy generacji na tym torze**, nie przy
walidacji pakietu i nie cichym obcięciem. Odmowa w etapie 4 zmuszałaby wspólny artefakt do
znajomości torów (ten sam błąd co prefiks nazwy zamiast poziomu katalogu), i sprawiałaby,
że surowszy tor po cichu rządzi luźniejszym. Zapisany krótszy plan działa w etapie 2, bo
tam plan napisał kod; tutaj listę napisał model, a przyjął ją człowiek, więc obcięcie
znaczyłoby, że proza promptu adresuje załącznik, którego żądanie nie niesie, czyli
dokładnie to, przed czym broni niezmiennik o prompcie z załącznikami. Kontrola siedzi
u składającego, więc jedna reguła obsługuje referencje, klatkę otwarcia, klipy i klatki
wejściowe naraz.

**Prompt powstaje przy wywołaniu i jest tym samym tekstem, który pokazuje podgląd.**
`aimator prompt-package show <project-id> <episode-id> --track <tor>
[--artifact R02|opening-frame|C03|entry:C03]` jest darmowe, nie sięga po sieć ani po
sekrety i drukuje dokładnie to, co poleci do modelu: numerowany blok
`Image N = <identyfikator> — <rola>` w kolejności, w jakiej żądanie poniesie bajty, potem
treść pliku z `prompts/`, potem blok o medium, potem kadr, potem, przy kadrach filmu (nie
przy referencjach), dosłowne ujęcia z listy, i na końcu `project.md`. Istnieje, bo etap 4
publikuje **połowę** promptu, a człowiek zatwierdza coś, czego inaczej nie widzi w formie,
w jakiej to poleci. Jest to zarazem ten sam składacz, którego używa wysyłka: jedna
implementacja, dwóch odbiorców, więc podgląd nie może się rozjechać z żądaniem.

Blok załączników idzie **przed** zadaniem, nie po nim: plik z `prompts/` adresuje
identyfikatory w pierwszym zdaniu, więc czytający musi je już znać. Prompt etapu 4 obiecuje
modelowi dokładnie ten układ, a to ta obietnica czyni identyfikator w prozie rozwiązywalnym.

**Archiwum próby** trafia do `episodes/<id>/<tor>/runs/<runId>/`, osobnego od
`episodes/<id>/runs/`, w którym archiwizują etapy tekstowe, i trzyma `prompt.md`,
`request.json`, `response.json`, `transport.json`, `run.json`, `validation.json` oraz, na
torze seedream, `original.png`. `request.json` niesie prompt i ustawienia, ale **nigdy
bajtów referencji**: te są wejściami, identyfikowanymi ścieżką i sha256. Poprzedni obraz
trafia do `previous.png` wyłącznie przy `--regenerate`.

**Wznowienie bez drugiej opłaty** działa tak jak w etapie 2: rekord `submitted` bez
zapisanej odpowiedzi to ślepy zaułek, który otwiera tylko `--regenerate`, ale odpowiedź,
która zdążyła trafić na dysk, jest już opłacona: gpt-image niesie bajty w treści, seedream
adres ważny 24 h, a powtórzenie tego samego polecenia dokańcza próbę bez wysyłania
czegokolwiek. Obraz w złym rozmiarze nie jest publikowany ani skalowany: rekord zostaje
`submitted`, odpowiedź zostaje w archiwum, a poprawka walidatora jest darmowa.

**Nie ma `--republish`.** Flagę niosą wyłącznie etapy z własnym rendererem, a ten publikuje
dokładnie te bajty, które zwrócił dostawca; nie ma tu czego naprawiać po stronie
publikacji, a błąd walidatora i tak otwiera darmowe wznowienie opisane wyżej.

**Akceptacja dotyczy jednego obrazu naraz.** `aimator approve <project-id> <episode-id>
--stage references --track <tor> --artifact R01[,R02]` odmawia bez jawnego wskazania, co
jest przyjmowane: przyjęcie R03 uruchamia płatne wywołanie R04, więc musi być czymś, co
ktoś napisał, a nie skutkiem ubocznym przyjęcia czegoś innego. `aimator check <project-id>
<episode-id> --stage references --track <tor>` sprawdza to samo i nie zapisuje niczego.

Rozjazd wejścia unieważnia akceptację i `check` to zgłasza, a `approve` przepisuje hashe
wejść i zapisuje nową zgodę, jak wszędzie indziej. Zabezpieczeniem nie jest tu ponowna
walidacja strukturalna, bo żaden parser nie orzeknie, czy R04 nadal pasuje do przerysowanej
R03; zabezpieczeniem jest to, że **oceną obrazu jest człowiek, który na niego patrzy**;
a komunikat mówi wprost, żeby obejrzeć obraz obok nowej wersji jego wejścia albo przerysować
go jawnym `--regenerate --artifact`.

## Etap 6: szczegóły

Pierwsza klatka filmu i pierwszy etap, którego bramka czyta **wyniki innego etapu, per
tor**. Konsumuje zatwierdzony `prompt-package.json` razem z `prompts/opening-frame.md`,
zasady i proporcje z `project.json` i `project.md`, zatwierdzoną `shot-list.md` oraz
zatwierdzone obrazy, które manifest wpisał w `opening.referenceIds`, **na tym torze**.
Produkuje `episodes/<id>/<tor>/opening-frame.png`, obok niego `opening-frame.stage.json`
z jednym rekordem, i jedno archiwum próby w `runs/` tego toru.

**Konsumuje listę ujęć, w odróżnieniu od etapu 5.** Klatka otwarcia jest kadrem filmu, więc
niesie dosłowne ujęcia pierwszego klipu, a referencja nie jest kadrem i nie ma ujęcia,
które można by do niej dołączyć. Hash `shot-list.md` jest więc zapisanym wejściem tego
etapu, choć nie był wejściem poprzedniego.

**Bramka pyta o cudze wyniki, ale na własnym torze.** Płatne wywołanie odmawia, dopóki
`prompt-package.stage.json` nie ma `review.status = "approved"`, a każda pozycja
`opening.referenceIds` nie jest zatwierdzona na tym torze: `hero:<id>`
w `character.stage.json` tej postaci, `Rnn` w `references.stage.json` tego odcinka i toru.
Etap 5 czekał na referencje, które sam narysował; tutaj zależność przekracza granicę etapu,
nie przekraczając granicy toru; dlatego zgoda wydana na gpt-image nie otwiera niczego na
seedream. `--dry-run` bramki nie omija: raportuje ją jako przeszkodę i i tak pokazuje prompt
w całości.

**Jeden artefakt, więc `--artifact` niczego nie zawęża i nie jest wymagane.** Ani przy
`--regenerate`, które ma dokładnie jeden obraz, który mógłby znaczyć, ani przy `approve`,
gdzie `aimator approve <project-id> <episode-id> --stage opening-frame --track <tor>` samo
w sobie jest wskazaniem. Etap 5 wymaga tej flagi, bo ma sześciu kandydatów i przyjęcie
niewłaściwego kupuje obraz; flaga o jednej dozwolonej wartości byłaby ceremonią stojącą tam,
gdzie kiedyś była decyzja. Reguła 7 mówi o decyzji **bez wartości domyślnej**; tu nie ma
drugiej możliwości, więc nie ma decyzji. Flagę nadal wolno napisać i nadal jest sprawdzana:
`--artifact R01` w tym etapie jest odmową, nie cichym zignorowaniem.

**Ramka jest ta sama co w etapie 5**: największy kadr o proporcjach `aspectRatio`, którego
oba boki są wielokrotnością 16 i który mieści się w limitach obu torów; dla `16:9` wychodzi
2816×1584. Liczy ją ta sama arytmetyka, bo jest to ta sama decyzja projektu, a nie nowa.
Klatka jest nieprzezroczysta: żaden późniejszy etap jej nie kompozytuje, tylko dołącza ją do
generacji.

**Liczba płatnych wywołań jest podawana przed wysyłką**, choć wynosi zero albo jeden.
Właśnie dlatego warto ją drukować: człowiek, który uruchamia `--dry-run`, pyta, czy to
polecenie zaraz kupi obraz, czy powie mu, że nie może. Podgląd nie liczy jako płatnego
wyniku, który prawdziwy przebieg pominie; gotowa klatka bez `--regenerate` to zero wywołań,
nie jedno.

**Archiwum próby** trafia do `episodes/<id>/<tor>/runs/<runId>/`, tego samego, w którym
archiwizuje etap 5: `runId` jest unikalny, a `run.json` zapisuje, którego etapu dotyczy;
dokładnie tak, jak etapy tekstowe dzielą jedno `runs/` pod odcinkiem. Trzyma `prompt.md`,
`request.json`, `response.json`, `transport.json`, `run.json`, `validation.json` oraz, na
torze seedream, `original.png`. `request.json` niesie prompt i ustawienia, ale **nigdy bajtów
referencji**: te są wejściami, identyfikowanymi ścieżką i sha256. Poprzednia klatka trafia do
`previous.png` wyłącznie przy `--regenerate`.

**Wznowienie bez drugiej opłaty** działa jak w etapach 2 i 5: rekord `submitted` bez
zapisanej odpowiedzi to ślepy zaułek, który otwiera tylko `--regenerate`, ale odpowiedź,
która zdążyła trafić na dysk, jest już opłacona i powtórzenie polecenia dokańcza próbę bez
wysyłania czegokolwiek. Obraz w złym rozmiarze nie jest publikowany ani skalowany: rekord
zostaje `submitted`, odpowiedź zostaje w archiwum, a poprawka walidatora jest darmowa.
**Nie ma `--republish`**: ten etap publikuje dokładnie te bajty, które zwrócił dostawca,
więc nie ma czego naprawiać po stronie publikacji.

**Akceptacja jest osobna od walidacji**, jak wszędzie. Klatka, która przeszła walidację, ma
`review.status = "pending"`; przyjmuje ją dopiero `aimator approve <project-id> <episode-id>
--stage opening-frame --track <tor>`. `aimator check <project-id> <episode-id> --stage
opening-frame --track <tor>` sprawdza to samo i nie zapisuje niczego.

Rozjazd wejścia unieważnia akceptację i `check` to zgłasza, a `approve` przepisuje hashe
wejść i zapisuje nową zgodę. Zabezpieczeniem nie jest ponowna walidacja strukturalna, bo
żaden parser nie orzeknie, czy klatka nadal pasuje do przerysowanej `R01`; zabezpieczeniem
jest to, że **oceną obrazu jest człowiek, który na niego patrzy**, a komunikat mówi wprost,
żeby obejrzeć klatkę obok nowej wersji jej wejścia albo przerysować ją jawnym
`--regenerate`.

## Etap 7: szczegóły

Pierwszy etap, który kupuje **dwa rodzaje mediów**, i pierwszy, którego bramka jest
**łańcuchem**. Konsumuje zatwierdzony `prompt-package.json` razem z `prompts/clips/Cnn.md`
i `prompts/entry-frames/Cnn.md`, zasady i proporcje z `project.json` i `project.md`,
zatwierdzoną `shot-list.md`, z której bierze dosłowne ujęcia i **planowaną długość klipu**,
oraz zatwierdzoną klatkę, od której klip się zaczyna, na tym torze. Produkuje
`episodes/<id>/<tor>/clips/Cnn.mp4` i `episodes/<id>/<tor>/frames/Cnn/`, obok nich jeden
`clips.stage.json` na oba media, i jedno archiwum próby w `runs/` tego toru.

**Jeden plik stanu na oba media**, z kluczami `C01`, `entry:C02`, `C02`…, czyli dokładnie
tym słownictwem, którego używa `prompt-package show --artifact`. Reguła 1 mówi „jeden
`<stage>.stage.json` na etap", a etap 7 jest jednym etapem, niezależnie od tego, ile
rodzajów plików zapisuje. `entry-frames.stage.json` nie istnieje i nie powstanie: nie ma
takiego etapu w słowniku nazw.

### Co jest rysowane, a co dziedziczone

Lista ujęć mówi per klip `Reference: opening-frame`, `previous-end-frame` albo
`new-scene-frame`. To pole nie rozstrzyga, **czy** klatka wejściowa powstaje; rozstrzyga,
**z czego** jest rysowana:

| `Reference` | Klatka wejściowa klipu | Załączniki jej wywołania | Bramka |
|---|---|---|---|
| `opening-frame` | brak własnej, jest nią `<tor>/opening-frame.png` z etapu 6 | brak | zatwierdzona klatka otwarcia na tym torze |
| `new-scene-frame` | rysowana do `frames/Cnn/entry.png` | `clips[].referenceIds` z manifestu | jak w etapie 6 |
| `previous-end-frame` | rysowana do `frames/Cnn/entry.png` | **Image 1 = `end:C(n-1)`**, potem `clips[].referenceIds` | zatwierdzona końcówka poprzednika na tym torze |

Wynika to wprost z etapu 4, nie z upodobania: `prompts/**` to **jeden plik na jedno
przyszłe płatne wywołanie**, a `entry-frames/Cnn.md` powstaje dla każdego klipu poza
pierwszym, więc klip kontynuujący, którego klatki nikt by nie rysował, zostawiałby plik
bez odbiorcy. Prompt etapu 4 opisuje zresztą oba przypadki wprost: klatka klipu
kontynuującego ma odtwarzać przyjętą końcówkę poprzednika i **niczego nie posuwać do
przodu**.

**Końcówka wraca razem z klipem.** Zadanie wideo jest uruchamiane z prośbą o ostatnią
klatkę, więc `frames/Cnn/end.png` publikuje się w tym samym kroku, z tej samej opłaconej
próby, jako drugie wyjście **tego samego rekordu**. Dlatego jedna ocena obejmuje klip i
klatkę, którą kontynuuje następny, i dlatego nie ma tu osobnego kroku wycinania, tego, przed
którym broni etap 2: bajty, które ktoś przyjmuje, powstają przed oceną, nie po niej.
Końcówka powstaje dla **każdego** klipu, nie tylko dla tych, których następnik jej
potrzebuje: gdyby zależała od pola następnego klipu, edycja listy ujęć zmieniałaby wstecz
to, co dawno opublikowany rekord powinien był zawierać.

### Płatne wywołanie klipu niesie dokładnie jeden obraz

I to jest reguła dostawcy, nie wybór: przypięcie pierwszej klatki i dołączanie referencji
to **wykluczające się tryby** API. Klip niesie więc swoją klatkę wejściową i nic więcej.
Referencje, które manifest przypisał klipowi, nie giną: to z nich narysowana jest ta
klatka, i tam robią swoją robotę. Blok załączników mówi to modelowi wprost: to nie jest
referencja, to jest pierwsza klatka, zacznij dokładnie tam i animuj do przodu.

Z tego samego powodu `clips[].referenceIds` pierwszego klipu nie ma odbiorcy w etapie 7:
klatką wejściową C01 jest klatka otwarcia, która ma własną listę w `opening.referenceIds`.

### Długość klipu

Bierze się z zatwierdzonej listy ujęć (`end - start` klipu) i jest tym, co zamawia
żądanie oraz z czym walidator porównuje odpowiedź. Model renderuje węższy zakres, niż
dopuszcza etap 3 (`maxClipSeconds` to 1–60). Klip o długości, której model nie renderuje,
jest **odmową przed wysyłką**, nigdy zaokrągleniem: plan zatwierdził człowiek, a narzędzie,
które po cichu zamówiłoby inną długość, zmieniłoby czas filmu bez niczyjej zgody. Komunikat
wskazuje poprawkę tam, gdzie ona należy: `maxClipSeconds` odcinka i przeplanowanie
etapu 3. To ta sama odmowa, którą `frameSize` stosuje do proporcji, których żaden tor nie
renderuje.

Kadr wideo nie jest osobną decyzją: klip dziedziczy proporcje po swojej pierwszej klatce,
a ta jest rysowana w kadrze filmu z `aspectRatio`. Rozdzielczość to najwyższy poziom, jaki
model oferuje; rozdzielczości oddanej tutaj nie odzyska się w montażu.

**Dźwięk nie jest generowany.** Ścieżka dźwiękowa odcinka jest ciągła przez cięcia, więc
należy do etapu **poniżej montażu**; model, który słyszy jeden klip naraz, nie ma jak jej
zrobić. Pole `generate_audio` domyślnie jest włączone u dostawcy, więc cisza jest proszona
jawnie. Nie jest to etap 8: montaż sklejający obraz nie ma czym napisać narracji, nie ma
ani jej tekstu, ani promptu, bo `prompts/**` to jeden plik na jedno przyszłe płatne
wywołanie i żaden z czterech rodzajów nie dotyczy dźwięku. Etap 8 wytwarza natomiast oś
czasu, wobec której ścieżkę w ogóle da się napisać, więc dźwięk jest wierszem **po nim**.

### Model i klucz

`--video-model <id>`, a bez tej flagi `AIMATOR_VIDEO_MODEL`, czyli **jedna zmienna na oba
tory**, w odróżnieniu od modeli obrazowych. Reguła „jedna zmienna na tor" istnieje dlatego,
że dwa tory są *rysowane* obok siebie dwoma różnymi modelami obrazu; klip nie jest
rysowany, tylko renderowany z klatki, którą ten tor już wyprodukował. Osią jest więc
miejsce wywołania, jak przy każdym etapie tekstowym, a tory nadal się różnią w jedyny
sposób, który tu cokolwiek znaczy: klip zaczyna się na klatce swojego toru. Klucz wideo to
`BYTEPLUS_MODELARK` na obu torach, również na gpt-image.

Klatki wejściowe rysuje ten sam model obrazowy co referencje i klatkę otwarcia:
`--image-model <id>`, a bez flagi `AIMATOR_IMAGE_MODEL_<TOR>`. Inny model dla klatki
wejściowej znaczyłby inną kreskę w środku jednego toru. Samo `--model` jest odmową: dwa
płatne miejsca wywołania to dwie flagi, a flaga, która nie mówi, o który model chodzi, jest
gorsza niż jej brak.

### Zadanie asynchroniczne, czyli nowy rodzaj wznowienia

Wideo nie wraca w odpowiedzi na POST, wraca identyfikator zadania. Dlatego `submitted`
zapisuje się **przed** POST-em, jak wszędzie, a `jobId` dopisuje się w chwili, gdy
istnieje: **przed pierwszym odpytaniem**. Od tego momentu przerwana próba jest próbą, którą
da się dokończyć pytaniem, a nie kupić drugi raz. Odpytywanie nie jest ponawianiem: zadanie
jest już opłacone i renderuje się po stronie dostawcy.

Zadanie, które dostawca oznaczył jako nieudane, nie zostało wyrenderowane ani rozliczone;
wolno więc uruchomić nowe zwykłym przebiegiem, bez `--regenerate`; wymaganie flagi robiłoby
z odmowy zakup. Przekroczenie czasu oczekiwania (trzydzieści minut) też nie jest stratą:
rekord zachowuje `jobId`, a powtórzenie tego samego polecenia odbiera gotowy klip.

**Archiwum próby** trafia do `episodes/<id>/<tor>/runs/<runId>/`, tego samego, w którym
archiwizują etapy 5 i 6. Trzyma `prompt.md`, `request.json`, `response.json`,
`transport.json`, `run.json`, `validation.json`, `original.mp4` i `last-frame.png`.
`request.json` niesie prompt i ustawienia, ale **nigdy bajtów klatki**: ta jest wejściem,
identyfikowanym ścieżką i sha256. Poprzedni klip trafia do `previous.mp4` wyłącznie przy
`--regenerate`.

**`--republish` istnieje tutaj i dotyczy wyłącznie klipów.** Etapy 5 i 6 jej nie mają, bo
publikują dokładnie te bajty, które zwrócił dostawca. Ten etap dodatkowo **rozstrzyga**:
czym jest końcówka, która przyszła razem z klipem, i jak ma się nazywać. Pomyłka w tym
rozstrzygnięciu wychodzi na jaw po publikacji, przy rekordzie `completed`, a kontrakt mówi
wprost, że kupiona odpowiedź musi dać się ponownie wyprowadzić za darmo. `--republish
--artifact C01` publikuje więc klip jeszcze raz z `runs/<runId>/`, nie wysyłając niczego i
nie wymagając ani modelu, ani klucza; zachowuje `runId` i `producer`, bo to ta sama próba,
a ocena wraca do `pending`, bo pliki nie są tymi, które ktoś przyjął. Wymaga jawnego
`--artifact` i wyklucza się z `--regenerate`. Klatki wejściowej nie obejmuje: tam nie ma
czego naprawiać po stronie publikacji.

**Format końcówki wybiera dostawca, nie my.** ModelArk oddaje ostatnią klatkę jako JPEG,
więc plik nazywa się `end.jpg`, a `end.png` powstaje tylko wtedy, gdy dostawca odda PNG.
Przekodowanie jej byłoby przyjęciem jednego obrazu i dołączeniem innego, dlatego nazwa
idzie za bajtami, a nie odwrotnie. Z tego samego powodu identyfikator `end:Cnn` rozwiązuje
się przez **rekord klipu**, a nie przez zgadnięcie rozszerzenia.

**Walidacja jest czysta i offline**, jak wszędzie: czyta pudełka MP4 (`ftyp`, `moov`,
`mvhd`, `tkhd`) i sprawdza, czy klip trwa tyle, ile zamówił plan, i czy ma proporcje
odcinka. Klip w złej długości nie jest publikowany ani przycinany: rekord zostaje
`submitted`, odpowiedź zostaje w archiwum, a poprawka walidatora jest darmowa. Dzięki temu
`check` działa bez żadnego dekodera na maszynie.

### Seria, liczby i akceptacja

**Jedno polecenie kupuje wszystko, na co bramki pozwalają**, jedno płatne wywołanie naraz,
a seria zatrzymuje się na pierwszym błędzie z zachowaniem wcześniejszych wyników, jak
w etapie 5. Na łańcuchu jest tego zwykle niewiele: klip otwierający nową scenę nie
potrzebuje niczego od poprzednika, więc może powstać, kiedy wcześniejszy czeka na człowieka.
Raport podaje liczbę płatnych wywołań **osobno dla obrazów i dla wideo**, zanim cokolwiek
wyśle: klip jest najdroższą rzeczą, jaką ten potok kupuje, a podgląd ma pozwolić przeczytać
i tekst, i rachunek.

`--artifact C02` albo `--artifact entry:C02` zawęża przebieg. `--regenerate` **wymaga**
jawnego `--artifact`, i `approve` też, tu ostrzej niż w etapie 5: przyjęcie klipu otwiera
rysowanie następnej klatki wejściowej, a przyjęcie tej klatki kupuje następny klip.
Akceptacja, której nikt nie napisał, wydawałaby pieniądze, na które nikt się nie zgodził.

`aimator check <project-id> <episode-id> --stage clips --track <tor>` sprawdza to samo i nie
zapisuje niczego. Rozjazd wejścia unieważnia akceptację i `check` to zgłasza, a `approve`
przepisuje hashe wejść i zapisuje nową zgodę, jak wszędzie indziej.

## Etap 8: szczegóły

Ostatni wiersz obrazu, pierwszy etap, który **niczego nie kupuje**, i pierwszy, którego
bajty wytwarza program lokalny, a nie człowiek ani model. Konsumuje zatwierdzoną
`shot-list.md` i każdy klip, który ta lista planuje, **zatwierdzony na tym torze**, oraz
`project.json` i `episode.json`, z których czyta proporcje i zadeklarowany tryb dźwięku.
Produkuje `episodes/<id>/<tor>/episode.mp4`, obok niego `assembly.stage.json` z jednym
rekordem, i jedno cienkie archiwum w `runs/` tego toru.

**Nie konsumuje pakietu promptów.** Montaż nie niesie instrukcji do żadnego modelu, więc
zapisanie hasha bajtów, których nikt nie wysłał, opisywałoby pytanie, którego nie zadano;
ta sama zasada, dla której etap 3 nie czyta `source.md`.

### Planu montażowego nie ma jako pliku

Kontrakt wymieniał kiedyś `edit-plan.json` wśród wejść tego etapu i żaden etap go nie
pisał. Słusznie nie pisał: **wszystko, co ten plik mógłby nieść, jest już w zatwierdzonej
liście ujęć**: kolejność klipów, ich bezwzględne sekundy i zagwarantowane kafelkowanie
odcinka bez dziur. Drugi plik byłby `shot-list.json` pod inną nazwą, a etapy 3 i 4 odrzuciły
to dwukrotnie z tego samego powodu: dwa pliki opisujące jedną prawdę rozjeżdżają się przy
pierwszej ręcznej poprawce, a poprawiany jest ten, który człowiek czyta.

Reguła 7 jest tu spełniona, a nie naginana. Cięcie na styk między klipami, które kafelkują
bez dziur, jest **tym, co plan mówi**, a nie wartością domyślną podstawioną za odpowiedź,
której nikt nie dał. Przenikanie, plansza tytułowa albo przestawienie klipów **byłyby** nową
decyzją, i właśnie dlatego etap 8 ich nie podejmuje: nie ma pola, które by je niosło.
Jeśli plan montażowy jest zły, poprawka należy do etapu 3.

### Bramka: zatwierdzone klipy, i nic poza nimi

Sklejenie odmawia, dopóki każdy klip z listy ujęć nie ma na tym torze rekordu `completed`
z `review.status = "approved"` i zgodnym hashem. Ta jedna bramka obejmuje też etapy 0 i 1:
pliki projektu są zapisanymi wejściami listy ujęć, więc ich edycja unieważnia jej akceptację
arytmetycznie i montaż blokuje bez osobnej reguły.

**Klatek wejściowych ani końcówek bramka nie dotyka.** Klatka wejściowa jest już pierwszą
klatką swojego klipu, a końcówka była materiałem łańcucha etapu 7, nie kadrem filmu. Pytanie
o plik, którego ten etap nigdy nie otwiera, byłoby trzymaniem etapu zakładnikiem, tak samo
jak odmowa zatwierdzenia obsady, dopóki nie istnieje odcinek.

Zgoda wydana na jednym torze nie otwiera drugiego. Dwa tory to dwa filmy z jednej historii
i żaden z nich nie jest „odcinkiem".

### Dryf długości: skleja się to, co wróciło

Klipy nie wracają co do sekundy: renderer przy 24 klatkach zostawia ułamek, a walidator
etapu 7 przyjmuje odchyłkę **mniejszą niż sekunda** i publikuje klip w takiej długości, w
jakiej przyszedł: „zachowano oryginał, niczego nie przycinam". To są bajty, które przyjął
człowiek, więc przycięcie ich tutaj złożyłoby film z klatek, których nie przyjął nikt. To
dokładnie ten sam zarzut, którym etap 2 broni się przed wycinaniem tła, a etap 7 przed
przekodowaniem końcówki.

Dlatego montaż **melduje różnicę, zamiast ją korygować**: raport podaje sumę z planu, sumę
tego, co wróciło, i odchyłkę, per klip i łącznie. Werdykt na gotowym pliku porównuje go
z **sumą jego własnych klipów**, nigdy z `durationSeconds` odcinka; poprawne sklejenie
dryfujących klipów nie może się wywracać z powodu, którego niżej nikt nie naprawi.
Osobnego progu nie ma i nie będzie: cokolwiek odstawało o sekundę albo więcej, nie przeszło
już walidacji etapu 7.

### Czym to jest sklejone

**ffmpeg, znaleziony w `PATH` albo wskazany przez `AIMATOR_FFMPEG`, wywołany raz, ze
strumieniowym kopiowaniem (`-c copy`).** Bez przekodowania, bo klipy to bajty, które ktoś
przyjął; warunek konkatenacji (identyczne parametry strumienia) jest spełniony
z konstrukcji, bo oba tory renderują jednym modelem wideo w jednej rozdzielczości i jednym
tempie klatek. Gdzie nie jest spełniony, narzędzie odmawia; nigdy po cichu nie przechodzi
na przekodowanie.

**Brak ffmpeg jest odmową, nie objazdem.** Innej drogi nie ma: mikser napisany w tym
repozytorium byłby zapisywaczem kontenera, któremu trzeba by potem ufać, czyli tym, czego
etap 7 uniknął, czytając pudełka zamiast wołać dekoder. Odmowa pada razem z bramką, przed
jakimkolwiek zapisem, i nic nie kosztuje. Komunikat wskazuje poprawkę: zainstaluj albo
wskaż ścieżkę.

**`check` zostaje offline i bez ffmpeg.** Czyta pudełka `episode.mp4` tym samym czystym
werdyktem, którym etap 7 czyta klip, więc montaż da się zweryfikować na maszynie bez
jakichkolwiek narzędzi multimedialnych; po to ten czytnik pudełek w ogóle powstał.

### Etap, który niczego nie kupuje

`producer.kind` ma tu **trzecią wartość, `local`**, i nie jest to wygoda. Rekord pochodzenia
odpowiada na jedno pytanie: co trzeba by uruchomić ponownie, żeby dostać te bajty. Dla
`manual` odpowiedzią są decyzje człowieka, już zapisane w wynikach; dla `model` jest nią endpoint,
model i wersja promptu. Dla montażu odpowiedzią jest **silnik i jego wersja**: dwa wydania
miksera nie muszą zapisać tego samego kontenera z tych samych klipów, a rekord mówiący
`manual` czyniłby to nieodpowiadalnym z pliku, czyli dokładnie tę awarię, przed którą
`producer` powstał. Wersja ląduje w polu `model`, które czyta się jako „jaki silnik
wyprodukował te bajty"; `endpoint` i `promptVersion` zostają puste, jak przy `manual`.
`status` to `completed` z konstrukcji: rekord bez sieci jest ukończony w chwili zapisu.

**Archiwum próby jest najcieńsze w całym potoku i taka jest prawda o nim.** Nic nie zostało
wysłane, więc nie ma `request.json`, `response.json` ani `prompt.md`. `runs/<runId>/` trzyma
to, czego nie da się odtworzyć: `transport.json`, argv, zgłoszoną wersję silnika, kod
wyjścia i stderr, oraz `concat.txt`, czyli listę, którą mikser dostał. Do tego `run.json`
z wejściami przez ścieżkę i sha256 i `validation.json` z werdyktem tamtej chwili. Samego
cięcia archiwum nie kopiuje: jest czystą funkcją klipów, których hashe są zapisane, a
powtórzenie go nic nie kosztuje. Poprzedni odcinek trafia do `previous.mp4` wyłącznie przy
`--regenerate`, i to on jest wracany na miejsce, gdy nowe cięcie nie przejdzie walidacji.

**Zły montaż jest kasowany, nie zachowywany.** Etap 7 trzyma niepoprawny klip, bo ktoś za
niego zapłacił; tutaj ten sam plik powstaje ponownie za darmo, więc „nie publikuj" znaczy
„nie zostawiaj".

### Bramka wyjściowa, `--artifact` i co znaczy „ocena całości"

**`--artifact` nie jest wymagane nigdzie w tym etapie**, ani przy `assembly generate`, ani
przy `--regenerate`, ani przy `approve`. Flaga wymuszająca cel istnieje z dwóch powodów:
kandydatów jest wielu, więc gołe polecenie jest niejednoznaczne, albo akt otwiera bramkę,
która kosztuje. Tutaj nie zachodzi żaden: jeden klucz `episode` na tor i nic poniżej.
Napisana flaga jest nadal sprawdzana: `--artifact C01` to odmowa, nie ciche zignorowanie.

**`--regenerate` jest wymagane do ponownego cięcia, i tu broni czegoś innego niż wyżej.**
We wszystkich wcześniejszych etapach ta flaga chroniła portfel. Tutaj nic się nie kupuje, ale
gotowy montaż nosi zgodę człowieka, a ciche nadpisanie wycofałoby ją bez niczyjej decyzji.
„Nic nie ponawia się samo" obowiązuje także wtedy, gdy powtórzenie jest darmowe.

**„Ocena całości" nie jest powtórką ośmiu ocen klipów.** Tamte mówią, że każde ujęcie jest
dobre; ta mówi, że **te klipy, w tej kolejności, to jest film**. Trzy rzeczy istnieją
wyłącznie w całości i w żadnej części: rytm przez cięcia, ciągłość na szwach, łańcuch
etapu 7 gwarantuje, z czego klatka wejściowa została **narysowana**, a nie gdzie czternaście
sekund renderu faktycznie się skończyło, i rzeczywista długość filmu. To dwa poziomy oceny,
nie jeden powtórzony, dokładnie jak karta postaci nie jest implikowana przez osiem widoków.

`aimator approve <project-id> <episode-id> --stage assembly --track <tor>` zapisuje ją,
związaną z bajtami odcinka. `aimator check <project-id> <episode-id> --stage assembly
--track <tor>` sprawdza to samo i nie zapisuje niczego. Rozjazd wejścia (przerysowany klip)
unieważnia akceptację i `check` to zgłasza, a `approve` przepisuje hashe i zapisuje nową
zgodę: zabezpieczeniem nie jest tu parser, tylko człowiek, który obejrzy odcinek jeszcze raz.

### `episode.mp4` jest niemy, i mówi o tym wprost

Odcinek zapisał w etapie 0 tryb dźwięku, a żaden etap nie produkuje ścieżki. Montaż jest
więc **cięciem obrazu**, całością tego, co ten wiersz kontraktuje, a nie skończonym
filmem. Niespełniona deklaracja jest **raportowana, nie egzekwowana**, dokładnie jak brak
kanału alfa na torze seedream: `check` i raport z generacji mówią, że odcinek deklaruje
`audio: <tryb>`, a `episode.mp4` jest niemy. Dalej prowadzi etap 9, który jako jedyny może
tę ścieżkę napisać, wobec filmu, który już istnieje.

## Etap 9: szczegóły

Pierwszy etap, który kupuje od **dwóch dostawców**, i pierwszy, którego artefakty leżą na
**dwóch poziomach drzewa**. Konsumuje zatwierdzoną `shot-list.md`, zasady i decyzje
z `project.json`, `project.md` i `episode.json`, głos narratora z `project.json` oraz,
wyłącznie do miksu, zatwierdzony `<tor>/episode.mp4`.

**Nie konsumuje pakietu promptów ani scenariusza.** Narracja jest już w liście ujęć, a
zapisanie hasha bajtów, których nikt nie wysłał, opisywałoby pytanie, którego nie zadano;
ta sama zasada, dla której etap 3 nie czyta `source.md`, a etap 8 nie czyta manifestu.
Drugi egzemplarz tych samych zdań zapraszałby zresztą model do wybrania tej wersji, która
lepiej się czyta, czyli dokładnie do rozjazdu, jaki zawsze produkują dwa pliki opisujące
jedną prawdę.

### Narracja jest podnoszona, nie pisana, i walidator to sprawdza

Prompt etapu 1 mówi wprost: *„If speech is allowed, write it in `language`"*. Kiedy tryb
dźwięku dopuszcza mowę, **słowa narratora powstają w etapie 1**, a etap 3 przenosi je do
pola `Audio` każdego ujęcia. Nie istnieje natomiast żadna ich postać maszynowa: siedzą
w zdaniu, które opisuje też muzykę, deszcz i grzmot.

Wyciąganie ich parserem byłoby **parserem nad prozą**, tym, czego etap 3 odmówił, robiąc
wiązaniem identyfikator obsady zamiast imienia, a etap 4, wpisując graf do JSON-a zamiast
w zdania. Robi to więc model, bo czytanie prozy jest tym, do czego model służy, a
walidator udowadnia, że podniesienie było podniesieniem: **tekst każdej kwestii musi
wystąpić co do słowa w ujęciu, które ta kwestia nazywa.** Zdanie, którego lista ujęć nie
zawiera, nie przechodzi walidacji, choćby czytało się lepiej.

Reguła 7 jest tu spełniona, a nie naginana, dokładnie jak w sekcji „Kto nazywa referencje
nieosobowe" piętro wyżej: każda decyzja, z której ten skrypt powstaje, **jest** zapisana;
słowa w zatwierdzonym scenariuszu, okna w zatwierdzonej liście ujęć. Model dokłada to,
czego nie ma żaden zatwierdzony artefakt: identyfikator na wypowiedź i sekundę planu,
w której ta wypowiedź się zaczyna.

Jeśli narracja ma powiedzieć coś, czego w ujęciach nie ma, poprawka należy do **etapu 1**.
Komunikat odmowy mówi to wprost, zamiast po prostu odmówić.

### Słowa są wspólne, miks jest per tor

To jest precedens etapu 4 przeczytany co do joty. Manifest nazywa `hero:ewa`, a w jaki plik
to się zamienia, rozstrzyga dopiero wysyłający, per tor. Tutaj skrypt nazywa
`N02 @ 7 s planu`, a w jaki **timecode** to się zamienia, rozstrzyga dopiero mikser.

| co | gdzie | dlaczego |
|---|---|---|
| `narration.md` | pod odcinkiem, bez poziomu toru | słowa opisują historię, nie obrazy |
| `narration/Nnn.wav` | pod odcinkiem, bez poziomu toru | bajty zależą od tekstu, głosu i modelu mowy; żadne z tych trzech nie różni się per tor |
| `<tor>/narrated.mp4` | pod torem | jedyna rzecz, która wie, ile naprawdę trwa *ten* film |

Głos czytający zdanie nie wie, nad którym z dwóch filmów usiądzie, więc kupowanie go dwa
razy byłoby płaceniem za katalog. Precedens złamałby się dopiero wtedy, gdyby różniła się
**mowa**, a nie różni się.

**Etap 9 pisze więc plik stanu na dwóch poziomach**, i to nie jest wyjątek od reguły 1.
Brzmi ona „jeden plik na etap, **na tym poziomie katalogu, do którego etap pisze**", a etap
2 trzyma już po jednym `character.stage.json` na każdą parę (postać, tor). Etap 9 jest po
prostu pierwszym, który ma obie połowy niezmiennika 3 w jednym wierszu: tekstową wspólną
i medialną per tor. Klucz `mix:gpt-image` w pliku wspólnym byłby prefiksem nazwy zamiast
poziomu katalogu, czyli złamaniem reguły 2, a duplikowanie słów per tor byłoby dwiema wersjami
jednej prawdy.

### Głos jest obsadą, nie konfiguracją

`narratorVoiceId` mieszka w `project.json`, obok `characters` i `aspectRatio`, bez wartości
domyślnej, i **bramkuje wyłącznie etap 9**, jak `maxClipSeconds` bramkuje wyłącznie etap 3.

Rozstrzyga to test drugiego odcinka. W zmiennej środowiskowej odcinek 2 puszczony z innej
powłoki dostałby **innego lektora**, a na dysku nie byłoby pliku mówiącego, że ktokolwiek
to zdecydował, czyli co do joty awaria, przed którą powstała obsada. W `episode.json` seria
musiałaby odpowiadać na to pytanie raz na odcinek, a nic nie wiązałoby odpowiedzi ze sobą.

Model mowy to osobna sprawa i jest zmienną: `--voice-model <id>`, a bez flagi
`AIMATOR_VOICE_MODEL`, **jedna na oba tory**, z tego samego powodu co model wideo. Klucz to
`ELEVENLABS_API_KEY`. Skrypt podnosi osobny model tekstowy: `--model <id>` albo
`AIMATOR_NARRATION_MODEL`, bo dwa płatne miejsca wywołania to dwie flagi.

**Obsadzenie narratora po zatwierdzeniu listy ujęć jest rozjazdem wejścia**, bo
`project.json` jest zapisanym wejściem każdego etapu poniżej. To nie usterka, tylko ten sam
mechanizm, co przy edycji `project.md`: akceptacja wygasa, `approve` przepisuje hashe
i zapisuje nową zgodę. Głos obsadza się razem z obsadą, na początku serii.

### Sposób czytania jest reżyserią i ma własny plik

Głos to **obsada**; to, jak on gra, to **reżyseria**, i to są dwie różne decyzje. Reżyseria
mieszka w `projects/<id>/narration.json`, na poziomie projektu, bo sposób czytania powraca
między odcinkami tak samo jak obsada, ale **obok** `project.json`, nigdy w środku.

Powód jest mechaniczny, nie estetyczny. `project.json` jest zapisanym wejściem niemal
każdego artefaktu w potoku: w `dzielna-ewa` to ~89 rekordów, aż po zatwierdzony
`episode.mp4` obu torów. Suwak, który ma się kręcić, bo dobiera się go odsłuchem (w kilku
podejściach), unieważniałby przy każdym ruchu zgodę na bajty, których nie dotknął o ani
jeden bit. `narration.json` jest wejściem **wyłącznie kupionych nagrań**, więc zmiana
brzmienia unieważnia dokładnie to, co pod starym brzmieniem powstało.

To jest też odpowiedź na to, czemu pierwsze nagrania wyszły płaskie. Nie było wady
w żadnej linijce kodu, nie było **miejsca na decyzję**, więc każde wywołanie szło na
ustawieniach domyślnych dostawcy, a te brzmią `stability: 0.5`, `style: 0`, o których sam
dostawca pisze, że skłaniają się ku monotonii. Brak decyzji nie jest brakiem liczby.

| suwak | zakres | domyślnie | w którą stronę |
|---|---|---|---|
| `stability` | 0–1 | 0.5 | **niżej** = szerszy zakres emocji; wyżej = monotonnie |
| `style` | 0–1 | 0.0 | **wyżej** = mocniejszy charakter głosu |
| `speed` | 0.7–1.2 | 1.0 | poniżej 1 zwalnia czytanie |
| `similarity` | 0–1 | 0.75 | wyżej = bliżej oryginalnej próbki |
| `speaker-boost` | tak/nie | tak | |

Wartości domyślne **nie łamią reguły 7**. Reguła wiąże decyzje, które domyślnej nie mają,
a te pięć ma, i to udokumentowaną przez dostawcę, dokładnie jak `AIMATOR_FFMPEG`. Czego
etap nie robi, to milczeć: wysyła je **jawnie przy każdym wywołaniu**, żeby archiwum
żądania odpowiadało na pytanie, co wyprodukowało te bajty, zamiast odsyłać czytelnika do
tego, jakie akurat były wtedy domyślne u dostawcy.

Zapisuje je `aimator narration direction <id> [--stability n] [--style n] [--speed n]
[--similarity n] [--speaker-boost]`, scalając: `--stability` samo znaczy stability,
a nie „przywróć resztę do domyślnych".

### Sąsiedztwo kwestii jest wyprowadzane, nigdy zapisywane

Druga połowa tego, czemu pierwsze podejście brzmiało płasko: każda kwestia była kupowana
tak, jakby była jedynym zdaniem w filmie. Dostawca przyjmuje `previous_text` i `next_text`
jako kontekst, żeby zdanie kupione osobno zostało przeczytane jak część akapitu, i są to
**sąsiednie kwestie skryptu**, więc są wyprowadzane, nigdy zapisywane. To ta sama reguła 7
czytana od drugiej strony, co przy planie montażowym etapu 8.

Znaki kontekstu są liczone **obok** rachunku, nigdy w nim. Dostawca dokumentuje te dwa
parametry, ale nie mówi, czy je rozlicza; nic tu nie zgaduje cudzymi pieniędzmi, więc
podgląd podaje obie liczby osobno i mówi, która jest która.

`seed` jest wyprowadzany z **identyfikatora próby**, nie ze zdania. Odtworzenie zapisanej
próby ma prosić o to samo czytanie, a `--regenerate` istnieje dlatego, że komuś się nie
spodobało to, co przyszło, więc ziarno przywiązane do zdania sprzedałoby mu tę samą
interpretację drugi raz.

### Jednostką jest wypowiedź, a rachunek jest w znakach

Jedna kwestia to **ciągły odcinek mowy**, nie zdanie i nie scena. Dwa zdania wypowiedziane
pod rząd bez przerwy są jedną wypowiedzią, bo to jeden kawałek prozodii; dwa zdania
rozdzielone sekundami ciszy są dwiema.

Argument prozodyczny za grubszą jednostką tutaj nie istnieje: kwestie dzielą dziesiątki
sekund, przez które żadna fraza nie przechodzi. Zostają dwa argumenty za drobną, czyli ocena,
jak w etapie 5, gdzie zła interpretacja jednego zdania kosztuje ponowne kupienie samego
tego zdania, oraz umieszczenie: jedno wywołanie na cały odcinek oddałoby jeden blok, którego
nie da się położyć na czterech kotwicach.

**Liczba wywołań przestała tu być rachunkiem.** ElevenLabs rozlicza **znaki wejścia**, więc
podgląd podaje jedno i drugie, per wypowiedź i łącznie, zanim cokolwiek wyśle. Tak samo
jak etap 7 musiał podać obrazy i wideo osobno, bo jedna liczba kłamała. Ceny nie podaje:
tego potok nie robi nigdzie.

Jeden `narration.md` zamiast jednego pliku na wywołanie, i to nie jest złamanie reguły
etapu 4. Tamta broni przed **krojeniem prozy parserem**; skrypt prozą nie jest, tylko listą
z gramatyką nagłówka `### N02 | U02 | 7s`, walidowaną ściśle, czyli kształtem **listy
ujęć**, nie pakietu promptów. Cztery pliki po jednym zdaniu byłyby płytkim modułem.

### Synchronizacja: bajty jak w etapie 8, umieszczenie jak w etapie 7

Oba precedensy obowiązują, każdy w swojej połowie, i to nie jest unik: etapy 7 i 8
rozróżniają dokładnie to samo, tylko każdy widzi jedną stronę.

**Bajtami rządzi etap 8.** Publikuje się to, co wróciło: żadnego rozciągania czasu, zmiany
tempa czytania ani skracania pauzy. To byłyby „bajty, których nie przyjął nikt", ten sam
zarzut, którym etap 2 broni się przed wycinaniem tła, a etap 7 przed przekodowaniem
końcówki.

**Umieszczeniem rządzi etap 7.** Kotwica pochodzi z planu, który zatwierdził człowiek, więc
narzędzie jej po cichu nie przesuwa. Odmowa, nie zaokrąglenie, gdy kwestia nachodzi na
początek następnej albo wychodzi poza koniec filmu; komunikat wskazuje poprawkę: skróć
zdanie w skrypcie i przyjmij je ponownie, albo przeplanuj etap 1.

Różnica wobec etapu 7 jest jedna: tam długość była znana **przed** zapłatą i dało się
odmówić przed POST-em. Tutaj poznaje się ją dopiero z bajtów, więc odmowa pada **przy
miksie**. Rekord zostaje `completed`, nagrania zostają, a ponowny miks po poprawce jest
darmowy, dokładnie jak etap 8 mówi o niepoprawnym cięciu.

**Kotwica z planu nie jest sekundą filmu.** Klipy wróciły dłuższe, niż je zamówiono, więc
7 s planu to nie 7 s tego toru. Mikser mapuje jedno na drugie przez same klipy. To ta sama
arytmetyka, którą etap 8 melduje jako dryf, przeczytana w drugą stronę, i **melduje
przesunięcie**, zamiast je ukrywać.

### Czym miksuje, co zapisuje `producer`, i dlaczego `check` zostaje offline

`lib/muxer` to ten sam ffmpeg, którym tnie etap 8: **drugi wołający, więc promocja**.
`AGENTS.md` zapowiadał ją przy wołającym, nie przy zgadywaniu. Moduł wystawia operacje
(`version`, `concat`, `mix`), nigdy procesu: `run(args)` byłby poszerzeniem interfejsu,
przed którym ten moduł istnieje.

**Obraz idzie kopią strumieniową.** `narrated.mp4` to nowy plik, którego strumień wideo jest
strumieniem `episode.mp4`, klatka w klatkę. Zatwierdzony montaż nie jest ani nadpisywany,
ani przekodowywany, więc zgoda wydana etapowi 8 zostaje tam, gdzie była. Dźwięk jest jedyną
rzeczą, którą ten moduł koduje, i tylko tutaj: MP4 nie niesie WAV-a, więc mowa jest
kodowana dokładnie raz, do pliku, który ktoś zaraz przyjmie, a bezstratne kwestie zostają
na dysku jako bajty, które kupiono.

**Trzy rodzaje pochodzenia w jednym etapie to trzy rekordy, nie jeden.** `producer` należy
do artefaktu, nie do etapu; etap 7 ma już dwa media w jednym pliku stanu:

| artefakt | `producer.kind` | `model` |
|---|---|---|
| `script` | `model` | model tekstowy, z `promptVersion` |
| `N01`…`Nnn` | `model` | `<model> / voice <voiceId>` |
| `narrated` | `local` | `ffmpeg <wersja>` |

Schemat `producer` nie wymagał nowej wartości. Identyfikator głosu ląduje w `model` obok
identyfikatora modelu, bo to pole odpowiada na „co trzeba by uruchomić ponownie, żeby dostać
te bajty", a dla mowy odpowiedzią jest model **i** głos. `promptVersion` przy TTS zostaje
`null`: nie ma tam naszej instrukcji, jest cudze zdanie jadące dosłownie, a numer wersji na
czyimś zdaniu byłby twierdzeniem o autorstwie, nie zapisem pochodzenia.

**Format kupowanej mowy to `wav_24000`, i to jest rozstrzygnięcie, nie preferencja.**
Domyślny MP3 podaje swoją długość tylko temu, kto przejdzie po jego ramkach, licząc je wobec
tablicy bitrate'ów i ufając, że strumień jest stały. WAV podaje częstotliwość, kanały
i rozmiar bloku danych w dwudziestu czterech bajtach przy początku, więc długość kupionej
kwestii jest arytmetyką. Etap 7 czytał pudełka MP4 zamiast wołać dekoder dokładnie z tego
powodu, wybór kontenera jest tym samym wyborem, o krok wcześniej. Format jest stałą miejsca
wywołania, jak endpoint, a nie decyzją.

`check` zostaje więc offline i bez ffmpeg, jak wszędzie: kwestie czyta nagłówkiem RIFF,
a `narrated.mp4` tym samym czytnikiem pudełek, którym etap 8 czyta `episode.mp4`,
sprawdzając przy okazji, że plik naprawdę niesie ścieżkę dźwiękową.

### Dwie oceny, bo dwa poziomy

**Ocena wspólna** dotyczy słów i głosów: czy ten skrypt mówi to, co mówi zatwierdzony plan,
i czy to czytanie brzmi jak narrator tej serii. Zapada raz, bo odpowiedź nie zależy od tego,
nad którym filmem kwestia usiądzie. `--artifact` jest tu **wymagane**, ostrzej niż
w etapie 5: przyjęcie skryptu uruchamia kupowanie każdego zdania w nim, a przyjęcie kwestii
otwiera miks.

**Ocena odsłuchu** jest per tor i nie da się jej wydać nigdzie indziej: czy narrator trafia
we właściwe miejsce nad **tym** obrazem. Nie jest powtórką ocen kwestii: kwestia przeczytana
bez zarzutu wciąż może wejść dwie sekundy za późno, dokładnie jak ocena całości w etapie 8
nie jest powtórką ośmiu ocen klipów. `--artifact` nie jest tu wymagane: jeden artefakt na
tor i nic poniżej, co przyjęcie mogłoby kupić.

### Czego ten etap nie domyka

Wszystkie cztery tryby dźwięku **zawierają muzykę i efekty**. Etap 9 produkuje samą
narrację, więc deklaracji nie domyka, i mówi o tym przy każdej generacji i przy każdym
`check`, dokładnie jak etap 8 melduje ciszę, a etap 2 brak kanału alfa. **Raportowane, nie
egzekwowane**: plik jest całością tego, co ten wiersz kontraktuje, a film wciąż nie jest
skończony. Dalej prowadzi etap 10, który muzykę i efekty kupuje.

## Etap 10: szczegóły

Pierwszy etap, który **przepisał własny wiersz kontraktu**, i jedyny, którego werdykt nie
potrafi udowodnić, że jego wynik mówi prawdę o wejściu. Obie te rzeczy są rozstrzygnięciami,
nie niedoróbkami, i obie są tutaj opisane.

Konsumuje zatwierdzoną `shot-list.md`, zasady i decyzje z `project.json`, `project.md`
i `episode.json`, poziomy z `mix.json` oraz, wyłącznie do miksu, zatwierdzony
`<tor>/episode.mp4`, zatwierdzony `<tor>/narrated.mp4` i przyjęte kwestie etapu 9.

**Nie konsumuje pakietu promptów ani scenariusza**, z tego samego powodu co etap 9:
zapisanie hasza bajtów, których nikt nie wysłał, opisywałoby pytanie, którego nie zadano.

### Czego nie ma i co stoi w tym miejscu

Etap 9 udowadnia uczciwość swojego skryptu mechanicznie: kwestia jest **podnoszona, nigdy
pisana**, a walidator znajduje każde zdanie co do słowa w ujęciu, które je nazywa. **Tutaj
jest to niemożliwe i potok tego nie udaje.**

Sprzeczność jest prawdziwa i wynika z reguły 9. Prompt muzyczny jest **instrukcją**, więc
reguła 9 każe pisać go po angielsku. Pole `Audio`, z którego on powstaje, jest
**materiałem**, po polsku, a reguła 9 zabrania go tłumaczyć. Przepisanie jest więc
zakazane z obu stron i nie ma czego szukać dosłownie.

Precedensem nie jest etap 9, tylko **etap 4**. Tamten też pisze angielskie instrukcje
z polskiej listy ujęć, też wysyła jedno obok drugiego w dwujęzycznym żądaniu, i też ocenia
własną odpowiedź werdyktem, który **nigdy nie czyta promptu**, tylko okablowanie wokół
niego. Etap 10 bierze tę samą umowę:

| co udowadnia walidator | co zostaje człowiekowi |
|---|---|
| każdy cue nazywa ujęcia, które istnieją | czy angielski opisuje polską prozę |
| **zadeklarowane ujęcia cue to dokładnie te, które leżą w jego sekundach** | czy to jest dobra muzyka |
| podkład kafelkuje film od 0 do końca planu, bez dziur i zakładek | |
| każda długość jest taka, jaką dostawca zrenderuje | |

Drugi wiersz niesie ciężar, który piętro wyżej niesie „podnoszone, nie pisane". Wierności
nie dowodzi; dowodzi, że model przeszedł **cały plan**: ujęcie pominięte i ujęcie wymyślone
wychodzą tak samo, jako rozjazd między tym, co cue deklaruje, a tym, co naprawdę leży w jego
sekundach.

**Reguły 9 nic tu nie egzekwuje i to jest precedens, a nie niedopatrzenie.** Instrukcja każe
odpowiadać po angielsku, dokładnie jak instrukcja etapu 4, a walidator etapu 4 też języka
nie sprawdza; to on ustanowił zasadę „nigdy nie czyta promptu". Sprawdzian był napisany
i został usunięty: jedyny tani test to litery języka filmu, a polskie zdanie potrafi nie
mieć ani jednej z nich; *„Delikatny instrumentalny motyw wieczorny"* nie ma. Strażnik,
który przepuszcza wklejony polski i odrzuca uczciwy angielski cytujący nazwę, jest gorszy
niż człowiek czytający arkusz, zanim kupi się choć sekundę dźwięku.

### Jednostka, rachunek i sprzeczność w cenniku dostawcy

Cennik ElevenLabs mówi na jednej stronie dwie rzeczy, które wyglądają na sprzeczne: tabela
stawek podaje cenę **za minutę** dla Music i dla Sound Effects, a FAQ pod nią mówi, że oba
są rozliczane **„per generation"**. Sprzeczności nie ma: to są odpowiedzi na dwa różne
pytania. Tabela podaje jednostkę **stawki**: sekundy wygenerowanego dźwięku. FAQ podaje
**moment naliczenia**: opłata pada przy żądaniu, nie przy pobraniu. Praktyczny wniosek jest
jeden i twardy: **`--regenerate` to druga pełna opłata, nie dopłata**, i raport mówi to
tam, gdzie ktoś to przeczyta.

**Liczba wywołań przestała tu być rachunkiem, drugi raz w potoku i z innego powodu niż
w etapie 9.** Tam rachunek był w znakach wejścia; tutaj jest w sekundach wyjścia. Jedno
wywołanie na trzydziestosekundowy podkład i jedno na półsekundowy trzask to ta sama liczba
i nic podobnego do tej samej kwoty. Podgląd podaje więc **wywołania i sekundy**, per cue
i łącznie. Cen nie podaje: tego potok nie robi nigdzie.

**Jednostką podkładu jest odcinek, a jednostką efektu zdarzenie.** Dwa osobno wygenerowane
utwory zestawione na styk nie dzielą tonacji ani tempa, więc podkład jest jednym
wywołaniem; to argument prozodyczny, którego etap 9 **nie** miał i wprost tego nie ukrywał.
Efekt jest kupowany pojedynczo, bo zła interpretacja jednego grzmotu ma kosztować jeden
grzmot; argument etapu 5.

Podkład zamawia się **prozą**, nie planem kompozycyjnym. Prompt w tym potoku jest prozą
wszędzie indziej, a lista list stylów byłaby JSON-em stojącym tam, gdzie należą zdania:
czyli tym, czego etap 4 odmówił.

### Stemy są wspólne, miks jest per tor

Precedens etapu 9 przeczytany co do joty. Podkład nie wie, nad którym z dwóch filmów
usiądzie, a różnią się one tylko dryfem, z jakim wróciły klipy, więc kupowanie dwa razy
byłoby płaceniem za katalog.

| co | gdzie | dlaczego |
|---|---|---|
| `sound-design.md` | pod odcinkiem, bez poziomu toru | arkusz opisuje historię, nie obrazy |
| `sound/Mnn.mp3`, `sound/Enn.mp3` | pod odcinkiem, bez poziomu toru | bajty zależą od cue, modelu i zamówionej długości; żadne z tych trzech nie różni się per tor |
| `<tor>/mixed.mp4` | pod torem | jedyna rzecz, która wie, ile naprawdę trwa *ten* film |

### Skąd się miksuje, i co się dzieje ze zgodą na `narrated.mp4`

**Etap 10 nie miksuje na `narrated.mp4`. Składa od nowa** z `episode.mp4` i stemów: obraz
idzie kopią strumieniową, mowa bierze się z bezstratnych `narration/Nnn.wav`, a wszystko
koduje się **dokładnie raz**, do pliku, który ktoś zaraz przyjmie. Miksowanie na narracji
kodowałoby mowę po raz drugi, i, co gorsza, czyniłoby ducking nieuczciwym, bo głos byłby
już w sygnale, pod który muzyka ma ustępować.

**Ze zgodą na `narrated.mp4` nie dzieje się nic, i to jest powiedziane wprost.** Plik nie
jest nadpisywany, przekodowywany ani unieważniany, a zgoda dalej znaczy to, co znaczyła:
narrator trafia we właściwe miejsce nad tym obrazem. Staje się **przyjętym produktem
pośrednim**, jedynym miejscem w całym potoku, w którym umieszczenie narracji słychać bez
muzyki w drodze.

I to jest odpowiedź na zarzut, który sam się nasuwa: etap 8 nazywa „trzymaniem etapu
zakładnikiem" bramkę na pliku, którego etap nigdy nie otwiera. Etap 10 faktycznie nie
otwiera tych bajtów. Czyta **zgodę** na nie, a ta zgoda jest jedynym dowodem, że narracja
siedzi tam, gdzie ma siedzieć nad *tym* filmem. Etap 10 ten fakt wykorzystuje, zamiast
ustalać go po raz drugi. Bramka na klatce wejściowej w etapie 8 nie miała takiego dowodu za
sobą; ta ma.

### Poziomy i ducking

**Ducking nie jest decyzją przechowywaną.** Odcinek, którego tryb niesie mowę, już
zadecydował, że głos jest na pierwszym planie; muzyka, która pod niego nie ustępuje, nie
jest „muzyką i narracją", tylko dwiema rzeczami naraz. Sidechain jest więc **wyprowadzany**
z trybu, tak samo jak `force_instrumental`.

**Ile ustępuje, jest decyzją.** Poziom podkładu, poziom efektów, głębokość duckingu i czas powrotu
mieszkają w `projects/<id>/mix.json`, na poziomie projektu, bo brzmienie serii powraca
między odcinkami tak samo jak obsada i sposób czytania.

Nie w `project.json`, z powodu `narration.json`: plik etapu 0 jest zapisanym wejściem
niemal wszystkiego, więc suwak unieważniałby zgody na bajty, których nie dotknął. I, co jest
subtelniejszą połową, **nie w `narration.json`**: tamten jest zapisanym wejściem *kupionych
nagrań*, a to, jak głośno pod nimi siedzi podkład, nie mówi nic o tym, jak zostały
przeczytane. Zmiana miksu nie może unieważniać nagrania. Dwa suwaki, dwa zasięgi, dwa pliki.

**Wartości startowe są i wymagają osobnego uzasadnienia**, bo tego, którym broni się
`narration.json`, tu nie ma: tam domyślne są udokumentowane przez dostawcę, a tutaj nie ma
dostawcy. Uzasadnienie jest inne i mocniejsze: **tej decyzji nie da się podjąć, zanim się ją
usłyszy.** Odmowa przed pierwszym miksem żądałaby odpowiedzi, której człowiek nie ma jak
uformować, a miks nic nie kosztuje i powtórzenie jest darmowe. Jak przy reżyserii, wartości
jadą do silnika **jawnie** przy każdym wywołaniu i lądują w archiwum, więc plik odpowiada,
co wyprodukowało te bajty.

### Werdykt offline, i co dokładnie tracimy

Etap 9 czytał długość kwestii z dwudziestu czterech bajtów nagłówka RIFF, bo sam wybrał
kontener. **Tutaj tego wyboru nie ma.** Ani `/v1/music`, ani `/v1/sound-generation` nie
oferują WAV-a, udokumentowany enum to MP3, surowy PCM, µ-law, A-law i Opus. PCM byłby
bezstratny, ale **nie niesie żadnego nagłówka**: częstotliwość znalibyśmy z nazwy formatu,
liczby kanałów nie, a pomyłka podaje długość dwukrotnie złą i nie mówi o tym ani słowa.

Stemy kupuje się więc w **MP3**, a werdykt **przechodzi po ramkach**. Zarzut, którym etap 9
odrzucił MP3, że długość zna tylko ten, kto liczy ramki „wobec tablicy bitrate'ów, ufając,
że strumień jest stały", zostaje odpowiedziany przez to, że się nie ufa: każdy nagłówek
ramki sam deklaruje swój bitrate, swoją częstotliwość i tryb kanałów, więc strumień
zmienny czyta się tak samo dokładnie jak stały. To ten sam wybór, co czytanie pudełek MP4
w etapie 7, i kosztuje około stu linii zamiast dwudziestu czterech bajtów. **Koszt jest
realny i dlatego jest tu napisany.**

`check` zostaje offline i bez ffmpeg, jak wszędzie: stemy czyta ramkami, a `mixed.mp4` tym
samym czytnikiem pudełek, którym etap 8 czyta `episode.mp4`, sprawdzając przy okazji, że
plik naprawdę niesie ścieżkę dźwiękową.

### Odmowa i meldunek: dwie różne rzeczy

**Efekt, który wychodzi poza koniec filmu, jest odmową.** To precedens etapu 7 i 9: gdzie
dźwięk siedzi, wynika z planu, który zatwierdził człowiek, więc narzędzie po cichu tego nie
przesuwa. Odmowa nic nie kosztuje, stemy zostają kupione, a ponowny miks po poprawce jest
darmowy.

**Podkład, który kończy się przed filmem, jest meldunkiem.** To precedens etapu 8: klipy
wróciły dłuższe, niż je zamówiono, więc podkład kupiony na długość planu kończy się ułamek
sekundy przed obrazem. To dziura, nie zderzenie, a odmowa z powodu, którego nikt niżej nie
naprawi, byłaby odmową bez wyjścia. Cisza na końcu jest ciszą, którą da się usłyszeć
i o której da się zdecydować.

**Efekty mogą na siebie nachodzić**, dwie rzeczy mogą dziać się naraz, a tylko narrator nie
może mówić sam przez siebie.

### Trzy rodzaje pochodzenia, tak jak w etapie 9

| artefakt | `producer.kind` | `model` |
|---|---|---|
| `cues` | `model` | model tekstowy, z `promptVersion` |
| `M01`…`Enn` | `model` | model muzyczny albo efektowy |
| `mixed` | `local` | `ffmpeg <wersja>` |

`promptVersion` przy stemach zostaje `null`, i wygląda to na odwrotność etapu 9, więc warto
powiedzieć wprost dlaczego. Tam tekstem było cudze zdanie jadące dosłownie. Tutaj tekst
**jest** instrukcją, ale nie naszą stałą: to cue, które ktoś przyjął w `sound-design.md`,
a na pytanie „która instrukcja wyprodukowała te bajty" odpowiada hash tego pliku, zapisany
wśród wejść. Numer wersji wskazywałby nie ten dokument.

### Dwie oceny, bo dwa poziomy

**Ocena wspólna** dotyczy dźwięku jako takiego: czy ten arkusz opisuje to, co opisuje
zatwierdzony plan, i czy to, co wróciło, brzmi jak ta seria. Zapada raz, bo odpowiedź nie
zależy od tego, nad którym filmem podkład usiądzie. `--artifact` jest **wymagane**, jak
w etapie 9 i z jedną krawędzią więcej: przyjęcie arkusza uruchamia kupowanie każdego cue,
przyjęcie stemu otwiera miks, a druga próba u tego dostawcy kosztuje pełną cenę jeszcze raz.

**Ocena odsłuchu** jest per tor i nie da się jej wydać nigdzie indziej: czy całość gra nad
**tym** obrazem. Nie jest powtórką ocen stemów: podkład piękny sam w sobie wciąż może bić
się z narratorem, a tylko ten plik ma oba naraz. `--artifact` nie jest tu wymagane: jeden
artefakt na tor i nic poniżej, co przyjęcie mogłoby kupić.

### Czego ten etap nie domyka

Po etapie 10 tryby `music-and-effects` i `narration` są **domknięte**: to dokładnie to, co
etapy 9 i 10 produkują między sobą. `dialogue` i `dialogue-and-narration` nie są:
**mowy postaci nie wytwarza dziś żaden etap tego potoku i po tym etapie nadal nie będzie.**
Raportowane, nie egzekwowane, jak wszędzie. Dalej prowadzi zadeklarowany wiersz 11.
