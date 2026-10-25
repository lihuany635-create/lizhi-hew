/** Production BUNDLE smoke, NOT real Supabase: same-origin iframe + mock owner RPC
 * + real Hew WASM kernel. Run only after vite build --base=./ has completed.
 */
import {chromium,expect} from '@playwright/test'
const ORIGIN='http://127.0.0.1:4187'
const browser=await chromium.launch({headless:process.env.LIZHI_HEADFUL!=='1',args:[
  '--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader'
]})
try {
  const ctx=await browser.newContext()
  const page=await ctx.newPage()
  const wasmOk=[]
  page.on('response',r=>{if(r.url().includes('.wasm')&&r.ok())wasmOk.push(r.url())})
  await page.goto(ORIGIN+'/',{waitUntil:'domcontentloaded'})
  const frame=page.frameLocator('#hew-frame')
  await frame.getByRole('button',{name:'連線 AI（30 分鐘）'}).waitFor({timeout:25000})
  await frame.getByRole('button',{name:'連線 AI（30 分鐘）'}).click()
  await frame.getByRole('button',{name:'斷開 AI 連線'}).waitFor({timeout:10000})
  if(await frame.getByRole('button',{name:'領取並處理一筆工作'}).count()!==0)
    throw Error('Unexpected second manual queue button')
  // Deterministic regression for Chrome's background-tab RAF starvation:
  // Playwright contexts report every page as visible even in headed Xvfb.
  // Override the SAME-ORIGIN Hew iframe's visibility to hidden, suppress RAF,
  // then ensure the model job still commits + ACKs without an animation frame.
  const paused=await page.evaluate(()=>{
    const node=document.querySelector('#hew-frame')
    const child=node?.contentWindow
    if(!child)throw Error('Missing same-origin Hew editor iframe')
    child.requestAnimationFrame=()=>0
    Object.defineProperty(child.document,'visibilityState',{
      configurable:true,get:()=> 'hidden'
    })
    child.document.dispatchEvent(new child.Event('visibilitychange'))
    return child.document.visibilityState==='hidden' &&
      child.requestAnimationFrame(()=>{})===0
  })
  if(!paused)throw Error('Simulated hidden iframe / stalled RAF guard failed')
  const other=await ctx.newPage()
  await other.goto(ORIGIN+'/hew-editor/?lizhi-model-queue=1',{waitUntil:'domcontentloaded'})
  await other.bringToFront()
  const hidden=paused
  await expect(frame.getByRole('status')).toContainText('Hew 幾何交易完成',{timeout:25000})
  const trace=await page.evaluate(()=>window.__lizhiEmbedTrace)
  const calls=trace.map(x=>x.name)
  for(const required of ['lizhi_model_begin','lizhi_model_heartbeat','lizhi_model_claim','lizhi_model_finish'])
    if(!calls.includes(required))throw Error('Missing RPC '+required)
  const ack=trace.find(x=>x.name==='lizhi_model_finish')
  if(ack.params.p_success!==true||!ack.params.p_new_revision||
    ack.params.p_new_revision===trace[0].params.p_revision)throw Error('Unverified model revision ACK')
  if(calls.filter(x=>x==='lizhi_model_claim').length!==1)throw Error('Claim duplicated')
  if(!wasmOk.length)throw Error('No native Hew WASM response was loaded')
  if(await other.getByRole('button',{name:'連線 AI（30 分鐘）'}).count()!==0)
    throw Error('Standalone production window improperly exposed queue')
  console.log('LIZHI_HEW_SAME_ORIGIN_PRODUCTION_BUNDLE_CHROMIUM_PASS',JSON.stringify({
    wasmLoaded:wasmOk.length>0,rpcs:calls,standaloneDenied:true,backgroundHiddenSimulated:hidden,rafBlocked:true,
  }))
}finally {await browser.close()}
