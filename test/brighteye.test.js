'use strict';

/**
 * @file Tests voor brighteye.js: opbouw van de Generic ASCII take-opdracht en validatie.
 * Uitvoeren: `node test/brighteye.test.js` (of `npm test`).
 */

const assert = require('assert');
const { takeCommand } = require('../brighteye');

// voorbeeld uit de handleiding: bron 10 (A) naar bestemming 4
assert.strictEqual(takeCommand(4, 10).toUpperCase(), '@ X:0/4,A\r');
assert.strictEqual(takeCommand(0, 0), '@ X:0/0,0\r');
assert.strictEqual(takeCommand(2, 255), '@ X:0/2,ff\r');
assert.throws(() => takeCommand(-1, 0));
assert.throws(() => takeCommand('x', 0));

console.log('brighteye: ok');
