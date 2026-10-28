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

  // Statusbalk: een gelukt commando maakt de camera 'ok'
  const hl = (await call('health:get')).data;
  assert.ok(Object.values(hl.cams).some((c) => c.ok === true), JSON.stringify(hl));

  // 3d. Autofocus
  logsReset();
  assert.ok((await call('cam:focus', { camera: 2 })).ok);
  assert.ok(logs().some((l) => l.dir === 'tx' && l.text === 'Autofocus uitvoeren'));

  // 3d2. Miniaturen via de webinterface van de BrightEye (poort 8080 in het echt)
  const thumbUrls = [];
  const thSrv = http.createServer((req, res) => {
    thumbUrls.push(req.url);
    res.setHeader('content-type', 'image/jpeg');
    res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  }).listen(0, '127.0.0.1');
  await new Promise((r) => thSrv.on('listening', r));
  const tc = (await call('cfg:get')).data;
  tc.brighteye.thumbs = { enabled: true, port: thSrv.address().port, intervalMs: 3000, cpguid: 'abc-guid' };
  assert.ok((await call('cfg:save', tc)).ok);
  const th1 = await call('thumb:get', { camera: 1 });
  assert.ok(th1.ok && th1.data.image.startsWith('data:image/jpeg;base64,'), JSON.stringify(th1));
  assert.ok(/^\/api\/\?cmd=2&mcmd=10&src=\d+&cpguid=abc-guid&expire=\d+$/.test(thumbUrls[0]), thumbUrls[0]);
  const thp = await call('thumb:get', { camera: 'pgm' });
  assert.ok(thp.ok && thp.data.src === 5, JSON.stringify(thp));
  assert.ok(/src=5&/.test(thumbUrls[thumbUrls.length - 1]), thumbUrls[thumbUrls.length - 1]);
  assert.ok(!(await call('thumb:get', { camera: 99 })).ok);
  assert.ok(logs().some((l) => /Miniatuur .*bron 5.*\nhttp:\/\/127\.0\.0\.1:\d+\/api\/\?cmd=2&mcmd=10&src=5&cpguid=abc-guid&expire=\d+/.test(l.text)), 'volledige URL in het log');
  thSrv.close();

  // 3e. Microposten (CoCon API, long polling) -> 'mics'-event
  let polls = 0;
  const micCalls = [];
  const micSrv = http.createServer((req, res) => {
    const send = (b) => res.end(typeof b === 'string' ? b : JSON.stringify(b));
    if (req.url === '/CoCon/Connect') return send({ Connect: true, id: 'abc' });
    if (req.url.startsWith('/CoCon/Microphone/GetState')) return send({ GetState: { State: { Speakers: [], Requests: [], Replies: [] } } });
    if (req.url.startsWith('/CoCon/Notification/id=abc')) {
      return setTimeout(() => (polls++ < 1 ? send({ MicrophoneState: { Speakers: [12], Requests: [5], Replies: [] } })
        : polls++ < 3 ? send({ MicrophoneState: { Speakers: [12, 30], Requests: [], Replies: [] } }) : null), 30);
    }
    micCalls.push(req.url);
    send('0');
  }).listen(0, '127.0.0.1');
  await new Promise((r) => micSrv.on('listening', r));
  // Tracking: micropost 12 hoort bij een zitplaats met preset; 30 heeft niets
  const tplan = (await call('plan:get')).data;
  const tseat = tplan.seats.find((x) => x.id);
  tseat.mic = 12;
  assert.ok((await call('plan:save', tplan)).ok);
  const tcfg = (await call('cfg:get')).data;
  tcfg.assign[tseat.id] = { camera: 3, preset: 44 };
  assert.ok((await call('cfg:save', tcfg)).ok);
  assert.strictEqual((await call('track:get')).data.enabled, false, 'tracking staat standaard uit');
  assert.ok((await call('track:set', { on: true })).data.enabled);
  logsReset();
  const mc = (await call('cfg:get')).data;
  mc.micApi = { enabled: true, host: '127.0.0.1', port: micSrv.address().port };
  assert.ok((await call('cfg:save', mc)).ok);
  await sleep(1500);
  const mics = events.filter(([c]) => c === 'mics').map(([, d]) => d.active.join(','));
  assert.deepStrictEqual(mics.slice(0, 3), ['', '12', '12,30'], JSON.stringify(mics));
  assert.deepStrictEqual((await call('mic:state')).data.active, [12, 30]);
  assert.ok(logs().some((l) => l.text === `Tracking: micropost 12 = ${tseat.naam}`), 'tracking volgt micro 12');
  assert.ok(logs().some((l) => /geen gekoppelde zitplaats/.test(l.text) && /micropost 30/.test(l.text)), 'micro 30 heeft geen zitplaats');
  assert.ok(events.some(([c, d]) => c === 'track' && d.enabled && d.mic === 12));
  assert.ok(events.some(([c, d]) => c === 'active' && d.id === tseat.id), 'tracking meldt de actieve plaats aan de UI');
  await call('cam:move', { camera: 1, dir: 'stop', speed: 5 }).catch(() => {});
  assert.ok((await call('track:get')).data.paused, 'handmatige actie pauzeert');
  await call('track:set', { on: false });
  assert.ok((await call('mic:on', { seat: 12 })).ok);
  assert.ok((await call('mic:off', { seat: 12 })).ok);
  assert.ok((await call('mic:muteAll')).ok);
  assert.ok(micCalls.includes('/CoCon/Microphone/SetState/?State=On&SeatNr=12') && micCalls.includes('/CoCon/Microphone/SetState/?State=Off&SeatNr=12') && micCalls.includes('/CoCon/Microphone/ClearMicrophoneList/?Type=SpeakersAndRequests'), JSON.stringify(micCalls));
  assert.ok(logs().some((l) => l.dir === 'tx' && l.text.startsWith(`CoCon: GET http://127.0.0.1:${micSrv.address().port}/CoCon/Microphone/SetState/?State=Off&SeatNr=12`)), 'volledige URL in het log');
  assert.ok(logs().some((l) => /^CoCon: HTTP 200 op http:\/\/127\.0\.0\.1:\d+\/CoCon\/Connect/.test(l.text)), 'antwoord in het log');
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

  // 4e. Presets exporteren en op een andere camera terugzetten (nep-IPL houdt pan/tilt/zoom/focus bij)
  process.env.GRCAM_SETTLE_MS = '5';
  const pc = (await call('cfg:get')).data;
  pc.brighteye.enabled = false;
  pc.assign = { z1: { camera: 1, preset: 5, alt: { camera: 4, preset: 8 } } };
  await call('cfg:save', pc);
  for (const [cam, pan, tilt, zoom] of [[1, -500, 120, 7000], [4, 40, -30, 100]]) {
    const a = 0x80 | 1;
    const sock = net.connect(2002 + cam, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    sock.write(Buffer.concat([
      Buffer.from([a, 0x01, 0x06, 0x02, 20, 20, ...[pan, tilt].flatMap((v) => [(v >> 12) & 15, (v >> 8) & 15, (v >> 4) & 15, v & 15]), 0xff]),
      Buffer.from([a, 0x01, 0x04, 0x47, (zoom >> 12) & 15, (zoom >> 8) & 15, (zoom >> 4) & 15, zoom & 15, 0xff]),
      Buffer.from([a, 0x01, 0x04, 0x3f, 0x01, cam === 1 ? 5 : 8, 0xff]),
    ]));
    await sleep(150);
    sock.destroy();
  }
  await call('track:set', { on: true });
  assert.ok(!(await call('presetio:export', { cameras: [1], file: path.join(tmp, 'x.json') })).ok, 'met tracking aan geweigerd');
  await call('track:set', { on: false });
  const outJson = path.join(tmp, 'presets.json');
  const outCsv = path.join(tmp, 'presets.csv');
  const ex = await call('presetio:export', { cameras: 'all', extra: '', file: outJson });
  assert.ok(ex.ok, JSON.stringify(ex));
  assert.strictEqual(ex.data.count, 2);
  const exported = JSON.parse(fs.readFileSync(outJson, 'utf8'));
  assert.strictEqual(exported.app, 'grcam-presets');
  const p5 = exported.presets.find((p) => p.camera === 1 && p.preset === 5);
  assert.deepStrictEqual([p5.pan, p5.tilt, p5.zoom], [-500, 120, 7000]);
  assert.ok(p5.usedBy.length, 'gekoppelde plaats staat erbij');
  const sc = await call('presetio:export', { cameras: [1], all: true, file: path.join(tmp, 'scan.json') });
  assert.ok(sc.ok && sc.data.count === 1 && sc.data.free[1].length === 127 && !sc.data.free[1].includes(5), JSON.stringify(sc.data));
  assert.ok(Array.isArray(JSON.parse(fs.readFileSync(path.join(tmp, 'scan.json'), 'utf8')).free['1']));
  assert.ok(events.some(([c, d]) => c === 'presetio:progress' && d.total === 128 && d.state === 'free'));
  assert.ok((await call('presetio:export', { cameras: [1], extra: '5-6', file: outCsv })).ok);
  assert.ok(/^camera,cameraNaam,preset,pan,tilt,zoom,focus,focusModus,gebruiktDoor/.test(fs.readFileSync(outCsv, 'utf8')));
  assert.ok(!(await call('presetio:export', { cameras: [1], extra: 'abc', file: outCsv })).ok, 'ongeldig bereik');
  // import: camera 1 uit het bestand -> camera 2 (nog leeg), daarna uitlezen via export op camera 2
  const op = await call('presetio:open', { file: outJson });
  assert.ok(op.ok && op.data.presets.length === 2 && op.data.targets.length === 4);
  const im = await call('presetio:import', { file: outJson, map: { 1: 2 } });
  assert.ok(im.ok && im.data.stored === 1 && im.data.warnings.length === 0, JSON.stringify(im));
  const pc2 = (await call('cfg:get')).data;
  pc2.assign = { z1: { camera: 2, preset: 5 } };
  await call('cfg:save', pc2);
  const back = path.join(tmp, 'back.json');
  assert.ok((await call('presetio:export', { cameras: [2], file: back })).ok);
  const b5 = JSON.parse(fs.readFileSync(back, 'utf8')).presets[0];
  assert.deepStrictEqual([b5.pan, b5.tilt, b5.zoom], [-500, 120, 7000], 'preset staat nu ook op camera 2');
  assert.ok(!(await call('presetio:import', { file: outJson, map: { 1: 2, 4: 2 } })).ok, 'dubbele doelcamera geweigerd');

  // 5. Debug uit: lastPreset niet meer toegestaan
  bad.debug = false;
  await call('cfg:save', bad);
  assert.ok(!(await call('cam:lastPreset', { camera: 1 })).ok);

  quiet('e2e-main: ok');
  process.exit(0);
})().catch((e) => { quiet(e); process.exit(1); });
