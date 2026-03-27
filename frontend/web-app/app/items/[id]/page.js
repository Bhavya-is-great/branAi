"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { deleteItem, getCollections, getDemoToken, getGraph, getItem, getRelated, reprocessItem, saveHighlight, updateItem } from "../../../lib/api";

const textLooksBinary = (value = "") => /\uFFFD|\u0000|ICC_PROFILE|JFIF|Exif|PNG|IHDR/.test(value) || value.length > 5000;
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

export default function ItemDetailPage() {
  const params = useParams();
  const itemId = Array.isArray(params?.id) ? params.id[0] : params?.id;
  const [item, setItem] = useState(null);
  const [related, setRelated] = useState([]);
  const [collections, setCollections] = useState([]);
  const [graphNode, setGraphNode] = useState(null);
  const [note, setNote] = useState("");
  const [editForm, setEditForm] = useState({ title: "", description: "", collectionId: "" });

  useEffect(() => {
    if (!itemId) return;
    getDemoToken().then(async (token) => {
      const [itemData, relatedData, collectionData, graphData] = await Promise.all([
        getItem(token, itemId),
        getRelated(token, itemId),
        getCollections(token),
        getGraph(token)
      ]);
      setItem(itemData.item);
      setEditForm({
        title: itemData.item?.title || "",
        description: itemData.item?.description || "",
        collectionId: itemData.item?.collection_id || ""
      });
      setRelated(relatedData.items || []);
      setCollections(collectionData.collections || []);
      setGraphNode((graphData.nodes || []).find((node) => node.id === itemId) || null);
    });
  }, [itemId]);

  const effectiveType = useMemo(() => {
    if (!item) return "";
    return item.metadata?.detectedSourceType || item.source_type;
  }, [item]);

  const isImageItem = useMemo(() => {
    if (!item) return false;
    return effectiveType === "image" || item.metadata?.contentType?.includes("image/") || /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(item.url || "");
  }, [item, effectiveType]);

  const isYoutubeItem = useMemo(() => {
    if (!item) return false;
    return effectiveType === "youtube" || isYoutubeUrl(item.url || "");
  }, [item, effectiveType]);

  const embeddingPreview = useMemo(() => {
    const embedding = item?.embedding;
    if (!Array.isArray(embedding) || !embedding.length) return "Embedding pending";
    return embedding.slice(0, 12).map((value) => Number(value).toFixed(3)).join(", ");
  }, [item]);

  const displayBody = useMemo(() => {
    if (!item) return "";
    if (isImageItem) return item.description || "Saved image asset.";
    const candidate = item.cleaned_content || item.raw_content || "";
    if (textLooksBinary(candidate)) return "This saved item appears to be a binary asset or malformed scrape output. Reprocess or re-save it to regenerate clean metadata.";
    return candidate || "Content is still being processed.";
  }, [item, isImageItem]);

  const addHighlight = async () => {
    if (!itemId) return;
    const selection = window.getSelection()?.toString();
    if (!selection) return;
    const token = await getDemoToken();
    await saveHighlight(token, { itemId, selectedText: selection, note });
    setNote("");
  };

  const handleDelete = async () => {
    const token = await getDemoToken();
    await deleteItem(token, itemId);
    window.location.href = "/";
  };

  const handleReprocess = async () => {
    const token = await getDemoToken();
    await reprocessItem(token, itemId);
    window.location.reload();
  };

  const handleUpdate = async () => {
    const token = await getDemoToken();
    const payload = await updateItem(token, itemId, editForm);
    setItem(payload.item);
  };

  if (!itemId) return <main className="p-8">Missing item id.</main>;
  if (!item) return <main className="p-8">Loading...</main>;

  return (
    <main className="mx-auto grid max-w-6xl gap-6 px-6 py-10 lg:grid-cols-[1.15fr_0.85fr]">
      <section className="card p-8">
        <div className="flex items-center justify-between gap-3">
          <span className="badge">{effectiveType}</span>
          <div className="flex gap-2">
            <button className="rounded-xl border border-slate-200 px-3 py-2 text-sm" onClick={handleReprocess}>Reprocess</button>
            <button className="rounded-xl bg-rose-600 px-3 py-2 text-sm text-white" onClick={handleDelete}>Delete</button>
          </div>
        </div>
        <h1 className="mt-4 text-4xl font-black">{item.title}</h1>
        <p className="mt-4 text-slate-600">{item.summary || item.description}</p>
        {item.url ? <a href={item.url} target="_blank" className="mt-3 block text-sm text-amber-700 underline">Open source</a> : null}

        {!!(item.ai_tags || []).length && (
          <div className="mt-5 flex flex-wrap gap-2">
            {(item.ai_tags || []).map((tag) => (
              <span key={tag} className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800">{tag}</span>
            ))}
          </div>
        )}

        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-stone-50 p-4 text-sm">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Cluster</p>
            <p className="mt-2 text-lg font-semibold text-slate-900">{graphNode?.cluster ?? "Pending"}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-stone-50 p-4 text-sm">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">3D Vector</p>
            <p className="mt-2 font-semibold text-slate-900">[{((graphNode?.vector3d?.x) || 0).toFixed(2)}, {((graphNode?.vector3d?.y) || 0).toFixed(2)}, {((graphNode?.vector3d?.z) || 0).toFixed(2)}]</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-stone-50 p-4 text-sm">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Importance</p>
            <p className="mt-2 text-lg font-semibold text-slate-900">{Number(item.importance_score || 0).toFixed(3)}</p>
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-950 p-4 text-xs leading-6 text-slate-200">
          <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400">Raw Embedding Preview</p>
          <p className="mt-2 break-all">{embeddingPreview}</p>
        </div>

        <div className="mt-6 grid gap-3 md:grid-cols-2">
          <input value={editForm.title} onChange={(event) => setEditForm((value) => ({ ...value, title: event.target.value }))} className="rounded-2xl border border-slate-200 px-4 py-3" />
          <select value={editForm.collectionId} onChange={(event) => setEditForm((value) => ({ ...value, collectionId: event.target.value }))} className="rounded-2xl border border-slate-200 px-4 py-3">
            <option value="">No collection</option>
            {collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}
          </select>
          <textarea value={editForm.description} onChange={(event) => setEditForm((value) => ({ ...value, description: event.target.value }))} className="md:col-span-2 min-h-24 rounded-2xl border border-slate-200 px-4 py-3" />
          <button className="w-fit rounded-2xl bg-slate-900 px-5 py-3 font-semibold text-white" onClick={handleUpdate}>Save Metadata</button>
        </div>

        {isYoutubeItem ? (
          <div className="mt-6 overflow-hidden rounded-3xl border border-slate-200 bg-stone-50">
            {item.metadata?.embedUrl ? (
              <iframe
                src={item.metadata.embedUrl}
                title={item.title}
                className="aspect-video w-full"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            ) : item.thumbnail_url ? (
              <img src={item.thumbnail_url} alt={item.title} className="max-h-[420px] w-full object-cover" />
            ) : null}
          </div>
        ) : null}

        {isImageItem && item.url ? (
          <div className="mt-6 overflow-hidden rounded-3xl border border-slate-200 bg-stone-50">
            <img src={item.url} alt={item.title} className="max-h-[520px] w-full object-contain bg-white" />
          </div>
        ) : null}

        <div className="mt-6 rounded-3xl bg-stone-50 p-5 text-sm leading-7 text-slate-700 whitespace-pre-wrap">
          {displayBody}
        </div>
        <div className="mt-6 flex gap-3">
          <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Attach a note to your selected highlight" className="w-full rounded-2xl border border-slate-200 px-4 py-3" />
          <button className="rounded-2xl bg-slate-900 px-5 py-3 font-semibold text-white" onClick={addHighlight}>Highlight</button>
        </div>
      </section>
      <aside className="card p-6">
        <h2 className="text-xl font-bold">Connected Ideas</h2>
        <div className="mt-4 space-y-3">
          {related.map((entry) => (
            <div key={entry.id} className="rounded-2xl bg-stone-50 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{entry.relation_type} {(entry.weight || 0).toFixed(2)}</p>
              <p className="mt-2 font-semibold">{entry.title}</p>
              <p className="mt-2 text-sm text-slate-600">{entry.summary || entry.description}</p>
            </div>
          ))}
        </div>
      </aside>
    </main>
  );
}


