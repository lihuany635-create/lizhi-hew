/**
 * Development-only local integration proof for Lizhi Model × Hew WASM.
 * No network, no token, no MCP, no cross-origin message event.
 * User explicitly arms this panel for ONE scene/revision and loses consent
 * when tab becomes hidden. Re-arming is mandatory after document mutation.
 * Do not enable in a production build without a separate durable job host.
 */
import { useEffect, useRef, useState } from 'react'
import { createLizhiModelHost, type LocalModelLease, type ModelSceneDispatcher } from './lizhiModelBrowserHost'

export interface LizhiModelPilotProps {
  getScene(): ModelSceneDispatcher | null
  getRevision(): string
  refreshScene(): void
}

interface ModelPermission {
  scene: ModelSceneDispatcher
  lease: LocalModelLease
}

export function LizhiModelPilotPanel({ getScene, getRevision, refreshScene }: LizhiModelPilotProps) {
  const [enabled, setEnabled] = useState(false)
  const [lastResult, setLastResult] = useState('No actions submitted')
  const permissionRef = useRef<ModelPermission | null>(null)
  const hostRef = useRef<ReturnType<typeof createLizhiModelHost> | null>(null)
  const latestDeps = useRef({ getScene, getRevision, refreshScene })
  latestDeps.current = { getScene, getRevision, refreshScene }

  function revoke() {
    permissionRef.current = null
    setEnabled(false)
  }

  useEffect(() => {
    const revokeWhenHidden = () => {
      if (document.visibilityState !== 'visible') revoke()
    }
    document.addEventListener('visibilitychange', revokeWhenHidden)
    return () => {
      permissionRef.current = null
      document.removeEventListener('visibilitychange', revokeWhenHidden)
    }
  }, [])

  function arm() {
    const scene = latestDeps.current.getScene()
    if (!scene) {
      setLastResult('Hew kernel is not ready')
      return
    }
    const lease: LocalModelLease = {
      session_id: crypto.randomUUID(),
      document_id: crypto.randomUUID(),
      revision: latestDeps.current.getRevision(),
      consent_expires_at_ms: Date.now() + 2 * 60_000,
    }
    permissionRef.current = { scene, lease }
    // New host means no receipts from old document/old approval carry over.
    hostRef.current = createLizhiModelHost({
      getScene: () => latestDeps.current.getScene(),
      getLease: () => {
        const granted = permissionRef.current
        if (!granted || granted.scene !== latestDeps.current.getScene() ||
            granted.lease.revision !== latestDeps.current.getRevision()) return null
        return granted.lease
      },
      now: () => Date.now(),
      refreshScene: () => latestDeps.current.refreshScene(),
    })
    setEnabled(true)
    setLastResult('Local 2-minute grant active; no remote connection')
  }

  function createTestBox() {
    const grant = permissionRef.current
    if (!grant || !hostRef.current) {
      setLastResult('Please grant local access first')
      return
    }
    const receipt = hostRef.current.execute({
      request_id: crypto.randomUUID(),
      session_id: grant.lease.session_id,
      document_id: grant.lease.document_id,
      expected_revision: grant.lease.revision,
      action: 'create_box',
      params: {
        origin_m: [0, 0, 0], size_m: [1.2, 0.6, 0.75], name: 'Lizhi Test Box',
      },
    })
    setLastResult(`${receipt.status}: ${receipt.code ?? 'Hew geometry transaction completed (not saved to disk)'}`)
    // One local mutation exhausts the approval, and requires a new revision
    // and explicit renewed consent before any following write.
    revoke()
  }

  return (
    <aside aria-label="Lizhi model pilot" style={{
      position: 'absolute', bottom: '18px', right: '18px', zIndex: 500,
      background: 'var(--surface-overlay, #222)', color: 'var(--text-primary, #fff)',
      border: '1px solid var(--border-default, #777)', borderRadius: '10px',
      width: '290px', padding: '12px', display: 'grid', gap: '8px',
    }}>
      <strong>立之 3D｜本機開發驗收</strong>
      <small>此面板不連接 ChatGPT／Supabase；僅測試本頁的 Hew WASM。</small>
      <button type="button" onClick={arm} disabled={enabled}>
        {enabled ? '本頁授權中（2 分鐘）' : '手動允許一次測試'}
      </button>
      <button type="button" onClick={createTestBox} disabled={!enabled}>
        建立 1200 × 600 × 750 mm 測試方體
      </button>
      <button type="button" onClick={revoke} disabled={!enabled}>撤銷授權</button>
      <small role="status">{lastResult}</small>
    </aside>
  )
}
