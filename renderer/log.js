'use strict';

/**
 * @file Apart logvenster: toont het verkeerslog groot, met filters, pauzeren en wissen, en de knoppen
 * "Debug" en "Test alle camera's" zodat je niet tussen vensters hoeft te wisselen.
 */

/* global api, LogFormat */
(() => {
  const $ = (id) => document.getElementById(id);
  const MAX = 1000;
  const el = $('logfull');
  /** Alle ontvangen regels (ook de gefilterde), zodat een filter achteraf terug kan tonen. */
  let all = [];

  /** @param {{dir:string}} e @returns {boolean} mag deze regel getoond worden? */
  const visible = (e) => ({ tx: $('fTx'), rx: $('fRx'), info: $('fInfo'), err: $('fErr') }[e.dir]?.checked ?? true);

  /** @param {object} e @returns {HTMLDivElement} */
  function lineEl(e) {
    const d = document.createElement('div');
    d.className = e.dir;
    d.textContent = LogFormat.format(e);
    return d;
  }

  /** Tekent de zichtbare regels opnieuw (na een filter of wissen). */
  function redraw() {
    el.replaceChildren(...all.filter(visible).map(lineEl));
    el.scrollTop = el.scrollHeight;
  }

  /** @param {object} e nieuwe logregel */
  function add(e) {
    all.push(e);
    if (all.length > MAX) all = all.slice(-MAX);
    if ($('pause').checked || !visible(e)) return;
    const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 30; // alleen meescrollen als je onderaan staat
    el.appendChild(lineEl(e));
    while (el.childNodes.length > MAX) el.removeChild(el.firstChild);
    if (stick) el.scrollTop = el.scrollHeight;
  }

  for (const id of ['fTx', 'fRx', 'fInfo', 'fErr']) $(id).addEventListener('change', redraw);
  $('pause').addEventListener('change', () => { if (!$('pause').checked) redraw(); });
  $('btnClear').addEventListener('click', () => { all = []; redraw(); });
  $('btnTest').addEventListener('click', () => api.testAll());
  $('debugSw').addEventListener('change', (e) => { $('lastPreset').hidden = true; api.setDebug(e.target.checked); });

  api.onLog(add);
  api.onDebugChanged((on) => { $('debugSw').checked = on; if (!on) $('lastPreset').hidden = true; });
  api.onLastPreset((e) => {
    $('lastPreset').textContent = `Laatst opgeroepen: camera ${e.camera} preset ${e.preset}`;
    $('lastPreset').hidden = !$('debugSw').checked;
  });

  (async () => {
    const hist = await api.logHistory();
    if (hist.ok) { all = hist.data; redraw(); }
    const cfg = await api.getConfig();
    if (cfg.ok) $('debugSw').checked = Boolean(cfg.data.debug);
  })();
})();
