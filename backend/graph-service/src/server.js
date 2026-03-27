require("dotenv").config({ path: require("node:path").resolve(__dirname, "../../../.env") });
const Fastify = require("fastify");
const cors = require("@fastify/cors");
const { Pool } = require("pg");
const {
  bfs,
  connectedComponents,
  cosineSimilarity,
  graphFromRelations,
  kMeans,
  pageRank,
  projectEmbedding3D
} = require("@second-brain/shared");

const app = Fastify({ logger: true });
const port = Number(process.env.GRAPH_SERVICE_PORT || 4104);
const pool = new Pool({ connectionString: process.env.POSTGRES_URL });

app.register(cors, { origin: true });
app.get("/health", async () => ({ ok: true, service: "graph-service" }));

const normalizeEmbedding = (value) => {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return [];
  }
};

const effectiveType = (item) => item.metadata?.detectedSourceType || item.source_type;

const rebuildUserGraph = async (userId) => {
  const itemsResult = await pool.query("SELECT * FROM items WHERE user_id = $1 AND status = 'processed'", [userId]);
  const items = itemsResult.rows.map((item) => ({ ...item, embedding: normalizeEmbedding(item.embedding) }));
  await pool.query("DELETE FROM relations WHERE user_id = $1", [userId]);

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const left = items[i];
      const right = items[j];
      const leftType = effectiveType(left);
      const rightType = effectiveType(right);
      const sameType = leftType === rightType;
      const tagOverlap = (left.ai_tags || []).filter((tag) => (right.ai_tags || []).includes(tag)).length;
      const vectorSimilarity = cosineSimilarity(left.embedding, right.embedding);
      const temporalDistance = Math.abs(new Date(left.created_at).getTime() - new Date(right.created_at).getTime()) / 86400000;
      const temporalWeight = sameType && temporalDistance < 10 ? 0.08 : 0;

      if (!sameType && (leftType === "image" || rightType === "image") && tagOverlap === 0 && vectorSimilarity < 0.92) {
        continue;
      }
      if (!sameType && (leftType === "youtube" || rightType === "youtube") && tagOverlap === 0 && vectorSimilarity < 0.88) {
        continue;
      }

      const sourcePenalty = sameType ? 1 : 0.58;
      const weight = Number(((vectorSimilarity * 0.72 + tagOverlap * 0.12 + temporalWeight) * sourcePenalty).toFixed(4));
      if (weight < 0.36) continue;
      const relationType = vectorSimilarity > 0.82 ? "semantic_similarity" : tagOverlap ? "shared_tags" : "temporal_relation";
      await pool.query(
        `INSERT INTO relations (user_id, from_item_id, to_item_id, relation_type, weight, metadata)
         VALUES ($1, $2, $3, $4, $5, $6), ($1, $3, $2, $4, $5, $6)`,
        [userId, left.id, right.id, relationType, weight, JSON.stringify({ tagOverlap, temporalDistance, leftType, rightType, vectorSimilarity })]
      );
    }
  }

  const relationsResult = await pool.query("SELECT * FROM relations WHERE user_id = $1", [userId]);
  const adjacency = graphFromRelations(relationsResult.rows);
  const rank = pageRank(adjacency);
  for (const item of items) {
    await pool.query("UPDATE items SET importance_score = $2 WHERE id = $1", [item.id, rank.get(item.id) || 0]);
  }
  return { adjacency, relations: relationsResult.rows };
};

app.post("/rebuild/:id?", async (request) => {
  const userId = request.body?.userId || request.query.userId;
  return rebuildUserGraph(userId).then(({ relations }) => ({ rebuilt: true, relations: relations.length }));
});

app.get("/graph", async (request) => {
  const userId = request.query.userId;
  const itemsResult = await pool.query(
    "SELECT id, title, source_type, importance_score, created_at, summary, embedding, ai_tags, metadata FROM items WHERE user_id = $1",
    [userId]
  );
  const relationsResult = await pool.query("SELECT * FROM relations WHERE user_id = $1", [userId]);
  const adjacency = graphFromRelations(relationsResult.rows);
  const items = itemsResult.rows.map((item, index) => {
    const embedding = normalizeEmbedding(item.embedding);
    return {
      ...item,
      embedding,
      vector3d: projectEmbedding3D(embedding, index)
    };
  });
  const clustered = kMeans(
    items.map((item) => ({ id: item.id, vector: item.embedding.length ? item.embedding : [item.vector3d.x, item.vector3d.y, item.vector3d.z] })),
    Math.min(4, Math.max(1, Math.ceil(items.length / 3)))
  );
  const clusterById = new Map(clustered.map((entry) => [entry.id, entry.cluster]));
  const nodes = items.map((item) => ({
    ...item,
    cluster: clusterById.get(item.id) ?? 0
  }));
  const start = request.query.start || nodes[0]?.id;
  return {
    nodes,
    edges: relationsResult.rows,
    traversal: bfs(adjacency, start),
    components: connectedComponents(adjacency),
    clusters: Array.from(new Set(nodes.map((node) => node.cluster))).sort((a, b) => a - b)
  };
});

app.get("/related/:id", async (request) => {
  const result = await pool.query(
    `SELECT i.*, r.weight, r.relation_type
     FROM relations r
     JOIN items i ON i.id = r.to_item_id
     WHERE r.from_item_id = $1 AND r.user_id = $2
     ORDER BY r.weight DESC
     LIMIT 10`,
    [request.params.id, request.query.userId]
  );
  return { items: result.rows };
});

app.listen({ port, host: "0.0.0.0" });
