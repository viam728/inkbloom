FROM python:3.12-slim

WORKDIR /app

# Install system dependencies for grpc
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

EXPOSE 8100 50051

CMD ["python", "-m", "app.main"]
