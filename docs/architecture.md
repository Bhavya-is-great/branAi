# Second Brain AI Architecture

## Text Diagram

```text
+-------------------+        +--------------------+        +---------------------+
| Chrome Extension  | -----> | API Gateway        | -----> | Content Service     |
| Next.js Web App   |        | Fastify + JWT      |        | Postgres + Redis    |
+-------------------+        +--------------------+        +----------+----------+
                                                                      |
                                                                      v
                                                            +---------+---------+
                                                            | BullMQ / Redis    |
                                                            | ingestion queue   |
                                                            +---------+---------+
                                                                      |
                                                                      v
 +-------------------+      +--------------------+       +------------+-----------+
 | Search Service    | <--> | Worker Service     | ----> | AI Service             |
 | Qdrant + Trie +   |      | extraction + jobs  |       | OpenAI + heuristics    |
 | LRU + hybrid rank |      +--------------------+       +------------+-----------+
 +---------+---------+                                                |
           |                                                          v
           |                                              +-----------+----------+
           +--------------------------------------------> | Graph Service        |
                                                          | adjacency + PageRank |
                                                          +----------------------+
```

## Data Structures

- Adjacency list graph
- BFS and DFS traversal
- Connected components detection
- PageRank-style importance scoring
- Inverted index for keyword search
- Trie for autocomplete
- LRU cache for hot search results
- Min-heap priority queue for resurfacing
- Cosine similarity for embeddings
- K-means clustering for topical grouping
- Time-decay scoring for rediscovery
