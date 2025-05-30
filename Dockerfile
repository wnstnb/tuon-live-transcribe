FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Ensure the .env file is created or use build ARGs/secrets for OPENAI_API_KEY in prod
# For local dev, Docker Compose with an env_file is often easier.

EXPOSE 8000

CMD ["uvicorn", "tuon_live_transcribe.main:app", "--host", "0.0.0.0", "--port", "8000"] 