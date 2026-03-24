require("dotenv").config({ path: require("node:path").resolve(__dirname, "../../../.env") });
const path = require("node:path");
const Fastify = require("fastify");
const { Worker } = require("bullmq");
const Redis = require("ioredis");
const cheerio = require("cheerio");
const pdfParse = require("pdf-parse");

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", { maxRetriesPerRequest: null });
const contentServiceUrl = process.env.CONTENT_SERVICE_URL || `http://localhost:${process.env.CONTENT_SERVICE_PORT || 4101}`;
const aiServiceUrl = process.env.AI_SERVICE_URL || `http://localhost:${process.env.AI_SERVICE_PORT || 4102}`;
const searchServiceUrl = process.env.SEARCH_SERVICE_URL || `http://localhost:${process.env.SEARCH_SERVICE_PORT || 4103}`;
const graphServiceUrl = process.env.GRAPH_SERVICE_URL || `http://localhost:${process.env.GRAPH_SERVICE_PORT || 4104}`;
const port = Number(process.env.WORKER_SERVICE_PORT || 4105);

const app = Fastify({ logger: true });
app.get("/health", async () => ({ ok: true, service: "worker-service" }));
app.listen({ port, host: "0.0.0.0" });

const isYoutubeUrl = (value = "") => /(?:youtube\.com|youtu\.be|m\.youtube\.com|youtube-nocookie\.com)/i.test(String(value));
const isTweetUrl = (value = "") => /(?:twitter\.com|x\.com)/i.test(String(value));

const extractYoutubeTranscript = async (url) => {
  const { YoutubeTranscript } = await import("youtube-transcript");
  const transcript = await YoutubeTranscript.fetchTranscript(url);
  return transcript.map((entry) => entry.text).join(" ");
};

const extractYoutubeId = (url = "") => {
  const match = String(url).match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})/);
  return match?.[1] || null;
};

const fetchYoutubeOEmbed = async (url) => {
  try {
    const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
};

const collapseWhitespace = (value = "") => value.replace(/\s+/g, " ").trim();

const pickMeta = ($, selectors) => {
  for (const selector of selectors) {
    const value = $(selector).attr("content") || $(selector).text();
    if (value && collapseWhitespace(value)) return collapseWhitespace(value);
  }
  return "";
};

const filenameFromUrl = (url = "") => {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(path.basename(parsed.pathname)) || "Saved asset";
  } catch {
    return "Saved asset";
  }
};

const titleFromFilename = (url = "") => {
  const file = filenameFromUrl(url).replace(/\.[a-z0-9]+$/i, "");
  return file.replace(/[-_]+/g, " ").trim() || "Saved image";
};

const extractReadableText = ($) => {
  const preferred = ["article", "main", "[role='main']", ".post-content", ".article-content", ".entry-content", ".content"];
  for (const selector of preferred) {
    const text = collapseWhitespace($(selector).text());
    if (text.length > 280) return text;
  }
  const paragraphs = $("p")
    .map((_, node) => collapseWhitespace($(node).text()))
    .get()
    .filter((text) => text.length > 40);
  if (paragraphs.length) return paragraphs.join(" ");
  return collapseWhitespace($("body").text());
};

const extractTweetFromHtml = ($, url) => {
  const description = pickMeta($, ["meta[property='og:description']", "meta[name='twitter:description']", "meta[name='description']"]);
  const title = pickMeta($, ["meta[property='og:title']", "meta[name='twitter:title']"]) || "Saved tweet";
  const authorMatch = title.match(/^(.*?) on X/i) || title.match(/^(.*?) on Twitter/i);
  const author = authorMatch?.[1] || pickMeta($, ["meta[name='author']"]);
  const thumbnailUrl = pickMeta($, ["meta[property='og:image']", "meta[name='twitter:image']"]) || null;
  const handleMatch = url.match(/(?:twitter|x)\.com\/([^/]+)/i);
  return {
    sourceType: "tweet",
    title: author ? `${author} post` : title,
    description,
    author,
    thumbnailUrl,
    text: description || title,
    metadata: {
      handle: handleMatch?.[1] || null,
      platform: /x\.com/i.test(url) ? "x" : "twitter"
    }
  };
};

const extractYoutubeFromHtml = ($, transcriptText = "", oembed = null, url = "") => {
  const title =
    oembed?.title ||
    pickMeta($, ["meta[property='og:title']", "meta[name='twitter:title']"]) ||
    collapseWhitespace($("title").text()) ||
    "Saved YouTube video";
  const description =
    pickMeta($, ["meta[name='description']", "meta[property='og:description']", "meta[name='twitter:description']"]) ||
    "";
  const author =
    oembed?.author_name ||
    pickMeta($, ["meta[itemprop='author']", "meta[name='author']", "link[itemprop='name']", "meta[property='og:video:tag']"]) ||
    "";
  const thumbnailUrl = oembed?.thumbnail_url || pickMeta($, ["meta[property='og:image']", "meta[name='twitter:image']"]) || null;
  const keywordText = pickMeta($, ["meta[name='keywords']", "meta[property='og:video:tag']"]) || "";
  const keywords = keywordText
    .split(",")
    .map((value) => collapseWhitespace(value))
    .filter(Boolean)
    .slice(0, 12);
  const videoId = extractYoutubeId(url);

  return {
    sourceType: "youtube",
    title,
    description,
    author,
    thumbnailUrl,
    text: [title, author, description, keywords.join(" "), transcriptText].filter(Boolean).join(". "),
    metadata: {
      platform: "youtube",
      transcriptAvailable: Boolean(collapseWhitespace(transcriptText)),
      keywords,
      videoId,
      embedUrl: videoId ? `https://www.youtube.com/embed/${videoId}` : null
    }
  };
};

const fetchUrl = (url) =>
  fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    }
  });

const extractFromUrl = async (url, hintedSourceType) => {
  const response = await fetchUrl(url);
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("image/")) {
    const title = titleFromFilename(url);
    return {
      sourceType: "image",
      title,
      description: `Saved image: ${filenameFromUrl(url)}`,
      thumbnailUrl: url,
      text: `Image saved from ${url}. File name: ${filenameFromUrl(url)}. OCR not enabled.`,
      metadata: {
        imageUrl: url,
        contentType,
        ocr: "optional"
      }
    };
  }

  if (contentType.includes("pdf")) {
    const buffer = Buffer.from(await response.arrayBuffer());
    const parsed = await pdfParse(buffer);
    return {
      sourceType: "pdf",
      title: titleFromFilename(url),
      text: parsed.text,
      metadata: { pages: parsed.numpages, contentType }
    };
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  if (hintedSourceType === "tweet" || isTweetUrl(url)) {
    const tweet = extractTweetFromHtml($, url);
    return { ...tweet, metadata: { ...tweet.metadata, contentType } };
  }
  if (hintedSourceType === "youtube" || isYoutubeUrl(url)) {
    const oembed = await fetchYoutubeOEmbed(url);
    const youtube = extractYoutubeFromHtml($, "", oembed, url);
    return { ...youtube, metadata: { ...youtube.metadata, contentType } };
  }

  const title =
    pickMeta($, ["meta[property='og:title']", "meta[name='twitter:title']"]) ||
    collapseWhitespace($("title").text()) ||
    collapseWhitespace($("h1").first().text()) ||
    titleFromFilename(url);
  const description = pickMeta($, ["meta[name='description']", "meta[property='og:description']", "meta[name='twitter:description']"]);
  const author = pickMeta($, ["meta[name='author']", "meta[property='article:author']", "[rel='author']"]);
  const thumbnailUrl = pickMeta($, ["meta[property='og:image']", "meta[name='twitter:image']"]) || null;
  const text = extractReadableText($);

  return {
    sourceType: hintedSourceType || "url",
    title,
    description,
    author,
    thumbnailUrl,
    text,
    metadata: {
      siteName: pickMeta($, ["meta[property='og:site_name']"]) || null,
      language: $("html").attr("lang") || null,
      contentType
    }
  };
};

const extractContent = async (item) => {
  if (item.source_type === "text" || item.source_type === "note") {
    return { sourceType: item.source_type, title: item.title, text: item.raw_content || item.title, metadata: item.metadata || {} };
  }

  if (item.source_type === "youtube" || isYoutubeUrl(item.url || "")) {
    let transcriptText = "";
    try {
      transcriptText = await extractYoutubeTranscript(item.url);
    } catch (error) {
      app.log.warn({ url: item.url, error: error.message }, "YouTube transcript unavailable, falling back to page metadata");
    }

    try {
      const [response, oembed] = await Promise.all([fetchUrl(item.url), fetchYoutubeOEmbed(item.url)]);
      const html = await response.text();
      const $ = cheerio.load(html);
      const extracted = extractYoutubeFromHtml($, transcriptText, oembed, item.url);
      return {
        sourceType: "youtube",
        title: extracted.title || item.title || "Saved YouTube video",
        description: extracted.description,
        author: extracted.author,
        thumbnailUrl: extracted.thumbnailUrl,
        text: extracted.text || transcriptText || item.title || item.url,
        metadata: {
          ...(item.metadata || {}),
          ...(extracted.metadata || {}),
          contentType: response.headers.get("content-type") || null
        }
      };
    } catch (error) {
      app.log.warn({ url: item.url, error: error.message }, "YouTube metadata fallback failed");
      return {
        sourceType: "youtube",
        title: item.title || "Saved YouTube video",
        description: "YouTube video saved. Transcript or page metadata was not available.",
        thumbnailUrl: item.thumbnail_url || null,
        text: [item.title, transcriptText, item.url].filter(Boolean).join(". "),
        metadata: {
          ...(item.metadata || {}),
          platform: "youtube",
          videoId: extractYoutubeId(item.url),
          transcriptAvailable: Boolean(collapseWhitespace(transcriptText))
        }
      };
    }
  }

  if (item.source_type === "pdf") {
    return extractFromUrl(item.url, item.source_type);
  }

  if (item.source_type === "image") {
    return {
      sourceType: "image",
      title: item.title || titleFromFilename(item.url),
      description: item.description || `Saved image: ${filenameFromUrl(item.url)}`,
      thumbnailUrl: item.url,
      text: `Image saved from ${item.url}. File name: ${filenameFromUrl(item.url)}. OCR not enabled.`,
      metadata: { ...(item.metadata || {}), imageUrl: item.url, ocr: "optional" }
    };
  }

  return extractFromUrl(item.url, item.source_type);
};

const callJson = async (url, options = {}) => {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`Request failed: ${url}`);
  return response.json();
};

new Worker(
  "ingestion",
  async (job) => {
    const itemPayload = await callJson(`${contentServiceUrl}/items/${job.data.itemId}?userId=${job.data.userId}`);
    const item = itemPayload.item;
    const extracted = await extractContent(item);
    const normalizedSourceType = extracted.sourceType || item.source_type;
    const aiInput = extracted.text || extracted.description || extracted.title || item.title;
    const ai = await callJson(`${aiServiceUrl}/process`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: aiInput,
        title: extracted.title || item.title,
        sourceType: normalizedSourceType,
        imageUrl: extracted.thumbnailUrl || item.thumbnail_url || null
      })
    });

    await callJson(`${contentServiceUrl}/internal/items/${item.id}/process`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: normalizedSourceType,
        title: extracted.title || item.title,
        description: extracted.description,
        author: extracted.author,
        thumbnailUrl: extracted.thumbnailUrl,
        rawContent: aiInput,
        cleanedContent: ai.cleanedText,
        summary: ai.summary,
        keywords: ai.keywords,
        aiTags: ai.tags,
        embedding: ai.embedding,
        metadata: { ...(extracted.metadata || {}), detectedSourceType: normalizedSourceType },
        status: "processed"
      })
    });

    await callJson(`${searchServiceUrl}/index/${item.id}`, { method: "POST" });
    await callJson(`${graphServiceUrl}/rebuild/${item.id}?userId=${job.data.userId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: job.data.userId })
    });
  },
  { connection: redis }
).on("failed", (job, error) => {
  app.log.error({ jobId: job?.id, error: error.message }, "Ingestion job failed");
});


