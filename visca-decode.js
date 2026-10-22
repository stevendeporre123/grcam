'use strict';

/**
 * @file Vertaalt VISCA-berichten naar leesbaar Nederlands, voor het verkeerslog.
 * - `describeCommand(buf)`: wat de app naar de camera stuurt (TX).
 * - `describe(msg, query)`: wat de camera terugstuurt (RX); `query` zegt op welke vraag een 4-byte
 *   antwoord (`y0 50 xx FF`) slaat, want dat ziet er voor elke vraag hetzelfde uit.
 * Pure functies, geen afhankelijkheden.
 */

/** Foutcodes uit `y0 6z ee FF`. */
const ERRORS = {
  0x01: 'berichtlengte fout',
  0x02: 'syntaxfout (commando niet begrepen)',
  0x03: 'commandobuffer vol (camera is bezig)',
  0x04: 'commando geannuleerd',
  0x05: 'geen socket (niets om te annuleren)',
  0x41: 'commando nu niet uitvoerbaar',
};

/** Waarden van het power-antwoord. */
const POWER = { 0x02: 'Camera is aan', 0x03: 'Camera staat uit (standby)', 0x04: 'Camera meldt een fout in de voeding' };

/**
 * Beschrijft één compleet bericht van een camera (eindigt op 0xFF).
 * @param {Buffer} m
 * @param {'power'|'memory'|undefined} [query] laatst gestuurde vraag aan die camera
 * @returns {string}
 */
function describe(m, query) {
  if (m.length < 3 || m[m.length - 1] !== 0xff) return 'Onvolledig bericht';
  if (m[0] < 0x90 || (m[0] & 0x0f) !== 0) return 'Onbekend bericht';
  const t = m[1];
  if (m.length === 3 && (t & 0xf0) === 0x40) return 'Camera heeft het commando aanvaard (ontvangen)';
  if (m.length === 3 && (t & 0xf0) === 0x50 && (t & 0x0f) !== 0) return 'Commando uitgevoerd (klaar)';
  if (m.length === 4 && (t & 0xf0) === 0x60) return `Fout: ${ERRORS[m[2]] ?? `code ${m[2].toString(16)}`}`;
  if (m.length === 4 && t === 0x50) {
    if (query === 'memory') return `Laatst opgeroepen preset: ${m[2]}`;
    if (query === 'power') return POWER[m[2]] ?? `Power-status onbekend (${m[2].toString(16)})`;
    return `Antwoord op een vraag (waarde ${m[2]})`;
  }
  return 'Onbekend bericht';
}

/** Pan- en tiltrichting uit de commandobytes. */
const PAN = { 1: 'links', 2: 'rechts' };
const TILT = { 1: 'omhoog', 2: 'omlaag' };

/**
 * Beschrijft een commando dat de app naar de camera stuurt.
 * @param {Buffer} b
 * @returns {string} leeg als het commando niet herkend wordt
 */
function describeCommand(b) {
  if (b[1] === 0x01 && b[2] === 0x04 && b[3] === 0x3f) {
    if (b[4] === 0x02) return `Preset ${b[5]} oproepen`;
    if (b[4] === 0x01) return `Huidige positie opslaan als preset ${b[5]}`;
  }
  if (b[1] === 0x01 && b[2] === 0x06 && b[3] === 0x04) return 'Naar home-positie';
  if (b[1] === 0x01 && b[2] === 0x06 && b[3] === 0x01) {
    const dirs = [PAN[b[6]], TILT[b[7]]].filter(Boolean);
    return dirs.length ? `Draaien ${dirs.join(' en ')}` : 'Draaien stoppen';
  }
  if (b[1] === 0x01 && b[2] === 0x04 && b[3] === 0x07) {
    if (b[4] === 0x00) return 'Zoom stoppen';
    if ((b[4] & 0xf0) === 0x20) return 'Inzoomen';
    if ((b[4] & 0xf0) === 0x30) return 'Uitzoomen';
  }
  if (b[1] === 0x09 && b[2] === 0x04 && b[3] === 0x00) return 'Vraag: staat de camera aan?';
  if (b[1] === 0x09 && b[2] === 0x04 && b[3] === 0x3f) return 'Vraag: laatst opgeroepen preset?';
  return '';
}

/**
 * Welke vraag is dit commando? (voor het duiden van het antwoord)
 * @param {Buffer} b
 * @returns {'power'|'memory'|undefined}
 */
function queryKind(b) {
  if (b[1] === 0x09 && b[2] === 0x04 && b[3] === 0x00) return 'power';
  if (b[1] === 0x09 && b[2] === 0x04 && b[3] === 0x3f) return 'memory';
  return undefined;
}

module.exports = { describe, describeCommand, queryKind };
