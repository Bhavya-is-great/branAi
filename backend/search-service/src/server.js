require("dotenv").config({ path: require("node:path").resolve(__dirname, "../../../.env") });
const Fastify = require("fastify");
const cors = require("@fastify/cors");
const { Pool } = require("pg");
const {
  LRUCache,
  Trie,
  buildInvertedIndex,
  cosineSimilarity,
  hybridScore,
  keywordScore,
  stableEmbedding,
  tokenize
} = require("@second-brain/shared");

const app = Fastify({ logger: true });
const port = Number(process.env.SEARCH_SERVICE_PORT || 4103);
const pool = new Pool({ connectionString: process.env.POSTGRES_URL });
const cache = new LRUCache(200);
const qdrantUrl = process.env.QDRANT_URL || "http://localhost:6333";
const aiServiceUrl = process.env.AI_SERVICE_URL || `http://localhost:${process.env.AI_SERVICE_PORT || 4102}`;

const ensureCollection = async () => {
  try {
    await fetch(`${qdrantUrl}/collections/items`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vectors: { size: 64, distance: "Cosine" } })
    });
  } catch {
    // Local fallback mode is acceptable if Qdrant is unavailable.
  }
};

const queryEmbedding = async (text) => {
  try {
    const response = await fetch(`${aiServiceUrl}/embed-query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text })
    });
    if (!response.ok) throw new Error("Embedding failed");
    const payload = await response.json();
    return payload.embedding;
  } catch {
    return stableEmbedding(text);
  }
};

const buildTrie = (items) => {
  const trie = new Trie();
  items.forEach((item) => tokenize(`${item.title} ${item.summary || ""}`).forEach((token) => trie.insert(token)));
  return trie;
};

const inferDateRange = (query = "") => {
  const now = new Date();
  const lower = query.toLowerCase();
  if (lower.includes("last month")) {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    return { dateFrom: start.toISOString(), dateTo: end.toISOString() };
  }
  if (lower.includes("this month")) {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return { dateFrom: start.toISOString() };
  }
  if (lower.includes("last week")) {
    const start = new Date(now);
    start.setDate(now.getDate() - 7);
    return { dateFrom: start.toISOString() };
  }
  return {};
};

const inferType = (query = "") => {
  const lower = query.toLowerCase();
  if (/(video|youtube)/.test(lower)) return "youtube";
  if (/(image|photo|picture|jpg|png)/.test(lower)) return "image";
  if (/(pdf|paper|document)/.test(lower)) return "pdf";
  if (/(tweet|twitter|x.com)/.test(lower)) return "tweet";
  return null;
};

app.register(cors, { origin: true });
app.get("/health", async () => ({ ok: true, service: "search-service" }));

app.post("/index/:id", async (request) => {
  const result = await pool.query("SELECT * FROM items WHERE id = $1", [request.params.id]);
  const item = result.rows[0];
  if (!item?.embedding) return { indexed: false, reason: "missing embedding" };
  await ensureCollection();
  try {
    await fetch(`${qdrantUrl}/collections/items/points`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        points: [
          {
            id: item.id.replace(/-/g, ""),
            vector: item.embedding,
            payload: { userId: item.user_id, title: item.title, summary: item.summary, sourceType: item.source_type }
          }
        ]
      })
    });
  } catch {
    request.log.warn("Qdrant unavailable during indexing");
  }
  cache.set(`items:${item.user_id}`, null);
  return { indexed: true };
});

app.get("/suggest", async (request) => {
  const userId = request.query.userId;
  const q = request.query.q || "";
  const itemsResult = await pool.query("SELECT id, title, summary, cleaned_content FROM items WHERE user_id = $1", [userId]);
  const trie = buildTrie(itemsResult.rows);
  return { suggestions: trie.searchPrefix(q.toLowerCase(), 10) };
});

app.get("/search", async (request) => {
  const userId = request.query.userId;
  const q = request.query.q || "";
  const derivedDateRange = inferDateRange(q);
  const derivedType = inferType(q);
  const filters = {
    type: request.query.type || derivedType,
    collectionId: request.query.collectionId || null,
    dateFrom: request.query.dateFrom || derivedDateRange.dateFrom || null,
    dateTo: request.query.dateTo || derivedDateRange.dateTo || null
  };
  const cacheKey = `${userId}:${q}:${JSON.stringify(filters)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const itemsResult = await pool.query("SELECT * FROM items WHERE user_id = $1 AND status = 'processed'", [userId]);
  const items = itemsResult.rows
    .map((row) => ({ ...row, embedding: Array.isArray(row.embedding) ? row.embedding : row.embedding || [] }))
    .filter((item) => {
      if (filters.type && !(item.source_type === filters.type || item.metadata?.detectedSourceType === filters.type)) return false;
      if (filters.collectionId && item.collection_id !== filters.collectionId) return false;
      if (filters.dateFrom && new Date(item.created_at) < new Date(filters.dateFrom)) return false;
      if (filters.dateTo && new Date(item.created_at) > new Date(filters.dateTo)) return false;
      return true;
    });
  const invertedIndex = buildInvertedIndex(items);
  const queryVector = await queryEmbedding(q);

  let vectorCandidates = [];
  try {
    const qdrantResponse = await fetch(`${qdrantUrl}/collections/items/points/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vector: queryVector, limit: 20, with_payload: true })
    });
    if (qdrantResponse.ok) {
      const payload = await qdrantResponse.json();
      vectorCandidates = payload.result || [];
    }
  } catch {
    vectorCandidates = [];
  }

  const vectorScoreMap = new Map(vectorCandidates.map((candidate) => [candidate.id, candidate.score]));

  const results = items
    .map((item) => {
      const vectorScore = vectorScoreMap.get(item.id.replace(/-/g, "")) || cosineSimilarity(queryVector, item.embedding || []);
      const keywordScoreValue = keywordScore(q, item, invertedIndex);
      const freshness = 1 / Math.log2(((Date.now() - new Date(item.created_at).getTime()) / 86400000) + 2);
      const score = hybridScore({ vectorScore, keywordScoreValue, freshness, importance: item.importance_score || 0 });
      return { ...item, score };
    })
    .filter((item) => item.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, 25);

  const response = { results, filtersApplied: filters };
  cache.set(cacheKey, response);
  return response;
});

app.listen({ port, host: "0.0.0.0" });
