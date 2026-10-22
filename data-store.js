'use strict';

/**
 * @file Vaste opslagplaats voor config en zittingsplan, los van de programmaversie.
 *
 * - De datamap heeft een vaste naam (`DATA_NAME`) in %APPDATA%, onafhankelijk van pakketnaam of versie, zodat een
 *   nieuwe .exe altijd dezelfde gegevens vindt.
 * - Eenmalige migratie vanuit mappen die eerdere versies gebruikten (`LEGACY_NAMES`).
 * - Elke wijziging bewaart eerst de vorige versie in `backups/` (de laatste `KEEP` blijven over).
 */

const fs = require('fs');
const path = require('path');

/** Naam van de datamap in %APPDATA%. */
const DATA_NAME = 'GRCam-PTZ';
/** Mappen die eerdere versies gebruikten (afhankelijk van de pakketnaam). */
const LEGACY_NAMES = ['ptz-backup', 'grcam', 'PTZ Backup', 'PTZ-Backup'];
/** Aantal bewaarde back-ups per bestand. */
const KEEP = 20;

/**
 * @param {string} appDataDir  %APPDATA% (Electron: app.getPath('appData'))
 * @returns {string} pad naar de vaste datamap
 */
const dataDir = (appDataDir) => path.join(appDataDir, DATA_NAME);

/**
 * Kopieert config.json en plan.json van een oudere map naar de nieuwe als daar nog niets staat.
 * @param {string} appDataDir
 * @param {string} target de nieuwe datamap
 * @returns {{from:string, files:string[]}|null} wat gekopieerd is, of null
 */
function migrateLegacy(appDataDir, target) {
  if (fs.existsSync(path.join(target, 'config.json'))) return null;
  for (const name of LEGACY_NAMES) {
    const dir = path.join(appDataDir, name);
    if (path.resolve(dir) === path.resolve(target) || !fs.existsSync(path.join(dir, 'config.json'))) continue;
    fs.mkdirSync(target, { recursive: true });
    const files = ['config.json', 'plan.json'].filter((f) => fs.existsSync(path.join(dir, f)));
    for (const f of files) fs.copyFileSync(path.join(dir, f), path.join(target, f));
    return { from: dir, files };
  }
  return null;
}

/**
 * Schrijft een bestand; een afwijkende vorige versie gaat eerst naar `backups/<naam>-<tijd>.bak`.
 * @param {string} file volledig pad
 * @param {string} text nieuwe inhoud
 * @param {number} [keep=KEEP]
 */
function writeWithBackup(file, text, keep = KEEP) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== text) {
    const dir = path.join(path.dirname(file), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, path.join(dir, `${path.basename(file)}-${stamp}.bak`));
    const old = fs.readdirSync(dir).filter((n) => n.startsWith(`${path.basename(file)}-`)).sort();
    for (const n of old.slice(0, Math.max(0, old.length - keep))) fs.unlinkSync(path.join(dir, n));
  }
  fs.writeFileSync(file, text);
}

module.exports = { DATA_NAME, LEGACY_NAMES, dataDir, migrateLegacy, writeWithBackup };
