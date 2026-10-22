'use strict';

/**
 * @file End-to-end test van main.js zonder Electron en zonder hardware: Electron wordt nagebootst,
 * tools/mock-ipl.js speelt IPL + BrightEye, en een tweede "NI-700"-client stuurt een preset-oproep.
 * Controleert: leesbare logregels, debugmodus (laatste preset), BrightEye take en status.
 * Gebruikt poorten 2003-2006 en 5200 op 127.0.0.1. Uitvoeren: `npm run test:e2e`.
 */

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const Module = require('module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grcam-e2e-'));
const appData = path.join(tmp, 'appData');
const downloads = path.join(tmp, 'downloads');
fs.mkdirSync(path.join(appData, 'grcam'), { recursive: true }); // map van een eerdere versie: moet worden overgenomen
fs.mkdirSync(downloads);
fs.writeFileSync(path.join(appData, 'grcam', 'config.json'), JSON.stringify({ view: 'zaal', assign: { z6: { camera: 2, preset: 33 } }, cameras: [{ id: 1, name: 'Oude naam' }] }));
let userData = path.join(tmp, 'default-userdata');
const handlers = {};
const events = [];
let quitCalled = false;
class FakeWindow {
  constructor() { this.webContents = { send: (c, d) => events.push([c, d]) }; }
  setMenuBarVisibility() {}
  loadFile() {}
  isDestroyed() { return false; }
}
const fakeElectron = {
  app: {
    getPath: (n) => ({ appData, userData, downloads }[n]),
    setPath: (n, v) => { if (n === 'userData') userData = v; },
    getVersion: () => '0.3.0',
    whenReady: () => Promise.resolve(),
    on() {},
    quit() { quitCalled = true; },
  },
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
  BrowserWindow: FakeWindow,
};
const origLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? fakeElectron : origLoad.call(this, request, ...rest); };

const quiet = console.log;
console.log = () => {};
require('../tools/mock-ipl');
// console.log blijft stil (de mock logt veel); resultaten gaan via `quiet`.

// Nep-GitHub voor de update-test (moet draaien vóór main.js start, die leest GRCAM_UPDATE_API)
const crypto = require('crypto');
const http = require('http');
const payload = crypto.randomBytes(50000);
let apiBase = '';
const gh = http.createServer((req, res) => {
  if (req.url.endsWith('/releases/latest')) {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({
      tag_name: 'v0.4.0', html_url: 'x', body: 'Nieuwe dingen',
      assets: [{ name: 'PTZ-Backup-0.4.0-portable.exe', browser_download_url: `${apiBase}/asset`, size: payload.length, digest: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}` }],
    }));
  }
  if (req.url === '/asset') return res.end(payload);
  res.statusCode = 404; res.end();
});
gh.listen(0, '127.0.0.1');
apiBase = '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (ch, arg) => {
  const r = await handlers[ch]({}, arg);
  return r;
};
const logs = () => events.filter(([c]) => c === 'log').map(([, e]) => e);

(async () => {
  await new Promise((r) => gh.once('listening', r));
  apiBase = `http://127.0.0.1:${gh.address().port}`;
  process.env.GRCAM_UPDATE_API = apiBase;
  require('../main');
  await sleep(300);

  // 0. Vaste datamap + overname van de oude map
  assert.strictEqual(path.basename(userData), 'GRCam-PTZ');
  const info = (await call('app:info')).data;
  assert.strictEqual(info.version, '0.3.0');
  const start = (await call('cfg:get')).data;
  assert.strictEqual(start.view, 'zaal', 'config uit oude map overgenomen');
  assert.deepStrictEqual(start.assign.z6, { camera: 2, preset: 33 });
  assert.strictEqual(start.cameras.length, 4, 'ontbrekende camera\'s aangevuld');
  assert.strictEqual(start.cameras[0].name, 'Oude naam');
  assert.ok(start.cameras[1].port, 'camera 2 uit de standaard');
  assert.ok(start.brighteye && start.ipl, 'ontbrekende sleutels aangevuld');

  const cfg = (await call('cfg:get')).data;
  cfg.ipl.host = '127.0.0.1';
  cfg.brighteye = { enabled: true, host: '127.0.0.1', port: 5200, dest: 0 };
  cfg.debug = true;
  assert.ok((await call('cfg:save', cfg)).ok);
  await sleep(300);

  // 1. Een andere client ("NI-700") roept preset 21 op; de app moet dat zien en de laatste preset opvragen.
  const ni = net.connect(2002 + 1, '127.0.0.1');
  await new Promise((r) => ni.once('connect', r));
  ni.write(Buffer.from([0x81, 0x01, 0x04, 0x3f, 0x02, 21, 0xff]));
  await sleep(800);
  const last = events.find(([c]) => c === 'lastPreset');
  assert.ok(last, 'lastPreset-event verwacht');
  assert.deepStrictEqual([last[1].camera, last[1].preset], [1, 21]);
  assert.ok(logs().some((l) => l.text === 'Commando uitgevoerd (klaar)'), 'RX in gewone taal');
  assert.ok(logs().some((l) => l.text === 'Laatst opgeroepen preset: 21'));
  assert.ok(logs().some((l) => l.dir === 'tx' && /Vraag: laatst opgeroepen preset\?/.test(l.text)));
  ni.destroy();

  // 2. Test-knop: ping + laatste preset per camera
  events.length = 0;
  for (const id of [1, 2, 3, 4]) assert.ok((await call('cam:ping', { camera: id })).ok);
  await sleep(300);
  assert.strictEqual(logs().filter((l) => l.text === 'Camera is aan').length, 4);
  for (const id of [1, 2, 3, 4]) assert.ok((await call('cam:lastPreset', { camera: id })).ok);
  await sleep(500);
  assert.strictEqual(events.filter(([c]) => c === 'lastPreset').length, 4);

  // 3. Brighteye: take en status
  events.length = 0;
  assert.ok((await call('program:switch', { camera: 2 })).ok);
  assert.ok(logs().some((l) => /Brighteye bevestigt: bestemming 0 staat nu op bron 1 \(Camera 2\)/.test(l.text)), JSON.stringify(logs()));
  events.length = 0;
  assert.ok((await call('program:status')).ok);
  assert.ok(logs().some((l) => /Brighteye bereikbaar: .* bron 1 \(Camera 2\)/.test(l.text)));

  // 4. Brighteye onbereikbaar: leesbare fout
  const bad = (await call('cfg:get')).data;
  bad.brighteye.port = 5999;
  await call('cfg:save', bad);
  const r = await call('program:status');
  assert.ok(!r.ok && /weigert de verbinding/.test(r.error), r.error);

  // 4b. Back-up maken en terugzetten
  const backup = (await call('backup:export')).data;
  assert.strictEqual(backup.app, 'grcam');
  const changed = (await call('cfg:get')).data;
  changed.view = 'ambtenaren';
  await call('cfg:save', changed);
  const restored = await call('backup:import', backup);
  assert.ok(restored.ok);
  assert.strictEqual((await call('cfg:get')).data.view, backup.config.view);
  assert.ok(!(await call('backup:import', { app: 'iets-anders' })).ok);
  assert.ok(fs.readdirSync(path.join(userData, 'backups')).some((n) => n.startsWith('config.json-')), 'automatische back-ups');

  // 4c. Update: controleren, downloaden (grootte + sha256) en pas dan starten
  assert.ok(!(await call('update:install')).ok, 'eerst controleren');
  const u = (await call('update:check')).data;
  assert.ok(u.newer && u.latest === '0.4.0' && u.current === '0.3.0');
  const inst = await call('update:install');
  assert.ok(inst.ok, inst.error);
  assert.ok(fs.readFileSync(inst.data.path).equals(payload));
  assert.strictEqual(path.dirname(inst.data.path), downloads);
  assert.ok(!quitCalled);

  // 5. Debug uit: lastPreset niet meer toegestaan
  bad.debug = false;
  await call('cfg:save', bad);
  assert.ok(!(await call('cam:lastPreset', { camera: 1 })).ok);

  quiet('e2e-main: ok');
  process.exit(0);
})().catch((e) => { quiet(e); process.exit(1); });
