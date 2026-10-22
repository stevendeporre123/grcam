'use strict';

/**
 * @file Leest de microposten-API (long polling) uit en meldt welke microposten actief zijn.
 *
 * De exacte vorm van het antwoord hangt van de API af. Daarom is de uitlezing tolerant en instelbaar:
 *  - `activePath`: punt-pad naar de lijst/het object met actieve microposten (bv. `data.activeMicrophones`);
 *    leeg = automatisch zoeken.
 *  - `idField`: veld met het micropostnummer als de lijst uit objecten bestaat (leeg = gangbare namen proberen).
 * Het ruwe antwoord komt (ingekort) in het verkeerslog zodat de instelling bijgestuurd kan worden.
 * De module kent geen Electron; `fetch` en timers zijn vervangbaar (testbaar).
 */

const ID_KEYS = ['mic', 'micId', 'micNumber', 'microphone', 'microphoneId', 'microphoneNumber', 'seat', 'seatNumber', 'unit', 'unitId', 'unitNumber', 'delegate', 'delegateId', 'participant', 'participantId', 'number', 'id'];
const STATE_KEYS = ['active', 'isActive', 'on', 'isOn', 'micOn', 'microphoneOn', 'state', 'status', 'enabled'];
const OFF_WORDS = /^(off|inactive|idle|false|0|muted|closed|requested|queued|waiting)$/i;
const LIST_KEYS = /(active|open|on|speaking|speak|talk|mic|microphone|unit|delegate|participant)/i;

/** Waarde uit een object via een punt-pad (`a.b.0.c`). */
const getPath = (obj, p) => String(p).split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** Is dit item "aan"? Items zonder statusveld tellen als aan (ze staan in een lijst van actieve). */
function isOn(item) {
  for (const k of STATE_KEYS) {
    if (!(k in item)) continue;
    const v = item[k];
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return !OFF_WORDS.test(v.trim());
  }
  return true;
}

/** Haalt een micropostnummer uit een item (getal, tekst of object). @returns {number|null} */
function toId(item, idField) {
  if (typeof item === 'number' && Number.isFinite(item)) return item;
  if (typeof item === 'string' && /^\d+$/.test(item.trim())) return Number(item);
  if (item && typeof item === 'object') {
    const keys = idField ? [idField] : ID_KEYS;
    for (const k of keys) {
      const v = getPath(item, k);
      if ((typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && /^\d+$/.test(v.trim()))) return Number(v);
    }
  }
  return null;
}

/** Zet een knoop (lijst, object-map of enkel item) om naar actieve nummers. */
function fromNode(node, idField) {
  const out = [];
  if (Array.isArray(node)) {
    for (const it of node) {
      if (it && typeof it === 'object' && !isOn(it)) continue;
      const id = toId(it, idField);
      if (id !== null) out.push(id);
    }
  } else if (node && typeof node === 'object') {
    const own = toId(node, idField);
    const vals = Object.entries(node);
    // {"12": true, "15": false} of {"12": {...}}
    if (vals.length && vals.every(([k]) => /^\d+$/.test(k))) {
      for (const [k, v] of vals) if (v && (typeof v !== 'object' || isOn(v)) && !(typeof v === 'string' && OFF_WORDS.test(v))) out.push(Number(k));
    } else if (own !== null && isOn(node)) out.push(own);
  } else {
    const id = toId(node, idField);
    if (id !== null) out.push(id);
  }
  return out;
}

/**
 * Bepaalt welke microposten actief zijn in een API-antwoord.
 * @param {any} json antwoord (al geparsed)
 * @param {{activePath?:string, idField?:string}} [o]
 * @returns {number[]} gesorteerde, unieke micropostnummers
 */
function extractActive(json, { activePath = '', idField = '' } = {}) {
  let ids = [];
  if (activePath) {
    ids = fromNode(getPath(json, activePath), idField);
  } else {
    // Automatisch: zoek eerst een lijst of map onder een sleutel die "actief/open/mic/…" heet, anders de hoofdlijst.
    const cands = [];
    const walk = (n, depth) => {
      if (depth > 4 || n == null || typeof n !== 'object') return;
      for (const [k, v] of Object.entries(n)) {
        if (v && typeof v === 'object' && LIST_KEYS.test(k)) cands.push(v);
        walk(v, depth + 1);
      }
    };
    if (Array.isArray(json)) cands.unshift(json);
    walk(json, 0);
    for (const c of cands) { ids = fromNode(c, idField); if (ids.length) break; }
  }
  return [...new Set(ids)].sort((a, b) => a - b);
}

/** Zet "Naam: waarde"-regels om naar een headers-object. @param {string} text */
function parseHeaders(text) {
  const h = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) h[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return h;
}

/**
 * Maakt de poller. Eén verzoek tegelijk; zodra het antwoord binnen is volgt het volgende (long polling).
 * @param {object} o
 * @param {() => {enabled:boolean,url:string,headers?:string,activePath?:string,idField?:string,timeoutMs?:number}} o.getConfig
 * @param {(active:number[]) => void} o.onChange  alleen bij een wijziging
 * @param {(msg:string, level:'info'|'err') => void} o.log
 * @param {typeof fetch} [o.fetchImpl]
 * @param {number} [o.minGapMs=400]  minimale tijd tussen twee verzoeken (voorkomt bestoken bij snelle antwoorden)
 * @param {number} [o.maxBackoffMs=30000]
 */
function createPoller({ getConfig, onChange, log, fetchImpl = fetch, minGapMs = 400, maxBackoffMs = 30000 }) {
  let running = false;
  let gen = 0;
  let ctrl = null;
  let last = null;
  let errLogged = false;

  async function loop(my) {
    let backoff = 2000;
    while (running && my === gen) {
      const c = getConfig();
      if (!c.enabled || !c.url) break;
      const t0 = Date.now();
      try {
        ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), c.timeoutMs || 60000);
        let res;
        try { res = await fetchImpl(c.url, { headers: parseHeaders(c.headers), signal: ctrl.signal }); } finally { clearTimeout(timer); }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch { throw new Error(`Antwoord is geen JSON: ${text.slice(0, 120)}`); }
        const active = extractActive(json, c);
        if (errLogged) { log('Microposten-API opnieuw bereikbaar', 'info'); errLogged = false; }
        backoff = 2000;
        const key = active.join(',');
        if (key !== last) {
          log(`Microposten-API: actief = ${active.length ? active.join(', ') : 'geen'} — ruw antwoord: ${text.replace(/\s+/g, ' ').slice(0, 300)}`, 'info');
          last = key;
          onChange(active);
        }
      } catch (e) {
        if (!running || my !== gen) break;
        const msg = e.name === 'AbortError' ? 'time-out' : e.message;
        if (e.name !== 'AbortError') {
          if (!errLogged) { log(`Microposten-API niet bereikbaar of onbruikbaar: ${msg}; nieuwe pogingen op de achtergrond`, 'err'); errLogged = true; }
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, maxBackoffMs);
          continue;
        }
      }
      const wait = minGapMs - (Date.now() - t0);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }

  return {
    /** (Her)start volgens de actuele config; doet niets als de koppeling uitstaat. */
    restart() {
      this.stop();
      const c = getConfig();
      if (!c.enabled || !c.url) return;
      running = true; last = null; errLogged = false;
      loop(++gen);
    },
    stop() { running = false; gen++; try { ctrl?.abort(); } catch { /* al klaar */ } if (last !== null) { last = null; onChange([]); } },
    get running() { return running; },
  };
}

module.exports = { extractActive, parseHeaders, createPoller };
