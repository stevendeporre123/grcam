'use strict';

/**
 * @file Tests voor host.js: ingetypte adressen opschonen.
 * Uitvoeren: `node test/host.test.js` (of `npm test`).
 */

const assert = require('assert');
const { cleanHost } = require('../host');

assert.strictEqual(cleanHost('10.0.28.152'), '10.0.28.152');
assert.strictEqual(cleanHost('http://10.0.28.152/'), '10.0.28.152');
assert.strictEqual(cleanHost(' https://brighteye.local/pad?x=1 '), 'brighteye.local');
assert.strictEqual(cleanHost('10.0.28.152:5200'), '10.0.28.152');
assert.strictEqual(cleanHost(''), '');
assert.strictEqual(cleanHost(undefined), '');

console.log('host: ok');
