import {describe,it,expect,vi} from 'vitest'
import {sameOriginParentLizhiAuth,canMountProductionModelQueue} from './lizhiModelSameOriginAuth'
const email='owner@example.test'
function mockHost() {
  return {allowedEmail:email,client:{
    auth:{getUser:vi.fn(async()=>({data:{user:{id:'11111111-1111-4111-8111-111111111111',email}},error:null}))},
    rpc:vi.fn(async()=>({data:null,error:null})),
  }}
}
const win=(origin:string,parent:unknown):Window=>({location:{origin},get parent(){return parent}} as unknown as Window)
describe('Hew production same-origin Lizhi Cloud auth bridge',()=>{
  it('allows only a same-origin parent with a well formed client',()=>{
    const parent={location:{origin:'https://lihuany635-create.github.io'},LizhiAuth:mockHost()}
    const child=win(parent.location.origin,parent)
    expect(sameOriginParentLizhiAuth(child)).toBe(parent.LizhiAuth)
    expect(canMountProductionModelQueue(child)).toBe(true)
  })
  it('rejects a standalone top-level window even if it forged LizhiAuth',()=>{
    const top={location:{origin:'https://lihuany635-create.github.io'},LizhiAuth:mockHost()}
    Object.defineProperty(top,'parent',{value:top})
    expect(sameOriginParentLizhiAuth(top as unknown as Window)).toBeNull()
  })
  it('rejects a different origin and does not use its LizhiAuth',()=>{
    const parent={location:{origin:'https://attacker.example'},LizhiAuth:mockHost()}
    expect(sameOriginParentLizhiAuth(win('https://lihuany635-create.github.io',parent))).toBeNull()
  })
  it('rejects an actual cross-origin getter security exception',()=>{
    const parent={get location(){throw new DOMException('SecurityError','SecurityError')},LizhiAuth:mockHost()}
    expect(sameOriginParentLizhiAuth(win('https://site.example',parent))).toBeNull()
  })
  it('rejects missing/malformed parent auth or email',()=>{
    const origin='https://same.example'
    const parent={location:{origin},LizhiAuth:{...mockHost(),allowedEmail:'not-an-email'}}
    expect(sameOriginParentLizhiAuth(win(origin,parent))).toBeNull()
    delete (parent as {LizhiAuth?:unknown}).LizhiAuth
    expect(sameOriginParentLizhiAuth(win(origin,parent))).toBeNull()
  })
})