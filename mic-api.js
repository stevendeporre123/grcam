'use strict';

/**
 * @file Client voor de CoCon API (Televic, REST/JSON met long polling): welke microposten staan aan?
 *
 * Werking volgens de CoCon API-handleiding (hoofdstuk 3.4 en 4.3):
 *  1. `GET /CoCon/Connect` geeft `{"Connect":true,"id":"<sessie-id>"}`.
 *  2. `GET /CoCon/Notification/id=<id>` blijft openstaan tot er een gebeurtenis is of na 30 s
 *     (`{"Notification":"Error 408"}`); daarna meteen opnieuw vragen (binnen 60 s, anders vergeet de server ons).
 *     Een sessie zonder poll gedurende 180 s vervalt (`Error 400`): dan opnieuw verbinden.
 *  3. Gebeurtenis `{"MicrophoneState":{"Speakers":[1,5],"Requests":[7],"Replies":[]}}`: de getallen zijn zetelnummers
 *     (SeatNr); dat is het micropostnummer dat bij een zetel is ingevuld. Alleen `Speakers` (aan) gebruiken we.
 *  5. Bedienen: `Microphone/SetState/?State=On|Off&SeatNr=n` (één micro aan of uit) en
 *     `Microphone/ClearMicrophoneList/?Type=SpeakersAndRequests` (alle micro's uit, ook de voorzitter).
 *  4. Bij het verbinden vragen we de huidige stand op (`GET /CoCon/Microphone/GetState`) en schrijven we ons uit van
 *     de andere modellen (Room, Voting, ...) zodat de server ons enkel de microfoongebeurtenissen stuurt.
 * Standaardpoort volgens de handleiding: 8990 (voorbeelden in het document gebruiken 8890); instelbaar.
 * De uitlezing van antwoorden is tolerant (de handleiding toont op plaatsen ';' in plaats van ',' en gekrulde aanhalingstekens).
 * De module kent geen Electron; `fetch` is vervangbaar (testbaar).
 */

/** Modellen waarvoor we ons uitschrijven; Microphone houden we. ButtonLED_Event staat standaard al uit. */
const OTHER_MODELS = ['Room', 'MeetingAgenda', 'Voting', 'Timer', 'Delegate', 'Audio', 'Interpretation', 'Logging', 'Interactive', 'External', 'Intercom', 'Video'];

/** Getallen uit `"Naam": [1,2,3]` (tolerant voor aanhalingstekens en ';'). @returns {number[]|null} */
function arrayOf(text, name) {
  const m = new RegExp(`["“”]?${name}["“”]?\\s*[:：]\\s*\\[([^\\]]*)\\]`).exec(text);
  if (!m) return null;
  return (m[1].match(/\d+/g) || []).map(Number);
}

/**
 * Leest de microfoonstand uit een antwoord (gebeurtenis `MicrophoneState` of antwoord op `Microphone/GetState`).
 * @param {string} text ruw antwoord
 * @returns {{active:number[]}|null} null als het antwoord geen microfoonstand bevat
 */
function parseMicState(text) {
  const s = String(text);
  const speakers = arrayOf(s, 'Speakers');
  if (speakers === null) return null;
  const sort = (a) => [...new Set(a)].sort((x, y) => x - y);
  return { active: sort(speakers) }; // aanvragen (Requests) gebruiken we niet
}

/** Basisadres van de API. @param {{host:string, port?:number}} c */
const baseUrl = (c) => `http://${c.host}:${Number(c.port) || 8990}/CoCon`;

/** Verzoek met time-out; geeft de tekst terug. */
async function getText(fetchImpl, url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok && !/Error 40[08]/.test(text)) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
    return text;
  } finally { clearTimeout(timer); }
}

/**
 * Maakt een sessie, vraagt de stand op en sluit de sessie weer (voor de testknop).
 * @param {{host:string, port?:number}} c
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{state:{active:number[]}|null, connect:string, stateText:string}>}
 */
async function probe(c, fetchImpl = fetch) {
  const base = baseUrl(c);
  const connect = await getText(fetchImpl, `${base}/Connect`, 8000);
  const id = /["“”]id["“”]\s*[:：]\s*["“”]([^"“”]+)["“”]/.exec(connect)?.[1];
  if (!id) throw new Error(`Geen sessie-id in het antwoord op Connect: ${connect.slice(0, 120)}`);
  try {
    const stateText = await getText(fetchImpl, `${base}/Microphone/GetState`, 8000);
    return { state: parseMicState(stateText), connect, stateText };
  } finally {
    getText(fetchImpl, `${base}/Disconnect/?Id=${id}`, 3000).catch(() => {});
  }
}

/**
 * Maakt de poller (één sessie, één long poll tegelijk).
 * @param {object} o
 * @param {() => {enabled:boolean, host:string, port?:number}} o.getConfig
 * @param {(state:{active:number[]}) => void} o.onChange  alleen bij een wijziging
 * @param {(msg:string, level:'info'|'err') => void} o.log
 * @param {typeof fetch} [o.fetchImpl]
 * @param {number} [o.pollTimeoutMs=45000]  iets langer dan de 30 s van de server
 * @param {number} [o.minGapMs=200]  minimale tijd tussen twee verzoeken
 * @param {number} [o.maxBackoffMs=30000]
 */
function createPoller({ getConfig, onChange, log, fetchImpl = fetch, pollTimeoutMs = 45000, minGapMs = 200, maxBackoffMs = 30000 }) {
  let running = false;
  let gen = 0;
  let ctrlSession = null; // { base, id } van de lopende sessie
  let last = null;
  let errLogged = false;

  const emit = (st) => {
    const key = st.active.join(',');
    if (key === last) return;
    last = key;
    log(`Microposten aan: ${st.active.length ? st.active.join(', ') : 'geen'}`, 'info');
    onChange(st);
  };

  async function connect(base) {
    const text = await getText(fetchImpl, `${base}/Connect`, 8000);
    const id = /["“”]id["“”]\s*[:：]\s*["“”]([^"“”]+)["“”]/.exec(text)?.[1];
    if (!id || /["“”]Connect["“”]\s*[:：]\s*false/.test(text)) throw new Error(`Verbinden met de CoCon API mislukt: ${text.slice(0, 120)}`);
    ctrlSession = { base, id };
    // Enkel microfoongebeurtenissen: de rest zou onnodig verkeer zijn (en de poll sneller laten terugkeren).
    await Promise.all(OTHER_MODELS.map((m) => getText(fetchImpl, `${base}/Unsubscribe/?Model=${m}&id=${id}`, 5000).catch(() => {})));
    const st = parseMicState(await getText(fetchImpl, `${base}/Microphone/GetState`, 8000));
    if (st) emit(st);
    log('Verbonden met de CoCon API (microposten)', 'info');
    return id;
  }

  async function loop(my) {
    let backoff = 2000;
    let id = null;
    while (running && my === gen) {
      const c = getConfig();
      if (!c.enabled || !c.host) break;
      const base = baseUrl(c);
      const t0 = Date.now();
      try {
        if (!id) { id = await connect(base); backoff = 2000; if (errLogged) errLogged = false; }
        const text = await getText(fetchImpl, `${base}/Notification/id=${id}`, pollTimeoutMs);
        if (/["“”]Notification["“”]\s*[:：]\s*["“”]Error 400/.test(text)) { id = null; ctrlSession = null; log('CoCon-sessie verlopen: opnieuw verbinden', 'info'); continue; }
        const st = /Error 408/.test(text) ? null : parseMicState(text);
        if (st) emit(st);
        errLogged = false; backoff = 2000;
      } catch (e) {
        if (!running || my !== gen) break;
        if (e.name === 'AbortError') { id = null; ctrlSession = null; continue; } // geen antwoord: sessie opnieuw opzetten
        if (!errLogged) { log(`CoCon API niet bereikbaar of onbruikbaar: ${e.message}; nieuwe pogingen op de achtergrond`, 'err'); errLogged = true; }
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, maxBackoffMs);
        continue;
      }
      const wait = minGapMs - (Date.now() - t0);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }

  const disconnect = () => {
    const s = ctrlSession; ctrlSession = null;
    if (s) getText(fetchImpl, `${s.base}/Disconnect/?Id=${s.id}`, 3000).catch(() => {});
  };

  return {
    /** (Her)start volgens de actuele config; doet niets als de koppeling uitstaat. */
    restart() {
      this.stop();
      const c = getConfig();
      if (!c.enabled || !c.host) return;
      running = true; last = null; errLogged = false;
      loop(++gen);
    },
    stop() {
      running = false; gen++;
      disconnect();
      if (last !== null) { last = null; onChange({ active: [] }); }
    },
    get running() { return running; },
  };
}

/**
 * Stuurt een opdracht naar de CoCon API; die antwoordt met 0 (gelukt), 1 (ongeldige waarde) of -1 (fout).
 * @param {{host:string, port?:number}} c
 * @param {string} path bv. `Microphone/SetState/?State=Off&SeatNr=3`
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<void>}
 * @throws {Error} met een leesbare melding
 */
async function command(c, path, fetchImpl = fetch) {
  const text = (await getText(fetchImpl, `${baseUrl(c)}/${path}`, 8000)).trim();
  if (/^"?0"?$/.test(text)) return;
  if (/^"?1"?$/.test(text)) throw new Error('CoCon weigerde de opdracht (ongeldige waarde, bv. een onbestaand zetelnummer)');
  if (/^"?-1"?$/.test(text)) throw new Error('CoCon meldt een fout bij het uitvoeren van de opdracht (zie het CoCon-serverlog)');
  throw new Error(`Onverwacht antwoord van CoCon: ${text.slice(0, 120)}`);
}

/** Eén micropost (zetelnummer) aan- of uitschakelen. */
const micSet = (state, c, seat, fetchImpl) => {
  const n = Number(seat);
  if (!Number.isInteger(n) || n < 1) return Promise.reject(new Error('Ongeldig micropostnummer'));
  return command(c, `Microphone/SetState/?State=${state}&SeatNr=${n}`, fetchImpl);
};
const micOff = (c, seat, fetchImpl) => micSet('Off', c, seat, fetchImpl);
const micOn = (c, seat, fetchImpl) => micSet('On', c, seat, fetchImpl);
/** Alle microposten uitschakelen (inclusief voorzitter en aanvragen). */
const micMuteAll = (c, fetchImpl) => command(c, 'Microphone/ClearMicrophoneList/?Type=SpeakersAndRequests', fetchImpl);

module.exports = { parseMicState, probe, createPoller, baseUrl, command, micOn, micOff, micMuteAll };
