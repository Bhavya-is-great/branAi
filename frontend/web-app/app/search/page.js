"use client";

import { useState } from "react";
import { getCollections, getDemoToken, searchItems } from "../../lib/api";

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [filters, setFilters] = useState({ type: "", collectionId: "", dateFrom: "", dateTo: "" });
  const [collections, setCollections] = useState([]);
  const [filtersApplied, setFiltersApplied] = useState(null);

  const ensureCollections = async (token) => {
    if (collections.length) return;
    const data = await getCollections(token);
    setCollections(data.collections || []);
  };

  const runSearch = async () => {
    const token = await getDemoToken();
    await ensureCollections(token);
    const data = await searchItems(token, { q: query, ...filters });
    setResults(data.results || []);
    setFiltersApplied(data.filtersApplied || null);
  };

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <div className="card p-6">
        <h1 className="text-3xl font-black">Semantic Search</h1>
        <p className="mt-2 text-slate-600">Try queries like "startup funding videos" or "AI articles from last month". You can also filter by content type, collection, and date range.</p>
        <div className="mt-5 flex gap-3">
          <input value={query} onChange={(event) => setQuery(event.target.value)} className="w-full rounded-2xl border border-slate-200 px-4 py-3" placeholder="Search your second brain" />
          <button className="rounded-2xl bg-pine px-5 py-3 font-semibold text-white" onClick={runSearch}>Search</button>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <select value={filters.type} onChange={(event) => setFilters((value) => ({ ...value, type: event.target.value }))} className="rounded-2xl border border-slate-200 px-4 py-3">
            <option value="">All types</option>
            <option value="url">Article</option>
            <option value="tweet">Tweet</option>
            <option value="image">Image</option>
            <option value="youtube">YouTube</option>
            <option value="pdf">PDF</option>
          </select>
          <select value={filters.collectionId} onChange={(event) => setFilters((value) => ({ ...value, collectionId: event.target.value }))} className="rounded-2xl border border-slate-200 px-4 py-3">
            <option value="">All collections</option>
            {collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}
          </select>
          <input type="date" value={filters.dateFrom} onChange={(event) => setFilters((value) => ({ ...value, dateFrom: event.target.value }))} className="rounded-2xl border border-slate-200 px-4 py-3" />
          <input type="date" value={filters.dateTo} onChange={(event) => setFilters((value) => ({ ...value, dateTo: event.target.value }))} className="rounded-2xl border border-slate-200 px-4 py-3" />
        </div>
        {filtersApplied ? <p className="mt-3 text-sm text-slate-500">Applied filters: {JSON.stringify(filtersApplied)}</p> : null}
      </div>
      <div className="mt-6 space-y-4">
        {results.map((item) => (
          <a key={item.id} href={`/items/${item.id}`} className="card block p-5">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-xl font-semibold">{item.title}</h2>
              <span className="badge">Score {(item.score || 0).toFixed(2)}</span>
            </div>
            <p className="mt-3 text-slate-600">{item.summary}</p>
            <p className="mt-2 text-xs uppercase tracking-[0.2em] text-slate-500">{item.metadata?.detectedSourceType || item.source_type}</p>
          </a>
        ))}
      </div>
    </main>
  );
}
