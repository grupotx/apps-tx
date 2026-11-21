// Ventana de firma manuscrita compartida (registro-terreno.html y terreno-asistencia.html).
// Script clásico: expone window.TFirma.abrirFirma. Necesita window.TC (terreno-core.js) para generar el PNG.
// Inyecta su propio CSS la primera vez que se abre (no depende de las clases de la página que la usa).
(function (g) {
  'use strict';

  const FIRMA_ANCHO_PNG = 400;   // ancho del PNG guardado (recortado al trazo)
  const esPngFirma = (f) => g.TC.esPngFirma(f);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const CSS = `
    html.firma-abierta,html.firma-abierta body{overflow:hidden;overscroll-behavior:none}
    .firma-ov{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:12px;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
    .firma-dlg{background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:14px;padding:16px;width:min(680px,100%);max-height:100%;box-shadow:0 24px 60px -20px rgba(0,0,0,.6)}
    .firma-dlg h2{margin:0 0 4px;font-size:17px}
    .firma-dlg p{margin:0 0 10px;font-size:12.5px}
    .firma-lienzo{position:relative;width:min(100%,calc((100vh - 190px) * 2));width:min(100%,calc((100dvh - 190px) * 2));min-width:200px;aspect-ratio:2/1;margin:0 auto;background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden}
    .firma-lienzo::after{content:"";position:absolute;left:6%;right:6%;top:72%;border-top:1px dashed #b9bcc2;pointer-events:none}
    .firma-lienzo img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;opacity:.22;pointer-events:none}
    .firma-lienzo canvas{position:absolute;inset:0;width:100%;height:100%;touch-action:none;cursor:crosshair}
    .firma-dlg .acciones{margin-top:12px;justify-content:flex-end}
    .firma-ov .btn{background:var(--brand,#e4032e);color:var(--brand-ink,#fff);border:1px solid var(--brand,#e4032e);border-radius:10px;padding:11px 16px;font:inherit;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
    .firma-ov .btn:hover{filter:brightness(1.06)}
    .firma-ov .btn[disabled]{opacity:.6;cursor:not-allowed}
    .firma-ov .btn.ghost{background:var(--card,#fff);color:var(--ink,#121212);border-color:var(--line,#dfdfdb)}
    .firma-ov .acciones{display:flex;flex-wrap:wrap;gap:8px}
    .firma-ov .mute{color:var(--mute,#5e6066)}
  `;

  function inyectaCss() {
    if (document.getElementById('tfirma-css')) return;
    const st = document.createElement('style');
    st.id = 'tfirma-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  /* Abre una ventana para firmar con el dedo, lápiz o mouse (eventos pointer).
     Devuelve una promesa: el PNG en base64 (data URL) al aplicar, '' si se aplicó dejando la firma en blanco,
     o null al cancelar. `firma` (opcional) es la firma actual: se muestra tenue como guía.
     Los trazos se guardan como puntos normalizados (unidad = ancho del lienzo) y se redibujan al girar o
     cambiar de tamaño la pantalla; el PNG sale de TC.trazoAPng. */
  function abrirFirma({ titulo = 'Firma', firma = '' } = {}){
    return new Promise(resolve => {
      inyectaCss();
      const previo = document.activeElement;
      const trazos = [];
      let actual = null, pid = null, limpiada = false;
      const ov = document.createElement('div');
      ov.className = 'firma-ov';
      ov.innerHTML = `<div class="firma-dlg" role="dialog" aria-modal="true" aria-label="${esc(titulo)}">
        <h2>${esc(titulo)}</h2>
        <p class="mute">Firma con el dedo o el lápiz dentro del recuadro.</p>
        <div class="firma-lienzo">${esPngFirma(firma) ? `<img alt="" src="${esc(firma)}">` : ''}<canvas></canvas></div>
        <div class="acciones">
          <button type="button" class="btn ghost" data-f="limpiar">Limpiar</button>
          <button type="button" class="btn ghost" data-f="cancelar">Cancelar</button>
          <button type="button" class="btn" data-f="aplicar" disabled>Aplicar</button>
        </div></div>`;
      document.documentElement.classList.add('firma-abierta');
      document.body.appendChild(ov);
      const caja = ov.querySelector('.firma-lienzo'), cv = ov.querySelector('canvas'), ctx = cv.getContext('2d');
      const bAplicar = ov.querySelector('[data-f="aplicar"]');
      const refresca = () => { bAplicar.disabled = !(trazos.length || (limpiada && esPngFirma(firma))); };

      const grosor = () => Math.max(2, cv.width / 150);
      const px = p => [p.x * cv.width, p.y * cv.width];
      function estilo(){ ctx.lineWidth = grosor(); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111'; }
      function redibuja(){
        ctx.clearRect(0, 0, cv.width, cv.height);
        estilo();
        for (const t of trazos) {
          if (!t.length) continue;
          ctx.beginPath();
          ctx.moveTo(...px(t[0]));
          if (t.length === 1) ctx.lineTo(px(t[0])[0] + 0.01, px(t[0])[1]);
          for (let i = 1; i < t.length; i++) ctx.lineTo(...px(t[i]));
          ctx.stroke();
        }
      }
      function ajusta(){
        const r = caja.getBoundingClientRect(), k = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round(r.width * k)), h = Math.max(1, Math.round(r.height * k));
        if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
        redibuja();
      }
      const punto = e => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.width }; };
      function segmento(t, desde){
        estilo(); ctx.beginPath();
        ctx.moveTo(...px(t[desde - 1] || t[desde]));
        for (let i = desde; i < t.length; i++) ctx.lineTo(...px(t[i]));
        if (t.length === 1) ctx.lineTo(px(t[0])[0] + 0.01, px(t[0])[1]);
        ctx.stroke();
      }

      cv.addEventListener('pointerdown', e => {
        if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
        e.preventDefault();
        try { cv.setPointerCapture(e.pointerId); } catch(_){}
        pid = e.pointerId; actual = [punto(e)]; trazos.push(actual);
        segmento(actual, 0); refresca();
      });
      cv.addEventListener('pointermove', e => {
        if (!actual || e.pointerId !== pid) return;
        e.preventDefault();
        const desde = actual.length;
        const lote = e.getCoalescedEvents ? e.getCoalescedEvents() : [];   // a veces viene vacío
        for (const ev of lote.length ? lote : [e]) actual.push(punto(ev));
        segmento(actual, desde);
      });
      const fin = e => { if (actual && e.pointerId === pid) { actual = null; pid = null; } };
      cv.addEventListener('pointerup', fin);
      cv.addEventListener('pointercancel', fin);
      // El navegador no debe arrastrar, seleccionar ni desplazar la página mientras se firma.
      ov.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
      ov.addEventListener('contextmenu', e => e.preventDefault());
      ov.addEventListener('dragstart', e => e.preventDefault());

      const ro = window.ResizeObserver ? new ResizeObserver(ajusta) : null;
      const alGirar = () => setTimeout(ajusta, 150);
      if (ro) ro.observe(caja);
      window.addEventListener('resize', ajusta);
      window.addEventListener('orientationchange', alGirar);

      function cerrar(valor){
        if (ro) ro.disconnect();
        window.removeEventListener('resize', ajusta);
        window.removeEventListener('orientationchange', alGirar);
        document.removeEventListener('keydown', tecla, true);
        ov.remove();
        document.documentElement.classList.remove('firma-abierta');
        if (previo && previo.focus) try { previo.focus(); } catch(_){}
        resolve(valor);
      }
      function tecla(e){ if (e.key === 'Escape') { e.stopPropagation(); cerrar(null); } }
      document.addEventListener('keydown', tecla, true);
      ov.addEventListener('click', e => {
        const f = e.target.closest('[data-f]'); if (!f) return;
        if (f.dataset.f === 'limpiar') { trazos.length = 0; actual = null; limpiada = true; const im = caja.querySelector('img'); if (im) im.remove(); redibuja(); refresca(); }
        else if (f.dataset.f === 'cancelar') cerrar(null);
        else if (f.dataset.f === 'aplicar' && !f.disabled) cerrar(trazos.length ? TC.trazoAPng(trazos, FIRMA_ANCHO_PNG) : '');
      });
      ajusta();
      ov.querySelector('[data-f="cancelar"]').focus();
    });
  }

  g.TFirma = { abrirFirma };
  if (typeof module !== 'undefined' && module.exports) module.exports = g.TFirma;
})(typeof window !== 'undefined' ? window : globalThis);
