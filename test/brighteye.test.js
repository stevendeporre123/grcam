'use strict';

/**
 * @file Tests voor brighteye.js: opbouw van de Generic ASCII take-opdracht en validatie.
 * Uitvoeren: `node test/brighteye.test.js` (of `npm test`).
 */

const assert = require('assert');
const { takeCommand, statusCommand, parseStatus } = require('../brighteye');

// voorbeeld uit de handleiding: bron 10 (A) naar bestemming 4
assert.strictEqual(takeCommand(4, 10).toUpperCase(), '@ X:0/4,A\r');
assert.strictEqual(takeCommand(0, 0), '@ X:0/0,0\r');
assert.strictEqual(takeCommand(2, 255), '@ X:0/2,ff\r');
assert.throws(() => takeCommand(-1, 0));
assert.throws(() => takeCommand('x', 0));


// status-vraag en -antwoord (handleiding: `@ X?07` -> `S:07,6`)
assert.strictEqual(statusCommand(7), '@ X?07\r'.replace('X?07', 'X?07'));
assert.throws(() => statusCommand(-1));
assert.deepStrictEqual(parseStatus('S:04,b\r\n>'), [{ dest: 4, src: 11 }]);
assert.deepStrictEqual(parseStatus('S:07,6\r\nS:01,7\r\n>'), [{ dest: 7, src: 6 }, { dest: 1, src: 7 }]);
assert.deepStrictEqual(parseStatus('>'), []);

console.log('brighteye: ok');
