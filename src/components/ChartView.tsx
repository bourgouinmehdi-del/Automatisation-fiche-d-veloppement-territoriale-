"use client";

import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartSpec } from "@/lib/types";
import { fmtNumber, fmtValue } from "@/lib/format";

/** Graphiques interactifs (survol, infobulles) ; palette catégorielle ordonnée. */
export const SERIES = ["#4c0297", "#d1271c", "#9c6ee8", "#f9a89e", "#212320", "#8f120a", "#c9adff", "#85877f"];

const short = (v: number) => (Math.abs(v) >= 10000 ? `${fmtNumber(v / 1000)} k` : fmtNumber(v, Math.abs(v) < 10 && !Number.isInteger(v) ? 1 : 0));

export default function ChartView({ chart: c }: { chart: ChartSpec }) {
  const tip = (v: unknown) => (typeof v === "number" ? fmtValue(v, c.unit) : "n.d.");
  const legend = c.series.length > 1 ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null;

  if (c.type === "line")
    return (
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={c.data} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
          <CartesianGrid stroke="#e9e3d3" vertical={false} />
          <XAxis dataKey={c.xKey} tick={{ fontSize: 11 }} />
          <YAxis tickFormatter={short} tick={{ fontSize: 11 }} domain={["auto", "auto"]} width={60} />
          <Tooltip formatter={tip} />
          {legend}
          {c.series.map((s, i) => (
            <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={SERIES[i]} strokeWidth={2} dot={{ r: 3 }} connectNulls={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );

  if (c.type === "pyramid") {
    const data = [...c.data].reverse().map((r) => ({ ...r, [c.series[0].key]: -(r[c.series[0].key] as number) }));
    return (
      <ResponsiveContainer width="100%" height={Math.max(220, data.length * 30 + 60)}>
        <BarChart data={data} layout="vertical" stackOffset="sign" margin={{ left: 10, right: 20 }}>
          <CartesianGrid stroke="#e9e3d3" horizontal={false} />
          <XAxis type="number" tickFormatter={(v) => short(Math.abs(v))} tick={{ fontSize: 11 }} />
          <YAxis type="category" dataKey={c.xKey} width={110} tick={{ fontSize: 11 }} />
          <Tooltip formatter={(v) => (typeof v === "number" ? fmtValue(Math.abs(v), c.unit) : "n.d.")} />
          {legend}
          {c.series.map((s, i) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} fill={SERIES[i]} stackId="p" radius={4} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    );
  }

  const horizontal = c.type === "hbar";
  const labelW = Math.min(240, Math.max(60, ...c.data.map((r) => String(r[c.xKey]).length * 6.5)));
  return (
    <ResponsiveContainer width="100%" height={horizontal ? Math.max(200, c.data.length * (c.series.length > 1 ? 34 : 24) + 60) : 300}>
      <BarChart data={c.data} layout={horizontal ? "vertical" : "horizontal"} margin={{ top: 10, right: 30, left: 10, bottom: 0 }} barGap={2}>
        <CartesianGrid stroke="#e9e3d3" vertical={horizontal} horizontal={!horizontal} />
        {horizontal ? (
          <>
            <XAxis type="number" tickFormatter={short} tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey={c.xKey} width={labelW} tick={{ fontSize: 11 }} interval={0} />
          </>
        ) : (
          <>
            <XAxis dataKey={c.xKey} tick={{ fontSize: 11 }} interval={0} />
            <YAxis tickFormatter={short} tick={{ fontSize: 11 }} width={60} />
          </>
        )}
        <Tooltip formatter={tip} />
        {legend}
        {c.series.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} fill={SERIES[i]} radius={4} maxBarSize={36} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
