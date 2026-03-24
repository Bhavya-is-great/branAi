"use client";

import { useState } from "react";
import { suggestItems } from "../lib/api";

export function SearchBar({ token }) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);

  const handleChange = async (value) => {
    setQuery(value);
    if (!value || !token) return setSuggestions([]);
    const data = await suggestItems(token, value);
    setSuggestions(data.suggestions || []);
  };

  return (
    <div>
      <input value={query} onChange={(event) => handleChange(event.target.value)} placeholder="Search suggestions" className="w-full rounded-2xl border border-slate-200 px-4 py-3" />
      {!!suggestions.length && (
        <div className="mt-3 flex flex-wrap gap-2">
          {suggestions.map((item) => (
            <a className="badge" key={item} href={`/search?q=${encodeURIComponent(item)}`}>{item}</a>
          ))}
        </div>
      )}
    </div>
  );
}
