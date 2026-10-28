'use strict';

/** Test van preset-io.js: bereiken, serialisatie (JSON/CSV), inlezen met controle en de lees/schrijf-rondgang op een nepcamera. */
const assert = require('assert');
const visca = require('../visca');
const pio = require('../preset-io');

// VISCA-bouwstenen en antwoorden
assert.strictEqual(visca.toHex(visca.panTiltAbsolute(1, -100, 300, 20)), '81 01 06 02 14 14 0f 0f 09 0c 00 01 02 0c ff');
assert.deepStrictEqual(visca.parsePanTilt(Buffer.from([0x90, 0x50, 0x0f, 0x0f, 0x09, 0x0c, 0x00, 0x01, 0x02, 0x0c, 0xff])), { pan: -100, tilt: 300 });
assert.strictEqual(visca.parsePanTilt(Buffer.from([0x90, 0x41, 0xff])), null);
assert.strictEqual(visca.parsePos16(Buffer.from([0x90, 0x50, 1, 2, 3, 4, 0xff])), 0x1234);
assert.strictEqual(visca.parseFocusMode(Buffer.from([0x90, 0x50, 3, 0xff])), 'manual');
assert.strictEqual(visca.parseFocusMode(Buffer.from([0x90, 0x50, 2, 0xff])), 'auto');
assert.strictEqual(visca.toHex(visca.zoomDirect(2, 0x4000)), '82 01 04 47 04 00 00 00 ff');
assert.strictEqual(visca.toHex(visca.focusMode(1, 'manual')), '81 01 04 38 03 ff');

// bereik
assert.deepStrictEqual(pio.parseRange('1-3, 9;5 3'), [1, 2, 3, 5, 9]);
assert.deepStrictEqual(pio.parseRange(''), []);
assert.throws(() => pio.parseRange('x'), /Ongeldig/);
assert.throws(() => pio.parseRange('5-2'), /Ongeldig/);
assert.throws(() => pio.parseRange('200'), /Ongeldig/);

// koppelingen (hoofd + alternatief + zaalknop)
const linked = pio.linkedPresets({ zaal: [{ id: 'zaal1', label: 'Zaal 1' }], assign: { z1: { camera: 1, preset: 5, alt: { camera: 2, preset: 6 } }, zaal1: { camera: 1, preset: 9 } } }, (id) => `Plek ${id}`);
assert.deepStrictEqual([...linked.get(1).keys()], [5, 9]);
assert.deepStrictEqual(linked.get(2).get(6), ['Plek z1 (alternatief)']);
assert.deepStrictEqual(linked.get(1).get(9), ['Zaal 1']);

// serialisatie: rondgang JSON en CSV (met komma en aanhalingsteken in de naam)
const data = { cameras: [{ id: 1, name: 'Cam, "links"' }], presets: [
  { camera: 1, preset: 5, pan: -100, tilt: 300, zoom: 4096, focus: 1000, focusMode: 'manual', usedBy: ['A', 'B (alternatief)'] },
  { camera: 1, preset: 6, pan: 0, tilt: 0, zoom: 0, focus: 77, focusMode: 'auto', usedBy: [] }] };
for (const f of ['json', 'csv']) {
  const back = pio.parse(pio.serialize(data, f));
  assert.deepStrictEqual(back.presets, data.presets, f);
  assert.strictEqual(back.cameras[0].id, 1);
}
assert.strictEqual(pio.parse(pio.serialize(data, 'csv')).cameras[0].name, 'Cam, "links"');
// puntkomma-CSV (Excel in NL) en BOM
const semi = '﻿camera;preset;pan;tilt;zoom\r\n2;7;10;-20;30\r\n';
assert.deepStrictEqual(pio.parse(semi).presets[0], { camera: 2, preset: 7, pan: 10, tilt: -20, zoom: 30, focus: null, focusMode: null, usedBy: [] });

// foutieve invoer
assert.throws(() => pio.parse(''), /leeg/);
assert.throws(() => pio.parse('{"app":"iets"}'), /geen presetexport/);
assert.throws(() => pio.parse('camera,preset,pan\r\n1,1,1'), /mist de kolom/);
assert.throws(() => pio.parse('camera,preset,pan,tilt,zoom\r\n1,200,0,0,0'), /buiten 0-127/);
assert.throws(() => pio.parse('camera,preset,pan,tilt,zoom\r\n1,1,x,0,0'), /pan is geen getal/);

// rondgang op een nepcamera in het geheugen: export van camera A, import op een lege camera B
function fakeCam(initial = {}) {
  const st = { pan: 0, tilt: 0, zoom: 0, focus: 0, mode: 'auto', presets: { ...initial } };
  return st;
}
function wire(cams) {
  const apply = (st, b) => {
    if (b[3] === 0x02 && b[2] === 0x06) { st.pan = visca.parsePanTilt(Buffer.from([0x90, 0x50, ...b.slice(6, 14), 0xff])).pan; st.tilt = visca.parsePanTilt(Buffer.from([0x90, 0x50, ...b.slice(6, 14), 0xff])).tilt; }
    else if (b[2] === 0x04 && b[3] === 0x47) st.zoom = visca.parsePos16(Buffer.from([0x90, 0x50, ...b.slice(4, 8), 0xff]));
    else if (b[2] === 0x04 && b[3] === 0x48 && st.mode === 'manual') st.focus = visca.parsePos16(Buffer.from([0x90, 0x50, ...b.slice(4, 8), 0xff]));
    else if (b[2] === 0x04 && b[3] === 0x38) st.mode = b[4] === 3 ? 'manual' : 'auto';
    else if (b[2] === 0x04 && b[3] === 0x3f && b[4] === 1) st.presets[b[5]] = { pan: st.pan, tilt: st.tilt, zoom: st.zoom, focus: st.focus, mode: st.mode };
    else if (b[2] === 0x04 && b[3] === 0x3f && b[4] === 2) Object.assign(st, st.presets[b[5]]);
  };
  const nib = (v) => [(v >> 12) & 15, (v >> 8) & 15, (v >> 4) & 15, v & 15];
  return {
    send: async (cam, b) => apply(cams[cam], b),
    query: async (cam, b, parse) => {
      const st = cams[cam];
      const reply = b[3] === 0x12 ? Buffer.from([0x90, 0x50, ...nib(st.pan & 0xffff), ...nib(st.tilt & 0xffff), 0xff])
        : b[3] === 0x47 ? Buffer.from([0x90, 0x50, ...nib(st.zoom), 0xff])
          : b[3] === 0x48 ? Buffer.from([0x90, 0x50, ...nib(st.focus), 0xff])
            : Buffer.from([0x90, 0x50, st.mode === 'manual' ? 3 : 2, 0xff]);
      return parse(reply);
    },
    addrOf: () => 1, nameOf: (c) => `Cam ${c}`, sleep: async () => {},
  };
}
(async () => {
  const cams = { 1: fakeCam({ 5: { pan: -1200, tilt: 340, zoom: 9000, focus: 4321, mode: 'manual' }, 6: { pan: 50, tilt: -60, zoom: 0, focus: 100, mode: 'auto' } }), 2: fakeCam() };
  const io = pio.createPresetIO(wire(cams));
  const rows = await io.exportCamera(1, [5, 6], new Map([[5, ['Rudy']]]));
  assert.deepStrictEqual(rows.map((r) => [r.preset, r.pan, r.tilt, r.zoom, r.focus, r.focusMode]), [[5, -1200, 340, 9000, 4321, 'manual'], [6, 50, -60, 0, 100, 'auto']]);
  assert.deepStrictEqual(rows[0].usedBy, ['Rudy']);
  const parsed = pio.parse(pio.serialize({ cameras: [{ id: 1, name: 'A' }], presets: rows }, 'csv'));
  const res = await io.importRows(2, parsed.presets);
  assert.strictEqual(res.stored, 2);
  assert.deepStrictEqual(res.warnings, []);
  assert.deepStrictEqual(cams[2].presets[5], { pan: -1200, tilt: 340, zoom: 9000, focus: 4321, mode: 'manual' });
  assert.strictEqual(cams[2].presets[6].mode, 'auto');
  // een camera die nooit stilstaat geeft een foutmelding
  let n = 0;
  const w = wire(cams);
  const io2 = pio.createPresetIO({ ...w, settleMaxMs: 0, query: async (c, b, p) => { n += 1; return b[3] === 0x12 ? { pan: n * 100, tilt: 0 } : b[3] === 0x47 ? 0 : p(Buffer.from([0x90, 0x50, 3, 0xff])); } });
  await assert.rejects(() => io2.exportCamera(1, [5]), /komt niet tot stilstand/);
  console.log('preset-io: ok');
})().catch((e) => { console.error(e); process.exit(1); });
