'use strict';

/**
 * @file Dunne laag boven `atem-connection` (Blackmagic ATEM, UDP 9910) om camera's naar PGM of PVW te schakelen.
 * De `Atem`-klasse wordt aangereikt zodat tests een nep-ATEM kunnen gebruiken.
 *
 * - PGM = harde cut via `changeProgramInput` op de gekozen mixer (ME 0 standaard), PVW = `changePreviewInput`.
 * - De stand van de programma-uitgang volgt de ATEM zelf (`stateChanged`), ook als iemand aan het toestel schakelt.
 */

const CONNECT_WAIT_MS = 4000;

/**
 * @param {{ Atem: new () => any, Enums?: any, onAudio?: (a:object|null)=>void, log?: (msg:string)=>void, onProgram?: (input:number|null)=>void, onHealth?: (ok:boolean, detail:string)=>void }} deps
 */
function createAtemSwitch({ Atem, Enums = null, log = () => {}, onProgram = () => {}, onHealth = () => {}, onAudio = () => {} }) {
  let atem = null;
  let host = '';
  let me = 0;
  let connected = false;

  const programOf = (state) => state?.video?.mixEffects?.[me]?.programInput ?? null;

  /** Maakt (indien nodig) een verbinding naar `address`; een gewijzigd adres vervangt de oude verbinding. */
  function connect(address, mixEffect = 0) {
    me = Number(mixEffect) || 0;
    if (atem && host === address) return;
    close();
    host = address;
    atem = new Atem();
    atem.on('connected', () => {
      connected = true;
      const model = atem.state?.info?.productIdentifier;
      log(`ATEM verbonden${model ? ` (${model})` : ''}`);
      onHealth(true, '');
      onProgram(programOf(atem.state));
      onAudio(audio());
    });
    atem.on('disconnected', () => { connected = false; onHealth(false, `ATEM ${address} is niet bereikbaar of de verbinding viel weg`); });
    atem.on('error', (msg) => log(`ATEM-fout: ${msg}`));
    atem.on('stateChanged', (state, paths) => {
      if (!connected) return;
      onProgram(programOf(state));
      if ((paths || []).some((p) => String(p).startsWith('audio'))) onAudio(audio());
    });
    atem.connect(address).catch((e) => { onHealth(false, `ATEM ${address}: ${e.message}`); });
  }

  function close() {
    const a = atem;
    atem = null; host = ''; connected = false;
    if (a) { a.removeAllListeners?.(); a.disconnect?.().catch?.(() => {}); }
  }

  /** Wacht tot de verbinding er is (de bibliotheek herstelt zelf na een val). */
  async function ready() {
    const t0 = Date.now();
    while (!connected) {
      if (!atem) throw new Error('ATEM-koppeling is niet ingesteld (Beheer → Instellingen)');
      if (Date.now() - t0 > CONNECT_WAIT_MS) throw new Error(`ATEM ${host} is niet bereikbaar (geen antwoord op UDP 9910): controleer het IP-adres, het netwerk en of UDP 9910 niet geblokkeerd wordt`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /**
   * Schakelt een ATEM-ingang naar programma of preview.
   * @param {number} input ingangsnummer op de ATEM (1-based, zoals op het toestel)
   * @param {'pgm'|'pvw'} target
   */
  async function take(input, target) {
    await ready();
    if (target === 'pvw') await atem.changePreviewInput(input, me);
    else await atem.changeProgramInput(input, me);
  }

  /** @returns {number|null} ingang die nu op programma staat (null als onbekend) */
  const program = () => (connected ? programOf(atem.state) : null);
  /** @returns {number|null} ingang die nu op preview staat */
  const preview = () => (connected ? (atem.state?.video?.mixEffects?.[me]?.previewInput ?? null) : null);
  const isConnected = () => connected;

  const PORT = { 1: 'SDI', 2: 'HDMI', 4: 'Component', 8: 'Composite', 16: 'S-Video', 256: 'intern' };
  const INTERNAL = { 0: '', 1: 'zwart', 2: 'kleurbalken', 3: 'kleur', 4: 'media player', 5: 'media player key', 6: 'SuperSource', 128: 'M/E-uitgang', 129: 'aux', 130: 'mask', 131: 'multiviewer', 132: 'audiomonitor' };
  /** Leesbare toestand voor het testscherm: model, videoformaat, ingangen en wat er op programma/preview staat. */
  function info() {
    const st = atem?.state;
    if (!connected || !st) return null;
    const inputs = Object.values(st.inputs || {}).map((i) => ({
      id: i.inputId, name: i.longName, short: i.shortName,
      type: i.internalPortType === 0 ? (PORT[i.externalPortType] || '') : (INTERNAL[i.internalPortType] || ''),
    })).sort((a, b) => a.id - b.id);
    const vm = st.settings?.videoMode;
    return {
      model: st.info?.productIdentifier || '', protocol: st.info?.apiVersion != null ? String(st.info.apiVersion) : '',
      videoMode: vm != null ? (Enums?.VideoMode?.[vm] ?? String(vm)) : '',
      program: programOf(st), preview: st.video?.mixEffects?.[me]?.previewInput ?? null, inputs,
    };
  }

  /** Audio-ingang waarop de volumeregeling werkt: de XLR (bron 1001) van de klassieke audiomixer. */
  const XLR = 1001;
  const channelOf = () => atem?.state?.audio?.channels?.[XLR] ?? null;
  /**
   * Stand van de XLR-ingang: `gain` in dB (-100 = uit/-oneindig), `on` = niet gedempt.
   * @returns {{id:number, gain:number, on:boolean}|null} null als er geen klassieke audiomixer / XLR is
   */
  function audio() {
    const ch = connected ? channelOf() : null;
    if (!ch) return null;
    return { id: XLR, gain: Number.isFinite(ch.gain) ? Math.round(ch.gain * 10) / 10 : -100, on: ch.mixOption !== 0 };
  }
  /**
   * Zet het volume en/of het dempen van de XLR-ingang.
   * @param {{gain?:number, on?:boolean}} p gain in dB (-60 of lager = oneindig stil, max +6)
   */
  async function setAudio({ gain, on }) {
    await ready();
    if (!channelOf()) throw new Error('Deze ATEM heeft geen klassieke audiomixer met XLR-ingang (bron 1001)');
    const props = {};
    if (gain !== undefined) { const g = Number(gain); if (!Number.isFinite(g)) throw new Error('Ongeldig volume'); props.gain = g <= -60 ? -Infinity : Math.min(6, g); }
    if (on !== undefined) props.mixOption = on ? 1 : 0; // 1 = aan, 0 = uit (gedempt)
    await atem.setClassicAudioMixerInputProps(XLR, props);
  }

  return { connect, close, take, program, preview, isConnected, ready, info, audio, setAudio };
}

module.exports = { createAtemSwitch };
