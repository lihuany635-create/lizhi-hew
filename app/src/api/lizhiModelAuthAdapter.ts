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
}
export interface ModelAuthOptions {
  ownerUid: string
  /** Optional secondary check; SQL owner_uid is always authoritative. */
  ownerEmail?: string
}

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const allowed=new Set([
  'lizhi_model_begin','lizhi_model_heartbeat','lizhi_model_claim',
  'lizhi_model_finish','lizhi_model_publish_scene','lizhi_model_close',
])

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
