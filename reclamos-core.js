// Reclamos: lógica pura (planta, validación del ingreso, acciones visibles, mensaje al cliente, métricas).
// Script clásico: en navegador expone window.RC; en Node, module.exports.
// Es solo presentación y cálculo: la autoridad de cada regla es la base (funciones rec_* de Supabase).
(function (g) {
  'use strict';

  // ── Catálogos (los ids son los valores guardados en la base) ──
  const ESTADOS = [
    { id: 'ingresado', label: 'Ingresado' },
    { id: 'derivado', label: 'Derivado' },
    { id: 'en_verificacion', label: 'En verificación' },
    { id: 'aprobado', label: 'Aprobado' },
    { id: 'rechazado', label: 'Rechazado' },
    { id: 'solucion_definida', label: 'Solución definida' },
    { id: 'comunicado', label: 'Comunicado al cliente' },
    { id: 'cerrado', label: 'Cerrado' },
    { id: 'anulado', label: 'Anulado' },
  ];
  const AREAS = [
    { id: 'calidad', label: 'Calidad' },
    { id: 'produccion', label: 'Producción' },
    { id: 'logistica', label: 'Logística y transporte' },
    { id: 'finanzas', label: 'Finanzas' },
    { id: 'comercial', label: 'Comercial' },
  ];
  const PLANTAS = [
    { id: 'pinturas', label: 'Pinturas' },
    { id: 'morteros', label: 'Morteros' },
    { id: 'adhesivos', label: 'Adhesivos' },
    { id: 'cementos', label: 'Cementos' },
  ];
  const SOLUCIONES = [
    { id: 'nota_credito', label: 'Nota de crédito' },
    { id: 'reposicion', label: 'Reposición de producto' },
    { id: 'descuento', label: 'Descuento en próxima compra' },
    { id: 'devolucion', label: 'Devolución de dinero' },
    { id: 'asesoria', label: 'Asesoría o visita técnica' },
    { id: 'explicacion', label: 'Explicación sin compensación' },
  ];
  // Roles que se asignan en la pestaña "Accesos". El vendedor no está: lo tiene implícito todo usuario del módulo.
  const ROLES = [
    { id: 'servicio_cliente', label: 'Servicio al cliente' },
    { id: 'asesor_tecnico', label: 'Asesor técnico' },
    { id: 'encargado_area', label: 'Encargado de área' },
    { id: 'encargado_calidad', label: 'Encargado de calidad de planta' },
    { id: 'gerencia', label: 'Gerencia' },
  ];
  const labelDe = (lista, id) => { const x = lista.find((e) => e.id === id); return x ? x.label : (id == null ? '' : String(id)); };
  // Solo en estas áreas el reclamo (y el encargado) se separa por planta.
  const AREAS_POR_PLANTA = ['calidad', 'produccion'];
  // Un reclamo lleva hasta 10 productos y dice quién reclama: un vendedor (de la lista) o un cliente (a mano).
  const MAX_PRODUCTOS = 10;
  const RECLAMANTES = [
    { id: 'vendedor', label: 'Vendedor' },
    { id: 'cliente', label: 'Cliente' },
  ];

  // ── Planta de un producto, a partir de su familia (misma regla que public.rec_planta_de_familia) ──
  function plantaDeFamilia(familia) {
    const f = String(familia == null ? '' : familia).trim().toUpperCase();
    if (f.startsWith('PINTURAS')) return 'pinturas';
    if (['MORTEROS', 'MORT BAS', 'MORT REP', 'ESPECIALES', 'ESTUCOS', 'GRANELES'].includes(f)) return 'morteros';
    if (f === 'CEMENTO') return 'cementos';
    return 'adhesivos';
  }

  // ── Productos de un reclamo ──
  // Los reclamos nuevos traen la lista `productos` [{code, nombre, planta}]; los anteriores solo las columnas
  // producto / producto_nombre / planta, que se leen como una lista de un elemento.
  function productosDe(r) {
    const x = r || {};
    if (Array.isArray(x.productos) && x.productos.length) {
      return x.productos.map((p) => ({ code: p.code, nombre: p.nombre || p.code, planta: p.planta || null }));
    }
    if (x.producto) return [{ code: x.producto, nombre: x.producto_nombre || x.producto, planta: x.planta || null }];
    return [];
  }
  // "Nombre" o "Nombre +N" (el primero y cuántos más hay); '' si no hay productos.
  function resumenProductos(r) {
    const ps = productosDe(r);
    if (!ps.length) return '';
    return ps.length > 1 ? ps[0].nombre + ' +' + (ps.length - 1) : ps[0].nombre;
  }
  const textoProductos = (r) => productosDe(r).map((p) => p.nombre).join(' / ');
  // Plantas distintas de los productos, en orden de aparición y sin nulos.
  const plantasDe = (r) => [...new Set(productosDe(r).map((p) => p.planta).filter(Boolean))];

  // Reparte `total` (entero) en `n` enteros que lo suman; el resto va de a 1 a los primeros.
  function repartir(total, n) {
    const k = Math.trunc(Number(n));
    if (!(k >= 1)) return [];
    const t = Math.trunc(Number(total) || 0);
    const base = Math.floor(t / k);
    const resto = t - base * k;
    return Array.from({ length: k }, (_, i) => base + (i < resto ? 1 : 0));
  }

  // ── Fechas (YYYY-MM-DD) ──
  const reFecha = /^\d{4}-\d{2}-\d{2}$/;
  function fechaValida(s) {
    if (typeof s !== 'string' || !reFecha.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }
  const utcDia = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const diasEntre = (a, b) => Math.round((utcDia(b) - utcDia(a)) / 86400000);
  const fechaCL = (s) => (fechaValida(String(s || '').slice(0, 10)) ? String(s).slice(0, 10).split('-').reverse().join('-') : '');

  // El día (calendario de Chile) de un instante: los tiempos de respuesta se cuentan en días corridos
  // del calendario, así un comunicado a las 23:00 de Chile no cae en el día siguiente por la hora UTC.
  const fmtCL = (() => {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' }); } catch (e) { return null; }
  })();
  function diaCL(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    if (fmtCL) { const s = fmtCL.format(d); if (reFecha.test(s)) return s; }
    return d.toISOString().slice(0, 10);
  }

  // ── Quién reclama ──
  // rec = { tipo: 'vendedor'|'cliente', id?, nombre?, correo?, telefono? }. Devuelve los errores en español (vacío si es válido).
  // Vendedor: se elige de la lista (id); su nombre y correo los toma la base del perfil y el teléfono es opcional.
  // Cliente: nombre obligatorio y al menos un correo o un teléfono. Mismos textos y reglas que public.rec_* en la base.
  const reCorreo = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const rePhoneChars = /^[0-9 +().-]+$/;
  const txt = (v) => String(v == null ? '' : v).trim();
  const telefonoValido = (s) => s.length <= 30 && rePhoneChars.test(s) && s.replace(/\D/g, '').length >= 7;
  function validarReclamante(rec) {
    const e = [];
    const x = rec || {};
    const correo = txt(x.correo);
    const telefono = txt(x.telefono);
    if (x.tipo === 'vendedor') {
      if (!txt(x.id)) e.push('Elige el vendedor.');
    } else if (x.tipo === 'cliente') {
      if (!txt(x.nombre)) e.push('Escribe el nombre de quien reclama.');
      if (!correo && !telefono) e.push('Indica un correo o un teléfono de contacto.');
      if (correo && !reCorreo.test(correo)) e.push('El correo no tiene un formato válido.');
    } else {
      return ['Indica quién reclama: vendedor o cliente.'];
    }
    if (telefono && !telefonoValido(telefono)) e.push('El teléfono debe tener al menos 7 dígitos.');
    return e;
  }

  // ── Validación del ingreso rápido ──
  // d.productos: arreglo de códigos de producto. Devuelve la lista de errores en español (vacía si es válido);
  // la base vuelve a validar todo.
  function validarCrear(d, motivos, hoy) {
    const e = [];
    const x = d || {};
    const codigos = (Array.isArray(x.productos) ? x.productos : []).map(txt).filter(Boolean);
    if (!x.cliente_id) e.push('Elige el cliente.');
    const m = (motivos || []).find((k) => k.id === x.motivo && k.activo !== false);
    if (!x.motivo) e.push('Elige el motivo.');
    else if (!m) e.push('El motivo elegido no existe o ya no está disponible.');
    else if (m.requiere_producto && !codigos.length) e.push('Este motivo exige indicar el producto.');
    if (codigos.length > MAX_PRODUCTOS) e.push('Máximo ' + MAX_PRODUCTOS + ' productos por reclamo.');
    if (new Set(codigos).size < codigos.length) e.push('Hay productos repetidos.');
    e.push(...validarReclamante(x.reclamante));
    if (!String(x.descripcion || '').trim()) e.push('Escribe la descripción del reclamo.');
    if (!x.fecha_recepcion) e.push('Indica la fecha de recepción.');
    else if (!fechaValida(x.fecha_recepcion)) e.push('La fecha de recepción no es válida.');
    else if (fechaValida(hoy) && x.fecha_recepcion > hoy) e.push('La fecha de recepción no puede ser futura.');
    else if (fechaValida(hoy) && diasEntre(x.fecha_recepcion, hoy) > 365) e.push('La fecha de recepción tiene más de un año de antigüedad; revísala.');
    return e;
  }

  // Monto de compensación: entero en pesos, no negativo. Acepta puntos de miles ("45.000"). Devuelve { valor, error }.
  function validarMonto(v) {
    const s = String(v == null ? '' : v).trim();
    if (s === '') return { valor: null, error: 'Indica el monto de la compensación (0 si no hay).' };
    if (/^-\s*\d/.test(s)) return { valor: null, error: 'El monto no puede ser negativo.' };
    if (/^\d+$/.test(s) || /^\d{1,3}(\.\d{3})+$/.test(s)) {
      const n = Number(s.replace(/\./g, ''));
      if (Number.isSafeInteger(n)) return { valor: n, error: null };
    }
    return { valor: null, error: 'El monto debe ser un número entero en pesos, sin decimales ni símbolos.' };
  }

  // ── Acciones que se muestran para un reclamo ──
  // Solo presentación: cada una la valida de nuevo la función rec_* correspondiente.
  //  · Servicio al cliente y administrador hacen lo mismo en el flujo (derivar, pedir visita, solución, comunicar, cerrar, anular).
  //  · Decide el asesor técnico (calidad) o el encargado del área (y planta, si el área se separa por planta);
  //    el administrador, servicio al cliente, el encargado de calidad y la gerencia no deciden por rol.
  //  · Reabrir y corregir la compensación de un cerrado: solo administrador.
  function accionesPermitidas(r, alcances, esAdmin, uid) {
    const out = [];
    if (!r) return out;
    const al = Array.isArray(alcances) ? alcances : [];
    const e = r.estado;
    const sc = !!esAdmin || al.some((a) => a.rol === 'servicio_cliente');
    const esAsesor = al.some((a) => a.rol === 'asesor_tecnico');
    const area = r.area_destino;

    let decide = false;
    if (area === 'calidad') {
      decide = esAsesor && (e === 'derivado' || e === 'en_verificacion') && (!r.asesor_id || r.asesor_id === uid);
    } else if (area && e === 'derivado') {
      decide = al.some((a) => a.rol === 'encargado_area' && a.area === area && (!AREAS_POR_PLANTA.includes(area) || (!!r.planta_destino && a.planta === r.planta_destino)));
    }

    if (sc && ['ingresado', 'derivado', 'en_verificacion'].includes(e)) out.push('derivar');
    if (sc && area === 'calidad' && e === 'derivado') out.push('pedir_verificacion');
    if ((sc && e !== 'cerrado' && e !== 'anulado') || (e === 'en_verificacion' && esAsesor && r.asesor_id === uid)) out.push('completar_datos');
    if (e === 'en_verificacion' && (sc || (esAsesor && r.asesor_id === uid))) out.push('reasignar_asesor');
    if (e === 'en_verificacion' && esAsesor && r.asesor_id === uid) out.push('informe');
    if (decide) out.push('decidir');
    if (decide && e === 'derivado') out.push('devolver');
    if (sc && (e === 'aprobado' || e === 'rechazado')) out.push('definir_solucion');
    if (sc && e === 'solucion_definida') out.push('comunicar');
    if (sc && e === 'comunicado') out.push('cerrar');
    if ((sc && (e === 'solucion_definida' || e === 'comunicado')) || (esAdmin && e === 'cerrado')) out.push('corregir_compensacion');
    if (sc && e !== 'cerrado' && e !== 'anulado') out.push('anular');
    if (esAdmin && (e === 'cerrado' || e === 'anulado')) out.push('reabrir');
    return out;
  }

  // ── Bandeja ──
  // "Pendiente de mí": hay algo que depende de esta persona POR SU ROL para que el reclamo avance (derivar uno recién
  // ingresado, informar, decidir, definir la solución, comunicar, cerrar). No cuenta lo optativo (anular, pedir visita,
  // corregir) ni lo que espera a otros, y el administrador solo acumula pendientes si además tiene el rol.
  const AVANCE = ['informe', 'decidir', 'definir_solucion', 'comunicar', 'cerrar'];
  function pendienteDeMi(r, alcances, esAdmin, uid) {
    if (!r) return false;
    const acc = accionesPermitidas(r, alcances, false, uid);
    return acc.some((a) => AVANCE.includes(a) || (a === 'derivar' && r.estado === 'ingresado'));
  }
  // "Informados": el encargado de calidad de una planta recibe copia de los reclamos de calidad de su planta (sin acciones).
  function esInformado(r, alcances) {
    if (!r || r.estado === 'anulado' || r.area_destino !== 'calidad' || !r.planta_destino) return false;
    return (Array.isArray(alcances) ? alcances : []).some((a) => a.rol === 'encargado_calidad' && a.planta === r.planta_destino);
  }

  // ── Mensaje al cliente (decisión, razones, solución y monto) ──
  const clp = (n) => '$' + String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  function mensajeCliente(r, cliente) {
    const x = r || {};
    const nombre = (cliente && cliente.name) ? String(cliente.name).trim() : '';
    const decision = x.decision || (x.estado === 'rechazado' ? 'rechazado' : 'aprobado');
    const rec = fechaCL(x.fecha_recepcion);
    const lineas = [
      'Estimado/a ' + (nombre || 'cliente') + ':',
      '',
      'Le escribimos por su reclamo' + (x.folio ? ' ' + x.folio : '') + (rec ? ', recibido el ' + rec : '') + '.',
      'Resultado: su reclamo fue ' + (decision === 'rechazado' ? 'RECHAZADO' : 'APROBADO') + '.',
    ];
    if (String(x.razones || '').trim()) lineas.push('Razones: ' + String(x.razones).trim());
    if (x.solucion_tipo) {
      const det = String(x.solucion_detalle || '').trim();
      lineas.push('Solución: ' + labelDe(SOLUCIONES, x.solucion_tipo) + (det ? '. ' + det : ''));
    }
    lineas.push('Monto de la compensación: ' + clp(x.compensacion));
    lineas.push('', 'Quedamos atentos a cualquier consulta.', 'Grupo TX');
    return lineas.join('\n');
  }

  // ── Métricas para gerencia ──
  const r1 = (n) => Math.round(n * 10) / 10;
  const promedio = (xs) => (xs.length ? r1(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  function mediana(xs) {
    if (!xs.length) return null;
    const s = xs.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return r1(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
  }
  const suma = (obj, k, v) => { obj[k] = (obj[k] || 0) + v; };
  const MS_DIA = 86400000;

  // Tiempos por etapa de UN reclamo, solo de su último ciclo (después del último evento "reabierto"):
  // los ciclos anteriores quedan en la historia pero no mezclan fechas ni dan tiempos negativos.
  function etapasDeReclamo(r, eventosDelReclamo) {
    const evs = eventosDelReclamo
      .map((ev, i) => ({ ev, i, t: new Date(ev.creado_en).getTime() }))
      .filter((o) => Number.isFinite(o.t))
      .sort((a, b) => a.t - b.t || (Number.isFinite(Number(a.ev.id)) && Number.isFinite(Number(b.ev.id)) ? Number(a.ev.id) - Number(b.ev.id) : 0) || a.i - b.i)
      .map((o) => o.ev);
    let ini = 0;
    for (let i = evs.length - 1; i >= 0; i--) if (evs[i].tipo === 'reabierto') { ini = i; break; }
    const ciclo = evs.slice(ini);
    const reabierto = ini > 0 || (evs[0] && evs[0].tipo === 'reabierto');
    const tm = (ev) => new Date(ev.creado_en).getTime();

    const iIng = ciclo.findIndex((ev) => ev.a_estado === 'ingresado');
    let tIng = iIng >= 0 ? tm(ciclo[iIng]) : (!reabierto && r.creado_en ? new Date(r.creado_en).getTime() : NaN);
    const desde = Math.max(iIng, 0);
    const buscar = (estados, tras) => {
      for (let i = tras; i < ciclo.length; i++) if (estados.includes(ciclo[i].a_estado)) return i;
      return -1;
    };
    const iDer = buscar(['derivado'], desde);
    const iDec = iDer >= 0 ? buscar(['aprobado', 'rechazado'], iDer + 1) : -1;
    const iSol = iDec >= 0 ? buscar(['solucion_definida'], iDec + 1) : -1;
    const iCom = iSol >= 0 ? buscar(['comunicado'], iSol + 1) : -1;
    const dias = (a, b) => { const d = (b - a) / MS_DIA; return Number.isFinite(d) && d >= 0 ? d : null; };
    return {
      ingresado_derivado: iDer >= 0 ? dias(tIng, tm(ciclo[iDer])) : null,
      derivado_decision: iDec >= 0 ? dias(tm(ciclo[iDer]), tm(ciclo[iDec])) : null,
      decision_solucion: iSol >= 0 ? dias(tm(ciclo[iDec]), tm(ciclo[iSol])) : null,
      solucion_comunicado: iCom >= 0 ? dias(tm(ciclo[iSol]), tm(ciclo[iCom])) : null,
    };
  }

  // reclamos: filas de rec_reclamos; eventos: filas de rec_eventos; periodo: {desde, hasta} (YYYY-MM-DD, sobre la
  // fecha de recepción, extremos incluidos; vacío = todo). Los anulados no cuentan. Los costos solo suman reclamos con
  // compensación ya definida. Sin producto/planta no entran en esas vistas (solo en área y motivo).
  // Los resultados por clave son objetos { clave: valor }.
  // ¿Cuenta en las métricas? No si está anulado; el período se mide sobre la fecha de recepción (extremos incluidos).
  function enPeriodo(r, periodo) {
    const p = periodo || {};
    if (!r || r.estado === 'anulado') return false;
    const f = String(r.fecha_recepcion || '').slice(0, 10);
    if (p.desde && f < p.desde) return false;
    if (p.hasta && f > p.hasta) return false;
    return true;
  }
  function metricas(reclamos, eventos, periodo) {
    const rs = (reclamos || []).filter((r) => enPeriodo(r, periodo));
    const m = {
      total: rs.length, abiertos: 0, costoTotal: 0,
      costoPorMotivo: {}, costoPorArea: {}, costoPorPlanta: {}, costoPorProducto: {}, porProducto: {},
      respuestaDias: null,
      etapasDias: { ingresado_derivado: null, derivado_decision: null, decision_solucion: null, solucion_comunicado: null },
      porMotivo: {}, porArea: {}, porPlanta: {},
    };
    const resp = [];
    const porReclamo = new Map();
    for (const ev of (eventos || [])) {
      if (!porReclamo.has(ev.reclamo_id)) porReclamo.set(ev.reclamo_id, []);
      porReclamo.get(ev.reclamo_id).push(ev);
    }
    const acum = { ingresado_derivado: [], derivado_decision: [], decision_solucion: [], solucion_comunicado: [] };
    for (const r of rs) {
      if (r.estado !== 'cerrado') m.abiertos++;
      const area = r.area_destino || 'sin_area';
      const planta = r.planta_destino || r.planta || null;
      suma(m.porMotivo, r.motivo, 1);
      suma(m.porArea, area, 1);
      if (planta) suma(m.porPlanta, planta, 1);
      // Cada producto cuenta una vez por reclamo; el costo se reparte entre los productos distintos (la suma es el costo).
      const codigos = [...new Set(productosDe(r).map((p) => p.code).filter(Boolean))];
      for (const cod of codigos) suma(m.porProducto, cod, 1);
      if (r.compensacion != null) {
        const c = Number(r.compensacion) || 0;
        m.costoTotal += c;
        suma(m.costoPorMotivo, r.motivo, c);
        suma(m.costoPorArea, area, c);
        if (planta) suma(m.costoPorPlanta, planta, c);
        repartir(c, codigos.length).forEach((parte, i) => suma(m.costoPorProducto, codigos[i], parte));
      }
      if (r.comunicado_en) {
        const fin = diaCL(r.comunicado_en);
        const ini = String(r.fecha_recepcion || '').slice(0, 10);
        if (fin && fechaValida(ini)) resp.push(Math.max(0, diasEntre(ini, fin)));
      }
      const et = etapasDeReclamo(r, porReclamo.get(r.id) || []);
      for (const k of Object.keys(acum)) if (et[k] != null) acum[k].push(et[k]);
    }
    m.respuestaDias = { promedio: promedio(resp), mediana: mediana(resp), n: resp.length };
    for (const k of Object.keys(acum)) m.etapasDias[k] = promedio(acum[k]);
    return m;
  }

  const API = { ESTADOS, AREAS, PLANTAS, SOLUCIONES, ROLES, AREAS_POR_PLANTA, MAX_PRODUCTOS, RECLAMANTES, labelDe, plantaDeFamilia, productosDe, resumenProductos, textoProductos, plantasDe, repartir, fechaValida, fechaCL, diasEntre, diaCL, validarReclamante, validarCrear, RE_CORREO: reCorreo, validarMonto, accionesPermitidas, pendienteDeMi, esInformado, clp, mensajeCliente, enPeriodo, metricas };
  if (typeof window !== 'undefined') g.RC = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
