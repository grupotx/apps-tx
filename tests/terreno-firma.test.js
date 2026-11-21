const { test } = require('node:test');
const assert = require('node:assert/strict');

// La ventana de firma necesita el DOM (se prueba en el navegador); aquí solo se comprueba que el módulo
// compartido se puede cargar sin DOM y que no hace nada hasta que se abre una firma.
test('terreno-firma: se carga sin DOM, expone abrirFirma y no inyecta nada al cargar', () => {
  const TFirma = require('../terreno-firma.js');
  assert.equal(typeof TFirma.abrirFirma, 'function');
  assert.equal(typeof document, 'undefined');
});
