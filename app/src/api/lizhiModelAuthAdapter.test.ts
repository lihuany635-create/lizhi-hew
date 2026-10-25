import {describe,it,expect,vi} from 'vitest'
import {createLizhiModelAuthAdapter, type UserAuthenticatedSupabaseClient} from './lizhiModelAuthAdapter'

const OWNER='11111111-1111-4111-8111-111111111111'
function fixture(){
 let uid=OWNER, email='owner@example.test',failAuth=false
 const rpc=vi.fn(async()=>({data:true,error:null}))
 const getUser=vi.fn(async()=>({
   data:{user:failAuth?null:{id:uid,email}},error:failAuth?{message:'unauthorized'}:null,
 }))
 const client:UserAuthenticatedSupabaseClient={auth:{getUser},rpc}
 return {adapter:createLizhiModelAuthAdapter(client,{ownerUid:OWNER,ownerEmail:'owner@example.test'}),
   rpc,getUser,setUid:(v:string)=>{uid=v},setEmail:(v:string)=>{email=v},
   setFailAuth:(v:boolean)=>{failAuth=v}}
}
describe('Verified Lizhi Supabase user client (no service token)',()=>{
 it('requires getUser() to verify owner UID AND email',async()=>{
  const f=fixture()
  expect(await f.adapter.verifyAuthenticatedOwner()).toBe(true)
  f.setUid('22222222-2222-4222-8222-222222222222')
  expect(await f.adapter.verifyAuthenticatedOwner()).toBe(false)
  f.setUid(OWNER);f.setEmail('unauthorized@example.test')
  expect(await f.adapter.verifyAuthenticatedOwner()).toBe(false)
  f.setEmail('owner@example.test');f.setFailAuth(true)
  expect(await f.adapter.verifyAuthenticatedOwner()).toBe(false)
 })
 it('refuses direct RPC calls from a no-longer-approved session',async()=>{
  const f=fixture();f.setFailAuth(true)
  const result=await f.adapter.rpc.rpc('lizhi_model_claim',{p_session:OWNER})
  expect(result.error).toBe('MODEL_OWNER_AUTH_REQUIRED')
  expect(f.rpc).not.toHaveBeenCalled()
 })
 it('limits API methods to six known 3D user-scope RPC functions',async()=>{
  const f=fixture()
  const bad=await f.adapter.rpc.rpc('lizhi_finance_delete_all',{})
  expect(bad.error).toBe('MODEL_RPC_NOT_ALLOWED')
  expect(f.getUser).not.toHaveBeenCalled()
  for(const name of ['lizhi_model_begin','lizhi_model_heartbeat','lizhi_model_claim',
   'lizhi_model_finish','lizhi_model_publish_scene','lizhi_model_close']){
   expect((await f.adapter.rpc.rpc(name,{})).error).toBeNull()
  }
  expect(f.rpc).toHaveBeenCalledTimes(6)
 })
 it('is fail-closed when authentication throws',async()=>{
  const client:UserAuthenticatedSupabaseClient={
   auth:{getUser:async()=>{throw Error('offline')}},
   rpc:async()=>({data:true,error:null}),
  }
  const adapter=createLizhiModelAuthAdapter(client,{ownerUid:OWNER})
  expect(await adapter.verifyAuthenticatedOwner()).toBe(false)
  expect((await adapter.rpc.rpc('lizhi_model_claim',{})).error).toBe('MODEL_OWNER_AUTH_REQUIRED')
 })
})
