# Strona i wydania

Adres publiczny: https://aimator.auditmos.com/.
Adres zapasowy (Cloudflare): `https://auditmos-aimator.<konto>.workers.dev/` — ma
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

**Każda strona niesie obie wersje językowe naraz.** Tekst polski i angielski stoi obok
siebie w `<span class="t" lang="…">`, a `styles.css` chowa nieaktywny — wybór zapada przed
pierwszym rysowaniem klatki, bez mignięcia. `site/lang.js` (skrypt blokujący, jak
`theme.js`) mówi tylko, który to język: zapisany wybór z `localStorage`, a gdy go nie ma —
pierwszy pasujący wpis `navigator.languages`. Bez JavaScriptu `data-lang` zostaje na `pl`
z szablonu, więc widać dokładnie jeden język. Tam, gdzie znaczniki nie wchodzą — `<title>`,
`<meta name="description">`, `<option>` motywu i `aria-label` — angielski tekst siedzi
w `data-en` / `data-label-en` i podmienia go ten sam skrypt.

**To jest odwrotnie niż na stronie vAIdeo**, gdzie podstawowy jest angielski. Powód jest
w treści, nie w preferencji: cała dokumentacja aimatora jest po polsku, film też. Manual
marki mówi „English-first" o samej `auditmos.com`; ta strona świadomie od tego odchodzi,
ale zostawia po angielsku wersję maszynową — `index.md` i `llms.txt`.

**Słowo „Changelog" zostaje nieprzetłumaczone** w obu wersjach: to nazwa sekcji, do której
prowadzi kotwica `#changelog` i pozycja w nawigacji.

Prozę wydania tłumaczy opcjonalny blok `en` w `site/releases/*.json` (`title`,
`description`, `changes[]`, `note`, `source.description`, `documents[].description`,
`episode.audio`). Każde brakujące pole wraca do polskiego oryginału, więc nowe wydanie bez
tłumaczenia buduje się normalnie.

**Nazwy torów i pola `subject` zostają bez tłumaczenia.** `gpt-image` i `seedream` to nazwy
modeli, a `subject` to linijka, którą pakiet promptów podał modelowi — czyli materiał
podlegający regule 9. Tłumaczenie byłoby drugą wersją tej samej prawdy.

Strona główna pokazuje wyłącznie najnowsze wydanie. Rozwijany przełącznik „Wersja"
prowadzi do osobnych adresów `/releases/0.1.0/` itd. Każdy zawiera tylko własny opis, plik
źródłowy i media. Przełączanie działa bez JavaScriptu, zachowuje historię przeglądarki
i pozwala linkować wybraną wersję.

## Co pokazuje wydanie

„Plik źródłowy odcinka" to `source.md` etapu 0: nazwa, język, rozmiar, podgląd na żądanie
i pobieranie. Zamrożona kopia leży w `site/sources/<wersja>/`, a jej SHA-256 jest w polu
`source` rejestru — to ten sam hash, który `episode.json` zapisał w workspace, więc
łańcuch od pliku wejściowego do filmu jest sprawdzalny. Limit podglądu to 120000 bajtów.

Galeria pokazuje **jeden tor naraz**. Natywne przyciski radio filtrują panele przez CSS
`:has()` (także bez JS). Pod filmem są trzy rozwijane grupy obrazów pośrednich — klatka
otwarcia, referencje i karty postaci — każda z identyfikatorem z manifestu (`R01`,
`hero:ewa`) i linijką `subject`. Dodając tor, dopisz jego selektor w `styles.css`.

„Dokumenty etapów" to tekstowa strona produkcji — wspólna dla obu torów, bo opisuje
historię, a nie obrazy. Rejestr wymienia je jawnie, więc zawężenie listy to edycja jednego
pola, nie zmiana kodu. `project.md` celowo nie jest publikowany: to biblia serii, wspólna
dla wszystkich odcinków, a nie artefakt tego wydania.

## Gdzie leżą pliki

Strona i media to jedna paczka **Cloudflare Workers Static Assets**. Build sprawdza
[limit 25 MiB na plik](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)
i odrzuca każdy plik, którego SHA-256 nie zgadza się z rejestrem.

Adres pliku: `https://aimator.auditmos.com/media/<wersja>/<nazwa>`. Cloudflare Static
Assets zwraca na żądanie Range całość ze statusem 200, więc `src/site/worker.ts` obsługuje
`/media/*`: pojedyncze zakresy bajtów, odczyt od podanej pozycji i od końca, If-Range,
odpowiedzi 206/416. Czyta strumień i kończy odczyt po żądanym fragmencie, bez ładowania
całego MP4 do pamięci. Wewnętrzny binding nie zawsze podaje `Content-Length`; generowany
`media-index.json` zawiera rozmiary plików z tej samej paczki wdrożeniowej.

Przy rosnącej bibliotece przejdź na **R2 z własną domeną**. To następny etap, nie obecna
zależność. Zachowaj strukturę `<wersja>/<plik>`; zmień budowanie URL-i i politykę
`media-src` / `img-src` w `site/_headers`.

`out/` jest w `.gitignore`, więc **zamrożone pliki wydania żyją tylko lokalnie**. Build
wymaga ich obecności i niczego nie regeneruje w razie braku. Publikacja nie zastępuje kopii
zapasowej eksportów.

## Kolejne wydanie

1. Zachowaj poprzednie eksporty. Nie nadpisuj ich po opublikowaniu: cache mediów jest
   roczny i niezmienny, a build i tak odmówi. Nie aktualizuj sum starego wydania, żeby
   obejść kontrolę — zarejestruj zmienione pliki jako nową wersję.
2. Skopiuj materiały z workspace do `out/releases/<wersja>/` i przekoduj je na postać
   webową. Modele wideo oddają HEVC, którego przeglądarki poza Safari nie odtworzą, a
   oryginały mają kilkadziesiąt megabajtów:

   ```bash
   ffmpeg -i mixed.mp4 -c:v libx264 -preset slow -crf 23 -maxrate 2000k -bufsize 4000k \
     -profile:v high -level 4.0 -pix_fmt yuv420p -c:a aac -b:a 128k -ac 2 \
     -movflags +faststart <tor>-mixed.mp4
   ffmpeg -i opening-frame.png -vf scale=1600:-2 -q:v 3 <tor>-opening-frame.jpg
   ```

   Napisz w polu `note`, co zostało przekodowane i jakie były oryginały. Podglądu nie
   wolno wydawać za plik, który wyszedł z narzędzia.
3. Dodaj miniaturę każdego toru do `site/assets/releases/<wersja>/<tor>.jpg`:
   `ffmpeg -ss 3 -i <tor>-mixed.mp4 -frames:v 1 -vf scale=960:-2 -q:v 3 miniatura.jpg`.
   Skala 960 px szerokości jest konwencją wszystkich miniatur.
4. Dodaj zamrożony plik źródłowy do `site/sources/<wersja>/` i `site/releases/<wersja>.json`
   na wzór poprzedniego: data, tytuł, faktyczne zmiany, dokładny commit GitHub, widoczność
   repozytorium, rozdzielczości i sumy SHA-256 **mierzone z gotowych plików**, nie
   deklarowane.
5. `pnpm site:build` i `pnpm site:preview`, sprawdź nowe materiały w obu motywach
   i obu językach.
6. `pnpm site:deploy` publikuje **publicznie** wszystkie zarejestrowane wydania.

## Weryfikacja

`wrangler.site.jsonc` publikuje wyłącznie `out/site` pod `aimator.auditmos.com`. Jedyny
binding to `ASSETS`; nie ma baz, API ani uploadu `.env` czy workspace. Worker serwuje
fragmenty istniejących plików i nic nie generuje. Konfiguracja używa `404-page`, więc błędny
adres pliku zwraca 404, a nie HTML strony.

Przed publikacją: `pnpm types`, `pnpm test`, `pnpm lint`, `pnpm site:build`,
`pnpm exec wrangler deploy --config wrangler.site.jsonc --dry-run`.

`src/site/index.test.ts` sprawdza zawartość paczki, brak publikacji prywatnych plików,
escapowanie tekstu z rejestru, obie wersje językowe i powrót do polskiej, wykrywanie
podmienionych i brakujących mediów, limit 25 MiB, zachowanie poprzedniego buildu
i `media-index.json`. `src/site/worker.test.ts` sprawdza zakresy bajtów, zakończenie
odczytu po wysłaniu fragmentu, If-Range, błędne zakresy i rozmiar z indeksu.

Dwa wyjątki w `biome.jsonc` mają powód zapisany na miejscu: `site/index.html` jest
szablonem, który build przepisuje podstawieniami tekstowymi, więc formatter go nie dotyka,
a `theme.js` i `lang.js` są blokujące celowo — każdy decyduje o pierwszej klatce.
