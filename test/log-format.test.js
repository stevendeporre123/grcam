'use strict';

/**
 * @file Tests voor renderer/log-format.js: opmaak van een logregel.
 * Uitvoeren: `node test/log-format.test.js` (of `npm test`).
 */

const assert = require('assert');
const { format } = require('../renderer/log-format');

const t = new Date(2026, 9, 22, 10, 32, 36).getTime();
assert.match(format({ t, dir: 'rx', camera: 1, hex: '90 50 02 ff', text: 'Camera is aan' }), /^10:32:36 RX cam1 90 50 02 ff — Camera is aan$/);
assert.match(format({ t, dir: 'info', camera: 2, hex: '', text: 'Geen antwoord' }), /^10:32:36 INFO cam2 Geen antwoord$/);
assert.match(format({ t, dir: 'err', hex: 'x' }), /^10:32:36 ERR x$/);
assert.ok(!/ {2}/.test(format({ t, dir: 'tx', hex: 'a' })), 'geen dubbele spaties');

console.log('log-format: ok');
