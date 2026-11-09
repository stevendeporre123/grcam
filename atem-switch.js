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
 * @param {{ Atem: new () => any, log?: (msg:string)=>void, onProgram?: (input:number|null)=>void, onHealth?: (ok:boolean, detail:string)=>void }} deps
 */
function createAtemSwitch({ Atem, log = () => {}, onProgram = () => {}, onHealth = () => {} }) {
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
    });
    atem.on('disconnected', () => { connected = false; onHealth(false, `ATEM ${address} is niet bereikbaar of de verbinding viel weg`); });
    atem.on('error', (msg) => log(`ATEM-fout: ${msg}`));
    atem.on('stateChanged', (state) => { if (connected) onProgram(programOf(state)); });
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
      if (Date.now() - t0 > CONNECT_WAIT_MS) throw new Error(`ATEM ${host} is niet bereikbaar (geen antwoord op UDP 9910): controleer het IP-adres en het netwerk`);
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

  return { connect, close, take, program, preview, isConnected, ready };
}

module.exports = { createAtemSwitch };
