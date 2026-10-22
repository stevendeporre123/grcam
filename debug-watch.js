'use strict';

/**
 * @file Debugmodus: na elk "klaar"-bericht (completion) van een camera meteen de laatst opgeroepen
 * preset opvragen (VISCA CAM_MemoryInq) en het antwoord doorgeven.
 *
 * Doel: ontdekken welke preset de bestaande automatisering (Televic -> NI-700) bij een micropost gebruikt.
 * Dit werkt alleen als de IPL de seriële antwoorden naar álle TCP-verbindingen op die poort stuurt;
 * daarom houdt main.js in debugmodus de verbindingen permanent open.
 *
 * De module kent geen sockets of Electron: schrijven en terugmelden gaat via callbacks (testbaar).
 */

const visca = require('./visca');

/**
 * Splitst een bytestroom in VISCA-berichten (elk eindigt op 0xFF).
 * @param {Buffer} carry rest van de vorige keer
 * @param {Buffer} chunk nieuwe bytes
 * @returns {{messages: Buffer[], rest: Buffer}}
 */
function splitMessages(carry, chunk) {
  const all = Buffer.concat([carry, chunk]);
  const messages = [];
  let start = 0;
  for (let i = 0; i < all.length; i++) {
    if (all[i] === 0xff) { messages.push(all.subarray(start, i + 1)); start = i + 1; }
  }
  return { messages, rest: all.subarray(start) };
}

/**
 * Is dit een completion-bericht (`z0 5y FF`, y = 1..F)? Antwoorden op inquiries (`z0 50 ..`) tellen niet mee,
 * zodat het antwoord op onze eigen vraag nooit een nieuwe vraag uitlokt.
 * @param {Buffer} m
 * @returns {boolean}
 */
const isCompletion = (m) => m.length === 3 && (m[0] & 0x0f) === 0x00 && m[0] >= 0x90 && (m[1] & 0xf0) === 0x50 && (m[1] & 0x0f) !== 0;

/**
 * Maakt de watcher.
 * @param {object} o
 * @param {(camId:number)=>{viscaAddr:number}} o.getCamera
 * @param {(camId:number, buf:Buffer)=>void} o.write  stuurt bytes naar de camera (en logt TX)
 * @param {(camId:number, preset:number)=>void} o.onLast  antwoord ontvangen
 * @param {(msg:string, camId:number)=>void} [o.log]
 * @param {(camId:number)=>void} [o.onTimeout]  de camera antwoordde niet binnen `replyTimeoutMs`
 * @param {number} [o.delayMs=200]  wachttijd na de completion voor we vragen
 * @param {number} [o.replyTimeoutMs=1500]  hoelang we op het antwoord wachten
 * @param {number} [o.suppressMs=1500]  negeer completions kort na onze eigen pan/tilt/zoom
 */
function createWatcher({ getCamera, write, onLast, log = () => {}, onTimeout = () => {}, delayMs = 200, replyTimeoutMs = 1500, suppressMs = 1500 }) {
  let enabled = false;
  /** @type {Map<number, {carry:Buffer, scheduled:boolean, pending:boolean, timer:any, lastOwn:number}>} */
  const st = new Map();
  const state = (id) => {
    if (!st.has(id)) st.set(id, { carry: Buffer.alloc(0), scheduled: false, pending: false, timer: null, lastOwn: 0 });
    return st.get(id);
  };

  /** Verstuurt de vraag en wacht op het antwoord. */
  function ask(camId) {
    const s = state(camId);
    s.scheduled = false;
    s.pending = true;
    write(camId, visca.memoryInquiry(getCamera(camId).viscaAddr));
    s.timer = setTimeout(() => { s.pending = false; log("Geen antwoord op de vraag naar de laatste preset (de camera ondersteunt dit mogelijk niet, of de verbinding is weggevallen)", camId);
      onTimeout(camId); }, replyTimeoutMs);
  }

  return {
    /** Stelt de vraag "laatste preset" meteen (bv. vanuit de testknop). @param {number} camId */
    ask(camId) { if (enabled && !state(camId).pending) ask(camId); },
    /** @param {boolean} on */
    setEnabled(on) {
      enabled = Boolean(on);
      if (!enabled) for (const s of st.values()) { clearTimeout(s.timer); s.pending = false; s.scheduled = false; s.carry = Buffer.alloc(0); }
    },
    get enabled() { return enabled; },
    /** Onthoudt dat de app zelf net een beweging stuurde (die completion negeren we). @param {number} camId */
    noteOwnMove(camId) { state(camId).lastOwn = Date.now(); },
    /**
     * Verwerkt bytes die van een camera binnenkomen.
     * @param {number} camId
     * @param {Buffer} chunk
     */
    feed(camId, chunk) {
      if (!enabled) return;
      const s = state(camId);
      const { messages, rest } = splitMessages(s.carry, chunk);
      s.carry = rest;
      for (const m of messages) {
        if (s.pending && m.length === 4 && (m[1] & 0xff) === 0x50) {
          clearTimeout(s.timer);
          s.pending = false;
          onLast(camId, m[2]);
        } else if (isCompletion(m) && !s.pending && !s.scheduled && Date.now() - s.lastOwn > suppressMs) {
          s.scheduled = true;
          setTimeout(() => { if (enabled) ask(camId); else s.scheduled = false; }, delayMs);
        }
      }
    },
  };
}

module.exports = { createWatcher, splitMessages, isCompletion };
