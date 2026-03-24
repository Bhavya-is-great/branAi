require("dotenv").config({ path: require("node:path").resolve(__dirname, "../../../.env") });
const Fastify = require("fastify");
const cors = require("@fastify/cors");
const { Pool } = require("pg");
const { Queue } = require("bullmq");
const Redis = require("ioredis");
const bcrypt = require("bcryptjs");
const { MinHeap, timeDecayScore } = require("@second-brain/shared");

const app = Fastify({ logger: true });
const port = Number(process.env.CONTENT_SERVICE_PORT || 4101);
const pool = new Pool({ connectionString: process.env.POSTGRES_URL });
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", { maxRetriesPerRequest: null });
const ingestionQueue = new Queue("ingestion", { connection: redis });

app.register(cors, { origin: true });
app.get("/health", async () => ({ ok: true, service: "content-service" }));

const cleanUser = (row) => ({ id: row.id, email: row.email, createdAt: row.created_at });
const userIdFrom = (request) => request.headers["x-user-id"] || request.query.userId || request.body?.userId;

const inferCollectionName = ({ sourceType, aiTags = [], title = "" }) => {
  const lowerTitle = String(title).toLowerCase();
  if (sourceType === "youtube") return "Videos";
  if (sourceType === "tweet") return "Tweets";
  if (sourceType === "pdf") return "Documents";
  if (sourceType === "image") return "Images";
  if (sourceType === "note") return "Notes";
  const preferredTag = (aiTags || []).find((tag) => tag && tag.length > 2 && !["youtube", "video", "tweet", "social", "pdf", "image", "note"].includes(String(tag).toLowerCase()));
  if (preferredTag) return preferredTag.charAt(0).toUpperCase() + preferredTag.slice(1);
  if (lowerTitle.includes("ai")) return "AI";
  return "Inbox";
};

const ensureAutoCollection = async ({ userId, currentCollectionId, sourceType, aiTags, title }) => {
  if (currentCollectionId) return currentCollectionId;
  const name = inferCollectionName({ sourceType, aiTags, title });
  const existing = await pool.query("SELECT id FROM collections WHERE user_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1", [userId, name]);
  if (existing.rows[0]) return existing.rows[0].id;
  const inserted = await pool.query(
    "INSERT INTO collections (user_id, name, description) VALUES ($1, $2, $3) RETURNING id",
    [userId, name, `Auto-organized ${name.toLowerCase()} collection`]
  );
  return inserted.rows[0].id;
};

app.post("/users/demo", async () => {
  const email = "demo@secondbrain.local";
  const passwordHash = await bcrypt.hash("demo-password", 10);
  const existing = await pool.query("SELECT id, email, created_at FROM users WHERE email = $1", [email]);
  if (existing.rows[0]) return cleanUser(existing.rows[0]);
  const inserted = await pool.query(
    "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at",
    [email, passwordHash]
  );
  return cleanUser(inserted.rows[0]);
});

app.post("/users/register", async (request, reply) => {
  const { email, password } = request.body;
  if (!email || !password) return reply.code(400).send({ message: "Email and password are required" });
  const passwordHash = await bcrypt.hash(password, 10);
  const inserted = await pool.query(
    "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at",
    [email, passwordHash]
  );
  return cleanUser(inserted.rows[0]);
});

app.post("/users/login", async (request, reply) => {
  const { email, password } = request.body;
  const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return reply.code(401).send({ message: "Invalid credentials" });
  }
  return cleanUser(user);
});

app.post("/save", async (request, reply) => {
  const userId = userIdFrom(request);
  const { sourceType, url, title, content, collectionId, metadata } = request.body;
  if (!userId) return reply.code(400).send({ message: "Missing userId" });
  const initialTitle = title || url || "Untitled note";
  const inserted = await pool.query(
    `INSERT INTO items (user_id, collection_id, source_type, url, title, raw_content, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [userId, collectionId || null, sourceType || "url", url || null, initialTitle, content || null, metadata || {}]
  );
  const item = inserted.rows[0];
  await ingestionQueue.add("process-item", { itemId: item.id, userId }, { removeOnComplete: 1000, removeOnFail: 1000 });
  return { item, queued: true };
});

app.get("/items", async (request) => {
  const userId = userIdFrom(request);
  const result = await pool.query(
    `SELECT i.*, c.name AS collection_name
     FROM items i
     LEFT JOIN collections c ON c.id = i.collection_id
     WHERE i.user_id = $1
     ORDER BY i.created_at DESC`,
    [userId]
  );
  return { items: result.rows };
});

app.get("/items/:id", async (request, reply) => {
  const userId = userIdFrom(request);
  const result = await pool.query("SELECT * FROM items WHERE id = $1 AND user_id = $2", [request.params.id, userId]);
  if (!result.rows[0]) return reply.code(404).send({ message: "Item not found" });
  const highlights = await pool.query("SELECT * FROM highlights WHERE item_id = $1 ORDER BY created_at DESC", [request.params.id]);
  return { item: result.rows[0], highlights: highlights.rows };
});

app.patch("/items/:id", async (request, reply) => {
  const userId = userIdFrom(request);
  const { title, description, collectionId } = request.body;
  const result = await pool.query(
    `UPDATE items
     SET title = COALESCE($3, title),
         description = COALESCE($4, description),
         collection_id = COALESCE($5, collection_id),
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [request.params.id, userId, title ?? null, description ?? null, collectionId ?? null]
  );
  if (!result.rows[0]) return reply.code(404).send({ message: "Item not found" });
  return { item: result.rows[0] };
});

app.delete("/items/:id", async (request, reply) => {
  const userId = userIdFrom(request);
  const deleted = await pool.query("DELETE FROM items WHERE id = $1 AND user_id = $2 RETURNING id", [request.params.id, userId]);
  if (!deleted.rows[0]) return reply.code(404).send({ message: "Item not found" });
  return { deleted: true, id: deleted.rows[0].id };
});

app.post("/items/:id/reprocess", async (request, reply) => {
  const userId = userIdFrom(request);
  const result = await pool.query("UPDATE items SET status = 'queued', updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING id", [request.params.id, userId]);
  if (!result.rows[0]) return reply.code(404).send({ message: "Item not found" });
  await ingestionQueue.add("process-item", { itemId: request.params.id, userId }, { removeOnComplete: 1000, removeOnFail: 1000 });
  return { queued: true, id: request.params.id };
});

app.get("/collections", async (request) => {
  const userId = userIdFrom(request);
  const result = await pool.query(
    `SELECT c.*, COUNT(i.id)::int AS item_count
     FROM collections c
     LEFT JOIN items i ON i.collection_id = c.id
     WHERE c.user_id = $1
     GROUP BY c.id
     ORDER BY c.created_at DESC`,
    [userId]
  );
  return { collections: result.rows };
});

app.post("/collections", async (request) => {
  const userId = userIdFrom(request);
  const { name, description } = request.body;
  const result = await pool.query(
    "INSERT INTO collections (user_id, name, description) VALUES ($1, $2, $3) RETURNING *",
    [userId, name, description || null]
  );
  return { collection: result.rows[0] };
});

app.post("/highlight", async (request) => {
  const userId = userIdFrom(request);
  const { itemId, selectedText, note, startOffset, endOffset } = request.body;
  const result = await pool.query(
    `INSERT INTO highlights (item_id, user_id, selected_text, note, start_offset, end_offset)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [itemId, userId, selectedText, note || null, startOffset || null, endOffset || null]
  );
  return { highlight: result.rows[0] };
});

app.post("/internal/items/:id/process", async (request, reply) => {
  const { id } = request.params;
  const { sourceType, title, description, author, thumbnailUrl, rawContent, cleanedContent, summary, keywords, aiTags, embedding, metadata, status } = request.body;
  const itemResult = await pool.query("SELECT id, user_id, collection_id, title FROM items WHERE id = $1", [id]);
  const existingItem = itemResult.rows[0];
  if (!existingItem) return reply.code(404).send({ message: "Item not found" });

  const autoCollectionId = await ensureAutoCollection({
    userId: existingItem.user_id,
    currentCollectionId: existingItem.collection_id,
    sourceType,
    aiTags,
    title: title || existingItem.title
  });

  const result = await pool.query(
    `UPDATE items
     SET source_type = COALESCE($2, source_type),
         title = COALESCE($3, title),
         description = COALESCE($4, description),
         author = COALESCE($5, author),
         thumbnail_url = COALESCE($6, thumbnail_url),
         raw_content = COALESCE($7, raw_content),
         cleaned_content = COALESCE($8, cleaned_content),
         summary = COALESCE($9, summary),
         keywords = COALESCE($10, keywords),
         ai_tags = COALESCE($11, ai_tags),
         embedding = COALESCE($12, embedding),
         metadata = metadata || $13::jsonb,
         status = COALESCE($14, status),
         collection_id = COALESCE(collection_id, $15),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, sourceType, title, description, author, thumbnailUrl, rawContent, cleanedContent, summary, keywords, aiTags, embedding ? JSON.stringify(embedding) : null, metadata ? JSON.stringify(metadata) : "{}", status || "processed", autoCollectionId || null]
  );

  for (const tagName of aiTags || []) {
    const tag = await pool.query(
      "INSERT INTO tags (user_id, name) SELECT user_id, $2 FROM items WHERE id = $1 ON CONFLICT (user_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
      [id, tagName]
    );
    if (tag.rows[0]) {
      await pool.query(
        "INSERT INTO item_tags (item_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [id, tag.rows[0].id]
      );
    }
  }

  return { item: result.rows[0] };
});

app.get("/resurface", async (request) => {
  const userId = userIdFrom(request);
  const result = await pool.query("SELECT * FROM items WHERE user_id = $1 AND status = 'processed'", [userId]);
  const heap = new MinHeap((a, b) => a.score - b.score);
  result.rows.forEach((item) => {
    const score = timeDecayScore({
      relevance: 0.8,
      createdAt: item.created_at,
      lastViewedAt: item.last_viewed_at,
      importanceScore: item.importance_score
    });
    heap.push({ item, score });
    if (heap.data.length > 8) heap.pop();
  });
  const ranked = heap.data.sort((a, b) => b.score - a.score).map((entry) => ({ ...entry.item, resurfacingScore: entry.score }));
  return { items: ranked };
});

app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  reply.code(500).send({ message: error.message || "Internal server error" });
});

app.listen({ port, host: "0.0.0.0" });
