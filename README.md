# Doci CLI

Pobieranie pojedynczych plików i całych katalogów z Doci z poziomu terminala. Obsługuje podkatalogi, kolejkę URL-i i równoległe transfery; pomija istniejące pliki.

Projekt jest vibe coded — powstał z pomocą AI.

## Szybki start

Wymagany Node.js 22+. Bez instalowania paczek npm. Polecenia uruchamiaj w katalogu z `doci.mjs`.

```sh
# Jeden plik lub katalog; drugi argument to katalog docelowy:
DOCI_PR_ID=TWOJ_NUMER_AKCJI_PR node doci.mjs 'URL_PLIKU_LUB_KATALOGU' './pobrane' --recursive

# Sesja przyjmująca kolejne URL-e:
DOCI_PR_ID=TWOJ_NUMER_AKCJI_PR node doci.mjs --interactive './pobrane' --recursive
```

Jeśli otrzymałeś dostęp w ramach akcji PRowej, odczytaj jej numer samodzielnie ze swojej przeglądarki i przekaż jako `DOCI_PR_ID`:

```sh
DOCI_PR_ID=TWOJ_NUMER_AKCJI_PR node doci.mjs --interactive './pobrane' --recursive
```

Zastąp `TWOJ_NUMER_AKCJI_PR` własną wartością liczbową. Skrypt nie zawiera numeru domyślnego. Instrukcja odczytu: [PR ID w KNOW-HOW.md](KNOW-HOW.md#pr-id). Korzystaj wyłącznie z otrzymanych uprawnień i materiałów, które możesz legalnie pobierać.

## Obsługa

W trybie interaktywnym wklej URL i naciśnij Enter. Możesz dodawać kolejne podczas pobierania, także kilka naraz oddzielonych białymi znakami.

- `/status` — pokaż stan procesu.
- `/exit`, `/quit` lub Ctrl-D — dokończ kolejkę i zakończ.
- Ctrl-C — przerwij natychmiast.

| Opcja | Działanie |
|---|---|
| `--recursive` | Pobieraj także podkatalogi |
| `--concurrency N` | Wspólny limit równoległych zadań sieciowych; domyślnie 5 |
| `--filter-max-size-mb N` | Maksymalny rozmiar jednego pliku; domyślnie 50 MB, 0 wyłącza limit |
| `--limit N` | Maksymalna liczba nowych pobrań w całej sesji |
| `--list` | Listuj URL-e bez pobierania plików |
| `--help` | Pokaż pomoc |

Po przerwaniu uruchom polecenie ponownie lub ponownie dodaj URL-e. Gotowe pliki zostaną pominięte, niepełne pobrane od początku. Kolejka URL-i nie przetrwa restartu. Nie uruchamiaj kilku procesów zapisujących do tego samego katalogu.

Szczegóły działania, diagnostyka i ograniczenia: [KNOW-HOW.md](KNOW-HOW.md).
