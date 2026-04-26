"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { gasGet } from "@/lib/gas";

// Périodes proposées dans le toolbar du dashboard. "tout" = pas de fenêtre,
// stats globales du portefeuille (l'état historique). Les autres options
// filtrent les compteurs de production (livrés / certificats / facturables /
// facturés) sur la fenêtre, sans toucher aux KPI de stock (clients, vélos
// total, planifiés).
type Period = "tout" | "jour" | "semaine" | "mois" | "annee" | "custom";

interface Stats {
  totalClients: number;
  totalVelos: number;
  velosLivres: number;
  velosPlanifies?: number;
  certificatsRecus: number;
  velosFacturables: number;
  velosFactures: number;
  clientsDocsComplets: number;
  progression: number;
  periodFrom?: string | null;
  periodTo?: string | null;
}

function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}
function startOfWeekMon(d: Date) {
  // Semaine ISO : lundi = jour 1.
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
}

function computeWindow(period: Period, customFrom: string, customTo: string): { from: string; to: string } | null {
  const now = new Date();
  if (period === "tout") return null;
  if (period === "jour") {
    const iso = isoDay(now);
    return { from: iso, to: iso };
  }
  if (period === "semaine") {
    const start = startOfWeekMon(now);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return { from: isoDay(start), to: isoDay(end) };
  }
  if (period === "mois") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return { from: isoDay(start), to: isoDay(end) };
  }
  if (period === "annee") {
    return { from: `${now.getFullYear()}-01-01`, to: `${now.getFullYear()}-12-31` };
  }
  if (period === "custom" && customFrom && customTo) {
    return { from: customFrom, to: customTo };
  }
  return null;
}

const PERIOD_LABELS: Record<Period, string> = {
  tout: "Tout",
  jour: "Aujourd'hui",
  semaine: "Semaine",
  mois: "Mois",
  annee: "Année",
  custom: "📅 Dates",
};

export default function Dashboard() {
  const [period, setPeriod] = useState<Period>("tout");
  const [customFrom, setCustomFrom] = useState<string>(isoDay(new Date()));
  const [customTo, setCustomTo] = useState<string>(isoDay(new Date()));
  const [showCustom, setShowCustom] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  const window = useMemo(
    () => computeWindow(period, customFrom, customTo),
    [period, customFrom, customTo],
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const params: Record<string, string> = window
          ? { from: window.from, to: window.to }
          : {};
        const r = (await gasGet("getStats", params)) as Stats;
        if (!cancelled) setStats(r);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [window]);

  if (loading && !stats) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Chargement...</div>
      </div>
    );
  }
  if (!stats) return null;

  const isFiltered = !!window;
  const periodSuffix = isFiltered ? ` · ${PERIOD_LABELS[period].toLowerCase()}` : "";

  // Compteurs : on distingue les KPI "stock" (toujours globaux) des KPI
  // "production" (filtrés si une fenêtre est active). Cela évite que le user
  // se demande pourquoi "Clients" tombe à 0 quand il sélectionne "Aujourd'hui".
  const cards = [
    {
      label: "Clients",
      value: stats.totalClients,
      sub: `${stats.clientsDocsComplets} dossiers complets`,
      color: "bg-blue-500",
      href: "/clients",
      stock: true,
    },
    {
      label: "Vélos total",
      value: stats.totalVelos,
      sub: `${stats.progression}% livrés`,
      color: "bg-green-500",
      href: "/clients",
      stock: true,
    },
    {
      label: "Vélos planifiés",
      value: stats.velosPlanifies ?? 0,
      sub: "dans une tournée à venir",
      color: "bg-sky-500",
      href: "/livraisons",
      stock: true,
    },
    {
      label: "Vélos livrés" + periodSuffix,
      value: stats.velosLivres,
      sub: isFiltered ? "sur la période" : `sur ${stats.totalVelos}`,
      color: "bg-emerald-500",
      href: "/livraisons",
      stock: false,
    },
    {
      label: "Certificats reçus" + periodSuffix,
      value: stats.certificatsRecus,
      sub: isFiltered ? "sur la période" : `sur ${stats.totalVelos}`,
      color: "bg-purple-500",
      href: "/clients",
      stock: false,
    },
    {
      label: "Facturables" + periodSuffix,
      value: stats.velosFacturables,
      sub: "livré + certificat + photo QR",
      color: "bg-amber-500",
      href: "/livraisons",
      stock: false,
    },
    {
      label: "Facturés" + periodSuffix,
      value: stats.velosFactures,
      sub: `reste ${stats.velosFacturables - stats.velosFactures} à facturer`,
      color: "bg-teal-500",
      href: "/livraisons",
      stock: false,
    },
  ];

  const restant = stats.totalVelos - stats.velosLivres;
  const joursRestants = Math.ceil(
    (new Date("2026-06-22").getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  );
  const velosParJour =
    joursRestants > 0 ? Math.ceil(restant / joursRestants) : restant;

  const handlePeriod = (p: Period) => {
    setPeriod(p);
    setShowCustom(p === "custom");
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Tableau de bord</h1>
        <p className="text-gray-500 mt-1 text-sm">
          Opération vélos cargo — objectif 2 mois
        </p>
      </div>

      {/* Toolbar période — segmented control. Sur mobile, scrollable
          horizontalement. La case "📅 Dates" ouvre un mini-form custom. */}
      <div className="bg-white border rounded-xl p-1.5 mb-3 inline-flex flex-wrap gap-1">
        {(["tout", "jour", "semaine", "mois", "annee", "custom"] as Period[]).map((p) => (
          <button
            key={p}
            onClick={() => handlePeriod(p)}
            className={`px-3 py-1.5 text-sm rounded-lg whitespace-nowrap transition-colors ${
              period === p
                ? "bg-gray-900 text-white"
                : "text-gray-700 hover:bg-gray-100"
            }`}
          >
            {PERIOD_LABELS[p]}
          </button>
        ))}
      </div>
      {showCustom && (
        <div className="bg-white border rounded-xl p-3 mb-4 flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Du</label>
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="px-2 py-1 border rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Au</label>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="px-2 py-1 border rounded-lg text-sm"
            />
          </div>
          <p className="text-[11px] text-gray-400 ml-auto self-center">
            Filtre les compteurs de production (livrés, certificats, facturés). Les compteurs Clients / Vélos total / Planifiés restent sur le portefeuille global.
          </p>
        </div>
      )}
      {isFiltered && !showCustom && (
        <p className="text-[11px] text-gray-400 mb-4">
          Compteurs « livrés / certificats / facturables / facturés » filtrés sur la période. Les autres restent globaux.
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
        {cards.map((card) => (
          <Link
            key={card.label}
            href={card.href}
            className={`bg-white rounded-xl shadow-sm border p-6 hover:shadow-md hover:border-gray-300 transition-all cursor-pointer block ${
              isFiltered && !card.stock ? "border-gray-300 ring-1 ring-gray-100" : "border-gray-200"
            }`}
          >
            <div className="flex items-center gap-3 mb-3">
              <div className={`w-3 h-3 rounded-full ${card.color}`} />
              <span className="text-sm text-gray-500">{card.label}</span>
            </div>
            <div className="text-3xl font-bold text-gray-900">{card.value}</div>
            <div className="text-sm text-gray-400 mt-1">{card.sub}</div>
          </Link>
        ))}
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-8">
        <div className="flex items-center gap-3 mb-4">
          <CargoBikeIcon className="w-8 h-8 text-green-600" />
          <h2 className="text-lg font-semibold">Progression globale</h2>
        </div>
        <div className="relative w-full mb-3">
          <div className="w-full bg-gray-200 rounded-full h-8">
            <div
              className="bg-gradient-to-r from-green-400 to-green-600 h-8 rounded-full transition-all flex items-center justify-center text-xs text-white font-bold"
              style={{ width: `${Math.max(stats.progression, 5)}%` }}
            >
              {stats.progression}%
            </div>
          </div>
          <div
            className="absolute top-1/2 -translate-y-1/2 transition-all duration-700"
            style={{ left: `calc(${Math.max(stats.progression, 2)}% - 16px)` }}
          >
            <CargoBikeIcon className="w-10 h-10 text-green-700 drop-shadow-md" />
          </div>
        </div>
        <div className="flex justify-between text-sm text-gray-500">
          <span>{stats.velosLivres} livrés</span>
          <span>{restant} restants</span>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h2 className="text-lg font-semibold mb-4">Rythme nécessaire</h2>
        <div className="grid grid-cols-3 gap-6 text-center">
          <div>
            <div className="text-2xl font-bold text-orange-500">
              {joursRestants}
            </div>
            <div className="text-sm text-gray-500">jours restants</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-orange-500">
              {velosParJour}
            </div>
            <div className="text-sm text-gray-500">vélos/jour requis</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-orange-500">{restant}</div>
            <div className="text-sm text-gray-500">vélos à livrer</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CargoBikeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 40" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      {/* Roue arrière */}
      <circle cx="12" cy="30" r="9" stroke="currentColor" strokeWidth="2.5" />
      <circle cx="12" cy="30" r="2" fill="currentColor" />
      {/* Roue avant */}
      <circle cx="52" cy="30" r="9" stroke="currentColor" strokeWidth="2.5" />
      <circle cx="52" cy="30" r="2" fill="currentColor" />
      {/* Cadre */}
      <path d="M12 30 L28 14 L42 14 L52 30" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {/* Tube de selle */}
      <path d="M28 14 L24 30" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      {/* Guidon */}
      <path d="M42 14 L46 8 L50 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {/* Selle */}
      <path d="M24 12 L32 12" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      {/* Caisse cargo */}
      <rect x="30" y="18" width="18" height="10" rx="2" stroke="currentColor" strokeWidth="2" fill="currentColor" fillOpacity="0.15" />
      {/* Colis dans la caisse */}
      <rect x="33" y="21" width="5" height="5" rx="1" fill="currentColor" fillOpacity="0.4" />
      <rect x="40" y="22" width="4" height="4" rx="1" fill="currentColor" fillOpacity="0.3" />
      {/* Pédales */}
      <circle cx="20" cy="28" r="3" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
