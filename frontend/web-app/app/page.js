"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { connectRealtime, createCollection, deleteItem, getCollections, getDemoToken, getGraph, getItems, getResurface, reprocessItem, saveItem } from "../lib/api";
import { SearchBar } from "../components/search-bar";
import { GraphPanel } from "../components/graph-panel";

const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

const parseUrl = (value = "") => {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    if (/^[a-z][a-z\d+\-.]*:/i.test(raw)) return null;
    try {
      return new URL(`https://${raw}`);
    } catch {
      return null;
    }
  }
};

const extractYoutubeId = (value = "") => {
  const raw = String(value || "").trim();
  if (YOUTUBE_VIDEO_ID_PATTERN.test(raw)) return raw;

  const parsed = parseUrl(raw);
  if (!parsed) return null;

  const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
  const segments = parsed.pathname.split("/").filter(Boolean);

  if (host === "youtu.be") {
    const candidate = segments[0] || "";
    return YOUTUBE_VIDEO_ID_PATTERN.test(candidate) ? candidate : null;
  }

  if (!host.endsWith("youtube.com") && !host.endsWith("youtube-nocookie.com")) return null;

  if (parsed.pathname === "/watch") {
    const candidate = parsed.searchParams.get("v") || "";
    return YOUTUBE_VIDEO_ID_PATTERN.test(candidate) ? candidate : null;
  }

  const marker = segments[0] || "";
  const candidate = (["embed", "shorts", "live", "v"].includes(marker) ? segments[1] : "") || "";
  return YOUTUBE_VIDEO_ID_PATTERN.test(candidate) ? candidate : null;
};

const isYoutubeUrl = (value = "") => Boolean(extractYoutubeId(value));
const isTweetUrl = (value = "") => /(?:twitter\.com|x\.com)/i.test(String(value));
const isImageUrl = (value = "") => /(?:\.(png|jpe?g|gif|webp|svg)(\?|$)|gstatic\.com\/images|googleusercontent\.com|imgur\.com|unsplash\.com|images\.pexels\.com)/i.test(String(value));
const isPdfUrl = (value = "") => /\.pdf(\?|$)/i.test(String(value));

const inferSourceType = (value = "") => {
  if (isYoutubeUrl(value)) return "youtube";
  if (isTweetUrl(value)) return "tweet";
  if (isImageUrl(value)) return "image";
  if (isPdfUrl(value)) return "pdf";
  return "url";
};

const compactText = (value = "", limit = 140) => {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
};

const readableItemTitle = (item) => {
  const title = String(item?.title || "").trim();
  if (title && !/^https?:\/\//i.test(title)) return compactText(title, 88);
  const url = String(item?.url || item?.title || "").trim();
  if (!url) return "Untitled item";
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname === "/" ? "" : parsed.pathname.split("/").filter(Boolean).slice(-2).join("/");
    const search = parsed.searchParams.get("q") || parsed.searchParams.get("v") || "";
    const suffix = [path, search].filter(Boolean).join(" ");
    return compactText(suffix ? `${host} / ${suffix}` : host, 88);
  } catch {
    return compactText(url, 88);
  }
};

export default function HomePage() {
  const [token, setToken] = useState("");
  const [items, setItems] = useState([]);
  const [resurface, setResurface] = useState([]);
  const [graph, setGraph] = useState({ nodes: [], edges: [], components: [] });
  const [collections, setCollections] = useState([]);
  const [url, setUrl] = useState("");
  const [noteText, setNoteText] = useState("");
  const [noteTitle, setNoteTitle] = useState("");
  const [collectionName, setCollectionName] = useState("");
  const [activeCollectionId, setActiveCollectionId] = useState("");
  const [busyItemIds, setBusyItemIds] = useState({});

  const markBusy = (itemId, action, value = true) => {
    setBusyItemIds((current) => {
      const next = { ...current };
      if (!value) delete next[`${itemId}:${action}`];
      else next[`${itemId}:${action}`] = true;
      return next;
    });
  };

  const reload = async (currentToken) => {
    const [itemsData, resurfaced, graphData, collectionData] = await Promise.all([
      getItems(currentToken),
      getResurface(currentToken),
      getGraph(currentToken),
      getCollections(currentToken)
    ]);
    setItems(itemsData.items || []);
    setResurface(resurfaced.items || []);
    setGraph(graphData);
    setCollections(collectionData.collections || []);
  };

  useEffect(() => {
    let cleanup = () => {};
    getDemoToken().then(async (value) => {
      setToken(value);
      await reload(value);
      cleanup = connectRealtime(value, async (event) => {
        if (["item:created", "item:updated", "item:deleted", "item:reprocess", "collection:created"].includes(event?.type)) {
          await reload(value);
        }
      });
    });
    return () => cleanup();
  }, []);

  const hasPendingItems = useMemo(
    () => items.some((item) => !item.status || item.status === "queued" || item.status === "processing"),
    [items]
  );

  useEffect(() => {
    if (!token || !hasPendingItems) return;
    const interval = setInterval(() => {
      reload(token).catch(() => {});
    }, 2500);
    return () => clearInterval(interval);
  }, [token, hasPendingItems]);

  const filteredItems = useMemo(() => {
    if (!activeCollectionId) return items;
    return items.filter((item) => item.collection_id === activeCollectionId);
  }, [items, activeCollectionId]);

  const handleSave = async () => {
    if (!url || !token) return;
    await saveItem(token, { sourceType: inferSourceType(url), url, collectionId: activeCollectionId || null });
    setUrl("");
  };

  const handleSaveNote = async () => {
    if (!noteText || !token) return;
    await saveItem(token, {
      sourceType: "note",
      title: noteTitle || noteText.slice(0, 60),
      content: noteText,
      collectionId: activeCollectionId || null,
      metadata: { createdFrom: "dashboard-note" }
    });
    setNoteText("");
    setNoteTitle("");
  };

  const handleDelete = async (event, itemId) => {
    event.preventDefault();
    event.stopPropagation();
    if (!token) return;
    markBusy(itemId, "delete", true);
    const previousItems = items;
    setItems((current) => current.filter((item) => item.id !== itemId));
    try {
      await deleteItem(token, itemId);
    } catch (error) {
      setItems(previousItems);
      window.alert(error?.message || "Delete failed");
    } finally {
      markBusy(itemId, "delete", false);
    }
  };

  const handleReprocess = async (event, itemId) => {
    event.preventDefault();
    event.stopPropagation();
    if (!token) return;
    markBusy(itemId, "reprocess", true);
    setItems((current) => current.map((item) => item.id === itemId ? { ...item, status: "queued", summary: item.summary || "Queued for reprocessing..." } : item));
    try {
      await reprocessItem(token, itemId);
      await reload(token);
    } catch (error) {
      window.alert(error?.message || "Reprocess failed");
    } finally {
      markBusy(itemId, "reprocess", false);
    }
  };

  const handleCreateCollection = async () => {
    if (!collectionName || !token) return;
    await createCollection(token, { name: collectionName });
    setCollectionName("");
  };

  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      <section className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="card p-8">
          <p className="badge">Second Brain AI</p>
          <h1 className="mt-4 text-5xl font-black tracking-tight text-ink">Your saved knowledge should think back with you.</h1>
          <p className="mt-4 max-w-2xl text-lg text-slate-600">Save articles, tweets, images, YouTube videos, PDFs, and notes. The system extracts meaning, clusters ideas, builds relationships, and resurfaces useful memories later.</p>
          <div className="mt-6 flex gap-3">
            <input className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none" placeholder="Paste a URL to save" value={url} onChange={(event) => setUrl(event.target.value)} />
            <button className="rounded-2xl bg-ember px-5 py-3 font-semibold text-white" onClick={handleSave}>Save</button>
          </div>
          <p className="mt-2 text-sm text-slate-500">Detected type: {inferSourceType(url || "https://youtube.com/watch?v=demo")}</p>
          {hasPendingItems ? <p className="mt-2 text-xs text-amber-700">Processing queued items. This view auto-refreshes until analysis finishes.</p> : null}
          <div className="mt-6 grid gap-3">
            <input className="rounded-2xl border border-slate-200 px-4 py-3" placeholder="Quick note title" value={noteTitle} onChange={(event) => setNoteTitle(event.target.value)} />
            <textarea className="min-h-28 rounded-2xl border border-slate-200 px-4 py-3" placeholder="Write a note directly into your second brain" value={noteText} onChange={(event) => setNoteText(event.target.value)} />
            <button className="w-fit rounded-2xl bg-slate-900 px-5 py-3 font-semibold text-white" onClick={handleSaveNote}>Save Note</button>
          </div>
          <div className="mt-8">
            <SearchBar token={token} />
          </div>
        </div>
        <div className="card p-6">
          <h2 className="text-xl font-bold">Memory Resurfacing</h2>
          <div className="mt-4 space-y-3">
            {resurface.map((item) => (
              <div key={item.id} className="rounded-2xl bg-stone-50 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Resurfacing Score {(item.resurfacingScore || 0).toFixed(2)}</p>
                <p className="mt-2 font-semibold">{compactText(readableItemTitle(item), 80)}</p>
                <p className="mt-1 text-sm text-slate-600">{compactText(item.summary || item.description || "Waiting for AI processing...", 180)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mt-6 grid gap-6 lg:grid-cols-[0.75fr_1.25fr]">
        <div className="card p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold">Collections</h2>
            <select value={activeCollectionId} onChange={(event) => setActiveCollectionId(event.target.value)} className="rounded-xl border border-slate-200 px-3 py-2 text-sm">
              <option value="">All</option>
              {collections.map((collection) => (
                <option key={collection.id} value={collection.id}>{collection.name}</option>
              ))}
            </select>
          </div>
          <div className="mt-4 flex gap-2">
            <input className="w-full rounded-2xl border border-slate-200 px-4 py-3" placeholder="New collection name" value={collectionName} onChange={(event) => setCollectionName(event.target.value)} />
            <button className="rounded-2xl bg-slate-900 px-4 py-3 font-semibold text-white" onClick={handleCreateCollection}>Add</button>
          </div>
          <div className="mt-4 space-y-2">
            {collections.map((collection) => (
              <div key={collection.id} className="rounded-2xl bg-stone-50 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 truncate font-semibold">{compactText(collection.name, 28)}</p>
                  <span className="badge shrink-0">{collection.item_count} items</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="card p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold">Knowledge Graph</h2>
            <span className="text-sm text-slate-500">{graph.components?.length || 0} topic islands</span>
          </div>
          <GraphPanel graph={graph} />
        </div>
      </section>

      <section className="mt-6 card p-6">
        <h2 className="text-xl font-bold">Recent Items</h2>
        <div className="mt-4 space-y-3">
          {filteredItems.slice(0, 12).map((item) => {
            const isDeleting = !!busyItemIds[`${item.id}:delete`];
            const isReprocessing = !!busyItemIds[`${item.id}:reprocess`];
            return (
              <div key={item.id} className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0 flex-1 overflow-hidden">
                    <div className="flex flex-wrap items-start gap-3">
                      <Link href={`/items/${item.id}`} className="min-w-0 flex-1 overflow-hidden">
                        <p className="truncate font-semibold leading-6 text-slate-900" title={item.title || item.url}>{readableItemTitle(item)}</p>
                      </Link>
                      <span className="badge shrink-0">{compactText(item.collection_name || item.metadata?.detectedSourceType || item.source_type, 18)}</span>
                    </div>
                    <p className="mt-2 break-words text-sm text-slate-600" title={item.summary || item.description || "Queued for processing"}>{compactText(item.summary || item.description || "Queued for processing", 180)}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span>Status:</span>
                      <span className="rounded-full bg-slate-100 px-2 py-1 font-semibold text-slate-700">{item.status || "queued"}</span>
                    </div>
                    {!!(item.ai_tags || []).length && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {item.ai_tags.slice(0, 5).map((tag) => (
                          <span key={tag} className="rounded-full bg-amber-100 px-2 py-1 text-[11px] font-semibold text-amber-800">{compactText(tag, 18)}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-row gap-2 self-start md:flex-col">
                    <button disabled={isReprocessing} className="rounded-xl border border-slate-200 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60" onClick={(event) => handleReprocess(event, item.id)}>{isReprocessing ? "Queued..." : "Reprocess"}</button>
                    <button disabled={isDeleting} className="rounded-xl bg-rose-600 px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-60" onClick={(event) => handleDelete(event, item.id)}>{isDeleting ? "Deleting..." : "Delete"}</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}

