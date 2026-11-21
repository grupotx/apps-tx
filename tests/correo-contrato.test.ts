// Contrato entre los dos lados del correo: lo que el navegador ARMA (TC.correoVisita / TC.correoEnsayo en terreno-core.js)
// y lo que el servidor EXIGE (validarSolicitud en la función terreno-correo). Cada lado fija su propio literal en su test;
// sin esta prueba, cambiar el asunto en un lado y su test deja el otro en verde y todos los envíos fallando en producción.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { validarSolicitud } from '../supabase/functions/_shared/correo.ts';

const TC = createRequire(import.meta.url)('../terreno-core.js');
const PDF = Buffer.from('%PDF-1.4\nprueba').toString('base64');

// El mismo contexto que arma supabase/functions/terreno-correo/index.ts a partir del registro guardado.
const ctxDe = (reg: any) => ({
  kind: reg.kind, cierreEmail: reg.kind === 'adherencia' ? reg.datos?.correo_cliente : reg.datos?.cierre?.email,
  cliente: reg.cliente, obra: reg.obra,
});
const pedidoDe = (reg: any, correo: { asunto: string; cuerpo: string }, para: string) => ({
  registro_id: 'r1', para, asunto: correo.asunto, cuerpo: correo.cuerpo, nombre: TC.nombreInforme(reg), base64: PDF,
});

const visita = (extra: object = {}) => ({
  kind: 'visita', cliente: 'Constructora Los Andes', obra: 'Edificio Alameda', fecha: '2026-11-18',
  datos: { producto: 'Piso Autonivelante', motivo: 'Fisuras en el piso', contacto: 'Ana Soto', cierre: { nombre: 'Pedro Rojas', email: 'pedro@andes.cl' } }, ...extra,
});
const ensayo = (extra: object = {}) => ({
  kind: 'adherencia', cliente: 'INGEVEC', obra: 'Edificio Torre 4', fecha: '2026-11-20',
  datos: { motivo_visita: 'Tracción Directa', correo_cliente: 'ana@ingevec.cl', filas: TC.normalizarFilas([{ area: '50x50', carga: '2,772' }]) }, ...extra,
});

test('contrato: el correo real de una visita pasa validarSolicitud', () => {
  const reg = visita();
  const r = validarSolicitud(pedidoDe(reg, TC.correoVisita(reg), reg.datos.cierre.email), ctxDe(reg));
  assert.deepEqual(r.ok ? { ok: true } : r, { ok: true });
});

test('contrato: el correo real de un ensayo de adherencia pasa validarSolicitud', () => {
  const reg = ensayo();
  const r = validarSolicitud(pedidoDe(reg, TC.correoEnsayo(reg), reg.datos.correo_cliente), ctxDe(reg));
  assert.deepEqual(r.ok ? { ok: true } : r, { ok: true });
});

test('contrato: sin obra o con una obra larga y con tildes el correo sigue pasando', () => {
  for (const reg of [visita({ obra: '' }), ensayo({ obra: '' }), visita({ obra: 'Condominio Ñuñoa – Etapa 2 «Torre Sur»' }), ensayo({ obra: 'Edificio Plaza Ñuble ' + 'x'.repeat(100) })]) {
    const correo = reg.kind === 'adherencia' ? TC.correoEnsayo(reg) : TC.correoVisita(reg);
    const para = reg.kind === 'adherencia' ? reg.datos.correo_cliente : reg.datos.cierre.email;
    const r = validarSolicitud(pedidoDe(reg, correo, para), ctxDe(reg));
    assert.deepEqual(r.ok ? { ok: true } : r, { ok: true }, reg.obra);
  }
});

test('contrato: el cuerpo que edita el PM pasa mientras nombre al cliente y la obra, y la regla del cliente coincide con la del servidor', () => {
  for (const reg of [visita(), ensayo()]) {
    const correo = reg.kind === 'adherencia' ? TC.correoEnsayo(reg) : TC.correoVisita(reg);
    const para = reg.kind === 'adherencia' ? reg.datos.correo_cliente : reg.datos.cierre.email;
    const ref = { cliente: reg.cliente, obra: reg.obra };
    const editado = correo.cuerpo + '\nP.D.: quedo atento a su visita de la próxima semana.';
    assert.equal(TC.validarCuerpoCorreo(editado, ref), '');
    assert.equal(validarSolicitud(pedidoDe(reg, { asunto: correo.asunto, cuerpo: editado }, para), ctxDe(reg)).ok, true);
    // Un cuerpo que ya no nombra la obra: el cliente lo frena con texto claro y el servidor lo rechazaría igual.
    const sinObra = 'Estimado(a) ' + reg.cliente + ': le adjuntamos el informe.';
    assert.match(TC.validarCuerpoCorreo(sinObra, ref), /obra/);
    assert.deepEqual(validarSolicitud(pedidoDe(reg, { asunto: correo.asunto, cuerpo: sinObra }, para), ctxDe(reg)), { ok: false, error: 'mensaje_no_corresponde' });
  }
});

test('contrato: el asunto real queda dentro del tope de 200 caracteres para una obra de largo razonable', () => {
  const reg = visita({ obra: 'O'.repeat(150) });
  assert.ok(TC.correoVisita(reg).asunto.length <= 200);
});
