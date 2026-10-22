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
const store = require('./data-store');
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
    log({ dir: 'info', camera: id, hex: '', text: `Laatst opgeroepen preset: ${preset}` });
    if (win && !win.isDestroyed()) win.webContents.send('lastPreset', { t: Date.now(), camera: id, preset });
  },
  log: (msg, id) => log({ dir: 'info', camera: id, hex: '', text: msg }),
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
  store.writeWithBackup(cfgPath(), JSON.stringify(config, null, 2));
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
  if (win && !win.isDestroyed()) win.webContents.send('log', { t: Date.now(), ...entry });
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
    sock.on('close', () => { conns.delete(key); if (config.debug) setTimeout(openDebugConnections, 3000); });
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
    getSocket(config.ipl.host, c.port, c.id).catch((e) => log({ dir: 'err', camera: c.id, hex: `debug: ${e.message}` }));
  }
}

/**
 * Past de debugmodus toe na het bewaren van de config: aan = permanente verbindingen, uit = sluiten.
 * @param {boolean} wasOn
 */
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
async function brighteyeExchange(cmd, camera) {
  const b = config.brighteye;
  if (!b.enabled || !b.host) throw new Error('Brighteye-koppeling is niet ingesteld (Beheer → Instellingen)');
  let reply = '';
  try {
    await new Promise((resolve, reject) => {
      const s = net.createConnection({ host: b.host, port: b.port });
      s.setTimeout(3000, () => s.destroy(new Error('Time-out Brighteye')));
      s.on('connect', () => s.write(cmd));
      s.on('data', (d) => {
        reply += d.toString('latin1');
        if (reply.includes('>')) s.end(); // prompt = klaar voor de volgende opdracht
      });
      s.on('close', resolve);
      s.on('error', reject);
    });
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
async function brighteyeTake(camera) {
  const cam = camById(camera);
  const cmd = takeCommand(config.brighteye.dest, cam.beSource);
  const reply = await brighteyeExchange(cmd, camera);
  const st = parseStatus(reply)[0];
  log({ dir: 'tx', camera, hex: `brighteye: ${JSON.stringify(cmd)}`, text: `Brighteye: ${cam.name} naar de programma-uitgang schakelen` });
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
  const cmd = statusCommand(config.brighteye.dest);
  const reply = await brighteyeExchange(cmd);
  const st = parseStatus(reply)[0];
  log({ dir: 'tx', hex: `brighteye: ${JSON.stringify(cmd)}`, text: 'Brighteye: welke bron staat er op de programma-uitgang?' });
  log({
    dir: 'rx', hex: `brighteye: ${JSON.stringify(reply)}`,
    text: st ? `Brighteye bereikbaar: programma-uitgang (bestemming ${st.dest}) staat op bron ${st.src}${camOfSource(st.src)}`
      : 'Brighteye bereikbaar (prompt ontvangen), maar gaf geen status terug',
  });
}

/** Laatst opgehaalde release-info en pad van een gedownloade update. */
let lastUpdate = null;
/** @type {string|null} */
let downloadedUpdate = null;

/**
 * IPC-handlers, per kanaalnaam. Argumenten komen van de UI via preload.js.
 * @type {Record<string, (event: object, arg: any) => any>}
 */
const handlers = {
  'cfg:get': () => config,
  'cfg:save': (_e, next) => { const was = Boolean(config.debug); saveConfig(next); applyDebug(was); return true; },
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

  'program:switch': (_e, { camera }) => brighteyeTake(camera),
  'program:status': () => brighteyeStatus(),

  'app:info': () => ({ version: app.getVersion(), dataDir: app.getPath('userData') }),

  // Back-up van alle instellingen en koppelingen (config + zittingsplan) als één JSON-bestand.
  'backup:export': () => ({ app: 'grcam', version: app.getVersion(), exportedAt: new Date().toISOString(), config, plan: loadPlan() }),
  'backup:import': (_e, b) => {
    if (!b || b.app !== 'grcam' || !b.config || !Array.isArray(b.config.cameras) || !b.plan || !Array.isArray(b.plan.seats) || !Array.isArray(b.plan.fracties)) {
      throw new Error('Dit is geen geldige back-up van deze app');
    }
    const was = Boolean(config.debug);
    saveConfig(normalizeConfig(b.config));
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

/** Maakt het hoofdvenster. De renderer draait zonder Node-toegang (contextIsolation); alles loopt via preload.js. */
function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, backgroundColor: '#14171c',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
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
  // Stille controle op een nieuwe versie (uitschakelbaar in de instellingen). Installeert nooit vanzelf.
  setTimeout(async () => {
    if (config.updateCheck === false) return;
    try {
      lastUpdate = await updater.checkLatest({ repo: REPO, current: app.getVersion(), apiBase: process.env.GRCAM_UPDATE_API || updater.API_BASE });
      if (lastUpdate.newer && win && !win.isDestroyed()) win.webContents.send('update:available', lastUpdate);
    } catch { /* geen internet in de zaal: stil negeren */ }
  }, 5000);
});

app.on('window-all-closed', () => app.quit());
