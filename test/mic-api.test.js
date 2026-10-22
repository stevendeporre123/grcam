'use strict';
const assert = require('assert');
const http = require('http');
const { extractActive, parseHeaders, createPoller } = require('../mic-api');

// Gangbare vormen
assert.deepStrictEqual(extractActive([12, 5, 12]), [5, 12]);
assert.deepStrictEqual(extractActive({ active: [{ micId: 7 }, { micId: 3 }] }), [3, 7]);
assert.deepStrictEqual(extractActive({ data: { microphones: [{ id: 1, state: 'on' }, { id: 2, state: 'off' }, { id: 3, active: false }, { id: 4, active: true }] } }), [1, 4]);
assert.deepStrictEqual(extractActive({ mics: { 12: true, 15: false, 20: 'on' } }), [12, 20]);
assert.deepStrictEqual(extractActive({ a: { b: { list: [{ seatNumber: '14' }] } } }, { activePath: 'a.b.list' }), [14]);
assert.deepStrictEqual(extractActive({ a: [{ x: 9 }] }, { activePath: 'a', idField: 'x' }), [9]);
assert.deepStrictEqual(extractActive({ nothing: 'here' }), []);
assert.deepStrictEqual(parseHeaders('Authorization: Bearer abc\r\nX-A:b'), { Authorization: 'Bearer abc', 'X-A': 'b' });

// Poller tegen een lokale server die als long poll antwoordt
(async () => {
  let n = 0;
  const bodies = [[{ id: 3 }], [{ id: 3 }], [{ id: 3 }, { id: 8 }], []];
  const srv = http.createServer((req, res) => {
    assert.strictEqual(req.headers['x-test'], 'ja');
    setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ active: bodies[Math.min(n++, bodies.length - 1)] })); }, 30);
  }).listen(0);
  await new Promise((r) => srv.on('listening', r));
  const seen = [];
  const logs = [];
  const cfg = { enabled: true, url: `http://127.0.0.1:${srv.address().port}/`, headers: 'X-Test: ja' };
  const p = createPoller({ getConfig: () => cfg, onChange: (a) => seen.push(a), log: (m, l) => logs.push([l, m]), minGapMs: 20 });
  p.restart();
  await new Promise((r) => setTimeout(r, 600));
  p.stop();
  srv.close();
  assert.deepStrictEqual(seen.slice(0, 3), [[3], [3, 8], []], JSON.stringify(seen)); // geen dubbele meldingen
  assert.ok(logs.some(([, m]) => /actief = 3,\s*8/.test(m)));

  // Onbereikbaar: één foutmelding, geen storm
  const bad = createPoller({ getConfig: () => ({ enabled: true, url: 'http://127.0.0.1:9/' }), onChange: () => {}, log: (m, l) => logs.push([l, m]), minGapMs: 10 });
  bad.restart();
  await new Promise((r) => setTimeout(r, 300));
  bad.stop();
  assert.strictEqual(logs.filter(([l]) => l === 'err').length, 1);
  console.log('mic-api: ok');
})();
