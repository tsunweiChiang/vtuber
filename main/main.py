import os
import io
import httpx
from typing import Optional
from urllib.parse import quote
from pydantic import BaseModel
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import StreamingResponse, Response
from fastapi.middleware.cors import CORSMiddleware

# ==========================================
# 1. 配置已啟動的 ASR 與 TTS API 位址
#    預設連本機（各自啟動時），Docker Compose 下改用環境變數指到服務名稱
# ==========================================
ASR_API_URL = os.environ.get("ASR_API_URL", "http://localhost:8000/transcribe")
TTS_API_URL = os.environ.get("TTS_API_URL", "http://10.1.1.3:27116/tts/zero_shot")

# CosyVoice zero-shot 的參考語者 prompt
TTS_PROMPT = "You are a helpful assistant.<|endofprompt|>希望你以后能够做的比我还好呦。"

app = FastAPI(title="麗臺科技 AI VTuber 中控服務")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-User-Text", "X-Reply-Text"],
)

# 待播音訊佇列（單槽）：/post 產生的 TTS 音訊放在這裡，
# 前端每秒輪詢 /dequeue-audio 取走並驅動 Live2D 播放。
_queued_audio: Optional[bytes] = None


class TextInput(BaseModel):
    text: str


async def synthesize(text: str) -> bytes:
    """呼叫 TTS 服務，將文字合成為 wav 音訊 bytes。"""
    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            tts_response = await client.post(
                TTS_API_URL,
                json={"text": text, "prompt": TTS_PROMPT},
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"TTS 連線錯誤: {str(e)}")
    if tts_response.status_code != 200:
        raise HTTPException(status_code=500, detail="TTS 服務生成失敗")
    return tts_response.content


# ==========================================
# 2. 核心端點
# ==========================================

@app.post("/post")
async def post_text(body: TextInput):
    """接收文字 → 呼叫 TTS 合成語音 → 放入播放佇列，前端輪詢取走後由人物唸出。"""
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="文字不能為空")

    audio = await synthesize(text)

    global _queued_audio
    _queued_audio = audio
    print(f"[/post] 已合成並排入佇列: {text}")
    return {"ok": True, "text": text}


@app.post("/asr")
async def asr_only(file: UploadFile = File(...)):
    """僅執行 ASR，回傳辨識文字。"""
    audio_bytes = await file.read()
    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            asr_files = {"file": (file.filename, audio_bytes, file.content_type)}
            asr_response = await client.post(ASR_API_URL, files=asr_files)
            if asr_response.status_code != 200:
                raise HTTPException(status_code=500, detail="ASR 服務辨識失敗")
            user_text = asr_response.json().get("text", "")
            print(f"[ASR 辨識結果]: {user_text}")
            return {"text": user_text}
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"ASR 連線錯誤: {str(e)}")


@app.post("/tts")
async def tts_only(body: TextInput):
    """接收文字 → 呼叫 TTS → 直接回傳音訊（不進佇列），供外部系統取用。"""
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="文字不能為空")

    audio = await synthesize(text)
    return StreamingResponse(
        io.BytesIO(audio),
        media_type="audio/wav",
        headers={
            "Content-Disposition": "attachment; filename=response.wav",
            "X-Reply-Text": quote(text),
        },
    )


# ==========================================
# 3. 前端播放佇列
# ==========================================

@app.post("/queue-audio")
async def queue_audio(file: UploadFile = File(...)):
    """直接注入一段音訊到播放佇列（測試用）。"""
    global _queued_audio
    _queued_audio = await file.read()
    return {"ok": True}


@app.get("/dequeue-audio")
async def dequeue_audio():
    global _queued_audio
    if _queued_audio is None:
        return Response(status_code=204)
    audio = _queued_audio
    _queued_audio = None
    return StreamingResponse(io.BytesIO(audio), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
