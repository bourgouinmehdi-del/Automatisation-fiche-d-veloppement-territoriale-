"use client";

import { useMemo, useRef, useState } from "react";
import L from "leaflet";
import { CircleMarker, GeoJSON, MapContainer, Marker, Popup, ScaleControl, TileLayer, Tooltip } from "react-leaflet";
import type { MapLayer, MapSpec } from "@/lib/types";
import { posterItems, type PosterItem } from "@/lib/render/poster-items";

/**
 * Carte « Où agir » interactive : les mêmes lieux numérotés que la carte
 * imprimée, sur un fond de plan zoomable ; couches activables, fiche de
 * chaque lieu au clic, liste cliquable qui centre la carte sur le lieu.
 */

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// Couches regroupées en interrupteurs (dans l'ordre d'affichage).
const TOGGLES: { key: string; label: string; layers: string[]; on: boolean }[] = [
  { key: "prio", label: "Bureaux prioritaires", layers: ["bv_prio"], on: true },
  { key: "hlm", label: "Logements sociaux", layers: ["hlm", "hlm_autres"], on: true },
  { key: "res", label: "Résidences Crous, foyers", layers: ["residences"], on: true },
  { key: "tract", label: "Tractage", layers: ["tractage", "ecoles"], on: true },
  { key: "bv", label: "Limites des bureaux", layers: ["bv_ctx"], on: true },
  { key: "qpv", label: "Quartiers prioritaires", layers: ["qpv"], on: true },
];

function badgeIcon(it: PosterItem, active: boolean) {
  return L.divIcon({
    className: "am-icon",
    html: `<span class="am-b am-${it.shape}${active ? " am-on" : ""}" style="--c:${it.color}"><span>${it.n}</span></span>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -12],
  });
}

function Details({ it }: { it: PosterItem }) {
  const lines = it.det.length ? it.det : [it.sub].filter(Boolean);
  return (
    <div className="text-[12.5px] leading-snug">
      <div className="mb-0.5 text-[11px] font-semibold" style={{ color: it.color }}>
        {it.action} · {it.group}
      </div>
      <div className="font-bold">{it.nom}</div>
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
      {it.quand ? <div className="mt-1 italic text-[#52514e]">Quand : {it.quand}</div> : null}
    </div>
  );
}

export default function ActionMap({ map, height = 520 }: { map: MapSpec; height?: number }) {
  // Deux lieux au même endroit (lieu de vote et résidence HLM) : léger décalage pour que les deux pastilles restent cliquables.
  const items = useMemo(() => {
    const xs = posterItems(map);
    const seen: [number, number][] = [];
    return xs.map((it) => {
      let at = it.at;
      let k = 0;
      while (seen.some((s) => Math.abs(s[0] - at[0]) < 0.0004 && Math.abs(s[1] - at[1]) < 0.00025) && k < 8) {
        k++;
        at = [it.at[0] + 0.00045 * Math.cos(k * 2.1), it.at[1] + 0.0003 * Math.sin(k * 2.1)];
      }
      seen.push(at);
      return { ...it, at };
    });
  }, [map]);
  const present = new Set(map.layers.filter((l) => l.data.features.length).map((l) => l.id));
  const toggles = TOGGLES.filter((t) => t.layers.some((id) => present.has(id)));
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(TOGGLES.map((t) => [t.key, t.on])));
  const [active, setActive] = useState<number | null>(null);
  const [lmap, setLmap] = useState<L.Map | null>(null);
  const markers = useRef(new Map<number, L.Marker>());
  const visible = (id: string) => {
    const t = TOGGLES.find((x) => x.layers.includes(id));
    return !t || on[t.key];
  };
  const layer = (id: string): MapLayer | undefined => map.layers.find((l) => l.id === id && l.data.features.length);
  const bounds = useMemo(() => (map.bbox ? L.latLngBounds([map.bbox[1], map.bbox[0]], [map.bbox[3], map.bbox[2]]) : undefined), [map.bbox]);
  const focus = (it: PosterItem) => {
    setActive(it.n);
    if (!lmap) return;
    // Petit écran : la liste est sous la carte, on remonte jusqu'à elle.
    const el = lmap.getContainer();
    if (el.getBoundingClientRect().top < 0) el.scrollIntoView({ behavior: "smooth", block: "start" });
    lmap.flyTo([it.at[1], it.at[0]], Math.max(lmap.getZoom(), 16), { duration: 0.6 });
    setTimeout(() => markers.current.get(it.n)?.openPopup(), 650);
  };
  const groups: { title: string; items: PosterItem[] }[] = [];
  for (const it of items) {
    const g = groups.find((x) => x.title === `${it.action} · ${it.group}`);
    if (g) g.items.push(it);
    else groups.push({ title: `${it.action} · ${it.group}`, items: [it] });
  }

  const poly = (id: string, style: L.PathOptions, tip?: (p: Record<string, unknown>) => string) => {
    const l = layer(id);
    if (!l || !visible(id)) return null;
    return (
      <GeoJSON
        key={`${id}-${on[TOGGLES.find((t) => t.layers.includes(id))?.key ?? ""]}`}
        data={l.data}
        style={() => style}
        onEachFeature={(f, lay) => {
          const t = tip?.((f.properties ?? {}) as Record<string, unknown>);
          if (t) lay.bindTooltip(t, { sticky: true });
        }}
      />
    );
  };
  const hlmDots = layer("hlm_autres");
  const hlmBig = layer("hlm");

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div>
        <div className="no-print mb-2 flex flex-wrap gap-1.5" role="group" aria-label="Couches de la carte">
          {toggles.map((t) => (
            <button
              key={t.key}
              type="button"
              aria-pressed={on[t.key]}
              onClick={() => setOn((s) => ({ ...s, [t.key]: !s[t.key] }))}
              className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${on[t.key] ? "border-[#4c0297] bg-[#4c0297] text-white" : "border-[var(--line)] bg-[var(--surface)] text-[var(--ink-2)]"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <MapContainer bounds={bounds} style={{ height: `min(${height}px, 72vh)`, borderRadius: 8 }} scrollWheelZoom={false} ref={setLmap}>
          <TileLayer
            // Tuiles OpenStreetMap (sans clé, comme les autres cartes de l'outil), atténuées pour que les lieux ressortent.
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">contributeurs OpenStreetMap</a>'
            url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
            className="am-tiles"
            maxZoom={19}
          />
          <ScaleControl imperial={false} />
          {poly("limite", { color: "#212320", weight: 2, dashArray: "6 4", fill: false })}
          {poly("bv_ctx", { color: "#8a8170", weight: 1, dashArray: "3 3", fill: false }, (p) => esc(p.nom))}
          {poly("bv_prio", { color: "#c98a00", weight: 2.5, fillColor: "#f3b51b", fillOpacity: 0.22 }, (p) => `<b>${esc(p.nom)}</b><br>${esc(p.sub)}`)}
          {poly("qpv", { color: "#4c0297", weight: 2, dashArray: "6 3", fill: false }, (p) => `Quartier prioritaire : <b>${esc(p.nom)}</b>${p.sub ? `<br>${esc(p.sub)}` : ""}`)}
          {hlmDots && visible("hlm_autres")
            ? hlmDots.data.features.map((f, i) => {
                const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates;
                const p = (f.properties ?? {}) as Record<string, unknown>;
                return (
                  <CircleMarker key={`d${i}`} center={[lat, lon]} radius={Number(p._r ?? 3)} pathOptions={{ color: "#fff", weight: 1, fillColor: "#e7b84a", fillOpacity: 0.9 }}>
                    <Tooltip>
                      <b>{String(p.nom)}</b>
                      <div>{String(p.sub)}</div>
                    </Tooltip>
                  </CircleMarker>
                );
              })
            : null}
          {hlmBig && visible("hlm")
            ? hlmBig.data.features.map((f, i) => {
                const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates;
                return <CircleMarker key={`h${i}`} center={[lat, lon]} radius={Number(f.properties?._r ?? 8)} pathOptions={{ color: "#212320", weight: 1, fillColor: "#f3b51b", fillOpacity: 0.75 }} interactive={false} />;
              })
            : null}
          {items
            .filter((it) => visible(it.layerId))
            .map((it) => (
              <Marker
                key={it.n}
                position={[it.at[1], it.at[0]]}
                icon={badgeIcon(it, active === it.n)}
                zIndexOffset={active === it.n ? 1000 : 0}
                eventHandlers={{ click: () => setActive(it.n) }}
                ref={(m) => {
                  if (m) markers.current.set(it.n, m);
                  else markers.current.delete(it.n);
                }}
              >
                <Popup maxWidth={260}>
                  <Details it={it} />
                </Popup>
              </Marker>
            ))}
        </MapContainer>
      </div>
      <aside className="max-h-[560px] overflow-y-auto rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3" aria-label="Où agir">
        <h4 className="mb-2 text-sm font-extrabold text-[#4c0297]">Où agir</h4>
        {items.length ? null : <p className="text-xs text-[var(--ink-2)]">Aucun lieu numéroté.</p>}
        {groups.map((g) => (
          <div key={g.title} className="mb-3">
            <div className="mb-1 text-[11px] font-semibold text-[var(--ink-2)]">{g.title}</div>
            <ol className="space-y-1">
              {g.items.map((it) => (
                <li key={it.n}>
                  <button
                    type="button"
                    onClick={() => focus(it)}
                    className={`flex w-full items-start gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-[var(--line)] ${active === it.n ? "bg-[var(--line)]" : ""}`}
                  >
                    <span className={`am-b am-${it.shape} am-sm`} style={{ ["--c" as string]: it.color }}>
                      <span>{it.n}</span>
                    </span>
                    <span>
                      <span className="block font-semibold">{it.nom}</span>
                      <span className="block text-[var(--ink-2)]">{it.sub}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </aside>
    </div>
  );
}
