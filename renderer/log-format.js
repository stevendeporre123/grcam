'use strict';

/**
 * @file Gedeelde opmaak van een logregel (hoofdvenster en het aparte logvenster).
 * Werkt in de browser (`window.LogFormat`) en in Node (tests).
 */
(function (root) {
  /**
   * Tekst van één logregel: `10:32:36 RX cam1 90 50 02 ff — Camera is aan`.
   * @param {{t:number, dir:string, camera?:number, hex?:string, text?:string}} e
   * @returns {string}
   */
  function format(e) {
    const time = new Date(e.t).toLocaleTimeString('nl-BE');
    const hex = e.hex || '';
    const text = e.text ? `${hex ? ' — ' : ''}${e.text}` : '';
    return `${time} ${String(e.dir).toUpperCase()} ${e.camera ? `cam${e.camera}` : ''} ${hex}${text}`.replace(/ {2,}/g, ' ');
  }

  const api = { format };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LogFormat = api;
})(typeof window !== 'undefined' ? window : globalThis);
