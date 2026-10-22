'use strict';

/**
 * @file Tests voor updater.js: versies vergelijken, release ophalen en downloaden (met redirect,
 * grootte- en sha256-controle) tegen een lokale nep-GitHub.
 * Uitvoeren: `node test/updater.test.js` (of `npm test`).
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { compareVersions, checkLatest, download } = require('../updater');

// versies
assert.ok(compareVersions('0.2.0', '0.1.9') > 0);
assert.ok(compareVersions('v1.0.0', '0.9.9') > 0);
assert.ok(compareVersions('0.1.0', '0.1.0-dev.5') > 0, 'definitief > voorlopig');
assert.ok(compareVersions('0.1.0-dev.10', '0.1.0-dev.9') > 0, 'numeriek vergelijken');
assert.ok(compareVersions('0.1.0', '0.1.1') < 0);
assert.strictEqual(compareVersions('0.1.0', '0.1.0'), 0);
assert.strictEqual(compareVersions('rommel', '0.1.0'), 0);

const payload = crypto.randomBytes(200000);
const sha = crypto.createHash('sha256').update(payload).digest('hex');
let base = '';
const server = http.createServer((req, res) => {
  if (req.url === '/repos/o/r/releases/latest') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({
      tag_name: 'v0.4.0', html_url: 'https://example/rel', body: 'Nieuw: dingen',
      assets: [{ name: 'PTZ-Backup-0.4.0-portable.exe', browser_download_url: `${base}/dl`, size: payload.length, digest: `sha256:${sha}` }],
    }));
  }
  if (req.url === '/dl') { res.statusCode = 302; res.setHeader('location', '/real'); return res.end(); } // redirect zoals GitHub
  if (req.url === '/real') return res.end(payload);
  if (req.url === '/bad') return res.end(payload.subarray(0, 1000));
  res.statusCode = 404; res.end();
});

server.listen(0, '127.0.0.1', async () => {
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await checkLatest({ repo: 'o/r', current: '0.3.0', apiBase: base });
    assert.strictEqual(r.latest, '0.4.0');
    assert.ok(r.newer);
    assert.strictEqual(r.notes, 'Nieuw: dingen');
    assert.strictEqual(r.asset.sha256, sha);
    assert.ok(!(await checkLatest({ repo: 'o/r', current: '0.4.0', apiBase: base })).newer);
    await assert.rejects(checkLatest({ repo: 'x/y', current: '0.1.0', apiBase: base }), /404/);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grcam-up-'));
    const dest = path.join(dir, 'new.exe');
    const pct = [];
    await download(r.asset.url, dest, { size: r.asset.size, sha256: r.asset.sha256, onProgress: (p) => pct.push(p) });
    assert.ok(fs.readFileSync(dest).equals(payload));
    assert.strictEqual(pct[pct.length - 1], 100);
    assert.ok(!fs.existsSync(`${dest}.part`));

    // verkeerde sha256 of te kleine download: verworpen en opgeruimd
    const bad = path.join(dir, 'bad.exe');
    await assert.rejects(download(`${base}/real`, bad, { sha256: 'ab'.repeat(32) }), /sha256/);
    await assert.rejects(download(`${base}/bad`, bad, { size: payload.length }), /onvolledig|Download/);
    assert.ok(!fs.existsSync(bad) && !fs.existsSync(`${bad}.part`));

    console.log('updater: ok');
    server.close();
  } catch (e) { console.error(e); process.exit(1); }
});
