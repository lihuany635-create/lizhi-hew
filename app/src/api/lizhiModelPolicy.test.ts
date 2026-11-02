import { describe, expect, it } from 'vitest'
import { checkCallJob, bytesFormatType } from './lizhiModelPolicy'

describe('checkCallJob', () => {
  it('accepts any well-formed Hew method with object params', () => {
    expect(checkCallJob({ method: 'hew.solid.follow_me', params: { profile: 'r1', path: undefined } }))
      .toEqual({ ok: true, method: 'hew.solid.follow_me', params: { profile: 'r1', path: undefined } })
    expect(checkCallJob({ method: 'hew.query.scene' })).toEqual({ ok: true, method: 'hew.query.scene', params: {} })
  })

  it('refuses host-owned connection methods', () => {
    for (const method of ['hew.meta.hello', 'hew.doc.attach', 'hew.doc.focus'])
      expect(checkCallJob({ method, params: {} })).toEqual({ ok: false, code: 'METHOD_RESERVED_FOR_HOST' })
  })

  it('requires confirmation for destructive calls, also inside a transaction', () => {
    expect(checkCallJob({ method: 'hew.entity.delete', params: { ids: ['obj_1'] } }))
      .toEqual({ ok: false, code: 'DESTRUCTIVE_CALL_REQUIRES_CONFIRMATION' })
    expect(checkCallJob({ method: 'hew.entity.delete', params: { ids: ['obj_1'] }, confirmed: true }).ok).toBe(true)
    const tx = { method: 'hew.doc.transact', params: { commands: [
      { method: 'hew.sketch.draw_rect', params: {} },
      { method: 'hew.entity.delete', params: { ids: ['obj_1'] } },
    ] } }
    expect(checkCallJob(tx)).toEqual({ ok: false, code: 'DESTRUCTIVE_CALL_REQUIRES_CONFIRMATION' })
    expect(checkCallJob({ ...tx, confirmed: true }).ok).toBe(true)
  })

  it('refuses solitary or nested transactions inside a transaction', () => {
    for (const method of ['hew.doc.save', 'hew.view.snapshot', 'hew.doc.transact']) {
      expect(checkCallJob({ method: 'hew.doc.transact', params: { commands: [{ method, params: {} }] } }))
        .toEqual({ ok: false, code: 'SOLITARY_METHOD_IN_TRANSACTION' })
    }
  })

  it('refuses filesystem paths anywhere in params', () => {
    expect(checkCallJob({ method: 'hew.doc.export', params: { format: 'glb', path: '/etc/x' } }))
      .toEqual({ ok: false, code: 'BROWSER_HAS_NO_FILESYSTEM_PATH' })
    expect(checkCallJob({ method: 'hew.view.snapshot', params: { opts: { depth_path: 'a.png' } } }))
      .toEqual({ ok: false, code: 'BROWSER_HAS_NO_FILESYSTEM_PATH' })
  })

  it('forces a browser save to hand bytes back', () => {
    expect(checkCallJob({ method: 'hew.doc.save', params: { format: 'hew' } }))
      .toEqual({ ok: true, method: 'hew.doc.save', params: { format: 'hew', return_bytes: true } })
    expect(checkCallJob({ method: 'hew.doc.save', params: { return_bytes: false } }).ok).toBe(false)
  })

  it('rejects malformed jobs', () => {
    expect(checkCallJob(null).ok).toBe(false)
    expect(checkCallJob({ method: 'eval', params: {} }).ok).toBe(false)
    expect(checkCallJob({ method: 'hew.query.scene', params: [] }).ok).toBe(false)
    expect(checkCallJob({ method: 'hew.query.scene', extra: 1 }).ok).toBe(false)
    expect(checkCallJob({ method: 'hew.query.scene', confirmed: false }).ok).toBe(false)
    expect(checkCallJob({ method: 'hew.doc.transact', params: { commands: [] } }).ok).toBe(false)
  })

  it('maps export formats to file types', () => {
    expect(bytesFormatType('glb')).toEqual({ mime: 'model/gltf-binary', ext: 'glb' })
    expect(bytesFormatType('hew').ext).toBe('hew')
    expect(bytesFormatType('nope').ext).toBe('bin')
  })
})
