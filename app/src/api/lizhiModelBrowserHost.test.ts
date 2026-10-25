import { describe, expect, it, vi } from 'vitest'
import {
  createLizhiModelHost,
  type ClaimedModelJob,
  type LocalModelLease,
  type ModelSceneDispatcher,
} from './lizhiModelBrowserHost'

const SESSION = '11111111-1111-4111-8111-111111111111'
const REQUEST = '22222222-2222-4222-8222-222222222222'
const DOCUMENT = 'lizhi-doc-demo-1'
const REVISION = 'rev-7'

function fixture() {
  const lease: LocalModelLease = {
    session_id: SESSION,
    document_id: DOCUMENT,
    revision: REVISION,
    consent_expires_at_ms: 2000,
  }
  let currentLease: LocalModelLease | null = lease
  let currentScene: ModelSceneDispatcher | null
  let now = 1000
  const frames: Record<string, unknown>[] = []
  const dispatch = vi.fn((_conn: number, frame: string) => {
    const value = JSON.parse(frame) as { method: string }
    frames.push(value as Record<string, unknown>)
    if (value.method === 'hew.meta.hello') {
      return JSON.stringify({ jsonrpc: '2.0', id: 'hello', result: { protocol: 1, profile: 'app' } })
    }
    return JSON.stringify({ jsonrpc: '2.0', id: 'command', result: { results: [{}, { object_id: 'obj_7' }, {}] } })
  })
  const open = vi.fn(() => 7)
  const close = vi.fn()
  currentScene = {
    api_connection_open: open,
    api_dispatch: dispatch,
    api_connection_close: close,
  }
  const refresh = vi.fn()
  const host = createLizhiModelHost({
    getScene: () => currentScene,
    getLease: () => currentLease,
    now: () => now,
    refreshScene: refresh,
  })
  const job: ClaimedModelJob = {
    request_id: REQUEST, session_id: SESSION,
    document_id: DOCUMENT, expected_revision: REVISION,
    action: 'create_box',
    params: { origin_m: [0, 0, 0], size_m: [1.2, 0.6, 0.75], name: 'Desk' },
  }
  return {
    job, host, dispatch, open, close, refresh, frames,
    setLease: (v: LocalModelLease | null) => { currentLease = v },
    setScene: (v: ModelSceneDispatcher | null) => { currentScene = v },
    setNow: (v: number) => { now = v },
  }
}

describe('Lizhi first-party browser model host (no transport)', () => {
  it('dispatches a bounded one-transaction box to real Hew API boundary only after hello', () => {
    const f = fixture()
    const result = f.host.execute(f.job)
    expect(result.status).toBe('succeeded')
    expect(result.automaticRetryAllowed).toBe(false)
    expect(f.frames.map(x => x.method)).toEqual(['hew.meta.hello', 'hew.doc.transact'])
    const commands = (f.frames[1].params as { commands: {
      method: string; params: Record<string, unknown>
    }[] }).commands
    expect(commands.map(c => c.method)).toEqual([
      'hew.sketch.draw_rect', 'hew.solid.extrude', 'hew.entity.rename',
    ])
    expect(commands[0].params.corner_b).toEqual([1.2, 0.6, 0])
    expect(commands[1].params.distance).toBe(0.75)
    expect(f.refresh).toHaveBeenCalledOnce()
    expect(f.open).toHaveBeenCalledOnce()
    expect(f.close).toHaveBeenCalledOnce()
  })

  it('refuses revoked / expired consent before opening a kernel connection', () => {
    const a = fixture()
    a.setLease(null)
    expect(a.host.execute(a.job).code).toBe('LOCAL_USER_CONSENT_REQUIRED')
    expect(a.open).not.toHaveBeenCalled()
    const b = fixture()
    b.setNow(2000)
    expect(b.host.execute(b.job).code).toBe('LOCAL_USER_CONSENT_REQUIRED')
    expect(b.open).not.toHaveBeenCalled()
  })

  it('refuses other sessions, other documents and stale revisions', () => {
    const a = fixture()
    expect(a.host.execute({ ...a.job, session_id: '33333333-3333-4333-8333-333333333333' }).code)
      .toBe('LOCAL_USER_CONSENT_REQUIRED')
    expect(a.host.execute({ ...a.job, document_id: 'another-doc' }).code)
      .toBe('DOCUMENT_MISMATCH')
    expect(a.host.execute({ ...a.job, expected_revision: 'rev-older' }).code)
      .toBe('STALE_DOCUMENT_REVISION')
    expect(a.dispatch).not.toHaveBeenCalled()
  })

  it('does not allow arbitrary Hew JSON-RPC, paths or invalid dimensions', () => {
    const f = fixture()
    for (const params of [
      { origin_m: [0, 0, 0], size_m: [-1, 2, 3] },
      { origin_m: [NaN, 0, 0], size_m: [1, 2, 3] },
      { origin_m: [0, 0, 0], size_m: [1, 2, 3], path: '/sensitive' },
      { origin_m: [0, 0, 0], size_m: [1, 2, 3], method: 'hew.doc.save' },
      { origin_m: [0, 0, 0], size_m: [100, 1, 1] },
    ]) expect(f.host.execute({ ...f.job, params }).code)
      .toBe('ACTION_NOT_ALLOWED_OR_INVALID_GEOMETRY')
    expect(f.host.execute({ ...f.job, action: 'delete' as 'create_box' }).status)
      .toBe('rejected')
    expect(f.dispatch).not.toHaveBeenCalled()
  })

  it('returns original same-id receipt without ever rerunning a mutation', () => {
    const f = fixture()
    const first = f.host.execute(f.job)
    expect(first.status).toBe('succeeded')
    expect(f.host.execute(f.job)).toBe(first)
    expect(f.frames).toHaveLength(2)
    expect(f.host.execute({ ...f.job, params: {
      origin_m: [1, 0, 0], size_m: [1.2, 0.6, 0.75],
    } }).code).toBe('REQUEST_ID_REUSED_WITH_DIFFERENT_PAYLOAD')
    expect(f.frames).toHaveLength(2)
  })

  it('does not repeat a potentially committed mutation after an exception', () => {
    const f = fixture()
    f.dispatch.mockImplementationOnce(() => JSON.stringify({
      jsonrpc: '2.0', id: 'hello', result: { protocol: 1 },
    })).mockImplementationOnce(() => { throw Error('kernel reply lost') })
    expect(f.host.execute(f.job).status).toBe('unknown')
    expect(f.host.execute(f.job).code).toBe('MODEL_RESULT_UNKNOWN_DO_NOT_RETRY')
    expect(f.dispatch).toHaveBeenCalledTimes(2)
    expect(f.close).toHaveBeenCalledTimes(1)
    expect(f.refresh).not.toHaveBeenCalled()
  })

  it('refuses the transaction on typed kernel error and does not refresh', () => {
    const f = fixture()
    f.dispatch.mockImplementationOnce(() => JSON.stringify({
      jsonrpc: '2.0', id: 'hello', result: { protocol: 1 },
    })).mockImplementationOnce(() => JSON.stringify({
      jsonrpc: '2.0', id: 'command', error: { code: -32602, message: 'invalid geometry' },
    }))
    expect(f.host.execute(f.job).code).toBe('HEW_KERNEL_REFUSED')
    expect(f.refresh).not.toHaveBeenCalled()
    expect(f.close).toHaveBeenCalledOnce()
  })

  it('runs a scene query without mutating or refreshing the viewport', () => {
    const f = fixture()
    const result = f.host.execute({ ...f.job, action: 'query_scene', params: {} })
    expect(result.status).toBe('succeeded')
    expect(f.frames[1].method).toBe('hew.query.scene')
    expect(f.refresh).not.toHaveBeenCalled()
  })

  it('refuses missing scene before any dispatch', () => {
    const f = fixture()
    f.setScene(null)
    expect(f.host.execute(f.job).code).toBe('SCENE_NOT_READY')
    expect(f.dispatch).not.toHaveBeenCalled()
  })
})
