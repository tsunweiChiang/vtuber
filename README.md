# VTuber（中控 + 前端）

AI VTuber 的中控 API 與 Live2D 前端，負責串接 ASR / TTS 服務並驅動角色播放語音。

## 資料夾結構

| 子資料夾 | 服務 | Port | 技術 |
|----------|------|------|------|
| [main/](main/) | 中控 API（轉接 ASR / TTS、管理前端播放佇列） | 8080 | Python 3.12 + FastAPI |
| [web/](web/) | Live2D 前端（錄音、播放、嘴型同步） | 5173 (HTTPS) | Node.js + Vite |
| `vtuber_env/` | `main/` 用的共用 Python 虛擬環境（`web/` 用不到） | - | - |

## 架構

```
瀏覽器(web:5173) ──/api proxy──► main(:8080) ──► asr(:8000)  Whisper
                                       │
外部系統 ──POST /post 文字─────────────┴─────► tts(:9999)  CosyVoice
```

## 快速啟動

```bash
# Terminal 1 — main
cd vtuber && source vtuber_env/bin/activate && cd main
uvicorn main:app --host 0.0.0.0 --port 8080

# Terminal 2 — web
cd vtuber/web && npm run dev
```

瀏覽器開啟 `https://localhost:5173`。

完整安裝步驟、環境變數、API 端點與驗證方式請見 [INSTALL.md](INSTALL.md)。
