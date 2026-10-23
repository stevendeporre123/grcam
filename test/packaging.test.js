'use strict';
/**
 * @file Controleert dat elk lokaal bestand dat main.js/preload.js laadt in de lijst `build.files` van package.json staat.
 * (Een ontbrekend bestand geeft pas in de gebouwde .exe de fout "Cannot find module".)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const files = pkg.build.files;
const listed = (rel) => files.some((f) => f === rel || (f.endsWith('/**') && rel.startsWith(f.slice(0, -2))));

const seen = new Set();
const walk = (rel) => {
  if (seen.has(rel)) return;
  seen.add(rel);
  const src = fs.readFileSync(path.join(root, rel), 'utf8');
  for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
    let target = path.normalize(path.join(path.dirname(rel), m[1])).replace(/\\/g, '/');
    if (!path.extname(target)) target += '.js';
    assert.ok(fs.existsSync(path.join(root, target)), `${rel} laadt ${target}, maar dat bestaat niet`);
    assert.ok(listed(target), `${target} wordt geladen door ${rel} maar staat niet in build.files van package.json`);
    if (target.endsWith('.js')) walk(target);
  }
};
for (const entry of ['main.js', 'preload.js']) walk(entry);
// Bestanden die de pagina's laden
for (const html of fs.readdirSync(path.join(root, 'renderer')).filter((f) => f.endsWith('.html'))) {
  const src = fs.readFileSync(path.join(root, 'renderer', html), 'utf8');
  for (const m of src.matchAll(/(?:src|href)="(\.\.\/[^"]+)"/g)) {
    const target = path.normalize(path.join('renderer', m[1])).replace(/\\/g, '/');
    assert.ok(listed(target), `${target} (nodig voor renderer/${html}) staat niet in build.files`);
  }
}
console.log('packaging: ok');
