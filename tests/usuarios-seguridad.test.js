const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// "Mi seguridad" (activar el 2FA) es la única forma de que una persona active su verificación en dos
// pasos, y Reportes TX exige ese 2FA para RRHH y Finanzas. Por eso la ven TODAS las cuentas activas,
// no solo los administradores. La lista de usuarios y sus módulos (admin_usuarios) sigue siendo solo
// para administradores. Aquí se ejecuta el start() real de usuarios.html contra un Supabase y un DOM
// de mentira (sin red, sin credenciales).
const RAIZ = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(RAIZ, 'usuarios.html'), 'utf8');

// El script de la página (el que define start()) sin la llamada final start(), que hace la prueba.
function scriptDeLaPagina() {
  const s = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((x) => x.includes('async function start()'));
  assert.ok(s, 'usuarios.html no tiene el script con start()');
  assert.match(s, /\nstart\(\);\s*$/, 'el script debe terminar llamando a start()');
  return s.replace(/\nstart\(\);\s*$/, '\n');
}

const elemento = () => ({
  innerHTML: '', textContent: '', value: '', disabled: false, hidden: false, onclick: null, onsubmit: null,
  dataset: {}, classList: { add() {}, remove() {} }, focus() {}, setSelectionRange() {}, closest: () => null,
});

const USUARIO_LISTA = {
  id: 'u-2', nombre: 'Rosa Pérez', email: 'rosa@grupotx.cl', cargo: 'Gerente RRHH', cuenta_activa: true, modulos: { rep_rrhh: { activo: true } },
};

// Corre start() con la sesión y el perfil dados. `factores`: factores TOTP de la persona; `gate`: lo que
// responde TMfa.gate (false = la persona cerró sesión en el aviso del código).
async function correr({ sesion = true, perfil, factores = [], gate = true }) {
  const llamadas = { rpc: [], gate: [], tablas: [], listFactors: 0 };
  const elementos = new Map();
  const sb = {
    auth: {
      getSession: async () => ({ data: { session: sesion ? { user: { id: 'u-1', email: 'ana@grupotx.cl' } } : null } }),
      onAuthStateChange() {},
      signInWithPassword: async () => ({ error: null }),
      mfa: { listFactors: async () => { llamadas.listFactors++; return { data: { totp: factores }, error: null }; } },
    },
    from(tabla) {
      llamadas.tablas.push(tabla);
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: perfil }) };
      return q;
    },
    rpc: async (fn, args) => {
      llamadas.rpc.push({ fn, args });
      return fn === 'admin_usuarios' ? { data: [USUARIO_LISTA], error: null } : { data: null, error: null };
    },
  };
  const ventana = {};
  ventana.top = ventana;
  const ctx = vm.createContext({
    window: ventana,
    document: {
      activeElement: null,
      querySelector: (sel) => { if (!elementos.has(sel)) elementos.set(sel, elemento()); return elementos.get(sel); },
      addEventListener() {},
    },
    supabase: { createClient: () => sb },
    // JSON: el objeto nace en el realm de la página y deepEqual no lo igualaría con uno de la prueba.
    TMfa: { gate: async (_sb, opts) => { llamadas.gate.push(JSON.parse(JSON.stringify(opts))); return gate; } },
    confirm: () => false,
    fetch: async () => { throw new Error('la prueba no debe llamar a fetch'); },
    location: { reload() {} },
    console,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(scriptDeLaPagina(), ctx);
  await vm.runInContext('start()', ctx);
  const texto = (sel) => (elementos.has(sel) ? elementos.get(sel).innerHTML : '');
  return { llamadas, texto, el: (sel) => elementos.get(sel) };
}

const perfil = (extra) => ({ nombre: 'Ana Gómez', email: 'ana@grupotx.cl', rol: 'vendedor', activo: true, ...extra });

test('cuenta activa que NO es administradora: ve "Mi seguridad", sin lista de usuarios y sin llamar a admin_usuarios', async () => {
  const r = await correr({ perfil: perfil() });
  assert.match(r.texto('#miseguridad'), /Mi seguridad/);
  assert.match(r.texto('#miseguridad'), /id="sg-on"/, 'puede activar su 2FA');
  assert.deepEqual(r.llamadas.rpc, [], 'ningún rpc: admin_usuarios es solo para administradores');
  assert.doesNotMatch(r.texto('#app'), /id="uq"|class="uc"|rosa@grupotx\.cl/, 'no se muestra la lista de usuarios');
  assert.doesNotMatch(r.texto('#app'), /Solo administradores/, 'no es un callejón sin salida');
  assert.match(r.texto('#app'), /solo para administradores/i, 'explica por qué no hay lista');
  assert.match(r.texto('#estado-conexion'), /Mi cuenta/);
  assert.doesNotMatch(r.texto('#estado-conexion'), /Administrador|Sin permiso/);
});

test('cuenta activa no administradora: el 2FA se pide con requireEnrollment:false y ANTES de pintar nada', async () => {
  const r = await correr({ perfil: perfil() });
  assert.deepEqual(r.llamadas.gate, [{ requireEnrollment: false }]);

  const cerro = await correr({ perfil: perfil(), gate: false });
  assert.equal(cerro.llamadas.gate.length, 1);
  assert.equal(cerro.texto('#miseguridad'), '', 'si no pasó el código, no se muestra nada');
  assert.equal(cerro.texto('#app'), '');
  assert.deepEqual(cerro.llamadas.rpc, []);
});

test('cuenta activa no administradora con 2FA ya activo: ve el estado "activa" y puede desactivarlo', async () => {
  const r = await correr({ perfil: perfil(), factores: [{ id: 'f-1', status: 'verified' }] });
  assert.match(r.texto('#miseguridad'), /activa/);
  assert.match(r.texto('#miseguridad'), /id="sg-off"/);
  assert.deepEqual(r.llamadas.rpc, []);
});

test('administrador: sigue viendo Mi seguridad y la lista de usuarios (admin_usuarios), igual que antes', async () => {
  const r = await correr({ perfil: perfil({ rol: 'admin' }) });
  assert.deepEqual(r.llamadas.gate, [{ requireEnrollment: false }]);
  assert.match(r.texto('#miseguridad'), /Mi seguridad/);
  assert.deepEqual(r.llamadas.rpc.map((x) => x.fn), ['admin_usuarios']);
  assert.match(r.texto('#app'), /id="uq"/);
  assert.match(r.texto('#app'), /rosa@grupotx\.cl/);
  assert.match(r.texto('#app'), /data-mod="rep_rrhh"/);
  assert.match(r.texto('#estado-conexion'), /Administrador/);
});

test('cuenta desactivada o sin perfil (aunque su rol diga admin): "Solo administradores", sin 2FA, sin rpc', async () => {
  for (const p of [perfil({ activo: false }), perfil({ activo: false, rol: 'admin' }), null]) {
    const r = await correr({ perfil: p });
    assert.match(r.texto('#app'), /Solo administradores/);
    assert.equal(r.texto('#miseguridad'), '');
    assert.deepEqual(r.llamadas.gate, []);
    assert.equal(r.llamadas.listFactors, 0);
    assert.deepEqual(r.llamadas.rpc, []);
  }
});

test('sin sesión: muestra el formulario de ingreso y no consulta nada más', async () => {
  const r = await correr({ sesion: false });
  assert.match(r.texto('#app'), /id="login"/);
  assert.deepEqual(r.llamadas.tablas, []);
  assert.deepEqual(r.llamadas.rpc, []);
  assert.deepEqual(r.llamadas.gate, []);
});
