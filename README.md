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

## Gegevens, back-up en updates

* **Waar staan mijn gegevens?** In `%APPDATA%\GRCam-PTZ` (config.json en plan.json), los van de programmaversie: een nieuwe
  .exe vindt dezelfde gegevens. Gegevens uit mappen van eerdere versies worden bij de eerste start overgenomen. Bij elke
  wijziging komt de vorige versie in `backups\` (de laatste 20 blijven bewaard).
* **Back-up maken / terugzetten** (Beheer): één JSON-bestand met alle instellingen, koppelingen en het zittingsplan.
* **Updates:** Beheer → *Controleer op updates*, of bij het opstarten (uitschakelbaar in Instellingen) verschijnt
  *Update x.y.z beschikbaar*. De app downloadt de laatste release van GitHub naast de huidige .exe, controleert grootte en
  sha256, en start de nieuwe versie na een klik. Nooit automatisch tijdens een zitting.
* **Waarschuwing van Defender/SmartScreen?** Zie [docs/SIGNING.md](docs/SIGNING.md).

## Zetels aanpassen

Beheer → **Bewerken** bij een zetel → *Zetel bewerken*: naam, fractie (of geen fractie) en micropostnummer. Cameranummers: Beheer → Instellingen → **Test** per camera; cameramarkeringen sleep je op het plan in Inleren-modus.

## Log in een apart venster

Beheer → **Log in apart venster** opent het verkeerslog groot in een eigen venster (handig op een tweede scherm), met filters
(TX/RX/Info/Fouten), pauzeren, wissen, de debugschakelaar, *Test alle camera's* en de gele banner "Laatst opgeroepen". Het
venster sluit mee met de app.

## Debug: preset van een micropost ontdekken

Beheer → **Debug: laatste preset tonen**. Activeer in de zaal een micropost: na het antwoord van de camera vraagt de app de laatst opgeroepen preset op en toont boven het zaalplan *Laatst opgeroepen: camera x preset yy*. Koppel die daarna aan de zetel. Staat uit bij elke start; niet tijdens een zitting gebruiken.

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

## Preset uitproberen

Beheer → *Preset uitproberen*: kies een camera en een presetnummer en roep die op, optioneel meteen naar PVW (preview, bestemming 0) of PGM (programma, bestemming 1) op de BrightEye. De bestemmingen zijn instelbaar. Zo zie je of een preset bestaat en welke zitplaats erbij hoort, zonder debugmodus. Debug stuurt extra vragen naar de camera's die ook de NI-700 ziet; gebruik het niet tijdens een zitting.
