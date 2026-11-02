import { describe, expect, it, vi } from 'vitest'
import { createLizhiModelHost, type ClaimedModelJob, type LocalModelReceipt } from './lizhiModelBrowserHost'
import { createLizhiModelQueue, type DocumentIdentity, type ModelJobEnvironment } from './lizhiModelQueue'

const SID = '11111111-1111-4111-8111-111111111111'
const DOC = '22222222-2222-4222-8222-222222222222'
const REQ = '33333333-3333-4333-8333-333333333333'
const JOB = '44444444-4444-4444-8444-444444444444'

function hostFixture(result: unknown, opts: { mutates?: boolean; error?: unknown } = {}) {
  const frames: Array<{ method: string; params?: unknown }> = []
  const scene = {
    api_connection_open: () => 1,
    api_connection_close: vi.fn(),
    api_method_mutates: vi.fn(() => opts.mutates ?? false),
    api_dispatch: (_c: number, frame: string) => {
      const f = JSON.parse(frame) as { method: string; params?: unknown; id: string }
      frames.push(f)
      if (f.method === 'hew.meta.hello') return JSON.stringify({ jsonrpc: '2.0', id: f.id, result: { protocol: 1 } })
      if (f.method === 'hew.doc.attach') return JSON.stringify({ jsonrpc: '2.0', id: f.id, result: {} })
      return JSON.stringify(opts.error
        ? { jsonrpc: '2.0', id: f.id, error: opts.error }
        : { jsonrpc: '2.0', id: f.id, result })
    },
  }
  const refresh = vi.fn()
  const after = vi.fn()
  const host = createLizhiModelHost({
    getScene: () => scene,
    getLease: () => ({ session_id: SID, document_id: DOC, revision: 'r1', consent_expires_at_ms: 9e15 }),
    refreshScene: refresh,
    now: () => 1000,
    afterDispatch: after,
  })
  const job = (params: unknown): ClaimedModelJob => ({
    request_id: REQ, session_id: SID, document_id: DOC, expected_revision: 'r1', action: 'call', params,
  })
  return { host, frames, refresh, after, job, scene }
}

describe('browser host call action', () => {
  it('dispatches any allowed method and reports whether it mutated', () => {
    const f = hostFixture({ region_id: 'r9' }, { mutates: true })
    const r = f.host.execute(f.job({ method: 'hew.sketch.offset', params: { region: 'r1', distance: 0.02 } }))
    expect(r).toMatchObject({ status: 'succeeded', mutated: true, reply: { region_id: 'r9' } })
    expect(f.frames[2]).toMatchObject({ method: 'hew.sketch.offset', params: { region: 'r1', distance: 0.02 } })
    expect(f.refresh).toHaveBeenCalledOnce()
    expect(f.after).toHaveBeenCalledWith('hew.sketch.offset', expect.any(String), true)
  })

  it('does not refresh after a read-only call', () => {
    const f = hostFixture({ tree: [] }, { mutates: false })
    const r = f.host.execute(f.job({ method: 'hew.query.scene' }))
    expect(r).toMatchObject({ status: 'succeeded', mutated: false })
    expect(f.refresh).not.toHaveBeenCalled()
  })

  it('returns the kernel error so the AI can fix its params', () => {
    const f = hostFixture(null, { error: { code: -32602, message: 'bad', data: { refusal: 'not_planar' } } })
    const r = f.host.execute(f.job({ method: 'hew.solid.push_pull', params: {} }))
    expect(r).toMatchObject({ status: 'rejected', code: 'HEW_KERNEL_REFUSED', reply: { error: { message: 'bad' } } })
  })

  it('refuses unconfirmed destructive calls before reaching the scene', () => {
    const f = hostFixture({})
    const r = f.host.execute(f.job({ method: 'hew.entity.delete', params: { ids: ['obj_1'] } }))
    expect(r).toMatchObject({ status: 'rejected', code: 'DESTRUCTIVE_CALL_REQUIRES_CONFIRMATION' })
    expect(f.frames).toHaveLength(0)
  })
})

function queueFixture(receipt: LocalModelReceipt) {
  let doc: DocumentIdentity = { document_id: DOC, revision: 'r1' }
  const calls: Array<{ name: string; params: Record<string, unknown> }> = []
  const uploads: Array<{ mime: string; ext: string; bytes: number }> = []
  const claim = { job_id: JOB, request_id: REQ, session_id: SID, document_id: DOC,
    expected_revision: 'r1', command: 'call', params: { method: 'hew.view.snapshot', params: {} } }
  let pending: unknown = claim
  const env: ModelJobEnvironment = {
    rpc: { rpc: async (name, params) => {
      calls.push({ name, params })
      if (name === 'lizhi_model_claim') { const c = pending; pending = null; return { data: c, error: null } }
      return { data: true, error: null }
    } },
    host: { execute: () => {
      if (receipt.mutated) doc = { document_id: DOC, revision: 'r2' }
      return receipt
    } },
    verifyAuthenticatedOwner: async () => true,
    getDocument: () => doc,
    pageVisible: () => true,
    now: () => 1000,
    uuid: () => SID,
    confirmCommittedRevision: async (prev) => doc.revision !== prev ? doc.revision : null,
    readSceneEntities: async () => [],
    uploadArtifact: async (bytes, mime, ext, jobId) => {
      uploads.push({ mime, ext, bytes: bytes.byteLength })
      return { bucket: 'lizhi-model-files', path: `${SID}/${jobId}/x.${ext}`, mime, bytes: bytes.byteLength }
    },
  }
  const queue = createLizhiModelQueue(env)
  return { queue, calls, uploads }
}

describe('queue call jobs', () => {
  it('finishes a read-only call at the same revision and uploads binary results', async () => {
    const png = btoa('\x89PNG fake image bytes')
    const f = queueFixture({ status: 'succeeded', mutated: false, automaticRetryAllowed: false,
      reply: { png_base64: png, width: 512, height: 512 } })
    expect(await f.queue.authorizeFromUserClick()).toBe(true)
    expect(await f.queue.pollOne()).toEqual({ state: 'succeeded', job_id: JOB, revision: 'r1' })
    expect(f.uploads).toEqual([{ mime: 'image/png', ext: 'png', bytes: 21 }])
    const fin = f.calls.find(c => c.name === 'lizhi_model_finish_v2')!
    expect(fin.params).toMatchObject({ p_success: true, p_mutated: false, p_new_revision: 'r1' })
    expect(fin.params.p_result).toEqual({ width: 512, height: 512,
      artifacts: { png_base64: { bucket: 'lizhi-model-files', path: `${SID}/${JOB}/x.png`, mime: 'image/png', bytes: 21 } } })
    expect(f.calls.some(c => c.name === 'lizhi_model_publish_scene')).toBe(false)
  })

  it('finishes a mutating call at the new verified revision and republishes the scene', async () => {
    const f = queueFixture({ status: 'succeeded', mutated: true, automaticRetryAllowed: false, reply: { object_id: 'obj_2' } })
    await f.queue.authorizeFromUserClick()
    expect(await f.queue.pollOne()).toEqual({ state: 'succeeded', job_id: JOB, revision: 'r2' })
    expect(f.calls.find(c => c.name === 'lizhi_model_finish_v2')!.params)
      .toMatchObject({ p_mutated: true, p_new_revision: 'r2', p_result: { object_id: 'obj_2' } })
    expect(f.calls.some(c => c.name === 'lizhi_model_publish_scene')).toBe(true)
  })

  it('records a kernel refusal as failed with the kernel error detail', async () => {
    const f = queueFixture({ status: 'rejected', code: 'HEW_KERNEL_REFUSED', automaticRetryAllowed: false,
      reply: { error: { code: -32602, message: 'bad' } } })
    await f.queue.authorizeFromUserClick()
    expect(await f.queue.pollOne()).toEqual({ state: 'failed', code: 'HEW_KERNEL_REFUSED', job_id: JOB })
    expect(f.calls.find(c => c.name === 'lizhi_model_finish_v2')!.params)
      .toMatchObject({ p_success: false, p_error: 'HEW_KERNEL_REFUSED', p_result: { error: { message: 'bad' } } })
  })

  it('halts on an unknown result and never finishes it', async () => {
    const f = queueFixture({ status: 'unknown', code: 'MODEL_RESULT_UNKNOWN_DO_NOT_RETRY', automaticRetryAllowed: false })
    await f.queue.authorizeFromUserClick()
    expect((await f.queue.pollOne()).state).toBe('unknown')
    expect(f.calls.some(c => c.name.startsWith('lizhi_model_finish'))).toBe(false)
  })
})
