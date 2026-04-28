"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { gasPost } from "@/lib/gas";
import { useData } from "@/lib/data-context";
import MultiDepSelect from "@/components/multi-dep-select";
import DateLoadPicker, { type DayLoad } from "@/components/date-load-picker";
import AddClientModal from "@/components/add-client-modal";

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
  // - `carte` (allClients) : clients avec lat/lng → utilisé pour la carte + filtres dépt/CP
  // - `clients` (allClientsFull) : TOUS les clients → utilisé pour les compteurs
  //   du bandeau, pour qu'ils matchent /tableau-de-bord (sinon les clients sans
  //   coordonnées GPS étaient invisibles dans le total)
  // - `stats` : déjà calculé côté data context (même source que /tableau-de-bord)
  const { carte: allClients, clients: allClientsFull, livraisons, stats, flotte, refresh } = useData();
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"gros" | "moyen" | "camionnette" | "retrait">("moyen");
  // ID du camion spécifique sélectionné (pour passer la vraie capacité à
  // suggestTournee). null = bouton "type" générique sans camion précis.
  const [selectedCamionId, setSelectedCamionId] = useState<string | null>(null);
  const [maxDistance, setMaxDistance] = useState(50);
  const [selectedDeps, setSelectedDeps] = useState<string[]>([]);
  const [codePostal, setCodePostal] = useState("");
  const [search, setSearch] = useState("");
  const [tournee, setTournee] = useState<TourneeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [showAddClient, setShowAddClient] = useState(false);

  const departements = Array.from(
    new Set(
      allClients
        .map((c) => (c.departement == null || c.departement === "" ? null : String(c.departement)))
        .filter((d): d is string => d !== null)
    )
  ).sort((a, b) => a.localeCompare(b));

  const cpFilter = codePostal.trim();
  const searchQuery = search.trim().toLowerCase();
  // Vélos réellement planifiés par client = somme des nbVelos des livraisons
  // statut=planifiee. Source de vérité plus fiable que stats.planifies persisté
  // (qui peut dériver). Cf. fix /livraisons 2026-04-28.
  const planifiesParClient = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of livraisons) {
      if (l.statut !== "planifiee") continue;
      const cid = l.clientId;
      if (!cid) continue;
      m.set(cid, (m.get(cid) || 0) + (l.nbVelos || 0));
    }
    return m;
  }, [livraisons]);
  const clients = allClients
    .map((c) => ({ ...c, velosPlanifies: planifiesParClient.get(c.id) || 0 }))
    .filter((c) => {
    const reste = c.nbVelos - c.velosLivres - (c.velosPlanifies || 0);
    if (reste <= 0) return false;
    if (selectedDeps.length > 0 && !(c.departement != null && selectedDeps.includes(String(c.departement)))) {
      return false;
    }
    if (cpFilter && !(c.codePostal != null && String(c.codePostal).startsWith(cpFilter))) {
      return false;
    }
    if (searchQuery) {
      const hay = `${c.entreprise} ${c.contact ?? ""} ${c.apporteur ?? ""} ${c.ville ?? ""} ${c.email ?? ""}`.toLowerCase();
      if (!hay.includes(searchQuery)) return false;
    }
    return true;
  });

  const loadByDate = useMemo(() => {
    const map = new Map<string, { velos: number; tournees: Set<string>; modes: Set<string> }>();
    for (const l of livraisons) {
      if (l.statut === "annulee" || !l.datePrevue) continue;
      const iso = toISO(new Date(l.datePrevue));
      if (!map.has(iso)) map.set(iso, { velos: 0, tournees: new Set(), modes: new Set() });
      const e = map.get(iso)!;
      e.velos += l._count?.velos ?? l.nbVelos ?? 0;
      if (l.tourneeId) e.tournees.add(l.tourneeId);
      if (l.mode) e.modes.add(l.mode);
    }
    return new Map(
      Array.from(map.entries()).map(([k, v]) => [k, { velos: v.velos, tournees: v.tournees.size, modes: Array.from(v.modes) }])
    );
  }, [livraisons]);

  // Source de vérité = `stats` du data context (= même calcul que /tableau-de-bord :
  // somme de stats.totalVelos / stats.livres / stats.planifies sur tous les clients,
  // PAS seulement ceux qui ont lat/lng). On ajoute juste les compteurs spécifiques
  // à la page (nbTournees, clientsRestants).
  const dashStats = useMemo(() => {
    const totalVelos = stats?.totalVelos ?? 0;
    const velosLivres = stats?.velosLivres ?? 0;
    const velosPlanifies = stats?.velosPlanifies ?? 0;
    const velosRestants = totalVelos - velosLivres - velosPlanifies;
    const clientsRestants = allClientsFull.filter((c) => {
      const rest = c.stats.totalVelos - c.stats.livres - (c.stats.planifies || 0);
      return rest > 0;
    }).length;
    const tourneeIds = new Set(livraisons.filter((l) => l.tourneeId && l.statut !== "annulee").map((l) => l.tourneeId));
    const pct = totalVelos > 0 ? Math.round(((velosLivres + velosPlanifies) / totalVelos) * 100) : 0;
    return { totalVelos, velosLivres, velosPlanifies, velosRestants, clientsRestants, nbTournees: tourneeIds.size, pct };
  }, [stats, allClientsFull, livraisons]);

  const handleSelectClient = useCallback(
    async (clientId: string) => {
      setSelected(clientId);
      setLoading(true);
      // Passe la capacité réelle du camion sélectionné (sinon suggestTournee
      // utilise un défaut par type qui peut être obsolète).
      const camion = selectedCamionId ? flotte.find((c) => c.id === selectedCamionId) : null;
      const capacite = camion?.capaciteVelos;
      const data = await gasPost("suggestTournee", { clientId, mode, maxDistance, capacite });
      setTournee(data);
      setLoading(false);
    },
    [mode, maxDistance, selectedCamionId, flotte]
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
    <div className="flex flex-col h-[calc(100vh-5rem)] lg:h-[calc(100vh-4rem)]">
      {/* Dashboard bandeau */}
      <div className="bg-white border-b px-4 py-3 flex-shrink-0">
        <div className="flex flex-wrap gap-3 items-center">
          <DashCard label="Commandés" value={dashStats.totalVelos} unit="vélos" color="gray" />
          <DashCard label="Livrés" value={dashStats.velosLivres} unit="vélos" color="green" />
          <DashCard label="Planifiés" value={dashStats.velosPlanifies} unit="vélos" color="blue" />
          <DashCard label="Restants" value={dashStats.velosRestants} unit="vélos" color={dashStats.velosRestants > 0 ? "orange" : "green"} />
          <DashCard label="Tournées" value={dashStats.nbTournees} color="purple" />
          <DashCard label="Clients à livrer" value={dashStats.clientsRestants} color="red" />
          <div className="flex items-center gap-2 ml-auto">
            <div className="w-32 h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-green-500 rounded-full transition-all"
                style={{ width: `${dashStats.pct}%` }}
              />
            </div>
            <span className="text-xs font-medium text-gray-600">{dashStats.pct}%</span>
          </div>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row flex-1 min-h-0">
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
        <div className="p-4 border-b flex items-start justify-between gap-2">
          <div>
            <h2 className="font-semibold text-lg">Planification</h2>
            <p className="text-sm text-gray-500 mt-1">
              {clients.length} clients sur la carte
            </p>
          </div>
          <button
            onClick={() => setShowAddClient(true)}
            className="px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 text-xs font-medium whitespace-nowrap"
          >
            + Nouveau client
          </button>
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
              placeholder="Nom, contact, apporteur, ville..."
              className="w-full px-3 py-2 border-2 border-green-300 rounded-lg text-sm focus:border-green-500 focus:outline-none"
            />
            {searchQuery && (
              <p className="text-xs text-gray-400 mt-1">{clients.length} résultat{clients.length !== 1 ? "s" : ""}</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">Département</label>
              <MultiDepSelect
                value={selectedDeps}
                onChange={(deps) => { setSelectedDeps(deps); setSelected(null); setTournee(null); }}
                options={departements}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">Code postal</label>
              <input
                type="text"
                inputMode="numeric"
                value={codePostal}
                onChange={(e) => { setCodePostal(e.target.value); setSelected(null); setTournee(null); }}
                placeholder="ex. 75010"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">
              Type de camion
            </label>
            <div className="flex flex-wrap gap-1">
              {(() => {
                // Liste tous les camions actifs depuis Firestore (option B :
                // 1 bouton par camion individuel, pas par type). L'utilisateur
                // peut choisir précisément quel véhicule sera affecté à la
                // tournée — ça change la capacité passée à suggestTournee.
                // Type côté UI : `camionnette` = `petit` côté flotte (legacy).
                const typeForUI = (t: string) => (t === "petit" ? "camionnette" : t);
                const buttons = flotte
                  .filter((c) => c.actif)
                  .map((c) => ({
                    id: c.id,
                    type: typeForUI(c.type) as "gros" | "moyen" | "camionnette" | "retrait",
                    label: c.nom,
                    cap: c.capaciteVelos > 0 ? `${c.capaciteVelos} v.` : "client",
                  }));
                // Tri stable : Gros d'abord, puis moyens (capacité décroissante),
                // puis petits, puis retrait.
                const order: Record<string, number> = { gros: 0, moyen: 1, camionnette: 2, retrait: 3 };
                buttons.sort((a, b) => {
                  const da = order[a.type] ?? 9;
                  const db = order[b.type] ?? 9;
                  if (da !== db) return da - db;
                  // Capacité décroissante dans le même type
                  const ca = parseInt(a.cap) || 0;
                  const cb = parseInt(b.cap) || 0;
                  return cb - ca;
                });
                return buttons;
              })().map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => { setMode(opt.type); setSelectedCamionId(opt.id); }}
                  className={`flex-1 min-w-[60px] px-2 py-2 text-xs font-medium rounded-lg transition-colors ${
                    selectedCamionId === opt.id
                      ? "bg-green-600 text-white"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                  title={opt.label}
                >
                  <span className="block truncate">{opt.label}</span>
                  <span className="block text-[10px] font-normal opacity-80">{opt.cap}</span>
                </button>
              ))}
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

        {mode === "retrait" ? (
          <RetraitPanel
            clients={clients}
            loadByDate={loadByDate}
            onPlanned={() => { refresh("livraisons"); refresh("carte"); }}
          />
        ) : (
          <>
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
                    <div className="font-medium">Livraison multi-camions</div>
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
                  clientsProches={tournee.clientsProches}
                  loadByDate={loadByDate}
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
          </>
        )}
      </div>
      </div>
      {showAddClient && (
        <AddClientModal
          onClose={() => {
            setShowAddClient(false);
            refresh("clients");
            refresh("carte");
          }}
        />
      )}
    </div>
  );
}

function DashCard({ label, value, unit, color }: { label: string; value: number; unit?: string; color: string }) {
  const colors: Record<string, string> = {
    gray: "bg-gray-50 text-gray-700",
    green: "bg-green-50 text-green-700",
    blue: "bg-blue-50 text-blue-700",
    orange: "bg-orange-50 text-orange-700",
    purple: "bg-purple-50 text-purple-700",
    red: "bg-red-50 text-red-700",
  };
  return (
    <div className={`px-3 py-1.5 rounded-lg ${colors[color] ?? colors.gray}`}>
      <div className="text-lg font-bold leading-tight">{value.toLocaleString("fr-FR")}</div>
      <div className="text-[10px] uppercase tracking-wide opacity-70">{label}{unit ? ` (${unit})` : ""}</div>
    </div>
  );
}

function RetraitPanel({
  clients,
  loadByDate,
  onPlanned,
}: {
  clients: { id: string; entreprise: string; ville: string | null; nbVelos: number; velosLivres: number; velosPlanifies: number }[];
  loadByDate: Map<string, DayLoad>;
  onPlanned: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [searchR, setSearchR] = useState("");
  const [date, setDate] = useState(nextMondayISO());
  const [notes, setNotes] = useState("");
  const [monteurs, setMonteurs] = useState(2);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ tourneeId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const available = clients.filter((c) => {
    const rest = c.nbVelos - c.velosLivres - (c.velosPlanifies || 0);
    return rest > 0;
  });

  const filtered = searchR.trim()
    ? available.filter((c) => `${c.entreprise} ${c.ville ?? ""}`.toLowerCase().includes(searchR.trim().toLowerCase()))
    : available;

  const toggle = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const selectedClients = available.filter((c) => selected.has(c.id));
  const totalVelos = selectedClients.reduce((s, c) => s + (c.nbVelos - c.velosLivres - (c.velosPlanifies || 0)), 0);
  const totalMin = totalVelos * 8;
  const velosParMonteur = Math.floor(480 / 8);
  const capacite = monteurs * velosParMonteur;
  const faisable = totalVelos <= capacite;
  const fmtDuree = (min: number) => { const h = Math.floor(min / 60); const m = min % 60; return h > 0 ? `${h}h${m > 0 ? String(m).padStart(2, "0") : ""}` : `${m}min`; };

  const submit = async () => {
    if (selected.size === 0) return;
    setError(null);
    setLoading(true);
    try {
      const stops = selectedClients.map((c, i) => ({
        clientId: c.id,
        ordre: i + 1,
        nbVelos: c.nbVelos - c.velosLivres - (c.velosPlanifies || 0),
      }));
      const r = await gasPost("createTournee", {
        datePrevue: date,
        notes: notes.trim() ? `Retrait entrepôt — ${notes.trim()}` : "Retrait entrepôt",
        mode: "retrait",
        stops,
      });
      if (r.error) { setError(r.error); }
      else { setResult(r); onPlanned(); }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur");
    }
    setLoading(false);
  };

  if (result) {
    return (
      <div className="p-4">
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 space-y-3">
          <div className="flex items-start gap-2">
            <span className="text-emerald-600 text-xl leading-none">✓</span>
            <div>
              <div className="font-medium text-emerald-900">Journée retrait planifiée</div>
              <div className="text-xs text-emerald-700 mt-1">
                {selectedClients.length} client{selectedClients.length > 1 ? "s" : ""} · {totalVelos} vélos
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Link href="/livraisons" className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm">
              Voir l&apos;agenda
            </Link>
            <button onClick={() => { setResult(null); setSelected(new Set()); }} className="px-3 py-1.5 bg-white border border-emerald-300 text-emerald-700 rounded-lg hover:bg-emerald-100 text-sm">
              Nouveau retrait
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3">
      <div className="bg-purple-50 border border-purple-200 rounded-lg p-3 space-y-1">
        <div className="font-medium text-purple-900 text-sm">Journée retrait entrepôt</div>
        <div className="text-xs text-purple-700">
          Les clients viennent chercher leurs vélos. Ton équipe de monteurs + chef admin les attend sur place.
        </div>
      </div>

      <div>
        <label className="block text-xs text-gray-500 mb-1">Date du retrait</label>
        <DateLoadPicker value={date} onChange={setDate} minDate={todayISO()} loadByDate={loadByDate} />
      </div>

      <div className="flex items-center gap-3">
        <label className="text-xs text-gray-600">Monteurs :</label>
        <input type="number" min={1} max={20} value={monteurs} onChange={(e) => setMonteurs(Math.max(1, parseInt(e.target.value) || 1))} className="w-14 px-2 py-1 text-sm border rounded-lg text-center" />
        <span className="text-xs text-gray-500">+ 1 chef admin (photos)</span>
      </div>

      <div>
        <label className="block text-xs text-gray-500 mb-1">
          Sélectionner les clients ({selected.size} · {totalVelos} vélos)
        </label>
        <input
          type="text"
          value={searchR}
          onChange={(e) => setSearchR(e.target.value)}
          placeholder="Filtrer par nom..."
          className="w-full px-3 py-1.5 border rounded-lg text-sm mb-2"
        />
        <div className="border rounded-lg max-h-48 overflow-y-auto divide-y">
          {filtered.slice(0, 50).map((c) => {
            const rest = c.nbVelos - c.velosLivres - (c.velosPlanifies || 0);
            return (
              <label key={c.id} className={`flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-50 ${selected.has(c.id) ? "bg-purple-50" : ""}`}>
                <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                <span className="flex-1 truncate">{c.entreprise}</span>
                <span className="text-xs text-gray-500">{c.ville}</span>
                <span className="text-xs font-medium">{rest} v.</span>
              </label>
            );
          })}
          {filtered.length === 0 && <div className="px-3 py-4 text-xs text-gray-400 text-center">Aucun client avec des vélos à livrer</div>}
        </div>
      </div>

      {selected.size > 0 && (
        <div className={`text-sm font-medium rounded-lg px-3 py-2 ${faisable ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>
          {totalVelos} vélos × {MINUTES_PAR_VELO} min = {fmtDuree(totalMin)} · {monteurs} monteur{monteurs > 1 ? "s" : ""} → {fmtDuree(Math.round(totalMin / monteurs))}/monteur
          {!faisable && ` (dépasse 8h — capacité max : ${capacite} vélos)`}
        </div>
      )}

      <div>
        <label className="block text-xs text-gray-500 mb-1">Notes (optionnel)</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="ex. équipe de 3 + 1 chef admin, parking est..." rows={2} className="w-full px-3 py-2 border rounded-lg text-sm resize-none" />
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-2 text-xs text-red-700">{error}</div>}

      <button
        onClick={submit}
        disabled={loading || selected.size === 0}
        className="w-full px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 text-sm font-medium"
      >
        {loading ? "Création..." : `Planifier le retrait · ${selected.size} client${selected.size > 1 ? "s" : ""} · ${totalVelos} vélos`}
      </button>
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

const ENTREPOT = { lat: 48.9545398, lng: 2.4557494, label: "AXDIS PRO – Blanc-Mesnil" };
const MINUTES_PAR_VELO = 12;
const HEURES_JOURNEE = 8;
const ROAD_FACTOR = 1.3;
const KM_PAR_MIN = 0.5;

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function computeSplitMetrics(stops: TourneeStop[]): {
  totalKm: number;
  driveMin: number;
  unloadMin: number;
  totalMin: number;
  nbVelos: number;
  segments: { distKm: number; trajetMin: number }[];
  retour: { distKm: number; trajetMin: number };
} {
  const segments: { distKm: number; trajetMin: number }[] = [];
  let prevLat = ENTREPOT.lat;
  let prevLng = ENTREPOT.lng;
  let totalKm = 0;
  let driveMin = 0;
  let nbVelos = 0;
  for (const s of stops) {
    nbVelos += s.nbVelos;
    if (prevLat && prevLng && s.lat && s.lng) {
      const routeKm = haversineKm(prevLat, prevLng, s.lat, s.lng) * ROAD_FACTOR;
      const min = Math.round(routeKm / KM_PAR_MIN);
      segments.push({ distKm: Math.round(routeKm * 10) / 10, trajetMin: min });
      totalKm += routeKm;
      driveMin += min;
    } else {
      segments.push({ distKm: 0, trajetMin: 0 });
    }
    prevLat = s.lat;
    prevLng = s.lng;
  }
  const retour =
    prevLat && prevLng
      ? (() => {
          const routeKm = haversineKm(prevLat, prevLng, ENTREPOT.lat, ENTREPOT.lng) * ROAD_FACTOR;
          const min = Math.round(routeKm / KM_PAR_MIN);
          totalKm += routeKm;
          driveMin += min;
          return { distKm: Math.round(routeKm * 10) / 10, trajetMin: min };
        })()
      : { distKm: 0, trajetMin: 0 };
  const unloadMin = nbVelos * MINUTES_PAR_VELO;
  const totalMin = driveMin + unloadMin;
  return {
    totalKm: Math.round(totalKm * 10) / 10,
    driveMin,
    unloadMin,
    totalMin,
    nbVelos,
    segments,
    retour,
  };
}

function fmtDuree(min: number): string {
  if (min <= 0) return "0min";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h${m > 0 ? String(m).padStart(2, "0") : ""}` : `${m}min`;
}

function PlanifierSplits({
  mode,
  splits,
  clientsProches,
  loadByDate,
  onPlanned,
  resetTour,
}: {
  mode: string;
  splits: TourneeSplit[];
  clientsProches: TourneeResult["clientsProches"];
  loadByDate: Map<string, DayLoad>;
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
  const [editedSplits, setEditedSplits] = useState<TourneeSplit[]>(() =>
    splits.map((s) => ({ ...s, stops: [...s.stops] }))
  );

  // Re-init dates + stops quand la suggestion serveur change (nouveau client cible / nouveau mode)
  useEffect(() => {
    const start = nextMondayISO();
    setDates(splits.map((_, i) => addDaysISO(start, i)));
    setEditedSplits(splits.map((s) => ({ ...s, stops: [...s.stops] })));
  }, [splits]); // eslint-disable-line react-hooks/exhaustive-deps

  const removeStop = (splitIdx: number, stopIdx: number) => {
    setEditedSplits((prev) =>
      prev.map((sp, i) => {
        if (i !== splitIdx) return sp;
        const stops = sp.stops.filter((_, j) => j !== stopIdx);
        const totalVelos = stops.reduce((sum, s) => sum + s.nbVelos, 0);
        return { ...sp, stops, totalVelos };
      })
    );
  };

  const addStopFromCandidate = (
    splitIdx: number,
    candidate: TourneeResult["clientsProches"][number]
  ) => {
    setEditedSplits((prev) =>
      prev.map((sp, i) => {
        if (i !== splitIdx) return sp;
        const used = sp.stops.reduce((sum, s) => sum + s.nbVelos, 0);
        const free = Math.max(0, sp.capacite - used);
        const nb = Math.min(candidate.velosRestants, free);
        if (nb <= 0) return sp;
        const newStop: TourneeStop = {
          id: candidate.id,
          entreprise: candidate.entreprise,
          ville: candidate.ville,
          lat: candidate.lat,
          lng: candidate.lng,
          nbVelos: nb,
          distance: candidate.distance,
        };
        const stops = [...sp.stops, newStop];
        return { ...sp, stops, totalVelos: used + nb };
      })
    );
  };

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
    const nonEmptySplits = editedSplits.filter((sp) => sp.stops.length > 0);
    if (nonEmptySplits.length === 0) {
      setError("Aucun arrêt à planifier");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      if (nonEmptySplits.length === 1) {
        const r = await gasPost("createTournee", {
          datePrevue: dates[0],
          notes: notes.trim(),
          mode,
          stops: nonEmptySplits[0].stops.map((s, i) => ({
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
        const tournees = nonEmptySplits.map((sp, idx) => ({
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
        {editedSplits.map((sp, idx) => {
          const isRetrait = mode === "retrait";
          const metrics = !isRetrait ? computeSplitMetrics(sp.stops) : null;
          const depasseJournee = metrics ? metrics.totalMin > HEURES_JOURNEE * 60 : false;
          const isEmpty = sp.stops.length === 0;
          return (
          <div key={idx} className="border rounded-lg p-3 bg-gray-50 space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-sm font-medium text-gray-700">
                Camion {sp.indexCamion}/{sp.nbCamionsTotal}
              </span>
              <span className="text-xs bg-white px-2 py-0.5 rounded border">
                {sp.totalVelos}/{sp.capacite} vélos · {sp.stops.length} arrêt{sp.stops.length > 1 ? "s" : ""}
              </span>
            </div>

            {metrics && (
              <div
                className={`text-[11px] rounded px-2 py-1.5 border ${
                  depasseJournee
                    ? "bg-red-50 border-red-200 text-red-800"
                    : "bg-white border-gray-200 text-gray-700"
                }`}
              >
                <div className="flex justify-between gap-2 flex-wrap">
                  <span>
                    📍 {metrics.totalKm} km aller-retour · roulage {fmtDuree(metrics.driveMin)}
                  </span>
                  <span>
                    déchargement {fmtDuree(metrics.unloadMin)}{" "}
                    <span className="text-gray-400">({sp.totalVelos}×{MINUTES_PAR_VELO}min)</span>
                  </span>
                </div>
                <div className="flex justify-between gap-2 mt-0.5 font-medium">
                  <span>Total 1 monteur : {fmtDuree(metrics.totalMin)}</span>
                  {depasseJournee && <span>⚠ dépasse {HEURES_JOURNEE}h</span>}
                </div>
              </div>
            )}

            <div className="space-y-1">
              {!isRetrait && (
                <div className="text-[10px] text-gray-400 pl-7">📍 départ {ENTREPOT.label}</div>
              )}
              {sp.stops.map((s, i) => (
                <div key={`${s.id}-${i}`}>
                  {metrics && i > 0 && metrics.segments[i] && metrics.segments[i].distKm > 0 && (
                    <div className="text-[10px] text-gray-400 pl-7 py-0.5">
                      ↓ {metrics.segments[i].distKm} km · ~{metrics.segments[i].trajetMin} min
                    </div>
                  )}
                  {metrics && i === 0 && metrics.segments[0] && metrics.segments[0].distKm > 0 && (
                    <div className="text-[10px] text-gray-400 pl-7 py-0.5">
                      ↓ {metrics.segments[0].distKm} km · ~{metrics.segments[0].trajetMin} min
                    </div>
                  )}
                  <div className="flex items-center gap-2 text-xs group">
                    <span className="w-5 h-5 rounded-full bg-green-600 text-white flex items-center justify-center font-medium">
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0 truncate">
                      {s.entreprise}
                      {s.ville && <span className="text-gray-400"> · {s.ville}</span>}
                    </div>
                    <span className="text-gray-600 whitespace-nowrap">{s.nbVelos} v.</span>
                    <button
                      type="button"
                      onClick={() => removeStop(idx, i)}
                      className="text-gray-300 hover:text-red-600 transition-colors text-sm leading-none px-1"
                      title="Retirer ce client (client pas dispo ce jour-là)"
                      aria-label={`Retirer ${s.entreprise}`}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
              {metrics && metrics.retour.distKm > 0 && (
                <div className="text-[10px] text-gray-400 pl-7 py-0.5">
                  ↩ retour {ENTREPOT.label} · {metrics.retour.distKm} km · ~{metrics.retour.trajetMin} min
                </div>
              )}
            </div>

            {!isRetrait && !isEmpty && (() => {
              const used = sp.stops.reduce((acc, s) => acc + s.nbVelos, 0);
              const free = sp.capacite - used;
              if (free <= 0) return null;
              const inSplit = new Set(sp.stops.map((s) => s.id));
              const candidates = (clientsProches || [])
                .filter((c) => !inSplit.has(c.id) && c.velosRestants > 0)
                .slice(0, 8);
              if (candidates.length === 0) return null;
              return (
                <div className="rounded-lg border border-dashed border-green-300 bg-green-50/50 p-2 space-y-1">
                  <div className="text-[11px] font-medium text-green-900 flex justify-between">
                    <span>🔁 Remplir le camion</span>
                    <span className="text-green-700">{free} v. libres</span>
                  </div>
                  <div className="text-[10px] text-gray-600">Clients proches éligibles, triés par distance :</div>
                  <div className="space-y-1">
                    {candidates.map((c) => {
                      const nb = Math.min(c.velosRestants, free);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => addStopFromCandidate(idx, c)}
                          className="w-full flex items-center gap-2 px-2 py-1.5 text-xs bg-white border rounded hover:border-green-400 hover:bg-green-50 text-left"
                        >
                          <span className="flex-1 min-w-0 truncate">
                            {c.entreprise}
                            {c.ville && <span className="text-gray-400"> · {c.ville}</span>}
                          </span>
                          <span className="text-gray-500 whitespace-nowrap">{c.distance} km</span>
                          <span className="text-green-700 font-medium whitespace-nowrap">+{nb} v.</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {isEmpty ? (
              <div className="text-xs text-gray-400 italic text-center py-2">
                Tournée vide — tous les arrêts retirés. Relance une nouvelle suggestion si besoin.
              </div>
            ) : (
              <div>
                <label className="block text-xs text-gray-500 mb-1">Date prévue</label>
                <DateLoadPicker
                  value={dates[idx] || ""}
                  onChange={(iso) => {
                    const next = [...dates];
                    next[idx] = iso;
                    setDates(next);
                  }}
                  minDate={today}
                  loadByDate={loadByDate}
                />
                {dates[idx] && (
                  <p className="text-xs text-gray-500 mt-1 capitalize">{formatFrDate(dates[idx])}</p>
                )}
              </div>
            )}
          </div>
          );
        })}

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

        {(() => {
          const nonEmpty = editedSplits.filter((sp) => sp.stops.length > 0);
          const totalVelos = nonEmpty.reduce((s, sp) => s + sp.totalVelos, 0);
          return (
            <button
              onClick={submit}
              disabled={loading || nonEmpty.length === 0}
              className="w-full px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 text-sm font-medium"
            >
              {loading
                ? "Création en cours…"
                : nonEmpty.length === 0
                ? "Aucun arrêt à planifier"
                : `Planifier ${nonEmpty.length} tournée${nonEmpty.length > 1 ? "s" : ""} · ${totalVelos} vélos`}
            </button>
          );
        })()}
      </div>
    </div>
  );
}
