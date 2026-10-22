'use strict';

/**
 * @file Tests voor data-store.js: vaste datamap, migratie van oudere mappen en roterende back-ups.
 * Uitvoeren: `node test/data-store.test.js` (of `npm test`).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../data-store');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grcam-ds-'));
const target = store.dataDir(root);
assert.strictEqual(path.basename(target), store.DATA_NAME);

// niets te migreren
assert.strictEqual(store.migrateLegacy(root, target), null);

// migratie vanuit een oudere map; bestaande data in de nieuwe map wordt nooit overschreven
const old = path.join(root, 'grcam');
fs.mkdirSync(old);
fs.writeFileSync(path.join(old, 'config.json'), '{"a":1}');
fs.writeFileSync(path.join(old, 'plan.json'), '{"b":2}');
const moved = store.migrateLegacy(root, target);
assert.deepStrictEqual(moved.files, ['config.json', 'plan.json']);
assert.strictEqual(fs.readFileSync(path.join(target, 'config.json'), 'utf8'), '{"a":1}');
fs.writeFileSync(path.join(old, 'config.json'), '{"a":999}');
assert.strictEqual(store.migrateLegacy(root, target), null);
assert.strictEqual(fs.readFileSync(path.join(target, 'config.json'), 'utf8'), '{"a":1}');

// back-ups: enkel bij een wijziging, en begrensd
const f = path.join(target, 'config.json');
store.writeWithBackup(f, '{"a":1}', 3); // identiek: geen back-up
assert.ok(!fs.existsSync(path.join(target, 'backups')));
for (let i = 2; i <= 8; i++) store.writeWithBackup(f, `{"a":${i}}`, 3);
const bak = fs.readdirSync(path.join(target, 'backups'));
assert.strictEqual(bak.length, 3, 'enkel de laatste 3 bewaren');
assert.strictEqual(fs.readFileSync(f, 'utf8'), '{"a":8}');
assert.ok(bak.every((n) => n.startsWith('config.json-') && n.endsWith('.bak')));

console.log('data-store: ok');
