# 立之 3D｜M4 完整 Hew API（瀏覽器 host）

## 做了什麼

ChatGPT 除了原本的建方塊、移動之外，現在可以透過一個通用 `call` 工作呼叫 Hew 的全部 API（105 個方法，見 `docs/API_REFERENCE.gen.md`）：畫圖、推拉、偏移、路徑跟隨、布林、剖切、群組、元件、材質、標籤、參考線、場景、屬性、復原、截圖、匯出、存檔等。

## 安全規則（`app/src/api/lizhiModelPolicy.ts`）

- `hew.meta.hello`、`hew.doc.attach`、`hew.doc.focus` 由 host 自己處理，工作不能送。
- 會刪資料或換掉目前文件的方法（刪除、開新檔、開檔、關閉、還原、匯入、清除未用、炸開群組／元件等）必須帶 `confirmed: true`；交易（`hew.doc.transact`）裡面的每個指令一樣檢查。
- 瀏覽器沒有檔案系統：任何 `path` / `*_path` 參數都拒絕；`hew.doc.save` 一律改成 `return_bytes: true`。
- 單獨指令（存檔、匯出、截圖、相機、復原等）不能放進交易。
- 其餘由 Hew 核心自己驗證 schema 與權限。

## 結果處理（`lizhiModelQueue.ts`）

- 唯讀與視角類指令：在**同一個 revision** 完成（`p_mutated=false`），不會取消排隊中的其他工作。
- 會改模型的指令：必須看到新的 revision 才 ACK，之後重新發布場景摘要。
- 截圖 PNG、深度圖、PDF、匯出檔、存檔的 base64 會用本人登入的 Supabase client 上傳到私人 bucket `lizhi-model-files/<uid>/<job_id>/`，工作結果只存檔案位置。
- 結果 JSON 超過 200 KB 時整份上傳成 JSON 檔。
- 核心拒絕時，把核心的錯誤物件一起寫回，讓 ChatGPT 能修正參數。
- 結果不明（unknown）一律停止接收、不重試，與原本相同。

## 需要伺服器端配合

需要 lizhi-cloud-web 的 `hew/sql/003_model_full_api.sql`（`call` 指令、`lizhi_model_finish_v2`、私人 bucket 與 RLS）和更新後的 Site / Edge 工具合約。未套用 SQL 前，`call` 工作在資料庫端就會被拒絕，原本的建方塊／移動不受影響。

## 測試

`pnpm --dir app exec vitest run src/api/lizhiModel` — 原有測試加新的 policy 與 call 測試全部通過。
