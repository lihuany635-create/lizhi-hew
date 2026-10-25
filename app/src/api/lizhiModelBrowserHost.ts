/**
 * 立之 3D browser-side execution core (AGPL-3.0-only, derived integration for Hew).
 *
 * This module runs INSIDE the already-authorized Hew React/WASM tab, against
 * its existing live Scene. It deliberately starts NO network requests, opens
 * NO MCP port, registers NO window message listener and holds NO API secrets.
 * The site, session lease, durable queue and consent UI are separate future
 * integrations. Do NOT call this from arbitrary HTTP, postMessage or untrusted
 * cross-origin code. Supply only authenticated, owner-scoped, claimed jobs.
 *
 * A successful response means the WASM kernel committed a transaction; it
 * does NOT mean .hew bytes reached persistent disk. File save/ack is separate.
 */
export type ModelAction = 'create_box' | 'move' | 'query_scene'

export interface ClaimedModelJob {
  request_id: string
  session_id: string
  document_id: string
  expected_revision: string
  action: ModelAction
  params: unknown
}

export interface LocalModelLease {
  session_id: string
  document_id: string
  revision: string
  consent_expires_at_ms: number
}

export interface ModelSceneDispatcher {
  api_connection_open(): number
  api_dispatch(connection: number, frame: string): string | undefined
  api_connection_close(connection: number): void
}

export interface ModelHostDeps {
  getScene(): ModelSceneDispatcher | null
  getLease(): LocalModelLease | null
  refreshScene(): void
  /** Must be backed by authoritative browser document session; NOT remote data. */
  now(): number
}

export interface LocalModelReceipt {
  status: 'succeeded' | 'rejected' | 'unknown'
  code?: string
  reply?: unknown
  automaticRetryAllowed: false
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const safe = (n: unknown, max: number) =>
  typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= max
const obj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const keys = (v: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every(k => Object.prototype.hasOwnProperty.call(v, k)) &&
  Object.keys(v).every(k => required.includes(k) || optional.includes(k))
const vec = (v: unknown, max: number) =>
  Array.isArray(v) && v.length === 3 && v.every(n => safe(n, max))
const refuse = (code: string): LocalModelReceipt =>
  ({ status: 'rejected', code, automaticRetryAllowed: false })

const MAX_BYTES = 8192
const MAX_REPLY_CHARS = 65536

function commandFor(job: ClaimedModelJob): { method: string; params: Record<string, unknown> } | null {
  const p = job.params
  if (!obj(p)) return null
  if (job.action === 'query_scene') {
    return keys(p, []) ? { method: 'hew.query.scene', params: {} } : null
  }
  if (job.action === 'create_box') {
    if (!keys(p, ['origin_m', 'size_m'], ['name']) ||
        !vec(p.origin_m, 100) || !Array.isArray(p.size_m) ||
        p.size_m.length !== 3 || !p.size_m.every(n => safe(n, 20) && n >= 0.0001) ||
        (p.name !== undefined && (typeof p.name !== 'string' || p.name.length < 1 || p.name.length > 80))) return null
    const [x, y, z] = p.origin_m as number[]
    const [w, d, h] = p.size_m as number[]
    return { method: 'hew.doc.transact', params: {
      label: '立之 AI: create box', commands: [
        { method: 'hew.sketch.draw_rect', as: 'base', params: {
          plane: { origin: [x, y, z], normal: [0, 0, 1] },
          corner_a: [x, y, z], corner_b: [x + w, y + d, z],
        } },
        { method: 'hew.solid.extrude', as: 'solid', params: {
          region: { $ref: 'base#/region_id' }, distance: h,
        } },
        { method: 'hew.entity.rename', params: {
          id: { $ref: 'solid#/object_id' }, name: p.name ?? 'Box',
        } },
      ],
    } }
  }
  if (job.action === 'move') {
    if (!keys(p, ['entity_id', 'translation_m']) ||
      typeof p.entity_id !== 'string' || !/^[a-z][a-z0-9_-]{0,79}$/i.test(p.entity_id) ||
      !vec(p.translation_m, 100) || (p.translation_m as number[]).every(n => n === 0)) return null
    return { method: 'hew.doc.transact', params: {
      label: '立之 AI: move object',
      commands: [{ method: 'hew.entity.move', params: {
        ids: [p.entity_id], translation: p.translation_m,
      } }],
    } }
  }
  return null
}

/**
 * Bind once to a trusted, same-origin host. The caller must verify that a
 * queue job was claimed for the authenticated user, and must separately
 * write its durable receipt to Supabase after this method returns.
 *
 * One process memory ledger suppresses duplicate request IDs within this
 * page instance, including an unconfirmed/exception result. The database
 * must enforce durable request_id idempotency across refresh/restarts.
 */
export function createLizhiModelHost(deps: ModelHostDeps) {
  const receipts = new Map<string, { payload: string; receipt: LocalModelReceipt }>()
  let busy = false

  function execute(job: ClaimedModelJob): LocalModelReceipt {
    let payload: string
    try {
      payload = JSON.stringify(job)
    } catch {
      return refuse('INVALID_JOB')
    }
    if (!payload || new TextEncoder().encode(payload).byteLength > MAX_BYTES ||
        !ID.test(job.request_id ?? '') || !ID.test(job.session_id ?? '') ||
        typeof job.document_id !== 'string' || job.document_id.length > 128 ||
        !job.document_id || typeof job.expected_revision !== 'string' ||
        job.expected_revision.length > 128 || !job.expected_revision) return refuse('INVALID_JOB')

    const previous = receipts.get(job.request_id)
    if (previous) return previous.payload === payload
      ? previous.receipt : refuse('REQUEST_ID_REUSED_WITH_DIFFERENT_PAYLOAD')
    if (busy) return refuse('MODEL_HOST_BUSY')

    const lease = deps.getLease()
    if (!lease || lease.consent_expires_at_ms <= deps.now() ||
        lease.session_id !== job.session_id) return refuse('LOCAL_USER_CONSENT_REQUIRED')
    if (lease.document_id !== job.document_id) return refuse('DOCUMENT_MISMATCH')
    if (lease.revision !== job.expected_revision) return refuse('STALE_DOCUMENT_REVISION')
    const scene = deps.getScene()
    if (!scene) return refuse('SCENE_NOT_READY')
    const command = commandFor(job)
    if (!command) return refuse('ACTION_NOT_ALLOWED_OR_INVALID_GEOMETRY')
    const uncertain: LocalModelReceipt = {
      status: 'unknown', code: 'MODEL_RESULT_UNKNOWN_DO_NOT_RETRY', automaticRetryAllowed: false,
    }
    receipts.set(job.request_id, { payload, receipt: uncertain })
    busy = true
    let connection: number | undefined
    try {
      connection = scene.api_connection_open()
      const hello = scene.api_dispatch(connection, JSON.stringify({
        jsonrpc: '2.0', id: 'hello', method: 'hew.meta.hello',
        params: { protocol: 1, client: { name: 'lizhi-model-browser-host', version: '0.1.0' } },
      }))
      const h = hello ? JSON.parse(hello) as { error?: unknown; result?: unknown } : null
      if (!h || h.error || !h.result) return uncertain
      // The live protocol requires an explicit document attach after hello.
      // Without it the real Hew dispatcher refuses even valid geometry
      // (-32002), although mocked transports can appear successful.
      const attach = scene.api_dispatch(connection, JSON.stringify({
        jsonrpc: '2.0', id: 'attach', method: 'hew.doc.attach', params: {},
      }))
      const attached = attach ? JSON.parse(attach) as { error?: unknown; result?: unknown } : null
      if (!attached || attached.error || attached.result === undefined) return uncertain
      const reply = scene.api_dispatch(connection, JSON.stringify({
        jsonrpc: '2.0', id: 'command', ...command,
      }))
      const parsed = reply ? JSON.parse(reply) as { error?: unknown; result?: unknown } : null
      if (!parsed) return uncertain
      if (parsed.error) {
        const receipt = refuse('HEW_KERNEL_REFUSED')
        receipts.set(job.request_id, { payload, receipt })
        return receipt
      }
      if (parsed.result === undefined || reply!.length > MAX_REPLY_CHARS) return uncertain
      if (command.method !== 'hew.query.scene') deps.refreshScene()
      const receipt: LocalModelReceipt = {
        status: 'succeeded', reply: parsed.result, automaticRetryAllowed: false,
      }
      receipts.set(job.request_id, { payload, receipt })
      return receipt
    } catch {
      return uncertain
    } finally {
      if (connection !== undefined) {
        try { scene.api_connection_close(connection) } catch { /* connection already lost */ }
      }
      busy = false
    }
  }

  return { execute }
}
