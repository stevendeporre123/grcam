'use strict';

/**
 * @file Tekent het zittingsplan als SVG-markup.
 * Werkt in de browser (`window.PlanView`) en in Node (`require`, voor de tests).
 *
 * Coördinaten van zetels, kader en camera's staan in de "plan-ruimte" van de zittingsplan-pagina
 * (`plan.bg` = begrenzing). In het zicht 'ambtenaren' worden enkel de posities 180° gedraaid
 * om het middelpunt van het kader; de tekst van de zetels blijft rechtop.
 */
(function (root) {
  /** Kleur per camera (1-4); wordt herhaald bij meer camera's. */
  const CAM_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#a855f7'];
  /** @param {number} id camera-nummer @returns {string} CSS-kleur */
  const camColor = (id) => CAM_COLORS[(Number(id) - 1) % CAM_COLORS.length] || '#888';

  /** Escapet tekst voor gebruik in HTML/SVG. @param {any} s @returns {string} */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /**
   * Zetels die aanklikbaar zijn (preset). Standaard: iedereen behalve medewerkers, kabinetten en pers.
   * Een expliciet `spreker: true/false` op de zetel (instelbaar in de app) heeft voorrang.
   */
  const isSpeaker = (s) => (typeof s.spreker === 'boolean' ? s.spreker
    : !['Kabinetten', 'Pers'].includes(s.groep) && !/medewerker|vertrouwenspersoon/i.test(s.naam));

  /**
   * Bouwt de SVG-inhoud voor het plan.
   * @param {{fracties:{key:string,naam:string,kleur:string}[], seats:object[], bg:{x:number,y:number,w:number,h:number}, decor?:object}} plan
   * @param {Record<string,{camera:number,preset:number}>} assign zetel-id -> camera + preset
   * @param {{view?:'ambtenaren'|'zaal', cameras?:{id:number,name:string,pos?:{x:number,y:number}}[], selCam?:number}} [opts]
   *   `view` 'ambtenaren' = 180° gedraaid; `cameras` = markeringen; `selCam` = gemarkeerde camera
   * @returns {{viewBox:string, html:string, flip:boolean, mx:number, my:number}} viewBox-waarde, SVG-elementen en
   *   het spiegelpunt (nodig om schermpositie terug naar plan-coördinaten om te rekenen)
   */
  function buildPlanSvg(plan, assign, opts = {}) {
    const fr = Object.fromEntries(plan.fracties.map((f) => [f.key, f.kleur]));
    const { bg, decor } = plan;
    // 'ambtenaren': plan 180° gedraaid (zicht vanaf de ambtenarenbank). Alleen posities spiegelen, tekst blijft rechtop.
    const flip = opts.view === 'ambtenaren';
    const mx = decor?.frame?.cx ?? bg.x + bg.w / 2;
    const my = decor?.frame?.cy ?? bg.y + bg.h / 2;
    const px = (x) => (flip ? 2 * mx - x : x);
    const py = (y) => (flip ? 2 * my - y : y);
    let html = '';

    if (decor?.frame) {
      const f = decor.frame;
      html += `<rect class="plan-bg" x="${f.cx - f.w / 2}" y="${f.cy - f.h / 2}" width="${f.w}" height="${f.h}"/>`;
    }
    for (const g of decor?.greyfills ?? []) {
      html += `<rect class="plan-grey" x="${px(g.cx) - g.w / 2}" y="${py(g.cy) - g.h / 2}" width="${g.w}" height="${g.h}"/>`;
    }

    for (const s of plan.seats) {
      const speaker = isSpeaker(s);
      const a = assign[s.id];
      const stroke = s.rand === 'zwart' ? '#4b5563' : fr[s.fractie] || '#888';
      const sw = s.rand === 'zwart' ? 0.8 : 2.4;
      const cls = ['seat', speaker ? (a ? 'set' : 'free') : 'off'].join(' ');
      const fs = s.fs || 8;
      const line = (txt, y, size) => {
        if (!txt) return '';
        const fit = txt.length * size * 0.56 > s.w - 6 ? ` textLength="${(s.w - 6).toFixed(1)}" lengthAdjust="spacingAndGlyphs"` : '';
        return `<text x="0" y="${y}" font-size="${size}" text-anchor="middle"${fit}>${esc(txt)}</text>`;
      };
      const two = Boolean(s.regel2);
      html += `<g class="${cls}" data-id="${esc(s.id)}" transform="translate(${px(s.cx).toFixed(2)} ${py(s.cy).toFixed(2)}) rotate(${s.ang || 0})">` +
        `<title>${esc(s.naam)}${s.regel2 ? ' · ' + esc(s.regel2) : ''}${s.mic ? ` · micropost ${esc(s.mic)}` : ''}${a ? ` → camera ${a.camera}, preset ${a.preset}` : ''}</title>` +
        `<rect class="base" x="${-s.w / 2}" y="${-s.h / 2}" width="${s.w}" height="${s.h}" rx="2" fill="#1f252d" stroke="${stroke}" stroke-width="${sw}"/>` +
        (a ? `<rect x="${-s.w / 2}" y="${-s.h / 2}" width="${s.w}" height="${s.h}" rx="2" fill="${camColor(a.camera)}" fill-opacity="0.32" pointer-events="none"/>` : '') +
        line(s.naam, two ? -1.5 : fs * 0.35, fs) +
        line(s.regel2, 8, Math.max(6, fs - 1)) +
        '</g>';
    }

    // Camera's als genummerde markering (positie in plan-coördinaten, net als de zetels).
    for (const c of opts.cameras ?? []) {
      if (!c.pos) continue;
      const sel = c.id === opts.selCam ? ' sel' : '';
      html += `<g class="cam${sel}" data-cam="${c.id}" transform="translate(${px(c.pos.x).toFixed(2)} ${py(c.pos.y).toFixed(2)})">` +
        `<title>${esc(c.name)}</title>` +
        `<circle r="10" fill="${camColor(c.id)}" stroke="#0b0d10" stroke-width="1.5"/>` +
        `<text x="0" y="4.2" font-size="12" font-weight="700" text-anchor="middle" fill="#0b0d10">${c.id}</text></g>`;
    }

    // Kabinetvakken steken iets voorbij het kader uit: marge rechts (of links bij gedraaid zicht).
    const x0 = flip ? bg.x - 24 : bg.x;
    return { viewBox: `${x0} ${bg.y} ${bg.w + 24} ${bg.h}`, html, flip, mx, my };
  }

  const api = { buildPlanSvg, isSpeaker, camColor, esc, CAM_COLORS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PlanView = api;
})(typeof window !== 'undefined' ? window : globalThis);
