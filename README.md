# PTZ Backup

Electron-noodbediening voor de 4 Lumens PTZ-camera's: VISCA over TCP naar de Extron IPL T S6 (RS-232 COM3–6), onafhankelijk van de AMX NI-700. Je bedient via het zittingsplan van de gemeenteraadszaal: klik een zetel en de camera springt naar de gekoppelde preset.

## Starten

```bash
npm install
npm start
```

Zonder hardware testen: `node tools/mock-ipl.js`, en zet in **Beheer → Instellingen** de IPL-host op `127.0.0.1`.
Tests: `npm test`. Windows-exe: `npm run dist`, of via GitHub Actions: push een tag `vX.Y.Z` en de portable `.exe` verschijnt onder Releases.

## Bediening

- **Zittingsplan:** standaard gedraaid zoals je het ziet vanaf de ambtenarenbank (knop rechtsboven wisselt naar het gewone zaalplan). 83 vakken, 55 sprekers aanklikbaar. Kader = fractie, kleurtint = gekoppelde camera. Grijze vakken zijn nog niet gekoppeld.
- **Zaal 1 / Zaal 2:** de twee algemene presets voor de hele zaal.
- **Camera + pan/tilt/zoom** voor bijsturen (vasthouden is bewegen, loslaten is stop, watchdog stopt na 4 s).

## Inleren (eenmalig, buiten een zitting)

1. Zet **Inleren** aan.
2. Stuur de camera met de pijlen naar de spreker.
3. Klik de zetel en kies **Opslaan in camera** (positie wordt in de camera bewaard onder dat presetnummer en gekoppeld), of **Enkel koppelen** voor een preset die al in de camera staat. Nieuwe koppelingen krijgen als voorstel presetnummer 20 of hoger, zodat bestaande presets niet overschreven worden.
4. Voor de zaalknoppen werkt het hetzelfde; daar kan je ook de naam van de knop aanpassen.

## Beheer

Tabel met alle zetels en zaalknoppen (DataTables), instellingen, verkeerslog, en **Zittingsplan importeren**: kies een backup-bestand van de zittingsplan-pagina om zetels en namen bij te werken. De koppelingen blijven behouden zolang de zetel-id's gelijk blijven.

## Eerst verifiëren vóór gebruik in een zitting

1. **TCP-poort per COM-poort** op de IPL: standaard 2003–2006 voor COM3–6, niet bevestigd. Controleer in de handleiding.
2. **Meerdere TCP-verbindingen**: de NI-700 heeft waarschijnlijk zelf een open verbinding. Test buiten een zitting of de IPL een tweede aanvaardt.
3. **VISCA-adres**: standaard 1. Controleer of de Lumens-camera's dat verwachten.
4. **Preset-nummers**: ruwe VISCA-waarden 0–127. Kijk welke de NI-700 al gebruikt, vooral voor de zaalpresets.
5. **Brighteye NXT-430** (uitgeschakeld tot je het instelt; knoppen "Programma: 1–4" verschijnen bovenaan):
   - Op de router: *External Control* → TCP/IP **On**, protocol **Generic ASCII**, en een **Profile** toewijzen. De app stuurt naar TCP-poort **5200**.
   - Bronnen en bestemmingen tellen vanaf 0 volgens dat Profile. Vul per camera de Brighteye-bron in (Instellingen) en de bestemming van de uitgang naar de encoder.
   - Opdracht: `@ X:0/<bestemming>,<bron>` + CR (hex-cijfers); de router antwoordt met `>`. Test met `node tools/mock-ipl.js` (nep-Brighteye op 5200).

## Opzet

Volledige technische documentatie (dataflow, IPC, bestandsformaten, protocollen, probleemoplossing): [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). De broncode is volledig voorzien van JSDoc.

| Bestand | Rol |
| --- | --- |
| `main.js` | TCP-verbindingen, IPC, config en plan (in de userData-map van de app) |
| `visca.js` | VISCA-commando's |
| `brighteye.js` | BrightEye take-opdracht (Generic ASCII) |
| `preload.js` | brug naar `window.api` |
| `tools/mock-ipl.js` | nep-IPL en nep-BrightEye om te testen |
| `test/` | Node assert-tests (`npm test`) |
| `docs/ARCHITECTURE.md` | technische documentatie |
| `renderer/plan-view.js` | tekent het zittingsplan als SVG |
| `renderer/app.js`, `index.html`, `style.css` | UI |
| `plan.default.json` | zetels en fracties uit de zittingsplan-pagina |
| `config.default.json` | standaardinstellingen |
