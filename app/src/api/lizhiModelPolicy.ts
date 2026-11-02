/**
 * 立之 3D: which Hew API calls a remote (ChatGPT) job may run in the
 * owner's authorized browser tab (AGPL-3.0-only, derived integration).
 *
 * The full Hew API surface is allowed (docs/API_REFERENCE.gen.md) with three
 * guards applied here, before anything reaches the kernel:
 *  - connection plumbing is owned by the host and never job-supplied
 *    (`hew.meta.hello`, `hew.doc.attach`, desktop window focus);
 *  - destructive calls need an explicit `confirmed: true` the AI may only
 *    set after the user agreed in chat;
 *  - the browser has no filesystem, so `path` params are refused and binary
 *    results always come back inline (`return_bytes` for saves) for the
 *    queue to upload into the owner's private storage.
 * The kernel's own schema validation and profile rules still apply.
 */

export const METHOD_PATTERN = /^hew\.[a-z]+\.[a-z_]+$/

/** Owned by the host connection; a job never sends these. */
export const BLOCKED_METHODS: ReadonlySet<string> = new Set([
  'hew.meta.hello',
  'hew.doc.attach',
  'hew.doc.focus',
])

/** Lose model data or replace the open document: need `confirmed: true`. */
export const DESTRUCTIVE_METHODS: ReadonlySet<string> = new Set([
  'hew.doc.new',
  'hew.doc.open',
  'hew.doc.close',
  'hew.doc.revert',
  'hew.doc.import',
  'hew.doc.purge_unused',
  'hew.entity.delete',
  'hew.sketch.delete',
  'hew.solid.delete_faces',
  'hew.solid.delete_imprint',
  'hew.group.explode',
  'hew.component.explode',
  'hew.tag.delete',
  'hew.scenes.remove',
  'hew.library.remove',
  'hew.attr.delete',
  'hew.guide.clear',
])

/** Solitary commands (HEW_API.md §6.4) may not sit inside a transaction. */
export const SOLITARY_METHODS: ReadonlySet<string> = new Set([
  'hew.doc.close', 'hew.doc.export', 'hew.doc.import', 'hew.doc.new',
  'hew.doc.open', 'hew.doc.revert', 'hew.doc.save', 'hew.history.redo',
  'hew.history.status', 'hew.history.undo', 'hew.print.pdf',
  'hew.view.camera', 'hew.view.line_drawing', 'hew.view.snapshot',
  'hew.view.units', 'hew.view.zoom_extents',
])

export const MAX_TRANSACT_COMMANDS = 200

export interface CallJobParams {
  method: string
  params: Record<string, unknown>
  confirmed?: true
}

export type CallCheck =
  | { ok: true; method: string; params: Record<string, unknown> }
  | { ok: false; code: string }

const obj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

function hasPathParam(v: unknown, depth = 0): boolean {
  if (depth > 8 || !obj(v)) return false
  for (const [k, x] of Object.entries(v)) {
    if ((k === 'path' || k.endsWith('_path')) && x !== undefined) return true
    if (obj(x) && hasPathParam(x, depth + 1)) return true
  }
  return false
}

/** Methods named anywhere in a call, including a transaction's commands. */
function innerCommands(method: string, params: Record<string, unknown>):
  Array<{ method: unknown; params: unknown }> | null {
  if (method !== 'hew.doc.transact') return []
  const list = params.commands
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_TRANSACT_COMMANDS) return null
  return list.map(c => obj(c) ? { method: c.method, params: c.params ?? {} } : { method: null, params: null })
}

/**
 * Validates a remote call job and returns the exact method/params the host
 * will dispatch. Pure: no scene access, safe to unit test and to mirror on
 * the server side.
 */
export function checkCallJob(p: unknown): CallCheck {
  if (!obj(p)) return { ok: false, code: 'INVALID_CALL' }
  const allowedKeys = ['method', 'params', 'confirmed']
  if (!Object.keys(p).every(k => allowedKeys.includes(k))) return { ok: false, code: 'INVALID_CALL' }
  const { method, confirmed } = p
  const params = p.params === undefined ? {} : p.params
  if (typeof method !== 'string' || !METHOD_PATTERN.test(method)) return { ok: false, code: 'INVALID_METHOD' }
  if (!obj(params)) return { ok: false, code: 'INVALID_PARAMS' }
  if (confirmed !== undefined && confirmed !== true) return { ok: false, code: 'INVALID_CALL' }
  const inner = innerCommands(method, params)
  if (inner === null) return { ok: false, code: 'INVALID_TRANSACTION' }
  const named = [{ method, params }, ...inner]
  for (const c of named) {
    if (typeof c.method !== 'string' || !METHOD_PATTERN.test(c.method) || !obj(c.params))
      return { ok: false, code: 'INVALID_TRANSACTION' }
    if (BLOCKED_METHODS.has(c.method)) return { ok: false, code: 'METHOD_RESERVED_FOR_HOST' }
    if (c !== named[0] && (SOLITARY_METHODS.has(c.method) || c.method === 'hew.doc.transact'))
      return { ok: false, code: 'SOLITARY_METHOD_IN_TRANSACTION' }
    if (DESTRUCTIVE_METHODS.has(c.method) && confirmed !== true)
      return { ok: false, code: 'DESTRUCTIVE_CALL_REQUIRES_CONFIRMATION' }
    if (hasPathParam(c.params)) return { ok: false, code: 'BROWSER_HAS_NO_FILESYSTEM_PATH' }
  }
  if (method === 'hew.doc.save') {
    if (params.return_bytes === false || params.copy === true) return { ok: false, code: 'BROWSER_SAVE_RETURNS_BYTES' }
    return { ok: true, method, params: { ...params, return_bytes: true } }
  }
  return { ok: true, method, params }
}

/** Result fields that carry binary output (base64) the queue uploads. */
export const ARTIFACT_FIELDS: Readonly<Record<string, { mime: string; ext: string }>> = {
  png_base64: { mime: 'image/png', ext: 'png' },
  depth_png_base64: { mime: 'image/png', ext: 'depth.png' },
  normals_png_base64: { mime: 'image/png', ext: 'normals.png' },
  id_buffer_base64: { mime: 'application/octet-stream', ext: 'ids.bin' },
  pdf_base64: { mime: 'application/pdf', ext: 'pdf' },
  bytes_base64: { mime: 'application/octet-stream', ext: 'bin' },
}

/** File type of `bytes_base64` from a save/export result's `format`. */
export function bytesFormatType(format: unknown): { mime: string; ext: string } {
  switch (format) {
    case 'hew': return { mime: 'application/zip', ext: 'hew' }
    case 'skp': case 'skp2017': return { mime: 'application/octet-stream', ext: 'skp' }
    case 'glb': case 'gltf': return { mime: 'model/gltf-binary', ext: 'glb' }
    case 'stl': return { mime: 'model/stl', ext: 'stl' }
    case '3mf': return { mime: 'model/3mf', ext: '3mf' }
    case 'usdz': return { mime: 'model/vnd.usdz+zip', ext: 'usdz' }
    default: return { mime: 'application/octet-stream', ext: 'bin' }
  }
}
