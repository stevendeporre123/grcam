'use strict';
const assert = require('assert');
const { createTracker, pickAlt } = require('../mic-track');

const calls = [];
const t = createTracker({ follow: (m) => calls.push(m) });

// standaard uit
t.update([5]); assert.deepStrictEqual(calls, []);
// aanzetten volgt het laatst aangezette micro (5)
t.setEnabled(true); assert.deepStrictEqual(calls, [5]);
// nieuw micro erbij: volgt 9
t.update([5, 9]); assert.deepStrictEqual(calls, [5, 9]);
// 9 gaat uit, 5 staat nog aan: volgt het overblijvende
t.update([5]); assert.deepStrictEqual(calls, [5, 9, 5]);
// alles uit: camera blijft staan
t.update([]); assert.deepStrictEqual(calls, [5, 9, 5]);
// zelfde micro opnieuw aan: volgt opnieuw
t.update([5]); assert.deepStrictEqual(calls, [5, 9, 5, 5]);
// handmatige actie pauzeert; uitgaan van een ander micro verandert niets
t.update([5, 7]); assert.deepStrictEqual(calls.slice(-1), [7]);
t.manual(); assert.ok(t.state().paused);
t.update([5]); assert.strictEqual(calls.slice(-1)[0], 7, 'in pauze: geen nieuwe actie');
// een nieuw micro heft de pauze op
t.update([5, 11]); assert.strictEqual(calls.slice(-1)[0], 11); assert.ok(!t.state().paused);
// uitzetten stopt
t.setEnabled(false); const n = calls.length; t.update([3]); assert.strictEqual(calls.length, n);

// alternatief kiezen
const assign = { z1: { camera: 1, preset: 100 }, z2: { camera: 2, preset: 100 }, z3: { camera: 3, preset: 100 }, z4: { camera: 4, preset: 100 } };
const zalen = [{ id: 'z1' }, { id: 'z2' }, { id: 'z3' }, { id: 'z4' }];
assert.deepStrictEqual(pickAlt({ camera: 1, alt: { camera: 4, preset: 8 } }, zalen, assign, 1), { camera: 4, preset: 8 });
assert.deepStrictEqual(pickAlt({ camera: 1 }, zalen, assign, 1), { camera: 2, preset: 100 });
assert.deepStrictEqual(pickAlt({ camera: 1 }, zalen, assign, 2), { camera: 3, preset: 100 }, 'live camera 2 is niet vrij');
assert.strictEqual(pickAlt({ camera: 1 }, [{ id: 'z1' }], assign, 1), undefined);
console.log('mic-track: ok');
