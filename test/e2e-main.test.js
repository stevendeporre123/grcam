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
const handlers = {};
const events = [];
class FakeWindow {
  constructor() { this.webContents = { send: (c, d) => events.push([c, d]) }; }
  setMenuBarVisibility() {}
  loadFile() {}
  isDestroyed() { return false; }
}
const fakeElectron = {
  app: { getPath: () => tmp, whenReady: () => Promise.resolve(), on() {}, quit() {} },
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
  BrowserWindow: FakeWindow,
};
const origLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? fakeElectron : origLoad.call(this, request, ...rest); };

const quiet = console.log;
console.log = () => {};
require('../tools/mock-ipl');
require('../main');
// console.log blijft stil (de mock logt veel); resultaten gaan via `quiet`.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (ch, arg) => {
  const r = await handlers[ch]({}, arg);
  return r;
};
const logs = () => events.filter(([c]) => c === 'log').map(([, e]) => e);

(async () => {
  await sleep(300);
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

  // 5. Debug uit: lastPreset niet meer toegestaan
  bad.debug = false;
  await call('cfg:save', bad);
  assert.ok(!(await call('cam:lastPreset', { camera: 1 })).ok);

  quiet('e2e-main: ok');
  process.exit(0);
})().catch((e) => { quiet(e); process.exit(1); });
