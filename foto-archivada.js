// Fotos archivadas: cuando una foto ya no está en Supabase (se movió a Google Drive tras 60 días),
// la pide a la función foto-archivada con la sesión del usuario. Usa el cliente `sb` de la página.
(function () {
  const URL_FN = 'https://xinnonzltoaoptnvkhhy.supabase.co/functions/v1/foto-archivada';
  const cache = new Map();

  // Devuelve una URL blob: para mostrar la foto, o lanza error si no hay acceso o no existe.
  window.fotoArchivada = function (bucket, ruta) {
    const k = bucket + '/' + ruta;
    if (!cache.has(k)) {
      cache.set(k, (async () => {
        const { data } = await sb.auth.getSession(); // `sb`: cliente Supabase de la página (const global)
        const token = data && data.session && data.session.access_token;
        if (!token) throw new Error('sin sesión');
        const r = await fetch(URL_FN, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ bucket, ruta }),
        });
        if (!r.ok) throw new Error('foto no disponible (' + r.status + ')');
        return URL.createObjectURL(await r.blob());
      })().catch((e) => { cache.delete(k); throw e; }));
    }
    return cache.get(k);
  };

  // Para <img>: si la imagen falla, intenta la copia archivada una sola vez.
  // Uso: <img src="..." data-bucket="fotos" data-ruta="u/a.jpg" onerror="fotoArchivadaImg(this)">
  window.fotoArchivadaImg = function (img) {
    if (img.dataset.archivada) return;
    img.dataset.archivada = '1';
    const b = img.dataset.bucket;
    // Sin data-ruta (fotos antiguas sin id): se obtiene de la URL pública .../object/public/<bucket>/<ruta>
    const ruta = img.dataset.ruta || decodeURIComponent(((img.src || '').split('/object/public/' + b + '/')[1] || '').split(/[?#]/)[0]);
    if (!ruta) return;
    window.fotoArchivada(b, ruta).then((u) => { img.src = u; }).catch(() => {});
  };
})();
