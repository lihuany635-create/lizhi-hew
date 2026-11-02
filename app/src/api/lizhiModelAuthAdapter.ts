/**
 * Optional first-party Supabase Auth adapter for the Lizhi Hew browser queue.
 *
 * The authenticated client MUST come from a trusted same-origin app session.
 * Never transfer access tokens through query strings, postMessage or Site tools.
 * Uses auth.getUser() (server-verifying) rather than trusting local getSession().
 * SQL-RPC auth.uid() and RLS remain the authoritative authorization boundary.
 * This is an adapter, not a login UI or deployed site.
 */
import type {ModelJobRpc} from './lizhiModelQueue'

interface UserIdentity { id: string; email?: string | null }
export interface UserAuthenticatedSupabaseClient {
  auth: { getUser(): Promise<{ data: {user: UserIdentity | null} | null; error: unknown }> }
  rpc(name: string, args: Record<string, unknown>):
    Promise<{ data: unknown; error: unknown }>
  /** Supabase Storage, used only to store a job's binary results privately. */
  storage?: {
    from(bucket: string): {
      upload(path: string, body: Blob, options: { contentType: string; upsert: boolean }):
        Promise<{ data: unknown; error: unknown }>
    }
  }
}
export interface ModelAuthOptions {
  ownerUid: string
  /** Optional secondary check; SQL owner_uid is always authoritative. */
  ownerEmail?: string
}

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const allowed=new Set([
  'lizhi_model_begin','lizhi_model_heartbeat','lizhi_model_claim',
  'lizhi_model_finish','lizhi_model_finish_v2','lizhi_model_publish_scene','lizhi_model_close',
])

/** Owner-private bucket for snapshots, exports and saved model files. */
export const MODEL_FILES_BUCKET='lizhi-model-files'
const EXT=/^[a-z0-9]+(\.[a-z0-9]+)?$/

/**
 * Uploads one job result file as the verified owner, under `<uid>/<job>/`.
 * Storage RLS (owner folder only) is the authority; this never uses a
 * service key and never makes the object public.
 */
export function createLizhiModelArtifactUploader(
  client: UserAuthenticatedSupabaseClient, ownerUid: string,
  verifyAuthenticatedOwner: () => Promise<boolean>, uuid: () => string,
) {
  return async(bytes:Uint8Array,mime:string,ext:string,jobId:string)=>{
    if(!client.storage)throw Error('MODEL_STORAGE_UNAVAILABLE')
    if(!UUID.test(ownerUid)||!UUID.test(jobId)||!EXT.test(ext))throw Error('MODEL_ARTIFACT_INVALID')
    if(bytes.byteLength===0||bytes.byteLength>48*1024*1024)throw Error('MODEL_ARTIFACT_SIZE')
    if(!await verifyAuthenticatedOwner())throw Error('MODEL_OWNER_AUTH_REQUIRED')
    const path=`${ownerUid}/${jobId}/${uuid()}.${ext}`
    const copy=new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    const {error}=await client.storage.from(MODEL_FILES_BUCKET)
      .upload(path,new Blob([copy.buffer],{type:mime}),{contentType:mime,upsert:false})
    if(error)throw Error('MODEL_ARTIFACT_UPLOAD_FAILED')
    return {bucket:MODEL_FILES_BUCKET,path,mime,bytes:bytes.byteLength}
  }
}

export function createLizhiModelAuthAdapter(
  client: UserAuthenticatedSupabaseClient, options: ModelAuthOptions,
): {verifyAuthenticatedOwner: () => Promise<boolean>; rpc: ModelJobRpc} {
  async function verifyAuthenticatedOwner() {
    if(!UUID.test(options.ownerUid))return false
    try {
      const {data,error}=await client.auth.getUser()
      const user=data?.user
      if(error || !user || user.id !== options.ownerUid)return false
      if(options.ownerEmail &&
         (user.email??'').trim().toLowerCase()!==options.ownerEmail.trim().toLowerCase())return false
      return true
    } catch {return false}
  }
  const rpc:ModelJobRpc={
    rpc:async(name,params)=>{
      if(!allowed.has(name))return {data:null,error:'MODEL_RPC_NOT_ALLOWED'}
      if(!await verifyAuthenticatedOwner())return {data:null,error:'MODEL_OWNER_AUTH_REQUIRED'}
      // Only the owner's verified JWT-bearing client, never Edge service_role.
      try {
        return await client.rpc(name,params)
      } catch {
        return {data:null,error:'MODEL_RPC_RESULT_UNKNOWN_DO_NOT_RETRY'}
      }
    },
  }
  return {verifyAuthenticatedOwner,rpc}
}
