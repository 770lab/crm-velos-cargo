"use client";

import { useData } from "@/lib/data-context";

export default function Dashboard() {
  const { stats, loading } = useData();

  if (loading || !stats) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Chargement...</div>
      </div>
    );
  }

  const cards = [
    {
      label: "Clients",
      value: stats.totalClients,
      sub: `${stats.clientsDocsComplets} dossiers complets`,
      color: "bg-blue-500",
    },
    {
      label: "Vélos total",
      value: stats.totalVelos,
      sub: `${stats.progression}% livrés`,
      color: "bg-green-500",
    },
    {
      label: "Vélos livrés",
      value: stats.velosLivres,
      sub: `sur ${stats.totalVelos}`,
      color: "bg-emerald-500",
    },
    {
      label: "Certificats reçus",
      value: stats.certificatsRecus,
      sub: `sur ${stats.totalVelos}`,
      color: "bg-purple-500",
    },
    {
      label: "Facturables",
      value: stats.velosFacturables,
      sub: "livré + certificat + photo QR",
      color: "bg-amber-500",
    },
    {
      label: "Facturés",
      value: stats.velosFactures,
      sub: `reste ${stats.velosFacturables - stats.velosFactures} à facturer`,
      color: "bg-teal-500",
    },
  ];

  const restant = stats.totalVelos - stats.velosLivres;
  const joursRestants = Math.ceil(
    (new Date("2026-06-22").getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  );
  const velosParJour =
    joursRestants > 0 ? Math.ceil(restant / joursRestants) : restant;

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Tableau de bord</h1>
        <p className="text-gray-500 mt-1">
          Opération vélos cargo — objectif 2 mois
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
        {cards.map((card) => (
          <div
            key={card.label}
            className="bg-white rounded-xl shadow-sm border border-gray-200 p-6"
          >
            <div className="flex items-center gap-3 mb-3">
              <div className={`w-3 h-3 rounded-full ${card.color}`} />
              <span className="text-sm text-gray-500">{card.label}</span>
            </div>
            <div className="text-3xl font-bold text-gray-900">{card.value}</div>
            <div className="text-sm text-gray-400 mt-1">{card.sub}</div>
          </div>
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
