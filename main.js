'use strict';

/**
 * @file Electron main process van PTZ Backup.
 *
 * Verantwoordelijkheden:
 *  - config en zittingsplan bewaren in de userData-map van de app;
 *  - VISCA-commando's naar de camera's sturen via de Extron IPL T S6 (TCP per COM-poort);
 *  - de BrightEye NXT-router schakelen (Generic ASCII, TCP 5200);
 *  - alles beschikbaar maken voor de UI via IPC (zie preload.js).
 *
 * Elk IPC-kanaal antwoordt met `{ok: true, data}` of `{ok: false, error}`, zodat de UI fouten kan tonen.
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const visca = require('./visca');
const { createWatcher, splitMessages } = require('./debug-watch');
const { describe, describeCommand, queryKind } = require('./visca-decode');
const { takeCommand, statusCommand, parseStatus } = require('./brighteye');
const { createPoller } = require('./mic-api');
const store = require('./data-store');
const { cleanHost } = require('./host');
const updater = require('./updater');

/** GitHub-repository waaruit updates komen (publieke releases). */
const REPO = 'stevendeporre123/grcam';

// Vaste datamap (los van pakketnaam/versie), zodat een nieuwe .exe altijd dezelfde gegevens vindt.
// Moet vóór het eerste gebruik van 'userData' gebeuren.
app.setPath('userData', store.dataDir(app.getPath('appData')));

/**
 * @typedef {Object} Camera
 * @property {number} id            camera-nummer (1-4)
 * @property {string} name          weergavenaam
 * @property {number} port          TCP-poort op de IPL die bij de COM-poort van de camera hoort
 * @property {number} viscaAddr     VISCA-adres (1-7)
 * @property {number} beSource      bronnummer in de BrightEye (telt vanaf 0, volgens het Profile)
 * @property {{x:number,y:number}} [pos] positie op het zittingsplan (plan-coördinaten)
 *
 * @typedef {Object} Config
 * @property {{host:string, idleCloseMs:number, moveWatchdogMs:number}} ipl
 * @property {Camera[]} cameras
 * @property {{enabled:boolean, host:string, port:number, dest:number}} brighteye
 * @property {'ambtenaren'|'zaal'} view                        richting van het plan
 * @property {{id:string,label:string}[]} zaal                 de algemene zaalknoppen
 * @property {Record<string,{camera:number,preset:number}>} assign  zetel-id of zaal-id -> camera + preset
 */

/** @type {BrowserWindow|null} */
let win = null;
/** Het aparte logvenster (indien open). @type {BrowserWindow|null} */
let logWin = null;
/** Laatste logregels, zodat een nieuw geopend logvenster niet leeg start. */
const logBuffer = [];
const LOG_KEEP = 1000;

/**
 * Stuurt een bericht naar alle open vensters (hoofdvenster en logvenster).
 * @param {string} channel
 * @param {any} data
 */
function broadcast(channel, data) {
  for (const w of [win, logWin]) if (w && !w.isDestroyed()) w.webContents.send(channel, data);
}
/** @type {Config|null} */
let config = null;

/**
 * Open TCP-verbindingen naar de IPL, per "host:poort". Een verbinding sluit zichzelf na `ipl.idleCloseMs`
 * inactiviteit zodat de NI-700 de IPL niet mist als die maar een beperkt aantal verbindingen toelaat.
 * @type {Map<string, {sock: net.Socket, timer: NodeJS.Timeout|null}>}
 */
const conns = new Map();

/**
 * Debugmodus: na elk completion van een camera vragen we de laatst opgeroepen preset op (zie debug-watch.js).
 * Het antwoord gaat als 'lastPreset' naar de UI (banner boven het zaalplan).
 */
const watcher = createWatcher({
  getCamera: (id) => camById(id),
  write: (id, buf) => {
    const cam = camById(id);
    const entry = conns.get(`${config.ipl.host}:${cam.port}`);
    if (!entry || entry.sock.destroyed) return;
    entry.sock.write(buf);
    logTx(id, buf, '(debug)');
  },
  onLast: (id, preset) => {
    broadcast('lastPreset', { t: Date.now(), camera: id, preset });
  },
  log: (msg, id) => log({ dir: 'info', camera: id, hex: '', text: msg }),
  // Geen antwoord: de verbinding kan stilletjes zijn weggevallen. Sluiten; in debugmodus wordt ze meteen hersteld.
  onTimeout: (id) => {
    const entry = conns.get(`${config.ipl.host}:${camById(id).port}`);
    if (entry) { entry.sock.destroy(); log({ dir: 'info', camera: id, hex: '', text: 'Verbinding met de IPL wordt hersteld' }); }
  },
});

/** Laatste vraag (power/memory) per camera, om een 4-byte antwoord te kunnen duiden. @type {Map<number, 'power'|'memory'>} */
const lastQuery = new Map();

/**
 * Logt een bericht dat we naar een camera sturen, met uitleg in gewone taal.
 * @param {number} id
 * @param {Buffer} buf
 * @param {string} [extra]
 */
function logTx(id, buf, extra = '') {
  const q = queryKind(buf);
  if (q) lastQuery.set(id, q);
  log({ dir: 'tx', camera: id, hex: visca.toHex(buf), text: [describeCommand(buf), extra].filter(Boolean).join(' ') });
}

/** Watchdog per camera: stopt een beweging als de operator niet loslaat of de UI hangt. @type {Map<number, NodeJS.Timeout>} */
const watchdogs = new Map();

/** @returns {string} pad naar config.json in de userData-map */
const cfgPath = () => path.join(app.getPath('userData'), 'config.json');
/** @returns {string} pad naar plan.json in de userData-map */
const planPath = () => path.join(app.getPath('userData'), 'plan.json');

/**
 * Laadt de config. Bij de eerste start wordt `config.default.json` gebruikt; ontbrekende sleutels
 * (bv. na een update van de app) worden aangevuld vanuit de standaardwaarden.
 * @returns {Config}
 */
function loadConfig() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(cfgPath(), 'utf8')); } catch { /* eerste start of onleesbaar: standaard */ }
  config = normalizeConfig(raw);
  saveConfig(config);
  return config;
}

/**
 * Vult een (oudere of ontbrekende) config aan met de standaardwaarden.
 * @param {object|null} raw
 * @returns {Config}
 */
function normalizeConfig(raw) {
  const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8'));
  const c = { ...defaults, ...(raw || {}) };
  c.ipl = { ...defaults.ipl, ...c.ipl };
  c.brighteye = { ...defaults.brighteye, ...c.brighteye };
  c.brighteye.thumbs = { ...defaults.brighteye.thumbs, ...(raw?.brighteye?.thumbs || {}) };
  c.ipl.host = cleanHost(c.ipl.host);
  c.brighteye.host = cleanHost(c.brighteye.host);
  c.timing = { ...defaults.timing, ...c.timing };
  c.micApi = { enabled: Boolean(c.micApi?.enabled), host: cleanHost(c.micApi?.host), port: Number(c.micApi?.port) || defaults.micApi.port };
  // Ontbrekende zaalknoppen (zaal3, zaal4 bij een oudere config) aanvullen; bestaande labels blijven.
  const haveZ = new Set((c.zaal || []).map((z) => z.id));
  c.zaal = [...(c.zaal || []), ...defaults.zaal.filter((z) => !haveZ.has(z.id))];
  c.debug = false; // debugmodus staat bij elke start uit (houdt anders IPL-verbindingen open)
  // Ontbrekende cameravelden (bv. positie op het plan) aanvullen vanuit de standaard.
  // Ontbrekende camera's (id 1-4) worden bijgemaakt.
  const have = new Map((raw?.cameras || []).map((cam) => [cam.id, cam]));
  c.cameras = defaults.cameras.map((d) => ({ ...d, ...have.get(d.id) }));
  return c;
}

/**
 * Bewaart de config op schijf en maakt hem de actieve config.
 * @param {Config} next
 */
function saveConfig(next) {
  config = next;
  if (config.ipl) config.ipl.host = cleanHost(config.ipl.host); // "http://10.0.0.1/" -> "10.0.0.1"
  if (config.brighteye) config.brighteye.host = cleanHost(config.brighteye.host);
  // De debugstand wordt nooit bewaard (staat bij elke start uit); zo maakt het schakelen geen back-ups aan.
  store.writeWithBackup(cfgPath(), JSON.stringify({ ...config, debug: false }, null, 2));
}

/**
 * Laadt het zittingsplan (zetels, fracties, achtergrond). Bij de eerste start wordt
 * `plan.default.json` naar de userData-map gekopieerd.
 * @returns {{fracties:object[], seats:object[], bg:object, decor:object}}
 */
function loadPlan() {
  try {
    return JSON.parse(fs.readFileSync(planPath(), 'utf8'));
  } catch {
    const plan = JSON.parse(fs.readFileSync(path.join(__dirname, 'plan.default.json'), 'utf8'));
    store.writeWithBackup(planPath(), JSON.stringify(plan));
    return plan;
  }
}

/**
 * Importeert een backup uit de zittingsplan-pagina (`{fracties, seats}`). Achtergrond en decor
 * blijven behouden; koppelingen in `config.assign` blijven gelden zolang de zetel-id's gelijk blijven.
 * @param {{fracties:object[], seats:object[]}} p
 * @returns {object} het nieuwe plan
 * @throws {Error} als het bestand geen geldige backup is
 */
function importPlan(p) {
  if (!p || !Array.isArray(p.fracties) || !Array.isArray(p.seats)) throw new Error('Geen geldig zittingsplan-bestand');
  const old = loadPlan();
  // Micropostnummers (alleen in deze app bijgehouden) blijven behouden per zetel-id.
  const mics = Object.fromEntries(old.seats.filter((s) => s.mic).map((s) => [s.id, s.mic]));
  const seats = p.seats.map((s) => (mics[s.id] && !s.mic ? { ...s, mic: mics[s.id] } : s));
  const plan = { ...old, fracties: p.fracties, seats };
  store.writeWithBackup(planPath(), JSON.stringify(plan));
  return plan;
}

/**
 * Bewaart het volledige zittingsplan (na het bewerken van zetels: naam, fractie, micropostnummer).
 * @param {{fracties:object[], seats:object[]}} p
 * @returns {object} het bewaarde plan
 * @throws {Error} als het plan ongeldig is
 */
function savePlan(p) {
  if (!p || !Array.isArray(p.fracties) || !Array.isArray(p.seats)) throw new Error('Ongeldig zittingsplan');
  store.writeWithBackup(planPath(), JSON.stringify(p));
  return p;
}

/**
 * Stuurt een logregel naar de UI (verkeerslog in het Beheer-scherm).
 * @param {{dir:'tx'|'rx'|'err'|'info', camera?:number, hex:string}} entry
 */
function log(entry) {
  const e = { t: Date.now(), ...entry };
  logBuffer.push(e);
  if (logBuffer.length > LOG_KEEP) logBuffer.shift();
  broadcast('log', e);
}

/**
 * Zoekt een camera in de config.
 * @param {number|string} id
 * @returns {Camera}
 * @throws {Error} als de camera niet bestaat
 */
const camById = (id) => {
  const c = config.cameras.find((x) => x.id === Number(id));
  if (!c) throw new Error(`Camera ${id} bestaat niet`);
  return c;
};

/**
 * Geeft een open verbinding naar host:poort terug (en hergebruikt een bestaande).
 * Binnenkomende bytes (VISCA-antwoorden) gaan naar het log.
 * @param {string} host
 * @param {number} port
 * @param {number} camId  camera waarvoor het verkeer gelogd wordt
 * @returns {Promise<{sock: net.Socket, timer: NodeJS.Timeout|null}>}
 */
function getSocket(host, port, camId) {
  const key = `${host}:${port}`;
  const existing = conns.get(key);
  if (existing && !existing.sock.destroyed) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    const entry = { sock, timer: null };
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 5000); // een wegvallende verbinding sneller opmerken
    sock.setTimeout(3000, () => sock.destroy(new Error(`Time-out bij verbinden met ${key}`)));
    sock.once('connect', () => {
      sock.setTimeout(0);
      conns.set(key, entry);
      resolve(entry);
    });
    // Antwoorden komen soms byte per byte binnen: eerst samenvoegen tot een compleet bericht (eindigt op 0xFF).
    let carry = Buffer.alloc(0);
    let flush = null;
    sock.on('data', (d) => {
      const r = splitMessages(carry, d);
      carry = r.rest;
      for (const m of r.messages) {
        log({ dir: 'rx', camera: camId, hex: visca.toHex(m), text: describe(m, lastQuery.get(camId)) });
        watcher.feed(camId, m);
      }
      clearTimeout(flush);
      if (carry.length) {
        flush = setTimeout(() => {
          log({ dir: 'rx', camera: camId, hex: visca.toHex(carry), text: 'Onvolledig bericht (geen einde ontvangen)' });
          carry = Buffer.alloc(0);
        }, 500);
      }
    });
    sock.on('error', (e) => { conns.delete(key); reject(e); });
    sock.on('close', () => { if (conns.get(key) === entry) conns.delete(key); scheduleReconnect(); });
  });
}

/**
 * Stuurt een VISCA-buffer naar de IPL-poort van een camera en herstart de inactiviteitstimer.
 * @param {number} camId
 * @param {Buffer} buf  VISCA-commando (zie visca.js)
 * @returns {Promise<void>}
 */
async function sendVisca(camId, buf) {
  const cam = camById(camId);
  const entry = await getSocket(config.ipl.host, cam.port, cam.id);
  await new Promise((res, rej) => entry.sock.write(buf, (e) => (e ? rej(e) : res())));
  logTx(cam.id, buf);
  clearTimeout(entry.timer);
  // In debugmodus blijven de verbindingen open zodat we ook berichten van de automatisering zien.
  if (!config.debug) entry.timer = setTimeout(() => entry.sock.destroy(), config.ipl.idleCloseMs);
}

/** Opent (indien nodig) permanente verbindingen naar alle camerapoorten; fouten komen in het log. */
function openDebugConnections() {
  if (!config.debug) return;
  for (const c of config.cameras) {
    const key = `${config.ipl.host}:${c.port}`;
    const ex = conns.get(key);
    if ((ex && !ex.sock.destroyed) || connecting.has(key)) continue; // niet dubbel verbinden
    connecting.add(key);
    getSocket(config.ipl.host, c.port, c.id)
      .then(() => { reconnectDelay = 3000; })
      .catch((e) => {
        if (!failLogged.has(key)) { failLogged.add(key); log({ dir: 'err', camera: c.id, hex: `debug: ${e.message}`, text: `Verbinden met de IPL (poort ${c.port}) lukt niet; nieuwe pogingen op de achtergrond` }); }
      })
      .finally(() => { connecting.delete(key); if (conns.has(key)) failLogged.delete(key); });
  }
}
/** Verbindingen die nu opgebouwd worden, en voor welke poort de fout al gelogd is. */
const connecting = new Set();
const failLogged = new Set();
let reconnectTimer = null;
let reconnectDelay = 3000;
/** Eén herverbinding tegelijk, met oplopende wachttijd (3 s tot 30 s) zodat een onbereikbare IPL niet bestookt wordt. */
function scheduleReconnect() {
  if (!config || !config.debug || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    openDebugConnections();
  }, reconnectDelay);
}
function applyDebug(wasOn) {
  watcher.setEnabled(config.debug);
  if (config.debug) { openDebugConnections(); return; }
  if (wasOn) for (const e of conns.values()) e.sock.destroy();
}

/**
 * Zet (of herstart) de watchdog van een camera. Na `ipl.moveWatchdogMs` zonder nieuw bewegingscommando
 * worden pan/tilt en zoom gestopt, zodat een camera nooit blijft draaien.
 * @param {number} camId
 * @param {number} a  VISCA-adres van de camera
 */
function armWatchdog(camId, a) {
  clearTimeout(watchdogs.get(camId));
  watchdogs.set(camId, setTimeout(() => {
    sendVisca(camId, visca.panTilt(a, 'stop')).catch(() => {});
    sendVisca(camId, visca.zoom(a, 'stop')).catch(() => {});
    log({ dir: 'info', camera: camId, hex: 'watchdog: beweging gestopt' });
  }, config.ipl.moveWatchdogMs));
}

/**
 * Vertaalt een netwerkfout naar een bruikbare melding voor de BrightEye.
 * @param {Error & {code?:string}} e
 * @returns {string}
 */
function brighteyeError(e) {
  const b = config.brighteye;
  if (e.code === 'ECONNREFUSED') return `Brighteye weigert de verbinding op ${b.host}:${b.port}: staat External Control → TCP/IP aan en is de poort juist?`;
  if (e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH' || e.code === 'ENOTFOUND') return `Brighteye ${b.host} is niet bereikbaar: controleer het IP-adres en het netwerk`;
  if (/Time-out/i.test(e.message)) return `Brighteye ${b.host}:${b.port} antwoordt niet (time-out): controleer het IP-adres en of de besturing aanstaat`;
  return `Brighteye-fout: ${e.message}`;
}

/**
 * Stuurt één opdracht naar de BrightEye en wacht tot de prompt `>` terugkomt.
 * @param {string} cmd opdracht (eindigt op CR)
 * @param {number} [camera] camera voor het log
 * @returns {Promise<string>} volledig antwoord van de router
 * @throws {Error} met een leesbare melding
 */
let beQueue = Promise.resolve();
async function brighteyeExchange(cmd, camera) {
  const b = config.brighteye;
  if (!b.enabled || !b.host) throw new Error('Brighteye-koppeling is niet ingesteld (Beheer → Instellingen)');
  let reply = '';
  const run = async () => {
    await new Promise((resolve, reject) => {
      const s = net.createConnection({ host: b.host, port: b.port });
      let done = false;
      const finish = (err) => { if (done) return; done = true; s.destroy(); err ? reject(err) : resolve(); };
      s.setTimeout(3000, () => finish(new Error('Time-out Brighteye')));
      s.on('connect', () => s.write(cmd));
      s.on('data', (d) => {
        reply += d.toString('latin1');
        if (reply.includes('>')) finish(); // prompt = klaar; meteen sluiten, niet wachten op de router
      });
      s.on('close', () => finish());
      s.on('error', finish);
    });
  };
  try {
    // Opdrachten één voor één: de router laat maar weinig gelijktijdige verbindingen toe.
    const turn = beQueue.then(run, run);
    beQueue = turn.catch(() => {});
    await turn;
  } catch (e) {
    const msg = brighteyeError(e);
    log({ dir: 'err', camera, hex: `brighteye: ${JSON.stringify(cmd)}`, text: msg });
    throw new Error(msg);
  }
  return reply;
}

/**
 * Welke camera hoort bij een Brighteye-bron?
 * @param {number} src
 * @returns {string} bv. " (camera 2)" of ""
 */
const camOfSource = (src) => {
  const c = config.cameras.find((x) => (x.beSource ?? -1) === src);
  return c ? ` (${c.name})` : '';
};

/**
 * Schakelt een camera naar de programma-uitgang van de BrightEye NXT en meldt wat de router terugzegt.
 * @param {number} camera
 * @returns {Promise<void>}
 */
/** Camera die als laatste door deze app naar PGM geschakeld werd (voor het geval de BrightEye niet bevraagd kan worden). */
let pgmCam = null;
/** Teller om een lopende, vertraagde schakeling te annuleren zodra er opnieuw geklikt wordt. */
let goSeq = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function brighteyeTake(camera, target = 'pgm') {
  const cam = camById(camera);
  const dest = target === 'pvw' ? Number(config.brighteye.pvwDest ?? 0) : Number(config.brighteye.dest ?? 1);
  const cmd = takeCommand(dest, cam.beSource);
  const reply = await brighteyeExchange(cmd, camera);
  const st = parseStatus(reply)[0];
  if (target !== 'pvw') { pgmCam = cam.id; broadcast('pgm', { camera: cam.id }); }
  log({ dir: 'tx', camera, hex: `brighteye: ${JSON.stringify(cmd)}`, text: `Brighteye: ${cam.name} naar ${target === 'pvw' ? 'PVW (preview)' : 'PGM (programma)'} schakelen (bestemming ${dest})` });
  log({
    dir: 'rx', camera, hex: `brighteye: ${JSON.stringify(reply)}`,
    text: st ? `Brighteye bevestigt: bestemming ${st.dest} staat nu op bron ${st.src}${camOfSource(st.src)}`
      : 'Brighteye heeft de opdracht ontvangen (prompt), maar geeft geen status terug',
  });
}

/**
 * Vraagt de BrightEye welke bron er nu op de programma-uitgang staat.
 * @returns {Promise<void>}
 */
async function brighteyeStatus() {
  // Alle bestemmingen 0-7 opvragen: zo zie je welke uitgang PGM is en welke preview. De ingestelde bestemming staat erbij.
  const mine = Number(config.brighteye.dest ?? 1);
  for (let d = 0; d <= 7; d++) {
    const cmd = statusCommand(d);
    const reply = await brighteyeExchange(cmd);
    const st = parseStatus(reply)[0];
    const tag = d === Number(config.brighteye.pvwDest ?? 0) ? ' ← PVW-bestemming van de app' : d === mine ? ' ← PGM-bestemming van de app' : '';
    log({ dir: 'tx', hex: `brighteye: ${JSON.stringify(cmd)}`, text: `Brighteye: welke bron staat er op bestemming ${d}?` });
    log({
      dir: 'rx', hex: `brighteye: ${JSON.stringify(reply)}`,
      text: st ? `Brighteye: bestemming ${d} staat op bron ${st.src}${camOfSource(st.src)}${tag}`
        : `Brighteye: bestemming ${d} gaf geen status terug (bestaat waarschijnlijk niet)${tag}`,
    });
  }
}

/**
 * Welke camera staat nu op PGM? Vraagt de BrightEye; bij een fout geldt de laatst bekende stand.
 * @returns {Promise<number|null>} camera-id of null als onbekend
 */
async function pgmSource() {
  try {
    const reply = await brighteyeExchange(statusCommand(Number(config.brighteye.dest ?? 1)));
    const st = parseStatus(reply)[0];
    const cam = st && config.cameras.find((c) => (c.beSource ?? -1) === st.src);
    pgmCam = cam ? cam.id : null;
  } catch { /* de fout staat al in het log; we gaan uit van de laatst bekende stand */ }
  broadcast('pgm', { camera: pgmCam });
  return pgmCam;
}

/**
 * Klik op een zetel of zaalknop: preset oproepen en de camera naar PGM schakelen (zonder bevestiging).
 * - Andere camera dan nu op PGM: preset oproepen, `timing.takeDelayMs` wachten tot de camera er staat, dan PGM.
 * - Dezelfde camera die al live staat en er is een alternatief: eerst de alternatieve camera/preset op PGM,
 *   `timing.altHoldMs` later de hoofdcamera, zodat die ongezien kan verplaatsen.
 * - Dezelfde camera zonder alternatief: enkel de preset oproepen (de camera is al live).
 * De opdracht is meteen terug na het oproepen; het vervolg loopt op de achtergrond en vervalt bij een nieuwe klik.
 * @param {{camera:number, preset:number, alt?:{camera:number,preset:number}}} a
 * @returns {Promise<{mode:'direct'|'alt'|'zonder-take', live:number|null}>}
 */
async function goTo({ camera, preset, alt }) {
  const my = ++goSeq;
  const cam = camById(camera);
  const take = config.brighteye.enabled && config.brighteye.host;
  const t = config.timing || {};
  const live = take ? await pgmSource() : null;
  const useAlt = Boolean(take && alt && alt.camera !== cam.id && live === cam.id);
  const failed = (e) => log({ dir: 'err', camera: cam.id, hex: '', text: e.message });
  watcher.noteOwnMove(cam.id);
  if (useAlt) {
    const ac = camById(alt.camera);
    log({ dir: 'info', camera: cam.id, hex: '', text: `${cam.name} staat al live: eerst ${ac.name} (preset ${alt.preset}) op PGM, daarna ${cam.name} (preset ${preset})` });
    await Promise.all([
      sendVisca(ac.id, visca.presetRecall(ac.viscaAddr, alt.preset)),
      sendVisca(cam.id, visca.presetRecall(cam.viscaAddr, preset)),
    ]);
    (async () => {
      await sleep(Number(t.takeDelayMs ?? 1500)); if (my !== goSeq) return;
      await brighteyeTake(ac.id, 'pgm'); if (my !== goSeq) return;
      await sleep(Number(t.altHoldMs ?? 4000)); if (my !== goSeq) return;
      await brighteyeTake(cam.id, 'pgm');
    })().catch(failed);
    return { mode: 'alt', live };
  }
  await sendVisca(cam.id, visca.presetRecall(cam.viscaAddr, preset));
  if (!take) return { mode: 'zonder-take', live };
  if (live !== cam.id) {
    (async () => {
      await sleep(Number(t.takeDelayMs ?? 1500)); if (my !== goSeq) return;
      await brighteyeTake(cam.id, 'pgm');
    })().catch(failed);
  }
  return { mode: 'direct', live };
}

// ---------- Microposten-API (long polling) ----------
/** CoCon-adres uit de config; fout als het niet ingevuld is. */
function micCfg() {
  const c = { host: cleanHost(config.micApi?.host), port: Number(config.micApi?.port) || 8890 };
  if (!c.host) throw new Error('Vul eerst het IP-adres van de CoCon-server in (Instellingen → Microposten)');
  return c;
}
let micKey = '';
/** Herstart de poller alleen als de instellingen ervan veranderd zijn (anders onderbreekt elke bewaring de long poll). */
function restartMicIfChanged() {
  const k = JSON.stringify(config.micApi || {});
  if (k === micKey) return;
  micKey = k;
  micPoller.restart();
}
/** Microposten (zetelnummers) die aan staan, volgens de CoCon API. */
let micState = { active: [] };
/** Elk CoCon-verzoek (volledige URL) en antwoord naar het verkeerslog. */
const micTrace = (dir, text) => log({ dir, hex: '', text });
const micFetch = () => require('./mic-api').tracedFetch(fetch, micTrace);
const micPoller = createPoller({
  fetchImpl: (...a) => micFetch()(...a),
  getConfig: () => ({ ...config.micApi, host: cleanHost(config.micApi?.host) }),
  onChange: (s) => { micState = s; broadcast('mics', s); },
  log: (text, dir) => log({ dir, hex: '', text }),
});

/** Laatst opgehaalde release-info en pad van een gedownloade update. */
let lastUpdate = null;
/** @type {string|null} */
let downloadedUpdate = null;

/**
 * IPC-handlers, per kanaalnaam. Argumenten komen van de UI via preload.js.
 * @type {Record<string, (event: object, arg: any) => any>}
 */
/**
 * Haalt de miniatuur (JPEG) van een BrightEye-bron op via de webinterface (poort 8080, zonder login).
 * @param {number|'pgm'} which camera-id of 'pgm' (de bron die nu op de programma-uitgang staat)
 * @returns {Promise<{src:number, camera:number|null, image:string}>} image is een data-URL
 */
const thumbState = new Map();
const thumbErrCount = new Map();
async function brighteyeThumb(which) {
  const b = config.brighteye;
  const t = b.thumbs || {};
  if (!b.host || t.enabled === false) throw new Error('Miniaturen staan uit of het Brighteye-adres ontbreekt');
  // PGM heeft een eigen bron in de BrightEye (standaard 5); de camera-thumbnails gebruiken het bronnummer van de camera.
  let src; let cam = null;
  if (which === 'pgm') src = Number(t.pgmSrc ?? 5);
  else {
    cam = config.cameras.find((c) => c.id === Number(which));
    if (!cam || cam.beSource === undefined) throw new Error('Camera zonder Brighteye-bronnummer');
    src = cam.beSource;
  }
  const q = new URLSearchParams({ cmd: '2', mcmd: '10', src: String(src) });
  if (t.cpguid) q.set('cpguid', t.cpguid);
  q.set('expire', String(Date.now() + 3600000));
  const url = `http://${b.host}:${Number(t.port) || 8080}/api/?${q}`;
  // De volledige URL komt in het log (te testen in een browser), maar enkel bij de eerste poging en bij elke
  // wijziging tussen gelukt/mislukt per bron; anders vol je het log met elke verversing.
  const note = (state, text) => {
    if (thumbState.get(src) === state && state === 'ok') return;
    if (thumbState.get(src) === state && state === 'err' && thumbErrCount.get(src) > 4) return;
    thumbState.set(src, state);
    thumbErrCount.set(src, state === 'err' ? (thumbErrCount.get(src) || 0) + 1 : 0);
    log({ dir: state === 'ok' ? 'info' : 'err', hex: '', text: `Miniatuur ${which === 'pgm' ? 'PGM' : cam.name} (bron ${src}): ${text}\n${url}` });
  };
  let res;
  try { res = await fetch(url, { signal: AbortSignal.timeout(2500), cache: 'no-store' }); }
  catch (e) { note('err', `geen verbinding (${e.cause?.code || e.name})`); throw new Error(`Miniatuur: geen verbinding (${e.cause?.code || e.name})`); }
  if (!res.ok) { note('err', `HTTP ${res.status}`); throw new Error(`Miniatuur: HTTP ${res.status}`); }
  const type = (res.headers.get('content-type') || '').split(';')[0];
  if (!type.startsWith('image/')) { note('err', `onverwacht antwoord (${type || 'onbekend'})`); throw new Error(`Miniatuur: onverwacht antwoord (${type || 'onbekend'})`); }
  const buf = Buffer.from(await res.arrayBuffer());
  note('ok', 'gelukt');
  return { src, camera: cam ? cam.id : pgmCam, image: `data:${type};base64,${buf.toString('base64')}` };
}

const handlers = {
  'thumb:get': (_e, { camera }) => brighteyeThumb(camera),
  'cfg:get': () => config,
  'cfg:save': (_e, next) => { const was = Boolean(config.debug); saveConfig(next); applyDebug(was); restartMicIfChanged(); return true; },
  'plan:get': () => loadPlan(),
  'plan:import': (_e, p) => importPlan(p),
  'plan:save': (_e, p) => savePlan(p),

  'cam:preset': (_e, { camera, preset }) => sendVisca(camera, visca.presetRecall(camById(camera).viscaAddr, preset)),
  'cam:presetStore': (_e, { camera, preset }) => sendVisca(camera, visca.presetStore(camById(camera).viscaAddr, preset)),
  'cam:home': (_e, { camera }) => sendVisca(camera, visca.home(camById(camera).viscaAddr)),
  'cam:ping': (_e, { camera }) => sendVisca(camera, visca.powerInquiry(camById(camera).viscaAddr)),

  'cam:move': async (_e, { camera, dir, speed }) => {
    const a = camById(camera).viscaAddr;
    watcher.noteOwnMove(camera);
    if (dir === 'stop') clearTimeout(watchdogs.get(camera));
    else armWatchdog(camera, a);
    await sendVisca(camera, visca.panTilt(a, dir, speed));
  },
  'cam:zoom': async (_e, { camera, dir, speed }) => {
    const a = camById(camera).viscaAddr;
    watcher.noteOwnMove(camera);
    if (dir === 'stop') clearTimeout(watchdogs.get(camera));
    else armWatchdog(camera, a);
    await sendVisca(camera, visca.zoom(a, dir, speed));
  },

  'program:switch': (_e, { camera, target }) => brighteyeTake(camera, target === 'pvw' ? 'pvw' : 'pgm'),
  'seat:go': (_e, a) => goTo(a),
  'cam:focus': (_e, { camera }) => sendVisca(camera, visca.focusTrigger(camById(camera).viscaAddr)),
  'mic:state': () => ({ ...micState, running: micPoller.running }),
  // Micro('s) uitschakelen via de CoCon API
  'mic:on': (_e, { seat }) => { const { micOn } = require('./mic-api'); return micOn(micCfg(), seat, micFetch()).then(() => log({ dir: 'info', hex: '', text: `Micropost ${seat} aangezet` })); },
  'mic:off': (_e, { seat }) => { const { micOff } = require('./mic-api'); return micOff(micCfg(), seat, micFetch()).then(() => log({ dir: 'info', hex: '', text: `Micropost ${seat} uitgeschakeld` })); },
  'mic:muteAll': () => { const { micMuteAll } = require('./mic-api'); return micMuteAll(micCfg(), micFetch()).then(() => log({ dir: 'info', hex: '', text: 'Alle microposten uitgeschakeld' })); },
  // Eén keer verbinden met de CoCon API en de huidige microfoonstand tonen (om de instelling te controleren).
  'mic:test': async (_e, c) => {
    const { probe } = require('./mic-api');
    const host = cleanHost(c?.host);
    if (!host) throw new Error('Vul eerst het IP-adres van de CoCon-server in');
    try {
      const r = await probe({ host, port: Number(c.port) || 8890 }, micFetch());
      log({ dir: 'info', hex: '', text: `CoCon API test: verbonden. Microposten aan: ${r.state ? (r.state.active.join(', ') || 'geen') : 'niet leesbaar'} — ruw antwoord: ${r.stateText.replace(/\s+/g, ' ').slice(0, 300)}` });
      return r.state;
    } catch (e) {
      const msg = e.cause?.code === 'ECONNREFUSED' ? `CoCon API weigert de verbinding op ${host}:${c.port || 8890}: is de API ingeschakeld en klopt de poort (8890 of 8990)?` : `CoCon API: ${e.message}${e.cause?.code ? ` (${e.cause.code})` : ''}`;
      log({ dir: 'err', hex: '', text: msg });
      throw new Error(msg);
    }
  },
  // Preset uitproberen: preset oproepen op een camera en (optioneel) die camera naar PVW of PGM schakelen.
  'preset:try': async (_e, { camera, preset, target }) => {
    const n = Number(preset);
    if (!Number.isInteger(n) || n < 0 || n > 254) throw new Error('Presetnummer moet een geheel getal van 0 tot 254 zijn');
    const cam = camById(camera);
    watcher.noteOwnMove(cam.id);
    await sendVisca(cam.id, visca.presetRecall(cam.viscaAddr, n));
    if (target === 'pvw' || target === 'pgm') await brighteyeTake(cam.id, target);
  },
  'program:status': () => brighteyeStatus(),

  'log:history': () => logBuffer,
  'log:open': () => createLogWindow(),
  'debug:set': (_e, { on }) => {
    const was = Boolean(config.debug);
    config.debug = Boolean(on);
    applyDebug(was);
    broadcast('cfg:debug', config.debug); // houdt het vinkje in alle vensters gelijk
  },
  // "Test alle camera's": power-vraag per camera; met debug ook de laatste preset; en de Brighteye-status.
  'test:all': async () => {
    const fail = (id) => (e) => log({ dir: 'err', camera: id, hex: '', text: e.message });
    await Promise.all(config.cameras.map((c) => sendVisca(c.id, visca.powerInquiry(c.viscaAddr)).catch(fail(c.id))));
    if (config.debug) {
      await new Promise((r) => setTimeout(r, 700));
      for (const c of config.cameras) watcher.ask(c.id);
    }
    if (config.brighteye.enabled && config.brighteye.host) await brighteyeStatus().catch(fail());
  },
  'app:info': () => ({ version: app.getVersion(), dataDir: app.getPath('userData') }),

  // Back-up van alle instellingen en koppelingen (config + zittingsplan) als één JSON-bestand.
  'backup:export': () => ({ app: 'grcam', version: app.getVersion(), exportedAt: new Date().toISOString(), config, plan: loadPlan() }),
  'backup:import': (_e, b) => {
    if (!b || b.app !== 'grcam' || !b.config || !Array.isArray(b.config.cameras) || !b.plan || !Array.isArray(b.plan.seats) || !Array.isArray(b.plan.fracties)) {
      throw new Error('Dit is geen geldige back-up van deze app');
    }
    const was = Boolean(config.debug);
    saveConfig(normalizeConfig(b.config));
    restartMicIfChanged();
    store.writeWithBackup(planPath(), JSON.stringify(b.plan));
    applyDebug(was);
    return { config, plan: b.plan };
  },

  'update:check': async () => {
    lastUpdate = await updater.checkLatest({ repo: REPO, current: app.getVersion(), apiBase: process.env.GRCAM_UPDATE_API || updater.API_BASE });
    return lastUpdate;
  },
  'update:install': async () => {
    if (!lastUpdate?.newer || !lastUpdate.asset) throw new Error('Er is geen nieuwe versie om te installeren');
    const dir = process.env.PORTABLE_EXECUTABLE_DIR || app.getPath('downloads');
    const dest = path.join(dir, `PTZ-Backup-${lastUpdate.latest}-portable.exe`);
    const a = lastUpdate.asset;
    await updater.download(a.url, dest, {
      size: a.size, sha256: a.sha256,
      onProgress: (percent) => { if (win && !win.isDestroyed()) win.webContents.send('update:progress', { percent }); },
    });
    downloadedUpdate = dest;
    log({ dir: 'info', hex: '', text: `Update ${lastUpdate.latest} gedownload en gecontroleerd: ${dest}` });
    return { path: dest };
  },
  // Start de gedownloade versie en sluit deze. Enkel het pad dat we zelf hebben gedownload wordt gestart.
  'update:launch': () => {
    if (!downloadedUpdate || !fs.existsSync(downloadedUpdate)) throw new Error('Er is nog geen update gedownload');
    spawn(downloadedUpdate, [], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.quit(), 300);
  },

  'cam:lastPreset': (_e, { camera }) => {
    if (!config.debug) throw new Error('Zet eerst de debugschakelaar aan');
    camById(camera);
    watcher.ask(camera);
  },
};

/** Opent het aparte logvenster (of haalt het naar voren). */
function createLogWindow() {
  if (logWin && !logWin.isDestroyed()) { logWin.focus(); return; }
  logWin = new BrowserWindow({
    width: 1000, height: 650, backgroundColor: '#14171c', title: 'Verkeerslog – PTZ Backup',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  logWin.setMenuBarVisibility(false);
  logWin.loadFile(path.join(__dirname, 'renderer', 'log.html'));
  logWin.on('closed', () => { logWin = null; });
}

/** Maakt het hoofdvenster. De renderer draait zonder Node-toegang (contextIsolation); alles loopt via preload.js. */
function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, backgroundColor: '#14171c',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; if (logWin && !logWin.isDestroyed()) logWin.close(); });
}

app.whenReady().then(() => {
  const moved = store.migrateLegacy(app.getPath('appData'), app.getPath('userData'));
  loadConfig();
  if (moved) log({ dir: 'info', hex: '', text: `Instellingen overgenomen uit ${moved.from}` });
  // Elke handler wordt verpakt zodat fouten als {ok:false, error} bij de UI aankomen en in het log verschijnen.
  for (const [ch, fn] of Object.entries(handlers)) {
    ipcMain.handle(ch, async (e, arg) => {
      try { return { ok: true, data: await fn(e, arg) }; }
      catch (err) { log({ dir: 'err', hex: err.message }); return { ok: false, error: err.message }; }
    });
  }
  createWindow();
  restartMicIfChanged();
  // Stille controle op een nieuwe versie (uitschakelbaar in de instellingen). Installeert nooit vanzelf.
  setTimeout(async () => {
    if (config.updateCheck === false) return;
    try {
      lastUpdate = await updater.checkLatest({ repo: REPO, current: app.getVersion(), apiBase: process.env.GRCAM_UPDATE_API || updater.API_BASE });
      if (lastUpdate.newer && win && !win.isDestroyed()) win.webContents.send('update:available', lastUpdate);
    } catch { /* geen internet in de zaal: stil negeren */ }
  }, 5000);
});

app.on('before-quit', () => micPoller.stop());
app.on('window-all-closed', () => app.quit());
