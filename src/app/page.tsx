"use client";

import { useEffect, useState } from "react";

interface Stats {
  totalClients: number;
  totalVelos: number;
  velosLivres: number;
  certificatsRecus: number;
  velosFacturables: number;
  velosFactures: number;
  clientsDocsComplets: number;
  progression: number;
  livraisonsParStatut: Record<string, number>;
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then(setStats);
  }, []);

  if (!stats) {
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
        <h2 className="text-lg font-semibold mb-4">Progression globale</h2>
        <div className="w-full bg-gray-200 rounded-full h-6 mb-3">
          <div
            className="bg-green-500 h-6 rounded-full transition-all flex items-center justify-center text-xs text-white font-medium"
            style={{ width: `${Math.max(stats.progression, 2)}%` }}
          >
            {stats.progression}%
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
