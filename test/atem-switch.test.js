'use strict';

/** Test van atem-switch.js met een nep-ATEM (zelfde interface als atem-connection): verbinden, cut, preview, programma volgen. */
const assert = require('assert');
const EventEmitter = require('events');
const { createAtemSwitch } = require('../atem-switch');

class FakeAtem extends EventEmitter {
  constructor() { super(); FakeAtem.last = this; this.calls = []; this.state = { info: { productIdentifier: 'ATEM Television Studio HD', apiVersion: 131100 }, inputs: { 1: { inputId: 1, longName: 'SDI 1', shortName: 'S1', externalPortType: 1, internalPortType: 0 }, 5: { inputId: 5, longName: 'HDMI 1', shortName: 'H1', externalPortType: 2, internalPortType: 0 }, 1000: { inputId: 1000, longName: 'Color Bars', shortName: 'Bars', externalPortType: 256, internalPortType: 2 } }, settings: { videoMode: 7 }, video: { mixEffects: [{ programInput: 1, previewInput: 2 }] } }; }
  async connect(host) { this.host = host; setTimeout(() => this.emit('connected'), 5); }
  async disconnect() { this.disconnected = true; }
  async changeProgramInput(i, me) { this.calls.push(['pgm', i, me]); this.state.video.mixEffects[me].programInput = i; this.emit('stateChanged', this.state, ['video.mixEffects.0.programInput']); }
  async changePreviewInput(i, me) { this.calls.push(['pvw', i, me]); this.state.video.mixEffects[me].previewInput = i; }
}

(async () => {
  const progs = []; const health = []; const logs = [];
  const sw = createAtemSwitch({ Atem: FakeAtem, log: (m) => logs.push(m), onProgram: (i) => progs.push(i), onHealth: (ok, d) => health.push([ok, d]) });
  assert.strictEqual(sw.program(), null, 'nog niet verbonden');
  await assert.rejects(() => sw.take(5, 'pgm'), /niet ingesteld/);
  sw.connect('10.0.0.9', 0);
  await sw.ready();
  assert.strictEqual(FakeAtem.last.host, '10.0.0.9');
  assert.deepStrictEqual(health.at(-1), [true, '']);
  assert.ok(logs.some((l) => /ATEM verbonden \(ATEM Television Studio HD\)/.test(l)));
  assert.strictEqual(sw.program(), 1);
  const inf = sw.info();
  assert.strictEqual(inf.model, 'ATEM Television Studio HD');
  assert.deepStrictEqual(inf.inputs.map((i) => [i.id, i.name, i.type]), [[1, 'SDI 1', 'SDI'], [5, 'HDMI 1', 'HDMI'], [1000, 'Color Bars', 'kleurbalken']]);
  assert.strictEqual([inf.program, inf.preview].join(), '1,2');
  await sw.take(6, 'pgm');
  await sw.take(7, 'pvw');
  assert.deepStrictEqual(FakeAtem.last.calls, [['pgm', 6, 0], ['pvw', 7, 0]]);
  assert.strictEqual(sw.program(), 6);
  assert.strictEqual(sw.preview(), 7);
  assert.strictEqual(progs.at(-1), 6, 'programma-wijziging wordt gemeld');
  // iemand schakelt aan het toestel zelf
  FakeAtem.last.state.video.mixEffects[0].programInput = 8; FakeAtem.last.emit('stateChanged', FakeAtem.last.state, []);
  assert.strictEqual(progs.at(-1), 8);
  // zelfde host: geen nieuwe verbinding; ander host: oude wordt gesloten
  const first = FakeAtem.last;
  sw.connect('10.0.0.9', 0);
  assert.strictEqual(FakeAtem.last, first);
  sw.connect('10.0.0.10', 0);
  assert.ok(first.disconnected && FakeAtem.last !== first);
  // verbinding valt weg
  await sw.ready();
  FakeAtem.last.emit('disconnected');
  assert.strictEqual(health.at(-1)[0], false);
  assert.match(health.at(-1)[1], /niet bereikbaar/);
  assert.strictEqual(sw.program(), null);
  sw.close();
  console.log('atem-switch: ok');
})().catch((e) => { console.error(e); process.exit(1); });
