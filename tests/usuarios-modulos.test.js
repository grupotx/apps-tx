const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Contrato entre usuarios.html (lista MODS) y la migración 20261129_reportes_acceso.sql
// (admin_set_modulo / admin_usuarios / rep_acceso): si una clave rep_* se escribe distinto en uno de
// los dos archivos, el interruptor falla en producción con "módulo desconocido". Aquí se cae antes.
const RAIZ = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(RAIZ, 'usuarios.html'), 'utf8');
// Las líneas comentadas (la reversa al final de la migración trae la versión antigua de las funciones)
// no cuentan como definición vigente.
const sql = fs.readFileSync(path.join(RAIZ, 'supabase', 'migrations', '20261129_reportes_acceso.sql'), 'utf8')
  .split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');

const ESPERADOS = [
  ['rep_resumen', 'Resumen'],
  ['rep_comercial', 'Comercial'],
  ['rep_logistica', 'Logística'],
  ['rep_produccion', 'Producción'],
  ['rep_estado_planta', 'Estado de planta'],
  ['rep_rrhh', 'RRHH'],
  ['rep_finanzas', 'Finanzas y tesorería'],
  ['rep_costos', 'Ver costos y márgenes'],
];

// Lee la lista MODS tal como la ejecutaría el navegador (sin DOM): el literal `const MODS=[...];`.
function leerMODS() {
  const m = html.match(/const MODS=\[[\s\S]*?\];/);
  assert.ok(m, 'usuarios.html no tiene `const MODS=[...];`');
  // JSON: pasa los objetos al realm de la prueba (con deepStrictEqual los arrays del vm no son iguales).
  return JSON.parse(vm.runInNewContext(m[0] + '\nJSON.stringify(MODS)'));
}

// Módulos que acepta admin_set_modulo en la rama rep_*: la lista de `substr(p_modulo, 5) not in (...)`.
function aceptadosPorAdminSetModulo() {
  const f = sql.match(/create or replace function public\.admin_set_modulo[\s\S]*?end \$function\$;/);
  assert.ok(f, 'la migración no define admin_set_modulo');
  const rama = f[0].match(/p_modulo like 'rep\\_%' then\s+if substr\(p_modulo, 5\) not in \(([^)]*)\)/);
  assert.ok(rama, 'admin_set_modulo no tiene la rama rep_*');
  return [...rama[1].matchAll(/'([a-z_]+)'/g)].map(x => 'rep_' + x[1]);
}

// Claves que admin_usuarios() devuelve bajo modulos: 'rep_' || modulo para cada fila de la lista values.
function devueltasPorAdminUsuarios() {
  const f = sql.match(/create or replace function public\.admin_usuarios[\s\S]*?\$function\$;/);
  assert.ok(f, 'la migración no define admin_usuarios');
  const v = f[0].match(/from \(values (.*?) as k\(modulo\)/);
  assert.ok(v, 'admin_usuarios no arma las claves rep_* desde una lista values');
  return [...v[1].matchAll(/\('([a-z_]+)'\)/g)].map(x => 'rep_' + x[1]);
}

test('usuarios.html: MODS trae los 8 módulos rep_* con su nombre, sin rol y agrupados en "Reportes TX"', () => {
  const rep = leerMODS().filter(m => m.k.startsWith('rep_'));
  assert.deepEqual(rep.map(m => [m.k, m.n]), ESPERADOS);
  for (const m of rep) {
    assert.equal(m.roles, null, `${m.k}: solo interruptor, sin rol`);
    assert.equal(m.grupo, 'Reportes TX', `${m.k}: grupo`);
  }
});

test('usuarios.html: los módulos de antes no cambian ni quedan en el grupo Reportes TX', () => {
  const previos = leerMODS().filter(m => !m.k.startsWith('rep_'));
  assert.deepEqual(previos.map(m => m.k), ['silos', 'crm', 'ent', 'tur', 'rt', 'cp', 'mtto']);
  for (const m of previos) assert.equal(m.grupo, undefined, `${m.k} no debe tener grupo`);
});

test('usuarios.html: las claves son únicas y no existe una rep_foo inventada', () => {
  const claves = leerMODS().map(m => m.k);
  assert.equal(new Set(claves).size, claves.length, 'claves repetidas en MODS');
  assert.ok(!claves.includes('rep_foo'));
  assert.ok(!/rep_foo/.test(html));
});

test('usuarios.html: los módulos rep_* quedan juntos y al final, para que el título del grupo se pinte una sola vez', () => {
  const claves = leerMODS().map(m => m.k);
  const primero = claves.findIndex(k => k.startsWith('rep_'));
  assert.ok(primero >= 0);
  assert.ok(claves.slice(primero).every(k => k.startsWith('rep_')), 'hay módulos no rep_* después de los rep_*');
});

test('migración: admin_set_modulo y admin_usuarios (y el check de rep_acceso) manejan exactamente las 8 claves', () => {
  const claves = ESPERADOS.map(e => e[0]);
  assert.deepEqual(aceptadosPorAdminSetModulo(), claves);
  assert.deepEqual(devueltasPorAdminUsuarios(), claves);
  const chk = sql.match(/check \(modulo in \(([^)]*)\)\)/);
  assert.ok(chk, 'rep_acceso no tiene check de módulos');
  assert.deepEqual([...chk[1].matchAll(/'([a-z_]+)'/g)].map(x => 'rep_' + x[1]), claves);
});

test('contrato: cada clave rep_* de MODS es aceptada por admin_set_modulo y devuelta por admin_usuarios (y al revés)', () => {
  const enMODS = leerMODS().map(m => m.k).filter(k => k.startsWith('rep_'));
  const acepta = aceptadosPorAdminSetModulo();
  const devuelve = devueltasPorAdminUsuarios();
  for (const k of enMODS) {
    assert.ok(acepta.includes(k), `${k}: admin_set_modulo no la acepta (dispararía "módulo desconocido")`);
    assert.ok(devuelve.includes(k), `${k}: admin_usuarios no la devuelve (el interruptor siempre saldría apagado)`);
  }
  for (const k of acepta) assert.ok(enMODS.includes(k), `${k}: la acepta la migración pero falta en MODS`);
});

test('usuarios.html: pintar() inserta el título del grupo ocupando todo el ancho de la grilla', () => {
  const css = html.match(/\.mod-g\{([^}]*)\}/);
  assert.ok(css, 'falta el estilo .mod-g del título del grupo');
  assert.match(css[1], /grid-column:\s*1\s*\/\s*-1/);
  const pintar = html.slice(html.indexOf('function pintar'), html.indexOf('async function rpc'));
  assert.match(pintar, /class="mod-g"/);
  assert.match(pintar, /m\.grupo/);
});
