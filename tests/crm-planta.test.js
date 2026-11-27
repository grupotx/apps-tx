// El CRM trae su propia copia mínima de la regla familia → planta (crm.html no carga reclamos-core.js).
// Este test evita que las dos copias se separen: extrae la función de crm.html y la compara con RC.plantaDeFamilia.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const RC = require('../reclamos-core.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'crm.html'), 'utf8');

// Las 40 familias que existen hoy en crm_products, más variantes de mayúsculas, espacios y valores raros.
const FAMILIAS = ['ACCESORIOS', 'Adhesivos', 'ADITIVOS', 'Cemento', 'CERAM PASTA', 'CERAMICOS', 'EPOXICOS', 'Especiales', 'Estucos', 'GRANELES', 'IMPERMEABILIZANTE',
  'MORT BAS', 'MORT REP', 'Morteros', 'PASTA MURO', 'Pinturas', 'PINTURAS · ACRYL TECHO', 'PINTURAS · ANTICORROSIVO', 'PINTURAS · LÁTEX ACRILICO', 'PINTURAS · MORTELINA',
  'PINTURAS · TEXTURA FINISH', 'S&B', 'SATE', '  mort bas ', 'cemento', 'pinturas · galvaplus', 'FAMILIA RARA', '', null, undefined];

function funcionDelCrm() {
  const m = html.match(/function plantaDeFamilia\([^)]*\)\{[\s\S]*?\n?\}(?=\s*(?:const|function|let|\/\/|\n))/);
  assert.ok(m, 'crm.html debe definir function plantaDeFamilia(f){…}');
  return new Function(m[0] + '; return plantaDeFamilia;')();
}

test('crm.html: plantaDeFamilia da lo mismo que RC.plantaDeFamilia para todas las familias', () => {
  const f = funcionDelCrm();
  for (const fam of FAMILIAS) assert.equal(f(fam), RC.plantaDeFamilia(fam), 'familia ' + JSON.stringify(fam));
});

test('crm.html: la tabla de productos muestra la planta, el formulario la edita y COLS la lleva', () => {
  assert.match(html, /products:\[[^\]]*'planta'/, "COLS.products debe incluir 'planta'");
  assert.match(html, /<th class="hide-m">Planta<\/th>/, 'la tabla de productos debe tener la columna Planta');
  assert.match(html, /id="p-planta"/, 'el formulario de producto debe tener el selector de planta');
  assert.match(html, /planta:g\('planta'\)/, 'guardar debe enviar la planta');
  for (const [id, lbl] of [['pinturas', 'Pinturas'], ['morteros', 'Morteros'], ['adhesivos', 'Adhesivos'], ['cementos', 'Cementos']]) {
    assert.ok(html.includes("['" + id + "','" + lbl + "']"), 'falta la opción ' + lbl);
  }
});

test('crm.html: al editar un producto de una familia fuera de la lista del formulario no se le cambia la familia', () => {
  // El selector de familia debe incluir la familia actual del producto aunque no esté en la lista fija.
  assert.match(html, /new Set\(\[[^\]]*'Pinturas'\][^)]*d\.family/, 'las opciones de familia deben incluir d.family');
});
