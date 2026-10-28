"use client";

import { useMemo } from "react";
import L from "leaflet";
import { CircleMarker, GeoJSON, LayersControl, LayerGroup, MapContainer, ScaleControl, TileLayer, Tooltip } from "react-leaflet";
import type { MapLayer, MapLegend, MapSpec, VoteMode } from "@/lib/types";
import { fmtValue } from "@/lib/format";

const MISSING = "#e5e7eb";

function colorFor(v: unknown, legend: MapLegend | undefined) {
  const classes = legend?.classes;
  if (typeof v !== "number" || !Number.isFinite(v) || !classes?.length) return MISSING;
  for (const c of classes) if (v <= c.max) return c.color;
  return classes[classes.length - 1].color;
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Carte interactive : zoom, déplacement, couches activables, infobulles avec valeur et source. */
export default function MapView({ map: map0, height = 460, mode }: { map: MapSpec; height?: number; mode?: VoteMode }) {
  // Lecture du vote (voix / inscrits) : légende et propriété colorée de la couche principale.
  const md = map0.modes?.find((x) => x.id === mode) ?? map0.modes?.[0];
  const map = useMemo<MapSpec>(
    () => (md ? { ...map0, legend: md.legend, layers: map0.layers.map((l, i) => (i === 0 && l.valueProperty ? { ...l, valueProperty: md.valueProperty, label: md.layerLabel } : l)) } : map0),
    [map0, md],
  );
  const bounds = useMemo(() => (map.bbox ? L.latLngBounds([map.bbox[1], map.bbox[0]], [map.bbox[3], map.bbox[2]]) : undefined), [map.bbox]);

  const polygonLayer = (l: MapLayer) => (
    <GeoJSON
      key={`${l.id}-${l.valueProperty ?? ""}`}
      data={l.data}
      style={(f) => {
        const p = (f?.properties ?? {}) as Record<string, unknown>;
        if (l.outlineOnly) return { color: l.color ?? "#111827", weight: 2.5, fill: false };
        return {
          color: p.bv != null ? "#4b5563" : "#ffffff",
          weight: p.bv != null ? 1 : 0.6,
          fillColor: l.valueProperty ? colorFor(p[l.valueProperty], map.legend) : ((p.color as string) ?? l.color ?? "#cbd5e1"),
          fillOpacity: 0.8,
        };
      }}
      onEachFeature={(f, layer) => {
        const p = (f.properties ?? {}) as Record<string, unknown>;
        if (l.labelProperty && p[l.labelProperty]) {
          layer.bindTooltip(esc(p[l.labelProperty]), { permanent: true, direction: "center", className: "map-label" });
          return;
        }
        const val = l.valueProperty ? `<br>${esc(l.label)} : <b>${p[l.valueProperty] == null ? "n.d." : esc(fmtValue(p[l.valueProperty] as number, map.legend?.unit ?? "nombre"))}</b>` : "";
        layer.bindTooltip(`<b>${esc(p.nom ?? p.name ?? "")}</b>${val}<br><span style="color:#8a8984">Source : ${esc(l.source.name)}</span>`, { sticky: true });
      }}
    />
  );

  const pointLayer = (l: MapLayer) => (
    <LayerGroup key={l.id}>
      {l.data.features.map((f, i) => {
        const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates;
        const p = (f.properties ?? {}) as Record<string, unknown>;
        return (
          <CircleMarker key={i} center={[lat, lon]} radius={6} pathOptions={{ color: "#fff", weight: 1.5, fillColor: (p.color as string) ?? l.color ?? "#111", fillOpacity: 1 }}>
            <Tooltip>
              <b>{String(p.name ?? "")}</b>
              {p.categoryLabel ? <div>{String(p.categoryLabel)}</div> : null}
              {typeof p.voyageurs === "number" ? <div>{fmtValue(p.voyageurs, "nombre")} voyageurs / an</div> : null}
              <div style={{ color: "#8a8984" }}>Source : {l.source.name}</div>
            </Tooltip>
          </CircleMarker>
        );
      })}
    </LayerGroup>
  );

  const lineLayer = (l: MapLayer) => <GeoJSON key={l.id} data={l.data} style={{ color: l.color ?? "#1baf7a", weight: 3 }} />;

  return (
    <div>
      <MapContainer bounds={bounds} style={{ height, borderRadius: 8 }} scrollWheelZoom={false}>
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">contributeurs OpenStreetMap</a>' url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <ScaleControl imperial={false} />
        <LayersControl position="topright" collapsed={false}>
          {map.layers.map((l) => (
            <LayersControl.Overlay key={l.id} name={`${esc(l.label)} (${l.data.features.length})`} checked={l.visible}>
              {l.kind === "polygons" ? polygonLayer(l) : l.kind === "lines" ? lineLayer(l) : pointLayer(l)}
            </LayersControl.Overlay>
          ))}
        </LayersControl>
      </MapContainer>
      {map.legend && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="font-semibold">{map.legend.title}</span>
          {map.legend.classes?.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              <span className="inline-block h-3 w-5 rounded-sm" style={{ background: c.color }} />
              {c.label ?? `${fmtValue(c.min, map.legend!.unit ?? "nombre")} – ${fmtValue(c.max, map.legend!.unit ?? "nombre")}`}
            </span>
          ))}
          {map.legend.classes && (
            <span className="flex items-center gap-1">
              <span className="inline-block h-3 w-5 rounded-sm" style={{ background: MISSING }} />
              {map.legend.missingLabel ?? "n.d."}
            </span>
          )}
          {map.legend.categories?.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              <span className="inline-block h-3 w-3 rounded-full" style={{ background: c.color }} />
              {c.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
