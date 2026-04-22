"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { gasPost } from "@/lib/gas";
import { useData } from "@/lib/data-context";
import MultiDepSelect from "@/components/multi-dep-select";

const MapView = dynamic(() => import("@/components/map-view"), { ssr: false });

interface TourneeClient {
  id: string;
  entreprise: string;
  ville: string | null;
  lat: number;
  lng: number;
  nbVelos: number;
  distance: number;
}

interface TourneeResult {
  mode: string;
  capacite: number;
  tournee: TourneeClient[];
  totalVelos: number;
  clientsProches: Array<{
    id: string;
    entreprise: string;
    ville: string | null;
    lat: number;
    lng: number;
    distance: number;
    velosRestants: number;
  }>;
}

export default function CartePage() {
  const { carte: allClients, refresh } = useData();
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"atelier" | "sursite">("atelier");
  const [maxDistance, setMaxDistance] = useState(50);
  const [selectedDeps, setSelectedDeps] = useState<string[]>([]);
  const [codePostal, setCodePostal] = useState("");
  const [search, setSearch] = useState("");
  const [tournee, setTournee] = useState<TourneeResult | null>(null);
  const [loading, setLoading] = useState(false);

  const departements = Array.from(
    new Set(
      allClients
        .map((c) => (c.departement == null || c.departement === "" ? null : String(c.departement)))
        .filter((d): d is string => d !== null)
    )
  ).sort((a, b) => a.localeCompare(b));

  const cpFilter = codePostal.trim();
  const searchQuery = search.trim().toLowerCase();
  const clients = allClients.filter((c) => {
    if (selectedDeps.length > 0 && !(c.departement != null && selectedDeps.includes(String(c.departement)))) {
      return false;
    }
    if (cpFilter && !(c.codePostal != null && String(c.codePostal).startsWith(cpFilter))) {
      return false;
    }
    if (searchQuery) {
      const hay = `${c.entreprise} ${c.ville ?? ""}`.toLowerCase();
      if (!hay.includes(searchQuery)) return false;
    }
    return true;
  });

  const handleSelectClient = useCallback(
    async (clientId: string) => {
      setSelected(clientId);
      setLoading(true);
      const data = await gasPost("suggestTournee", { clientId, mode, maxDistance });
      setTournee(data);
      setLoading(false);
    },
    [mode, maxDistance]
  );

  useEffect(() => {
    if (selected) handleSelectClient(selected);
  }, [mode, maxDistance, selected, handleSelectClient]);

  const selectedClient = clients.find((c) => c.id === selected);
  const tourneeIds = new Set(tournee?.tournee.map((t) => t.id) || []);

  return (
    <div className="flex flex-col lg:flex-row h-[calc(100vh-5rem)] lg:h-[calc(100vh-4rem)]">
      <div className="flex-1 relative min-h-[300px]">
        <MapView
          clients={clients}
          selectedId={selected}
          tourneeIds={tourneeIds}
          tournee={tournee?.tournee || []}
          onSelectClient={handleSelectClient}
        />
      </div>

      <div className="w-full lg:w-96 bg-white border-t lg:border-t-0 lg:border-l overflow-y-auto max-h-[50vh] lg:max-h-none">
        <div className="p-4 border-b">
          <h2 className="font-semibold text-lg">Planification</h2>
          <p className="text-sm text-gray-500 mt-1">
            {clients.length} clients sur la carte
          </p>
        </div>

        <div className="p-4 border-b space-y-3">
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">
              Rechercher
            </label>
            <input
              type="text"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setSelected(null); setTournee(null); }}
              placeholder="Nom du client ou ville..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">
              Filtrer par département
            </label>
            <MultiDepSelect
              value={selectedDeps}
              onChange={(deps) => { setSelectedDeps(deps); setSelected(null); setTournee(null); }}
              options={departements}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">
              Filtrer par code postal
            </label>
            <input
              type="text"
              inputMode="numeric"
              value={codePostal}
              onChange={(e) => { setCodePostal(e.target.value); setSelected(null); setTournee(null); }}
              placeholder="ex. 75010 ou 750"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">
              Mode de livraison
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => setMode("atelier")}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  mode === "atelier"
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                Atelier (6/camion)
              </button>
              <button
                onClick={() => setMode("sursite")}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  mode === "sursite"
                    ? "bg-orange-600 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                Sur site (54/camion)
              </button>
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">
              Rayon max : {maxDistance} km
            </label>
            <input
              type="range"
              min={10}
              max={200}
              step={10}
              value={maxDistance}
              onChange={(e) => setMaxDistance(Number(e.target.value))}
              className="w-full"
            />
          </div>
        </div>

        {!selected && (
          <div className="p-8 text-center text-gray-400 text-sm">
            Cliquez sur un client sur la carte pour calculer une tournée
          </div>
        )}

        {loading && (
          <div className="p-8 text-center text-gray-400 text-sm">
            Calcul de la tournée...
          </div>
        )}

        {selected && selectedClient && tournee && !loading && (
          <div className="p-4 space-y-4">
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
              <div className="font-medium text-blue-900">
                {selectedClient.entreprise}
              </div>
              <div className="text-sm text-blue-700">
                {selectedClient.ville} ({selectedClient.departement})
              </div>
              <div className="text-sm text-blue-600 mt-1">
                {selectedClient.nbVelos - selectedClient.velosLivres} vélos à
                livrer
              </div>
            </div>

            <div className="bg-green-50 border border-green-200 rounded-lg p-3">
              <div className="flex justify-between items-center">
                <span className="font-medium text-green-900">Tournée suggérée</span>
                <span className="text-sm text-green-700">
                  {tournee.totalVelos}/{tournee.capacite} vélos
                </span>
              </div>
              <div className="text-xs text-green-600 mt-1">
                {tournee.tournee.length} arrêt{tournee.tournee.length > 1 ? "s" : ""} —{" "}
                {mode === "atelier" ? "montage atelier" : "montage sur site"}
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="text-sm font-medium text-gray-700">
                Arrêts de la tournée
              </h3>
              {tournee.tournee.map((t, i) => (
                <div
                  key={t.id}
                  className={`flex items-center gap-3 p-2 rounded-lg text-sm ${
                    i === 0 ? "bg-blue-50" : "bg-gray-50"
                  }`}
                >
                  <span className="w-6 h-6 rounded-full bg-green-600 text-white text-xs flex items-center justify-center font-medium">
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{t.entreprise}</div>
                    <div className="text-xs text-gray-500">
                      {t.ville}
                      {t.distance > 0 && ` — ${t.distance} km`}
                    </div>
                  </div>
                  <span className="text-xs font-medium bg-white px-2 py-1 rounded border">
                    {t.nbVelos} v.
                  </span>
                </div>
              ))}
            </div>

            <PlanifierTournee
              mode={mode}
              tournee={tournee}
              onPlanned={() => refresh("livraisons")}
              resetTour={() => handleSelectClient(selected!)}
            />

            {tournee.clientsProches.length > tournee.tournee.length - 1 && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-gray-700">
                  Autres clients proches
                </h3>
                {tournee.clientsProches
                  .filter((c) => !tourneeIds.has(c.id))
                  .slice(0, 10)
                  .map((c) => (
                    <button
                      key={c.id}
                      onClick={() => handleSelectClient(c.id)}
                      className="w-full flex items-center gap-3 p-2 rounded-lg text-sm hover:bg-gray-50 text-left"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="truncate">{c.entreprise}</div>
                        <div className="text-xs text-gray-400">
                          {c.ville} — {c.distance} km
                        </div>
                      </div>
                      <span className="text-xs text-gray-500">
                        {c.velosRestants} v.
                      </span>
                    </button>
                  ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function nextMondayISO(): string {
  const d = new Date();
  const day = d.getDay();
  const diff = (8 - day) % 7 || 7;
  d.setDate(d.getDate() + diff);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function todayISO(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function PlanifierTournee({
  mode,
  tournee,
  onPlanned,
  resetTour,
}: {
  mode: "atelier" | "sursite";
  tournee: TourneeResult;
  onPlanned: () => void;
  resetTour: () => void;
}) {
  const [date, setDate] = useState<string>(() => nextMondayISO());
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ tourneeId: string; created: number; datePrevue: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const today = useMemo(() => todayISO(), []);
  const isPast = date && date < today;

  const formatFrDate = (iso: string) => {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
  };

  const weekdayLabel = useMemo(() => {
    if (!date) return "";
    const d = new Date(date + "T00:00:00");
    return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  }, [date]);

  const submit = async () => {
    if (!date) {
      setError("Choisis une date");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const stops = tournee.tournee.map((t, i) => ({
        clientId: t.id,
        ordre: i + 1,
        nbVelos: t.nbVelos,
      }));
      const r = await gasPost("createTournee", {
        datePrevue: date,
        notes: notes.trim(),
        mode,
        stops,
      });
      if (r.error) {
        setError(r.error);
      } else {
        setResult(r);
        onPlanned();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    }
    setLoading(false);
  };

  const reset = () => {
    setResult(null);
    setNotes("");
    setError(null);
    resetTour();
  };

  if (result) {
    return (
      <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 space-y-3">
        <div className="flex items-start gap-2">
          <span className="text-emerald-600 text-xl leading-none">✓</span>
          <div>
            <div className="font-medium text-emerald-900">Tournée planifiée</div>
            <div className="text-sm text-emerald-700">
              {result.created} livraison{result.created > 1 ? "s" : ""} créée{result.created > 1 ? "s" : ""} pour le{" "}
              <span className="font-medium">{formatFrDate(result.datePrevue)}</span>
            </div>
            <div className="text-xs text-emerald-600 mt-0.5 font-mono">ID tournée : {result.tourneeId}</div>
          </div>
        </div>
        <div className="flex gap-2">
          <Link
            href="/livraisons"
            className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm"
          >
            Voir dans Livraisons →
          </Link>
          <button
            onClick={reset}
            className="px-3 py-1.5 bg-white border border-emerald-300 text-emerald-700 rounded-lg hover:bg-emerald-100 text-sm"
          >
            Nouvelle tournée
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="border-t pt-3 space-y-2">
      <h3 className="text-sm font-medium text-gray-700">Planifier cette tournée</h3>

      <div className="space-y-2">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Date prévue</label>
          <input
            type="date"
            value={date}
            min={today}
            onChange={(e) => setDate(e.target.value)}
            className="w-full px-3 py-2 border rounded-lg text-sm"
          />
          {date && !isPast && (
            <p className="text-xs text-gray-500 mt-1 capitalize">{weekdayLabel}</p>
          )}
          {isPast && (
            <p className="text-xs text-amber-700 mt-1">⚠️ Date dans le passé</p>
          )}
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">Notes (optionnel)</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="ex. camion 2, conducteur Jean…"
            rows={2}
            className="w-full px-3 py-2 border rounded-lg text-sm resize-none"
          />
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-2 text-xs text-red-700">
            {error}
          </div>
        )}

        <button
          onClick={submit}
          disabled={loading || !date}
          className="w-full px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 text-sm font-medium"
        >
          {loading
            ? "Création en cours…"
            : `Planifier (${tournee.tournee.length} arrêt${tournee.tournee.length > 1 ? "s" : ""} · ${tournee.totalVelos} vélo${tournee.totalVelos > 1 ? "s" : ""})`}
        </button>
      </div>
    </div>
  );
}
