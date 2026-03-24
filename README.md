# Second Brain AI

Production-grade monorepo for a personal knowledge engine that captures internet content, processes it semantically, connects related knowledge, and resurfaces information over time.

## Architecture

- `backend/api-gateway` Fastify gateway with JWT auth, rate limiting, and route aggregation
- `backend/content-service` PostgreSQL-backed CRUD for items, collections, highlights, and resurfacing
- `backend/ai-service` summarization, keywords, tags, embeddings, and clustering with OpenAI fallback support
- `backend/search-service` hybrid retrieval using inverted index, cosine similarity, trie suggestions, and LRU caching
- `backend/graph-service` knowledge graph management with adjacency lists, BFS, DFS, connected components, and PageRank
- `backend/worker-service` BullMQ worker for extraction, enrichment, indexing, and graph rebuilds
- `frontend/web-app` Next.js UI for dashboard, search, graph, and item detail workflows
- `frontend/extension` Chrome extension for one-click capture of the current tab
- `packages/shared` shared algorithms and utilities
- `infra` Docker Compose, Postgres schema bootstrap, and Nginx reverse proxy

## Core Flow

1. Save content through the web app or Chrome extension.
2. API gateway forwards the request to content service.
3. Content service stores raw content and pushes a BullMQ ingestion job.
4. Worker extracts text and metadata using `cheerio`, `unfluff`, `pdf-parse`, and YouTube transcript support.
5. AI service generates summaries, keywords, tags, and embeddings.
6. Search service indexes embeddings and performs hybrid ranking.
7. Graph service rebuilds relationships and updates importance scores.
8. Resurfacing ranks useful older items with time decay and priority-queue selection.

## Local Development

1. Start infrastructure: `docker compose up -d postgres redis qdrant`
2. Install workspace dependencies: `cmd /c npm install`
3. Run services in separate terminals:
   - `cmd /c npm run dev:gateway`
   - `cmd /c npm run dev:content`
   - `cmd /c npm run dev:ai`
   - `cmd /c npm run dev:search`
   - `cmd /c npm run dev:graph`
   - `cmd /c npm run dev:worker`
   - `cmd /c npm run dev:web`
4. Open `http://localhost:3000`
5. Load `frontend/extension/src` as an unpacked Chrome extension

## Key APIs

- `POST /save`
- `GET /items`
- `GET /search`
- `GET /related/:id`
- `GET /graph`
- `GET /resurface`
- `POST /highlight`

## Verification Notes

- Backend source files were syntax-checked with `node --check`.
- Full runtime verification still requires dependency installation plus Postgres, Redis, and Qdrant running locally.
