/* =============================================================================
  main.js — AI VTuber 主控邏輯
  職責：
    - 初始化 PIXI + Live2D 模型並管理視窗縮放
    - 提供麥克風錄音（MediaRecorder），錄音結束後：
        POST /asr 取得辨識文字 → POST /post 讓後端合成 TTS 並排入播放佇列
    - 每秒輪詢 /dequeue-audio 取出佇列音訊（來源：/post 或外部系統），
      播放並同步驅動 Live2D 嘴型張合
  CORS 解法：所有 API 呼叫使用相對路徑 "/api"，由 Vite proxy 轉發至後端
             8080 port，避免瀏覽器的跨來源安全限制。
============================================================================= */

import "./style.css";
import * as PIXI from "pixi.js";
import { Live2DModel } from "pixi-live2d-display/cubism4";

/* pixi-live2d-display 內部需要透過全域 window.PIXI 取用 PIXI 的渲染管線，
   若不手動掛載，Live2DModel 在建立 ticker/renderer 時會找不到正確實例。 */
window.PIXI = PIXI;

/* CORS Proxy 入口。
   前端一律使用相對路徑 "/api"，Vite dev server 會依 vite.config.js
   的 proxy 規則將請求轉發至 http://localhost:8080，
   從而繞過瀏覽器的同源政策並避免後端需要處理 SSL。 */
const MAIN_API_URL = "/api";

/* ── DOM 參考 ─────────────────────────────────────────────────────────────── */
const canvas = document.getElementById("live2d-canvas");  // Live2D 渲染目標
const recordBtn = document.getElementById("record-btn");  // 錄音切換按鈕

/* 畫面上已無狀態列，狀態一律輸出到 console 供除錯。 */
function setStatus(text) {
  console.log(`[status] ${text}`);
}

/* ── 應用程式狀態 ─────────────────────────────────────────────────────────── */
let app = null;           // PIXI.Application 實例
let model = null;         // Live2DModel 實例
let currentAudio = null;  // 當前正在播放的 Audio 物件（用來中斷前一段音訊）

/* AudioContext 在頁面載入時就建立（建立本身不受 Autoplay Policy 限制，
   只是可能停在 "suspended" 狀態）。每輪播放前都會嘗試 resume()：
   - 若瀏覽器允許自動播放（例如以 --autoplay-policy=no-user-gesture-required
     啟動 Chrome，或 Firefox 對此網站設定「允許音訊」），resume 立即成功，
     開頁即可出聲，無需任何點擊。
   - 若瀏覽器不允許，resume 會保持 suspended，音訊留在後端佇列，
     等使用者在頁面上點擊一次解鎖後的下一輪再播（後備方案）。 */
const audioContext = new AudioContext();

function ensureAudioContext() {
  if (audioContext.state === "suspended") {
    audioContext.resume();
  }
}

/* 後備：瀏覽器不允許自動播放時，頁面上任何一次點擊都能解鎖 AudioContext。 */
document.addEventListener("click", ensureAudioContext);

/* 載入後立即嘗試解鎖一次（在允許自動播放的環境會直接成功）。 */
ensureAudioContext();

/* ── 錄音相關狀態 ─────────────────────────────────────────────────────────── */
let mediaRecorder = null;  // MediaRecorder 實例
let audioChunks = [];      // 累積錄音資料片段的陣列
let isRecording = false;   // 目前是否正在錄音

/* ============================================================================
   人物顯示設定 — 想調整人物大小 / 位置改這裡
   依視窗方向自動套用：高 > 寬 → portrait（直向），否則 landscape（橫向）

   landscape（橫向，維持原本畫面）：
     - scale  ：固定縮放倍率
     - yRatio ：人物「中心點」的垂直位置（0.85 = 偏下，只露出上半身）

   portrait（直向螢幕）：
     - heightRatio ：人物高度佔畫面高度的比例
                     0.95 ≈ 全身入鏡；改 1.3、1.5 會放大變半身特寫
     - yRatio      ：人物中心點的垂直位置（0.5 = 正中央，數字越大越往下）
============================================================================ */
const DISPLAY = {
  landscape: { scale: 0.35, yRatio: 0.85 },
  portrait:  { heightRatio: 0.95, yRatio: 0.5 },
};

/* ============================================================================
   initPixi — 初始化 PIXI 渲染器並載入 Live2D 模型
   副作用：建立全域 app、model；監聽 window resize 事件。
============================================================================ */
async function initPixi() {
  try {
    app = new PIXI.Application({
      view: canvas,
      resizeTo: document.getElementById("vtuber-panel"),
      backgroundAlpha: 0,
      antialias: true
    });

    setStatus("載入模型中...");

    model = await Live2DModel.from("/models/hiyori_free/hiyori_free_t08.model3.json");

    app.stage.addChild(model);
    model.anchor.set(0.5, 0.5);

    resizeModel();
    window.addEventListener("resize", resizeModel);

    setStatus("Live2D 模型載入完成");
  } catch (err) {
    console.error(err);
    setStatus(`模型載入失敗：${err.message}`);
  }
}

/* ============================================================================
   resizeModel — 根據目前視窗尺寸重新縮放、定位 Live2D 模型
   直向螢幕：以畫面高度為基準自動計算縮放，讓人物完整入鏡
   橫向螢幕：維持原本的固定縮放與偏下構圖
   （參數見上方 DISPLAY 設定區塊）
============================================================================ */
function resizeModel() {
  if (!model) return;

  const panel = document.getElementById("vtuber-panel");
  const w = panel.clientWidth;
  const h = panel.clientHeight;
  const isPortrait = h > w;

  if (isPortrait) {
    const cfg = DISPLAY.portrait;
    /* 模型未縮放前的原始高度（originalHeight 由 pixi-live2d-display 提供，
       萬一取不到就用「目前高度 ÷ 目前縮放」推回原始值） */
    const origH = model.internalModel?.originalHeight || model.height / model.scale.y;
    model.scale.set((h * cfg.heightRatio) / origH);
    model.y = h * cfg.yRatio;
  } else {
    const cfg = DISPLAY.landscape;
    model.scale.set(cfg.scale);
    model.y = h * cfg.yRatio;
  }

  model.x = w / 2;
}

/* ============================================================================
   setMouthOpen — 設定 Live2D 嘴型張開程度
============================================================================ */
function setMouthOpen(value) {
  if (!model) return;
  const mouthValue = Math.max(0, Math.min(value, 1));
  model.internalModel.coreModel.setParameterValueById("ParamMouthOpenY", mouthValue);
}

/* ============================================================================
   resetMouth — 將嘴型重設為閉嘴狀態
============================================================================ */
function resetMouth() {
  setMouthOpen(0);
}

/* ============================================================================
   playAudioWithMouth — 播放 TTS 音訊並同步驅動 Live2D 嘴型
============================================================================ */
async function playAudioWithMouth(audioUrl) {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }

  const audio = new Audio(audioUrl);
  currentAudio = audio;

  await audioContext.resume();

  const source = audioContext.createMediaElementSource(audio);
  const analyser = audioContext.createAnalyser();

  source.connect(analyser);
  analyser.connect(audioContext.destination);

  analyser.fftSize = 256;
  const dataArray = new Uint8Array(analyser.fftSize);
  let isPlaying = true;

  const motionManager = model?.internalModel?.motionManager;
  const originalStartMotion = motionManager?.startMotion?.bind(motionManager);

  if (motionManager) {
    motionManager.stopAllMotions();
    motionManager.startMotion = async () => undefined;
  }

  audio.onended = () => {
    isPlaying = false;
    resetMouth();
    setStatus("播放完成");
    if (motionManager && originalStartMotion) {
      motionManager.startMotion = originalStartMotion;
    }
  };

  function updateMouth() {
    if (!isPlaying) return;
    analyser.getByteTimeDomainData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const v = (dataArray[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / dataArray.length);
    setMouthOpen(Math.min(rms * 8, 1.0));
    requestAnimationFrame(updateMouth);
  }

  setStatus("播放 TTS 中");
  await audio.play();
  updateMouth();
}

/* ============================================================================
   sendAudioBlob — 麥克風錄音送出流程：
     Step 1. POST /asr  → 取得辨識文字
     Step 2. POST /post → 後端合成 TTS 並排入佇列，
             由 pollQueuedAudio 取走播放（人物唸出辨識到的文字）
============================================================================ */
async function sendAudioBlob(blob, filename = "recording.webm") {
  const formData = new FormData();
  formData.append("file", blob, filename);

  try {
    // ── Step 1: ASR ────────────────────────────────────────────────────────
    setStatus("辨識語音中...");

    const asrRes = await fetch(`${MAIN_API_URL}/asr`, {
      method: "POST",
      body: formData
    });

    if (!asrRes.ok) throw new Error(`ASR 錯誤 HTTP ${asrRes.status}`);

    const { text: userText } = await asrRes.json();
    setStatus(`辨識結果：${userText}`);

    if (!userText || !userText.trim()) {
      setStatus("未辨識到有效文字");
      return;
    }

    // ── Step 2: /post → TTS → 播放佇列 ────────────────────────────────────
    setStatus("合成語音中...");

    const postRes = await fetch(`${MAIN_API_URL}/post`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: userText })
    });

    if (!postRes.ok) throw new Error(`/post 錯誤 HTTP ${postRes.status}`);

  } catch (error) {
    console.error(error);
    setStatus(`錯誤：${error.message}`);
  }
}

/* ============================================================================
   startRecording — 開始麥克風錄音
============================================================================ */
async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];

    const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) audioChunks.push(event.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(audioChunks, { type: mimeType || "audio/webm" });
      await sendAudioBlob(blob);
    };

    mediaRecorder.start();
    isRecording = true;
    recordBtn.classList.add("recording");
    setStatus("錄音中...");

  } catch (error) {
    console.error(error);
    setStatus(`麥克風錯誤：${error.message}`);
  }
}

/* ============================================================================
   stopRecording — 停止錄音並觸發音訊送出流程
============================================================================ */
function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  isRecording = false;
  recordBtn.classList.remove("recording");
}

/* ── 錄音按鈕事件監聽 ─────────────────────────────────────────────────────── */
recordBtn.addEventListener("click", () => {
  ensureAudioContext();
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
});

/* ============================================================================
   pollQueuedAudio — 輪詢後端播放佇列。
   佇列中的音訊是 TTS 成品（來自 /post 或 /queue-audio），
   取到後直接播放並驅動嘴型。
============================================================================ */
let isPolling = false;

async function pollQueuedAudio() {
  if (isPolling) return;

  /* 每輪都嘗試解鎖；瀏覽器允許自動播放時 resume 會直接成功。
     仍處於 suspended（未解鎖）時先不取件，音訊留在後端佇列，
     等解鎖後的下一輪再播，避免取走卻播不出聲。 */
  try {
    await audioContext.resume();
  } catch (_) { /* resume 失敗視同未解鎖 */ }
  if (audioContext.state !== "running") return;

  isPolling = true;
  try {
    const res = await fetch(`${MAIN_API_URL}/dequeue-audio`);
    if (res.status === 200) {
      const blob = await res.blob();
      const audioUrl = URL.createObjectURL(blob);
      await playAudioWithMouth(audioUrl);
    }
  } catch (_) {
    // 後端不可達時靜默忽略
  } finally {
    isPolling = false;
  }
}

window.addEventListener("load", () => {
  setInterval(pollQueuedAudio, 1000);
});

initPixi();
