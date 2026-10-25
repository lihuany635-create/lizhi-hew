import {expect,test} from '@playwright/test'

test('M3 browser queue: mocked verified Supabase Auth/RPC -> actual Hew WASM solid -> commit ACK',async({page})=>{
  await page.addInitScript(()=>{
    type User={id:string;email:string}
    type Trace={name:string;params:Record<string,unknown>}
    const owner:User={
      id:'11111111-1111-4111-8111-111111111111',
      email:'owner@example.test',
    }
    const jobId='44444444-4444-4444-8444-444444444444'
    const requestId='33333333-3333-4333-8333-333333333333'
    let currentSession='',documentId='',initialRev='',alreadyClaimed=false
    const trace:Trace[]=[]
    const mock={
      auth:{getUser:async()=>({data:{user:owner},error:null})},
      rpc:async(name:string,params:Record<string,unknown>)=>{
        trace.push({name,params})
        let data:unknown=null
        if(name==='lizhi_model_begin'){
          currentSession=String(params.p_session)
          documentId=String(params.p_document)
          initialRev=String(params.p_revision)
          data=true
        }else if(name==='lizhi_model_heartbeat'){
          data=String(params.p_session)===currentSession
        }else if(name==='lizhi_model_claim'){
          if(!alreadyClaimed){
            alreadyClaimed=true
            data={
              job_id:jobId,request_id:requestId,
              session_id:currentSession,document_id:documentId,
              expected_revision:initialRev,command:'create_box',
              params:{origin_m:[0,0,0],size_m:[1.2,0.6,0.75],name:'AI Desk'}
            }
          }
        }else if(name==='lizhi_model_finish')data=true
        else if(name==='lizhi_model_publish_scene')data=true
        else if(name==='lizhi_model_close')data=true
        else return {data:null,error:{message:'UNKNOWN_MOCK_RPC'}}
        return {data,error:null}
      },
    }
    Object.assign(window,{
      LizhiAuth:{client:mock,allowedEmail:owner.email},
      __lizhiM3Trace:trace,
    })
  })
  await page.goto('/?lizhi-model-queue-pilot=1')
  await expect.poll(()=>page.evaluate(()=>{
    const h=(window as Window & {__hew_test?:{isReady:()=>boolean}}).__hew_test
    return h?.isReady()??false
  })).toBe(true)
  const panel=page.getByRole('complementary',{name:'Lizhi model authenticated queue pilot'})
  await expect(panel).toBeVisible()
  await panel.getByRole('button',{name:'本人授權 120 秒'}).click()
  await expect(panel.getByRole('status')).toContainText('已授權 120 秒')
  await panel.getByRole('button',{name:'領取並處理一筆工作'}).click()
  await expect(panel.getByRole('status')).toContainText('Hew 幾何交易完成')
  const scene=await page.evaluate(()=>{
    const h=(window as Window & {__hew_test?:{
      getObjectIds():string[]
      getObjectCount():number
      getObjectBounds(id:string):number[]
      isObjectSolid(id:string):boolean
    }}).__hew_test!
    const id=h.getObjectIds()[0]
    return {count:h.getObjectCount(),solid:h.isObjectSolid(id),bounds:h.getObjectBounds(id)}
  })
  expect(scene.count).toBe(1)
  expect(scene.solid).toBe(true)
  for(const [i,v] of [0,0,0,1.2,0.6,0.75].entries())
    expect(scene.bounds[i]).toBeCloseTo(v,4)
  const trace=await page.evaluate(()=>(window as Window & {
    __lizhiM3Trace?:{name:string;params:Record<string,unknown>}[]
  }).__lizhiM3Trace??[])
  expect(trace.map(x=>x.name).slice(0,4)).toEqual([
    'lizhi_model_begin','lizhi_model_heartbeat','lizhi_model_claim','lizhi_model_finish',
  ])
  const ack=trace.find(x=>x.name==='lizhi_model_finish')
  expect(ack?.params.p_success).toBe(true)
  expect(typeof ack?.params.p_new_revision).toBe('string')
  expect(ack?.params.p_new_revision).not.toBe(trace[0]?.params.p_revision)
  expect(trace.filter(x=>x.name==='lizhi_model_claim')).toHaveLength(1)
  const snapshot=trace.find(x=>x.name==='lizhi_model_publish_scene')
  expect(snapshot).toBeDefined()
  expect(Array.isArray(snapshot?.params.p_entities)).toBe(true)
  const entities=snapshot?.params.p_entities as Array<{id:string;name:string;kind:string}>
  expect(entities.some(x=>x.id.startsWith('obj_')&&x.kind==='object')).toBe(true)
})
