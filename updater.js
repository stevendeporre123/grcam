'use strict';

/**
 * @file Controleert op nieuwe versies via de publieke GitHub Releases en downloadt de portable .exe.
 * Geen Electron-afhankelijkheid: testbaar met een lokale nep-server (`apiBase`).
 * Er wordt niets automatisch geïnstalleerd; main.js start een download pas na een klik van de operator.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');

/** Standaard GitHub-API. */
const API_BASE = 'https://api.github.com';

/**
 * GET met redirects (GitHub verwijst downloads door naar een andere host).
 * @param {string} url
 * @param {{headers?:object, timeout?:number, maxRedirects?:number}} [o]
 * @returns {Promise<import('http').IncomingMessage>}
 */
function get(url, { headers = {}, timeout = 8000, maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('http://') ? http : https;
    const req = lib.get(url, { headers: { 'User-Agent': 'grcam-updater', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (maxRedirects <= 0) return reject(new Error('Te veel doorverwijzingen'));
        return resolve(get(new URL(res.headers.location, url).toString(), { headers, timeout, maxRedirects: maxRedirects - 1 }));
      }
      resolve(res);
    });
    req.setTimeout(timeout, () => req.destroy(new Error('Time-out bij het ophalen van de update-gegevens')));
    req.on('error', reject);
  });
}

/**
 * Splitst "1.2.3" of "v1.2.3-dev.4" in delen.
 * @param {string} v
 * @returns {{nums:number[], pre:string[]}|null}
 */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v));
  return m ? { nums: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] } : null;
}

/**
 * Vergelijkt twee versies (semver, met voorlopige versies lager dan de definitieve).
 * @param {string} a
 * @param {string} b
 * @returns {number} >0 als a nieuwer is dan b, <0 als ouder, 0 als gelijk (of onleesbaar)
 */
function compareVersions(a, b) {
  const x = parseVersion(a); const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]; const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p); const qn = /^\d+$/.test(q);
    if (pn && qn && +p !== +q) return +p - +q;
    if (!(pn && qn) && p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * Haalt de laatste release op.
 * @param {{repo:string, current:string, apiBase?:string}} o  repo = "eigenaar/naam"
 * @returns {Promise<{current:string, latest:string, newer:boolean, notes:string, page:string,
 *   asset:{name:string,url:string,size:number,sha256:string|null}|null}>}
 */
async function checkLatest({ repo, current, apiBase = API_BASE }) {
  const res = await get(`${apiBase}/repos/${repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
  let body = '';
  for await (const c of res) body += c;
  if (res.statusCode !== 200) throw new Error(`GitHub antwoordde met status ${res.statusCode}`);
  const rel = JSON.parse(body);
  const latest = String(rel.tag_name || '').replace(/^v/, '');
  const a = (rel.assets || []).find((x) => /portable\.exe$/i.test(x.name));
  return {
    current, latest, newer: compareVersions(latest, current) > 0, notes: rel.body || '', page: rel.html_url || '',
    asset: a ? { name: a.name, url: a.browser_download_url, size: a.size, sha256: a.digest ? String(a.digest).replace(/^sha256:/, '') : null } : null,
  };
}

/**
 * Downloadt een bestand naar `dest` (via een .part-bestand) en controleert grootte en sha256.
 * @param {string} url
 * @param {string} dest
 * @param {{size?:number, sha256?:string|null, onProgress?:(percent:number)=>void}} [o]
 * @returns {Promise<string>} dest
 */
async function download(url, dest, { size, sha256, onProgress } = {}) {
  const res = await get(url, { timeout: 30000 });
  if (res.statusCode !== 200) throw new Error(`Download mislukt (status ${res.statusCode})`);
  const total = Number(res.headers['content-length']) || size || 0;
  const hash = crypto.createHash('sha256');
  const part = `${dest}.part`;
  const out = fs.createWriteStream(part);
  let got = 0;
  try {
    await new Promise((resolve, reject) => {
      res.on('data', (c) => { hash.update(c); got += c.length; if (total && onProgress) onProgress(Math.round((got / total) * 100)); });
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      res.pipe(out);
    });
    if (size && got !== size) throw new Error(`Download onvolledig (${got} van ${size} bytes)`);
    if (sha256 && hash.digest('hex') !== sha256.toLowerCase()) throw new Error('Controlesom (sha256) klopt niet: download verworpen');
    fs.renameSync(part, dest);
  } catch (e) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw e;
  }
  return dest;
}

module.exports = { API_BASE, compareVersions, checkLatest, download };
