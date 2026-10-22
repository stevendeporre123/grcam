'use strict';

/**
 * @file Tests voor visca-decode.js: berichten en commando's in gewone taal.
 * Uitvoeren: `node test/visca-decode.test.js` (of `npm test`).
 */

const assert = require('assert');
const { describe, describeCommand, queryKind } = require('../visca-decode');
const v = require('../visca');
const B = (...x) => Buffer.from(x);

assert.match(describe(B(0x90, 0x41, 0xff)), /aanvaard/);
assert.match(describe(B(0x90, 0x51, 0xff)), /uitgevoerd/);
assert.strictEqual(describe(B(0x90, 0x50, 0x02, 0xff), 'power'), 'Camera is aan');
assert.match(describe(B(0x90, 0x50, 0x03, 0xff), 'power'), /uit/);
assert.strictEqual(describe(B(0x90, 0x50, 0x15, 0xff), 'memory'), 'Laatst opgeroepen preset: 21');
assert.match(describe(B(0x90, 0x50, 0x15, 0xff)), /waarde 21/);
assert.match(describe(B(0x90, 0x60, 0x02, 0xff)), /syntaxfout/);
assert.match(describe(B(0x90, 0x61, 0x41, 0xff)), /niet uitvoerbaar/);
assert.match(describe(B(0x90, 0x50)), /Onvolledig/);
assert.match(describe(B(0x12, 0x34, 0xff)), /Onbekend/);

assert.strictEqual(describeCommand(v.presetRecall(1, 21)), 'Preset 21 oproepen');
assert.match(describeCommand(v.presetStore(1, 5)), /opslaan als preset 5/);
assert.match(describeCommand(v.home(1)), /home/);
assert.strictEqual(describeCommand(v.panTilt(1, 'left', 50)), 'Draaien links');
assert.strictEqual(describeCommand(v.panTilt(1, 'upright', 50)), 'Draaien rechts en omhoog');
assert.strictEqual(describeCommand(v.panTilt(1, 'stop')), 'Draaien stoppen');
assert.strictEqual(describeCommand(v.zoom(1, 'tele')), 'Inzoomen');
assert.strictEqual(describeCommand(v.zoom(1, 'wide')), 'Uitzoomen');
assert.strictEqual(describeCommand(v.zoom(1, 'stop')), 'Zoom stoppen');
assert.match(describeCommand(v.powerInquiry(1)), /aan/);
assert.match(describeCommand(v.memoryInquiry(1)), /laatst/);

assert.strictEqual(queryKind(v.powerInquiry(1)), 'power');
assert.strictEqual(queryKind(v.memoryInquiry(1)), 'memory');
assert.strictEqual(queryKind(v.presetRecall(1, 1)), undefined);

console.log('visca-decode: ok');
