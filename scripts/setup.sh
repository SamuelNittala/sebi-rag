#!/bin/bash
# One-time setup script for MF PDF RAG

set -e

echo "MF PDF RAG Setup"
echo "================"
echo ""

# Check for Ollama
if ! command -v ollama &> /dev/null; then
    echo "Ollama not found. Please install Ollama first:"
    echo "  curl -fsSL https://ollama.com/install.sh | sh"
    exit 1
fi

echo "Pulling embedding model (bge-m3)..."
ollama pull bge-m3

echo ""
echo "Pulling LLM model (qwen2.5:7b)..."
ollama pull qwen2.5:7b

echo ""
echo "Starting infrastructure (Qdrant, PostgreSQL, Redis)..."
docker compose -f docker/docker-compose.yml up -d

echo ""
echo "Waiting for services to be ready..."
sleep 5

echo ""
echo "Installing dependencies..."
bun install

echo ""
echo "Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Copy .env.example to .env and adjust if needed"
echo "  2. Run 'bun run db:migrate' to create database tables"
echo "  3. Run 'bun run dev' to start the API server"
