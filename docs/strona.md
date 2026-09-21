# Strona i wydania

Adres publiczny: https://aimator.auditmos.com/.
Adres zapasowy (Cloudflare): `https://auditmos-aimator.<konto>.workers.dev/` ma
`X-Robots-Tag: noindex`, a adres kanoniczny nadal wskazuje domenę główną.

Strona jest bliźniacza wobec [vaideo.auditmos.com](https://vaideo.auditmos.com/) i
świadomie: obie realizują „portable website shell" z
[manuala Auditmos](https://auditmos.com/design.md) (odczytanego 2026-09-21), więc różni je
treść, subdomena i domyślny język, a nie wygląd. Nie wymyślaj tu drugiego motywu.

## Co trafia na stronę

`site/index.html` i `site/styles.css` tworzą statyczny landing. `src/site/` wstawia w niego
changelog z `site/releases/*.json` i kopiuje do `out/site` **tylko to, co jest na liście**
`STATIC_FILES`. HTML, filmy, obrazy, pobieranie i rozwijane sekcje działają bez
JavaScriptu; JS zapamiętuje motyw i język oraz zatrzymuje pozostałe odtwarzacze.

Sekcja „Jak to powstaje" stoi w `site/index.html` na stałe, bo opisuje narzędzie, a nie
wydanie, więc wychodzi tak samo na stronie głównej i na każdej podstronie wersji. Jest to
ten sam podział na jedenaście etapów w trzech fazach co
[docs/jak-to-powstaje.md](jak-to-powstaje.md), tylko kartami zamiast diagramu, bo Mermaid
wymagałby JavaScriptu z obcego CDN-u. Że obie listy mówią to samo, pilnuje
`src/test/docs.test.ts`: nazwy etapów muszą się zgadzać w README, na tej stronie
dokumentacji i w znacznikach `data-stage` szablonu.

**Każda strona niesie obie wersje językowe naraz.** Tekst polski i angielski stoi obok
siebie w `<span class="t" lang="…">`, a `styles.css` chowa nieaktywny. Wybór zapada przed
pierwszym rysowaniem klatki, bez mignięcia. `site/lang.js` (skrypt blokujący, jak
`theme.js`) mówi tylko, który to język: zapisany wybór z `localStorage`, a gdy go nie ma, to
pierwszy pasujący wpis `navigator.languages`. Bez JavaScriptu `data-lang` zostaje na `pl`
z szablonu, więc widać dokładnie jeden język. Tam, gdzie znaczniki nie wchodzą, czyli w `<title>`,
`<meta name="description">`, `<option>` motywu i `aria-label`, angielski tekst siedzi
w `data-en` / `data-label-en` i podmienia go ten sam skrypt.

**To jest odwrotnie niż na stronie vAIdeo**, gdzie podstawowy jest angielski. Powód jest
w treści, nie w preferencji: cała dokumentacja aimatora jest po polsku, film też. Manual
marki mówi „English-first" o samej `auditmos.com`; ta strona świadomie od tego odchodzi,
ale zostawia po angielsku wersję maszynową: `index.md` i `llms.txt`.

**Słowo „Changelog" zostaje nieprzetłumaczone** w obu wersjach: to nazwa sekcji, do której
prowadzi kotwica `#changelog` i pozycja w nawigacji.

Prozę wydania tłumaczy opcjonalny blok `en` w `site/releases/*.json` (`title`,
`description`, `changes[]`, `note`, `source.description`, `documents[].description`,
`episode.audio`). Każde brakujące pole wraca do polskiego oryginału, więc nowe wydanie bez
tłumaczenia buduje się normalnie.

**Nazwy torów i pola `subject` zostają bez tłumaczenia.** `gpt-image` i `seedream` to nazwy
modeli, a `subject` to linijka, którą pakiet promptów podał modelowi, czyli materiał
podlegający regule 9. Tłumaczenie byłoby drugą wersją tej samej prawdy.

Strona główna pokazuje wyłącznie najnowsze wydanie. Rozwijany przełącznik „Wersja"
prowadzi do osobnych adresów `/releases/0.1.0/` itd. Każdy zawiera tylko własny opis, plik
źródłowy i media. Przełączanie działa bez JavaScriptu, zachowuje historię przeglądarki
i pozwala linkować wybraną wersję.

## Co pokazuje wydanie

„Plik źródłowy odcinka" to `source.md` etapu 0: nazwa, język, rozmiar, podgląd na żądanie
i pobieranie. Zamrożona kopia leży w `site/sources/<wersja>/`, a jej SHA-256 jest w polu
`source` rejestru. To ten sam hash, który `episode.json` zapisał w workspace, więc
łańcuch od pliku wejściowego do filmu jest sprawdzalny. Limit podglądu to 120000 bajtów.

Galeria pokazuje **jeden tor naraz**. Natywne przyciski radio filtrują panele przez CSS
`:has()` (także bez JS). Pod filmem są trzy rozwijane grupy obrazów pośrednich: klatka
otwarcia, referencje i karty postaci, każda z identyfikatorem z manifestu (`R01`,
`hero:ewa`) i linijką `subject`. Dodając tor, dopisz jego selektor w `styles.css`.

„Dokumenty etapów" to tekstowa strona produkcji, wspólna dla obu torów, bo opisuje
historię, a nie obrazy. Rejestr wymienia je jawnie, więc zawężenie listy to edycja jednego
pola, nie zmiana kodu. `project.md` celowo nie jest publikowany: to biblia serii, wspólna
dla wszystkich odcinków, a nie artefakt tego wydania.

## Gdzie leżą pliki

Bajty wydania leżą w dwóch miejscach, podzielone według tego, czym są.

**Tekst jest w repozytorium.** Plik źródłowy odcinka (`site/sources/<wersja>/`) i dokumenty
etapów (`site/documents/<wersja>/`) są małe, warto je czytać w diffie, a strona je cytuje,
nie tylko linkuje. Idą do paczki **Cloudflare Workers Static Assets** razem ze stroną.
Całość waży około 350 KB.

**Media są w R2**, w prywatnym buckecie `aimator-site-media` (WEUR). Filmy i obrazy się
strumieniuje, nie czyta, a bucket jest jedyną kopią, która przeżyje laptopa, na którym
powstały. Bucket **nie ma publicznej domeny ani adresu `r2.dev`**: jedynym czytelnikiem jest
Worker, na własnym origin strony. To dlatego strona może zostać przy `default-src 'self'`
i dlatego link „pobierz" nadal pobiera, zamiast otwierać obcą domenę.

Ten podział zdejmuje dwie rzeczy naraz. Nie obowiązuje już
[limit 25 MiB na plik](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/),
bo to limit Static Assets, a nie R2. I **`pnpm site:build` nie potrzebuje niczego z `out/`**:
świeży klon repozytorium przebuduje i wdroży stronę, a filmy zostaną tam, gdzie były. Tylko
`pnpm site:media` czyta zamrożone eksporty, wyłącznie po to, żeby je wysłać.

Adres pliku: `https://aimator.auditmos.com/media/<wersja>/<nazwa>`, a klucz w buckecie to
`<wersja>/<nazwa>`. `src/site/worker.ts` obsługuje `/media/*` i nic więcej: zakresy bajtów,
odczyt od podanej pozycji i od końca, If-Range, HEAD, odpowiedzi 200/206/404/416. R2
przyjmuje offset, więc przewinięcie na 1:15 czyta wyłącznie bajty, o które poprosiła
przeglądarka. Wcześniej, gdy filmy były assetami, trzeba było przeczytać i wyrzucić
pierwsze 75 sekund.

`pnpm site:media` wysyła **bezwarunkowo**, po sprawdzeniu każdego pliku przeciw sumie
SHA-256 z rejestru. To nie jest niedopatrzenie: skoro bajty się zgadzają, ponowne wysłanie
może zapisać tylko ten sam plik, a pomijanie tego, co już jest, wymagałoby HEAD-a, którego
Wrangler nie oferuje, albo drugiej listy „co już opublikowano", czyli dokładnie tej
rozbieżności, przed którą chroni reguła 7.

## Kolejne wydanie

1. Zachowaj poprzednie eksporty. Nie nadpisuj ich po opublikowaniu: cache mediów jest
   roczny i niezmienny, a build i tak odmówi. Nie aktualizuj sum starego wydania, żeby
   obejść kontrolę; zarejestruj zmienione pliki jako nową wersję.

2. **`pnpm site:freeze <projekt> <odcinek> <wersja>`** to jedno polecenie, które robi całą
   mechaniczną część:

   ```bash
   pnpm site:freeze dzielna-ewa 02-latarnia 0.2.0
   ```

   Wyjmuje z workspace film każdego toru i przekodowuje go do H.264 (powodem jest
   **kodek, nie rozmiar**: R2 zniósł limit wielkości pliku, ale modele wideo oddają HEVC,
   którego przeglądarki poza Safari nie odtworzą), skaluje klatkę otwarcia, referencje
   i karty postaci do podglądów JPEG 1600 px, wycina miniaturę każdego toru z **gotowego
   pliku webowego**, kopiuje plik źródłowy i dokumenty etapów do repozytorium i wypisuje
   `site/releases/<wersja>.json` z policzonymi sumami SHA-256, rozdzielczościami i długością
   **zmierzonymi z plików, które właśnie zrobił**, nie zadeklarowanymi.

   Czego nie robi: nie pisze prozy. Każdy tekst, który zobaczy czytelnik, wychodzi jako
   `TODO`, a polecenie wypisuje listę pól do napisania. Identyfikatory i linijki `subject`
   referencji **podnosi z pakietu promptów**, bo to angielski tekst, który dostał model, a
   przepisywanie go ręcznie byłoby drugą wersją tej samej prawdy.

   Odmawia, gdy wersja już istnieje, gdy etap 0 nie jest zatwierdzony (albo zgoda wygasła
   po ręcznej edycji), gdy któryś tor nie ma `mixed.mp4` i gdy brakuje karty postaci.

3. Napisz prozę w `site/releases/<wersja>.json`. Dopóki zostaje tam choć jedno `TODO`,
   `pnpm site:build` odmawia i wymienia pola po nazwach. W polu `note` napisz, co zostało
   przekodowane i jakie były oryginały. Podglądu nie wolno wydawać za plik, który wyszedł
   z narzędzia.

4. `pnpm site:build` i `pnpm site:preview`, sprawdź nowe materiały w obu motywach
   i obu językach. Podgląd czyta media z **prawdziwego** bucketu (`remote` w konfiguracji
   bindingu), więc nowe pliki zobaczysz dopiero po `pnpm site:media`.

5. `pnpm site:deploy` robi trzy rzeczy po kolei: buduje stronę, wysyła media do R2
   i publikuje **publicznie** wszystkie zarejestrowane wydania.

## Weryfikacja

`wrangler.site.jsonc` publikuje wyłącznie `out/site` pod `aimator.auditmos.com`. Bindingi są
dwa: `ASSETS` i `MEDIA` (bucket tylko do odczytu); nie ma baz, API ani uploadu `.env` czy
workspace. Worker serwuje istniejące obiekty i nic nie generuje. `run_worker_first` obejmuje
wyłącznie `/media/*`; reszta idzie prosto z assetów, z `_headers` i bez wywołania Workera,
a `404-page` odpowiada na błędny adres.

Przed publikacją: `pnpm types`, `pnpm test`, `pnpm lint`, `pnpm unused`, `pnpm site:build`,
`pnpm exec wrangler deploy --config wrangler.site.jsonc --dry-run`.

`src/site/index.test.ts` sprawdza zawartość paczki, brak publikacji prywatnych plików i
mediów, budowanie bez żadnych eksportów na dysku, escapowanie tekstu z rejestru, obie wersje
językowe i powrót do polskiej, bramkę na nienapisanej prozie, wykrywanie podmienionych
i brakujących plików, zachowanie poprzedniego buildu oraz to, że publikacja mediów nie oddaje
bucketowi pliku, którego bajty się zmieniły. `src/site/worker.test.ts` sprawdza zakresy
bajtów, to że bucket dostaje dokładnie żądany offset, If-Range, HEAD, błędne zakresy i 404
na brakujący klucz. `src/site/episode.test.ts` sprawdza zamrażanie na workspace zbudowanym
przez wspólny fixture przez wejścia własnych etapów: co trafia do wydania, podnoszenie
`subject` z pakietu, miniaturę wyciętą z pliku webowego, pomiar gotowego pliku i cztery
odmowy. Silnik jest wstrzykiwany, więc te testy nie potrzebują ffmpeg. Prawdziwy silnik
sprawdza się tam, gdzie jest przedmiotem testu.

Dwa wyjątki w `biome.jsonc` mają powód zapisany na miejscu: `site/index.html` jest
szablonem, który build przepisuje podstawieniami tekstowymi, więc formatter go nie dotyka,
a `theme.js` i `lang.js` są blokujące celowo, bo każdy decyduje o pierwszej klatce.
