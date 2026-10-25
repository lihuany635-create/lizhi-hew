# M3｜立之 3D 模型 Browser Job Relay 接線交接（2026-10-25）

> 狀態：**獨立可測試候選元件**，尚未接入正式 Hew 使用者登入、沒有正式 Supabase migration、沒有 3D 私人 Site，禁止宣稱 ChatGPT 已可遠端繪圖。
>
> 工作台專案：`f1dd7512-ce86-4268-b7cb-b4edd11ce8d7`。
>
> 分支：`lihuany635-create/lizhi-hew@feature/lizhi-model-browser-host-v1`；主倉 `lihuany635-create/lizhi-cloud-web@feature/hew-3d-mcp-v1-20261025`。

## 本次新增原始碼

- `app/src/api/lizhiModelQueue.ts`：網頁端**不自動執行**的單筆工作領取器。輸入必須是同一個 Hew Scene 的 `getDocument()`、經使用者按鈕發起的 `authorizeFromUserClick()`、`verifyAuthenticatedOwner()`，以及採本人 JWT 的 Supabase `rpc()`。可按需 `pollOne()`、`revoke()`。限制 120 秒；背景分頁/換文件/版本衝突就拒絕。
- `app/src/api/lizhiModelAuthAdapter.ts`：使用既有一方 Supabase client 的 `auth.getUser()` 向 Auth 伺服器確認身分，限定 `ownerUid`，可選額外 email 比對。只開放六個 `lizhi_model_*` user-RPC；拒絕任意 RPC、shell、service_role token。程式**不接收裸 access token**、不負責跨網域登入、不使用跨框 `postMessage`。
- `app/src/api/lizhiModelQueue.test.ts`、`lizhiModelAuthAdapter.test.ts`：與既有 Hew 真實 WASM host 的隔離測試一起，在 GitHub Actions 執行 21 個安全測試。

## 精確呼叫順序

1. 使用者本人點擊允許，確認已登入的 Supabase 身分（不能只信 localStorage/session.user），取得同 Scene `document_id` UUID 與「真正的」`revision`。
2. 以 **authenticated JWT** 呼叫 `public.lizhi_model_begin(p_session,p_document,p_revision)`；成功後才打開頁面本地 120 秒 lease。必須顯示可撤銷的授權控制。
3. 每次使用者指定檢查或經明確同意的有限度排程呼叫 `pollOne()`，先確認頁面可見、登入有效、document/revision 未換，再呼叫 `heartbeat` + `claim`。
4. Claim 返回唯一 request/job、document/revision 與有限 `create_box` / `move`，由**相同已驗收的 Hew WebAssembly Scene** 的 `createLizhiModelHost().execute()` 交易；不使用抽象遠端 CAD 引擎。
5. 只有 Hew 成功、實際場景 `confirmCommittedRevision()` 讀到新版，才以 `finish(p_success:true,p_new_revision)` ACK；再最佳努力傳 `publish_scene` 摘要。成功不是 .hew 檔案已寫入磁碟。
6. 如果 ACK 遺失、WASM 結果不明、版本相衝，停止且絕對不自動重執行同 request；保留已領取 job 供人工核對。頁面隱藏/取消時呼叫 `close()`，在斷線下仍有 SQL 120 秒租約過期防護。

## 與 SQL / 私人 Site 的連接條件

- 使用 SQL 候選：`lizhi-cloud-web/hew/sql/001_model_queue.REVIEW_ONLY.sql`。已有獨立 PostgreSQL 16 安全測試 **PASS**，但是**尚未套用正式資料庫**。
- Edge 候選：`supabase/functions/lizhi-model-site-mcp/index.ts`、`edge-core.mjs`。之前已驗證私人 Site→Edge→模擬 SQL 的 Node 22/22 安全測試，以及 Deno 靜態檢查；**沒有實際 HTTP 上線與服務金鑰**。
- 使用者既有雲端庫登入程式為 `lizhi-cloud-web/auth.js` 的 `window.LizhiAuth.client`。它只對同一個 **origin** 內載入的頁面有效。Hew 另一網域/跨來源 iframe 不能直接讀取這個全域，也**禁止**用 URL query、任意 postMessage、Site MCP 或任意隱藏欄位傳 bearer token。正式接線必須決定 Hew 使用同源安全 host、或自己完成受審核的 Supabase OAuth 登入/Callback。
- 真正的 `getDocument().document_id` 必須跟隨同一份 Hew 原生編輯器文件，不能每次重新產生 UUID 造成上一張模型誤綁。真正 `confirmCommittedRevision` 須由場景/API 或 App 的權威文件計數讀取，不可自訂新版時間戳當作成功證明。
- `ModelJobEnvironment` 為依賴注入邊界；只有拿到實際 `auth.getUser()` 與同頁 Scene 之後才可 mount 顯示「啟用 AI 建模」按鈕；現行 DEV Pilot 仍是單機測試，不提供網路操作。

## 驗收狀態，嚴格區分

| 驗收範圍 | 狀態 |
|---|---|
| Hew Rust WASM + Chromium 手動授權建立 1200×600×750 mm 封閉實體 | PASS（既有 M1 CI） |
| PostgreSQL owner/doc/revision/idempotency 佇列 | PASS（既有 M2 isolated CI） |
| Private Site → Edge JS core → mock SQL 合約 | PASS（既有 M3 Node CI） |
| Browser Job Coordinator + Auth adapter mock RPC 安全測試 | 看本分支最新 CI；測試不代表有實際 Auth 登入 |
| 使用者真實登入 + 從 Supabase 領取工作 + Hew 建立 + 回報正式 SQL | NOT_TESTED |
| 一般 ChatGPT 載入 3D 私人 MCP 六工具 | NOT_TESTED |
| .hew 儲存／重新開啟與 CADCraft /工程中心入口整合 | NOT_TESTED |

**注意**：在 M3 完成全部實際授權／網路整合前，不要合併 main、不要開放任意編輯、不要將模型原始檔上傳雲端、也不要把隔離 CI 誤作正式已上線。

## M3 DEV UI：僅具同源 Auth 時可人工驗證

- `app/src/api/LizhiModelQueuePilotPanel.tsx`、`App.tsx`：加入 **DEV 模式且需 URL 參數 `lizhi-model-queue-pilot`** 才渲染的佇列驗證面板。只有此頁本身確實存在 `window.LizhiAuth.client` 且提供 `allowedEmail` 才能啟動；取得 Supabase `auth.getUser()`、比對帳號允許清單後再發出 begin。
- 按鈕要求本人明確同意 120 秒、手動領取一筆、隨時撤銷；分頁隱藏時撤銷；不會背景監聽、不會顯示或收集 bearer 字串。
- App 為當前文件生命週期建立每頁 UUID，`revision` 取自真實 Hew App `docGeneration:docRev`，並等待 viewport 更新後的修訂值才上報交易成功。**此 UUID 暫不跨重新載入儲存，不能當作正式模型檔案 ID**。
- 模型 scene summary 的實際投影讀取尚未實作；程式對 `readSceneEntities()` 明確 throw，避免偷偷發佈空物件清單而覆寫歷史。
- `app/e2e/lizhi-model-queue-auth-gate.spec.ts`：在沒有同源 Auth 的 Chromium 瀏覽器確認頁面拒絕操作。
- `app/e2e/lizhi-model-queue-mocked-rpc.spec.ts`：**模擬** same-origin Supabase Auth/RPC 回覆，但真正用 Chromium 的 Hew WASM 執行幾何建立並查驗封閉體、尺寸、1 次 claim 與真實 doc revision ACK。此測試是 mock DB，**不是正式 Supabase 網路端到端**。
- 完整 CI 的真 Rust/WASM build、上述兩項 Playwright 與先前單機 pilot 回歸，以最新隔離 Workflow 結果為準。不能因為已有測試原始碼就標記通過。

### 真正上線時必須替換的部分

1. DEV Gate 不能直接改成 production：要先決定 Hew 的 HTTPS 正式 origin、可用的 Supabase OAuth callback，並整合真正的本人 account allowlist。不同 origin 的`window.LizhiAuth` 不能假裝可直接取得；禁止從跨網站 iframe 傳 access token。
2. 將每頁 UUID 與受保存 .hew 文件 ID、原生 revision 關聯，補離線/換檔/Undo/Reload 驗收。
3. 把正式模型 scene 摘要（有限 id/name/kind）依同一 Scene 查詢後發送，完成 durable .hew save ACK。
4. 在正式 Supabase 部署隔離 SQL/Edge 並設定獨立 Server Secret；建立私人 Site MCP；最後在一般 ChatGPT 中完成 6 工具真實載入與 E2E。

