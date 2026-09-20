# Skille Claude Code w tym repo

Repo dostarcza skille Claude Code w `.claude/skills/` — dla tych fragmentów pracy, których
reguły warto mieć zapisane raz, zamiast powtarzać je w każdej rozmowie.

## Dostępne skille

| Skill | Polecenie | Do czego służy |
|-------|-----------|----------------|
| Develop Series | `/develop-series` | Doprowadza mglisty pomysł do stanu, w którym da się odpowiedzieć na pytania etapu 0 |
| Prepare Project | `/prepare-project` | Prowadzi etap 0 — zbiera decyzje kreatywne i zapisuje artefakty, które konsumuje etap 1 |
| Environment Variables | `/environment-variables` | Dodaje i waliduje zmienne środowiskowe |
| Bugfix | `/bugfix` | Odtwarza zgłoszony błąd w czerwonym teście, zanim cokolwiek naprawi |

## Develop Series

```
/develop-series
```

[Etap 0](docs/stages/00-przygotowanie.md) zakłada, że wiesz już, czym jest Twoja seria. Ta
sesja jest mostem od „mam pomysł" do odpowiedzi: premisa, świat, ton, odbiorca, bohater,
styl wizualny, proporcje obrazu. Jedno pytanie naraz, prowadzenie zamiast przesłuchania —
to Twój materiał kreatywny, a gust nie musi się tłumaczyć.

Skill niczego nie zapisuje. Kończy przekazaniem decyzji do `/prepare-project`, który ma
monopol na zapis — dwa miejsca, w których mieszkają decyzje kreatywne, to o jedno za dużo.

Użyteczny, a nie gadatliwy, robią go dwie granice:

- **Nie opracowuje fabuły odcinka.** Robi to [etap 1](docs/stages/01-scenariusz.md), z pliku
  źródłowego. Gdyby fabuła powstała w rozmowie, główna reguła potoku — każdy etap konsumuje
  artefakt, nigdy czatu — pękłaby na pierwszym kroku.
- **Jest łagodnie natarczywy w trzech sprawach**: styl wizualny i stały wygląd bohatera, bo
  z nich powstają prompty obrazowe, a model czyta „ładny, klimatyczny" jako nic i za każdym
  razem wypełnia tę lukę inaczej; proporcje obrazu, które nie mają wartości domyślnej i nie
  dają się zmienić, gdy obrazy już istnieją; oraz to, skąd w ogóle bierze się wygląd postaci.

Ostatnia z nich decyduje o długości sesji. Odpowiedź „ze zdjęć" znaczy, że etap postaci
zacznie od tych plików. Odpowiedź „z opisu" znaczy, że w całym potoku nie istnieje żadna
fotografia, więc wygląd każdej postaci trzeba napisać właśnie tutaj.

Tak czy inaczej skill prowadzi bieżącą listę każdej powracającej postaci, przedmiotu
i miejsca, które wypłyną w rozmowie, i nie przekaże pracy dalej, dopóki któraś pozycja jest
nazwana, ale nieopisana — nazwanie to inwentarz, nie wygląd. Lista jest tym, co wyprodukował
Twój wywiad, nigdy stałą checklistą: zdjęcie utrwala twarz, ale nigdy przedmiotu ani pokoju,
więc te potrzebują prozy w obu wariantach. Granicą jest powracalność — to, co w siódmym
odcinku musi wyglądać identycznie, należy do zasad projektu, a lokacje odcinka, przedmioty
jednorazowe i ujęcia zostają przy późniejszych etapach, które wyprowadzają je ze scenariusza.

Pomiń ten skill, jeśli umiesz już odpowiedzieć na te pytania. Wywiad z kimś, kto zdecydował,
zaprasza go do podważania dobrych instynktów.

## Prepare Project

```
/prepare-project
```

[Etap 0](docs/stages/00-przygotowanie.md) jest rozmową, nie generacją, i jedynym miejscem,
którym decyzje kreatywne wchodzą do systemu. Skill jest właścicielem tego wywiadu:
streszcza, co jest już zatwierdzone, pyta wyłącznie o to, czego brakuje, oznacza własne
pomysły jako propozycje i odmawia zapisania decyzji, której nikt nie podjął.

Sens jest w podziale, który skill egzekwuje. Ręcznie piszesz dokładnie jeden plik —
`project.md`, wspólne zasady serii. Wszystko mechaniczne jest wywołaniem CLI: katalogi,
kopia bajtowa Twojego źródła odcinka, hashe, schemat, unikalność numeru odcinka i bramka
gotowości. Właśnie dlatego `aimator check` można ufać: nic, co sprawdza, nie zostało
wklepane ręcznie.

Kończy się na `aimator approve`, które celowo nie jest tym samym co `aimator check`.
`check` pyta, czy pliki się trzymają kupy; `approve` jest miejscem, w którym człowiek mówi,
że je przyjmuje. Odmawia wszystkiego, co `check` odrzuca, i wiąże decyzję z bajtami w takim
kształcie, w jakim leżą — włącznie z `project.md`, który dostaje swój hash dokładnie w tej
chwili i w żadnej wcześniejszej. Edytuj zatwierdzony artefakt później, a akceptacja znika,
i `check` to powie.

Żadne polecenie etapu 0 nie woła płatnego API.

## Environment Variables

```
/environment-variables
```

Kiedy potrzebujesz nowej zmiennej środowiskowej, skill przeprowadza przez trzy kroki:

1. Dodanie schematu Zod w `src/lib/env.ts` — `client`, `server` albo `shared`
2. Umieszczenie wartości w `.env` (wartości domyślne) albo `.env.local` (sekrety)
3. Dopisanie testu walidacji w `src/lib/env.test.ts`

Postawi też `@t3-oss/env-core` + Zod od zera, jeśli `src/lib/env.ts` jeszcze nie istnieje.

Kontekst całej konfiguracji — które zmienne istnieją i dlaczego jest ich tyle — jest
w [docs/konfiguracja.md](docs/konfiguracja.md).

### Przykład

```
/environment-variables
> „Potrzebuję WEATHER_API_KEY do klienta pogody"
> Claude dodaje schemat, wkłada sekret do .env.local i pisze test
```

## Bugfix

```
/bugfix
```

Uruchamia się sam, kiedy zgłaszasz, że coś jest zepsute. Wymusza jedną kolejność:

1. Odtworzenie błędu w czerwonym teście — jeszcze bez zmian w implementacji
2. Pokazanie Ci czerwonego testu i proponowanej poprawki, a potem czekanie na zgodę
3. Naprawa, po której test przechodzi
4. Pełna seria testów, żeby potwierdzić, że nic innego nie padło

Sensem kroku 1 jest falsyfikowalność. Test napisany *po* poprawce dowodzi, że kod robi to,
co przed chwilą napisano; test napisany *przed* dowodzi, że błąd naprawdę został odtworzony.
Jeśli ten pierwszy test od razu przechodzi, błąd nie został odtworzony, a diagnoza jest zła —
i skill zatrzymuje się w tym miejscu, zamiast pozwolić Ci naprawiać nie to, co trzeba.

## Cała reszta

Reszta pracy to zwykły Claude Code, bez żadnego skilla:

- **Planowanie** — opisz, co chcesz zbudować, i poproś, żeby najpierw rozpoznał kod
- **Implementacja** — TDD pionowymi plastrami: jeden czerwony test, minimalny kod, refaktor,
  od nowa
- **Commit** — powiedz `commit this` albo użyj wbudowanego `/commit`

Pełny proces produkcyjny opisuje [README.md](README.md), a kontrakt etapów —
[docs/pipeline.md](docs/pipeline.md).
