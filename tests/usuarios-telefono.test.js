const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Teléfono por persona en "Usuarios y accesos": se pinta en cada ficha y se guarda con admin_set_telefono
// (no con admin_set_perfil, que sigue manejando solo nombre y cargo). Se ejecuta el script real de
// usuarios.html contra un Supabase y un DOM de mentira (sin red).
const RAIZ = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(RAIZ, 'usuarios.html'), 'utf8');

function scriptDeLaPagina() {
  const s = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((x) => x.includes('async function start()'));
  assert.ok(s, 'usuarios.html no tiene el script con start()');
  return s.replace(/\nstart\(\);\s*$/, '\n');
}

const elemento = () => ({
  innerHTML: '', textContent: '', value: '', disabled: false, hidden: false, onclick: null, onsubmit: null,
  dataset: {}, classList: { add() {}, remove() {} }, focus() {}, setSelectionRange() {}, closest: () => null,
});

const USUARIOS = [
  { id: 'u-1', nombre: 'Ana Gómez', email: 'ana@grupotx.cl', cargo: 'Admin', telefono: null, cuenta_activa: true, modulos: {} },
  { id: 'u-2', nombre: 'Rosa Pérez', email: 'rosa@grupotx.cl', cargo: 'Ventas', telefono: '+56 9 1234 5678', cuenta_activa: true, modulos: {} },
];

async function correr({ errorTelefono = null } = {}) {
  const rpcs = [];
  const toasts = [];
  const elementos = new Map();
  const oyentes = {};
  const sb = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'u-1', email: 'ana@grupotx.cl' } } } }),
      onAuthStateChange() {},
      mfa: { listFactors: async () => ({ data: { totp: [] }, error: null }) },
    },
    from() {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { nombre: 'Ana Gómez', email: 'ana@grupotx.cl', rol: 'admin', activo: true } }) };
      return q;
    },
    rpc: async (fn, args) => {
      rpcs.push({ fn, args: JSON.parse(JSON.stringify(args || {})) });
      if (fn === 'admin_usuarios') return { data: JSON.parse(JSON.stringify(USUARIOS)), error: null };
      if (fn === 'admin_set_telefono' && errorTelefono) return { data: null, error: { message: errorTelefono } };
      return { data: null, error: null };
    },
  };
  const ventana = {};
  ventana.top = ventana;
  const ctx = vm.createContext({
    window: ventana,
    document: {
      activeElement: null,
      querySelector: (sel) => { if (!elementos.has(sel)) elementos.set(sel, elemento()); return elementos.get(sel); },
      addEventListener: (tipo, fn) => { (oyentes[tipo] = oyentes[tipo] || []).push(fn); },
    },
    supabase: { createClient: () => sb },
    TMfa: { gate: async () => true },
    confirm: () => false,
    fetch: async () => { throw new Error('la prueba no debe llamar a fetch'); },
    location: { reload() {} },
    console, setTimeout, clearTimeout,
  });
  vm.runInContext(scriptDeLaPagina(), ctx);
  await vm.runInContext('start()', ctx);
  const app = () => elementos.get('#app').innerHTML;
  // Simula que la persona edita un input data-f de la ficha `id` y sale del campo (evento change).
  const cambiar = async (id, campo, valor) => {
    const sec = { dataset: { id }, querySelector: () => null };
    const t = { id: '', dataset: { f: campo }, value: valor, closest: (s) => (s === '.uc' ? sec : null) };
    for (const fn of oyentes.change || []) await fn({ target: t });
  };
  const toast = () => elementos.get('#toast');
  return { rpcs, app, cambiar, toast };
}

const inputTel = (h, id) => {
  const sec = h.split('<section').find((s) => s.includes(`data-id="${id}"`));
  assert.ok(sec, `no hay ficha de ${id}`);
  const m = sec.match(/<input[^>]*data-f="telefono"[^>]*>/);
  assert.ok(m, `la ficha de ${id} no tiene input data-f="telefono"`);
  return m[0];
};

test('cada ficha trae el input de teléfono con el valor de u.telefono (vacío si es null)', async () => {
  const { app } = await correr();
  const h = app();
  assert.match(inputTel(h, 'u-2'), /value="\+56 9 1234 5678"/);
  assert.match(inputTel(h, 'u-1'), /value=""/);
  assert.match(h, /<label>Teléfono<\/label>/);
});

test('el input de teléfono sale con maxlength, inputmode tel y autocomplete off', async () => {
  const { app } = await correr();
  const i = inputTel(app(), 'u-2');
  assert.match(i, /maxlength="30"/);
  assert.match(i, /inputmode="tel"/);
  assert.match(i, /autocomplete="off"/);
});

test('cambiar el teléfono llama a admin_set_telefono (y no a admin_set_perfil)', async () => {
  const { rpcs, cambiar } = await correr();
  rpcs.length = 0;
  await cambiar('u-2', 'telefono', '  +56 9 8765 4321 ');
  assert.deepEqual(rpcs, [{ fn: 'admin_set_telefono', args: { p_id: 'u-2', p_telefono: '+56 9 8765 4321' } }]);
});

test('vaciar el teléfono manda null', async () => {
  const { rpcs, cambiar } = await correr();
  rpcs.length = 0;
  await cambiar('u-2', 'telefono', '   ');
  assert.deepEqual(rpcs, [{ fn: 'admin_set_telefono', args: { p_id: 'u-2', p_telefono: null } }]);
});

test('cambiar el cargo sigue llamando a admin_set_perfil, sin tocar el teléfono', async () => {
  const { rpcs, cambiar } = await correr();
  rpcs.length = 0;
  await cambiar('u-2', 'cargo', 'Jefe de ventas');
  assert.deepEqual(rpcs, [{ fn: 'admin_set_perfil', args: { p_id: 'u-2', p_nombre: 'Rosa Pérez', p_cargo: 'Jefe de ventas' } }]);
});

test('si la base rechaza el teléfono se muestra el aviso y se recarga la lista', async () => {
  const msg = 'El teléfono debe tener al menos 7 dígitos.';
  const { rpcs, cambiar, toast } = await correr({ errorTelefono: msg });
  rpcs.length = 0;
  await cambiar('u-2', 'telefono', '123');
  assert.deepEqual(rpcs.map((r) => r.fn), ['admin_set_telefono', 'admin_usuarios']);
  assert.equal(toast().textContent, msg);
});
