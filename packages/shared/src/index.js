const crypto = require("node:crypto");

class LRUCache {
  constructor(limit = 100) {
    this.limit = limit;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return null;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.limit) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
  }
}

class MinHeap {
  constructor(compare = (a, b) => a.score - b.score) {
    this.compare = compare;
    this.data = [];
  }

  push(value) {
    this.data.push(value);
    this.bubbleUp(this.data.length - 1);
  }

  pop() {
    if (this.data.length === 0) return null;
    const top = this.data[0];
    const tail = this.data.pop();
    if (this.data.length > 0) {
      this.data[0] = tail;
      this.bubbleDown(0);
    }
    return top;
  }

  bubbleUp(index) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(this.data[index], this.data[parent]) >= 0) break;
      [this.data[index], this.data[parent]] = [this.data[parent], this.data[index]];
      index = parent;
    }
  }

  bubbleDown(index) {
    while (true) {
      let smallest = index;
      const left = index * 2 + 1;
      const right = index * 2 + 2;
      if (left < this.data.length && this.compare(this.data[left], this.data[smallest]) < 0) smallest = left;
      if (right < this.data.length && this.compare(this.data[right], this.data[smallest]) < 0) smallest = right;
      if (smallest === index) break;
      [this.data[index], this.data[smallest]] = [this.data[smallest], this.data[index]];
      index = smallest;
    }
  }
}

class TrieNode {
  constructor() {
    this.children = new Map();
    this.words = new Set();
  }
}

class Trie {
  constructor() {
    this.root = new TrieNode();
  }

  insert(word) {
    let node = this.root;
    for (const char of word.toLowerCase()) {
      if (!node.children.has(char)) node.children.set(char, new TrieNode());
      node = node.children.get(char);
      node.words.add(word);
    }
  }

  searchPrefix(prefix, limit = 8) {
    let node = this.root;
    for (const char of prefix.toLowerCase()) {
      if (!node.children.has(char)) return [];
      node = node.children.get(char);
    }
    return Array.from(node.words).slice(0, limit);
  }
}

const tokenize = (input = "") =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

const stableEmbedding = (text, dimensions = 64) => {
  const vector = new Array(dimensions).fill(0);
  tokenize(text).forEach((token, tokenIndex) => {
    const hash = crypto.createHash("sha256").update(`${token}:${tokenIndex}`).digest();
    for (let i = 0; i < dimensions; i += 1) {
      vector[i] += (hash[i % hash.length] / 255) * (i % 2 === 0 ? 1 : -1);
    }
  });
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value ** 2, 0)) || 1;
  return vector.map((value) => Number((value / norm).toFixed(6)));
};

const cosineSimilarity = (left = [], right = []) => {
  if (!left.length || !right.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i] * right[i];
    leftNorm += left[i] ** 2;
    rightNorm += right[i] ** 2;
  }
  return dot / ((Math.sqrt(leftNorm) * Math.sqrt(rightNorm)) || 1);
};

const buildInvertedIndex = (items = []) => {
  const index = new Map();
  items.forEach((item) => {
    const terms = new Set(tokenize(`${item.title || ""} ${item.summary || ""} ${item.cleaned_content || ""}`));
    terms.forEach((term) => {
      if (!index.has(term)) index.set(term, new Set());
      index.get(term).add(item.id);
    });
  });
  return index;
};

const keywordScore = (query, item, invertedIndex) => {
  const terms = tokenize(query);
  if (!terms.length) return 0;
  const hits = terms.filter((term) => invertedIndex.get(term)?.has(item.id)).length;
  return hits / terms.length;
};

const hybridScore = ({ vectorScore, keywordScoreValue, freshness = 0, importance = 0 }) =>
  vectorScore * 0.45 + keywordScoreValue * 0.3 + freshness * 0.15 + importance * 0.1;

const timeDecayScore = ({ relevance, createdAt, lastViewedAt, importanceScore = 0 }) => {
  const ageDays = Math.max(1, (Date.now() - new Date(createdAt).getTime()) / 86400000);
  const recencyFactor = 1 / Math.log2(ageDays + 2);
  const viewedPenalty = lastViewedAt ? 0.82 : 1;
  return (relevance * 0.55 + recencyFactor * 0.25 + importanceScore * 0.2) * viewedPenalty;
};

const graphFromRelations = (relations = []) => {
  const adjacency = new Map();
  relations.forEach((relation) => {
    if (!adjacency.has(relation.from_item_id)) adjacency.set(relation.from_item_id, []);
    adjacency.get(relation.from_item_id).push({
      to: relation.to_item_id,
      weight: relation.weight,
      type: relation.relation_type
    });
    if (!adjacency.has(relation.to_item_id)) adjacency.set(relation.to_item_id, []);
  });
  return adjacency;
};

const bfs = (adjacency, start) => {
  if (!start) return [];
  const visited = new Set([start]);
  const queue = [start];
  const order = [];
  while (queue.length) {
    const node = queue.shift();
    order.push(node);
    for (const edge of adjacency.get(node) || []) {
      if (!visited.has(edge.to)) {
        visited.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return order;
};

const dfs = (adjacency, start, visited = new Set(), order = []) => {
  if (!start) return order;
  visited.add(start);
  order.push(start);
  for (const edge of adjacency.get(start) || []) {
    if (!visited.has(edge.to)) dfs(adjacency, edge.to, visited, order);
  }
  return order;
};

const connectedComponents = (adjacency) => {
  const visited = new Set();
  const components = [];
  for (const node of adjacency.keys()) {
    if (visited.has(node)) continue;
    const component = dfs(adjacency, node, visited, []);
    components.push(component);
  }
  return components;
};

const pageRank = (adjacency, iterations = 20, damping = 0.85) => {
  const nodes = Array.from(adjacency.keys());
  if (!nodes.length) return new Map();
  const rank = new Map(nodes.map((node) => [node, 1 / nodes.length]));
  for (let i = 0; i < iterations; i += 1) {
    const next = new Map(nodes.map((node) => [node, (1 - damping) / nodes.length]));
    nodes.forEach((node) => {
      const edges = adjacency.get(node) || [];
      const share = (rank.get(node) || 0) / (edges.length || nodes.length);
      if (!edges.length) {
        nodes.forEach((target) => next.set(target, (next.get(target) || 0) + damping * share));
      } else {
        edges.forEach((edge) => next.set(edge.to, (next.get(edge.to) || 0) + damping * share));
      }
    });
    next.forEach((value, key) => rank.set(key, value));
  }
  return rank;
};

const kMeans = (vectors = [], k = 3, iterations = 8) => {
  if (!vectors.length) return [];
  const centroids = vectors.slice(0, Math.min(k, vectors.length)).map((item) => [...item.vector]);
  let assignments = new Array(vectors.length).fill(0);
  for (let step = 0; step < iterations; step += 1) {
    assignments = vectors.map((item) => {
      let bestIndex = 0;
      let bestScore = -Infinity;
      centroids.forEach((centroid, index) => {
        const score = cosineSimilarity(item.vector, centroid);
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      });
      return bestIndex;
    });

    centroids.forEach((centroid, centroidIndex) => {
      const members = vectors.filter((_, index) => assignments[index] === centroidIndex);
      if (!members.length) return;
      for (let i = 0; i < centroid.length; i += 1) {
        centroid[i] = members.reduce((sum, member) => sum + member.vector[i], 0) / members.length;
      }
    });
  }
  return vectors.map((item, index) => ({ ...item, cluster: assignments[index] }));
};

const projectEmbedding3D = (vector = [], fallbackIndex = 0) => {
  const safe = Array.isArray(vector) && vector.length ? vector : stableEmbedding(`fallback-${fallbackIndex}`);
  return {
    x: Number((safe[0] || 0).toFixed(6)),
    y: Number((safe[1] || 0).toFixed(6)),
    z: Number((safe[2] || 0).toFixed(6))
  };
};

const createLogger = (serviceName) => ({
  info: (message, meta = {}) => console.log(JSON.stringify({ level: "info", serviceName, message, ...meta })),
  error: (message, meta = {}) => console.error(JSON.stringify({ level: "error", serviceName, message, ...meta }))
});

module.exports = {
  LRUCache,
  MinHeap,
  Trie,
  bfs,
  buildInvertedIndex,
  connectedComponents,
  cosineSimilarity,
  createLogger,
  dfs,
  graphFromRelations,
  hybridScore,
  kMeans,
  keywordScore,
  pageRank,
  projectEmbedding3D,
  stableEmbedding,
  timeDecayScore,
  tokenize
};
