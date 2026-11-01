"use client";

import {
  AreaChart, Area, LineChart, Line, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Legend,
} from "recharts";

const AXIS = { stroke: "#64748b", fontSize: 11 };
const GRID = "#1d2b45";

const tooltipStyle = {
  backgroundColor: "#0b1220",
  border: "1px solid #1d2b45",
  borderRadius: 8,
  fontSize: 12,
  color: "#f8fafc",
};

/**
 * Charts.
 *
 * Every series that can contain an incomplete trailing period renders that
 * period with a dashed boundary, so a chart never implies a drop that is just
 * "today is not over yet".
 */
export function ActivityChart({
  data, incompleteFrom,
}: {
  data: Array<{ bucket: string; activeUsers: number; newUsers: number; complete: boolean }>;
  incompleteFrom?: string | null;
}) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <defs>
          <linearGradient id="activeFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="bucket" tick={AXIS} tickLine={false} axisLine={false} minTickGap={28} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip contentStyle={tooltipStyle} />
        {incompleteFrom ? (
          <ReferenceLine
            x={incompleteFrom}
            stroke="#f59e0b"
            strokeDasharray="4 3"
            label={{ value: "incomplete", fill: "#f59e0b", fontSize: 10, position: "insideTopRight" }}
          />
        ) : null}
        <Area type="monotone" dataKey="activeUsers" name="Active users"
              stroke="#3b82f6" strokeWidth={2} fill="url(#activeFill)" />
        <Area type="monotone" dataKey="newUsers" name="New users"
              stroke="#06b6d4" strokeWidth={1.5} fill="none" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function RetentionCurve({ data }: { data: Array<{ period: number; rate: number | null }> }) {
  const plot = data.map((d) => ({ period: `D${d.period}`, rate: d.rate === null ? null : d.rate * 100 }));
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={plot} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="period" tick={AXIS} tickLine={false} axisLine={false} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} domain={[0, 100]} unit="%" />
        <Tooltip contentStyle={tooltipStyle} formatter={(v) => (v === null ? "not yet knowable" : `${Number(v).toFixed(1)}%`)} />
        <Line type="monotone" dataKey="rate" name="Retained" stroke="#06b6d4" strokeWidth={2}
              dot={{ r: 3, fill: "#06b6d4" }} connectNulls={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function MrrChart({
  data,
}: {
  data: Array<{ periodKey: string; newMinor: number; expansionMinor: number; contractionMinor: number; churnMinor: number }>;
}) {
  const plot = data.map((d) => ({
    period: d.periodKey,
    New: d.newMinor / 100,
    Expansion: d.expansionMinor / 100,
    Contraction: -d.contractionMinor / 100,
    Churn: -d.churnMinor / 100,
  }));
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={plot} margin={{ top: 8, right: 8, left: -8, bottom: 0 }} stackOffset="sign">
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="period" tick={AXIS} tickLine={false} axisLine={false} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} />
        <Tooltip contentStyle={tooltipStyle} />
        <Legend wrapperStyle={{ fontSize: 11, color: "#94a3b8" }} />
        <ReferenceLine y={0} stroke="#2a3b59" />
        <Bar dataKey="New" stackId="a" fill="#10b981" />
        <Bar dataKey="Expansion" stackId="a" fill="#06b6d4" />
        <Bar dataKey="Contraction" stackId="a" fill="#f59e0b" />
        <Bar dataKey="Churn" stackId="a" fill="#f43f5e" />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function FeatureTrendChart({ data }: { data: Array<{ day: string; users: number }> }) {
  return (
    <ResponsiveContainer width="100%" height={180}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="day" tick={AXIS} tickLine={false} axisLine={false} minTickGap={30} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip contentStyle={tooltipStyle} />
        <Line type="monotone" dataKey="users" name="Users" stroke="#3b82f6" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
