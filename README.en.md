# ai-memory — Local-First AI Long-Term Memory Service

> A "long-term memory" backend for AI assistants. Stores conversations, document snippets, and knowledge as structured data in Qdrant vector DB (or SQLite fallback). Retrieves what was said before using **vector search + keyword recall + knowledge graph**.

---

## Overview

`ai-memory` is a **local-first** AI memory system. It gives AI assistants cross-session, cross-project long-term memory — instead of starting from scratch every conversation.

- **Storage**: Qdrant vector DB (`memories` collection, 1024-dim vector + structured payload). Auto-falls back to local SQLite (`memories.db`) when `qdrant_url` / `embedding_url` is not configured.
- **Embedding**: `qwen3-embedding:0.6B` (1024-dim, via Ollama).
- **LLM**: DeepSeek v4 Flash / local models via Ollama for fact extraction + knowledge graph generation.
- **Protocol**: MCP (Model Context Protocol) via SSE at `/sse` + REST API at `:8765`.

## Quick Start

```bash
# Local SQLite mode (no Qdrant needed)
npm start
# Open http://localhost:8765/admin

# Full mode (with config.json)
# Edit config.example.json → config.json, fill in your Qdrant/LLM URLs
npm start
```

### Docker

```bash
docker compose up -d
# Qdrant on :6333, ai-memory on :8765
# First-time: create Qdrant collection (see docker-compose.yml comments)
```

### Deploy to Server

```bash
SSH2_PASSWORD=your_password node deploy.js
# Backs up → uploads code → syntax checks → restarts → health checks
```

## Architecture

```
config(L0) → util/embed(L1) → backend/intelligence(L2) →
graph/projects/facts/memory/capture(L3-5) →
correction/quality/diagnostics(L5) → mcp/rest(L6) → server(L7)
```

- **Fastify v5** on the HTTP layer (40+ routes, auth, schema validation, OpenAPI docs at `/docs`)
- **MCP SSE** endpoint at `/sse` (11 tools: add/search/list/pin/export/import/backup memory, etc.)
- All modules load in dependency order; no circular deps.

## Features

| Feature | Description |
|---------|-------------|
| **Memory CRUD** | Add, search (semantic/keyword/hybrid), list, update, delete memories |
| **Fact Extraction** | LLM extracts facts, entities, relations from raw text |
| **Conflict Resolution** | Detects contradictions / supplements, merges or versions autonomously |
| **Deduplication** | Content-hash exact + vector similarity fuzzy merge |
| **Knowledge Graph** | Entity-relation graph with neighbor queries |
| **Working Memory** | Short-term buffer before promoting to long-term |
| **User Correction** | Correct memories via feedback; system learns from corrections |
| **Auto Capture** | Watch files/directories, tail new content and ingest |
| **Lifecycle** | TTL expiry, pinning, cleanup throttling |
| **Cross-Project** | Related-project borrowed memories with decay weighting |
| **MMR Reranking** | Maximum Marginal Relevance diversity reranking |
| **Webhook** | Event-driven push (memory.added / memory.updated / error alerts) |
| **Authentication** | Bearer token via `api_keys` config. Admin login page. SSE supports `?key=` |
| **Rate Limiting** | 100 req/min global, 5 req/min on config/reset |
| **Health Monitoring** | err_stats per category, alert webhook every 5 minutes if non-zero |
| **API Docs** | OpenAPI/Swagger UI at `/docs`, JSON at `/api/docs/json` |

## Configuration

See `config.example.json` for all ~35 fields. Key ones:

| Field | Default | Description |
|-------|---------|-------------|
| `qdrant_url` | `""` | Qdrant endpoint. Empty → SQLite fallback |
| `embedding_url` | `""` | Embedding API (OpenAI /v1/embeddings compatible) |
| `llm_url` | `http://127.0.0.1:11434/v1/chat/completions` | LLM endpoint for extraction |
| `api_keys` | `[]` | Bearer tokens. Empty → no auth |
| `webhook_urls` | `[]` | Event push targets |

All fields also support environment variables for Docker (e.g., `QDRANT_URL`, `LLM_URL`, `API_KEYS`).

## File Layout

| Path | Role |
|------|------|
| `server.js` | Thin entry: loads config → starts Fastify |
| `lib/rest.js` | Fastify v5 app: 40+ routes, auth, SSE, schema, logging, rate-limit |
| `lib/config.js` | Config singleton from config.json + env fallbacks |
| `lib/memory.js` | Core CRUD + search (754 lines, entry point) |
| `lib/memory_lifecycle.js` | Cleanup / consolidate / batch (180 lines) |
| `lib/memory_work.js` | Working memory operations (42 lines) |
| `lib/backend.js` | SQLite schema, FTS, KG, dedup, entity vocab (826 lines) |
| `lib/capture.js` | Auto-capture from file/dir watching |
| `lib/webhook.js` | Event push (memory lifecycle events + system alerts) |
| `lib/qdrant.js` | Qdrant client wrapper |
| `admin.html` | Admin UI (served at `/admin`) |
| `deploy.js` | One-click deploy to remote server (sshtool/ssh2) |
| `Dockerfile` + `docker-compose.yml` | Containerized full-stack (Qdrant + ai-memory) |

## Testing

```bash
npm run test:unit        # Pure function unit tests (23 cases, ms-level)
npm run test:quick       # unit + health + memory_ops (local, no deps needed)
API_KEY=xxx npm run verify  # Full suite (requires Qdrant + LLM)
```

## License

MIT. See `LICENSE.md`.
