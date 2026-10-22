'use strict';

/**
 * @file Preload-script: de enige brug tussen de UI (renderer) en het main-proces.
 * Stelt `window.api` beschikbaar. Elke functie geeft een Promise terug met `{ok: true, data}` of `{ok: false, error}`.
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Roept een IPC-kanaal aan in het main-proces.
 * @param {string} ch  kanaalnaam, zie `handlers` in main.js
 * @param {any} [arg]
 * @returns {Promise<{ok:boolean, data?:any, error?:string}>}
 */
const call = (ch, arg) => ipcRenderer.invoke(ch, arg);

contextBridge.exposeInMainWorld('api', {
  /** Actuele config ophalen. */
  getConfig: () => call('cfg:get'),
  /** Config bewaren. @param {object} c */
  saveConfig: (c) => call('cfg:save', c),
  /** Zittingsplan ophalen. */
  getPlan: () => call('plan:get'),
  /** Zittingsplan importeren uit een backup-bestand ({fracties, seats}). @param {object} p */
  importPlan: (p) => call('plan:import', p),
  /** Zittingsplan bewaren (na bewerken van zetels). @param {object} p */
  savePlan: (p) => call('plan:save', p),
  /** Preset oproepen. @param {number} camera @param {number} preset VISCA 0-127 */
  preset: (camera, preset) => call('cam:preset', { camera, preset }),
  /** Huidige positie opslaan in een preset (overschrijft). */
  presetStore: (camera, preset) => call('cam:presetStore', { camera, preset }),
  /** Camera naar de home-positie. @param {number} camera */
  home: (camera) => call('cam:home', { camera }),
  /** Testcommando (power-inquiry) om te zien of de camera antwoordt. @param {number} camera */
  ping: (camera) => call('cam:ping', { camera }),
  /** Pan/tilt starten of stoppen. @param {number} camera @param {string} dir bv. 'left' of 'stop' @param {number} [speed] 1-100 */
  move: (camera, dir, speed) => call('cam:move', { camera, dir, speed }),
  /** Zoom starten of stoppen. @param {number} camera @param {'tele'|'wide'|'stop'} dir @param {number} [speed] 1-7 */
  zoom: (camera, dir, speed) => call('cam:zoom', { camera, dir, speed }),
  /** Debugmodus: laatst opgeroepen preset van een camera opvragen. @param {number} camera */
  lastPreset: (camera) => call('cam:lastPreset', { camera }),
  /** BrightEye: welke bron staat er op de programma-uitgang? (komt in het log) */
  programStatus: () => call('program:status'),
  /** Camera naar de programma-uitgang van de BrightEye schakelen. @param {number} camera */
  program: (camera) => call('program:switch', { camera }),
  /** Debugmodus: laatst opgeroepen preset van een camera. @param {(e:{t:number,camera:number,preset:number})=>void} fn */
  onLastPreset: (fn) => ipcRenderer.on('lastPreset', (_e, entry) => fn(entry)),
  /** Luistert naar logregels van het main-proces. @param {(e:{t:number,dir:string,camera?:number,hex:string})=>void} fn */
  onLog: (fn) => ipcRenderer.on('log', (_e, entry) => fn(entry)),
});
