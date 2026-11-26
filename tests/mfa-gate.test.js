const { test } = require('node:test');
const assert = require('node:assert/strict');

// La verificación en dos pasos necesita el DOM y una sesión de Supabase real (se prueba en el
// navegador); aquí solo se comprueba que el módulo compartido se puede cargar sin DOM y que no hace
// nada hasta que se llama a gate().
test('mfa-gate: se carga sin DOM, expone gate y no inyecta nada al cargar', () => {
  const TMfa = require('../mfa-gate.js');
  assert.equal(typeof TMfa.gate, 'function');
  assert.equal(typeof document, 'undefined');
});
