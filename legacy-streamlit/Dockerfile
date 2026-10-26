FROM python:3.10-slim

WORKDIR /app

# 安裝依賴
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 複製程式碼
COPY . .

# 暴露 Streamlit 預設的 8501 埠號 (若跑 GCP Cloud Run, 預設為 8080，可以視需求更改)
EXPOSE 8080

# 執行指令
CMD ["streamlit", "run", "app.py", "--server.port=8080", "--server.address=0.0.0.0"]
