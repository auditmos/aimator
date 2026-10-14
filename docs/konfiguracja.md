# Konfiguracja

## Katalog roboczy

Artefakty leżą **poza repozytorium**, bo jeden projekt to setki megabajtów obrazów
i wideo:

```bash
cp .env.example .env
```

```dotenv
# .env: Twoje lokalne wartości, poza gitem
AIMATOR_WORKSPACE=~/Documents/Video/aimator-workspace
```

Wiodące `~/` jest rozwijane. `--workspace <ścieżka>` nadpisuje tę wartość dla jednego
wywołania.

Kolejność ma znaczenie: `.env.local` wygrywa z `.env`, a zmienna z powłoki wygrywa
z obydwoma. Commitowany jest wyłącznie `.env.example`.

## Modele i klucze

Żaden model nie ma wartości domyślnej: **model, którego nikt nie wybrał, nie jest
decyzją.** Klucze czytane są wyłącznie na ścieżce płatnej, bo `--dry-run` nie sięga po
sekret ani po sieć.

```dotenv
AIMATOR_IMPORT_MODEL=…                # import materiału, tekstowy; przydziela sekcje
AIMATOR_SCREENPLAY_MODEL=…            # etap 1
AIMATOR_IMAGE_MODEL_GPT_IMAGE=…       # etap 2, tor gpt-image
AIMATOR_IMAGE_MODEL_SEEDREAM=…        # etap 2, tor seedream
AIMATOR_SHOTLIST_MODEL=…              # etap 3
AIMATOR_PROMPTS_MODEL=…               # etap 4
AIMATOR_VIDEO_MODEL=…                 # etap 7, JEDEN dla obu torów: dreamina-seedance-* albo kling-3.0
AIMATOR_FFMPEG=ffmpeg                 # etapy 7 (Kling), 8-10 i 12; program, nie model; tylko gdy nie jest w PATH
AIMATOR_NARRATION_MODEL=…             # etap 9, tekstowy; podnosi skrypt
AIMATOR_VOICE_MODEL=…                 # etap 9, mowa; JEDEN dla obu torów
AIMATOR_DIALOGUE_VOICE_MODEL=…        # głosy postaci: próbka i kwestie; inny niż narratora
AIMATOR_SOUND_MODEL=…                 # etap 10, tekstowy; pisze arkusz cue
AIMATOR_MUSIC_MODEL=…                 # etap 10, podkład; JEDEN dla obu torów
AIMATOR_EFFECTS_MODEL=…               # etap 10, efekty; JEDEN dla obu torów
AIMATOR_DIALOGUE_MODEL=…              # etap 11, tekstowy; podnosi skrypt dialogu
AIMATOR_TRANSLATION_MODEL=…           # etap 11, tekstowy; tłumaczy skrypt na język ust

OPENAI_API_KEY=…
BYTEPLUS_MODELARK=…                   # także klucz wideo Seedance, na obu torach
KLING_API_KEY=…                       # klucz wideo, gdy AIMATOR_VIDEO_MODEL=kling-3.0
ELEVENLABS_API_KEY=…                  # mowa narratora i postaci, muzyka i efekty; jeden klucz

AIMATOR_LIPSYNC_BUCKET=…              # lip-sync: PRYWATNY bucket R2 na klip pożyczony dostawcy
R2_ACCOUNT_ID=…                       # konto R2, którego endpoint podpisują klucze niżej
R2_ACCESS_KEY_ID=…                    # token API R2 (S3), zawężony do tego bucketu
R2_SECRET_ACCESS_KEY=…
```

**Model wideo wybiera dostawcę.** Identyfikator przechodzi przez zamkniętą tabelę:
`dreamina-seedance-*` idzie na BytePlus ModelArk z kluczem `BYTEPLUS_MODELARK`, a
`kling-3.0` na Kling z kluczem `KLING_API_KEY`. Inny identyfikator to odmowa przed
wysyłką, z listą znanych. Kling nie oddaje ostatniej klatki klipu, więc etap 7 wycina ją
lokalnie przez ffmpeg i bez niego odmawia, zanim cokolwiek kupi.

**Klip pożyczony na czas lip-syncu.** Kling Lip Sync nie przyjmuje bajtów wideo, tylko id
klipu, który sam wyrenderował w ciągu 30 dni, albo adres, z którego go pobierze. Każdy inny
klip trafia na czas zadania do **prywatnego** bucketu R2 `AIMATOR_LIPSYNC_BUCKET`, dostawca
dostaje podpisany URL GET ważny najwyżej godzinę, a po zadaniu obiekt jest usuwany. Obiekt
nazywa się sha256 pliku, nigdy ścieżką z katalogu roboczego. Nieudane usunięcie to
meldunek, nie odmowa: bucket jest prywatny, a adres wygasa sam. To nie jest bucket strony,
bo worker strony serwuje wszystko, co w nim leży. `R2_ACCESS_KEY_ID` i
`R2_SECRET_ACCESS_KEY` to dane S3 tokenu API R2, zawężonego do tego jednego bucketu, a nie
logowanie wranglera. Wszystkie cztery czytane są wyłącznie na ścieżce płatnej, która
naprawdę wysyła, a brak którejkolwiek to odmowa z jej nazwą, zanim cokolwiek wyjdzie.

## Dlaczego tyle zmiennych

**Jedna zmienna na płatne miejsce wywołania, nie na dostawcę.** Dlatego etap 9 ma dwie,
a etap 10 trzy: model, który pisze, i modele, które robią dźwięk, to różne decyzje.
Wspólna zmienna znaczyłaby, że wybór modelu do scenariusza po cichu wybrał też model do
listy ujęć, a tego nikt nie zdecydował.

**Zmienna idzie za miejscem wywołania, klucz za dostawcą.** Stąd jeden
`ELEVENLABS_API_KEY` na cztery zmienne, i `BYTEPLUS_MODELARK` także na torze `gpt-image`,
kiedy renderuje klip.

**Model obrazu jest per tor, model wideo nie.** Oba tory są *rysowane* obok siebie, więc
wspólna zmienna czyniłaby z puszczenia obu z jednej powłoki edycję między poleceniami.
Klip nie jest rysowany, tylko renderowany z klatki, którą ten tor już wyprodukował, więc
osią jest miejsce wywołania, nie tor.

## Czego tu nie ma

**Głosu narratora.** Kto czyta serię, to obsada, bo wraca między odcinkami tak samo jak
postacie, więc siedzi w `project.json` jako `narratorVoiceId`, ustawiany przez
`project voice`. W zmiennej drugi odcinek puszczony z innej powłoki dostałby innego
lektora, a na dysku nie byłoby pliku mówiącego, że ktokolwiek tak zdecydował.

**Głosów postaci.** Z tego samego powodu to też obsada, ale nie w `project.json`, tylko
osobno dla każdej postaci i języka w `characters/<postać>/voices/<język>/voice.json`,
ustawianym przez `character voice`. Zmiana takiego pliku cofa wyłącznie zgodę na próbkę
tego języka, a zmiana `project.json` cofnęłaby zgody na obrazy i klipy.

**Języka ust.** Na jaki język tłumaczy się dialog i w jakim ruszają się usta drugiej
wersji, to decyzja odcinka w `episodes/<odcinek>/lip-sync.json`, ustawiana przez
`episode lip-sync`. `AIMATOR_TRANSLATION_MODEL` wybiera model, który tłumaczy, nigdy język.

**Sposobu czytania i poziomów miksu.** `narration.json` i `mix.json` leżą w katalogu
projektu, bo to suwaki, które ktoś kręci po odsłuchu, a zmienna środowiskowa nie
unieważnia niczego, co powstało pod starą wartością.

`AIMATOR_FFMPEG` jest jedyną zmienną, która nazywa **program**, a nie model, i jedyną,
której brak ma sensowną odpowiedź. Każda inna odmawia domyślnej, bo model nikogo nie
wybrany nie jest decyzją; „ffmpeg na tej maszynie" nie jest wyborem między silnikami, to
jest ten silnik. Zmienna istnieje dla buildu spoza `PATH`, nigdy do podmiany narzędzia.

---

[← README](../README.md) · [pełny kontrakt](pipeline.md)
