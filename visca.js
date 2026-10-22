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

module.exports = { focusTrigger, presetRecall, presetStore, home, panTilt, zoom, powerInquiry, memoryInquiry, toHex };
