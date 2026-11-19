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

if (typeof module !== 'undefined') module.exports = { claveValida, buscarFilaPorNumero, nombresPendientes, copiasABorrar, prefijoCarpeta };
