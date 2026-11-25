// Mantención sin conexión: lógica pura de la fila (mismo patrón que terreno-core.js/silos-core.js).
// Script clásico: en navegador expone window.MC; en Node, module.exports.
(function (g) {
  'use strict';

  // Mismo separador que mantencion.html:2594 (SEP = '\u0001'): se copia aquí tal cual, no se
  // inventa uno nuevo ni se importa del HTML, porque este módulo no puede depender de él.
  const SEP = '\u0001';

  // La identidad de un documento de mtto_docs es su (coleccion,id), igual que en la tabla real
  // (PK compuesta): a diferencia de Terreno/Silos (un solo id por fila), aquí la clave junta los
  // dos campos con el mismo separador que usa docsDeDb()/aplicarDoc() en mantencion.html.
  const claveDoc = (coleccion, id) => `${coleccion}${SEP}${id}`;

  // Lo que se encola al guardar un documento sin conexión. Mismo contrato que TC.entradaRegistro /
  // SC.entradaSolicitud: `base` es la versión que se estaba corrigiendo (el updated_at que devuelve
  // mtto_guardar_doc, para detectar si otra persona lo cambió mientras no había señal), `baseFresca`
  // distingue si esa base se acaba de pedir/leer (no una que quedó vieja esperando turno en la cola),
  // y `hechoEn` es la hora real del registro, no la de sincronización. `dependeDe` se devuelve como
  // hermano de `tipo`/`datos` (nunca anidado dentro de `datos`): offline-core.js (nuevaEntrada,
  // procesarFila) y offline.js (encolar: `opciones.dependeDe`, separado de `datos`) lo leen siempre
  // de ahí, igual que cadenaCompleta/descendientes/causaCadena de abajo (copiadas de terreno-core.js)
  // esperan `e.dependeDe`, nunca `e.datos.dependeDe`. Terreno/Silos no tienen este parámetro en sus
  // entradaRegistro/entradaSolicitud porque allí se pasa aparte, directo a `encolar(tipo, datos,
  // {dependeDe})`; aquí se acepta en entradaDoc (y se devuelve al mismo nivel) porque en Mantención
  // una corrección puede depender de un documento de OTRA colección (p. ej. un checklist que depende
  // de que su equipo se haya creado primero), así que conviene calcularlo junto con el resto de la
  // entrada en un solo lugar. Quien llame a `encolar` debe pasar `entrada.dependeDe` en `opciones`,
  // nunca leerlo de `entrada.datos`.
  function entradaDoc({ id, coleccion, docId, data, base, baseFresca, hechoEn, dependeDe }) {
    return {
      tipo: 'mantencion.doc',
      datos: {
        id, coleccion, docId: docId || null, data: data || {},
        base: base || null, baseFresca: !!baseFresca, hechoEn,
      },
      dependeDe: dependeDe || null,
    };
  }

  // Mensaje literal que offline-core.js (procesarFila) pone en una entrada cuando la que debía ir
  // antes (dependeDe) terminó con problema. Copiado de terreno-core.js/silos-core.js: es genérico
  // sobre la forma {id, dependeDe, estado, error}.
  const MSG_DEPENDE = 'Depende de un registro con problema';
  const causaCadena = (entradas, entrada) => {
    const porId = new Map((entradas || []).map((e) => [e.id, e]));
    let actual = entrada; const vistos = new Set();
    while (actual && actual.error === MSG_DEPENDE && actual.dependeDe && !vistos.has(actual.id)) {
      vistos.add(actual.id);
      actual = porId.get(actual.dependeDe) || null;
    }
    return (actual && actual.error) || entrada.error;
  };

  // Todas las entradas unidas a `id` por `dependeDe`, en cualquier sentido. Copiado de
  // terreno-core.js/silos-core.js: es genérico sobre la forma {id, dependeDe, estado, error}.
  const cadenaCompleta = (entradas, id) => {
    const todas = entradas || [];
    const vistos = new Set([id]), cola = [id];
    while (cola.length) {
      const x = cola.shift();
      const e = todas.find((y) => y.id === x);
      if (e && e.dependeDe && !vistos.has(e.dependeDe)) { vistos.add(e.dependeDe); cola.push(e.dependeDe); }
      todas.forEach((y) => { if (y.dependeDe === x && !vistos.has(y.id)) { vistos.add(y.id); cola.push(y.id); } });
    }
    return [...vistos];
  };

  // Solo lo que depende de `id`, directa o transitivamente. Copiado de terreno-core.js/silos-core.js:
  // es genérico sobre la forma {id, dependeDe, estado, error}.
  const descendientes = (entradas, id) => {
    const todas = entradas || [];
    const vistos = new Set(), cola = [id];
    while (cola.length) {
      const x = cola.shift();
      todas.forEach((y) => { if (y.dependeDe === x && !vistos.has(y.id)) { vistos.add(y.id); cola.push(y.id); } });
    }
    return [...vistos];
  };

  // Mezcla lo pendiente con los documentos ya cargados del servidor, sin mutar ninguna de las dos
  // listas. Mismo contrato que TC.aplicarFilaTerreno/SC.aplicarFilaSilos, pero la identidad de una
  // fila es coleccion+id (claveDoc), no un solo id: dos documentos de colecciones distintas pueden
  // compartir el mismo id sin pisarse. `docsServidor` trae filas con la forma de la tabla real
  // (coleccion, id, data, …); una entrada que corrige un documento existente lo reemplaza en su
  // sitio, una nueva va al principio. `_fila` queda con entradaId/estado/error (el error sube por
  // la cadena con causaCadena si la entrada está en problema), igual que en Terreno/Silos.
  const aplicarFilaDocs = (docsServidor, entradas) => {
    const lista = (docsServidor || []).slice();
    const nuevas = [];
    (entradas || []).forEach((e) => {
      if (!e || e.tipo !== 'mantencion.doc' || !e.datos) return;
      const d = e.datos;
      const coleccion = d.coleccion;
      const id = d.docId || d.id;
      const clave = claveDoc(coleccion, id);
      // Si ya hay un problema en este documento se deja ese: es la única entrada con Reintentar
      // y Descartar, y una pendiente posterior no debe taparlo. Mismo criterio que filaDeDoc en
      // mantencion.html (la PRIMERA entrada con problema, la causa raíz de la cadena, nunca una hija
      // más reciente que solo heredó "Depende de un registro con problema"): se unificó así (y no al
      // revés) porque `verMiVersionOt`/`bandaFilaOt` necesitan el entradaId de la causa raíz para leer
      // su `error` real (p. ej. distinguir NO_EXISTE de CONFLICTO) sin tener que trepar la cadena de
      // nuevo — causaCadena ya devuelve el mismo texto desde cualquier punto de la cadena, pero el
      // entradaId sí cambia según cuál se elija.
      let marca = { entradaId: e.id, estado: e.estado, error: e.estado === 'problema' ? causaCadena(entradas, e) : (e.error || null) };
      let lugar = lista, idx = lista.findIndex((r) => r && claveDoc(r.coleccion, r.id) === clave);
      if (idx < 0) { lugar = nuevas; idx = nuevas.findIndex((r) => r && claveDoc(r.coleccion, r.id) === clave); }
      const previo = idx >= 0 ? lugar[idx] : { id, coleccion };
      if (previo._fila && previo._fila.estado === 'problema') marca = previo._fila;
      // La base para mezclar es `_datos` si la fila ya pasó por aquí antes (otra entrada pendiente
      // del mismo documento), o `data` si es la fila tal como la trajo el servidor la primera vez.
      const data = { ...(previo._datos || previo.data || {}), ...(d.data || {}) };
      const fila = { ...previo, id, coleccion, data, _datos: data, _fila: marca };
      if (idx >= 0) lugar[idx] = fila; else nuevas.push(fila);
    });
    return [...nuevas, ...lista];
  };

  // mtto_guardar_doc responde con mensajes que empiezan con CONFLICTO: o NO_EXISTE:; se distinguen
  // por el prefijo porque el cliente no recibe un código aparte. Copiado de terreno-core.js/silos-core.js.
  const msgDe = (error) => String((error && error.message) || error || '');
  const esConflicto = (error) => msgDe(error).startsWith('CONFLICTO:');
  const noExiste = (error) => msgDe(error).startsWith('NO_EXISTE:');
  const MSG_CONFLICTO = 'Otro técnico cambió esto mientras no tenías señal. Revisa tu versión antes de volver a guardarla.';

  // Equivalente puro de docsDeDb() (mantencion.html:2601) comparado contra `snap` dentro de
  // subirCambios() (mantencion.html ~2634-2637): dado el mapa actual (clave -> documento) y el
  // mapa `snap` (clave -> JSON.stringify del documento ya sincronizado), devuelve qué subir y qué
  // borrar. Acepta tanto Map como objeto plano (clave -> valor) para que sea fácil de probar y de
  // llamar desde el HTML sin tener que envolver nada. A diferencia de subirCambios, esta función no
  // agrupa los borrados por colección: devuelve las claves completas (coleccion+SEP+id) tal como
  // pide el contrato de la Tarea 2; agruparlas para el borrado en lote sigue siendo trabajo del
  // llamador (igual que hoy separa `c,id = k.split(SEP)`).
  function docsCambiados(actual, snapshot) {
    const act = actual instanceof Map ? actual : new Map(Object.entries(actual || {}));
    const snap = snapshot instanceof Map ? snapshot : new Map(Object.entries(snapshot || {}));
    const cambiados = [];
    act.forEach((v, k) => {
      const j = JSON.stringify(v);
      if (snap.get(k) !== j) cambiados.push([k, v]);
    });
    const borrados = [];
    snap.forEach((_, k) => { if (!act.has(k)) borrados.push(k); });
    return { cambiados, borrados };
  }

  const API = { SEP, claveDoc, entradaDoc, aplicarFilaDocs, cadenaCompleta, descendientes, causaCadena, esConflicto, noExiste, MSG_CONFLICTO, docsCambiados };
  if (typeof window !== 'undefined') g.MC = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
