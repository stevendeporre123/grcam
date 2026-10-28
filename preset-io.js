'use strict';

/**
 * @file Import/export van camerapresets (positie, zoom, focus) naar JSON of CSV, bv. om alle presets van een
 * vervangen camera over te zetten. Alleen wat VISCA kan uitlezen en terugschrijven zit erin: pan/tilt, zoom,
 * focuspositie en focusmodus. Beeldinstellingen (belichting, witbalans, ...) horen niet bij een VISCA-preset.
 *
 * De module kent geen sockets: `createPresetIO` krijgt `send(camId, buf)` en `query(camId, buf, parse)` aangereikt.
 */

const visca = require('./visca');

const FORMAT_VERSION = 1;
const CSV_HEADER = ['camera', 'cameraNaam', 'preset', 'pan', 'tilt', 'zoom', 'focus', 'focusModus', 'gebruiktDoor'];

/**
 * Leest "1-5, 9, 100" als lijst presetnummers (0-127, uniek, oplopend).
 * @param {string} text
 * @returns {number[]}
 */
function parseRange(text) {
  const out = new Set();
  for (const part of String(text || '').split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`Ongeldig presetbereik: "${part}"`);
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (a > 127 || b > 127 || b < a) throw new Error(`Ongeldig presetbereik: "${part}" (toegestaan: 0-127)`);
    for (let i = a; i <= b; i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

/**
 * Presets die in de configuratie aan een plaats of zaalknop gekoppeld zijn, per camera, met wie ze gebruikt.
 * @param {{assign:Record<string,any>, zaal?:{id:string,label:string}[]}} cfg
 * @param {(seatId:string)=>string} [labelOf]  leesbare naam van een zetel-id
 * @returns {Map<number, Map<number,string[]>>} camera -> preset -> gebruikers
 */
function linkedPresets(cfg, labelOf = (id) => id) {
  const zl = new Map((cfg.zaal || []).map((z) => [z.id, z.label]));
  const out = new Map();
  const add = (cam, preset, who) => {
    if (!Number.isInteger(Number(cam)) || !Number.isInteger(Number(preset))) return;
    if (!out.has(cam)) out.set(cam, new Map());
    const m = out.get(cam);
    if (!m.has(preset)) m.set(preset, []);
    m.get(preset).push(who);
  };
  for (const [id, a] of Object.entries(cfg.assign || {})) {
    if (!a) continue;
    const name = zl.get(id) || labelOf(id);
    add(a.camera, a.preset, name);
    const alt = a.alt;
    if (alt && alt.camera != null && alt.preset != null) add(alt.camera, alt.preset, `${name} (alternatief)`);
  }
  return out;
}

/** @param {any} v @returns {string} */
const csvCell = (v) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",;\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * @param {{cameras:{id:number,name:string}[], presets:any[], exportedAt?:string}} data
 * @param {'json'|'csv'} format
 * @returns {string}
 */
function serialize(data, format) {
  if (format === 'csv') {
    const names = new Map(data.cameras.map((c) => [c.id, c.name]));
    const lines = [CSV_HEADER.join(',')];
    for (const p of data.presets) {
      lines.push([p.camera, names.get(p.camera) || '', p.preset, p.pan, p.tilt, p.zoom, p.focus, p.focusMode, (p.usedBy || []).join(' | ')].map(csvCell).join(','));
    }
    return `${lines.join('\r\n')}\r\n`;
  }
  return JSON.stringify({ app: 'grcam-presets', version: FORMAT_VERSION, exportedAt: data.exportedAt || new Date().toISOString(), cameras: data.cameras, presets: data.presets }, null, 2);
}

/** Splitst één CSV-regel (komma of puntkomma als scheider, aanhalingstekens ondersteund). */
function splitCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  const sep = (text.split(/\r?\n/, 1)[0].match(/;/g) || []).length > (text.split(/\r?\n/, 1)[0].match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

const num = (v, what, row) => {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n)) throw new Error(`Rij ${row}: ${what} is geen getal`);
  return n;
};

/**
 * Leest JSON of CSV (herkend aan de inhoud) en controleert de rijen.
 * @param {string} text
 * @returns {{cameras:{id:number,name:string}[], presets:{camera:number,preset:number,pan:number,tilt:number,zoom:number,focus:number|null,focusMode:'auto'|'manual'|null,usedBy:string[]}[]}}
 */
function parse(text) {
  const t = String(text || '').replace(/^﻿/, '').trim();
  if (!t) throw new Error('Het bestand is leeg');
  let raw;
  if (t.startsWith('{')) {
    let j;
    try { j = JSON.parse(t); } catch (e) { throw new Error(`Geen geldige JSON: ${e.message}`); }
    if (j.app !== 'grcam-presets') throw new Error('Dit bestand is geen presetexport van deze app');
    if (j.version > FORMAT_VERSION) throw new Error(`Bestandsversie ${j.version} is nieuwer dan deze app begrijpt`);
    raw = (j.presets || []).map((p) => ({ ...p }));
    var cams = Array.isArray(j.cameras) ? j.cameras.map((c) => ({ id: Number(c.id), name: String(c.name ?? '') })) : [];
  } else {
    const rows = splitCsv(t);
    const head = rows.shift().map((h) => h.trim());
    const col = (n) => head.indexOf(n);
    for (const need of ['camera', 'preset', 'pan', 'tilt', 'zoom']) if (col(need) < 0) throw new Error(`CSV mist de kolom "${need}"`);
    const get = (r, n) => (col(n) >= 0 ? (r[col(n)] ?? '').trim() : '');
    raw = rows.map((r) => ({ camera: get(r, 'camera'), cameraNaam: get(r, 'cameraNaam'), preset: get(r, 'preset'), pan: get(r, 'pan'), tilt: get(r, 'tilt'), zoom: get(r, 'zoom'), focus: get(r, 'focus'), focusMode: get(r, 'focusModus'), usedBy: get(r, 'gebruiktDoor') ? get(r, 'gebruiktDoor').split(' | ') : [] }));
    const seen = new Map();
    for (const r of raw) if (r.camera !== '' && !seen.has(Number(r.camera))) seen.set(Number(r.camera), r.cameraNaam || `Camera ${r.camera}`);
    var cams = [...seen].map(([id, name]) => ({ id, name }));
  }
  if (!raw.length) throw new Error('Het bestand bevat geen presets');
  const presets = raw.map((p, i) => {
    const row = i + 1;
    const preset = num(p.preset, 'preset', row);
    if (!Number.isInteger(preset) || preset < 0 || preset > 127) throw new Error(`Rij ${row}: preset ${preset} ligt buiten 0-127`);
    const mode = p.focusMode === 'manual' || p.focusMode === 'auto' ? p.focusMode : null;
    const focus = p.focus === '' || p.focus === null || p.focus === undefined ? null : num(p.focus, 'focus', row);
    return {
      camera: num(p.camera, 'camera', row), preset,
      pan: num(p.pan, 'pan', row), tilt: num(p.tilt, 'tilt', row), zoom: num(p.zoom, 'zoom', row),
      focus, focusMode: mode, usedBy: Array.isArray(p.usedBy) ? p.usedBy.map(String) : [],
    };
  });
  const ids = new Set(presets.map((p) => p.camera));
  const cameras = cams.length ? cams.filter((c) => ids.has(c.id)) : [];
  for (const id of ids) if (!cameras.some((c) => c.id === id)) cameras.push({ id, name: `Camera ${id}` });
  return { cameras, presets };
}

/**
 * @param {{ send:(camId:number,buf:Buffer)=>Promise<void>, query:(camId:number,buf:Buffer,parse:(b:Buffer)=>any,timeoutMs?:number)=>Promise<any>,
 *   addrOf:(camId:number)=>number, nameOf:(camId:number)=>string, sleep?:(ms:number)=>Promise<void>, log?:(msg:string,camId?:number)=>void,
 *   settleMs?:number, settleMaxMs?:number }} deps
 */
function createPresetIO(deps) {
  const { send, query, addrOf, nameOf } = deps;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.log || (() => {});
  const settleMs = deps.settleMs ?? 400;
  const settleMaxMs = deps.settleMaxMs ?? 15000;
  const PT_TOL = 3;
  const Z_TOL = 8;

  /** Leest pan/tilt/zoom. */
  async function readPose(cam) {
    const a = addrOf(cam);
    const pt = await query(cam, visca.panTiltPosInquiry(a), visca.parsePanTilt);
    const zoom = await query(cam, visca.zoomPosInquiry(a), visca.parsePos16);
    return { pan: pt.pan, tilt: pt.tilt, zoom };
  }
  const near = (x, y) => Math.abs(x.pan - y.pan) <= PT_TOL && Math.abs(x.tilt - y.tilt) <= PT_TOL && Math.abs(x.zoom - y.zoom) <= Z_TOL;

  /** Wacht tot de stand twee metingen na elkaar gelijk is (de camera staat stil). */
  async function settle(cam) {
    let prev = await readPose(cam);
    const t0 = Date.now();
    for (;;) {
      await sleep(settleMs);
      const cur = await readPose(cam);
      if (near(prev, cur)) return cur;
      if (Date.now() - t0 > settleMaxMs) throw new Error(`${nameOf(cam)}: de camera komt niet tot stilstand`);
      prev = cur;
    }
  }

  /**
   * Leest de opgegeven presets van één camera uit door ze op te roepen en de stand te meten.
   * @param {number} cam
   * @param {number[]} presets
   * @param {Map<number,string[]>} [usedBy]
   * @param {(p:{camera:number,done:number,total:number,preset:number})=>void} [onProgress]
   */
  async function exportCamera(cam, presets, usedBy = new Map(), onProgress = () => {}) {
    const a = addrOf(cam);
    const rows = [];
    let done = 0;
    for (const preset of presets) {
      onProgress({ camera: cam, done, total: presets.length, preset });
      await send(cam, visca.presetRecall(a, preset));
      const pose = await settle(cam);
      const focus = await query(cam, visca.focusPosInquiry(a), visca.parsePos16);
      const focusMode = await query(cam, visca.focusModeInquiry(a), visca.parseFocusMode);
      rows.push({ camera: cam, preset, ...pose, focus, focusMode, usedBy: usedBy.get(preset) || [] });
      done += 1;
    }
    onProgress({ camera: cam, done, total: presets.length, preset: null });
    log(`${nameOf(cam)}: ${rows.length} presets uitgelezen`, cam);
    return rows;
  }

  /**
   * Schrijft rijen naar een doelcamera: stand instellen, afwachten, controleren en daarna als preset opslaan.
   * @param {number} cam doelcamera
   * @param {ReturnType<typeof parse>['presets']} rows
   * @param {(p:{camera:number,done:number,total:number,preset:number|null})=>void} [onProgress]
   * @returns {Promise<{stored:number, warnings:string[]}>}
   */
  async function importRows(cam, rows, onProgress = () => {}) {
    const a = addrOf(cam);
    const warnings = [];
    let done = 0;
    for (const r of rows) {
      onProgress({ camera: cam, done, total: rows.length, preset: r.preset });
      if (r.focusMode === 'manual' && r.focus !== null) {
        await send(cam, visca.focusMode(a, 'manual'));
        await send(cam, visca.focusDirect(a, r.focus));
      } else if (r.focusMode === 'auto') {
        await send(cam, visca.focusMode(a, 'auto'));
      }
      await send(cam, visca.panTiltAbsolute(a, r.pan, r.tilt));
      await send(cam, visca.zoomDirect(a, r.zoom));
      const got = await settle(cam);
      if (!near(got, r)) warnings.push(`${nameOf(cam)} preset ${r.preset}: stand wijkt af (gevraagd ${r.pan}/${r.tilt}/${r.zoom}, gemeten ${got.pan}/${got.tilt}/${got.zoom})`);
      await send(cam, visca.presetStore(a, r.preset));
      done += 1;
    }
    onProgress({ camera: cam, done, total: rows.length, preset: null });
    log(`${nameOf(cam)}: ${done} presets opgeslagen${warnings.length ? `, ${warnings.length} waarschuwing(en)` : ''}`, cam);
    return { stored: done, warnings };
  }

  return { exportCamera, importRows, settle, readPose };
}

module.exports = { parseRange, linkedPresets, serialize, parse, createPresetIO, FORMAT_VERSION, CSV_HEADER };
