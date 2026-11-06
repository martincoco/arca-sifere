# SIFERE (Convenio Multilateral)

Automation for the monthly IIBB Convenio Multilateral DDJJ in SIFERE Web. Work in progress.

## Setup

    npm install && npx playwright install chromium

Credentials come from the macOS Keychain profiles shared with the other ARCA tools (`arca-<perfil>`, see
`arca-facturador-colegio`'s `npm run credenciales`).

## Step 1: capture the real screens

    npm run explorar -- martin

Logs in and opens SIFERE Web, then you do the DDJJ by hand. Every screen is saved to `capturas/`
(HTML + screenshot, gitignored: they contain real tax data). In the terminal: Enter saves the current screen
again (useful after filling a table without changing page), `q` finishes. Native confirmation popups are
relayed to the terminal for an `s/N` answer.

## Monthly use

    cp config.example.json config.json   # once: contribuyente CUIT, activity, jurisdiction split
    npm run presentar -- 500000          # previous month; --periodo 2026-09 for another one

The amount is typed without thousands separators (`500000` or `500000.50`). The script creates the DJ, loads the
amount, imports deducciones, fills each jurisdiction from `config.json` (percentage, tratamiento fiscal,
alícuota, ingresos gravados/exentos), copies the firmante from the last presented DJ, and stops on the totals
for an `s/N` before "Cerrar DJ". Presenting and the VEP are done by hand afterwards.

It never deletes anything: if a draft for the period already exists, delete it from "Listado de DDJJ" first.
Failures leave the browser open and save screenshots plus each frame's HTML to `debug/` (gitignored).
