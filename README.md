# InkBloom

面向自媒体创作者的 AIGC 图文创作工具。

## 技术栈

- **前端**: React + TypeScript + Vite + TipTap
- **后端**: Go + Gin + gRPC
- **AI 服务**: Python + FastAPI
- **数据库**: PostgreSQL 16
- **缓存**: Redis 7
- **消息队列**: NATS JetStream
- **容器化**: Docker Compose

## 项目结构

```
inkbloom/
├── packages/
│   ├── web/           # 前端
│   ├── server/        # Go 主服务
│   ├── ai-service/    # Python AI 服务
│   └── shared/        # 共享 Protobuf 定义
├── docker-compose.yml
├── Makefile
└── README.md
```

## 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/your-username/inkbloom.git
cd inkbloom
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 填写必要配置
```

### 3. 启动基础设施

```bash
make up
# 或
docker compose up -d
```

这会启动 PostgreSQL、Redis 和 NATS。

### 4. 启动开发服务

```bash
# Go 服务
make dev-server

# 前端
make dev-web

# AI 服务
make dev-ai
```

### 5. 数据库迁移

```bash
make migrate-up
```

## 常用命令

```bash
make up          # 启动 Docker 服务
make down        # 停止 Docker 服务
make logs        # 查看日志
make build       # 构建所有服务
make test        # 运行测试
make clean       # 清理构建产物
```

## 开发环境要求

- Node.js >= 18
- pnpm >= 9
- Go >= 1.22
- Python >= 3.12
- Docker & Docker Compose
