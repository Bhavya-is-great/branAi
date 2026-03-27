require("dotenv").config({ path: require("node:path").resolve(__dirname, "../../../.env") });
const Fastify = require("fastify");
const cors = require("@fastify/cors");
const { stableEmbedding, tokenize, kMeans } = require("@second-brain/shared");
const { ChatOllama, OllamaEmbeddings } = require("@langchain/ollama");

const app = Fastify({ logger: true });
const port = Number(process.env.AI_SERVICE_PORT || 4102);
const openAiKey = process.env.OPENAI_API_KEY;
const openAiChatModel = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const openAiEmbeddingModel = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const aiProvider = (process.env.AI_PROVIDER || (openAiKey ? "openai" : "ollama")).toLowerCase();
const ollamaBaseUrl = (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/$/, "");
const ollamaChatModel = process.env.OLLAMA_CHAT_MODEL || "gemma3:1b";
const ollamaVisionModel = process.env.OLLAMA_VISION_MODEL || "gemma3:4b";
const ollamaEmbeddingModel = process.env.OLLAMA_EMBEDDING_MODEL || "nomic-embed-text";
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
  if (sourceType === "image") {
    base.add("image");
    if (/anime|manga|character|art|illustration/i.test(`${title} ${text}`)) base.add("art");
  }
  if (sourceType === "note") base.add("note");
  return Array.from(base).filter(Boolean).slice(0, 8);
};

const parseJsonLoose = (value) => {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    const match = String(value).match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
};

const promptForItem = ({ text, sourceType }) => [
  `Analyze this saved ${sourceType} item.`,
  "Return strict JSON with keys: summary, keywords, tags.",
  "summary must be 1-3 concise sentences.",
  "keywords must be an array of short phrases.",
  "tags must be an array of short topical tags.",
  "If this is an image, describe what is visually present and infer likely themes, style, mood, characters, scene, and objects.",
  "If this is a video, use both the text and any supplied thumbnail as hints.",
  `Text context: ${String(text || "").slice(0, 12000)}`
].join("\n");

const openAiProcess = async ({ text, imageUrl, imageBase64, imageContentType, sourceType }) => {
  const content = [{ type: "text", text: promptForItem({ text, sourceType }) }];
  if (imageBase64) content.push({ type: "image_url", image_url: { url: `data:${imageContentType || "image/jpeg"};base64,${imageBase64}` } });
  else if (imageUrl) content.push({ type: "image_url", image_url: { url: imageUrl } });

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${openAiKey}`
    },
    body: JSON.stringify({
      model: openAiChatModel,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You analyze saved knowledge items. Return JSON with summary, keywords, and tags. Use any supplied image to identify visible subjects, objects, scene, style, and mood." },
        { role: "user", content }
      ]
    })
  });
  if (!response.ok) throw new Error(`OpenAI process failed: ${response.status}`);
  const payload = await response.json();
  return JSON.parse(payload.choices[0].message.content);
};

const ollamaTextProcess = async ({ text, sourceType }) => {
  const model = new ChatOllama({ baseUrl: ollamaBaseUrl, model: ollamaChatModel, temperature: 0.2, format: "json" });
  const result = await model.invoke(promptForItem({ text, sourceType }));
  const content = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
  const parsed = parseJsonLoose(content);
  if (!parsed) throw new Error("Ollama text output was not valid JSON");
  return parsed;
};

const ollamaVisionProcess = async ({ text, imageBase64, sourceType }) => {
  if (!imageBase64) throw new Error("Missing inline image bytes for Ollama vision");
  const response = await fetch(`${ollamaBaseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: ollamaVisionModel,
      stream: false,
      format: "json",
      messages: [{ role: "user", content: promptForItem({ text, sourceType }), images: [imageBase64] }]
    })
  });
  if (!response.ok) throw new Error(`Ollama vision process failed: ${response.status}`);
  const payload = await response.json();
  const parsed = parseJsonLoose(payload?.message?.content);
  if (!parsed) throw new Error("Ollama vision output was not valid JSON");
  return parsed;
};

const localProcess = async ({ text, imageBase64, sourceType }) => {
  if (sourceType === 'image' && !imageBase64) return null;
  if (imageBase64) return ollamaVisionProcess({ text, imageBase64, sourceType });
  return ollamaTextProcess({ text, sourceType });
};

const openAiEmbedding = async (text) => {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${openAiKey}` },
    body: JSON.stringify({ model: openAiEmbeddingModel, input: text.slice(0, 12000) })
  });
  if (!response.ok) throw new Error(`OpenAI embedding failed: ${response.status}`);
  const payload = await response.json();
  return normalizeEmbedding(payload.data[0].embedding);
};

const localEmbeddingModel = new OllamaEmbeddings({ baseUrl: ollamaBaseUrl, model: ollamaEmbeddingModel });
const localEmbedding = async (text) => normalizeEmbedding(await localEmbeddingModel.embedQuery(text.slice(0, 12000)));

app.register(cors, { origin: true });
app.get("/health", async () => ({ ok: true, service: "ai-service", provider: aiProvider }));

app.post("/embed-query", async (request) => {
  const text = request.body?.text || "";
  try {
    const embedding = aiProvider === "openai" && openAiKey ? await openAiEmbedding(text) : await localEmbedding(text);
    return { embedding };
  } catch (error) {
    request.log.warn({ error: error.message }, "Embedding provider failed, using stable embedding fallback");
    return { embedding: stableEmbedding(text) };
  }
});

app.post("/process", async (request) => {
  const text = request.body?.text || "";
  const title = request.body?.title || "Untitled";
  const sourceType = request.body?.sourceType || "url";
  const imageUrl = request.body?.imageUrl || null;
  const imageBase64 = request.body?.imageBase64 || null;
  const imageContentType = request.body?.imageContentType || null;
  let summary = heuristicSummary(text || title);
  let keywords = heuristicKeywords(text || title);
  let tags = enrichTags({ sourceType, keywords, title, text });

  try {
    let ai = null;
    if (aiProvider === "openai" && openAiKey) {
      ai = await openAiProcess({ text: text || title, imageUrl, imageBase64, imageContentType, sourceType });
    } else {
      ai = await localProcess({ text: text || title, imageBase64, sourceType });
    }
    if (ai) {
      summary = ai.summary || summary;
      keywords = Array.isArray(ai.keywords) && ai.keywords.length ? ai.keywords : keywords;
      tags = Array.isArray(ai.tags) && ai.tags.length ? ai.tags : tags;
    }
  } catch (error) {
    request.log.warn({ error: error.message, provider: aiProvider }, "AI processing failed, using heuristics");
  }

  tags = enrichTags({ sourceType, keywords, title, text: `${title}. ${text}` }).concat(tags || []).filter(Boolean);
  tags = Array.from(new Set(tags)).slice(0, 8);

  let embedding;
  try {
    embedding = aiProvider === "openai" && openAiKey ? await openAiEmbedding(`${title}. ${text}`) : await localEmbedding(`${title}. ${text}`);
  } catch (error) {
    request.log.warn({ error: error.message, provider: aiProvider }, "Embedding generation failed, using stable fallback");
    embedding = stableEmbedding(`${title}. ${text}`);
  }

  return {
    summary,
    keywords,
    tags,
    embedding,
    clusterHint: sourceType,
    cleanedText: text.replace(/\s+/g, " ").trim(),
    provider: aiProvider
  };
});

app.post("/cluster", async (request) => {
  const vectors = request.body?.vectors || [];
  return { clusters: kMeans(vectors, request.body?.k || 3) };
});

app.listen({ port, host: "0.0.0.0" });
