'use strict';

/**
 * Automatische tracking: de camera volgt steeds het laatst aangezette micro.
 * - Houdt de volgorde bij waarin microposten aangingen. Doel = het meest recente dat nog aanstaat.
 * - Een handmatige actie (`manual()`) pauzeert de tracking tot er opnieuw een micro aangaat of tot ze opnieuw ingeschakeld wordt.
 * - Gaan alle micro's uit (en er is niet handmatig ingegrepen), dan wordt `onIdle` aangeroepen (terug naar het overzichtsbeeld).
 * @param {{follow:(mic:number)=>void, onChange?:(s:object)=>void}} o
 */
function createTracker({ follow, onChange = () => {}, onIdle = () => {} }) {
  let enabled = false;
  let paused = false;
  let order = [];
  let current = null;
  let prev = [];
  const state = () => ({ enabled, paused, mic: current });
  const emit = () => onChange(state());
  const target = () => (order.length ? order[order.length - 1] : null);
  const go = (mic) => { current = mic; emit(); follow(mic); };
  return {
    state,
    /** @param {boolean} on */
    setEnabled(on) {
      enabled = Boolean(on);
      paused = false;
      if (!enabled) { current = null; emit(); return; }
      const t = target();
      if (t !== null) go(t); else emit();
    },
    /** Handmatige bediening: tracking wacht op het volgende nieuwe micro. */
    manual() {
      if (!enabled || paused) return;
      paused = true;
      emit();
    },
    /** @param {number[]} active micropostnummers die nu aan staan */
    update(active) {
      const fresh = active.filter((m) => !prev.includes(m));
      order = order.filter((m) => active.includes(m)).concat(fresh);
      const wasOn = prev.length > 0;
      prev = [...active];
      if (!enabled) return;
      if (fresh.length) paused = false;
      const t = target();
      if (t === null && wasOn && !paused) { current = null; emit(); onIdle(); return; }
      if (t === null || paused) { emit(); return; }
      if (fresh.length || t !== current) go(t); else emit();
    },
  };
}

/**
 * Kiest het alternatief voor een zitplaats: het ingestelde alternatief, anders de overzichtspreset
 * (Zaal-knop) van de eerste camera die niet de gevraagde en niet de live camera is.
 * @param {{camera:number, alt?:{camera:number,preset:number}}} a koppeling van de zitplaats
 * @param {Array<{id:string}>} zalen zaalknoppen
 * @param {Record<string,{camera:number,preset:number}>} assign alle koppelingen
 * @param {number|null} live camera die nu op PGM staat
 * @returns {{camera:number,preset:number}|undefined}
 */
function pickAlt(a, zalen, assign, live) {
  if (a.alt) return a.alt;
  const options = zalen.map((z) => assign[z.id]).filter(Boolean)
    .filter((x) => x.camera !== a.camera && x.camera !== live)
    .sort((x, y) => x.camera - y.camera);
  return options[0] ? { camera: options[0].camera, preset: options[0].preset } : undefined;
}

module.exports = { createTracker, pickAlt };
