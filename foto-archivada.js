// Fotos de un bucket privado: primero intenta una URL firmada del propio bucket; si la foto ya no está
// en Supabase (se movió a Google Drive tras 60 días), la pide a la función foto-archivada con la sesión
// del usuario. Usa el cliente `sb` de la página.
(function () {
  const URL_FN = 'https://xinnonzltoaoptnvkhhy.supabase.co/functions/v1/foto-archivada';
  const cache = new Map();

  // Devuelve una URL para mostrar la foto, o lanza error si no hay acceso o no existe.
  window.fotoArchivada = function (bucket, ruta) {
    const k = bucket + '/' + ruta;
    const previa = cache.get(k);
    // Una URL firmada vale 1 hora: pasado ese tiempo hay que pedir una nueva, no servir la vencida para
    // siempre (una página que vive abierta mucho rato, como Silos, la vuelve a pedir al re-renderizar).
    if (previa && Date.now() < previa.expira) return previa.promesa;
    const entrada = { expira: Infinity, promesa: null };
    entrada.promesa = (async () => {
      // Primero una URL firmada del bucket (rápido, sin pasar por Drive): cubre el caso normal de un
      // bucket privado con la foto todavía en Supabase. Si falla (bucket sin política de lectura para
      // este usuario, o la foto ya no está porque la retención la borró), se sigue con el respaldo.
      try {
        const { data, error } = await sb.storage.from(bucket).createSignedUrl(ruta, 3600);
        if (!error && data && data.signedUrl) {
          entrada.expira = Date.now() + 55 * 60 * 1000; // renueva antes de que la firma venza (1h)
          return data.signedUrl;
        }
      } catch (_) { /* sigue con el respaldo de Drive */ }
      const { data } = await sb.auth.getSession(); // `sb`: cliente Supabase de la página (const global)
      const token = data && data.session && data.session.access_token;
      if (!token) throw new Error('sin sesión');
      const r = await fetch(URL_FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ bucket, ruta }),
      });
      if (!r.ok) throw new Error('foto no disponible (' + r.status + ')');
      return URL.createObjectURL(await r.blob()); // archivada en Drive: no vence, se cachea sin límite
    })().catch((e) => { cache.delete(k); throw e; });
    cache.set(k, entrada);
    return entrada.promesa;
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
