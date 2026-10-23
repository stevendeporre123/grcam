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
const logEvents = [];
let quitCalled = false;
let windowsCreated = 0;
class FakeWindow {
  constructor() {
    windowsCreated += 1;
    const sink = windowsCreated === 1 ? events : logEvents; // hoofdvenster en logvenster krijgen elk hun eigen lijst
    this.webContents = { send: (c, d) => sink.push([c, d]) };
  }
  setMenuBarVisibility() {}
  loadFile() {}
  on() {}
  focus() {}
  close() {}
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
const logsReset = () => { for (let i = events.length - 1; i >= 0; i--) if (events[i][0] === 'log') events.splice(i, 1); };

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
  cfg.brighteye = { enabled: true, host: '127.0.0.1', port: 5200, dest: 0, pvwDest: 1 };
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
  assert.ok(logs().some((l) => /Brighteye: bestemming 0 staat op bron 1 \(Camera 2\)/.test(l.text)));

  // 3b. Preset uitproberen: oproepen + naar PVW (bestemming 1 in deze testconfig)
  events.length = 0;
  assert.ok((await call('preset:try', { camera: 3, preset: 7, target: 'pvw' })).ok);
  assert.ok(logs().some((l) => /Camera 3 naar PVW \(preview\) schakelen \(bestemming 1\)/.test(l.text)), JSON.stringify(logs()));
  assert.strictEqual((await call('preset:try', { camera: 3, preset: 999 })).ok, false);
  assert.ok((await call('preset:try', { camera: 3, preset: 7 })).ok);

  // 3c. Klik op een zetel: preset + PGM, met alternatief als dezelfde camera al live staat
  const fast = (await call('cfg:get')).data;
  fast.timing = { takeDelayMs: 40, altHoldMs: 150 };
  assert.ok((await call('cfg:save', fast)).ok);
  logsReset();
  let g = await call('seat:go', { camera: 3, preset: 5 });
  assert.ok(g.ok && g.data.mode === 'direct' && g.data.live === 2, JSON.stringify(g)); // camera 2 staat live (bron 1 op PGM)
  await sleep(200);
  assert.ok(logs().some((l) => /Camera 3 naar PGM \(programma\) schakelen \(bestemming 0\)/.test(l.text)), 'andere camera: take na wachttijd');
  logsReset();
  g = await call('seat:go', { camera: 3, preset: 6, alt: { camera: 4, preset: 9 } });
  assert.strictEqual(g.data.mode, 'alt', JSON.stringify(g));
  await sleep(120);
  assert.ok(logs().some((l) => /Camera 4 naar PGM/.test(l.text)), 'alternatief eerst');
  assert.ok(!logs().some((l) => /Camera 3 naar PGM/.test(l.text)), 'hoofdcamera nog niet');
  await sleep(300);
  assert.ok(logs().some((l) => /Camera 3 naar PGM/.test(l.text)), 'daarna de hoofdcamera');
  // een nieuwe klik annuleert de wachtende schakeling
  logsReset();
  await call('seat:go', { camera: 3, preset: 6, alt: { camera: 4, preset: 9 } });
  await call('seat:go', { camera: 1, preset: 2 });
  await sleep(400);
  assert.ok(!logs().some((l) => /Camera 3 naar PGM/.test(l.text)), 'vervallen schakeling');
  assert.ok(logs().some((l) => /Oude naam naar PGM/.test(l.text)));

  // 3d. Autofocus
  logsReset();
  assert.ok((await call('cam:focus', { camera: 2 })).ok);
  assert.ok(logs().some((l) => l.dir === 'tx' && l.text === 'Autofocus uitvoeren'));

  // 3e. Microposten (CoCon API, long polling) -> 'mics'-event
  let polls = 0;
  const micSrv = http.createServer((req, res) => {
    const send = (b) => res.end(typeof b === 'string' ? b : JSON.stringify(b));
    if (req.url === '/CoCon/Connect') return send({ Connect: true, id: 'abc' });
    if (req.url.startsWith('/CoCon/Microphone/GetState')) return send({ GetState: { State: { Speakers: [], Requests: [], Replies: [] } } });
    if (req.url.startsWith('/CoCon/Notification/id=abc')) {
      return setTimeout(() => (polls++ < 1 ? send({ MicrophoneState: { Speakers: [12], Requests: [5], Replies: [] } })
        : polls++ < 3 ? send({ MicrophoneState: { Speakers: [12, 30], Requests: [], Replies: [] } }) : null), 30);
    }
    send('0');
  }).listen(0, '127.0.0.1');
  await new Promise((r) => micSrv.on('listening', r));
  const mc = (await call('cfg:get')).data;
  mc.micApi = { enabled: true, host: '127.0.0.1', port: micSrv.address().port };
  assert.ok((await call('cfg:save', mc)).ok);
  await sleep(1500);
  const mics = events.filter(([c]) => c === 'mics').map(([, d]) => `${d.active}|${d.requests}`);
  assert.deepStrictEqual(mics.slice(0, 3), ['|', '12|5', '12,30|'], JSON.stringify(mics));
  assert.deepStrictEqual((await call('mic:state')).data.active, [12, 30]);
  const mt = await call('mic:test', { host: '127.0.0.1', port: micSrv.address().port });
  assert.ok(mt.ok && Array.isArray(mt.data.active), JSON.stringify(mt));
  mc.micApi.enabled = false;
  await call('cfg:save', mc);
  micSrv.close();

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

  // 4d. Logvenster, debug aan/uit vanuit een ander venster, en "Test alle camera's" in één keer
  const w0 = windowsCreated;
  assert.ok((await call('log:open')).ok);
  await call('log:open'); // tweede keer: bestaand venster, geen nieuw
  assert.strictEqual(windowsCreated, w0 + 1);
  const ok = await call('cfg:get');
  ok.data.brighteye.port = 5200;
  await call('cfg:save', ok.data);
  assert.ok((await call('debug:set', { on: true })).ok);
  assert.ok(events.some(([c, d]) => c === 'cfg:debug' && d === true));
  await sleep(300);
  events.length = 0;
  assert.ok((await call('test:all')).ok);
  await sleep(1200);
  assert.strictEqual(logs().filter((l) => l.text === 'Camera is aan').length, 4);
  assert.strictEqual(logs().filter((l) => /^Laatst opgeroepen preset: \d+$/.test(l.text)).length, 4);
  assert.ok(logs().some((l) => /Brighteye: bestemming 0 staat op bron/.test(l.text)));
  const hist = (await call('log:history')).data;
  assert.ok(Array.isArray(hist) && hist.length > 10);
  assert.ok(logEvents.some(([c]) => c === 'log'), 'het logvenster krijgt ook de regels');
  assert.ok(!JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')).debug, 'debug wordt niet bewaard');

  // 5. Debug uit: lastPreset niet meer toegestaan
  bad.debug = false;
  await call('cfg:save', bad);
  assert.ok(!(await call('cam:lastPreset', { camera: 1 })).ok);

  quiet('e2e-main: ok');
  process.exit(0);
})().catch((e) => { quiet(e); process.exit(1); });
