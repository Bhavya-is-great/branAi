import { io } from "socket.io-client";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000";
let socketInstance = null;

const isRecoverableAuthFailure = (payload = {}) => {
  const message = String(payload?.message || "").toLowerCase();
  return payload?.statusCode === 401 || message.includes("unauthorized") || message.includes("items_user_id_fkey") || message.includes("not present in table \"users\"");
};

const rawRequest = async (path, options = {}) => {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(payload?.message || `Request failed: ${response.status}`);
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
};

const getStoredToken = () => (typeof window !== "undefined" ? localStorage.getItem("second-brain-token") : null);
const setStoredToken = (token) => {
  if (typeof window !== "undefined") localStorage.setItem("second-brain-token", token);
};
const clearStoredToken = () => {
  if (typeof window !== "undefined") localStorage.removeItem("second-brain-token");
};

export const getDemoToken = async (forceRefresh = false) => {
  if (!forceRefresh) {
    const existing = getStoredToken();
    if (existing) return existing;
  }
  const payload = await rawRequest("/auth/demo");
  setStoredToken(payload.token);
  return payload.token;
};

const authedRequest = async (path, token, options = {}, retry = true) => {
  try {
    return await rawRequest(path, {
      ...options,
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.headers || {})
      }
    });
  } catch (error) {
    if (retry && isRecoverableAuthFailure(error.payload || { message: error.message, statusCode: error.statusCode })) {
      clearStoredToken();
      const refreshedToken = await getDemoToken(true);
      return authedRequest(path, refreshedToken, options, false);
    }
    throw error;
  }
};

export const connectRealtime = (token, onEvent) => {
  if (typeof window === "undefined") return () => {};
  if (!socketInstance) {
    socketInstance = io(API_BASE_URL, {
      transports: ["websocket", "polling"],
      auth: { token }
    });
  } else {
    socketInstance.auth = { token };
    socketInstance.connect();
  }
  const handler = (payload) => onEvent?.(payload);
  socketInstance.on("knowledge:event", handler);
  return () => {
    socketInstance?.off("knowledge:event", handler);
  };
};

export const getItems = (token) => authedRequest("/items", token);
export const getItem = (token, id) => authedRequest(`/items/${id}`, token);
export const updateItem = (token, id, body) => authedRequest(`/items/${id}`, token, { method: "PATCH", body: JSON.stringify(body) });
export const deleteItem = (token, id) => authedRequest(`/items/${id}`, token, { method: "DELETE" });
export const reprocessItem = (token, id) => authedRequest(`/items/${id}/reprocess`, token, { method: "POST", body: JSON.stringify({}) });
export const getResurface = (token) => authedRequest("/resurface", token);
export const getGraph = (token) => authedRequest("/graph", token);
export const getRelated = (token, id) => authedRequest(`/related/${id}`, token);
export const getCollections = (token) => authedRequest("/collections", token);
export const createCollection = (token, body) => authedRequest("/collections", token, { method: "POST", body: JSON.stringify(body) });
export const searchItems = (token, params) => {
  const search = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value) search.set(key, value);
  });
  return authedRequest(`/search?${search.toString()}`, token);
};
export const suggestItems = (token, q) => authedRequest(`/suggest?q=${encodeURIComponent(q)}`, token);
export const saveItem = (token, body) => authedRequest("/save", token, { method: "POST", body: JSON.stringify(body) });
export const saveHighlight = (token, body) => authedRequest("/highlight", token, { method: "POST", body: JSON.stringify(body) });
