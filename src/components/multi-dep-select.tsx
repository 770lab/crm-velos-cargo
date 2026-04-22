"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  value: string[];
  onChange: (deps: string[]) => void;
  options: string[];
  className?: string;
  placeholder?: string;
}

export default function MultiDepSelect({
  value,
  onChange,
  options,
  className = "",
  placeholder = "Tous les départements",
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const toggle = (d: string) => {
    if (value.includes(d)) {
      onChange(value.filter((v) => v !== d));
    } else {
      onChange([...value, d]);
    }
  };

  const filtered = query
    ? options.filter((d) => d.toLowerCase().includes(query.toLowerCase()))
    : options;

  const label =
    value.length === 0
      ? placeholder
      : value.length <= 3
        ? [...value].sort((a, b) => a.localeCompare(b)).join(", ")
        : `${value.length} départements`;

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white text-left"
      >
        <span className={value.length === 0 ? "text-gray-500" : "text-gray-900"}>
          {label}
        </span>
        <svg
          className={`w-4 h-4 text-gray-400 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-full min-w-[220px] bg-white border border-gray-200 rounded-lg shadow-lg max-h-80 overflow-hidden flex flex-col">
          <div className="p-2 border-b flex items-center gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Rechercher..."
              className="flex-1 px-2 py-1 text-sm border border-gray-200 rounded"
              autoFocus
            />
            {value.length > 0 && (
              <button
                type="button"
                onClick={() => onChange([])}
                className="text-xs text-gray-500 hover:text-gray-700 whitespace-nowrap"
              >
                Tout effacer
              </button>
            )}
          </div>
          <div className="overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-sm text-gray-400 text-center">
                Aucun département
              </div>
            ) : (
              filtered.map((d) => {
                const checked = value.includes(d);
                return (
                  <label
                    key={d}
                    className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(d)}
                      className="accent-blue-600"
                    />
                    <span>{d}</span>
                  </label>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
