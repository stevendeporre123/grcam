'use strict';

/**
 * @file Tests voor debug-watch.js: berichten splitsen, completion herkennen, de vraag "laatste preset"
 * pas na een completion sturen, het antwoord doorgeven en geen lus veroorzaken.
 * Uitvoeren: `node test/debug-watch.test.js` (of `npm test`).
 */

const assert = require('assert');
const { createWatcher, splitMessages, isCompletion } = require('../debug-watch');
const visca = require('../visca');

// splitsen over meerdere brokken
let r = splitMessages(Buffer.alloc(0), Buffer.from([0x90, 0x41, 0xff, 0x90, 0x51]));
assert.strictEqual(r.messages.length, 1);
r = splitMessages(r.rest, Buffer.from([0xff]));
assert.deepStrictEqual([...r.messages[0]], [0x90, 0x51, 0xff]);

// completion vs. inquiry-antwoord vs. ACK
assert.ok(isCompletion(Buffer.from([0x90, 0x51, 0xff])));
assert.ok(isCompletion(Buffer.from([0xa0, 0x52, 0xff])));
assert.ok(!isCompletion(Buffer.from([0x90, 0x41, 0xff])), 'ACK is geen completion');
assert.ok(!isCompletion(Buffer.from([0x90, 0x50, 0x07, 0xff])), 'inquiry-antwoord is geen completion');

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

(async () => {
  const written = [];
  const got = [];
  const logs = [];
  const w = createWatcher({
    getCamera: () => ({ viscaAddr: 1 }),
    write: (id, buf) => written.push([id, visca.toHex(buf)]),
    onLast: (id, p) => got.push([id, p]),
    log: (m) => logs.push(m),
    delayMs: 20, replyTimeoutMs: 80, suppressMs: 100,
  });

  // uitgeschakeld: niets doen
  w.feed(1, Buffer.from([0x90, 0x51, 0xff]));
  await sleep(50);
  assert.strictEqual(written.length, 0);

  // ingeschakeld: completion -> vraag -> antwoord
  w.setEnabled(true);
  await sleep(120); // eventuele onderdrukking uit vorige stap is niet van toepassing
  w.feed(2, Buffer.from([0x90, 0x41, 0xff])); // ACK alleen: geen vraag
  await sleep(50);
  assert.strictEqual(written.length, 0);
  w.feed(2, Buffer.from([0x90, 0x41, 0xff, 0x90, 0x51, 0xff]));
  await sleep(50);
  assert.deepStrictEqual(written, [[2, '81 09 04 3f ff']]);
  w.feed(2, Buffer.from([0x90, 0x50, 0x15, 0xff])); // preset 21
  assert.deepStrictEqual(got, [[2, 0x15]]);

  // het antwoord zelf lokt geen nieuwe vraag uit
  await sleep(60);
  assert.strictEqual(written.length, 1);

  // geen antwoord: time-out wordt gelogd
  w.feed(3, Buffer.from([0x90, 0x51, 0xff]));
  await sleep(150);
  assert.strictEqual(written.length, 2);
  assert.ok(logs.some((m) => m.includes("Geen antwoord")));

  // een 4-byte bericht zonder openstaande vraag (bv. power-inquiry-antwoord) wordt genegeerd
  w.feed(1, Buffer.from([0x90, 0x50, 0x02, 0xff]));
  assert.strictEqual(got.length, 1);

  // eigen beweging: completion kort erna negeren
  w.noteOwnMove(4);
  w.feed(4, Buffer.from([0x90, 0x51, 0xff]));
  await sleep(50);
  assert.strictEqual(written.length, 2);

  console.log('debug-watch: ok');
})().catch((e) => { console.error(e); process.exit(1); });
