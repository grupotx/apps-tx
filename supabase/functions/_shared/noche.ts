// Modo noche del respaldo: nombre de la copia diaria y selección de archivos a liberar en Supabase.
// Lógica pura, sin APIs de red.

export type ArchivoRetencion = {
  id: number;
  bucket: string;
  drive_file_id: string | null;
  creado_storage: string | null; // fecha de subida al storage de Supabase (inicio de los 60 días)
  borrado_supabase_at: string | null;
};

// 'mtto_docs' es el pseudo-bucket de las fotos base64 antiguas de Mantención: viven dentro de la fila y no se tocan.
const NO_BORRAR = new Set(['mtto_docs']);

export function seleccionarParaBorrar(archivos: ArchivoRetencion[], ahora: Date, dias = 60): number[] {
  const limite = ahora.getTime() - dias * 86400000;
  return archivos
    .filter((a) => !NO_BORRAR.has(a.bucket) && a.drive_file_id && !a.borrado_supabase_at
      && a.creado_storage && new Date(a.creado_storage).getTime() < limite)
    .map((a) => a.id);
}

export function nombreCopia(ahora: Date): string {
  const dia = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ahora);
  return `base-${dia}.json.gz`;
}
