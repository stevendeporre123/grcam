# PTZ Backup – technische documentatie

## 1. Doel en context

Noodbediening voor de vier Lumens PTZ-camera's in de gemeenteraadszaal. De normale keten is:

```
Televic (70 micro's) → Televic API → (AMX NI-700) → Extron IPL T S6 → RS-232 VISCA → 4 Lumens PTZ
                                                                    BrightEye NXT-430 (clean switch) → streaming encoder
```

Deze app vervangt de automatische keten **niet**, maar biedt een handmatig alternatief wanneer de tracking faalt:
dezelfde VISCA-commando's gaan rechtstreeks over TCP naar de IPL (omzeilt de NI-700), en de BrightEye
wordt over IP omgeschakeld.

## 2. Structuur

```
main.js              Electron main-proces: config, plan, TCP, IPC, venster
preload.js           Brug (contextBridge) → window.api
visca.js             VISCA-commando's (Buffers)
brighteye.js         BrightEye Generic ASCII take-opdracht
renderer/
  index.html         Markup + dialogen (CSP)
  style.css          Donker thema
  plan-view.js       SVG-opbouw van het zittingsplan (browser + Node)
  app.js             UI-logica
config.default.json  Standaardinstellingen
plan.default.json    Zittingsplan (83 zetels, 8 fracties)
tools/mock-ipl.js    Nep-IPL (2003-2006) + nep-BrightEye (5200)
test/*.test.js       Node assert-tests
```

## 3. Dataflow

```
klik op zetel ─► app.js pick(id) ─► window.api.preset(cam, preset)
                                      │  ipcRenderer.invoke('cam:preset')
                                      ▼
                                 main.js handlers['cam:preset']
                                      │  visca.presetRecall(viscaAddr, preset)
                                      ▼
                         TCP-socket naar IPL host:camera.port ─► RS-232 ─► camera
```

* Verbindingen worden **op aanvraag** geopend en na `idleCloseMs` (2 s) stilte gesloten, zodat de IPL-poort
  zo kort mogelijk bezet is (belangrijk als de NI-700 dezelfde poort gebruikt).
* Tijdens pan/tilt/zoom loopt een **watchdog** (`moveWatchdogMs`, 4 s): zonder nieuw commando wordt automatisch
  een 'stop' gestuurd, zodat een camera nooit blijft doordraaien.
* Alle verkeer (TX/RX, hex) wordt als `log`-event naar de UI gestuurd (Beheer → verkeerslog, max. 200 regels).

## 4. IPC-kanalen

Elk antwoord heeft de vorm `{ ok: true, data }` of `{ ok: false, error }`.

| Kanaal | Argument | Doet |
| --- | --- | --- |
| `cfg:get` | – | geeft de config |
| `cfg:save` | config | valideert/merget en bewaart de config |
| `plan:get` | – | geeft het zittingsplan |
| `plan:import` | `{fracties, seats}` | vervangt het plan (backup-formaat van de zittingsplan-pagina) |
| `cam:preset` | `{camera, preset}` | preset oproepen |
| `cam:presetStore` | `{camera, preset}` | huidige positie opslaan (overschrijft) |
| `cam:home` | `{camera}` | home-positie |
| `cam:ping` | `{camera}` | power-inquiry; antwoord in het log |
| `cam:move` | `{camera, dir, speed}` | pan/tilt starten/stoppen |
| `cam:zoom` | `{camera, dir, speed}` | zoom starten/stoppen |
| `program:switch` | `{camera}` | BrightEye: bron van die camera naar de programma-uitgang |
| `log` (main → renderer) | `{t, dir, camera, hex}` | verkeerslog |

## 5. Bestandsformaten

Config en plan staan na de eerste start in de userData-map van de app (`%APPDATA%/ptz-backup` op Windows);
de `*.default.json` bestanden zijn enkel de startwaarden.

### config.json

```jsonc
{
  "ipl": { "host": "10.0.28.155", "idleCloseMs": 2000, "moveWatchdogMs": 4000 },
  "cameras": [
    { "id": 1, "name": "Camera 1", "port": 2003, "viscaAddr": 1, "beSource": 0,
      "pos": { "x": 8, "y": 178 } }          // positie op het plan (plan-coördinaten)
  ],
  "brighteye": { "enabled": false, "host": "", "port": 5200, "dest": 0 },
  "view": "ambtenaren",                     // of "zaal"
  "zaal": [ { "id": "zaal1", "label": "Zaal 1" }, { "id": "zaal2", "label": "Zaal 2" } ],
  "assign": { "<zetel-of-zaal-id>": { "camera": 1, "preset": 20 } }
}
```

### plan.json

```jsonc
{
  "fracties": [ { "key": "...", "naam": "...", "kleur": "#rrggbb" } ],
  "seats": [ { "id": "...", "naam": "...", "regel2": "...", "fractie": "...", "groep": "...",
               "cx": 0, "cy": 0, "w": 60, "h": 24, "ang": 0, "fs": 8, "rand": "zwart|fractie" } ],
  "bg": { "x": 0, "y": 0, "w": 568, "h": 806 },
  "decor": { "frame": { "cx": 0, "cy": 0, "w": 0, "h": 0 }, "greyfills": [ { "cx": 0, "cy": 0, "w": 0, "h": 0 } ] }
}
```

Een import accepteert ook enkel `{fracties, seats}` (backup van de zittingsplan-pagina); `bg` en `decor`
blijven dan behouden. Koppelingen blijven bestaan zolang de zetel-id's gelijk blijven.

## 6. Protocollen

### VISCA (via IPL, TCP)

| Actie | Bytes |
| --- | --- |
| Preset oproepen | `8x 01 04 3F 02 pp FF` |
| Preset opslaan | `8x 01 04 3F 01 pp FF` |
| Home | `8x 01 06 04 FF` |
| Pan/tilt | `8x 01 06 01 VV WW 0p 0t FF` (pan 1-24, tilt 1-20) |
| Zoom | `8x 01 04 07 00/2s/3s FF` |
| Power-inquiry | `8x 09 04 00 FF` |

`x` = camera-adres (standaard 1). De camera antwoordt `90 41 FF` (ACK) en `90 51 FF` (completion).

### BrightEye NXT (Generic ASCII, TCP 5200)

`@ X:0/<bestemming>,<bron>` + CR, cijfers in ASCII-hex, 0-gebaseerd, antwoord `>`.
Op de router: *External Control* → TCP/IP On, protocol Generic ASCII, een Profile toewijzen.

## 7. UI

* **Bediening**: SVG-plan (klik zetel), zaalknoppen, camerakeuze, 3×3 pad (vasthouden = bewegen), zoom, home, snelheid.
  Zicht 'Zicht ambtenarenbank' = plan 180° gedraaid, tekst blijft leesbaar.
* **Inleren** (checkbox): klik op zetel opent een modal. *Opslaan in camera* = `presetStore` + koppeling;
  *Enkel koppelen* = alleen de koppeling; *Wissen* = koppeling verwijderen. Voorstel voor een nieuw presetnummer: ≥ 20.
* **Beheer**: DataTables 2.x overzicht (alle zetels + zaalknoppen), instellingen, plan-import, test van alle camera's, log.
* De UI krijgt enkel `window.api` (contextIsolation aan, geen Node in de renderer, CSP-meta in index.html).

## 8. Testen

```bash
npm test                     # visca, plan, brighteye
node tools/mock-ipl.js       # nep-IPL + nep-BrightEye; zet de hosts in de app op 127.0.0.1
```

## 9. Problemen oplossen

| Symptoom | Mogelijke oorzaak |
| --- | --- |
| "Geen verbinding" bij elke camera | IPL-host fout, of de TCP-poort per COM-poort verschilt van 2003-2006 |
| Eerste camera werkt, automatische tracking valt weg | de IPL aanvaardt maar één TCP-verbinding per poort; gebruik de app enkel als de NI-700 uit is |
| Camera reageert niet maar het log toont TX | verkeerd VISCA-adres, of baudrate/COM-instelling op de IPL |
| Preset springt naar de verkeerde plaats | presetnummer wordt ook door de NI-700 gebruikt; leer opnieuw in vanaf 20 |
| Brighteye schakelt niet | Profile niet toegewezen, bron/bestemming-nummering (0-gebaseerd) of poort 5200 |

## 10. Nog te verifiëren in de zaal

1. TCP-poort per COM-poort op de IPL (aangenomen 2003-2006).
2. Of de IPL een tweede TCP-verbinding naast de NI-700 aanvaardt.
3. VISCA-adres van de Lumens-camera's (aangenomen 1).
4. Welke camera bij welke IPL-poort hoort, en de markeerposities op het plan.
5. Welke presetnummers de NI-700 al gebruikt (vooral voor Zaal 1 en Zaal 2: koppelen met *Enkel koppelen*).
6. BrightEye Profile: bron-nummers per camera en bestemming van de uitgang naar de encoder.
