# 立之 3D｜Hew 自有 Fork 與瀏覽器建模執行核心

**Fork:** `lihuany635-create/lizhi-hew`  
**Upstream:** `hew3d/hew` @ `f7734a5dfa262c03822d0eae918206705223e6b3`  
**Branch:** `feature/lizhi-model-browser-host-v1`  
**Workstation:** 立之雲端庫製作工作台 `f1dd7512-ce86-4268-b7cb-b4edd11ce8d7`

## 已做（限程式與隔離測試）

- 原始碼 Fork 已由 GitHub 驗證，保留 Hew 原始 AGPL-3.0-only/LICENSE 和 Plugin API Exception；不修改 `main`。
- `app/src/api/lizhiModelBrowserHost.ts` 直接使用 **Hew 自身** WebAssembly `Scene.api_connection_open/api_dispatch/api_connection_close`，不重寫幾何引擎。
- 僅接受 `create_box`、`move`、`query_scene`；將受限的長方體轉為 Hew 官方 atomic `hew.doc.transact`，不允許任意 JSON-RPC、scripts、檔案路徑、刪除。
- 執行前要求 local consent lease 未到期、session/document/revision 都正確；逐筆 request_id 防同一頁面重覆執行。引擎回應不明返回 `MODEL_RESULT_UNKNOWN_DO_NOT_RETRY`。
- 交易成功只代表 WASM 幾何 commit，**不是 .hew 永久存檔**。任何正式端到端成功判斷還需要 DB claim/finish 與 durable save ACK。
- 網頁端這個模組 **尚未被 App.tsx 啟動**；不建立 MessageEvent 或外部接口，故目前不會接受 ChatGPT 的遠端指令。
- 專用 Vitest 測試驗證：本機授權、跨專案隔離、修訂版本、幾何限制、原生 RPC、同 request_id 去重、錯誤不重送、讀取不變更。

## 與現有立之 CAD 的關係

現有 CAD Site v3 與 `lizhi-cad-site-mcp` 保持原樣。3D 模組建立在自己的 Hew Fork 和 3D 專用 Site/Edge/job 後端上。先前 `lizhi-cloud-web` Draft PR #12 已有 `model_*` 六工具合約與 Site adapter，10/10 Node 隔離 CI PASS。

保留官方 Hew Web 發佈特性：root-relative resources 只能直接從網站根路徑載入；若整合立之雲端庫，先採用獨立 origin 或修改並重測 Vite asset base 路徑，不可直接嵌在 `/hew/` 後便稱正常。涉及分發／網路服務的修改需遵守 AGPL-3.0-only 與官方 Plugin API Exception。

## 真正接通前缺少的工作

1. **M1 Web kernel 真實 E2E**：單獨編譯／啟動 Hew Web；把受控 Host 綁定 App 的同一個 Scene，UI 必須提供明確的本機允許、到期與關閉操作；不得從跨網域 message 偽造 session。
2. **M2**：3D 專屬 owner/session/document/revision/lease 的 PostgreSQL queue 與 RLS、service-only RPC，隔離 CI 驗證 request-id idempotency；現有工作台及正式 Supabase 不先改。
3. **M3**：獨立 `lizhi-model-site-mcp` Edge 與私人 Site，伺服器身分核實及 server-only Secret，ChatGPT 六工具載入。
4. **M4**：在本人已授權網頁執行一個 1200×600×750 mm 模型；先查 job `succeeded`、再讀 scene 與 `.hew` 重新開啟，最後確認 Undo/版本隔離。
5. **M5**：受限 move/edit、SKP/GLB 匯出、版本與實際 durable save-ack。

**截至此文件版本，沒有實際部署網站、沒有啟動本機 consent，不存在 ChatGPT → Hew 的生產操作能力。**

文件為可接續的開發交接，不是模型生成成功聲明。
