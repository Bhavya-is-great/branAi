require("dotenv").config({ path: require("node:path").resolve(__dirname, "../../../.env") });
const Fastify = require("fastify");
const cors = require("@fastify/cors");
const jwt = require("@fastify/jwt");
const rateLimit = require("@fastify/rate-limit");
const { Server } = require("socket.io");

const app = Fastify({ logger: true });
const port = Number(process.env.API_GATEWAY_PORT || 4000);
const services = {
  content: process.env.CONTENT_SERVICE_URL || `http://localhost:${process.env.CONTENT_SERVICE_PORT || 4101}`,
  search: process.env.SEARCH_SERVICE_URL || `http://localhost:${process.env.SEARCH_SERVICE_PORT || 4103}`,
  graph: process.env.GRAPH_SERVICE_URL || `http://localhost:${process.env.GRAPH_SERVICE_PORT || 4104}`
};

const upstreamJson = async (url, options = {}) => {
  const response = await fetch(url, options);
  const body = await response.text();
  let parsed = null;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    parsed = { message: body };
  }
  if (!response.ok) {
    const error = new Error(parsed?.message || `Upstream error: ${response.status}`);
    error.statusCode = response.status;
    error.payload = parsed;
    throw error;
  }
  return parsed;
};

app.register(cors, { origin: true });
app.register(jwt, { secret: process.env.JWT_SECRET || "change-me" });
app.register(rateLimit, { max: 200, timeWindow: "1 minute" });

app.decorate("authenticate", async (request, reply) => {
  try {
    await request.jwtVerify();
  } catch {
    reply.code(401).send({ message: "Unauthorized" });
  }
});

app.get("/health", async () => ({ ok: true, service: "api-gateway" }));

const signAuthResponse = async (user) => ({
  token: await app.jwt.sign({ userId: user.id, email: user.email }),
  user
});

app.get("/auth/demo", async () => signAuthResponse(await upstreamJson(`${services.content}/users/demo`, { method: "POST" })));
app.post("/auth/register", async (request) => signAuthResponse(await upstreamJson(`${services.content}/users/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(request.body)
})));
app.post("/auth/login", async (request) => signAuthResponse(await upstreamJson(`${services.content}/users/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(request.body)
})));

app.addHook("preHandler", async (request, reply) => {
  if (request.url.startsWith("/health") || request.url.startsWith("/auth/")) return;
  await app.authenticate(request, reply);
});

let io;
const emitUserEvent = (userId, type, payload = {}) => {
  if (!io) return;
  io.to(`user:${userId}`).emit("knowledge:event", {
    type,
    userId,
    timestamp: new Date().toISOString(),
    ...payload
  });
};

app.post("/save", async (request) => {
  const result = await upstreamJson(`${services.content}/save`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user-id": request.user.userId },
    body: JSON.stringify(request.body)
  });
  emitUserEvent(request.user.userId, "item:created", { itemId: result.item?.id, sourceType: request.body?.sourceType || result.item?.source_type });
  return result;
});

app.get("/items", async (request) => upstreamJson(`${services.content}/items?userId=${request.user.userId}`));
app.get("/items/:id", async (request) => upstreamJson(`${services.content}/items/${request.params.id}?userId=${request.user.userId}`));
app.patch("/items/:id", async (request) => {
  const result = await upstreamJson(`${services.content}/items/${request.params.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-user-id": request.user.userId },
    body: JSON.stringify(request.body)
  });
  emitUserEvent(request.user.userId, "item:updated", { itemId: request.params.id });
  return result;
});
app.delete("/items/:id", async (request) => {
  const result = await upstreamJson(`${services.content}/items/${request.params.id}?userId=${request.user.userId}`, {
    method: "DELETE",
    headers: { "x-user-id": request.user.userId }
  });
  emitUserEvent(request.user.userId, "item:deleted", { itemId: request.params.id });
  return result;
});
app.post("/items/:id/reprocess", async (request) => {
  const result = await upstreamJson(`${services.content}/items/${request.params.id}/reprocess`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user-id": request.user.userId },
    body: JSON.stringify({})
  });
  emitUserEvent(request.user.userId, "item:reprocess", { itemId: request.params.id });
  return result;
});
app.get("/collections", async (request) => upstreamJson(`${services.content}/collections?userId=${request.user.userId}`));
app.post("/collections", async (request) => {
  const result = await upstreamJson(`${services.content}/collections`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user-id": request.user.userId },
    body: JSON.stringify(request.body)
  });
  emitUserEvent(request.user.userId, "collection:created", { collectionId: result.collection?.id });
  return result;
});
app.post("/highlight", async (request) => upstreamJson(`${services.content}/highlight`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-user-id": request.user.userId },
  body: JSON.stringify(request.body)
}));
app.get("/resurface", async (request) => upstreamJson(`${services.content}/resurface?userId=${request.user.userId}`));
app.get("/search", async (request) => {
  const params = new URLSearchParams({ userId: request.user.userId, q: request.query.q || "" });
  ["type", "collectionId", "dateFrom", "dateTo"].forEach((key) => {
    if (request.query[key]) params.set(key, request.query[key]);
  });
  return upstreamJson(`${services.search}/search?${params.toString()}`);
});
app.get("/suggest", async (request) => upstreamJson(`${services.search}/suggest?userId=${request.user.userId}&q=${encodeURIComponent(request.query.q || "")}`));
app.get("/related/:id", async (request) => upstreamJson(`${services.graph}/related/${request.params.id}?userId=${request.user.userId}`));
app.get("/graph", async (request) => upstreamJson(`${services.graph}/graph?userId=${request.user.userId}&start=${request.query.start || ""}`));

app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  reply.code(error.statusCode || 500).send(error.payload || { message: error.message || "Internal server error" });
});

app.listen({ port, host: "0.0.0.0" }).then(() => {
  io = new Server(app.server, {
    cors: { origin: true, credentials: true }
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) throw new Error("Missing token");
      const payload = await app.jwt.verify(token);
      socket.user = payload;
      next();
    } catch {
      next(new Error("Unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.user?.userId;
    if (!userId) return socket.disconnect();
    socket.join(`user:${userId}`);
    socket.emit("knowledge:event", { type: "socket:ready", userId, timestamp: new Date().toISOString() });
  });
});
