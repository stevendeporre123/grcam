'use strict';

/**
 * @file Tests voor het zittingsplan: unieke ids, SVG-groepen, 180°-spiegeling,
 * camera-markeringen binnen de viewBox, escaping en de standaardconfig.
 * Uitvoeren: `node test/plan.test.js` (of `npm test`).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildPlanSvg, isSpeaker, esc } = require('../renderer/plan-view');

const plan = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plan.default.json'), 'utf8'));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.default.json'), 'utf8'));

// unieke zetel-ids
const ids = plan.seats.map((s) => s.id);
assert.strictEqual(new Set(ids).size, ids.length);

// elke zetel krijgt een groep in de SVG; alleen sprekers zijn aanklikbaar
const { html, viewBox } = buildPlanSvg(plan, { z4: { camera: 2, preset: 21 } });
assert.strictEqual((html.match(/class="seat /g) || []).length, plan.seats.length);
assert.ok(html.includes('camera 2, preset 21'));
assert.ok(viewBox.split(' ').length === 4);
const speakers = plan.seats.filter(isSpeaker);
assert.ok(speakers.length > 50 && speakers.length < plan.seats.length);
assert.ok(!isSpeaker({ naam: 'Fractiemedewerker', groep: 'x' }));
assert.ok(!isSpeaker({ naam: 'Pers', groep: 'Pers' }));
assert.ok(isSpeaker({ naam: 'Pers 1', groep: 'Pers', spreker: true }));
assert.ok(!isSpeaker({ naam: 'Rudy', groep: 'College', spreker: false }));
assert.ok(plan.seats.some((s) => s.id === 'spreker' && isSpeaker(s)));
assert.strictEqual(plan.seats.filter((s) => s.groep === 'Pers' && isSpeaker(s)).length, 3);
assert.ok(isSpeaker({ naam: 'Rudy Coddens', groep: 'College' }));

// gedraaid zicht: posities gespiegeld om het kadermidden, tekst rechtop (geen rotate(180))
const liesbet = plan.seats.find((s) => s.naam === 'Liesbet VERTRIEST');
const fc = plan.decor.frame;
const flipped = buildPlanSvg(plan, {}, { view: 'ambtenaren' });
const tx = (2 * fc.cx - liesbet.cx).toFixed(2);
const ty = (2 * fc.cy - liesbet.cy).toFixed(2);
assert.ok(flipped.html.includes(`translate(${tx} ${ty}) rotate(0)`));
assert.ok(!/rotate\(180\)/.test(flipped.html));
assert.ok(cfg.view === 'ambtenaren');

// camera's als markering op het plan, ook in gedraaid zicht binnen de viewBox
assert.strictEqual(cfg.cameras.filter((c) => c.pos).length, 4);
for (const view of ['zaal', 'ambtenaren']) {
  const r = buildPlanSvg(plan, {}, { view, cameras: cfg.cameras, selCam: 2 });
  assert.strictEqual((r.html.match(/class="cam/g) || []).length, 4);
  assert.ok(r.html.includes('class="cam sel" data-cam="2"'));
  const [x0, , w] = r.viewBox.split(' ').map(Number);
  for (const m of r.html.matchAll(/class="cam[^"]*" data-cam="\d" transform="translate\(([\d.-]+) ([\d.-]+)\)"/g)) {
    assert.ok(Number(m[1]) - 10 >= x0 && Number(m[1]) + 10 <= x0 + w, `camera buiten viewBox (${view})`);
  }
}

// escaping
assert.strictEqual(esc('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');

// configstructuur voor de zaalknoppen
assert.strictEqual(cfg.zaal.length, 2);
assert.deepStrictEqual(cfg.assign, {});

console.log(`plan: ok (${plan.seats.length} zetels, ${speakers.length} sprekers)`);
