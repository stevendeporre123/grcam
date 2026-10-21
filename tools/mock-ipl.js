'use strict';

/**
 * @file Nep-IPL en nep-BrightEye voor testen zonder hardware.
 *
 * - Poorten 2003-2006 (127.0.0.1): print ontvangen VISCA-bytes en antwoordt met ACK (`x0 41 FF`)
 *   gevolgd door completion (`x0 51 FF`), waarbij x = antwoordadres van de camera.
 * - Poort 5200 (127.0.0.1): nep-BrightEye (Generic ASCII); elke opdracht eindigt op CR en krijgt '>' terug.
 *
 * Gebruik: `node tools/mock-ipl.js`, en zet in de app (Beheer -> Instellingen) de IPL-host
 * en de BrightEye-host op 127.0.0.1.
 */
const net = require('net');
const { toHex } = require('../visca');

// Nep-Brighteye (Generic ASCII, poort 5200): elke opdracht eindigt op CR en krijgt de prompt '>' terug.
net.createServer((s) => {
  let buf = '';
  s.on('data', (d) => {
    buf += d.toString('latin1');
    while (buf.includes('\r')) {
      const [cmd, ...rest] = buf.split('\r');
      buf = rest.join('\r');
      console.log(`[5200] rx ${JSON.stringify(cmd)}`);
      s.write('>');
    }
  });
}).listen(5200, '127.0.0.1', () => console.log('mock-Brighteye luistert op 5200'));

for (const port of [2003, 2004, 2005, 2006]) {
  net.createServer((s) => {
    console.log(`[${port}] verbonden`);
    s.on('data', (d) => {
      console.log(`[${port}] rx ${toHex(d)}`);
      const addr = ((d[0] & 0x07) + 8) << 4; // antwoord-adres: camera 1 antwoordt met 0x90
      s.write(Buffer.from([addr, 0x41, 0xff, addr, 0x51, 0xff]));
    });
    s.on('close', () => console.log(`[${port}] gesloten`));
  }).listen(port, '127.0.0.1', () => console.log(`mock-IPL luistert op ${port}`));
}
