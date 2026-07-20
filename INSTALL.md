# VTuber（中控 + 前端）安裝說明

這個資料夾包含 AI VTuber 的兩個服務：

| 子資料夾 | 服務 | Port | 技術 |
|----------|------|------|------|
| `main/` | 中控 API（轉接 TTS、管理前端播放佇列） | 8080 | Python 3.12 + FastAPI |
| `web/` | Live2D 前端（錄音、播放、嘴型同步） | 5173 (HTTPS) | Node.js + Vite |

`vtuber_env/` 是 main 用的共用 Python 虛擬環境（web 是純 Node 專案，用不到它）。

## 架構

```
瀏覽器(web:5173) ──/api proxy──► main(:8080)
外部系統 ──POST /post 文字──────────────────► tts(:9999)  CosyVoice
```

main 不含 LLM，只做轉接與佇列：`/post` 收到文字後呼叫 TTS 合成，放進播放佇列；
前端每秒輪詢 `/dequeue-audio` 取走音訊，驅動 Live2D 唸出來。
（`main/model_config.json` 是先前 LLM 版本的遺留設定檔，目前用不到；內含 api_key，已在 .gitignore。）

---

# 一、main（中控 API）

## 系統需求

| 項目 | 需求 |
|------|------|
| Python | 3.12 |
| 相依服務 | TTS（:9999）——只測佇列端點時可不啟動 |

## 需要安裝的套件（見 [requirements.txt](requirements.txt)）

`vtuber/requirements.txt` 是指向 `main/requirements.txt` 的 symlink——本機安裝與 Docker build
（`main/Dockerfile` 會 `COPY requirements.txt`）共用同一份，不用重複維護。

| 套件 | 用途 |
|------|------|
| `fastapi` / `uvicorn` / `python-multipart` | API 服務 |
| `httpx` | 非同步呼叫 TTS |
| `pydantic` | 資料模型 |

## 安裝步驟

```bash
cd vtuber

# 1. 建立共用虛擬環境（已存在可跳過）
uv venv vtuber_env --seed --python=3.12

# 2. 啟用並安裝套件
source vtuber_env/bin/activate
uv pip install -r requirements.txt
```

## 啟動

```bash
cd vtuber
source vtuber_env/bin/activate
cd main
uvicorn main:app --host 0.0.0.0 --port 8080
```

## 環境變數（選用）

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `TTS_API_URL` | `http://localhost:9999/tts/zero_shot` | TTS 服務位址 |

## API 端點

| 端點 | 方法 | 說明 |
|------|------|------|
| `/post` | POST | `{"text": "..."}` → 呼叫 TTS 合成語音並排入播放佇列，前端人物會唸出來 |
| `/tts` | POST | `{"text": "..."}` → 直接回傳 wav 音訊（不進佇列） |
| `/queue-audio` | POST | 直接注入 wav 音訊到播放佇列（測試用，不需 TTS） |
| `/dequeue-audio` | GET | 前端輪詢取出佇列音訊；佇列為空回 204 |

## 驗證（在 vtuber/ 目錄下執行）

```bash
# 不依賴 TTS 的基本驗證：注入音訊 → 取回
curl -X POST http://localhost:8080/queue-audio -F "file=@../tts/zero_shot_0.wav"
curl -s http://localhost:8080/dequeue-audio -o out.wav && file out.wav

# 傳文字給人物唸（需 TTS 已啟動；開著前端網頁即會播放）
curl -X POST http://localhost:8080/post \
  -H "Content-Type: application/json" \
  -d '{"text": "你好，我是麗臺科技的 AI VTuber"}'

# 純文字進、語音出（需 TTS 已啟動）
curl -X POST http://localhost:8080/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "你好，請自我介紹"}' -o reply.wav
```

---

# 二、web（Live2D 前端）

## 系統需求

| 項目 | 需求 |
|------|------|
| Node.js | 20 以上 |
| npm | 隨 Node.js 附帶 |

> 前端是純 Node.js 專案，**不需要 Python 虛擬環境，也沒有 requirements.txt**——套件安裝與版本鎖定
> 全部由 [web/package.json](web/package.json) 與 `package-lock.json` 管理。
> 資料夾裡若有 `web_env/`（Python venv），它與前端服務無關，activate 與否都不影響 `npm run dev`。

## npm 套件（見 [web/package.json](web/package.json)）

| 套件 | 用途 |
|------|------|
| `pixi.js@^6.5.10` | 2D 渲染引擎 |
| `pixi-live2d-display@^0.4.0` | Live2D 模型載入與驅動 |
| `vite@^4.5.0` | 開發伺服器與打包工具（dev） |
| `@vitejs/plugin-basic-ssl@^2.3.0` | 自簽 HTTPS 憑證（dev） |

## 靜態資源（已包含在 web/ 內）

- `public/models/hiyori_free` → 符號連結到 `hiyori_zh-Hans/hiyori_free/runtime`（Live2D 模型）
- `public/live2dcubismcore.min.js` — Cubism Core 執行庫
- `public/LR_logo_blue.svg` — Logo

## 安裝步驟

```bash
cd vtuber/web

# 1. 安裝所有 npm 套件
#    注意：一定要加 --legacy-peer-deps！
#    因為 @vitejs/plugin-basic-ssl@2.3.0 官方宣告需要 vite 6+，
#    本專案用 vite 4（兩者實際可共存），直接 npm install 會報 ERESOLVE 錯誤。
npm install --legacy-peer-deps

# 2. 啟動開發伺服器（HTTPS）
npm run dev
```

瀏覽器開啟 `https://localhost:5173`（自簽憑證，第一次要按「進階 → 繼續前往」）。
區網其他裝置（如手機）用 `https://<本機IP>:5173`。

> **注意**：前端所有 API 走相對路徑 `/api`，由 Vite proxy 轉發到 main 中控服務
> （預設 `http://localhost:8080`，可用環境變數 `VITE_PROXY_TARGET` 覆寫）。

---

# 啟動順序

1. `tts`（:9999）
2. `main`（:8080）
3. `web`（:5173）

只測 `/queue-audio`、`/dequeue-audio` 或前端畫面時，可以只起 main + web，不需要 GPU 服務。
