import {describe,it,expect,vi} from 'vitest'
import {createLizhiModelQueue, type DocumentIdentity, type ModelJobEnvironment} from './lizhiModelQueue'
import type {ClaimedModelJob, LocalModelReceipt} from './lizhiModelBrowserHost'

const SID='11111111-1111-4111-8111-111111111111'
const DOC='22222222-2222-4222-8222-222222222222'
const REQ='33333333-3333-4333-8333-333333333333'
const JOB='44444444-4444-4444-8444-444444444444'
const box={origin_m:[0,0,0],size_m:[1.2,0.6,0.75],name:'Desk'}
const claimed=()=>({job_id:JOB,request_id:REQ,session_id:SID,
  document_id:DOC,expected_revision:'r1',command:'create_box',params:box})
function fixture() {
  let auth=true
  let visible=true
  let now=1000
  let doc:DocumentIdentity|null={document_id:DOC,revision:'r1'}
  let nextJob:unknown=null
  let committed='r2'
  let failRpc=''
  const calls:{name:string;params:Record<string,unknown>}[]=[]
  const execute=vi.fn((job:ClaimedModelJob):LocalModelReceipt=>({
    status:'succeeded',reply:{object_id:'obj_1'},automaticRetryAllowed:false,
  }))
  const env:ModelJobEnvironment={
    rpc:{rpc:async(name,params)=>{
      calls.push({name,params})
      if(name===failRpc)throw Error('private service error')
      const data:Record<string,unknown>={
        lizhi_model_begin:true,lizhi_model_heartbeat:true,
        lizhi_model_claim:nextJob,lizhi_model_finish:true,
        lizhi_model_publish_scene:true,lizhi_model_close:true,
      }
      return {data:data[name],error:null}
    }},
    host:{execute},
    verifyAuthenticatedOwner:async()=>auth,
    getDocument:()=>doc,
    pageVisible:()=>visible,
    now:()=>now,
    uuid:()=>SID,
    confirmCommittedRevision:async()=>{
      if(committed)doc={document_id:DOC,revision:committed}
      return committed
    },
    readSceneEntities:async()=>[{id:'obj_1',name:'Desk',kind:'solid'}],
  }
  return {queue:createLizhiModelQueue(env),calls,execute,
    setAuth:(v:boolean)=>{auth=v},setVisible:(v:boolean)=>{visible=v},
    setNow:(v:number)=>{now=v},setDoc:(v:DocumentIdentity|null)=>{doc=v},
    setJob:(v:unknown)=>{nextJob=v},setCommitted:(v:string)=>{committed=v},
    setRpcFailure:(v:string)=>{failRpc=v},
  }
}
describe('M3 Lizhi model browser queue (isolated authenticated RPC mock)',()=>{
  it('requires a verified owner and explicit click before calling begin',async()=>{
    const f=fixture()
    expect((await f.queue.pollOne()).state).toBe('rejected')
    expect(f.calls).toHaveLength(0)
    f.setAuth(false)
    expect(await f.queue.authorizeFromUserClick()).toBe(false)
    expect(f.calls).toHaveLength(0)
    f.setAuth(true)
    expect(await f.queue.authorizeFromUserClick()).toBe(true)
    expect(f.queue.isAuthorized()).toBe(true)
    expect(f.queue.getLease()?.consent_expires_at_ms).toBe(121000)
    expect(f.calls.map(c=>c.name)).toEqual(['lizhi_model_begin'])
  })
  it('only polls one time when explicitly invoked; no timers or extra jobs',async()=>{
    const f=fixture();await f.queue.authorizeFromUserClick()
    expect(await f.queue.pollOne()).toEqual({state:'idle'})
    expect(f.calls.map(c=>c.name)).toEqual([
      'lizhi_model_begin','lizhi_model_heartbeat','lizhi_model_claim'
    ])
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('runs a confirmed geometry job once, updates revision, publishes limited scene and ACKs',async()=>{
    const f=fixture();expect(await f.queue.authorizeFromUserClick()).toBe(true)
    f.setJob(claimed())
    const outcome=await f.queue.pollOne()
    expect(outcome).toEqual({state:'succeeded',job_id:JOB,revision:'r2'})
    expect(f.execute).toHaveBeenCalledOnce()
    const arg=f.execute.mock.calls[0]?.[0] as ClaimedModelJob
    expect(arg.params).toEqual(box)
    expect(arg.expected_revision).toBe('r1')
    expect(f.queue.getLease()?.revision).toBe('r2')
    expect(f.calls.map(c=>c.name)).toEqual([
      'lizhi_model_begin','lizhi_model_heartbeat','lizhi_model_claim',
      'lizhi_model_finish','lizhi_model_publish_scene'
    ])
    expect(f.calls[3]?.params.p_success).toBe(true)
    expect(f.calls[3]?.params.p_new_revision).toBe('r2')
    expect(f.calls[4]?.params.p_entities).toEqual([{id:'obj_1',name:'Desk',kind:'solid'}])
    // Same request, even if the fake database returns it again, MUST NOT replay.
    const again=await f.queue.pollOne()
    expect(again.state).toBe('unknown')
    expect(f.execute).toHaveBeenCalledOnce()
  })
  it('refuses a job for a different document or stale revision',async()=>{
    const f=fixture();await f.queue.authorizeFromUserClick()
    f.setJob({...claimed(),document_id:'55555555-5555-4555-8555-555555555555'})
    expect((await f.queue.pollOne()).state).toBe('unknown')
    expect(f.execute).not.toHaveBeenCalled()
    const g=fixture();await g.queue.authorizeFromUserClick()
    g.setJob({...claimed(),expected_revision:'r0'})
    expect((await g.queue.pollOne()).state).toBe('unknown')
    expect(g.execute).not.toHaveBeenCalled()
  })
  it('rejects a hidden tab, changed current document or expired two-minute consent',async()=>{
    const f=fixture();await f.queue.authorizeFromUserClick()
    f.setVisible(false)
    expect((await f.queue.pollOne()).state).toBe('rejected')
    expect(f.queue.isAuthorized()).toBe(false)
    expect(f.calls.at(-1)?.name).toBe('lizhi_model_close')
    const g=fixture();await g.queue.authorizeFromUserClick()
    g.setDoc({document_id:DOC,revision:'r3'})
    expect((await g.queue.pollOne()).state).toBe('rejected')
    const h=fixture();await h.queue.authorizeFromUserClick()
    h.setNow(121000)
    expect((await h.queue.pollOne()).state).toBe('rejected')
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('does not ACK success when kernel result is unknown or document revision is unchanged',async()=>{
    const f=fixture();await f.queue.authorizeFromUserClick();f.setJob(claimed())
    f.execute.mockImplementationOnce(()=>({
      status:'unknown',code:'MODEL_RESULT_UNKNOWN_DO_NOT_RETRY',automaticRetryAllowed:false
    }))
    const out=await f.queue.pollOne()
    expect(out.state).toBe('unknown')
    expect(f.calls.some(c=>c.name==='lizhi_model_finish')).toBe(false)
    const g=fixture();await g.queue.authorizeFromUserClick();g.setJob(claimed())
    g.setCommitted('r1')
    expect((await g.queue.pollOne()).state).toBe('unknown')
    expect(g.calls.some(c=>c.name==='lizhi_model_finish')).toBe(false)
  })
  it('handles rejected kernel transaction without reporting success',async()=>{
    const f=fixture();await f.queue.authorizeFromUserClick();f.setJob(claimed())
    f.execute.mockImplementationOnce(()=>({
      status:'rejected',code:'HEW_KERNEL_REFUSED',automaticRetryAllowed:false
    }))
    const out=await f.queue.pollOne()
    expect(out).toEqual({state:'failed',code:'HEW_KERNEL_REFUSED',job_id:JOB})
    const finish=f.calls.find(c=>c.name==='lizhi_model_finish')
    expect(finish?.params.p_success).toBe(false)
  })
  it('does not replay after RPC finish ACK lost',async()=>{
    const f=fixture();await f.queue.authorizeFromUserClick();f.setJob(claimed())
    f.setRpcFailure('lizhi_model_finish')
    expect((await f.queue.pollOne()).state).toBe('unknown')
    expect((await f.queue.pollOne()).state).toBe('unknown')
    expect(f.execute).toHaveBeenCalledOnce()
  })
})
