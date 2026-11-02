/**
 * Lizhi Model M3 browser job orchestrator.
 *
 * Runs within Hew's first-party tab. No service-role key, Edge secret,
 * localStorage token or cross-origin message listener. A connected UI may
 * automatically poll pending work under a bounded explicit 30-minute lease. An application
 * controller must supply a Supabase PostgREST client with a VERIFIED user's
 * JWT, plus user-gesture consent and live same-Scene document identity.
 *
 * The production UI must receive auth only from the verified same-origin parent.
 * The scene host commits WASM geometry; persistence to a .hew file is separate.
 */
import type { ClaimedModelJob, LocalModelReceipt } from './lizhiModelBrowserHost'
import { ARTIFACT_FIELDS, bytesFormatType } from './lizhiModelPolicy'

/** Where an uploaded binary result now lives (owner-private storage). */
export interface StoredArtifact { bucket: string; path: string; mime: string; bytes: number }

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
  // Frame still open/mounted; background tabs ARE allowed within the lease.
  pageVisible(): boolean
  now(): number
  uuid(): string
  /** Verify actual WASM scene revision after successful transaction; don't invent it. */
  confirmCommittedRevision(oldRevision: string): Promise<string | null>
  /** Projection only; never send actual model file, document paths or materials. */
  readSceneEntities(): Promise<Array<{ id: string; name: string; kind: string }>>
  /**
   * Optional: store one binary result (snapshot PNG, export, saved .hew) in
   * the owner's private storage with the verified user's own client. Without
   * it, binary results are dropped from the job result and reported as such.
   */
  uploadArtifact?(bytes: Uint8Array, mime: string, ext: string, jobId: string): Promise<StoredArtifact>
}
export type QueueOutcome =
  | { state: 'idle' }
  | { state: 'rejected'; code: string }
  | { state: 'unknown'; code: string; job_id?: string }
  | { state: 'failed'; code: string; job_id: string }
  | { state: 'succeeded'; job_id: string; revision: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
// Explicit consent is a fixed 30 minutes. Heartbeats never renew this deadline.
const MAX_CONSENT_MS = 30 * 60_000
const MAX_RPC_CHARS = 8192
// A `call` job's stored result (JSON) may be up to this size; larger
// results are uploaded as a JSON artifact instead.
const MAX_CALL_RESULT_CHARS = 200_000
const LARGE_SVG_CHARS = 32_768
const validRevision = (s: unknown): s is string =>
  typeof s === 'string' && s.length > 0 && s.length <= 128
const validDoc = (d: DocumentIdentity | null): d is DocumentIdentity =>
  !!d && UUID.test(d.document_id) && validRevision(d.revision)
const object = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x)
const err = (code: string): QueueOutcome => ({ state: 'rejected', code })
const limit = (v: unknown, max = MAX_RPC_CHARS) => {
  try { return JSON.stringify(v).length <= max } catch { return false }
}
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
function decodeBase64(s: string): Uint8Array | null {
  if (s.length % 4 !== 0 || !BASE64.test(s)) return null
  try {
    const bin = atob(s)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch { return null }
}
/**
 * Moves binary/oversized parts of a kernel result into private storage and
 * returns the JSON that is safe to store in the job row.
 */
async function storeCallResult(env: ModelJobEnvironment, jobId: string, reply: unknown): Promise<unknown> {
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) {
    if (limit(reply, MAX_CALL_RESULT_CHARS)) return reply
    reply = { value: reply }
  }
  const out: Record<string, unknown> = { ...(reply as Record<string, unknown>) }
  const artifacts: Record<string, StoredArtifact | { dropped: string }> = {}
  for (const [key, kind] of Object.entries(ARTIFACT_FIELDS)) {
    const v = out[key]
    if (typeof v !== 'string') continue
    delete out[key]
    const bytes = decodeBase64(v)
    if (!bytes) { artifacts[key] = { dropped: 'NOT_BASE64' }; continue }
    const type = key === 'bytes_base64' ? bytesFormatType(out.format) : kind
    if (!env.uploadArtifact) { artifacts[key] = { dropped: 'NO_PRIVATE_STORAGE' }; continue }
    artifacts[key] = await env.uploadArtifact(bytes, type.mime, type.ext, jobId)
  }
  if (typeof out.svg === 'string' && out.svg.length > LARGE_SVG_CHARS) {
    const svg = out.svg
    delete out.svg
    artifacts.svg = env.uploadArtifact
      // oxlint-disable-next-line lingui/no-unlocalized-strings -- MIME type, not UI text
      ? await env.uploadArtifact(new TextEncoder().encode(svg), 'image/svg+xml', 'svg', jobId)
      : { dropped: 'NO_PRIVATE_STORAGE' }
  }
  if (Object.keys(artifacts).length) out.artifacts = artifacts
  if (limit(out, MAX_CALL_RESULT_CHARS)) return out
  if (!env.uploadArtifact) return { truncated: true, artifacts: out.artifacts ?? null }
  const full = await env.uploadArtifact(
    new TextEncoder().encode(JSON.stringify(out)), 'application/json', 'json', jobId)
  return { truncated: true, result_artifact: full }
}
async function query(db: ModelJobRpc, name: string, params: Record<string, unknown>,
  max = MAX_RPC_CHARS) {
  // Only these functions may be called, never untrusted job-supplied methods.
  const permitted = [
    'lizhi_model_begin', 'lizhi_model_heartbeat', 'lizhi_model_claim',
    'lizhi_model_finish', 'lizhi_model_finish_v2', 'lizhi_model_publish_scene',
    'lizhi_model_close',
  ]
  if (!permitted.includes(name)) throw Error('UNAUTHORIZED_RPC')
  if (!limit(params, max)) throw Error('MODEL_RPC_TOO_LARGE')
  const {data,error} = await db.rpc(name,params)
  if (error || !limit(data)) throw Error('MODEL_RPC_FAILED')
  return data
}

export function createLizhiModelQueue(env: ModelJobEnvironment) {
  let lease: { session_id: string; document_id: string; revision: string; deadline: number } | null = null
  let busy = false
  let halted = false
  const received = new Set<string>()
  // Any unknown mutation halts future claims until explicit revoke/re-authorize.
  const uncertain=(code:string,job_id?:string):QueueOutcome=>{
    halted=true
    return {state:'unknown',code,job_id}
  }

  function validLease(): boolean {
    const d=env.getDocument()
    return !halted && !!lease && env.pageVisible() && env.now() < lease.deadline &&
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
      const requestedAt=env.now()
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
        revision:before.revision,deadline:requestedAt+MAX_CONSENT_MS}
      return true
    } catch { return false }
    finally {busy=false}
  }

  async function revoke(): Promise<boolean> {
    const prev=lease
    lease=null
    halted=false
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
          !['create_box','move','call'].includes(claim.command as string) ||
          !object(claim.params) ||
          claim.session_id !== before.session_id ||
          claim.document_id !== before.document_id ||
          claim.expected_revision !== before.revision ||
          received.has(claim.request_id as string)) {
        // Claimed jobs cannot be automatically replayed. A bad claim is
        // reported as unknown for manual inspection; never run its command.
        return uncertain('MODEL_INVALID_CLAIM_DO_NOT_RETRY',
          object(claim) && typeof claim.job_id==='string' ? claim.job_id : undefined)
      }
      const jobId=claim.job_id as string
      received.add(claim.request_id as string)
      if (!validLease())return uncertain('MODEL_CONSENT_LOST_AFTER_CLAIM',jobId)
      const job: ClaimedModelJob={
        request_id:claim.request_id as string,session_id:before.session_id,
        document_id:before.document_id,expected_revision:before.revision,
        action:claim.command as 'create_box'|'move'|'call',params:claim.params,
      }
      const receipt=env.host.execute(job)
      if (job.action==='call') return await finishCall(before,jobId,receipt)
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
        return uncertain(receipt.code??'MODEL_RESULT_UNKNOWN_DO_NOT_RETRY',jobId)
      }
      // Revision is read from actual Hew scene/application; the bridge cannot
      // claim success merely because a JSON-RPC reply said "result".
      const committed=await env.confirmCommittedRevision(before.revision)
      if (!validRevision(committed) || committed===before.revision)
        return uncertain('MODEL_REVISION_NOT_VERIFIED_DO_NOT_RETRY',jobId)
      const current=env.getDocument()
      if (!current || current.document_id!==before.document_id ||
          current.revision!==committed || !env.pageVisible() ||
          env.now()>=before.deadline)
        return uncertain('MODEL_DOCUMENT_CHANGED_AFTER_COMMIT_DO_NOT_RETRY',jobId)
      const finished=await query(env.rpc,'lizhi_model_finish',{
        p_session:before.session_id,p_job:jobId,p_success:true,
        p_new_revision:committed,p_result:{kernel_transaction_committed:true},p_error:null,
      })
      if (finished!==true)
        return uncertain('MODEL_FINISH_ACK_UNKNOWN_DO_NOT_RETRY',jobId)
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
      return uncertain('MODEL_RPC_RESULT_UNKNOWN_DO_NOT_RETRY')
    } finally {busy=false}
  }
  /**
   * Finishes a generic Hew API `call` job. Read-only and view calls finish
   * at the same revision; mutating calls must show a new verified revision.
   * Kernel refusals are reported back with the kernel's error object so the
   * AI can correct its params.
   */
  async function finishCall(
    before:{session_id:string;document_id:string;revision:string;deadline:number},
    jobId:string, receipt:LocalModelReceipt,
  ):Promise<QueueOutcome> {
    const finish=(success:boolean,mutated:boolean,revision:string,result:unknown,error:string|null)=>
      query(env.rpc,'lizhi_model_finish_v2',{
        p_session:before.session_id,p_job:jobId,p_success:success,p_mutated:mutated,
        p_new_revision:revision,p_result:result??null,p_error:error,
      },MAX_CALL_RESULT_CHARS+4096)
    if (receipt.status==='rejected') {
      const detail=limit(receipt.reply,MAX_CALL_RESULT_CHARS)?receipt.reply:null
      if (await finish(false,false,before.revision,detail,receipt.code??'MODEL_ENGINE_REJECTED')===true)
        return {state:'failed',code:receipt.code??'MODEL_ENGINE_REJECTED',job_id:jobId}
      return uncertain(receipt.code??'MODEL_RESULT_UNKNOWN_DO_NOT_RETRY',jobId)
    }
    if (receipt.status!=='succeeded')
      return uncertain(receipt.code??'MODEL_RESULT_UNKNOWN_DO_NOT_RETRY',jobId)
    const mutated=receipt.mutated===true
    let revision=before.revision
    if (mutated) {
      const committed=await env.confirmCommittedRevision(before.revision)
      if (!validRevision(committed) || committed===before.revision)
        return uncertain('MODEL_REVISION_NOT_VERIFIED_DO_NOT_RETRY',jobId)
      revision=committed
    }
    const current=env.getDocument()
    if (!current || current.document_id!==before.document_id ||
        current.revision!==revision || !env.pageVisible() || env.now()>=before.deadline)
      return uncertain('MODEL_DOCUMENT_CHANGED_AFTER_COMMIT_DO_NOT_RETRY',jobId)
    let stored:unknown
    try {
      stored=await storeCallResult(env,jobId,receipt.reply)
    } catch {
      // The kernel already committed; only the result upload failed.
      stored={kernel_transaction_committed:true,artifacts_failed:true}
    }
    // Uploads can take a while: refresh the session before the ACK.
    const alive=await query(env.rpc,'lizhi_model_heartbeat',{
      p_session:before.session_id,p_document:before.document_id,p_revision:before.revision,
    })
    if (alive!==true) return uncertain('MODEL_SESSION_LOST_BEFORE_ACK_DO_NOT_RETRY',jobId)
    if (await finish(true,mutated,revision,stored,null)!==true)
      return uncertain('MODEL_FINISH_ACK_UNKNOWN_DO_NOT_RETRY',jobId)
    if (mutated) {
      lease={...before,revision}
      try {
        const entities=await env.readSceneEntities()
        if (Array.isArray(entities) && entities.length<=100 && limit(entities)) {
          await query(env.rpc,'lizhi_model_publish_scene',{
            p_session:before.session_id,p_document:before.document_id,
            p_revision:revision,p_entities:entities,
          })
        }
      } catch { /* committed; scene snapshot not published */ }
    }
    return {state:'succeeded',job_id:jobId,revision}
  }
  return {authorizeFromUserClick,pollOne,revoke,
    isAuthorized:()=>validLease(),
    getLease:()=>validLease()?{session_id:lease!.session_id,document_id:lease!.document_id,
      revision:lease!.revision,consent_expires_at_ms:lease!.deadline}:null}
}
