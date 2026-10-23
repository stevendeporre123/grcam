'use strict';
const assert = require('assert');
const http = require('http');
const { parseMicState, probe, createPoller, micOff, micMuteAll } = require('../mic-api');

// Antwoorden zoals in de CoCon API-handleiding (ook de slordige schrijfwijzen)
assert.deepStrictEqual(parseMicState('{"MicrophoneState":{"Speakers":[6],"Requests":[],"Replies":[]}}'), { active: [6] });
assert.deepStrictEqual(parseMicState('{“MicrophoneState”:{“Speakers”:[1,5];”Requests”:[7]}}'), { active: [1, 5] });
assert.deepStrictEqual(parseMicState('{"GetState":{"State":{"Speakers":[5],"Requests":[4],"Replies":[]}}}'), { active: [5] });
assert.deepStrictEqual(parseMicState('{"Get":{"MicrophoneMode":{"MaxNrActive":4,"Mode":"Request"},"State":{"Requests":[],"Speakers":[]}}}'), { active: [] });
assert.strictEqual(parseMicState('{"Notification":"Error 408"}'), null);
assert.strictEqual(parseMicState('{"MicrophoneMode":{"Mode":"Operator"}}'), null);

/** Nep-CoCon: Connect, Unsubscribe, GetState en een Notification die om beurt time-out, een gebeurtenis of een verlopen sessie geeft. */
function fakeCoCon() {
  const calls = [];
  let polls = 0; let sessions = 0;
  const script = ['408', { Speakers: [3], Requests: [] }, { Speakers: [3, 8], Requests: [2] }, '400', { Speakers: [], Requests: [] }];
  const srv = http.createServer((req, res) => {
    calls.push(req.url);
    const send = (b, code = 200) => { res.statusCode = code; res.end(typeof b === 'string' ? b : JSON.stringify(b)); };
    if (req.url === '/CoCon/Connect') return send({ Connect: true, id: `sess-${++sessions}` });
    if (req.url.startsWith('/CoCon/Unsubscribe/')) return send({ UnSubscribe: { result: true } });
    if (req.url === '/CoCon/Microphone/GetState') return send({ GetState: { State: { Speakers: [], Requests: [], Replies: [] } } });
    if (req.url.startsWith('/CoCon/Disconnect/')) return send('0');
    if (req.url === '/CoCon/Microphone/SetState/?State=Off&SeatNr=3') return send('0');
    if (req.url.startsWith('/CoCon/Microphone/SetState/')) return send('1');
    if (req.url === '/CoCon/Microphone/ClearMicrophoneList/?Type=SpeakersAndRequests') return send('0');
    if (req.url.startsWith('/CoCon/Notification/id=')) {
      const step = script[Math.min(polls++, script.length)];
      return setTimeout(() => {
        if (step === undefined) return; // blijft hangen (long poll)
        if (step === '408') return send({ Notification: 'Error 408' }, 408);
        if (step === '400') return send({ Notification: 'Error 400' }, 400);
        send({ MicrophoneState: { ...step, Replies: [] } });
      }, 20);
    }
    send('?', 404);
  });
  return { srv, calls, sessions: () => sessions };
}

(async () => {
  const f = fakeCoCon();
  f.srv.listen(0, '127.0.0.1');
  await new Promise((r) => f.srv.on('listening', r));
  const port = f.srv.address().port;
  const cfg = { enabled: true, host: '127.0.0.1', port };

  await micOff(cfg, 3);
  await assert.rejects(() => micOff(cfg, 99), /ongeldige waarde/);
  await assert.rejects(() => micOff(cfg, 0), /Ongeldig/);
  await micMuteAll(cfg);
  const pr = await probe(cfg);
  assert.deepStrictEqual(pr.state, { active: [] });

  const seen = []; const logs = [];
  const p = createPoller({ getConfig: () => cfg, onChange: (s) => seen.push(s), log: (m, l) => logs.push([l, m]), minGapMs: 10, pollTimeoutMs: 2000 });
  p.restart();
  await new Promise((r) => setTimeout(r, 700));
  p.stop();
  await new Promise((r) => setTimeout(r, 50));
  // eerste stand (leeg), dan [3], dan [3,8]+aanvraag [2]; na de verlopen sessie opnieuw verbonden en leeg
  assert.deepStrictEqual(seen.map((s) => s.active.join(',')).slice(0, 4), ['', '3', '3,8', ''], JSON.stringify(seen));
  assert.ok(f.sessions() >= 3, 'na Error 400 een nieuwe sessie (plus de testsessie)');
  assert.ok(f.calls.some((u) => u.startsWith('/CoCon/Unsubscribe/?Model=Voting&id=')), 'andere modellen uitgeschreven');
  assert.ok(f.calls.some((u) => u.startsWith('/CoCon/Disconnect/')), 'sessie netjes afgesloten');
  assert.ok(!logs.some(([l]) => l === 'err'), JSON.stringify(logs));
  f.srv.close();

  // Onbereikbaar: één foutmelding, geen storm
  const bad = createPoller({ getConfig: () => ({ enabled: true, host: '127.0.0.1', port: 9 }), onChange: () => {}, log: (m, l) => logs.push([l, m]), minGapMs: 10 });
  bad.restart();
  await new Promise((r) => setTimeout(r, 300));
  bad.stop();
  assert.strictEqual(logs.filter(([l]) => l === 'err').length, 1);
  console.log('mic-api: ok');
})();
