/**
 * The production Hew editor may borrow the existing Lizhi Cloud Supabase
 * session ONLY when embedded on the exact same origin.
 *
 * Cross-origin iframe postMessage, URL tokens, bearer forwarding, and a
 * standalone production window's arbitrary LizhiAuth global are forbidden.
 * SQL owner checks and auth.getUser() remain the final authorization gates.
 */
import type { UserAuthenticatedSupabaseClient } from './lizhiModelAuthAdapter'

export interface LizhiModelAuthHost {
  client: UserAuthenticatedSupabaseClient
  allowedEmail?: string
}
type AuthWindow = Window & { LizhiAuth?: LizhiModelAuthHost }

function validHost(auth: LizhiModelAuthHost | undefined): auth is LizhiModelAuthHost {
  return !!auth &&
    typeof auth.allowedEmail === 'string' &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(auth.allowedEmail) &&
    typeof auth.client?.auth?.getUser === 'function' &&
    typeof auth.client?.rpc === 'function'
}

/** Browser same-origin enforcement throws on a cross-origin parent. Fail closed. */
export function sameOriginParentLizhiAuth(win: Window): LizhiModelAuthHost | null {
  try {
    if (win.parent === win ||
        win.parent.location.origin !== win.location.origin) return null
    const host = (win.parent as AuthWindow).LizhiAuth
    return validHost(host) ? host : null
  } catch {
    return null
  }
}

/** Strict dev-only standalone injection for the existing isolated E2E tests. */
export function devStandaloneLizhiAuth(win: Window): LizhiModelAuthHost | null {
  if (!import.meta.env.DEV) return null
  const host = (win as AuthWindow).LizhiAuth
  return validHost(host) ? host : null
}

/** Only a same-origin iframe with an authenticated host can show PROD controls. */
export function canMountProductionModelQueue(win: Window): boolean {
  return sameOriginParentLizhiAuth(win) !== null
}
