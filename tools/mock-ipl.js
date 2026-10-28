'use strict';

/**
 * @file Nep-IPL en nep-BrightEye voor testen zonder hardware.
 *
 * - Poorten 2003-2006 (127.0.0.1): print ontvangen VISCA-bytes en antwoordt met ACK (`x0 41 FF`)
 *   gevolgd door completion (`x0 51 FF`), waarbij x = antwoordadres van de camera.
 * - Beantwoordt ook `8x 09 04 3F FF` (laatste preset) met `y0 50 pp FF`.
 * - Poort 5200 (127.0.0.1): nep-BrightEye (Generic ASCII); elke opdracht eindigt op CR. Een take of status-vraag
 *   (`@ X?0<dest>`) krijgt `S:<niveau><dest>,<bron>` + CRLF, en alles krijgt de prompt '>' terug.
 *
 * Gebruik: `node tools/mock-ipl.js`, en zet in de app (Beheer -> Instellingen) de IPL-host
 * en de BrightEye-host op 127.0.0.1.
 */
const net = require('net');
const { toHex } = require('../visca');

/** Huidige bron per bestemming op de nep-Brighteye. @type {Record<number, number>} */
const beSrc = {};

// Nep-Brighteye (Generic ASCII, poort 5200): elke opdracht eindigt op CR en krijgt de prompt '>' terug.
net.createServer((s) => {
  let buf = '';
  s.on('data', (d) => {
    buf += d.toString('latin1');
    while (buf.includes('\r')) {
      const [cmd, ...rest] = buf.split('\r');
      buf = rest.join('\r');
      console.log(`[5200] rx ${JSON.stringify(cmd)}`);
      const take = /^@ X:0\/([0-9a-f]+),([0-9a-f]+)$/i.exec(cmd);
      const ask = /^@ X\?0([0-9a-f]+)$/i.exec(cmd);
      if (take) beSrc[parseInt(take[1], 16)] = parseInt(take[2], 16);
      const dest = take ? parseInt(take[1], 16) : ask ? parseInt(ask[1], 16) : null;
      // Status Response `S:<niveau><bestemming>,<bron>` + CRLF, daarna de prompt (zoals de echte router)
      if (dest !== null) s.write(`S:0${dest.toString(16)},${(beSrc[dest] ?? 0).toString(16)}\r\n`);
      s.write('>');
    }
  });
}).listen(5200, '127.0.0.1', () => console.log('mock-Brighteye luistert op 5200'));

/** Laatst opgeroepen preset per poort (voor de debug-vraag). @type {Record<number, number>} */
const lastPreset = {};
/** Nep-stand per poort: pan, tilt, zoom, focus, focusmodus en bewaarde presets. @type {Record<number, any>} */
const poses = {};

/**
 * Nep-camera's per poort. Antwoorden gaan naar ALLE verbonden clients op die poort, zoals we vermoeden dat de
 * echte IPL doet met seriële data (ongeverifieerd): zo kan de debugmodus de commando's van een "NI-700" zien.
 * @type {Map<number, Set<net.Socket>>}
 */
const clients = new Map();

for (const port of [2003, 2004, 2005, 2006]) {
  clients.set(port, new Set());
  net.createServer((s) => {
    console.log(`[${port}] verbonden`);
    clients.get(port).add(s);
    const reply = (buf) => clients.get(port).forEach((c) => { if (!c.destroyed && c.writable) c.write(buf); });
    s.on('error', () => clients.get(port).delete(s));
    // Meerdere commando's kunnen in één TCP-pakket binnenkomen: elk bericht (eindigt op FF) apart afhandelen.
    s.on('data', (chunk) => {
      let from = 0;
      for (let i = 0; i < chunk.length; i++) if (chunk[i] === 0xff) { handle(chunk.subarray(from, i + 1)); from = i + 1; }
    });
    const handle = (d) => {
      console.log(`[${port}] rx ${toHex(d)}`);
      const addr = ((d[0] & 0x07) + 8) << 4; // antwoord-adres: camera 1 antwoordt met 0x90
      const pose = (poses[port] ||= { pan: 0, tilt: 0, zoom: 0, focus: 0, mode: 2, presets: {} });
      const nib = (o) => [(o >> 12) & 0xf, (o >> 8) & 0xf, (o >> 4) & 0xf, o & 0xf];
      const rd = (o, signed) => { const u = ((d[o] & 0xf) << 12) | ((d[o + 1] & 0xf) << 8) | ((d[o + 2] & 0xf) << 4) | (d[o + 3] & 0xf); return signed && u > 0x7fff ? u - 0x10000 : u; };
      // Nep-positie: pan/tilt/zoom/focus onthouden, presets bewaren en terugzetten (de beweging is meteen klaar)
      if (d[1] === 0x01 && d[2] === 0x06 && d[3] === 0x02) { pose.pan = rd(6, true); pose.tilt = rd(10, true); }
      if (d[1] === 0x01 && d[2] === 0x04 && d[3] === 0x47) pose.zoom = rd(4);
      if (d[1] === 0x01 && d[2] === 0x04 && d[3] === 0x48 && pose.mode === 3) pose.focus = rd(4);
      if (d[1] === 0x01 && d[2] === 0x04 && d[3] === 0x38) pose.mode = d[4];
      if (d[1] === 0x01 && d[2] === 0x04 && d[3] === 0x3f && d[4] === 0x01) pose.presets[d[5]] = { pan: pose.pan, tilt: pose.tilt, zoom: pose.zoom, focus: pose.focus, mode: pose.mode };
      if (d[1] === 0x01 && d[2] === 0x04 && d[3] === 0x3f && d[4] === 0x02 && pose.presets[d[5]]) Object.assign(pose, pose.presets[d[5]]);
      if (d[1] === 0x09 && d[2] === 0x06 && d[3] === 0x12) return reply(Buffer.from([addr, 0x50, ...nib(pose.pan), ...nib(pose.tilt), 0xff]));
      if (d[1] === 0x09 && d[2] === 0x04 && d[3] === 0x47) return reply(Buffer.from([addr, 0x50, ...nib(pose.zoom), 0xff]));
      if (d[1] === 0x09 && d[2] === 0x04 && d[3] === 0x48) return reply(Buffer.from([addr, 0x50, ...nib(pose.focus), 0xff]));
      if (d[1] === 0x09 && d[2] === 0x04 && d[3] === 0x38) return reply(Buffer.from([addr, 0x50, pose.mode, 0xff]));
      if (d[1] === 0x01 && d[2] === 0x04 && d[3] === 0x3f && d[4] === 0x02) lastPreset[port] = d[5]; // preset-oproep onthouden
      if (d[1] === 0x09 && d[2] === 0x04 && d[3] === 0x3f) return reply(Buffer.from([addr, 0x50, lastPreset[port] ?? 0, 0xff])); // laatste preset
      if (d[1] === 0x09 && d[2] === 0x04 && d[3] === 0x00) return reply(Buffer.from([addr, 0x50, 0x02, 0xff])); // power: aan
      reply(Buffer.from([addr, 0x41, 0xff, addr, 0x51, 0xff]));
    };
    s.on('close', () => { clients.get(port).delete(s); console.log(`[${port}] gesloten`); });
  }).listen(port, '127.0.0.1', () => console.log(`mock-IPL luistert op ${port}`));
}
