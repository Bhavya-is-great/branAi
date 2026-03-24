"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { connectRealtime, createCollection, deleteItem, getCollections, getDemoToken, getGraph, getItems, getResurface, reprocessItem, saveItem } from "../lib/api";
import { SearchBar } from "../components/search-bar";
import { GraphPanel } from "../components/graph-panel";

const isYoutubeUrl = (value = "") => /(?:youtube\.com|youtu\.be|m\.youtube\.com|youtube-nocookie\.com)/i.test(String(value));
const isTweetUrl = (value = "") => /(?:twitter\.com|x\.com)/i.test(String(value));
const isImageUrl = (value = "") => /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(String(value));
const isPdfUrl = (value = "") => /\.pdf(\?|$)/i.test(String(value));

const inferSourceType = (value = "") => {
  if (isYoutubeUrl(value)) return "youtube";
  if (isTweetUrl(value)) return "tweet";
  if (isImageUrl(value)) return "image";
  if (isPdfUrl(value)) return "pdf";
  return "url";
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
    await deleteItem(token, itemId);
  };

  const handleReprocess = async (event, itemId) => {
    event.preventDefault();
    event.stopPropagation();
    if (!token) return;
    await reprocessItem(token, itemId);
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
                <p className="mt-2 font-semibold">{item.title}</p>
                <p className="mt-1 text-sm text-slate-600">{item.summary || item.description || "Waiting for AI processing..."}</p>
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
                <div className="flex items-center justify-between">
                  <p className="font-semibold">{collection.name}</p>
                  <span className="badge">{collection.item_count} items</span>
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
          {filteredItems.slice(0, 12).map((item) => (
            <div key={item.id} className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-4">
                    <Link href={`/items/${item.id}`} className="min-w-0 flex-1">
                      <p className="truncate font-semibold">{item.title}</p>
                    </Link>
                    <span className="badge">{item.collection_name || item.metadata?.detectedSourceType || item.source_type}</span>
                  </div>
                  <p className="mt-2 text-sm text-slate-600">{item.summary || item.description || "Queued for processing"}</p>
                  {!!(item.ai_tags || []).length && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {item.ai_tags.slice(0, 5).map((tag) => (
                        <span key={tag} className="rounded-full bg-amber-100 px-2 py-1 text-[11px] font-semibold text-amber-800">{tag}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 flex-col gap-2">
                  <button className="rounded-xl border border-slate-200 px-3 py-2 text-sm" onClick={(event) => handleReprocess(event, item.id)}>Reprocess</button>
                  <button className="rounded-xl bg-rose-600 px-3 py-2 text-sm text-white" onClick={(event) => handleDelete(event, item.id)}>Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
