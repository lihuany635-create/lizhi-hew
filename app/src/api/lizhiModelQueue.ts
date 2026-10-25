/**
 * Lizhi Model M3 browser job orchestrator.
 *
 * Runs within Hew's first-party tab. No service-role key, Edge secret, automatic
 * timer, localStorage token or cross-origin message listener. An application
 * controller must supply a Supabase PostgREST client with a VERIFIED user's
 * JWT, plus user-gesture consent and live same-Scene document identity.
 *
 * PROPOSAL ONLY: not connected to production auth, not mounted in Hew UI.
 * The scene host commits WASM geometry; persistence to a .hew file is separate.
 */
import type { ClaimedModelJob, LocalModelReceipt } from './lizhiModelBrowserHost'

export type DocumentIdentity = { document_id: string; revision: string }

export interface ModelJobRpc {
  rpc(name: string, params: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>
}
export interface ModelJobHost {
  execute(job: ClaimedModelJob): LocalModelReceipt
}
export interface ModelJobEnvironment {
  rpc: ModelJobRpc
  host: ModelJobHost
  // MUST validate Supabase auth.getUser() against the actual server.
  verifyAuthenticatedOwner(): Promise<boolean>
  getDocument(): DocumentIdentity | null
  pageVisible(): boolean
  now(): number
  uuid(): string
  /** Verify actual WASM scene revision after successful transaction; don't invent it. */
  confirmCommittedRevision(oldRevision: string): Promise<string | null>
  /** Projection only; never send actual model file, document paths or materials. */
  readSceneEntities(): Promise<Array<{ id: string; name: string; kind: string }>>
}
export type QueueOutcome =
  | { state: 'idle' }
  | { state: 'rejected'; code: string }
  | { state: 'unknown'; code: string; job_id?: string }
  | { state: 'failed'; code: string; job_id: string }
  | { state: 'succeeded'; job_id: string; revision: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_CONSENT_MS = 120_000
const MAX_RPC_CHARS = 8192
const validRevision = (s: unknown): s is string =>
  typeof s === 'string' && s.length > 0 && s.length <= 128
const validDoc = (d: DocumentIdentity | null): d is DocumentIdentity =>
  !!d && UUID.test(d.document_id) && validRevision(d.revision)
const object = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x)
const err = (code: string): QueueOutcome => ({ state: 'rejected', code })
const limit = (v: unknown) => {
  try { return JSON.stringify(v).length <= MAX_RPC_CHARS } catch { return false }
}
async function query(db: ModelJobRpc, name: string, params: Record<string, unknown>) {
  // Only these functions may be called, never untrusted job-supplied methods.
  const permitted = [
    'lizhi_model_begin', 'lizhi_model_heartbeat', 'lizhi_model_claim',
    'lizhi_model_finish', 'lizhi_model_publish_scene', 'lizhi_model_close',
  ]
  if (!permitted.includes(name)) throw Error('UNAUTHORIZED_RPC')
  const {data,error} = await db.rpc(name,params)
  if (error || !limit(data)) throw Error('MODEL_RPC_FAILED')
  return data
}

export function createLizhiModelQueue(env: ModelJobEnvironment) {
  let lease: { session_id: string; document_id: string; revision: string; deadline: number } | null = null
  let busy = false
  const received = new Set<string>()

  function validLease(): boolean {
    const d=env.getDocument()
    return !!lease && env.pageVisible() && env.now() < lease.deadline &&
      validDoc(d) && d.document_id === lease.document_id &&
      d.revision === lease.revision
  }

  async function authorizeFromUserClick(): Promise<boolean> {
    if (busy || lease || !env.pageVisible()) return false
    busy=true
    try {
      if (!await env.verifyAuthenticatedOwner()) return false
      const doc=env.getDocument()
      if (!validDoc(doc)) return false
      const sid=env.uuid()
      if (!UUID.test(sid)) return false
      // Must not start if the user changed documents during the auth round trip.
      const before={...doc}
      const allowed=await query(env.rpc,'lizhi_model_begin',{
        p_session:sid,p_document:doc.document_id,p_revision:doc.revision,
      })
      if (allowed !== true) return false
      const after=env.getDocument()
      if (!env.pageVisible() || !validDoc(after) ||
          after.document_id !== before.document_id || after.revision !== before.revision) {
        await query(env.rpc,'lizhi_model_close',{p_session:sid}).catch(()=>null)
        return false
      }
      lease={session_id:sid,document_id:before.document_id,
        revision:before.revision,deadline:env.now()+MAX_CONSENT_MS}
      return true
    } catch { return false }
    finally {busy=false}
  }

  async function revoke(): Promise<boolean> {
    const prev=lease
    lease=null
    if (!prev) return true
    try {
      return await query(env.rpc,'lizhi_model_close',{p_session:prev.session_id}) === true
    } catch { return false }
  }

  async function pollOne(): Promise<QueueOutcome> {
    if (busy) return err('MODEL_QUEUE_BUSY')
    if (!validLease()) {
      if (lease) await revoke()
      return err('USER_CONSENT_OR_DOCUMENT_EXPIRED')
    }
    busy=true
    try {
      if (!await env.verifyAuthenticatedOwner()) return err('MODEL_AUTH_NOT_VERIFIED')
      if (!validLease()) return err('USER_CONSENT_OR_DOCUMENT_EXPIRED')
      const before={...lease!}
      const heartbeat=await query(env.rpc,'lizhi_model_heartbeat',{
        p_session:before.session_id,p_document:before.document_id,p_revision:before.revision,
      })
      if (heartbeat!==true) return err('MODEL_SESSION_REVOKED')
      const claim=await query(env.rpc,'lizhi_model_claim',{p_session:before.session_id})
      if (claim===null) return {state:'idle'}
      if (!object(claim) || !UUID.test(claim.job_id as string) ||
          !UUID.test(claim.request_id as string) ||
          !UUID.test(claim.session_id as string) ||
          !UUID.test(claim.document_id as string) ||
          !validRevision(claim.expected_revision) ||
          !['create_box','move'].includes(claim.command as string) ||
          !object(claim.params) ||
          claim.session_id !== before.session_id ||
          claim.document_id !== before.document_id ||
          claim.expected_revision !== before.revision ||
          received.has(claim.request_id as string)) {
        // Claimed jobs cannot be automatically replayed. A bad claim is
        // reported as unknown for manual inspection; never run its command.
        return {state:'unknown',code:'MODEL_INVALID_CLAIM_DO_NOT_RETRY',
          job_id:typeof claim.job_id==='string'?claim.job_id:undefined}
      }
      const jobId=claim.job_id as string
      received.add(claim.request_id as string)
      if (!validLease())return {state:'unknown',code:'MODEL_CONSENT_LOST_AFTER_CLAIM',job_id:jobId}
      const job: ClaimedModelJob={
        request_id:claim.request_id as string,session_id:before.session_id,
        document_id:before.document_id,expected_revision:before.revision,
        action:claim.command as 'create_box'|'move',params:claim.params,
      }
      const receipt=env.host.execute(job)
      if (receipt.status!=='succeeded') {
        // Unknown kernel result may already have committed. Do not auto-replay.
        // Mark failed only on an explicit kernel rejection; unknown stays claimed.
        if (receipt.status==='rejected') {
          const finish=await query(env.rpc,'lizhi_model_finish',{
            p_session:before.session_id,p_job:jobId,p_success:false,
            p_new_revision:before.revision,p_result:null,
            p_error:receipt.code??'MODEL_ENGINE_REJECTED',
          })
          if (finish===true)return {state:'failed',code:receipt.code??'MODEL_ENGINE_REJECTED',job_id:jobId}
        }
        return {state:'unknown',code:receipt.code??'MODEL_RESULT_UNKNOWN_DO_NOT_RETRY',job_id:jobId}
      }
      // Revision is read from actual Hew scene/application; the bridge cannot
      // claim success merely because a JSON-RPC reply said "result".
      const committed=await env.confirmCommittedRevision(before.revision)
      if (!validRevision(committed) || committed===before.revision)
        return {state:'unknown',code:'MODEL_REVISION_NOT_VERIFIED_DO_NOT_RETRY',job_id:jobId}
      const current=env.getDocument()
      if (!current || current.document_id!==before.document_id ||
          current.revision!==committed || !env.pageVisible() ||
          env.now()>=before.deadline)
        return {state:'unknown',code:'MODEL_DOCUMENT_CHANGED_AFTER_COMMIT_DO_NOT_RETRY',job_id:jobId}
      const finished=await query(env.rpc,'lizhi_model_finish',{
        p_session:before.session_id,p_job:jobId,p_success:true,
        p_new_revision:committed,p_result:{kernel_transaction_committed:true},p_error:null,
      })
      if (finished!==true)
        return {state:'unknown',code:'MODEL_FINISH_ACK_UNKNOWN_DO_NOT_RETRY',job_id:jobId}
      lease={...before,revision:committed}
      // Scene projection is best-effort: do not invalidate committed receipt.
      try {
        const entities=await env.readSceneEntities()
        if (Array.isArray(entities) && entities.length<=100 && limit(entities)) {
          await query(env.rpc,'lizhi_model_publish_scene',{
            p_session:before.session_id,p_document:before.document_id,
            p_revision:committed,p_entities:entities
          })
        }
      } catch { /* status succeeded, but scene snapshot not published */ }
      return {state:'succeeded',job_id:jobId,revision:committed}
    } catch {
      return {state:'unknown',code:'MODEL_RPC_RESULT_UNKNOWN_DO_NOT_RETRY'}
    } finally {busy=false}
  }
  return {authorizeFromUserClick,pollOne,revoke,
    isAuthorized:()=>validLease(),
    getLease:()=>validLease()?{...lease!}:null}
}
