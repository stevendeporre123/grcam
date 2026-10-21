'use strict';

/**
 * @file Tests voor visca.js: byte-exacte controle van alle commando's.
 * Uitvoeren: `node test/visca.test.js` (of `npm test`).
 */

const assert = require('assert');
const v = require('../visca');

const hex = (b) => v.toHex(b);

assert.strictEqual(hex(v.presetRecall(1, 5)), '81 01 04 3f 02 05 ff');
assert.strictEqual(hex(v.presetStore(1, 5)), '81 01 04 3f 01 05 ff');
assert.strictEqual(hex(v.home(2)), '82 01 06 04 ff');
assert.strictEqual(hex(v.panTilt(1, 'left', 100)), '81 01 06 01 18 14 01 03 ff');
assert.strictEqual(hex(v.panTilt(1, 'stop')), '81 01 06 01 0a 08 03 03 ff');
assert.strictEqual(hex(v.zoom(1, 'tele', 3)), '81 01 04 07 23 ff');
assert.strictEqual(hex(v.zoom(1, 'wide', 3)), '81 01 04 07 33 ff');
assert.strictEqual(hex(v.zoom(1, 'stop')), '81 01 04 07 00 ff');
assert.strictEqual(hex(v.powerInquiry(1)), '81 09 04 00 ff');
assert.throws(() => v.panTilt(1, 'sideways'));
assert.strictEqual(v.presetRecall(1, 500)[5], 127); // clamp

console.log('visca: ok');
