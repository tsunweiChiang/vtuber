/* =============================================================================
  vite.config.js — Vite 開發伺服器設定
  職責：
    1. 啟用 HTTPS（basicSsl）— 麥克風 API 要求安全來源
    2. 設定 CORS Proxy（/api → localhost:8080）— 解決混合內容問題
    3. 允許存取上層目錄（fs.allow）— 讓 Vite 能服務 ../web-env 外的靜態資源
    4. 保留符號連結（preserveSymlinks）— 支援 npm link 或單體倉庫的模組解析
============================================================================= */

import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

export default defineConfig({
  plugins: [
    /* basicSsl()：為 Vite dev server 自動產生並套用自簽 TLS 憑證，
       使開發伺服器以 HTTPS 提供服務。
       必要原因：瀏覽器的 MediaDevices.getUserMedia()（麥克風存取）
       與 AudioContext 只允許在「安全來源（Secure Context）」下運作，
       即 https:// 或 localhost。當從區網其他裝置（如手機）連線測試時，
       localhost 不再成立，HTTPS 是唯一可行方案。 */
    basicSsl()
  ],
  server: {
    host: "0.0.0.0",  /* 監聽所有網路介面，允許區網內其他裝置連線 */
    port: 5173,
    https: true,       /* 配合 basicSsl() 啟用 HTTPS 模式 */
    fs: {
      /* 允許 Vite 服務相對路徑 ".." 以上層目錄的靜態檔案。
         Live2D 模型資源（/models/...）存放在 web-env 外層目錄，
         若不設定此項，Vite 會拒絕存取並回傳 403 Forbidden。 */
      allow: [".."]
    },
    proxy: {
      /* CORS Proxy 規則：所有以 "/api" 開頭的請求轉發至後端。
         解決的問題：
           - 前端（https://host:5173）向後端（http://host:8080）發送請求
             會觸發「Mixed Content」錯誤（HTTPS 頁面不允許呼叫 HTTP API）。
           - 若後端也啟用 SSL，需要管理憑證，增加部署複雜度。
           - 改用 Vite proxy 讓前端只和自己的 HTTPS 伺服器通訊，
             由 Vite 在伺服器端（Node.js）以 HTTP 轉發至後端，
             繞過瀏覽器的混合內容限制，後端無需任何 SSL 設定。
         rewrite：去除路徑前綴 "/api"，使 /api/voice-chat 轉發至 /voice-chat。
         changeOrigin：修改請求的 Host header 為 target，
                       避免後端因 Host 不符而拒絕請求。 */
      "/api": {
        /* 後端 FastAPI 服務位址。
           本機開發預設 localhost:8080；
           Docker Compose 下由 VITE_PROXY_TARGET 環境變數指向 main 服務。 */
        target: process.env.VITE_PROXY_TARGET || "http://localhost:8080",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, "")  /* 移除 /api 前綴 */
      }
    }
  },
  resolve: {
    /* 保留模組解析時的符號連結（symlink）真實路徑。
       若使用 npm link 或 pnpm workspace 的連結套件，
       Vite 預設會解析符號連結的真實路徑（realpath），
       可能導致 HMR（熱模組替換）無法正確追蹤模組變更。
       設為 true 可保留連結語意，確保模組身份一致。 */
    preserveSymlinks: true
  }
});
