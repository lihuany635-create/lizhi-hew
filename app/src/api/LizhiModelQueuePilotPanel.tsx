/**
 * Explicit-click model queue panel. Production MUST run under an embedded
 * same-origin authenticated Lizhi Cloud parent; standalone production cannot
 * provide a spoofable window.LizhiAuth object. The existing DEV-only mock
 * remains solely for isolated Chromium tests. No JWT forwarding/postMessage.
 */
import {useEffect,useRef,useState} from 'react'
import {createLizhiModelHost,type ModelSceneDispatcher} from './lizhiModelBrowserHost'
import {createLizhiModelQueue,type DocumentIdentity} from './lizhiModelQueue'
import {createLizhiModelAuthAdapter} from './lizhiModelAuthAdapter'
import {sameOriginParentLizhiAuth,devStandaloneLizhiAuth} from './lizhiModelSameOriginAuth'

export interface LizhiModelQueuePilotProps {
  getScene():ModelSceneDispatcher|null
  getDocument():DocumentIdentity|null
  refreshScene():void
}
export function LizhiModelQueuePilotPanel(props:LizhiModelQueuePilotProps) {
  const [status,setStatus]=useState('尚未啟用；只支援同源的立之雲端庫本人登入')
  const [active,setActive]=useState(false)
  const [busy,setBusy]=useState(false)
  const latest=useRef(props)
  latest.current=props
  const queueRef=useRef<ReturnType<typeof createLizhiModelQueue>|null>(null)
  const pollTimer=useRef<ReturnType<typeof setInterval>|null>(null)
  const polling=useRef(false)
  const stopTimer=()=>{
    if(pollTimer.current!==null)clearInterval(pollTimer.current)
    pollTimer.current=null
  }
  async function close(){
    stopTimer()
    const queue=queueRef.current
    queueRef.current=null
    setActive(false)
    if(queue)await queue.revoke()
  }
  useEffect(()=>{
    const onLeave=()=>{ void close() }
    window.addEventListener('pagehide',onLeave)
    // Switching between ChatGPT and Hew tabs MUST NOT revoke consent.
    // Closing/navigating the actual Hew document always revokes the session.
    return ()=>{
      window.removeEventListener('pagehide',onLeave)
      stopTimer()
      if(queueRef.current)void queueRef.current.revoke()
      queueRef.current=null
    }
  },[])

  async function approve(){
    if(busy||queueRef.current)return
    setBusy(true)
    try {
      const session=sameOriginParentLizhiAuth(window)??devStandaloneLizhiAuth(window)
      if(!session?.client?.auth?.getUser||!session.client.rpc) {
        setStatus('缺少同源驗證登入；不可使用跨來源傳送 Token')
        return
      }
      if(typeof session.allowedEmail!=='string' || !session.allowedEmail.includes('@')) {
        setStatus('未配置可核對的帳號白名單；禁止授權')
        return
      }
      const {data,error}=await session.client.auth.getUser()
      if(error||!data?.user?.id){setStatus('尚未通過 Supabase 本人驗證');return}
      const adapter=createLizhiModelAuthAdapter(session.client,{
        ownerUid:data.user.id,ownerEmail:session.allowedEmail,
      })
      if(!await adapter.verifyAuthenticatedOwner()) {
        setStatus('使用者身份與允許名單不一致')
        return
      }
      // Only one same-page live Hew Scene may be operated.
      let queue:ReturnType<typeof createLizhiModelQueue>|null=null
      const host=createLizhiModelHost({
        getScene:()=>latest.current.getScene(),
        getLease:()=>queue?.getLease()??null,
        refreshScene:()=>latest.current.refreshScene(),
        now:()=>Date.now(),
      })
      queue=createLizhiModelQueue({
        rpc:adapter.rpc,host,
        verifyAuthenticatedOwner:adapter.verifyAuthenticatedOwner,
        getDocument:()=>latest.current.getDocument(),
        // A background tab remains authorized while OPEN, up to 30 minutes.
        // Server-side freshness checks still fail closed if the browser sleeps.
        pageVisible:()=>document.documentElement.isConnected && !window.closed,
        now:()=>Date.now(),uuid:()=>crypto.randomUUID(),
        confirmCommittedRevision:async(previous)=>{
          // App.refreshScene synchronously flushes the authoritative
          // document revision. RAF callbacks do not run in background tabs,
          // so never await requestAnimationFrame during a 30-minute session.
          const current=latest.current.getDocument()
          return current&&current.revision!==previous?current.revision:null
        },
        readSceneEntities:async()=>{
          // Query the SAME trusted WASM Scene after the committed revision ACK.
          // Send a strict projection (stable IDs, names, kinds), never geometry
          // blobs, file paths, materials or arbitrary JSON-RPC from the job.
          const lease=queue?.getLease()
          if(!lease)throw Error('SCENE_SNAPSHOT_CONSENT_REQUIRED')
          const reply=host.execute({
            request_id:crypto.randomUUID(),
            session_id:lease.session_id,document_id:lease.document_id,
            expected_revision:lease.revision,
            action:'query_scene',params:{},
          })
          if(reply.status!=='succeeded'||!reply.reply ||
              typeof reply.reply!=='object'||Array.isArray(reply.reply))
            throw Error('SCENE_QUERY_NOT_VERIFIED')
          const tree=(reply.reply as {tree?:unknown}).tree
          if(!Array.isArray(tree)||tree.length>100)
            throw Error('SCENE_PROJECTION_INVALID')
          return tree.map((item:unknown)=>{
            if(!item||typeof item!=='object'||Array.isArray(item))
              throw Error('SCENE_ENTITY_INVALID')
            const e=item as Record<string,unknown>
            if(typeof e.id!=='string'||!/^[a-z][a-z0-9_-]{0,79}$/i.test(e.id)||
                typeof e.name!=='string'||e.name.length>80||
                typeof e.kind!=='string'||e.kind.length>32)
              throw Error('SCENE_ENTITY_INVALID')
            return {id:e.id,name:e.name,kind:e.kind}
          })
        },
      })
      if(!await queue.authorizeFromUserClick()){
        setStatus('資料庫尚未部署或此帳號/模型未授權')
        return
      }
      queueRef.current=queue
      setActive(true)
      setStatus('已連線 30 分鐘｜等待 ChatGPT 指令（不需再按領取）')
      // Bounded read/claim loop, never an automatic consent renewal.
      // One job at a time; unknown results stop the loop without replay.
      pollTimer.current=setInterval(()=>{void processPending()},10_000)
      void processPending()
    }catch {setStatus('認證或授權失敗；不執行任何 3D 命令')}
    finally {setBusy(false)}
  }
  async function processPending(){
    const queue=queueRef.current
    if(!queue||polling.current)return
    polling.current=true
    try {
      const answer=await queue.pollOne()
      if(queue!==queueRef.current)return
      if(answer.state==='succeeded'){
        setStatus('Hew 幾何交易完成且已確認 ACK；模型尚未存檔 .hew')
      }else if(answer.state==='failed'){
        setStatus('模型工作被拒絕：'+answer.code+'；仍可接收下一筆')
      }else if(answer.state==='unknown'||answer.state==='rejected'){
        await close()
        setStatus(answer.state==='unknown'?
          '工作結果不明：已斷線、禁止重試；請檢查目前模型':
          '授權到期、登入失效或文件變更：已斷線')
      }
      // idle intentionally preserves the connection status.
    }catch{
      await close()
      setStatus('工作結果不明：已斷線、禁止自動重試')
    }finally{polling.current=false}
  }
  async function toggle(){
    if(busy)return
    if(queueRef.current){
      setBusy(true)
      await close()
      setBusy(false)
      setStatus('已手動斷開 AI 連線')
    }else{
      await approve()
    }
  }
  return <aside aria-label="Lizhi model authenticated queue pilot" style={{
    position:'absolute',bottom:18,right:328,zIndex:501,
    background:'var(--surface-overlay,#222)',color:'var(--text-primary,#fff)',
    border:'1px solid #777',borderRadius:10,width:300,padding:12,display:'grid',gap:8,
  }}>
    <strong>立之 3D｜ChatGPT 工作授權</strong>
    <small>按一次連線 30 分鐘，自動接收 ChatGPT 指令；同一按鈕可隨時斷線。關閉頁面或到期即停止，不會自動續期。</small>
    <button type="button" onClick={()=>{void toggle()}} disabled={busy}>
      {active?'斷開 AI 連線':'連線 AI（30 分鐘）'}
    </button>
    <small role="status">{status}</small>
  </aside>
}
