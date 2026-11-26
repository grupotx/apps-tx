// Verificación en dos pasos (2FA) al entrar a cualquier app. La activación vive solo en usuarios.html
// ("Mi seguridad"); este archivo solo hace cumplir lo ya activado al iniciar sesión.
// Como todas las apps viven en el mismo dominio (apps.grouptx.app) comparten la misma sesión guardada
// en el navegador: verificar el código en una app también vale para las demás mientras dure esa sesión.
// Script clásico: expone window.TMfa. Llamar a TMfa.gate(sb, {esAdmin}) justo después de confirmar que
// hay sesión activa, antes de mostrar nada de la app. Si devuelve false, no seguir: ya se encargó de
// avisar o de cerrar sesión.
(function (g) {
  'use strict';

  const CSS = `
    .mfa-ov{position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:12px}
    .mfa-dlg{background:var(--card,#fff);color:var(--ink,#121212);border:1px solid var(--line,#dfdfdb);border-radius:14px;padding:18px;width:min(380px,100%);box-shadow:0 24px 60px -20px rgba(0,0,0,.6)}
    .mfa-dlg h2{margin:0 0 6px;font-size:17px}
    .mfa-dlg p{margin:0 0 14px;font-size:13px;color:var(--mute,#5e6066)}
    .mfa-dlg input{width:100%;box-sizing:border-box;font:inherit;font-size:22px;letter-spacing:6px;text-align:center;padding:10px;border:1px solid var(--line,#dfdfdb);border-radius:10px;background:var(--sunk,#eaeae7);color:var(--ink,#121212)}
    .mfa-dlg .mfa-err{margin-top:8px;font-size:12.5px;color:#c0272d}
    .mfa-dlg .acciones{margin-top:14px;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}
    .mfa-dlg .btn{font:inherit;font-weight:700;border-radius:10px;padding:10px 14px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;background:var(--brand,#e4032e);color:var(--brand-ink,#fff);border:1px solid var(--brand,#e4032e)}
    .mfa-dlg .btn:hover{filter:brightness(1.06)}
    .mfa-dlg .btn[disabled]{opacity:.6;cursor:not-allowed}
    .mfa-dlg .btn.ghost{background:var(--card,#fff);color:var(--ink,#121212);border-color:var(--line,#dfdfdb)}
  `;

  function inyectaCss() {
    if (document.getElementById('mfa-gate-css')) return;
    const s = document.createElement('style');
    s.id = 'mfa-gate-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function cerrarSesion(sb) {
    return async () => { try { await sb.auth.signOut(); } catch (e) {} location.reload(); };
  }

  // El factor ya está verificado, pero esta sesión concreta todavía no pasó el segundo paso: pide el
  // código de 6 dígitos y lo verifica. Devuelve true si quedó en aal2, false si se cerró sesión.
  function pedirCodigo(sb, factorId) {
    inyectaCss();
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'mfa-ov';
      ov.innerHTML = `
        <div class="mfa-dlg" role="dialog" aria-modal="true">
          <h2>Código de verificación</h2>
          <p>Esta cuenta tiene activada la verificación en dos pasos. Ingresa el código de 6 dígitos de tu app de autenticación.</p>
          <input id="mfa-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000">
          <div class="mfa-err" id="mfa-err" hidden></div>
          <div class="acciones">
            <button type="button" class="btn ghost" id="mfa-salir">Cerrar sesión</button>
            <button type="button" class="btn" id="mfa-ok">Verificar</button>
          </div>
        </div>`;
      document.body.appendChild(ov);
      const input = ov.querySelector('#mfa-code');
      const err = ov.querySelector('#mfa-err');
      const okBtn = ov.querySelector('#mfa-ok');
      input.focus();
      const verificar = async () => {
        const code = input.value.trim();
        if (!/^\d{6}$/.test(code)) { err.textContent = 'Ingresa los 6 dígitos.'; err.hidden = false; return; }
        okBtn.disabled = true; okBtn.textContent = 'Verificando…'; err.hidden = true;
        const { data: ch, error: chErr } = await sb.auth.mfa.challenge({ factorId });
        if (chErr) { err.textContent = 'No se pudo iniciar la verificación. Revisa tu conexión e intenta de nuevo.'; err.hidden = false; okBtn.disabled = false; okBtn.textContent = 'Verificar'; return; }
        const { error: vErr } = await sb.auth.mfa.verify({ factorId, challengeId: ch.id, code });
        if (vErr) { err.textContent = 'Código incorrecto o vencido. Intenta de nuevo.'; err.hidden = false; okBtn.disabled = false; okBtn.textContent = 'Verificar'; input.select(); return; }
        ov.remove();
        resolve(true);
      };
      okBtn.onclick = verificar;
      input.onkeydown = (e) => { if (e.key === 'Enter') verificar(); };
      ov.querySelector('#mfa-salir').onclick = async () => { await cerrarSesion(sb)(); resolve(false); };
    });
  }

  // El rol exige 2FA (admin) pero esta cuenta todavía no activó ningún factor: no deja seguir, manda a
  // activarlo en usuarios.html.
  function mostrarBloqueo(sb) {
    inyectaCss();
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'mfa-ov';
      ov.innerHTML = `
        <div class="mfa-dlg" role="dialog" aria-modal="true">
          <h2>Activa la verificación en dos pasos</h2>
          <p>Tu cuenta es administradora: antes de continuar, activa el 2FA desde <b>Usuarios → Mi seguridad</b>.</p>
          <div class="acciones">
            <button type="button" class="btn ghost" id="mfa-salir3">Cerrar sesión</button>
            <a class="btn" href="/usuarios.html">Ir a Usuarios</a>
          </div>
        </div>`;
      document.body.appendChild(ov);
      ov.querySelector('#mfa-salir3').onclick = async () => { await cerrarSesion(sb)(); resolve(); };
    });
  }

  // Tope para las dos consultas de abajo: sin esto, un Supabase alcanzable pero lento (no un error de
  // red clasificable, solo colgado) dejaría el arranque de CUALQUIER app esperando para siempre. Mismo
  // criterio de "carrera con tope" que ya usan crm.html/mantencion.html/etc. para getSession().
  const esperaMfa = (ms) => new Promise((res) => setTimeout(() => res({ data: null, error: new Error('tope de espera') }), ms));

  // Llamar justo después de confirmar que hay sesión activa, antes de mostrar nada de la app.
  // opts.requireEnrollment: si esta cuenta DEBE tener 2FA activo para usar esta app (admin central) —
  // en usuarios.html (la página donde se activa) se pasa false aunque sea admin, para no bloquear a
  // quien todavía no se ha podido inscribir.
  // Devuelve true si se puede continuar normalmente con el arranque de la app.
  async function gate(sb, opts) {
    opts = opts || {};
    const { data: lf, error: lfErr } = await Promise.race([sb.auth.mfa.listFactors(), esperaMfa(6000)]);
    if (lfErr || !lf) return true; // sin red, muy lento u otro problema: no bloquear por esto
    const verificado = (lf.totp || []).find((f) => f.status === 'verified');
    if (!verificado) {
      if (opts.requireEnrollment) { await mostrarBloqueo(sb); return false; }
      return true; // nadie le exige 2FA y no tiene factor: nada que hacer
    }
    const { data: aal, error: aalErr } = await Promise.race([sb.auth.mfa.getAuthenticatorAssuranceLevel(), esperaMfa(6000)]);
    if (aalErr || !aal) return true;
    if (aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') return await pedirCodigo(sb, verificado.id);
    return true;
  }

  g.TMfa = { gate };
  if (typeof module !== 'undefined' && module.exports) module.exports = g.TMfa;
})(typeof window !== 'undefined' ? window : globalThis);
