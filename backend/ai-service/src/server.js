require("dotenv").config({ path: require("node:path").resolve(__dirname, "../../../.env") });
const Fastify = require("fastify");
const cors = require("@fastify/cors");
const { stableEmbedding, tokenize, kMeans } = require("@second-brain/shared");

const app = Fastify({ logger: true });
const port = Number(process.env.AI_SERVICE_PORT || 4102);
const openAiKey = process.env.OPENAI_API_KEY;
const chatModel = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const embeddingModel = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const EMBEDDING_SIZE = 64;

const stopWords = new Set(["the", "and", "for", "that", "with", "this", "from", "have", "your", "about", "into", "they", "their", "were", "will", "what", "when", "where", "which", "while", "there", "been", "http", "https"]);

const normalizeEmbedding = (vector = [], size = EMBEDDING_SIZE) => {
  if (!Array.isArray(vector) || !vector.length) return stableEmbedding("");
  if (vector.length === size) return vector;
  const normalized = new Array(size).fill(0);
  const bucketSize = vector.length / size;
  for (let index = 0; index < size; index += 1) {
    const start = Math.floor(index * bucketSize);
    const end = Math.max(start + 1, Math.floor((index + 1) * bucketSize));
    const slice = vector.slice(start, end);
    normalized[index] = slice.reduce((sum, value) => sum + value, 0) / slice.length;
  }
  const norm = Math.sqrt(normalized.reduce((sum, value) => sum + value ** 2, 0)) || 1;
  return normalized.map((value) => Number((value / norm).toFixed(6)));
};

const heuristicKeywords = (text) => {
  const counts = new Map();
  tokenize(text).forEach((token) => {
    if (token.length < 3 || stopWords.has(token)) return;
    counts.set(token, (counts.get(token) || 0) + 1);
  });
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([token]) => token);
};

const heuristicSummary = (text) => text.split(/(?<=[.!?])\s+/).slice(0, 3).join(" ").slice(0, 700);

const enrichTags = ({ sourceType, keywords, title, text }) => {
  const base = new Set([...(keywords || []).slice(0, 5)]);
  if (sourceType === "youtube") {
    base.add("youtube");
    base.add("video");
    if (/shorts/i.test(title) || /shorts/i.test(text)) base.add("shorts");
  }
  if (sourceType === "tweet") {
    base.add("tweet");
    base.add("social");
  }
  if (sourceType === "pdf") base.add("pdf");
  if (sourceType === "image") base.add("image");
  if (sourceType === "note") base.add("note");
  return Array.from(base).filter(Boolean).slice(0, 8);
};

const openAiProcess = async ({ text, imageUrl, sourceType }) => {
  const content = [{ type: "text", text: `Analyze this saved ${sourceType} item and return JSON with keys summary, keywords, tags. Text: ${text.slice(0, 12000)}` }];
  if (imageUrl) {
    content.push({ type: "image_url", image_url: { url: imageUrl } });
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${openAiKey}`
    },
    body: JSON.stringify({
      model: chatModel,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You analyze saved knowledge items. Return JSON with summary, keywords, and tags. If an image is provided, use it as a visual hint, especially for videos and images. Keep tags concise and topical."
        },
        {
          role: "user",
          content
        }
      ]
    })
  });
  if (!response.ok) throw new Error(`OpenAI process failed: ${response.status}`);
  const payload = await response.json();
  return JSON.parse(payload.choices[0].message.content);
};

const openAiEmbedding = async (text) => {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${openAiKey}`
    },
    body: JSON.stringify({ model: embeddingModel, input: text.slice(0, 12000) })
  });
  if (!response.ok) throw new Error(`OpenAI embedding failed: ${response.status}`);
  const payload = await response.json();
  return normalizeEmbedding(payload.data[0].embedding);
};

app.register(cors, { origin: true });
app.get("/health", async () => ({ ok: true, service: "ai-service" }));

app.post("/embed-query", async (request) => {
  const text = request.body?.text || "";
  try {
    const embedding = openAiKey ? await openAiEmbedding(text) : stableEmbedding(text);
    return { embedding };
  } catch {
    return { embedding: stableEmbedding(text) };
  }
});

app.post("/process", async (request) => {
  const text = request.body?.text || "";
  const title = request.body?.title || "Untitled";
  const sourceType = request.body?.sourceType || "url";
  const imageUrl = request.body?.imageUrl || null;
  let summary = heuristicSummary(text || title);
  let keywords = heuristicKeywords(text || title);
  let tags = enrichTags({ sourceType, keywords, title, text });

  if (openAiKey) {
    try {
      const ai = await openAiProcess({ text: text || title, imageUrl, sourceType });
      summary = ai.summary || summary;
      keywords = Array.isArray(ai.keywords) && ai.keywords.length ? ai.keywords : keywords;
      tags = Array.isArray(ai.tags) && ai.tags.length ? ai.tags : tags;
    } catch (error) {
      request.log.warn({ error: error.message }, "OpenAI processing failed, using heuristics");
    }
  }

  tags = enrichTags({ sourceType, keywords, title, text: `${title}. ${text}` }).concat(tags || []).filter(Boolean);
  tags = Array.from(new Set(tags)).slice(0, 8);

  let embedding;
  try {
    embedding = openAiKey ? await openAiEmbedding(`${title}. ${text}`) : stableEmbedding(`${title}. ${text}`);
  } catch {
    embedding = stableEmbedding(`${title}. ${text}`);
  }

  return {
    summary,
    keywords,
    tags,
    embedding,
    clusterHint: sourceType,
    cleanedText: text.replace(/\s+/g, " ").trim()
  };
});

app.post("/cluster", async (request) => {
  const vectors = request.body?.vectors || [];
  return { clusters: kMeans(vectors, request.body?.k || 3) };
});

app.listen({ port, host: "0.0.0.0" });
