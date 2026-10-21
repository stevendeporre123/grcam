'use strict';

/**
 * @file BrightEye NXT: "Generic ASCII" protocol over TCP poort 5200 (handleiding hoofdstuk 6).
 * - Bronnen en bestemmingen starten bij 0 en volgen het Profile dat aan de externe besturing is toegewezen.
 * - Cijfers zijn ASCII-hex. Opdrachten eindigen op CR; de router antwoordt met de prompt '>'.
 * - Spaties in de opdracht (behalve die na '@') zijn niet toegelaten.
 */

/**
 * Bouwt een directe crosspoint-take (level 0): bron -> bestemming.
 * @param {number} dest bestemming (0-gebaseerd, uitgang naar de encoder)
 * @param {number} src bron (0-gebaseerd, volgens het toegewezen Profile)
 * @returns {string} bv. `@ X:0/0,2\r`
 * @throws {Error} als bron of bestemming geen geheel getal 0-65535 is
 */
function takeCommand(dest, src) {
  const d = Number(dest);
  const s = Number(src);
  if (![d, s].every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff)) throw new Error('Ongeldige bron of bestemming');
  return `@ X:0/${d.toString(16)},${s.toString(16)}\r`;
}

module.exports = { takeCommand };
