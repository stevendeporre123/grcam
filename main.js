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
const net = require('net');
const path = require('path');
const visca = require('./visca');
const { takeCommand } = require('./brighteye');

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
  const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8'));
  try {
    config = { ...defaults, ...JSON.parse(fs.readFileSync(cfgPath(), 'utf8')) };
  } catch {
    config = defaults;
  }
  config.ipl = { ...defaults.ipl, ...config.ipl };
  config.brighteye = { ...defaults.brighteye, ...config.brighteye };
  // Ontbrekende cameravelden (bv. positie op het plan) aanvullen vanuit de standaard.
  config.cameras = config.cameras.map((c) => ({ ...defaults.cameras.find((d) => d.id === c.id), ...c }));
  saveConfig(config);
  return config;
}

/**
 * Bewaart de config op schijf en maakt hem de actieve config.
 * @param {Config} next
 */
function saveConfig(next) {
  config = next;
  fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
  fs.writeFileSync(cfgPath(), JSON.stringify(config, null, 2));
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
    fs.mkdirSync(path.dirname(planPath()), { recursive: true });
    fs.writeFileSync(planPath(), JSON.stringify(plan));
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
  const plan = { ...loadPlan(), fracties: p.fracties, seats: p.seats };
  fs.writeFileSync(planPath(), JSON.stringify(plan));
  return plan;
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
    sock.on('data', (d) => log({ dir: 'rx', camera: camId, hex: visca.toHex(d) }));
    sock.on('error', (e) => { conns.delete(key); reject(e); });
    sock.on('close', () => conns.delete(key));
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
  log({ dir: 'tx', camera: cam.id, hex: visca.toHex(buf) });
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => entry.sock.destroy(), config.ipl.idleCloseMs);
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
 * Schakelt een camera naar de programma-uitgang van de BrightEye NXT.
 * Wacht op de prompt `>` van de router voor de verbinding gesloten wordt.
 * @param {number} camera
 * @returns {Promise<void>}
 */
async function brighteyeTake(camera) {
  const b = config.brighteye;
  if (!b.enabled || !b.host) throw new Error('Brighteye-koppeling is niet ingesteld');
  const cmd = takeCommand(b.dest, camById(camera).beSource);
  await new Promise((resolve, reject) => {
    const s = net.createConnection({ host: b.host, port: b.port });
    let buf = '';
    s.setTimeout(3000, () => s.destroy(new Error('Time-out Brighteye')));
    s.on('connect', () => s.write(cmd));
    s.on('data', (d) => {
      buf += d.toString('latin1');
      log({ dir: 'rx', camera, hex: `brighteye: ${JSON.stringify(d.toString('latin1'))}` });
      if (buf.includes('>')) s.end(); // prompt = klaar voor de volgende opdracht
    });
    s.on('close', resolve);
    s.on('error', reject);
  });
  log({ dir: 'tx', camera, hex: `brighteye: ${JSON.stringify(cmd)}` });
}

/**
 * IPC-handlers, per kanaalnaam. Argumenten komen van de UI via preload.js.
 * @type {Record<string, (event: object, arg: any) => any>}
 */
const handlers = {
  'cfg:get': () => config,
  'cfg:save': (_e, next) => { saveConfig(next); return true; },
  'plan:get': () => loadPlan(),
  'plan:import': (_e, p) => importPlan(p),

  'cam:preset': (_e, { camera, preset }) => sendVisca(camera, visca.presetRecall(camById(camera).viscaAddr, preset)),
  'cam:presetStore': (_e, { camera, preset }) => sendVisca(camera, visca.presetStore(camById(camera).viscaAddr, preset)),
  'cam:home': (_e, { camera }) => sendVisca(camera, visca.home(camById(camera).viscaAddr)),
  'cam:ping': (_e, { camera }) => sendVisca(camera, visca.powerInquiry(camById(camera).viscaAddr)),

  'cam:move': async (_e, { camera, dir, speed }) => {
    const a = camById(camera).viscaAddr;
    if (dir === 'stop') clearTimeout(watchdogs.get(camera));
    else armWatchdog(camera, a);
    await sendVisca(camera, visca.panTilt(a, dir, speed));
  },
  'cam:zoom': async (_e, { camera, dir, speed }) => {
    const a = camById(camera).viscaAddr;
    if (dir === 'stop') clearTimeout(watchdogs.get(camera));
    else armWatchdog(camera, a);
    await sendVisca(camera, visca.zoom(a, dir, speed));
  },

  'program:switch': (_e, { camera }) => brighteyeTake(camera),
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
  loadConfig();
  // Elke handler wordt verpakt zodat fouten als {ok:false, error} bij de UI aankomen en in het log verschijnen.
  for (const [ch, fn] of Object.entries(handlers)) {
    ipcMain.handle(ch, async (e, arg) => {
      try { return { ok: true, data: await fn(e, arg) }; }
      catch (err) { log({ dir: 'err', hex: err.message }); return { ok: false, error: err.message }; }
    });
  }
  createWindow();
});

app.on('window-all-closed', () => app.quit());
