# Stage 1: Build
FROM golang:1.26-alpine AS builder

# Go 模块代理可配置（默认七牛，海外/CI 可在 build 时用 --build-arg 覆盖为官方源）
ARG GOPROXY=https://goproxy.cn,direct
ENV GOPROXY=${GOPROXY}

RUN apk add --no-cache git

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /app/server ./cmd/server

# Stage 2: Run
FROM alpine:3.19

RUN apk add --no-cache ca-certificates tzdata wget

WORKDIR /app

COPY --from=builder /app/server .
COPY --from=builder /app/config.yaml .
COPY --from=builder /app/migrations ./migrations

EXPOSE 8080

ENTRYPOINT ["./server"]
