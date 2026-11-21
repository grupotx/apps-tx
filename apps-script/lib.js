// Funciones puras del Apps Script de respaldo (en Apps Script se pega como lib.gs).

function claveValida(recibida, esperada) {
  if (typeof recibida !== 'string' || typeof esperada !== 'string' || !esperada) return false;
  var largo = Math.max(recibida.length, esperada.length);
  var dif = recibida.length ^ esperada.length;
  for (var i = 0; i < largo; i++) dif |= (recibida.charCodeAt(i) || 0) ^ (esperada.charCodeAt(i) || 0);
  return dif === 0;
}

function buscarFilaPorNumero(valores, numero) {
  for (var i = 1; i < valores.length; i++) {
    if (Number(valores[i][0]) === Number(numero)) return i;
  }
  return -1;
}

function nombresPendientes(existentes, archivos) {
  return archivos.map(function (a) { return a.nombre; }).filter(function (n) { return existentes.indexOf(n) < 0; });
}

function copiasABorrar(nombres, conservar) {
  var orden = nombres.slice().sort().reverse();
  return orden.slice(conservar || 30).sort();
}

function prefijoCarpeta(numero) {
  return ('000000' + numero).slice(-6) + ' · ';
}

// Una sola dirección, sin espacios, comas, punto y coma, saltos de línea ni segundo @ (evita destinatarios extra e inyección de cabeceras).
function correoValido(s) {
  return typeof s === 'string' && s.length <= 254 && /^[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[^\s@,;<>()"']{2,}$/.test(s);
}

// ¿Los bytes (con signo, como los da Utilities.base64Decode) empiezan con la firma de un PDF, "%PDF-"?
function esPdfBytes(bytes) {
  var firma = [37, 80, 68, 70, 45];
  if (!bytes || bytes.length < firma.length) return false;
  for (var i = 0; i < firma.length; i++) if ((bytes[i] & 255) !== firma[i]) return false;
  return true;
}

// Valida el pedido de la acción 'correo'. Devuelve '' si está bien, o el motivo del rechazo. No toca servicios de Google.
function validarCorreo(c) {
  if (!correoValido(c.para)) return 'destino inválido';
  if (!correoValido(c.copia)) return 'falta la copia al PM';
  if (c.responderA && !correoValido(c.responderA)) return 'responderA inválido';
  if (typeof c.asunto !== 'string' || !c.asunto.trim() || c.asunto.length > 300 || /[\r\n]/.test(c.asunto)) return 'asunto inválido';
  if (typeof c.cuerpo !== 'string' || !c.cuerpo.trim() || c.cuerpo.length > 50000) return 'cuerpo inválido';
  if (typeof c.nombre !== 'string' || !/\.pdf$/i.test(c.nombre) || /[\/\r\n]/.test(c.nombre) || c.nombre.length > 200) return 'el adjunto debe ser un .pdf';
  if (typeof c.base64 !== 'string' || !c.base64) return 'el adjunto debe ser un pdf (vacío)';
  return '';
}

if (typeof module !== 'undefined') module.exports = { claveValida, buscarFilaPorNumero, nombresPendientes, copiasABorrar, prefijoCarpeta, correoValido, esPdfBytes, validarCorreo };
