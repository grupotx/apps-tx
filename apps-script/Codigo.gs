// Respaldo Apps TX → Google Drive. Web App de controldegestion@grupotx.cl.
// Script Properties: RESPALDO_CLAVE, ROOT_FOLDER_ID.
// Contrato: docs/superpowers/plans/2026-11-19-respaldo-drive.md (Task 3).

var NOMBRES_APP = { entregas: 'Entregas', terreno: 'Terreno', silos: 'Silos', mantencion: 'Mantención', crm: 'CRM' };
var COLS_FIJAS = ['Número', 'Fecha', 'Identificador'];
var COLS_FINALES = ['Observaciones', 'Estado', 'Carpeta', 'Respaldado'];

function doPost(e) {
  var r;
  try {
    var body = JSON.parse(e.postData.contents);
    var props = PropertiesService.getScriptProperties();
    if (!claveValida(body.clave, props.getProperty('RESPALDO_CLAVE'))) return json_({ ok: false, error: 'no autorizado' });
    // Correo al cliente: no usa Drive ni el candado (no escribe en la carpeta de respaldos).
    if (body.accion === 'correo') return json_(enviarCorreo_(body));
    var raiz = DriveApp.getFolderById(props.getProperty('ROOT_FOLDER_ID'));
    if (body.accion === 'archivo') return json_(leerArchivo_(raiz, body.fileId));
    var lock = LockService.getScriptLock();
    lock.waitLock(60000);
    try {
      if (body.accion === 'envio') r = guardarEnvio_(raiz, body.envio);
      else if (body.accion === 'eliminado') r = marcarEliminado_(raiz, body.app, body.numero);
      else if (body.accion === 'copia') r = guardarCopia_(raiz, body.nombre, body.base64);
      else r = { ok: false, error: 'acción desconocida' };
    } finally { lock.releaseLock(); }
  } catch (err) {
    r = { ok: false, error: String(err && err.message || err) };
  }
  return json_(r);
}

// Instalación: ejecutar UNA de estas desde el editor (menú Ejecutar). Crean la carpeta raíz y guardan ROOT_FOLDER_ID.
function instalarCarpetaPrueba() { return crearCarpetaRaiz_('Respaldos Apps TX (PRUEBA)'); }
function instalarCarpetaReal() { return crearCarpetaRaiz_('Respaldos Apps TX'); }
function crearCarpetaRaiz_(nombre) {
  var it = DriveApp.getRootFolder().getFoldersByName(nombre);
  var f = it.hasNext() ? it.next() : DriveApp.createFolder(nombre);
  PropertiesService.getScriptProperties().setProperty('ROOT_FOLDER_ID', f.getId());
  Logger.log('Carpeta raíz: ' + f.getUrl());
  return f.getUrl();
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function subcarpeta_(padre, nombre) {
  var it = padre.getFoldersByName(nombre);
  return it.hasNext() ? it.next() : padre.createFolder(nombre);
}

function hoja_(carpetaApp, nombreApp) {
  var nombre = nombreApp + ' - Registros';
  var it = carpetaApp.getFilesByName(nombre);
  if (it.hasNext()) return SpreadsheetApp.open(it.next()).getSheets()[0];
  var ss = SpreadsheetApp.create(nombre);
  DriveApp.getFileById(ss.getId()).moveTo(carpetaApp);
  var sh = ss.getSheets()[0];
  sh.appendRow(COLS_FIJAS.concat(COLS_FINALES));
  sh.setFrozenRows(1);
  return sh;
}

function encabezados_(sh, claves) {
  var enc = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  claves.forEach(function (k) {
    if (enc.indexOf(k) < 0) {
      var pos = enc.indexOf(COLS_FINALES[0]);
      sh.insertColumnBefore(pos + 1);
      sh.getRange(1, pos + 1).setValue(k);
      enc.splice(pos, 0, k);
    }
  });
  return enc;
}

function escribirFila_(sh, numero, valores) {
  var enc = encabezados_(sh, Object.keys(valores));
  var datos = sh.getDataRange().getValues();
  var idx = buscarFilaPorNumero(datos, numero);
  var fila = idx >= 0 ? datos[idx].slice() : enc.map(function () { return ''; });
  enc.forEach(function (k, i) { if (k in valores) fila[i] = valores[k]; });
  if (idx >= 0) sh.getRange(idx + 1, 1, 1, enc.length).setValues([fila]);
  else sh.appendRow(fila);
}

function carpetaEnvio_(carpetaApp, numero, nombre) {
  var q = 'title contains "' + prefijoCarpeta(numero) + '"';
  var it = carpetaApp.searchFolders(q);
  while (it.hasNext()) {
    var f = it.next();
    if (f.getName().indexOf(prefijoCarpeta(numero)) === 0) {
      if (f.getName() !== nombre) f.setName(nombre);
      return f;
    }
  }
  return carpetaApp.createFolder(nombre);
}

function guardarEnvio_(raiz, env) {
  var nombreApp = NOMBRES_APP[env.app];
  if (!nombreApp) return { ok: false, error: 'app desconocida' };
  var carpetaApp = subcarpeta_(raiz, nombreApp);
  var carpeta = carpetaEnvio_(carpetaApp, env.numero, env.carpeta);

  var existentes = {};
  var it = carpeta.getFiles();
  while (it.hasNext()) { var f = it.next(); existentes[f.getName()] = f; }
  var pendientes = nombresPendientes(Object.keys(existentes), env.archivos);
  env.archivos.forEach(function (a) {
    if (pendientes.indexOf(a.nombre) >= 0 && a.base64) {
      var mime = /\.png$/i.test(a.nombre) ? 'image/png' : 'image/jpeg';
      existentes[a.nombre] = carpeta.createFile(Utilities.newBlob(Utilities.base64Decode(a.base64), mime, a.nombre));
    }
  });

  var nombrePdf = 'Resumen ' + env.fila['Número'] + '.pdf';
  if (existentes[nombrePdf]) existentes[nombrePdf].setTrashed(true);
  var t = HtmlService.createTemplateFromFile('Resumen');
  t.env = env;
  t.nombreApp = nombreApp;
  carpeta.createFile(Utilities.newBlob(t.evaluate().getContent(), 'text/html', 'r.html').getAs('application/pdf').setName(nombrePdf));

  var valores = {};
  Object.keys(env.fila).forEach(function (k) { valores[k] = env.fila[k]; });
  valores['Número'] = env.numero;
  valores['Estado'] = 'Activo';
  valores['Carpeta'] = carpeta.getUrl();
  valores['Respaldado'] = new Date();
  escribirFila_(hoja_(carpetaApp, nombreApp), env.numero, valores);

  return {
    ok: true, folderId: carpeta.getId(), folderUrl: carpeta.getUrl(),
    archivos: env.archivos.filter(function (a) { return existentes[a.nombre]; })
      .map(function (a) { return { nombre: a.nombre, fileId: existentes[a.nombre].getId() }; })
  };
}

function marcarEliminado_(raiz, app, numero) {
  var nombreApp = NOMBRES_APP[app];
  if (!nombreApp) return { ok: false, error: 'app desconocida' };
  var carpetaApp = subcarpeta_(raiz, nombreApp);
  var tz = Session.getScriptTimeZone();
  escribirFila_(hoja_(carpetaApp, nombreApp), numero, { 'Estado': 'Eliminado ' + Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm') });
  return { ok: true };
}

// Correo al cliente con el informe PDF adjunto; sale de la casilla de este script y deja copia (cc) al PM que lo envía.
// Requiere el permiso script.send_mail (appsscript.json): al publicar la versión nueva Google pide autorizarlo.
function enviarCorreo_(c) {
  var motivo = validarCorreo(c);
  if (motivo) return { ok: false, error: motivo };
  var bytes = Utilities.base64Decode(c.base64);
  if (!esPdfBytes(bytes)) return { ok: false, error: 'el adjunto debe ser un pdf (contenido)' };
  var opciones = {
    to: c.para, cc: c.copia, subject: c.asunto, body: c.cuerpo, name: 'Grupo TX',
    attachments: [Utilities.newBlob(bytes, 'application/pdf', c.nombre)]
  };
  if (c.responderA) opciones.replyTo = c.responderA;
  MailApp.sendEmail(opciones);
  return { ok: true };
}

function guardarCopia_(raiz, nombre, base64) {
  var carpeta = subcarpeta_(raiz, 'Base completa');
  carpeta.createFile(Utilities.newBlob(Utilities.base64Decode(base64), 'application/gzip', nombre));
  var nombres = [], porNombre = {};
  var it = carpeta.getFiles();
  while (it.hasNext()) { var f = it.next(); nombres.push(f.getName()); porNombre[f.getName()] = f; }
  copiasABorrar(nombres, 30).forEach(function (n) { porNombre[n].setTrashed(true); });
  return { ok: true };
}

function leerArchivo_(raiz, fileId) {
  var f = DriveApp.getFileById(fileId);
  if (!dentroDe_(f, raiz.getId())) return { ok: false, error: 'fuera de la carpeta de respaldos' };
  var b = f.getBlob();
  return { ok: true, mime: b.getContentType(), base64: Utilities.base64Encode(b.getBytes()) };
}

function dentroDe_(f, raizId) {
  var nivel = [f], vueltas = 0;
  while (nivel.length && vueltas++ < 6) {
    var siguiente = [];
    for (var i = 0; i < nivel.length; i++) {
      var ps = nivel[i].getParents();
      while (ps.hasNext()) {
        var p = ps.next();
        if (p.getId() === raizId) return true;
        siguiente.push(p);
      }
    }
    nivel = siguiente;
  }
  return false;
}
