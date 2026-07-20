# main（中控 Agent）只做 API 轉接與 LLM 呼叫，不需要 GPU
FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir uv

COPY requirements.txt /app/
RUN uv pip install --system -r requirements.txt

COPY main.py model_config.json /app/

EXPOSE 8080

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
