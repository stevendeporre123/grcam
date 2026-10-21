'use strict';

/**
 * @file UI-logica van PTZ Backup (renderer-proces).
 *
 * Schermen:
 *  - Bediening: zittingsplan (SVG), zaalknoppen, camerakeuze en pan/tilt/zoom.
 *  - Beheer: DataTables-overzicht van alle koppelingen, instellingen, plan-import en verkeerslog.
 *
 * Modi:
 *  - Normaal: klik op een zetel of zaalknop roept de gekoppelde camerapreset op.
 *  - Inleren (checkbox): klik opent een modal om camera + preset te koppelen of de huidige
 *    camerapositie als preset op te slaan.
 *
 * Alle communicatie met camera's en schijf loopt via `window.api` (zie preload.js).
 */

/* global jQuery, api, PlanView */
(() => {
  const { buildPlanSvg, isSpeaker, camColor, esc } = PlanView;

  /** Voorgesteld startnummer bij inleren; lagere presets gebruikt de bestaande automatisering mogelijk al. */
  const FIRST_FREE_PRESET = 20;

  /** Volgorde van de richtingsknoppen in het 3x3-pad. */
  const DIRS = ['upleft', 'up', 'upright', 'left', 'stop', 'right', 'downleft', 'down', 'downright'];
  const ARROWS = { upleft: '↖', up: '↑', upright: '↗', left: '←', stop: '■', right: '→', downleft: '↙', down: '↓', downright: '↘' };

  /** @type {object} config uit het main-proces (zie typedef Config in main.js) */
  let cfg;
  /** @type {object} zittingsplan: {fracties, seats, bg, decor} */
  let plan;
  /** @type {object} DataTables-instantie van het Beheer-scherm */
  let table;
  /** Staat de inleermodus aan? */
  let learn = false;
  /** Camera die met het pad wordt bestuurd. */
  let selCam = 1;
  /** Zetel- of zaal-id die laatst succesvol is opgeroepen (wordt gemarkeerd). */
  let activeId = null;
  /** Zetel- of zaal-id dat in de inleer-modal bewerkt wordt. */
  let editingId = null;
  /** Spiegelgegevens van de laatst getekende plan (voor het slepen van camera's). */
  let geom = { flip: false, mx: 0, my: 0 };

  /** @param {string} i element-id */
  const $id = (i) => document.getElementById(i);
  /** @param {string} id zetel-id @returns {object|undefined} */
  const seatOf = (id) => plan.seats.find((s) => s.id === id);
  /** @param {string} id zaal-id @returns {{id:string,label:string}|undefined} */
  const zaalOf = (id) => cfg.zaal.find((z) => z.id === id);
  /** Naam voor een zetel of zaalknop. @param {string} id */
  const labelOf = (id) => zaalOf(id)?.label ?? seatOf(id)?.naam ?? id;
  /** Weergavenaam van een camera. @param {number} id */
  const camName = (id) => cfg.cameras.find((c) => c.id === id)?.name ?? `Camera ${id}`;

  /**
   * Toont kort een foutmelding onderaan het scherm.
   * @param {string} msg
   */
  function toast(msg) {
    const t = $id('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.h);
    toast.h = setTimeout(() => t.classList.remove('show'), 3500);
  }

  /**
   * Wacht op een IPC-antwoord en toont de fout als `ok` false is.
   * @param {Promise<{ok:boolean, data?:any, error?:string}>} promise
   * @returns {Promise<{ok:boolean, data?:any, error?:string}>}
   */
  async function run(promise) {
    const r = await promise;
    if (!r.ok) toast(r.error);
    return r;
  }

  /** Bewaart `cfg` via het main-proces en tekent alles opnieuw. */
  async function persist() {
    await run(api.saveConfig(cfg));
    renderAll();
  }

  // ---------- Plan ----------

  /** Tekent het zittingsplan (zetels, camera's, gekozen richting) in de SVG. */
  function renderPlan() {
    const svg = $id('plan');
    const { viewBox, html, flip, mx, my } = buildPlanSvg(plan, cfg.assign, { view: cfg.view, cameras: cfg.cameras, selCam });
    geom = { flip, mx, my };
    svg.setAttribute('viewBox', viewBox);
    svg.innerHTML = html;
    document.querySelectorAll('#viewSel button').forEach((b) => b.classList.toggle('on', b.dataset.view === (cfg.view || 'zaal')));
    markActive();
  }

  // Wisselen tussen "Zicht ambtenarenbank" en "Zaalplan"
  $id('viewSel').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b) return;
    cfg.view = b.dataset.view;
    await persist();
  });

  /** Markeert de laatst opgeroepen zetel of zaalknop. */
  function markActive() {
    document.querySelectorAll('.seat.active, .zaal button.active').forEach((e) => e.classList.remove('active'));
    if (!activeId) return;
    document.querySelector(`.seat[data-id="${CSS.escape(activeId)}"]`)?.classList.add('active');
    document.querySelector(`.zaal button[data-id="${CSS.escape(activeId)}"]`)?.classList.add('active');
  }

  /** Tekent de zaalknoppen; de randkleur toont de gekoppelde camera. */
  function renderZaal() {
    $id('zaalBtns').innerHTML = cfg.zaal.map((z) => {
      const a = cfg.assign[z.id];
      const col = a ? camColor(a.camera) : 'var(--line)';
      return `<button data-id="${esc(z.id)}" style="border-color:${col}">${esc(z.label)}</button>`;
    }).join('');
  }

  /** Tekent de vier camerakeuzeknoppen. */
  function renderCamSel() {
    $id('camSel').innerHTML = cfg.cameras.map((c) =>
      `<button data-cam="${c.id}" class="${c.id === selCam ? 'sel' : ''}" style="border-color:${camColor(c.id)}">${c.id}</button>`).join('');
  }

  /**
   * Toont rechtsboven wie er geselecteerd is en welke camera/preset daarbij hoort.
   * @param {string} id zetel- of zaal-id
   */
  function setNow(id) {
    const a = cfg.assign[id];
    $id('now').innerHTML = a
      ? `<b>${esc(labelOf(id))}</b>${esc(camName(a.camera))} · preset ${a.preset}`
      : `<b>${esc(labelOf(id))}</b>Nog niet gekoppeld`;
  }

  /**
   * Klik op een zetel of zaalknop. In inleermodus opent dit de modal, anders wordt de preset opgeroepen.
   * @param {string} id zetel- of zaal-id
   */
  async function pick(id) {
    if (learn) { openAssign(id); return; }
    const a = cfg.assign[id];
    setNow(id);
    if (!a) { toast(`${labelOf(id)}: nog geen camerapreset gekoppeld`); return; }
    selectCamera(a.camera);
    const r = await run(api.preset(a.camera, a.preset));
    if (r.ok) { activeId = id; markActive(); }
  }

  /**
   * Kiest de camera die met het pad bestuurd wordt en markeert die op het plan.
   * @param {number} id
   */
  function selectCamera(id) {
    selCam = id;
    renderCamSel();
    document.querySelectorAll('#plan .cam').forEach((c) => c.classList.toggle('sel', Number(c.dataset.cam) === selCam));
  }

  // Eén klik-handler op de SVG (event delegation): camera-markering of zetel
  $id('plan').addEventListener('click', (e) => {
    const cam = e.target.closest('.cam');
    if (cam) { selectCamera(Number(cam.dataset.cam)); return; }
    const g = e.target.closest('.seat');
    // Niet-aanklikbare zetels (bv. pers) kan je enkel in inleermodus openen, om ze aanklikbaar te maken.
    if (g && (learn || !g.classList.contains('off'))) pick(g.dataset.id);
  });
  $id('zaalBtns').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (b) pick(b.dataset.id);
  });
  $id('camSel').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-cam]');
    if (b) selectCamera(Number(b.dataset.cam));
  });

  // ---------- Camera's verslepen (alleen in inleermodus) ----------

  /**
   * Schermpositie -> plan-coördinaten (rekening houdend met viewBox en de 180°-spiegeling).
   * @param {PointerEvent} e
   * @returns {{x:number, y:number}}
   */
  function planPoint(e) {
    const svg = $id('plan');
    const m = svg.getScreenCTM().inverse();
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m);
    return geom.flip ? { x: 2 * geom.mx - p.x, y: 2 * geom.my - p.y } : { x: p.x, y: p.y };
  }

  // Sleep een cameramarkering naar de juiste plaats; de nieuwe positie wordt bewaard.
  $id('plan').addEventListener('pointerdown', (e) => {
    const g = e.target.closest('.cam');
    if (!learn || !g) return;
    const cam = cfg.cameras.find((c) => c.id === Number(g.dataset.cam));
    if (!cam) return;
    const startX = e.clientX; const startY = e.clientY;
    let moved = false;
    g.setPointerCapture(e.pointerId);
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      moved = true;
      const p = planPoint(ev);
      cam.pos = { x: Math.round(p.x), y: Math.round(p.y) };
      const shown = geom.flip ? { x: 2 * geom.mx - cam.pos.x, y: 2 * geom.my - cam.pos.y } : cam.pos;
      g.setAttribute('transform', `translate(${shown.x} ${shown.y})`);
    };
    const up = async () => {
      g.removeEventListener('pointermove', move);
      g.removeEventListener('pointerup', up);
      g.removeEventListener('pointercancel', up);
      if (moved) await persist();
    };
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', up);
    g.addEventListener('pointercancel', up);
  });

  // ---------- Inleren ----------

  $id('learn').addEventListener('change', (e) => {
    learn = e.target.checked;
    $id('learnBanner').hidden = !learn;
    document.body.classList.toggle('learning', learn);
  });

  /**
   * Eerste vrije presetnummer voor een camera, te beginnen bij FIRST_FREE_PRESET.
   * Houdt alleen rekening met koppelingen in deze app, niet met presets die al in de camera staan.
   * @param {number} camera
   * @returns {number}
   */
  function nextFree(camera) {
    const used = new Set(Object.values(cfg.assign).filter((a) => a.camera === camera).map((a) => a.preset));
    let n = FIRST_FREE_PRESET;
    while (used.has(n) && n < 127) n++;
    return n;
  }

  /**
   * Opent de inleer-modal voor een zetel of zaalknop, vooraf ingevuld met de bestaande koppeling
   * of een voorstel voor een vrij presetnummer.
   * @param {string} id zetel- of zaal-id
   */
  function openAssign(id) {
    const f = $id('formAssign');
    const a = cfg.assign[id];
    editingId = id;
    const isZaal = Boolean(zaalOf(id));
    $id('assignTitle').textContent = isZaal ? `Zaalknop: ${zaalOf(id).label}` : labelOf(id);
    $id('assignSub').textContent = isZaal ? '' : seatOf(id)?.regel2 || '';
    $id('rowLabel').hidden = !isZaal;
    const seat = isZaal ? null : seatOf(id);
    $id('seatEdit').hidden = !seat;
    $id('seatEdit').open = false;
    if (seat) {
      f.sNaam.value = seat.naam || '';
      f.sFractie.innerHTML = '<option value="">— geen fractie —</option>' +
        plan.fracties.filter((x) => x.key !== 'geen').map((x) => `<option value="${esc(x.key)}">${esc(x.naam)}</option>`).join('');
      f.sFractie.value = seat.fractie && seat.fractie !== 'geen' ? seat.fractie : '';
      f.sMic.value = seat.mic ?? '';
      f.sKlik.checked = isSpeaker(seat);
    }
    f.label.value = zaalOf(id)?.label ?? '';
    f.camera.innerHTML = cfg.cameras.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    f.camera.value = a?.camera ?? selCam;
    f.preset.value = a?.preset ?? nextFree(Number(f.camera.value));
    // Bij een nieuwe koppeling volgt het presetvoorstel de gekozen camera.
    if (!a) f.camera.onchange = () => { f.preset.value = nextFree(Number(f.camera.value)); };
    else f.camera.onchange = null;
    document.querySelector(`.seat[data-id="${CSS.escape(id)}"]`)?.classList.add('pending');
    $id('dlgAssign').showModal();
  }

  /** Sluit de inleer-modal en haalt de markering van de zetel weg. */
  function closeAssign() {
    document.querySelectorAll('.seat.pending').forEach((e) => e.classList.remove('pending'));
    $id('dlgAssign').close();
  }

  /**
   * Leest camera en preset uit de modal.
   * @returns {{camera:number, preset:number}|null} null als het formulier ongeldig is
   */
  function assignFromForm() {
    const f = $id('formAssign');
    if (!f.reportValidity()) return null;
    return { camera: Number(f.camera.value), preset: Number(f.preset.value) };
  }

  /**
   * Schrijft een koppeling in `cfg.assign` (en de nieuwe naam van een zaalknop).
   * Vraagt bevestiging als dezelfde camera + preset al bij een andere zetel hoort.
   * @param {{camera:number, preset:number}} a
   * @returns {boolean} false als de gebruiker annuleert
   */
  function applyAssign(a) {
    const f = $id('formAssign');
    const clash = Object.entries(cfg.assign).find(([k, v]) => k !== editingId && v.camera === a.camera && v.preset === a.preset);
    if (clash && !confirm(`Camera ${a.camera} preset ${a.preset} hoort al bij "${labelOf(clash[0])}". Toch ook koppelen?`)) return false;
    cfg.assign[editingId] = a;
    const z = zaalOf(editingId);
    if (z && f.label.value.trim()) z.label = f.label.value.trim();
    return true;
  }

  $id('aCancel').addEventListener('click', closeAssign);

  // "Zetelgegevens opslaan": naam, fractie en micropostnummer van de zetel bewaren
  $id('sSave').addEventListener('click', async () => {
    const f = $id('formAssign');
    const seat = seatOf(editingId);
    if (!seat) return;
    const naam = f.sNaam.value.trim();
    if (!naam) { toast('Een zetel heeft een naam nodig'); return; }
    const mic = f.sMic.value === '' ? null : Number(f.sMic.value);
    if (mic !== null && (!Number.isInteger(mic) || mic < 1)) { toast('Ongeldig micropostnummer'); return; }
    const dup = mic !== null && plan.seats.find((s) => s.id !== seat.id && s.mic === mic);
    if (dup) { toast(`Micropost ${mic} is al gekoppeld aan ${dup.naam}`); return; }
    const oldNaam = plan.fracties.find((x) => x.key === seat.fractie)?.naam ?? '';
    const newKey = f.sFractie.value || 'geen';
    const newNaam = plan.fracties.find((x) => x.key === newKey && newKey !== 'geen')?.naam ?? '';
    // regel2 toont de fractienaam: meebewegen als ze nog overeenkomt (of leeg was)
    if (!seat.regel2 || seat.regel2 === oldNaam) seat.regel2 = newNaam;
    seat.naam = naam;
    seat.spreker = f.sKlik.checked;
    seat.fractie = newKey;
    if (mic === null) delete seat.mic; else seat.mic = mic;
    const r = await run(api.savePlan(plan));
    if (!r.ok) return;
    closeAssign();
    renderAll();
  });

  // "Wissen": koppeling verwijderen (de preset in de camera blijft bestaan)
  $id('aClear').addEventListener('click', async () => {
    delete cfg.assign[editingId];
    closeAssign();
    await persist();
  });

  // "Enkel koppelen": preset staat al in de camera, alleen de koppeling bewaren
  $id('aLink').addEventListener('click', async () => {
    const a = assignFromForm();
    if (!a || !applyAssign(a)) return;
    closeAssign();
    await persist();
  });

  // "Opslaan in camera": huidige camerapositie als preset bewaren (overschrijft) en koppelen
  $id('aStore').addEventListener('click', async () => {
    const a = assignFromForm();
    if (!a) return;
    if (!confirm(`Huidige positie van ${camName(a.camera)} opslaan als preset ${a.preset}? De bestaande preset ${a.preset} in de camera wordt overschreven.`)) return;
    const prev = cfg.assign[editingId];
    if (!applyAssign(a)) return;
    const r = await run(api.presetStore(a.camera, a.preset));
    if (!r.ok) { // niet bewaard in de camera: oude koppeling terugzetten
      if (prev) cfg.assign[editingId] = prev; else delete cfg.assign[editingId];
      return;
    }
    closeAssign();
    await persist();
  });

  // ---------- PTZ ----------

  /** @returns {number} snelheid 5-100 uit de schuifregelaar */
  const speed = () => Number($id('speed').value);

  /**
   * Maakt van een knop een "vasthouden = bewegen" knop. Loslaten, pointer-cancel of het venster
   * verliezen van focus roept `stop` aan.
   * @param {HTMLElement} btn
   * @param {() => void} start
   * @param {() => void} stop
   */
  function hold(btn, start, stop) {
    let on = false;
    const up = () => { if (!on) return; on = false; btn.classList.remove('hold'); stop(); };
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); btn.setPointerCapture?.(e.pointerId); on = true; btn.classList.add('hold'); start(); });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => btn.addEventListener(ev, up));
    window.addEventListener('blur', up);
  }

  /** Bouwt het 3x3-pad, de zoomknoppen en de homeknop en koppelt ze aan de geselecteerde camera. */
  function buildPad() {
    $id('pad').innerHTML = DIRS.map((d) => `<button data-dir="${d}">${ARROWS[d]}</button>`).join('');
    $id('pad').querySelectorAll('[data-dir]').forEach((b) => {
      const d = b.dataset.dir;
      if (d === 'stop') { b.addEventListener('click', () => run(api.move(selCam, 'stop'))); return; }
      hold(b, () => run(api.move(selCam, d, speed())), () => run(api.move(selCam, 'stop')));
    });
    document.querySelectorAll('[data-zoom]').forEach((b) => {
      hold(b, () => run(api.zoom(selCam, b.dataset.zoom, 3)), () => run(api.zoom(selCam, 'stop')));
    });
    $id('btnHome').addEventListener('click', () => run(api.home(selCam)));
  }

  // ---------- Beheer ----------

  /**
   * Rijen voor de DataTable: de zaalknoppen en alle zetels waar iemand spreekt, met hun koppeling.
   * @returns {{id:string, naam:string, fractie:string, camera:number|null, preset:number|null}[]}
   */
  const rowsData = () => [
    ...cfg.zaal.map((z) => ({ id: z.id, naam: z.label, fractie: 'Zaal' })),
    ...plan.seats.filter(isSpeaker).map((s) => ({ id: s.id, naam: s.naam, mic: s.mic ?? null, fractie: plan.fracties.find((f) => f.key === s.fractie && f.key !== 'geen')?.naam ?? '' })),
  ].map((r) => ({ ...r, camera: cfg.assign[r.id]?.camera ?? null, preset: cfg.assign[r.id]?.preset ?? null }));

  /** Maakt de DataTables-tabel (DataTables 2.x) en koppelt de knoppen "Oproepen" en "Bewerken". */
  function initTable() {
    table = new DataTable('#map', {
      data: rowsData(),
      pageLength: 25,
      order: [[3, 'asc']],
      language: { search: 'Zoeken:', lengthMenu: '_MENU_ per pagina', info: '_START_–_END_ van _TOTAL_', zeroRecords: 'Geen resultaten' },
      columns: [
        { title: 'Naam', data: 'naam', render: (d) => esc(d) },
        { title: 'Fractie', data: 'fractie', render: (d) => esc(d) },
        { title: 'Micropost', data: 'mic', defaultContent: '', width: '80px', render: (d) => d ?? '' },
        // Niet-gekoppelde rijen sorteren achteraan (99)
        { title: 'Camera', data: 'camera', defaultContent: '', render: (d, t) => (d ? (t === 'display' ? esc(camName(d)) : d) : (t === 'display' ? '<span class="mute">niet gekoppeld</span>' : 99)) },
        { title: 'Preset', data: 'preset', defaultContent: '', width: '70px', render: (d) => d ?? '' },
        {
          title: '', data: null, orderable: false, searchable: false, width: '200px',
          render: (_d, _t, row) => `<button data-act="go" data-id="${esc(row.id)}" ${row.camera ? '' : 'disabled'}>Oproepen</button><button data-act="edit" data-id="${esc(row.id)}">Bewerken</button>`,
        },
      ],
    });
    $id('map').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b || b.disabled) return;
      if (b.dataset.act === 'go') pick(b.dataset.id);
      if (b.dataset.act === 'edit') openAssign(b.dataset.id);
    });
  }

  /** Vult de tabel opnieuw met de huidige koppelingen en toont "x van y gekoppeld". */
  function refreshTable() {
    const data = rowsData();
    table.clear().rows.add(data).draw(false);
    const n = data.filter((r) => r.camera).length;
    $id('assignCount').textContent = `· ${n} van ${data.length} gekoppeld`;
  }

  // ---------- Tabs, instellingen, plan-import, log ----------

  // Wisselen tussen Bediening en Beheer
  document.querySelectorAll('.tabs button[data-tab]').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
    $id('viewOp').hidden = b.dataset.tab !== 'op';
    $id('viewAdmin').hidden = b.dataset.tab !== 'admin';
    if (b.dataset.tab === 'admin') table.columns.adjust();
  }));

  /** Toont de "Programma"-knoppen (BrightEye) bovenaan als de koppeling aanstaat. */
  function renderProgram() {
    const el = $id('program');
    const on = cfg.brighteye?.enabled;
    el.hidden = !on;
    if (!on) return;
    el.innerHTML = '<span>Programma:</span>' + cfg.cameras.map((c) => `<button data-prog="${c.id}">${c.id}</button>`).join('');
    el.querySelectorAll('[data-prog]').forEach((b) => b.addEventListener('click', () => run(api.program(Number(b.dataset.prog)))));
  }

  /**
   * Leest de camera-rijen uit het instellingenformulier en zet ze in `cfg.cameras`.
   * @param {HTMLFormElement} f
   */
  function readCamFields(f) {
    for (const c of cfg.cameras) {
      c.name = f.querySelector(`[data-n="${c.id}"]`).value.trim() || c.name;
      c.port = Number(f.querySelector(`[data-p="${c.id}"]`).value);
      c.viscaAddr = Number(f.querySelector(`[data-a="${c.id}"]`).value);
      c.beSource = Number(f.querySelector(`[data-b="${c.id}"]`).value);
    }
  }

  /**
   * Laat een camera even links-rechts bewegen zodat je ter plaatse ziet welke fysieke camera
   * bij dit nummer hoort. Gebruikt de waarden die nu in het formulier staan (eerst bewaard).
   * @param {number} id camera-nummer
   */
  async function wiggle(id) {
    readCamFields($id('formSettings'));
    await run(api.saveConfig(cfg));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const d of ['left', 'right', 'right', 'left']) {
      const r = await run(api.move(id, d, 30));
      if (!r.ok) return;
      await sleep(500);
      await run(api.move(id, 'stop'));
      await sleep(150);
    }
  }

  // Instellingen openen: IPL-host, per camera naam/poort/VISCA-adres/BrightEye-bron, BrightEye-gegevens
  $id('btnSettings').addEventListener('click', () => {
    const f = $id('formSettings');
    f.host.value = cfg.ipl.host;
    $id('camFields').innerHTML = '<legend>Welke camera is welk nummer? Pas de poort aan en klik Test.</legend>' +
      '<div class="camrow camhead"><span>Naam</span><span>IPL-poort</span><span>VISCA</span><span>Brighteye</span><span></span></div>' +
      cfg.cameras.map((c) => `<div class="camrow"><input data-n="${c.id}" value="${esc(c.name)}"><input data-p="${c.id}" type="number" value="${c.port}"><input data-a="${c.id}" type="number" min="1" max="7" value="${c.viscaAddr}"><input data-b="${c.id}" type="number" min="0" value="${c.beSource ?? 0}"><button type="button" data-test="${c.id}">Test</button></div>`).join('');
    $id('camFields').querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', () => wiggle(Number(b.dataset.test))));
    f.bEnabled.checked = !!cfg.brighteye.enabled;
    f.bHost.value = cfg.brighteye.host || '';
    f.bPort.value = cfg.brighteye.port || 5200;
    f.bDest.value = cfg.brighteye.dest ?? 0;
    $id('dlgSettings').showModal();
  });
  $id('setCancel').addEventListener('click', () => $id('dlgSettings').close());
  $id('formSettings').addEventListener('submit', async (e) => {
    const f = e.target;
    cfg.ipl.host = f.host.value.trim();
    readCamFields(f);
    Object.assign(cfg.brighteye, { enabled: f.bEnabled.checked, host: f.bHost.value.trim(), port: Number(f.bPort.value), dest: Number(f.bDest.value) });
    await persist();
  });

  // Zittingsplan importeren uit een backup-bestand van de zittingsplan-pagina
  $id('btnImportPlan').addEventListener('click', () => $id('planFile').click());
  $id('planFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const r = await run(api.importPlan(JSON.parse(await file.text())));
      if (r.ok) { plan = r.data; renderAll(); toast('Zittingsplan geïmporteerd'); }
    } catch { toast('Dat bestand is geen geldig JSON-bestand'); }
    e.target.value = '';
  });

  // Debugmodus: schakelaar in Beheer; het main-proces houdt dan verbindingen open en vraagt de laatste preset op.
  const banner = $id('lastPreset');
  $id('debugSw').addEventListener('change', async (e) => {
    cfg.debug = e.target.checked;
    banner.hidden = true;
    await persist();
  });

  // Banner boven het zaalplan: "Laatst opgeroepen: camera x preset yy" (met zetelnaam als de preset gekoppeld is)
  api.onLastPreset((e) => {
    const hit = Object.entries(cfg.assign).find(([, a]) => a.camera === e.camera && a.preset === e.preset);
    const who = hit ? ` — gekoppeld aan ${labelOf(hit[0])}` : '';
    banner.textContent = `Laatst opgeroepen: camera ${e.camera} preset ${e.preset}${who}`;
    banner.hidden = !cfg.debug;
  });

  // Test alle camera's met een power-inquiry; antwoorden verschijnen in het verkeerslog
  $id('btnPing').addEventListener('click', () => cfg.cameras.forEach((c) => run(api.ping(c.id))));

  // Verkeerslog: maximaal 200 regels, TX = verstuurd, RX = antwoord
  const logEl = $id('log');
  api.onLog((e) => {
    const time = new Date(e.t).toLocaleTimeString('nl-BE');
    const line = document.createElement('div');
    line.className = e.dir;
    line.textContent = `${time} ${e.dir.toUpperCase()} ${e.camera ? `cam${e.camera}` : ''} ${e.hex}`;
    logEl.appendChild(line);
    while (logEl.childNodes.length > 200) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  });

  /** Tekent alle onderdelen opnieuw na een wijziging van config of plan. */
  function renderAll() {
    renderPlan();
    renderZaal();
    renderCamSel();
    renderProgram();
    markActive();
    $id('debugSw').checked = Boolean(cfg.debug);
    if (!cfg.debug) banner.hidden = true;
    if (table) refreshTable();
  }

  // Opstarten: config en plan ophalen, dan tekenen
  (async () => {
    cfg = (await api.getConfig()).data;
    plan = (await api.getPlan()).data;
    buildPad();
    renderAll();
    initTable();
    refreshTable();
  })();
})();
