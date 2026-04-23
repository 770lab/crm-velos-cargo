"use client";

import { useEffect, useMemo, useState } from "react";
import { gasGet, gasPost } from "@/lib/gas";
import { useData, type LivraisonRow } from "@/lib/data-context";

type View = "semaine" | "mois" | "liste";

interface Tournee {
  tourneeId: string | null;
  datePrevue: string | null;
  mode: string | null;
  livraisons: LivraisonRow[];
  totalVelos: number;
  statutGlobal: "planifiee" | "en_cours" | "livree" | "annulee" | "mixte";
}

export default function LivraisonsPage() {
  const { livraisons, refresh } = useData();
  const [view, setView] = useState<View>("semaine");
  const [refDate, setRefDate] = useState<Date>(() => new Date());
  const [openTournee, setOpenTournee] = useState<Tournee | null>(null);

  useEffect(() => {
    refresh("livraisons");
  }, [refresh]);

  const tournees = useMemo(() => groupByTournee(livraisons), [livraisons]);
  const tourneesByDate = useMemo(() => {
    const map = new Map<string, Tournee[]>();
    for (const t of tournees) {
      if (!t.datePrevue) continue;
      const key = isoDate(t.datePrevue);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    }
    return map;
  }, [tournees]);

  const livraisonsSansDate = livraisons.filter((l) => !l.datePrevue);

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Livraisons</h1>
          <p className="text-gray-500 mt-1">
            {tournees.length} tournée{tournees.length > 1 ? "s" : ""} · {livraisons.length} livraison{livraisons.length > 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border bg-white overflow-hidden">
            {(["semaine", "mois", "liste"] as View[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 py-1.5 text-sm capitalize ${
                  view === v ? "bg-green-600 text-white" : "text-gray-600 hover:bg-gray-50"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      {view !== "liste" && (
        <NavBar refDate={refDate} setRefDate={setRefDate} view={view} />
      )}

      {view === "semaine" && (
        <WeekView refDate={refDate} tourneesByDate={tourneesByDate} onOpen={setOpenTournee} />
      )}
      {view === "mois" && (
        <MonthView refDate={refDate} tourneesByDate={tourneesByDate} onOpen={setOpenTournee} />
      )}
      {view === "liste" && (
        <ListView tournees={tournees} onOpen={setOpenTournee} />
      )}

      {livraisonsSansDate.length > 0 && view !== "liste" && (
        <div className="mt-6 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
          {livraisonsSansDate.length} livraison{livraisonsSansDate.length > 1 ? "s" : ""} sans date — bascule en vue Liste pour les voir.
        </div>
      )}

      {openTournee && (
        <TourneeModal
          tournee={openTournee}
          onClose={() => setOpenTournee(null)}
          onChanged={() => { refresh("livraisons"); refresh("carte"); }}
        />
      )}
    </div>
  );
}

function NavBar({
  refDate,
  setRefDate,
  view,
}: {
  refDate: Date;
  setRefDate: (d: Date) => void;
  view: View;
}) {
  const label = useMemo(() => {
    if (view === "semaine") {
      const start = startOfWeek(refDate);
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      return `${start.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} — ${end.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" })}`;
    }
    return refDate.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  }, [refDate, view]);

  const step = view === "semaine" ? 7 : 30;
  const moveBack = () => {
    const d = new Date(refDate);
    if (view === "semaine") d.setDate(d.getDate() - step);
    else d.setMonth(d.getMonth() - 1);
    setRefDate(d);
  };
  const moveFwd = () => {
    const d = new Date(refDate);
    if (view === "semaine") d.setDate(d.getDate() + step);
    else d.setMonth(d.getMonth() + 1);
    setRefDate(d);
  };

  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2">
        <button onClick={moveBack} className="px-2 py-1 border rounded hover:bg-gray-50">←</button>
        <button
          onClick={() => setRefDate(new Date())}
          className="px-3 py-1 border rounded hover:bg-gray-50 text-sm"
        >
          Aujourd&apos;hui
        </button>
        <button onClick={moveFwd} className="px-2 py-1 border rounded hover:bg-gray-50">→</button>
      </div>
      <div className="text-sm font-medium text-gray-700 capitalize">{label}</div>
      <div className="w-24" />
    </div>
  );
}

function WeekView({
  refDate,
  tourneesByDate,
  onOpen,
}: {
  refDate: Date;
  tourneesByDate: Map<string, Tournee[]>;
  onOpen: (t: Tournee) => void;
}) {
  const start = startOfWeek(refDate);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d;
  });
  const today = isoDate(new Date());

  return (
    <div className="bg-white rounded-xl border overflow-hidden">
      <div className="grid grid-cols-7 border-b bg-gray-50 text-xs text-gray-600">
        {days.map((d) => {
          const iso = isoDate(d);
          const isToday = iso === today;
          return (
            <div
              key={iso}
              className={`px-3 py-2 border-r last:border-r-0 ${isToday ? "bg-blue-50 text-blue-800" : ""}`}
            >
              <div className="font-medium capitalize">{d.toLocaleDateString("fr-FR", { weekday: "short" })}</div>
              <div className="text-base font-bold text-gray-900">
                {d.getDate()}
                <span className="text-xs font-normal text-gray-500 ml-1">{d.toLocaleDateString("fr-FR", { month: "short" })}</span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="grid grid-cols-7 min-h-[60vh]">
        {days.map((d) => {
          const iso = isoDate(d);
          const list = tourneesByDate.get(iso) || [];
          return (
            <div key={iso} className="border-r last:border-r-0 p-2 space-y-1.5">
              {list.length === 0 && <div className="text-[11px] text-gray-300">—</div>}
              {list.map((t) => (
                <TourneeCard key={t.tourneeId || t.livraisons[0].id} tournee={t} onClick={() => onOpen(t)} compact />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MonthView({
  refDate,
  tourneesByDate,
  onOpen,
}: {
  refDate: Date;
  tourneesByDate: Map<string, Tournee[]>;
  onOpen: (t: Tournee) => void;
}) {
  const first = new Date(refDate.getFullYear(), refDate.getMonth(), 1);
  const start = startOfWeek(first);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    cells.push(d);
  }
  const today = isoDate(new Date());
  const monthIdx = refDate.getMonth();

  return (
    <div className="bg-white rounded-xl border overflow-hidden">
      <div className="grid grid-cols-7 border-b bg-gray-50 text-xs text-gray-600">
        {["lun", "mar", "mer", "jeu", "ven", "sam", "dim"].map((j) => (
          <div key={j} className="px-3 py-2 border-r last:border-r-0 capitalize font-medium">{j}</div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((d) => {
          const iso = isoDate(d);
          const list = tourneesByDate.get(iso) || [];
          const inMonth = d.getMonth() === monthIdx;
          const isToday = iso === today;
          return (
            <div
              key={iso}
              className={`border-r border-b last:border-r-0 min-h-[110px] p-1.5 space-y-1 ${
                inMonth ? "bg-white" : "bg-gray-50/50"
              } ${isToday ? "ring-1 ring-inset ring-blue-300" : ""}`}
            >
              <div className={`text-xs font-medium ${inMonth ? "text-gray-700" : "text-gray-400"}`}>
                {d.getDate()}
              </div>
              {list.slice(0, 3).map((t) => (
                <TourneeCard key={t.tourneeId || t.livraisons[0].id} tournee={t} onClick={() => onOpen(t)} compact />
              ))}
              {list.length > 3 && (
                <div className="text-[10px] text-gray-500">+{list.length - 3} autres</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ListView({ tournees, onOpen }: { tournees: Tournee[]; onOpen: (t: Tournee) => void }) {
  const sorted = [...tournees].sort((a, b) => {
    if (!a.datePrevue) return 1;
    if (!b.datePrevue) return -1;
    return a.datePrevue < b.datePrevue ? -1 : 1;
  });
  return (
    <div className="bg-white rounded-xl border overflow-x-auto">
      <table className="w-full min-w-[700px] text-sm">
        <thead className="bg-gray-50 border-b">
          <tr>
            <th className="text-left px-4 py-2 font-medium text-gray-600">Date</th>
            <th className="text-left px-4 py-2 font-medium text-gray-600">Tournée</th>
            <th className="text-left px-4 py-2 font-medium text-gray-600">Mode</th>
            <th className="text-center px-4 py-2 font-medium text-gray-600">Arrêts</th>
            <th className="text-center px-4 py-2 font-medium text-gray-600">Vélos</th>
            <th className="text-center px-4 py-2 font-medium text-gray-600">Statut</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {sorted.map((t) => (
            <tr key={t.tourneeId || t.livraisons[0].id} className="hover:bg-gray-50 cursor-pointer" onClick={() => onOpen(t)}>
              <td className="px-4 py-2">{t.datePrevue ? new Date(t.datePrevue).toLocaleDateString("fr-FR") : "—"}</td>
              <td className="px-4 py-2 font-mono text-xs">{t.tourneeId || "(sans tournée)"}</td>
              <td className="px-4 py-2">{t.mode || "—"}</td>
              <td className="px-4 py-2 text-center">{t.livraisons.length}</td>
              <td className="px-4 py-2 text-center">{t.totalVelos}</td>
              <td className="px-4 py-2 text-center"><StatutPill statut={t.statutGlobal} /></td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr><td colSpan={6} className="px-4 py-12 text-center text-gray-400">Aucune livraison.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function TourneeCard({
  tournee,
  onClick,
  compact = false,
}: {
  tournee: Tournee;
  onClick: () => void;
  compact?: boolean;
}) {
  const palette = modePalette(tournee.mode);
  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded ${palette.bg} ${palette.border} border ${palette.text} ${
        compact ? "px-1.5 py-1 text-[11px]" : "px-2 py-1.5 text-xs"
      } hover:opacity-90 transition-opacity`}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="font-medium truncate">
          {tournee.livraisons[0]?.client.entreprise}
          {tournee.livraisons.length > 1 && ` +${tournee.livraisons.length - 1}`}
        </span>
        <span className="font-mono opacity-70 whitespace-nowrap">{tournee.totalVelos}v</span>
      </div>
      {!compact && (
        <div className="text-[10px] opacity-75 truncate">
          {tournee.tourneeId ? `🚛 ${tournee.tourneeId}` : ""}
          {tournee.mode ? ` · ${tournee.mode === "atelier" ? "atelier" : "sur site"}` : ""}
        </div>
      )}
    </button>
  );
}

function modePalette(mode: string | null) {
  if (mode === "sursite") return { bg: "bg-orange-100", border: "border-orange-300", text: "text-orange-900" };
  if (mode === "atelier") return { bg: "bg-blue-100", border: "border-blue-300", text: "text-blue-900" };
  return { bg: "bg-gray-100", border: "border-gray-300", text: "text-gray-800" };
}

function StatutPill({ statut }: { statut: Tournee["statutGlobal"] }) {
  const map: Record<string, string> = {
    planifiee: "bg-gray-100 text-gray-700",
    en_cours: "bg-blue-100 text-blue-700",
    livree: "bg-green-100 text-green-700",
    annulee: "bg-red-100 text-red-700",
    mixte: "bg-amber-100 text-amber-700",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${map[statut]}`}>
      {statut === "planifiee" && "Planifiée"}
      {statut === "en_cours" && "En cours"}
      {statut === "livree" && "Livrée"}
      {statut === "annulee" && "Annulée"}
      {statut === "mixte" && "Partielle"}
    </span>
  );
}

function TourneeModal({
  tournee,
  onClose,
  onChanged,
}: {
  tournee: Tournee;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  const updateStatut = async (id: string, statut: string) => {
    setBusy(id);
    const data: Record<string, unknown> = { statut };
    if (statut === "livree") data.dateEffective = new Date().toISOString();
    await gasPost("updateLivraison", { id, data });
    onChanged();
    setBusy(null);
  };

  const setAllLivrees = async () => {
    setBusy("all");
    for (const l of tournee.livraisons) {
      if (l.statut !== "livree") {
        await gasPost("updateLivraison", { id: l.id, data: { statut: "livree", dateEffective: new Date().toISOString() } });
      }
    }
    onChanged();
    setBusy(null);
    onClose();
  };

  const annuler = async (id: string) => {
    if (!confirm("Annuler cette livraison ? (la donnée est conservée, le statut passe à 'annulée')")) return;
    setBusy(id);
    await gasGet("deleteLivraison", { id });
    onChanged();
    setBusy(null);
  };

  const restaurer = async (id: string) => {
    setBusy(id);
    await gasGet("restoreLivraison", { id });
    onChanged();
    setBusy(null);
  };

  const palette = modePalette(tournee.mode);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-3">
          <div>
            <div className={`inline-flex items-center gap-2 ${palette.text}`}>
              <span className="text-lg font-semibold">
                Tournée {tournee.tourneeId ? <span className="font-mono">{tournee.tourneeId}</span> : "(sans id)"}
              </span>
            </div>
            <div className="text-sm text-gray-500 mt-1">
              {tournee.datePrevue && new Date(tournee.datePrevue).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
              {tournee.mode && ` · ${tournee.mode === "atelier" ? "atelier (6/camion)" : "sur site (54/camion)"}`}
              {` · ${tournee.totalVelos} vélos`}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="space-y-2">
          {tournee.livraisons.map((l, i) => (
            <div key={l.id} className="border rounded-lg p-3 flex items-center gap-3">
              <span className="w-7 h-7 rounded-full bg-green-600 text-white text-sm flex items-center justify-center font-medium shrink-0">
                {i + 1}
              </span>
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{l.client.entreprise}</div>
                <div className="text-xs text-gray-500 truncate">
                  {[l.client.adresse, l.client.ville, l.client.codePostal].filter(Boolean).join(", ") || "—"}
                </div>
              </div>
              <span className="text-sm font-medium bg-gray-100 px-2 py-0.5 rounded">
                {l._count.velos} v.
              </span>
              <select
                value={l.statut}
                disabled={busy === l.id}
                onChange={(e) => updateStatut(l.id, e.target.value)}
                className="text-xs px-2 py-1 border rounded"
              >
                <option value="planifiee">Planifiée</option>
                <option value="en_cours">En cours</option>
                <option value="livree">Livrée</option>
                <option value="annulee">Annulée</option>
              </select>
              {l.statut === "annulee" ? (
                <button
                  onClick={() => restaurer(l.id)}
                  disabled={busy === l.id}
                  title="Restaurer (passe à planifiée)"
                  className="text-emerald-500 hover:text-emerald-700 text-xs whitespace-nowrap"
                >
                  ↺ restaurer
                </button>
              ) : (
                <button
                  onClick={() => annuler(l.id)}
                  disabled={busy === l.id}
                  title="Annuler (soft, la donnée est conservée)"
                  className="text-amber-500 hover:text-amber-700 text-xs whitespace-nowrap"
                >
                  annuler
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-3 mt-4 pt-3 border-t">
          <button
            onClick={setAllLivrees}
            disabled={busy === "all"}
            className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
          >
            {busy === "all" ? "Mise à jour…" : "Tout marquer livré"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Helpers ----

function isoDate(input: string | Date): string {
  const d = typeof input === "string" ? new Date(input) : input;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function startOfWeek(d: Date): Date {
  const out = new Date(d);
  const day = out.getDay(); // 0 = dim
  const diff = day === 0 ? -6 : 1 - day; // lundi = début
  out.setDate(out.getDate() + diff);
  out.setHours(0, 0, 0, 0);
  return out;
}

function parseTourneeFromNotes(notes: string | null): { tourneeId: string | null; mode: string | null } {
  if (!notes) return { tourneeId: null, mode: null };
  const tid = notes.match(/\[([a-f0-9]{8})\]/)?.[1] ?? null;
  let mode: string | null = null;
  if (/—\s*atelier\b/.test(notes)) mode = "atelier";
  else if (/—\s*sur site\b/.test(notes)) mode = "sursite";
  return { tourneeId: tid, mode };
}

function groupByTournee(livraisons: LivraisonRow[]): Tournee[] {
  const groups = new Map<string, Tournee>();
  for (const l of livraisons) {
    const tidFromCol = l.tourneeId || null;
    const modeFromCol = l.mode || null;
    const fallback = parseTourneeFromNotes(l.notes);
    const tourneeId = tidFromCol || fallback.tourneeId;
    const mode = modeFromCol || fallback.mode;
    const dateKey = l.datePrevue ? isoDate(l.datePrevue) : "no-date";
    const groupKey = `${tourneeId || `solo-${l.id}`}|${dateKey}`;
    let g = groups.get(groupKey);
    if (!g) {
      g = {
        tourneeId,
        datePrevue: l.datePrevue,
        mode,
        livraisons: [],
        totalVelos: 0,
        statutGlobal: "planifiee",
      };
      groups.set(groupKey, g);
    }
    g.livraisons.push(l);
    g.totalVelos += l._count.velos;
  }

  for (const g of groups.values()) {
    const statuts = new Set(g.livraisons.map((l) => l.statut));
    if (statuts.size === 1) {
      g.statutGlobal = ([...statuts][0] as Tournee["statutGlobal"]) || "planifiee";
    } else {
      g.statutGlobal = "mixte";
    }
  }

  return Array.from(groups.values());
}
