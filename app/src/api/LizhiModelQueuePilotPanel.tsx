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
  async function close(){
    const queue=queueRef.current
    queueRef.current=null
    setActive(false)
    if(queue)await queue.revoke()
  }
  useEffect(()=>{
    const onLeave=()=>{ void close() }
    window.addEventListener('pagehide',onLeave)
    const onHide=()=>{
      if(document.visibilityState!=='visible'){
        void close()
        setStatus('背景分頁：授權已撤銷')
      }
    }
    document.addEventListener('visibilitychange',onHide)
    return ()=>{
      window.removeEventListener('pagehide',onLeave)
      document.removeEventListener('visibilitychange',onHide)
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
        pageVisible:()=>document.visibilityState==='visible',
        now:()=>Date.now(),uuid:()=>crypto.randomUUID(),
        confirmCommittedRevision:async(previous)=>{
          // Wait for the authoritative Hew App's revision after viewport refresh.
          // Never fabricate a new revision to force a successful database ACK.
          for(let i=0;i<12;i++){
            const current=latest.current.getDocument()
            if(current&&current.revision!==previous)return current.revision
            await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()))
          }
          return null
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
      setStatus('已授權 120 秒，僅能主動領取一次；離開本頁自動關閉')
    }catch {setStatus('認證或授權失敗；不執行任何 3D 命令')}
    finally {setBusy(false)}
  }
  async function poll(){
    if(busy||!queueRef.current)return
    setBusy(true)
    try {
      const answer=await queueRef.current.pollOne()
      setStatus(answer.state==='succeeded'?
        'Hew 幾何交易完成並確認 DB ACK；尚未存檔 .hew':
        answer.state==='idle'?'目前沒有待處理的模型工作':
        answer.state==='unknown'?'結果不明，已停止後續領取；請人工檢查模型':
        answer.state==='failed'?'Hew 明確拒絕：'+answer.code:
        '已停止：'+answer.code)
      if(!queueRef.current.isAuthorized()) {
        void close()
      }
    }catch{setStatus('結果不明，禁止自動重試');void close()}
    finally{setBusy(false)}
  }
  return <aside aria-label="Lizhi model authenticated queue pilot" style={{
    position:'absolute',bottom:18,right:328,zIndex:501,
    background:'var(--surface-overlay,#222)',color:'var(--text-primary,#fff)',
    border:'1px solid #777',borderRadius:10,width:300,padding:12,display:'grid',gap:8,
  }}>
    <strong>立之 3D｜ChatGPT 工作授權</strong>
    <small>必須使用雲端庫同源本人登入；一次授權 120 秒，工作只手動領取。不保證 .hew 已儲存。</small>
    <button type="button" onClick={()=>{void approve()}} disabled={active||busy}>本人授權 120 秒</button>
    <button type="button" onClick={()=>{void poll()}} disabled={!active||busy}>領取並處理一筆工作</button>
    <button type="button" onClick={()=>{void close()}} disabled={!active||busy}>撤銷 3D 操作權限</button>
    <small role="status">{status}</small>
  </aside>
}
