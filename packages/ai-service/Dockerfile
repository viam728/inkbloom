FROM python:3.12-slim

# PyPI 下载源可配置（默认清华镜像；海外/CI 可在 build 时用 --build-arg 覆盖为官方源）
ARG PIP_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple
ENV PIP_INDEX_URL=${PIP_INDEX}

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
