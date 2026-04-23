"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { gasPost } from "@/lib/gas";
import { useData } from "@/lib/data-context";
import MultiDepSelect from "@/components/multi-dep-select";

const MapView = dynamic(() => import("@/components/map-view"), { ssr: false });

interface TourneeStop {
  id: string;
  entreprise: string;
  ville: string | null;
  lat: number;
  lng: number;
  nbVelos: number;
  distance: number;
}

interface TourneeSplit {
  stops: TourneeStop[];
  totalVelos: number;
  capacite: number;
  indexCamion: number;
  nbCamionsTotal: number;
}

interface TourneeResult {
  mode: string;
  capacite: number;
  nbCamions: number;
  velosClient: number;
  splits: TourneeSplit[];
  // compat
  tournee: TourneeStop[];
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
  error?: string;
}

export default function CartePage() {
  const { carte: allClients, refresh } = useData();
  const [selected, setSelected] = useState<string | null>(null);
  const mode = "sursite";
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
  const allTourneeIds = new Set<string>();
  if (tournee?.splits) {
    tournee.splits.forEach((sp) => sp.stops.forEach((s) => allTourneeIds.add(s.id)));
  }
  // Pour la polyline (route map), on prend la 1ère tournée par défaut
  const firstSplitStops = tournee?.splits?.[0]?.stops ?? tournee?.tournee ?? [];

  return (
    <div className="flex flex-col lg:flex-row h-[calc(100vh-5rem)] lg:h-[calc(100vh-4rem)]">
      <div className="flex-1 relative min-h-[300px]">
        <MapView
          clients={clients}
          selectedId={selected}
          tourneeIds={allTourneeIds}
          tournee={firstSplitStops}
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
            <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700">
              Sur site — 54 vélos/camion (montés)
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

        {selected && selectedClient && tournee && tournee.error && !loading && (
          <div className="p-4">
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
              {tournee.error}
            </div>
          </div>
        )}

        {selected && selectedClient && tournee && !tournee.error && !loading && (
          <div className="p-4 space-y-4">
            <ClientHeader client={selectedClient} tournee={tournee} />

            {tournee.nbCamions > 1 && (
              <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 text-sm text-orange-900">
                <div className="font-medium">⚠️ Livraison multi-camions</div>
                <div className="mt-1">
                  Ce client commande <strong>{tournee.velosClient} vélos</strong> mais la capacité
                  est de <strong>{tournee.capacite}/camion</strong>. {tournee.nbCamions} tournées
                  seront créées pour livrer la totalité.
                </div>
              </div>
            )}

            <PlanifierSplits
              mode={mode}
              splits={tournee.splits}
              onPlanned={() => { refresh("livraisons"); refresh("carte"); }}
              resetTour={() => handleSelectClient(selected!)}
            />

            {tournee.clientsProches.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-gray-700">
                  Autres clients proches
                </h3>
                {tournee.clientsProches
                  .filter((c) => !allTourneeIds.has(c.id))
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

function ClientHeader({
  client,
  tournee,
}: {
  client: { entreprise: string; ville: string | null; departement: string | null; nbVelos: number; velosLivres: number; velosPlanifies: number };
  tournee: TourneeResult;
}) {
  const restant = client.nbVelos - client.velosLivres - client.velosPlanifies;
  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 space-y-1">
      <div className="font-medium text-blue-900">{client.entreprise}</div>
      <div className="text-sm text-blue-700">
        {client.ville} ({client.departement})
      </div>
      <div className="text-sm text-blue-600">
        {client.nbVelos} commandés · {client.velosLivres} livrés
        {client.velosPlanifies > 0 && (
          <> · <span className="text-orange-700">{client.velosPlanifies} déjà planifiés</span></>
        )}
      </div>
      <div className="text-xs text-blue-500">
        À planifier maintenant : {tournee.velosClient} vélo{tournee.velosClient > 1 ? "s" : ""}
        {restant !== tournee.velosClient && ` (reste ${restant} après cette planif)`}
      </div>
    </div>
  );
}

function nextMondayISO(): string {
  const d = new Date();
  const day = d.getDay();
  const diff = (8 - day) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return toISO(d);
}

function todayISO(): string {
  return toISO(new Date());
}

function toISO(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return toISO(d);
}

function PlanifierSplits({
  mode,
  splits,
  onPlanned,
  resetTour,
}: {
  mode: string;
  splits: TourneeSplit[];
  onPlanned: () => void;
  resetTour: () => void;
}) {
  const [dates, setDates] = useState<string[]>(() => {
    const start = nextMondayISO();
    return splits.map((_, i) => addDaysISO(start, i));
  });
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ count: number; tournees: { tourneeId: string; created: number; datePrevue: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-init dates si le nombre de splits change
  useEffect(() => {
    const start = nextMondayISO();
    setDates(splits.map((_, i) => addDaysISO(start, i)));
  }, [splits.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const today = useMemo(() => todayISO(), []);

  const formatFrDate = (iso: string) => {
    if (!iso) return "";
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  };

  const submit = async () => {
    if (dates.some((d) => !d)) {
      setError("Choisis une date pour chaque tournée");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      if (splits.length === 1) {
        const r = await gasPost("createTournee", {
          datePrevue: dates[0],
          notes: notes.trim(),
          mode,
          stops: splits[0].stops.map((s, i) => ({
            clientId: s.id,
            ordre: i + 1,
            nbVelos: s.nbVelos,
          })),
        });
        if (r.error) {
          setError(r.error);
        } else {
          setResult({ count: 1, tournees: [r] });
          onPlanned();
        }
      } else {
        const tournees = splits.map((sp, idx) => ({
          datePrevue: dates[idx],
          mode,
          notes: notes.trim()
            ? `${notes.trim()} (camion ${sp.indexCamion}/${sp.nbCamionsTotal})`
            : `camion ${sp.indexCamion}/${sp.nbCamionsTotal}`,
          stops: sp.stops.map((s, i) => ({
            clientId: s.id,
            ordre: i + 1,
            nbVelos: s.nbVelos,
          })),
        }));
        const r = await gasPost("createTournees", { tournees, mode, notes: notes.trim() });
        if (r.error) {
          setError(r.error);
        } else {
          setResult({ count: r.count, tournees: r.tournees });
          onPlanned();
        }
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
            <div className="font-medium text-emerald-900">
              {result.count} tournée{result.count > 1 ? "s" : ""} planifiée{result.count > 1 ? "s" : ""}
            </div>
            <ul className="text-xs text-emerald-700 mt-1 space-y-0.5">
              {result.tournees.map((t, i) => (
                <li key={t.tourneeId}>
                  Camion {i + 1} → {t.created} arrêt{t.created > 1 ? "s" : ""} le{" "}
                  <span className="font-medium">{formatFrDate(t.datePrevue)}</span>{" "}
                  <span className="font-mono text-emerald-500">[{t.tourneeId}]</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="flex gap-2">
          <Link
            href="/livraisons"
            className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm"
          >
            Voir l&apos;agenda →
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
    <div className="border-t pt-3 space-y-3">
      <h3 className="text-sm font-medium text-gray-700">
        Planifier {splits.length === 1 ? "cette tournée" : `les ${splits.length} tournées`}
      </h3>

      <div className="space-y-3">
        {splits.map((sp, idx) => (
          <div key={idx} className="border rounded-lg p-3 bg-gray-50 space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-sm font-medium text-gray-700">
                Camion {sp.indexCamion}/{sp.nbCamionsTotal}
              </span>
              <span className="text-xs bg-white px-2 py-0.5 rounded border">
                {sp.totalVelos}/{sp.capacite} vélos · {sp.stops.length} arrêt{sp.stops.length > 1 ? "s" : ""}
              </span>
            </div>

            <div className="space-y-1">
              {sp.stops.map((s, i) => (
                <div key={`${s.id}-${i}`} className="flex items-center gap-2 text-xs">
                  <span className="w-5 h-5 rounded-full bg-green-600 text-white flex items-center justify-center font-medium">
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0 truncate">
                    {s.entreprise}
                    {s.ville && <span className="text-gray-400"> · {s.ville}</span>}
                  </div>
                  <span className="text-gray-600 whitespace-nowrap">{s.nbVelos} v.</span>
                </div>
              ))}
            </div>

            <div>
              <label className="block text-xs text-gray-500 mb-1">Date prévue</label>
              <input
                type="date"
                value={dates[idx] || ""}
                min={today}
                onChange={(e) => {
                  const next = [...dates];
                  next[idx] = e.target.value;
                  setDates(next);
                }}
                className="w-full px-3 py-1.5 border rounded-lg text-sm bg-white"
              />
              {dates[idx] && (
                <p className="text-xs text-gray-500 mt-1 capitalize">{formatFrDate(dates[idx])}</p>
              )}
            </div>
          </div>
        ))}

        <div>
          <label className="block text-xs text-gray-500 mb-1">Notes (optionnel)</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="ex. conducteur Jean, contact sur place…"
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
          disabled={loading}
          className="w-full px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 text-sm font-medium"
        >
          {loading
            ? "Création en cours…"
            : `Planifier ${splits.length} tournée${splits.length > 1 ? "s" : ""} · ${splits.reduce((s, sp) => s + sp.totalVelos, 0)} vélos`}
        </button>
      </div>
    </div>
  );
}
