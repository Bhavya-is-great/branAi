"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const palette = ["#f97316", "#38bdf8", "#a3e635", "#f472b6", "#facc15", "#c084fc"];
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const FLOOR_Y = 220;

const compactText = (value = "", limit = 26) => {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "Untitled item";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
};

const displayTitle = (node) => {
  const title = String(node?.title || "").trim();
  if (title && !/^https?:\/\//i.test(title)) return compactText(title, 28);
  const url = String(node?.url || node?.title || "").trim();
  if (!url) return "Untitled item";
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname.split("/").filter(Boolean).slice(-1)[0] || parsed.searchParams.get("q") || parsed.searchParams.get("v") || "";
    return compactText(path ? `${host} / ${path}` : host, 28);
  } catch {
    return compactText(url, 28);
  }
};

const makeBaseLayout = (nodes = []) => {
  if (!nodes.length) return [];

  const raw = nodes.map((node, index) => ({
    ...node,
    label: displayTitle(node),
    rawX: Number.isFinite(node.vector3d?.x) ? node.vector3d.x : Math.cos((index / Math.max(nodes.length, 1)) * Math.PI * 2),
    rawY: Number.isFinite(node.vector3d?.y) ? node.vector3d.y : Math.sin((index / Math.max(nodes.length, 1)) * Math.PI * 2),
    rawZ: Number.isFinite(node.vector3d?.z) ? node.vector3d.z : 0
  }));

  const minX = Math.min(...raw.map((node) => node.rawX));
  const maxX = Math.max(...raw.map((node) => node.rawX));
  const minY = Math.min(...raw.map((node) => node.rawY));
  const maxY = Math.max(...raw.map((node) => node.rawY));
  const minZ = Math.min(...raw.map((node) => node.rawZ));
  const maxZ = Math.max(...raw.map((node) => node.rawZ));

  const spanX = Math.max(0.0001, maxX - minX);
  const spanY = Math.max(0.0001, maxY - minY);
  const spanZ = Math.max(0.0001, maxZ - minZ);

  return raw.map((node) => {
    const normalizedX = ((node.rawX - minX) / spanX - 0.5) * 700;
    const normalizedY = ((node.rawY - minY) / spanY - 0.5) * 360;
    const normalizedZ = (node.rawZ - minZ) / spanZ;
    return {
      ...node,
      baseX: normalizedX,
      baseY: normalizedY,
      depth: normalizedZ,
      color: palette[(node.cluster || 0) % palette.length],
      radius: 14 + Math.max(0, (node.importance_score || 0) * 24) + normalizedZ * 10
    };
  });
};

export function GraphPanel({ graph }) {
  const panelRef = useRef(null);
  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 });
  const [drag, setDrag] = useState(null);
  const [hoveredId, setHoveredId] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const nodes = useMemo(() => makeBaseLayout(graph.nodes || []), [graph.nodes]);
  const edges = graph.edges || [];
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const connectedIds = useMemo(() => {
    if (!hoveredId) return new Set();
    const ids = new Set([hoveredId]);
    edges.forEach((edge) => {
      if (edge.from_item_id === hoveredId) ids.add(edge.to_item_id);
      if (edge.to_item_id === hoveredId) ids.add(edge.from_item_id);
    });
    return ids;
  }, [edges, hoveredId]);

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    const element = panelRef.current;
    if (!element) return;
    const onWheel = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const nextScale = clamp(viewport.scale - event.deltaY * 0.001, 0.35, 3.2);
      setViewport((value) => ({ ...value, scale: nextScale }));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [viewport.scale]);

  const handleMouseDown = (event) => setDrag({ x: event.clientX, y: event.clientY });

  const handleMouseMove = (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    setDrag({ x: event.clientX, y: event.clientY });
    setViewport((value) => ({ ...value, x: value.x + dx, y: value.y + dy }));
  };

  const handleMouseUp = () => setDrag(null);

  const toggleFullscreen = async () => {
    if (!panelRef.current) return;
    if (!document.fullscreenElement) await panelRef.current.requestFullscreen();
    else await document.exitFullscreen();
  };

  return (
    <div ref={panelRef} className={`mt-6 rounded-3xl bg-slate-950 p-4 text-white ${isFullscreen ? "h-screen w-screen rounded-none p-6" : ""}`}>
      <div className="mb-3 flex items-center justify-between text-xs uppercase tracking-[0.2em] text-slate-400">
        <span>2D Knowledge Map</span>
        <div className="flex items-center gap-3">
          <span>{graph.components?.length || 0} topic islands</span>
          <button onClick={toggleFullscreen} className="rounded-xl border border-white/15 px-3 py-2 text-[11px] font-semibold text-white">
            {isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
          </button>
        </div>
      </div>
      <div className="mb-3 flex items-center justify-between text-[11px] uppercase tracking-[0.2em] text-slate-500">
        <span>X/Y = map position</span>
        <span>Z axis = vertical stem + shadow + depth meter</span>
      </div>
      <div className="overflow-hidden rounded-2xl border border-white/10 overscroll-contain" onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}>
        <svg viewBox="0 0 880 560" className={`w-full cursor-grab active:cursor-grabbing bg-[radial-gradient(circle_at_top,_rgba(249,115,22,0.12),_transparent_36%),linear-gradient(180deg,_rgba(15,23,42,0.96),_rgba(2,6,23,1))] ${isFullscreen ? "h-[calc(100vh-170px)]" : "h-[560px]"}`}>
          <g transform={`translate(${440 + viewport.x} ${240 + viewport.y}) scale(${viewport.scale})`}>
            <line x1="-390" y1={FLOOR_Y} x2="390" y2={FLOOR_Y} stroke="rgba(148,163,184,0.16)" strokeWidth="1.5" />
            {edges.map((edge) => {
              const from = byId.get(edge.from_item_id);
              const to = byId.get(edge.to_item_id);
              if (!from || !to) return null;
              const active = hoveredId && (edge.from_item_id === hoveredId || edge.to_item_id === hoveredId);
              return (
                <line
                  key={edge.id}
                  x1={from.baseX}
                  y1={from.baseY}
                  x2={to.baseX}
                  y2={to.baseY}
                  stroke={active ? "rgba(251,191,36,0.95)" : "rgba(148,163,184,0.24)"}
                  strokeWidth={active ? Math.max(1.8, (edge.weight || 0) * 4.2) : Math.max(0.8, (edge.weight || 0) * 2.2)}
                />
              );
            })}

            {nodes.map((node) => {
              const dimmed = hoveredId && !connectedIds.has(node.id);
              const shadowY = FLOOR_Y;
              return (
                <a key={node.id} href={`/items/${node.id}`} onMouseEnter={() => setHoveredId(node.id)} onMouseLeave={() => setHoveredId(null)}>
                  <g opacity={dimmed ? 0.18 : 1}>
                    <line x1={node.baseX} y1={node.baseY} x2={node.baseX} y2={shadowY} stroke="rgba(148,163,184,0.28)" strokeWidth="1.5" strokeDasharray="4 4" />
                    <ellipse cx={node.baseX} cy={shadowY} rx={node.radius + node.depth * 16} ry={7 + node.depth * 4} fill={node.color} opacity="0.14" />
                    <circle cx={node.baseX} cy={node.baseY} r={node.radius + 8 + node.depth * 10} fill={node.color} opacity={0.08 + node.depth * 0.18} />
                    <circle cx={node.baseX} cy={node.baseY} r={node.radius} fill={node.color} opacity={0.7 + node.depth * 0.25} />
                    <text x={node.baseX} y={node.baseY + node.radius + 18} textAnchor="middle" fontSize="12" fill="#e2e8f0">
                      {node.label}
                    </text>
                  </g>
                </a>
              );
            })}
          </g>

          <g transform="translate(824 88)">
            <line x1="0" y1="0" x2="0" y2="180" stroke="rgba(148,163,184,0.5)" strokeWidth="2" />
            <circle cx="0" cy="0" r="12" fill="#f8fafc" opacity="0.95" />
            <circle cx="0" cy="180" r="6" fill="#64748b" opacity="0.7" />
            <text x="16" y="4" fontSize="11" fill="#e2e8f0">High Z</text>
            <text x="16" y="184" fontSize="11" fill="#94a3b8">Low Z</text>
          </g>
        </svg>
      </div>
      <p className="mt-3 text-xs text-slate-400">Drag to pan, use the mouse wheel to zoom, hover a node to highlight its connections, and use fullscreen for detailed exploration.</p>
      {!!hoveredId && <p className="mt-2 text-xs text-amber-300">Showing connections for {byId.get(hoveredId)?.label || hoveredId}</p>}
      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {nodes.slice(0, 6).map((node) => (
          <div key={node.id} className="min-w-0 rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-xs text-slate-300">
            <p className="truncate font-semibold text-white" title={node.title || node.url}>{node.label}</p>
            <p className="mt-1">cluster {node.cluster}</p>
            <p className="mt-1">importance {(node.importance_score || 0).toFixed(3)}</p>
            <p className="mt-1">z depth {node.depth.toFixed(2)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
