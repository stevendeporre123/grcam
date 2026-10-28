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

/* global jQuery, api, PlanView, LogFormat */
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
  /** Camera die nu op PGM staat (melding van het main-proces) en actieve microposten (API). */
  let pgmCam = null;
  let micActive = [];
  /** Zetel of zaalknop die rechtsboven getoond wordt. */
  let nowId = null;
  /** Welke variant van de getoonde plaats staat op PGM: 'main' (hoofd) of 'alt' (alternatief). */
  let nowVar = 'main';
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
    const { viewBox, html, flip, mx, my } = buildPlanSvg(plan, cfg.assign, { view: cfg.view, cameras: cfg.cameras, selCam, pgmCam });
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

  /** Verschuiving "translate(x y)" van een SVG-groep als getallen. @param {Element|null} g */
  const posOf = (g) => {
    const m = /translate\(([-\d.]+)[ ,]+([-\d.]+)\)/.exec(g?.getAttribute('transform') || '');
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  };

  /**
   * Markeert de laatst opgeroepen zetel of zaalknop: dikke pulserende rand in de kleur van de camera
   * en een stippellijn van die camera naar de zetel. Markeert ook de PGM-camera en de actieve microposten.
   */
  function markActive() {
    document.querySelectorAll('.seat.active, .zaal button.active').forEach((e) => e.classList.remove('active'));
    document.querySelectorAll('#plan .link').forEach((e) => e.remove());
    const a = activeId && cfg.assign[activeId];
    const col = a ? camColor(a.camera) : '#fff';
    $id('now').style.borderLeft = `6px solid ${a ? col : 'var(--line)'}`;
    if (activeId) {
      const seat = document.querySelector(`.seat[data-id="${CSS.escape(activeId)}"]`);
      if (seat) {
        seat.classList.add('active');
        seat.style.setProperty('--act', col);
        const cam = a && document.querySelector(`#plan .cam[data-cam="${a.camera}"]`);
        const p1 = posOf(cam); const p2 = posOf(seat);
        if (p1 && p2) $id('plan').querySelector('.seat').insertAdjacentHTML('beforebegin', `<line class="link" x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="${col}"/>`);
      }
      const zb = document.querySelector(`.zaal button[data-id="${CSS.escape(activeId)}"]`);
      if (zb) { zb.classList.add('active'); zb.style.setProperty('--act', col); }
    }
    markCams();
    markMics();
  }

  /** Toont welke camera op PGM staat (rode ring + label) en welke camera geselecteerd is (witte ring). */
  function markCams() {
    document.querySelectorAll('#plan .cam').forEach((c) => c.classList.toggle('pgm', pgmCam !== null && Number(c.dataset.cam) === pgmCam));
    document.querySelectorAll('#camSel button').forEach((b) => b.classList.toggle('pgm', pgmCam !== null && Number(b.dataset.cam) === pgmCam));
  }

  /** Markeert zetels waarvan de micropost aan staat (rood). Boven het plan staan de namen met een uit-knop per micro en "Alle micro's uit". */
  function markMics() {
    const on = new Set(micActive);
    const items = [];
    document.querySelectorAll('#plan .seat').forEach((g) => {
      const s = seatOf(g.dataset.id);
      const hit = Boolean(s && s.mic != null && on.has(s.mic));
      g.classList.toggle('mic-on', hit);
      if (hit) items.push({ mic: s.mic, text: `${s.naam} (mic ${s.mic})` });
    });
    for (const m of micActive) if (!plan.seats.some((s) => s.mic === m)) items.push({ mic: m, text: `onbekende micropost ${m}` });
    const el = $id('micInfo');
    const enabled = Boolean(cfg.micApi?.enabled && cfg.micApi?.host);
    el.hidden = !enabled;
    el.classList.toggle('quiet', !items.length);
    if (nowId) setNow(nowId); // knop "Micro aan/uit" volgt de stand
    el.innerHTML = '<span class="mi-text">' + (items.length ? 'Micropost aan:' : 'Geen micropost aan') + '</span>' +
      items.map((i) => `<span class="mi-chip">${esc(i.text)} <button data-micoff="${i.mic}" title="Deze micro uitschakelen">uit</button></span>`).join('') +
      '<button id="btnMuteAll" class="mi-all" title="Alle microposten uitschakelen">Alle micro\'s uit</button>';
  }

  $id('micInfo').addEventListener('click', async (e) => {
    const off = e.target.closest('[data-micoff]');
    if (off) { const r = await run(api.micOff(Number(off.dataset.micoff))); if (r.ok) toast(`Micropost ${off.dataset.micoff} uitgeschakeld`); return; }
    if (e.target.closest('#btnMuteAll')) {
      if (!confirm('Alle microposten uitschakelen (ook de voorzitter)?')) return;
      const r = await run(api.micMuteAll());
      if (r.ok) toast('Alle microposten uitgeschakeld');
    }
  });

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
      `<button data-cam="${c.id}" class="${c.id === selCam ? 'sel' : ''}${c.id === pgmCam ? ' pgm' : ''}" style="border-color:${camColor(c.id)}">${c.id}</button>`).join('');
  }

  /**
   * Toont rechtsboven wie er geselecteerd is en welke camera/preset daarbij hoort.
   * @param {string} id zetel- of zaal-id
   */
  function setNow(id) {
    nowId = id;
    const a = cfg.assign[id];
    const s = seatOf(id);
    const micOk = Boolean(s && s.mic != null && cfg.micApi?.enabled && cfg.micApi?.host);
    const isOn = micOk && micActive.includes(s.mic);
    const micBtn = micOk
      ? `<div class="now-mic"><span class="mute">Micropost ${s.mic}: ${isOn ? 'aan' : 'uit'}</span> ` +
        (isOn ? `<button data-micoff="${s.mic}">Micro uit</button>` : `<button data-micon="${s.mic}">Micro aan</button>`) + '</div>'
      : '';
    $id('now').innerHTML = (a
      ? `<b>${esc(labelOf(id))}</b>${esc(camName(a.camera))} · preset ${a.preset}${a.alt ? `<br><span class="mute">alternatief: ${esc(camName(a.alt.camera))} · preset ${a.alt.preset}</span><div class="now-var"><button data-var="main" data-id="${esc(id)}" class="${nowVar === 'main' ? 'on' : ''}" title="Hoofdcamera en -preset op PGM">Hoofd</button><button data-var="alt" data-id="${esc(id)}" class="${nowVar === 'alt' ? 'on' : ''}" title="Alternatieve camera en preset op PGM (de koppeling blijft zoals ze is)">Alternatief</button></div>` : ''}`
      : `<b>${esc(labelOf(id))}</b>Nog niet gekoppeld`) + micBtn;
  }

  // Micro aan/uit voor de getoonde zetel (knoppen in het blok rechtsboven)
  $id('now').addEventListener('click', async (e) => {
    const vr = e.target.closest('[data-var]');
    if (vr) {
      const as = cfg.assign[vr.dataset.id];
      const v = vr.dataset.var === 'alt' ? as?.alt : as;
      if (!v) return;
      nowVar = vr.dataset.var;
      setNow(vr.dataset.id);
      selectCamera(v.camera);
      const r = await run(api.seatGo({ camera: v.camera, preset: v.preset }));
      if (r.ok) toast(`${nowVar === 'alt' ? 'Alternatief' : 'Hoofd'}: ${camName(v.camera)} · preset ${v.preset}`); else { nowVar = nowVar === 'alt' ? 'main' : 'alt'; setNow(vr.dataset.id); }
      return;
    }
    const on = e.target.closest('[data-micon]');
    const off = e.target.closest('[data-micoff]');
    if (!on && !off) return;
    const n = Number((on || off).dataset.micon ?? (on || off).dataset.micoff);
    const r = await run(on ? api.micOn(n) : api.micOff(n));
    if (r.ok) toast(`Micropost ${n} ${on ? 'aangezet' : 'uitgeschakeld'}`);
  });

  /**
   * Klik op een zetel of zaalknop. In inleermodus opent dit de modal, anders wordt de preset opgeroepen.
   * @param {string} id zetel- of zaal-id
   */
  async function pick(id) {
    if (learn) { openAssign(id); return; }
    const a = cfg.assign[id];
    nowVar = 'main';
    setNow(id);
    if (!a) { toast(`${labelOf(id)}: nog geen camerapreset gekoppeld`); return; }
    selectCamera(a.camera);
    activeId = id; markActive(); // meteen tonen wat je gekozen hebt; bij een fout hieronder terugzetten
    const r = await run(api.seatGo({ camera: a.camera, preset: a.preset, alt: a.alt }));
    if (!r.ok) { activeId = null; markActive(); return; }
    if (r.data?.mode === 'alt') toast(`${camName(a.camera)} staat al live: eerst ${camName(a.alt.camera)}, straks ${camName(a.camera)}`);
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
    if (cam) {
      const id = Number(cam.dataset.cam);
      selectCamera(id);
      // Klik op de camera op het plan = die camera ook naar de programma-uitgang (BrightEye), niet in inleermodus.
      if (!learn && cfg.brighteye?.enabled) run(api.program(id)).then((r) => { if (r.ok) toast(`Camera ${id} naar programma`); });
      return;
    }
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
    f.camera.onchange = () => {
      if (!a) f.preset.value = nextFree(Number(f.camera.value));
      selectCamera(Number(f.camera.value));
    };
    // Alternatief: camera (of geen) + preset
    const camOpts = cfg.cameras.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    f.altCamera.innerHTML = '<option value="">— geen —</option>' + camOpts;
    f.altCamera.value = a?.alt ? String(a.alt.camera) : '';
    f.altPreset.value = a?.alt?.preset ?? '';
    document.querySelectorAll('.seat.pending').forEach((e) => e.classList.remove('pending'));
    document.querySelector(`.seat[data-id="${CSS.escape(id)}"]`)?.classList.add('pending');
    refreshAssignThumbs();
    selectCamera(Number(f.camera.value)); // de joystick rechts bestuurt meteen de camera van deze plaats
    const dlg = $id('dlgAssign');
    if (dlg.open) return; // in inleermodus blijft het venster openstaan; we hebben enkel de velden herladen
    if (learn) { dlg.classList.add('floating'); dlg.show(); } else { dlg.classList.remove('floating'); dlg.showModal(); }
  }

  /** Sluit de inleer-modal en haalt de markering van de zetel weg. */
  function closeAssign() {
    document.querySelectorAll('.seat.pending').forEach((e) => e.classList.remove('pending'));
    $id('dlgAssign').close();
  }

  /**
   * Leest camera en preset uit de modal.
   * @returns {{camera:number, preset:number, alt?:{camera:number,preset:number}}|null} null als het formulier ongeldig is
   */
  function assignFromForm() {
    const f = $id('formAssign');
    if (!f.reportValidity()) return null;
    const out = { camera: Number(f.camera.value), preset: Number(f.preset.value) };
    if (f.altCamera.value !== '') {
      const alt = { camera: Number(f.altCamera.value), preset: Number(f.altPreset.value) };
      if (f.altPreset.value === '' || !Number.isInteger(alt.preset) || alt.preset < 0 || alt.preset > 127) { toast('Vul een presetnummer (0-127) in voor het alternatief'); return null; }
      if (alt.camera === out.camera) { toast('Het alternatief moet een andere camera zijn dan de hoofdcamera'); return null; }
      out.alt = alt;
    }
    return out;
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

  // "Oproepen": de preset van deze plaats op de camera tonen (zonder PGM te wijzigen)
  $id('aGo').addEventListener('click', () => {
    const f = $id('formAssign');
    if (f.preset.value === '') { toast('Vul een presetnummer in'); return; }
    selectCamera(Number(f.camera.value));
    run(api.preset(Number(f.camera.value), Number(f.preset.value)));
    refreshAssignThumbs(1800);
  });
  $id('aAltGo').addEventListener('click', () => {
    const f = $id('formAssign');
    if (f.altCamera.value === '' || f.altPreset.value === '') { toast('Kies eerst een alternatieve camera en preset'); return; }
    selectCamera(Number(f.altCamera.value));
    run(api.preset(Number(f.altCamera.value), Number(f.altPreset.value)));
    refreshAssignThumbs(1800);
  });
  // "Hoofd ⇄ alternatief omwisselen": de twee posities verwisselen en meteen bewaren
  $id('aSwap').addEventListener('click', async () => {
    const f = $id('formAssign');
    if (f.altCamera.value === '' || f.altPreset.value === '') { toast('Er is nog geen alternatief om mee te wisselen'); return; }
    [f.camera.value, f.altCamera.value] = [f.altCamera.value, f.camera.value];
    [f.preset.value, f.altPreset.value] = [f.altPreset.value, f.preset.value];
    selectCamera(Number(f.camera.value));
    refreshAssignThumbs(1800);
    const a = assignFromForm();
    if (!a) return;
    if (!applyAssign(a)) return;
    await persist();
    toast(`${labelOf(editingId)}: hoofd en alternatief omgewisseld`);
  });
  // "Alternatief opslaan in camera": huidige positie van de alternatieve camera bewaren onder het alternatieve presetnummer
  $id('aAltStore').addEventListener('click', async () => {
    const f = $id('formAssign');
    if (f.altCamera.value === '' || f.altPreset.value === '') { toast('Kies eerst een alternatieve camera en preset'); return; }
    const cam = Number(f.altCamera.value); const pre = Number(f.altPreset.value);
    if (!confirm(`Huidige positie van ${camName(cam)} opslaan als preset ${pre}? De bestaande preset ${pre} in de camera wordt overschreven.`)) return;
    const r = await run(api.presetStore(cam, pre));
    if (r.ok) toast(`${camName(cam)}: preset ${pre} opgeslagen. Klik "Enkel koppelen" om het alternatief te bewaren.`);
  });

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
    thumbSoon($id('ptThumb'), $id('ptThumbMsg'), () => a.camera);
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
    $id('btnAF').addEventListener('click', () => run(api.focus(selCam)));
    // Kleine bijsturingen (positie, zoom, focus) tijdens de bediening bewaren in de preset van de actieve plaats.
    $id('btnSavePreset').addEventListener('click', async () => {
      const a = nowId && cfg.assign[nowId];
      const v = a && (nowVar === 'alt' ? a.alt : a);
      if (!v) { toast('Kies eerst een plaats met een gekoppelde preset'); return; }
      if (selCam !== v.camera) { toast(`Niet opgeslagen: de gekozen camera (${camName(selCam)}) hoort niet bij ${labelOf(nowId)} (${camName(v.camera)}). Kies die camera eerst.`); return; }
      const r = await run(api.presetStore(v.camera, v.preset));
      if (r.ok) toast(`Opgeslagen: ${labelOf(nowId)} (${nowVar === 'alt' ? 'alternatief' : 'hoofd'}) = ${camName(v.camera)} · preset ${v.preset}`);
    });
  }

  // ---------- Beheer ----------

  /**
   * Rijen voor de DataTable: de zaalknoppen en alle zetels waar iemand spreekt, met hun koppeling.
   * @returns {{id:string, naam:string, fractie:string, camera:number|null, preset:number|null}[]}
   */
  const rowsData = () => [
    ...cfg.zaal.map((z) => ({ id: z.id, naam: z.label, fractie: 'Zaal' })),
    ...plan.seats.filter(isSpeaker).map((s) => ({ id: s.id, naam: s.naam, mic: s.mic ?? null, fractie: plan.fracties.find((f) => f.key === s.fractie && f.key !== 'geen')?.naam ?? '' })),
  ].map((r) => ({ ...r, camera: cfg.assign[r.id]?.camera ?? null, preset: cfg.assign[r.id]?.preset ?? null, alt: cfg.assign[r.id]?.alt ?? null }));

  /** Maakt de DataTables-tabel (DataTables 2.x) en koppelt de knoppen "Oproepen" en "Bewerken". */
  function initTable() {
    table = new DataTable('#map', {
      data: rowsData(),
      pageLength: 25,
      autoWidth: false,
      order: [[3, 'asc']],
      language: { search: 'Zoeken:', lengthMenu: '_MENU_ per pagina', info: '_START_–_END_ van _TOTAL_', zeroRecords: 'Geen resultaten' },
      columns: [
        { title: 'Naam', data: 'naam', width: '22%', render: (d) => esc(d) },
        { title: 'Fractie', data: 'fractie', width: '13%', render: (d) => esc(d) },
        { title: 'Micropost', data: 'mic', defaultContent: '', width: '9%', render: (d) => d ?? '' },
        // Niet-gekoppelde rijen sorteren achteraan (99)
        { title: 'Camera', data: 'camera', defaultContent: '', width: '12%', render: (d, t) => (d ? (t === 'display' ? esc(camName(d)) : d) : (t === 'display' ? '<span class="mute">niet gekoppeld</span>' : 99)) },
        { title: 'Preset', data: 'preset', defaultContent: '', width: '7%', render: (d) => d ?? '' },
        { title: 'Alternatief', data: 'alt', defaultContent: '', width: '15%', render: (d, t) => (d ? (t === 'display' ? `${esc(camName(d.camera))} · ${d.preset}` : `${d.camera}-${String(d.preset).padStart(3, '0')}`) : (t === 'display' ? '' : '99')) },
        {
          title: '', data: null, orderable: false, searchable: false, width: '22%', className: 'acts',
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

  /** Schakelaar voor automatische micro-tracking (staat standaard uit en wordt niet bewaard). */
  function renderProgram() { /* de Programma-knoppen zijn vervangen door de tracking-schakelaar */ }
  function showTrack(s) {
    $id('trackSw').checked = Boolean(s.enabled);
    const seat = s.mic != null ? plan?.seats?.find((x) => x.mic === s.mic) : null;
    $id('trackInfo').textContent = !s.enabled ? '' : s.paused ? 'gepauzeerd (handmatig) – wacht op volgend micro' : seat ? `volgt ${seat.naam}` : 'wacht op een micro';
    $id('program').classList.toggle('on', Boolean(s.enabled));
    const tag = $id('modeTag');
    tag.className = `tag${s.enabled ? (s.paused ? ' paused' : ' auto') : ''}`;
    tag.textContent = !s.enabled ? 'handmatig' : s.paused ? 'handmatig (tracking gepauzeerd)' : seat ? `automatisch · ${seat.naam}` : 'automatisch';
  }
  $id('trackSw').addEventListener('change', async (e) => {
    if (e.target.checked && !(cfg.micApi?.enabled && cfg.micApi?.host)) { e.target.checked = false; toast('Zet eerst de CoCon-koppeling aan (Beheer → Instellingen)'); return; }
    const r = await run(api.trackSet(e.target.checked));
    if (r.ok) showTrack(r.data); else e.target.checked = !e.target.checked;
  });
  api.onTrack(showTrack);
  api.onActive(({ id }) => {
    const a = cfg.assign[id];
    if (!a) return;
    nowVar = 'main';
    activeId = id;
    setNow(id);
    selectCamera(a.camera);
    markActive();
  });
  api.trackGet().then((r) => { if (r.ok) showTrack(r.data); });

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
    f.uCheck.checked = cfg.updateCheck !== false;
    api.appInfo().then((r) => { if (r.ok) $id('appInfo').textContent = `Versie ${r.data.version} · gegevens in ${r.data.dataDir}`; });
    $id('camFields').innerHTML = '<legend>Welke camera is welk nummer? Pas de poort aan en klik Test.</legend>' +
      '<div class="camrow camhead"><span>Naam</span><span>IPL-poort</span><span>VISCA</span><span>Brighteye</span><span></span></div>' +
      cfg.cameras.map((c) => `<div class="camrow"><input data-n="${c.id}" value="${esc(c.name)}"><input data-p="${c.id}" type="number" value="${c.port}"><input data-a="${c.id}" type="number" min="1" max="7" value="${c.viscaAddr}"><input data-b="${c.id}" type="number" min="0" value="${c.beSource ?? 0}"><button type="button" data-test="${c.id}">Test</button></div>`).join('');
    $id('camFields').querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', () => wiggle(Number(b.dataset.test))));
    f.bEnabled.checked = !!cfg.brighteye.enabled;
    f.bHost.value = cfg.brighteye.host || '';
    f.bPort.value = cfg.brighteye.port || 5200;
    f.bDest.value = cfg.brighteye.dest ?? 1;
    f.tTake.value = cfg.timing?.takeDelayMs ?? 1500;
    f.tAlt.value = cfg.timing?.altHoldMs ?? 4000;
    const m = cfg.micApi || {};
    f.mEnabled.checked = !!m.enabled; f.mHost.value = m.host || ''; f.mPort.value = m.port || 8890;
    f.bPvw.value = cfg.brighteye.pvwDest ?? 0;
    f.trOverview.innerHTML = '<option value="">— niets doen —</option>' + (cfg.zaal || []).map((z) => `<option value="${esc(z.id)}">${esc(z.label)}</option>`).join('');
    f.trOverview.value = cfg.tracking?.overview ?? '';
    f.trDelay.value = cfg.tracking?.delayMs ?? 5000;
    const th = cfg.brighteye.thumbs || {};
    f.thEnabled.checked = th.enabled !== false; f.thPort.value = th.port || 8080; f.thMs.value = th.intervalMs || 3000; f.thPgm.value = th.pgmSrc ?? 5; f.thGuid.value = th.cpguid || '';
    $id('dlgSettings').showModal();
  });
  $id('setCancel').addEventListener('click', () => $id('dlgSettings').close());
  $id('formSettings').addEventListener('submit', async (e) => {
    const f = e.target;
    // "http://10.0.0.1/" of "10.0.0.1:5200" -> "10.0.0.1"
    const clean = (v) => v.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');
    cfg.ipl.host = clean(f.host.value);
    readCamFields(f);
    cfg.updateCheck = f.uCheck.checked;
    Object.assign(cfg.brighteye, { enabled: f.bEnabled.checked, host: clean(f.bHost.value), port: Number(f.bPort.value), dest: Number(f.bDest.value), pvwDest: Number(f.bPvw.value) });
    cfg.tracking = { overview: f.trOverview.value, delayMs: Math.max(0, Number(f.trDelay.value) || 0) };
    cfg.brighteye.thumbs = { enabled: f.thEnabled.checked, port: Number(f.thPort.value) || 8080, intervalMs: Math.max(1000, Number(f.thMs.value) || 3000), pgmSrc: Number(f.thPgm.value) || 0, cpguid: f.thGuid.value.trim() };
    cfg.timing = { takeDelayMs: Number(f.tTake.value) || 0, altHoldMs: Number(f.tAlt.value) || 0 };
    cfg.micApi = { enabled: f.mEnabled.checked, host: clean(f.mHost.value), port: Number(f.mPort.value) || 8890 };
    await persist();
  });
  $id('mTest').addEventListener('click', async () => {
    const f = $id('formSettings');
    const clean = (v) => v.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');
    const r = await run(api.micTest({ host: clean(f.mHost.value), port: Number(f.mPort.value) || 8890 }));
    if (r.ok) toast('CoCon API bereikbaar, zie het verkeerslog voor de stand');
  });

  // ---------- Updates ----------

  /** Laatst gevonden release. */
  let upd = null;
  const btnUpd = $id('btnUpdate');

  /** Toont de oranje "Update beschikbaar"-knop. @param {object} u */
  function showUpdate(u) {
    upd = u;
    btnUpd.hidden = !u.newer;
    btnUpd.textContent = `Update ${u.latest} beschikbaar`;
  }

  /** Opent het updatevenster met versie en release-notes. */
  function openUpdate() {
    $id('updTitle').textContent = `Versie ${upd.latest} beschikbaar`;
    $id('updInfo').textContent = `Je gebruikt versie ${upd.current}.${upd.asset ? '' : ' Deze release bevat geen .exe.'}`;
    $id('updNotes').textContent = upd.notes || '(geen release-notes)';
    $id('updBar').hidden = true;
    $id('updGo').disabled = !upd.asset;
    $id('dlgUpdate').showModal();
  }

  /** Controleert handmatig op een nieuwe versie. */
  async function checkUpdates() {
    const r = await run(api.checkUpdate());
    if (!r.ok) return;
    showUpdate(r.data);
    if (r.data.newer) openUpdate(); else toast(`Je hebt de laatste versie (${r.data.current})`);
  }

  btnUpd.addEventListener('click', () => upd && openUpdate());
  $id('btnUpdateCheck').addEventListener('click', checkUpdates);
  $id('updLater').addEventListener('click', () => $id('dlgUpdate').close());
  api.onUpdateAvailable(showUpdate);
  api.onUpdateProgress((p) => { $id('updBar').value = p.percent; });
  $id('updGo').addEventListener('click', async () => {
    $id('updGo').disabled = true;
    $id('updBar').hidden = false;
    $id('updBar').value = 0;
    const r = await run(api.installUpdate());
    if (!r.ok) { $id('updGo').disabled = false; return; }
    await run(api.launchUpdate()); // de app sluit en de nieuwe versie start
  });

  // ---------- Back-up ----------

  // Back-up maken: één JSON-bestand met instellingen, koppelingen en zittingsplan
  $id('btnBackup').addEventListener('click', async () => {
    const r = await run(api.exportBackup());
    if (!r.ok) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' }));
    a.download = `ptz-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  // Back-up terugzetten
  $id('btnRestore').addEventListener('click', () => $id('backupFile').click());
  $id('backupFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!confirm('Alle huidige instellingen, koppelingen en het zittingsplan worden vervangen door de back-up. Doorgaan?')) return;
    try {
      const r = await run(api.restoreBackup(JSON.parse(await file.text())));
      if (!r.ok) return;
      cfg = r.data.config;
      plan = r.data.plan;
      renderAll();
      toast('Back-up teruggezet');
    } catch { toast('Dat bestand is geen geldig JSON-bestand'); }
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

  // Camera op PGM en actieve microposten komen uit het main-proces
  api.onPgm((d) => { pgmCam = d.camera ?? null; renderCamSel(); markCams(); });
  api.onMics((d) => { micActive = d.active || []; markMics(); });

  // Test alle camera's met een power-inquiry; antwoorden verschijnen in het verkeerslog
  // Test alle camera's; de volledige test (met debug ook de laatste preset, plus Brighteye) loopt in het main-proces.
  $id('btnPing').addEventListener('click', () => run(api.testAll()));

  // ---------- Miniaturen (BrightEye) ----------
  /** Haalt een miniatuur op en zet die in een <img>; toont de fout in `msgEl`. */
  async function thumbInto(img, msgEl, camera) {
    if (!cfg.brighteye?.enabled || cfg.brighteye.thumbs?.enabled === false) { img.hidden = true; if (msgEl) msgEl.textContent = ''; return; }
    const r = await api.thumb(camera);
    if (r.ok) { img.src = r.data.image; img.hidden = false; if (msgEl) msgEl.textContent = ''; }
    else { img.hidden = true; if (msgEl) msgEl.textContent = r.error; }
  }
  const thumbSoon = (img, msgEl, camGetter, ms = 1800) => setTimeout(() => thumbInto(img, msgEl, camGetter()), ms);
  let thumbTimer = null;
  let thumbBusy = false;
  /** Bouwt de strook met 4 camera's en PGM onder het plan en ververst die met een vast interval. */
  let thumbSig = '';
  function renderThumbs() {
    const box = $id('thumbs');
    const t = cfg.brighteye?.thumbs;
    const sig = JSON.stringify([cfg.brighteye?.enabled, cfg.brighteye?.host, t, cfg.cameras.map((c) => [c.id, c.name, c.beSource])]);
    if (sig === thumbSig) return; // niets gewijzigd: de lopende verversing blijft
    thumbSig = sig;
    clearInterval(thumbTimer);
    const on = cfg.brighteye?.enabled && cfg.brighteye.host && t?.enabled !== false;
    box.hidden = !on;
    if (!on) return;
    box.innerHTML = [...cfg.cameras.map((c) => ({ id: c.id, t: c.name })), { id: 'pgm', t: 'PGM' }]
      .map((o) => `<div class="th ${o.id === 'pgm' ? 'pgm' : ''}" data-th="${o.id}"><div class="ph"></div><span>${esc(o.t)}</span></div>`).join('');
    const MAX_FOUTEN = 3; // na meer dan 3 opeenvolgende fouten stopt het ophalen van die miniatuur
    const tick = async () => {
      if (thumbBusy || document.hidden) return;
      thumbBusy = true;
      try {
        await Promise.all([...box.querySelectorAll('.th:not(.stopped)')].map(async (el) => {
          const id = el.dataset.th === 'pgm' ? 'pgm' : Number(el.dataset.th);
          const r = await api.thumb(id);
          el.dataset.fails = r.ok ? '0' : String(Number(el.dataset.fails || 0) + 1);
          if (!r.ok && Number(el.dataset.fails) > MAX_FOUTEN) {
            el.classList.add('stopped');
            el.title = `Gestopt na ${MAX_FOUTEN + 1} fouten: ${r.error}`;
            const ph = el.querySelector('img, .ph'); if (ph) ph.style.opacity = '0.35';
            return;
          }
          const ph = el.querySelector('.ph, img');
          if (r.ok) {
            if (ph.tagName !== 'IMG') { const im = document.createElement('img'); im.alt = ''; ph.replaceWith(im); }
            el.querySelector('img').src = r.data.image;
            el.title = '';
            if (id === 'pgm') el.querySelector('span').textContent = r.data.camera ? `PGM: ${camName(r.data.camera)}` : 'PGM';
          } else { el.title = r.error; }
        }));
      } finally { thumbBusy = false; }
      if (!box.querySelector('.th:not(.stopped)')) { // alles gestopt: stop de timer en bied handmatig opnieuw proberen aan
        clearInterval(thumbTimer);
        if (!box.querySelector('.retry')) box.insertAdjacentHTML('beforeend', '<button type="button" class="retry" title="Miniaturen opnieuw proberen">Miniaturen gestopt na fouten — opnieuw proberen</button>');
      }
    };
    tick();
    thumbTimer = setInterval(tick, Math.max(1000, Number(t.intervalMs) || 3000));
  }
  $id('thumbs').addEventListener('click', (e) => {
    if (!e.target.closest('.retry')) return;
    thumbSig = ''; // forceert een nieuwe opbouw met teller op nul
    renderThumbs();
  });
  // Miniatuur in de preset-tool en in de koppelmodal
  $id('ptCam').addEventListener('change', () => thumbInto($id('ptThumb'), $id('ptThumbMsg'), Number($id('ptCam').value)));
  /** Ververst de twee miniaturen (hoofd en alternatief) in het koppelvenster, eventueel na een wachttijd (camera moet eerst bewegen). */
  function refreshAssignThumbs(delay = 0) {
    const f = $id('formAssign');
    const go = () => {
      thumbInto($id('asThumb'), $id('asThumbMsg'), Number(f.camera.value));
      if (f.altCamera.value !== '') thumbInto($id('asThumbAlt'), $id('asThumbAltMsg'), Number(f.altCamera.value));
      else { $id('asThumbAlt').hidden = true; $id('asThumbAltMsg').textContent = '(geen alternatief)'; }
    };
    if (delay) setTimeout(go, delay); else go();
  }
  // Zolang het preset-hulpmiddel of het koppelvenster openstaat, verversen de miniaturen vanzelf (de camera heeft tijd nodig om te bewegen).
  let liveBusy = false;
  setInterval(async () => {
    if (liveBusy || document.hidden || !cfg?.brighteye?.enabled) return;
    const tools = $id('dlgTools').open; const assign = $id('dlgAssign').open;
    if (!tools && !assign) return;
    liveBusy = true;
    try {
      const jobs = [];
      if (tools) jobs.push(thumbInto($id('ptThumb'), $id('ptThumbMsg'), Number($id('ptCam').value)));
      if (assign) {
        const f = $id('formAssign');
        jobs.push(thumbInto($id('asThumb'), $id('asThumbMsg'), Number(f.camera.value)));
        if (f.altCamera.value !== '') jobs.push(thumbInto($id('asThumbAlt'), $id('asThumbAltMsg'), Number(f.altCamera.value)));
      }
      await Promise.all(jobs);
    } finally { liveBusy = false; }
  }, Math.max(1000, Number(cfg?.brighteye?.thumbs?.intervalMs) || 2000));
  $id('formAssign').camera.addEventListener('change', () => refreshAssignThumbs());
  $id('formAssign').altCamera.addEventListener('change', () => refreshAssignThumbs());
  $id('aAF').addEventListener('click', () => { const f = $id('formAssign'); selectCamera(Number(f.camera.value)); run(api.focus(Number(f.camera.value))); refreshAssignThumbs(2500); });
  $id('aAltAF').addEventListener('click', () => {
    const f = $id('formAssign');
    if (f.altCamera.value === '') { toast('Kies eerst een alternatieve camera'); return; }
    selectCamera(Number(f.altCamera.value)); run(api.focus(Number(f.altCamera.value))); refreshAssignThumbs(2500);
  });
  // Klik op een miniatuur onder het plan = die camera meteen op PGM, zonder waarschuwing
  $id('thumbs').addEventListener('click', (e) => {
    const th = e.target.closest('.th[data-th]');
    if (!th || th.dataset.th === 'pgm') return;
    const id = Number(th.dataset.th);
    selectCamera(id);
    run(api.program(id)).then((r) => { if (r.ok) toast(`${camName(id)} naar PGM`); });
  });

  // ---------- Preset uitproberen ----------
  function fillPresetTry() {
    const sel = $id('ptCam');
    const cur = sel.value;
    sel.innerHTML = cfg.cameras.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    if (cur) sel.value = cur;
  }
  /** Vult de lijst met personen/banken (zaalknoppen + plaatsen) om een geprobeerde preset aan te koppelen. */
  function fillPresetSeats() {
    const sel = $id('ptSeat');
    const cur = sel.value;
    const names = (plan.seats || []).filter((s) => s.naam).map((s) => ({ id: s.id, t: s.naam }));
    const zalen = (cfg.zaal || []).map((z) => ({ id: z.id, t: `Zaal: ${z.label}` }));
    const all = [...zalen, ...names.sort((a, b) => a.t.localeCompare(b.t, 'nl'))];
    sel.innerHTML = all.map((o) => `<option value="${esc(o.id)}">${esc(o.t)}</option>`).join('');
    if (cur) sel.value = cur;
  }
  $id('ptLink').addEventListener('click', async () => {
    const id = $id('ptSeat').value;
    const camera = Number($id('ptCam').value);
    const preset = Number($id('ptNum').value);
    const kind = $id('ptKind').value;
    if (!id || !Number.isInteger(preset) || preset < 0 || preset > 127) { toast('Kies een plaats en een presetnummer (0-127)'); return; }
    const cur = cfg.assign[id];
    if (kind === 'alt') {
      if (!cur) { toast(`${labelOf(id)} heeft nog geen hoofdpreset; koppel die eerst`); return; }
      if (cur.camera === camera) { toast('Het alternatief moet een andere camera zijn dan de hoofdcamera'); return; }
      cfg.assign[id] = { ...cur, alt: { camera, preset } };
    } else {
      if (cur?.alt && cur.alt.camera === camera) { toast('De hoofdcamera mag niet gelijk zijn aan de alternatieve camera'); return; }
      cfg.assign[id] = { ...cur, camera, preset };
    }
    await persist();
    toast(`${labelOf(id)}: ${kind === 'alt' ? 'alternatief' : 'hoofdpreset'} = ${camName(camera)} · preset ${preset}`);
  });
  /** Toont of de gekozen camera+preset al aan een plaats of persoon gekoppeld is (hoofd of alternatief). */
  function showPresetUse() {
    const cam = Number($id('ptCam').value); const pre = Number($id('ptNum').value);
    const uses = [];
    for (const [id, a] of Object.entries(cfg.assign)) {
      if (a.camera === cam && a.preset === pre) uses.push(`${labelOf(id)} (hoofd)`);
      if (a.alt && a.alt.camera === cam && a.alt.preset === pre) uses.push(`${labelOf(id)} (alternatief)`);
    }
    $id('ptUse').textContent = uses.length ? `Al gekoppeld aan: ${uses.join(', ')}` : `${camName(cam)} · preset ${pre}: nog niet gekoppeld`;
    $id('ptUse').classList.toggle('used', uses.length > 0);
  }
  $id('ptCam').addEventListener('change', showPresetUse);
  $id('ptNum').addEventListener('input', showPresetUse);
  async function presetTry(target) {
    const camera = Number($id('ptCam').value);
    const preset = Number($id('ptNum').value);
    if (target && !cfg.brighteye?.enabled) { toast('Zet eerst de Brighteye-koppeling aan (Beheer → Instellingen)'); return; }
    if (target === 'pgm' && !confirm(`Preset ${preset} oproepen op camera ${camera} en die camera LIVE op PGM zetten?`)) return;
    const r = await run(api.presetTry(camera, preset, target));
    if (r.ok) { toast(`Camera ${camera}: preset ${preset} opgeroepen${target ? ` en naar ${target.toUpperCase()}` : ''}`); thumbSoon($id('ptThumb'), $id('ptThumbMsg'), () => camera); }
  }
  $id('ptOnly').addEventListener('click', () => presetTry(null));
  $id('ptPvw').addEventListener('click', () => presetTry('pvw'));
  $id('ptPgm').addEventListener('click', () => presetTry('pgm'));
  $id('btnLogWin').addEventListener('click', () => run(api.openLogWindow()));
  // Hulpmiddelen: zwevend (niet-modaal) venster zodat het log en de rest zichtbaar blijven
  const openTools = () => { const d = $id('dlgTools'); if (!d.open) d.show(); thumbInto($id('ptThumb'), $id('ptThumbMsg'), Number($id('ptCam').value)); };
  $id('btnTools').addEventListener('click', openTools);
  $id('btnTools2').addEventListener('click', openTools);
  $id('toolsClose').addEventListener('click', () => $id('dlgTools').close());

  // De debugstand kan ook in het logvenster gewijzigd worden.
  api.onDebugChanged((on) => { cfg.debug = on; $id('debugSw').checked = on; if (!on) banner.hidden = true; });

  // Verkeerslog: maximaal 200 regels, TX = verstuurd, RX = antwoord
  const logEl = $id('log');
  api.onLog((e) => {
    const line = document.createElement('div');
    line.className = e.dir;
    line.textContent = LogFormat.format(e);
    logEl.appendChild(line);
    while (logEl.childNodes.length > 200) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  });

  /** Tekent alle onderdelen opnieuw na een wijziging van config of plan. */
  function renderAll() {
    renderPlan();
    renderZaal();
    renderCamSel();
    renderProgram(); fillPresetTry(); fillPresetSeats(); showPresetUse(); renderThumbs();
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
    micActive = (await api.micState()).data?.active || [];
    renderAll();
    initTable();
    refreshTable();
  })();
})();
