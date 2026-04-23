"use client";

import { useMemo, useState } from "react";

export type DayLoad = { velos: number; tournees: number; modes: string[] };

function toISO(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function todayISO(): string {
  return toISO(new Date());
}

function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return toISO(d);
}

export default function DateLoadPicker({
  value,
  onChange,
  minDate = "",
  loadByDate,
}: {
  value: string;
  onChange: (iso: string) => void;
  minDate?: string;
  loadByDate: Map<string, DayLoad>;
}) {
  const [weekOffset, setWeekOffset] = useState(0);

  const base = useMemo(() => {
    const today = todayISO();
    const anchor = value && value >= today ? value : today;
    const d = new Date(anchor + "T00:00:00");
    d.setDate(d.getDate() + weekOffset * 7);
    const day = d.getDay();
    const diff = (day + 6) % 7;
    d.setDate(d.getDate() - diff);
    return toISO(d);
  }, [value, weekOffset]);

  const days = useMemo(() => Array.from({ length: 21 }, (_, i) => addDaysISO(base, i)), [base]);
  const today = todayISO();
  const dayHeaders = ["L", "M", "M", "J", "V", "S", "D"];

  const firstLabel = new Date(days[0] + "T00:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  const lastLabel = new Date(days[20] + "T00:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "short" });

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-gray-500">{firstLabel} — {lastLabel}</span>
        <div className="flex gap-1">
          <button type="button" onClick={() => setWeekOffset((o) => o - 1)} className="px-1.5 py-0.5 border rounded text-xs hover:bg-gray-50">←</button>
          <button type="button" onClick={() => setWeekOffset(0)} className="px-1.5 py-0.5 border rounded text-xs hover:bg-gray-50">Auj.</button>
          <button type="button" onClick={() => setWeekOffset((o) => o + 1)} className="px-1.5 py-0.5 border rounded text-xs hover:bg-gray-50">→</button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {dayHeaders.map((d, i) => (
          <div key={i} className="text-center text-[10px] text-gray-400 font-medium">{d}</div>
        ))}
        {days.map((iso) => {
          const d = new Date(iso + "T00:00:00");
          const load = loadByDate.get(iso);
          const isSelected = iso === value;
          const isDisabled = iso < today || (minDate !== "" && iso < minDate);
          const hasLoad = !!load && load.velos > 0;
          const cls = isSelected
            ? "bg-blue-600 text-white border-blue-700 font-semibold"
            : isDisabled
            ? "bg-gray-100 text-gray-300 border-gray-100 cursor-not-allowed"
            : hasLoad
            ? "bg-amber-50 border-amber-300 text-amber-900 hover:bg-amber-100"
            : "bg-green-50 border-green-200 text-green-800 hover:bg-green-100";
          return (
            <button
              key={iso}
              type="button"
              disabled={isDisabled}
              onClick={() => onChange(iso)}
              className={`p-1 rounded border text-center transition-colors ${cls}`}
              title={hasLoad
                ? `${load!.velos} vélos · ${load!.tournees} tournée${load!.tournees > 1 ? "s" : ""}${load!.modes.length ? ` · ${load!.modes.join(", ")}` : ""}`
                : isDisabled ? "Passé" : "Libre"}
            >
              <div className="text-xs font-bold leading-tight">{d.getDate()}</div>
              <div className="text-[9px] leading-tight mt-0.5 truncate">
                {hasLoad ? `${load!.velos}v` : isDisabled ? "" : "libre"}
              </div>
            </button>
          );
        })}
      </div>
      <input
        type="date"
        value={value}
        min={minDate}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-1.5 border rounded-lg text-sm"
      />
    </div>
  );
}
