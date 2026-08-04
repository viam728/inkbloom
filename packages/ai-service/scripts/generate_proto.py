"""Script to generate gRPC code for both Python and Go.

Prerequisites:
  - Python: grpcio-tools (pip install grpcio-tools)
  - Go: protoc-gen-go, protoc-gen-go-grpc
    go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
    go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest

Usage:
  python scripts/generate_proto.py
"""

import os
import subprocess
import sys

# Project root (assuming script is in packages/ai-service/scripts/)
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
AI_SERVICE_DIR = os.path.dirname(SCRIPT_DIR)
PROJECT_ROOT = os.path.dirname(os.path.dirname(AI_SERVICE_DIR))
PROTO_DIR = os.path.join(PROJECT_ROOT, "packages", "shared", "proto")
PYTHON_OUT = os.path.join(AI_SERVICE_DIR, "app", "grpc_server", "generated")
GO_OUT = os.path.join(PROJECT_ROOT, "packages", "server", "proto", "aiservice")


def generate_python():
    """Generate Python gRPC code."""
    print("Generating Python gRPC code...")
    cmd = [
        sys.executable, "-m", "grpc_tools.protoc",
        f"-I{PROTO_DIR}",
        f"--python_out={PYTHON_OUT}",
        f"--grpc_python_out={PYTHON_OUT}",
        os.path.join(PROTO_DIR, "ai_service.proto"),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Error generating Python gRPC code: {result.stderr}")
        return False
    print("Python gRPC code generated successfully.")
    return True


def generate_go():
    """Generate Go gRPC code."""
    print("Generating Go gRPC code...")
    cmd = [
        "protoc",
        f"-I{PROTO_DIR}",
        f"--go_out={GO_OUT}",
        "--go_opt=paths=source_relative",
        f"--go-grpc_out={GO_OUT}",
        "--go-grpc_opt=paths=source_relative",
        os.path.join(PROTO_DIR, "ai_service.proto"),
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"Error generating Go gRPC code: {result.stderr}")
            print("Make sure protoc-gen-go and protoc-gen-go-grpc are installed:")
            print("  go install google.golang.org/protobuf/cmd/protoc-gen-go@latest")
            print("  go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest")
            return False
        print("Go gRPC code generated successfully.")
        return True
    except FileNotFoundError:
        print("protoc not found. Install protoc and Go plugins to generate Go code.")
        print("  go install google.golang.org/protobuf/cmd/protoc-gen-go@latest")
        print("  go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest")
        return False


if __name__ == "__main__":
    os.makedirs(PYTHON_OUT, exist_ok=True)
    os.makedirs(GO_OUT, exist_ok=True)

    py_ok = generate_python()
    go_ok = generate_go()

    if py_ok:
        print("\nDone. Python gRPC code is ready.")
    if not go_ok:
        print("\nGo gRPC code generation skipped (tools not available).")
