'use strict';

/**
 * @file VISCA-commandobouwer (Lumens/Sony-compatibel) voor de PTZ-camera's.
 *
 * Elk commando is een `Buffer` die eindigt op 0xFF. Het eerste byte is `0x80 | adres`
 * (adres 1-7; bij een RS-232 point-to-point verbinding meestal 1).
 * De functies versturen niets: het versturen gebeurt in main.js over de TCP-poort van de IPL.
 *
 * Referentie van de gebruikte commando's:
 *  - Preset oproepen    `8x 01 04 3F 02 pp FF`
 *  - Preset opslaan     `8x 01 04 3F 01 pp FF`
 *  - Home               `8x 01 06 04 FF`
 *  - Pan/tilt           `8x 01 06 01 VV WW 0p 0t FF` (VV pan-snelheid 1-24, WW tilt-snelheid 1-20)
 *  - Zoom               `8x 01 04 07 <00|2s|3s> FF`  (s = snelheid 1-7)
 *  - Power-inquiry      `8x 09 04 00 FF`
 *  - Laatste preset     `8x 09 04 3F FF` (antwoord `y0 50 pp FF`)
 */

/**
 * Headerbyte voor een camera-adres.
 * @param {number} a camera-adres 1-7
 * @returns {number}
 */
const hdr = (a) => 0x80 | (a & 0x07);

/**
 * Rondt af en begrenst een getal; ongeldige invoer wordt 0 (en dan naar `lo` getrokken).
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));

/**
 * Preset oproepen.
 * @param {number} a camera-adres 1-7
 * @param {number} p presetnummer 0-127
 * @returns {Buffer}
 */
const presetRecall = (a, p) => Buffer.from([hdr(a), 0x01, 0x04, 0x3f, 0x02, clamp(p, 0, 127), 0xff]);

/**
 * Huidige camerapositie opslaan in een preset (overschrijft de bestaande).
 * @param {number} a camera-adres 1-7
 * @param {number} p presetnummer 0-127
 * @returns {Buffer}
 */
const presetStore = (a, p) => Buffer.from([hdr(a), 0x01, 0x04, 0x3f, 0x01, clamp(p, 0, 127), 0xff]);

/**
 * Camera naar de home-positie.
 * @param {number} a camera-adres 1-7
 * @returns {Buffer}
 */
const home = (a) => Buffer.from([hdr(a), 0x01, 0x06, 0x04, 0xff]);

/**
 * Richtingscodes voor pan en tilt: [pan, tilt] met 01 = links/omhoog, 02 = rechts/omlaag, 03 = stop.
 * @type {Record<string, [number, number]>}
 */
const DIRS = {
  up: [0x03, 0x01], down: [0x03, 0x02], left: [0x01, 0x03], right: [0x02, 0x03],
  upleft: [0x01, 0x01], upright: [0x02, 0x01], downleft: [0x01, 0x02], downright: [0x02, 0x02],
  stop: [0x03, 0x03],
};

/**
 * Pan/tilt-beweging starten of stoppen. De snelheid (1-100 %) wordt geschaald naar
 * pan 1-24 en tilt 1-20. De camera blijft bewegen tot er een 'stop' volgt.
 * @param {number} a camera-adres 1-7
 * @param {'up'|'down'|'left'|'right'|'upleft'|'upright'|'downleft'|'downright'|'stop'} dir
 * @param {number} [speed=40] 1-100
 * @returns {Buffer}
 * @throws {Error} bij een onbekende richting
 */
function panTilt(a, dir, speed = 40) {
  const d = DIRS[dir];
  if (!d) throw new Error(`Onbekende richting: ${dir}`);
  const s = clamp(speed, 1, 100) / 100;
  const pan = clamp(s * 24, 1, 24);
  const tilt = clamp(s * 20, 1, 20);
  return Buffer.from([hdr(a), 0x01, 0x06, 0x01, pan, tilt, d[0], d[1], 0xff]);
}

/**
 * Zoom starten of stoppen.
 * @param {number} a camera-adres 1-7
 * @param {'tele'|'wide'|'stop'} dir
 * @param {number} [speed=3] 1-7
 * @returns {Buffer}
 * @throws {Error} bij een onbekende zoomrichting
 */
function zoom(a, dir, speed = 3) {
  const sp = clamp(speed, 1, 7);
  const b = dir === 'tele' ? 0x20 | sp : dir === 'wide' ? 0x30 | sp : dir === 'stop' ? 0x00 : null;
  if (b === null) throw new Error(`Onbekende zoomrichting: ${dir}`);
  return Buffer.from([hdr(a), 0x01, 0x04, 0x07, b, 0xff]);
}

/**
 * Eenvoudige inquiry (power) om te testen of de camera antwoordt.
 * @param {number} a camera-adres 1-7
 * @returns {Buffer}
 */
const powerInquiry = (a) => Buffer.from([hdr(a), 0x09, 0x04, 0x00, 0xff]);

/**
 * Vraagt het nummer van de laatst opgeroepen preset op (CAM_MemoryInq). Antwoord: `y0 50 pp FF`.
 * Niet elke camera ondersteunt dit; het nummer is onbetrouwbaar als de camera daarna verstelt is.
 * @param {number} a camera-adres 1-7
 * @returns {Buffer}
 */
const memoryInquiry = (a) => Buffer.from([hdr(a), 0x09, 0x04, 0x3f, 0xff]);

/**
 * Bytes als leesbare hex-string, bv. `81 01 04 3f 02 05 ff` (voor het verkeerslog).
 * @param {Buffer} b
 * @returns {string}
 */
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

/**
 * Autofocus één keer laten uitvoeren (One Push AF Trigger: `8x 01 04 18 01 FF`).
 * @param {number} a camera-adres 1-7
 * @returns {Buffer}
 */
const focusTrigger = (a) => Buffer.from([hdr(a), 0x01, 0x04, 0x18, 0x01, 0xff]);


/** Inquiry: pan/tilt-positie. Antwoord `y0 50 0w 0w 0w 0w 0z 0z 0z 0z FF` (11 bytes). @param {number} a */
const panTiltPosInquiry = (a) => Buffer.from([hdr(a), 0x09, 0x06, 0x12, 0xff]);
/** Inquiry: zoompositie. Antwoord `y0 50 0p 0q 0r 0s FF` (7 bytes). @param {number} a */
const zoomPosInquiry = (a) => Buffer.from([hdr(a), 0x09, 0x04, 0x47, 0xff]);
/** Inquiry: focuspositie. Antwoord `y0 50 0p 0q 0r 0s FF` (7 bytes). @param {number} a */
const focusPosInquiry = (a) => Buffer.from([hdr(a), 0x09, 0x04, 0x48, 0xff]);
/** Inquiry: focusmodus. Antwoord `y0 50 02|03 FF` (02 = auto, 03 = handmatig). @param {number} a */
const focusModeInquiry = (a) => Buffer.from([hdr(a), 0x09, 0x04, 0x38, 0xff]);

/** 16 bits (twee-complement) als vier nibbles, elk in een eigen byte. */
const nib16 = (v) => { const u = (Number(v) & 0xffff); return [(u >> 12) & 0xf, (u >> 8) & 0xf, (u >> 4) & 0xf, u & 0xf]; };

/**
 * Absolute pan/tilt-positie (`8x 01 06 02 VV WW Y Y Y Y Z Z Z Z FF`).
 * @param {number} a camera-adres 1-7
 * @param {number} pan  16-bit waarde (negatief toegestaan)
 * @param {number} tilt 16-bit waarde (negatief toegestaan)
 * @param {number} [speed=20] pan-snelheid 1-24 (tilt volgt)
 * @returns {Buffer}
 */
const panTiltAbsolute = (a, pan, tilt, speed = 20) => Buffer.from([hdr(a), 0x01, 0x06, 0x02, clamp(speed, 1, 24), clamp(speed, 1, 20), ...nib16(pan), ...nib16(tilt), 0xff]);
/** Zoom direct (`8x 01 04 47 0p 0q 0r 0s FF`). @param {number} a @param {number} z 0-65535 */
const zoomDirect = (a, z) => Buffer.from([hdr(a), 0x01, 0x04, 0x47, ...nib16(z), 0xff]);
/** Focus direct (`8x 01 04 48 0p 0q 0r 0s FF`); werkt alleen in handmatige focus. @param {number} a @param {number} f 0-65535 */
const focusDirect = (a, f) => Buffer.from([hdr(a), 0x01, 0x04, 0x48, ...nib16(f), 0xff]);
/** Focusmodus zetten: `auto` of `manual`. @param {number} a @param {'auto'|'manual'} mode */
const focusMode = (a, mode) => Buffer.from([hdr(a), 0x01, 0x04, 0x38, mode === 'manual' ? 0x03 : 0x02, 0xff]);

/** Leest vier nibbles vanaf `off` als getal; `signed` voor pan/tilt. */
const readNib16 = (b, off, signed) => { const u = ((b[off] & 0xf) << 12) | ((b[off + 1] & 0xf) << 8) | ((b[off + 2] & 0xf) << 4) | (b[off + 3] & 0xf); return signed && u > 0x7fff ? u - 0x10000 : u; };
/** Antwoord op de pan/tilt-inquiry. @param {Buffer} b @returns {{pan:number,tilt:number}|null} */
const parsePanTilt = (b) => (b.length === 11 && b[1] === 0x50 ? { pan: readNib16(b, 2, true), tilt: readNib16(b, 6, true) } : null);
/** Antwoord op de zoom- of focus-inquiry. @param {Buffer} b @returns {number|null} */
const parsePos16 = (b) => (b.length === 7 && b[1] === 0x50 ? readNib16(b, 2, false) : null);
/** Antwoord op de focusmodus-inquiry. @param {Buffer} b @returns {'auto'|'manual'|null} */
const parseFocusMode = (b) => (b.length === 4 && b[1] === 0x50 ? (b[2] === 0x03 ? 'manual' : b[2] === 0x02 ? 'auto' : null) : null);

module.exports = { focusTrigger, presetRecall, presetStore, home, panTilt, zoom, powerInquiry, memoryInquiry, toHex,
  panTiltPosInquiry, zoomPosInquiry, focusPosInquiry, focusModeInquiry, panTiltAbsolute, zoomDirect, focusDirect, focusMode,
  parsePanTilt, parsePos16, parseFocusMode };
