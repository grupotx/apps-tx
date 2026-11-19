// ¿Puede el usuario ver una foto archivada en Drive? Solo si puede leer el registro dueño de la foto
// (las mismas reglas RLS de cada app). Lógica pura: la consulta real llega como dependencia.

export type ArchivoDueno = { tabla: string; registro_id: string; drive_file_id: string | null };

export type DepsPermiso = {
  archivo(bucket: string, ruta: string): Promise<ArchivoDueno | null>;
  leerComoUsuario(tabla: string, registroId: string): Promise<boolean>;
};

export async function puedeVer(d: DepsPermiso, bucket: string, ruta: string):
  Promise<{ ok: true; fileId: string } | { ok: false; status: 403 | 404 }> {
  if (!bucket || !ruta) return { ok: false, status: 404 };
  const a = await d.archivo(bucket, ruta);
  if (!a || !a.drive_file_id) return { ok: false, status: 404 };
  if (!(await d.leerComoUsuario(a.tabla, a.registro_id))) return { ok: false, status: 403 };
  return { ok: true, fileId: a.drive_file_id };
}
