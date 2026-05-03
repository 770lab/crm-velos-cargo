"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { gasPost } from "@/lib/gas";
import { useData } from "@/lib/data-context";
import MultiDepSelect from "@/components/multi-dep-select";
import DateLoadPicker, { type DayLoad } from "@/components/date-load-picker";
import AddClientModal from "@/components/add-client-modal";
// Yoann 2026-05-01 : suggestion depuis /carte (voir clients alentours
// pendant la planif). Le panneau encapsule le bouton + les 2 modals
// (suggestion 1 tournée + planificateur journée).
import { SuggererTourneePanel, SuggererTourneeModal, PlanifierJourneeModal } from "@/app/entrepots/page";

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
  // Vue (Yoann 2026-05-01) : "clients" = vue actuelle (clients à livrer),
  // "entrepots" = vue dépôts + stocks, "hybride" = les deux superposés.
  const [vue, setVue] = useState<"clients" | "entrepots" | "hybride">("clients");
  // Entrepôts (Yoann 2026-05-01) : chargés une fois depuis Firestore et
  // passés à la fois au MapView (markers) et à l'EntrepotsPanel.
  type EntrepotMapPoint = {
    id: string;
    nom: string;
    ville: string;
    adresse: string;
    role: "fournisseur" | "stock" | "ephemere";
    isPrimary: boolean;
    archived: boolean;
    stockCartons: number;
    stockVelosMontes: number;
    capaciteMax: number | null;
    groupeClient?: string | null;
    lat: number | null;
    lng: number | null;
  };
  const [entrepotsList, setEntrepotsList] = useState<EntrepotMapPoint[]>([]);
  const [selectedEntrepotId, setSelectedEntrepotId] = useState<string | null>(null);
  // Yoann 2026-05-01 : modal Suggérer ouvert depuis click entrepôt (map ou
  // encart "+proche") — bypasse la sidebar pour aller direct à la planif.
  const [quickSuggestEntrepot, setQuickSuggestEntrepot] = useState<EntrepotMapPoint | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const { collection, onSnapshot } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      const unsub = onSnapshot(collection(db, "entrepots"), (snap) => {
        if (!alive) return;
        const rows: EntrepotMapPoint[] = [];
        for (const d of snap.docs) {
          const data = d.data();
          rows.push({
            id: d.id,
            nom: String(data.nom || ""),
            ville: String(data.ville || ""),
            adresse: String(data.adresse || ""),
            role: data.role === "fournisseur" || data.role === "ephemere" ? data.role : "stock",
            isPrimary: !!data.isPrimary,
            archived: !!data.dateArchivage,
            stockCartons: Number(data.stockCartons || 0),
            stockVelosMontes: Number(data.stockVelosMontes || 0),
            capaciteMax: typeof data.capaciteMax === "number" ? data.capaciteMax : null,
            groupeClient: typeof data.groupeClient === "string" ? data.groupeClient : null,
            lat: typeof data.lat === "number" ? data.lat : null,
            lng: typeof data.lng === "number" ? data.lng : null,
          });
        }
        rows.sort((a, b) => {
          if (a.archived !== b.archived) return a.archived ? 1 : -1;
          if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
          return a.nom.localeCompare(b.nom);
        });
        setEntrepotsList(rows);
      });
      return () => unsub();
    })();
    return () => { alive = false; };
  }, []);
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
  // Vélos réellement planifiés / livrés par client = somme des nbVelos des
  // livraisons par statut. Source de vérité plus fiable que stats.planifies /
  // stats.velosLivres persistés (qui peuvent dériver et donner des points
  // "fantômes" sur la carte → 30-04 10h20 demande Yoann : les clients déjà
  // 100% planifiés ou livrés ne doivent plus apparaître sur la carte).
  const flagsParClient = useMemo(() => {
    const m = new Map<string, { planifie: number; livre: number }>();
    for (const l of livraisons) {
      if (l.statut === "annulee") continue;
      const cid = l.clientId;
      if (!cid) continue;
      const cur = m.get(cid) || { planifie: 0, livre: 0 };
      if (l.statut === "livree") {
        cur.livre += l.nbVelos || 0;
      } else {
        // planifiee, en_cours, autres états non-annulés
        cur.planifie += l.nbVelos || 0;
      }
      m.set(cid, cur);
    }
    return m;
  }, [livraisons]);
  const clients = allClients
    .map((c) => {
      const f = flagsParClient.get(c.id) || { planifie: 0, livre: 0 };
      // On prend le MAX entre le compteur persisté (c.velosLivres) et le compteur
      // live (somme livraisons livrées) : si l'un des deux est plus grand, c'est
      // qu'il reflète mieux la réalité — on évite les régressions sur clients
      // sans livraisons en base mais avec velosLivres > 0 (ancien import).
      const velosLivresEffectif = Math.max(c.velosLivres || 0, f.livre);
      return { ...c, velosPlanifies: f.planifie, velosLivresEffectif };
    })
    .filter((c) => {
    const reste = c.nbVelos - c.velosLivresEffectif - (c.velosPlanifies || 0);
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
    // Vélos planifiés = SOMME(nbVelos) des livraisons statut=planifiee
    // (et non count livraisons comme stats.planifies persisté). Sans ça,
    // 39 livraisons de 8 vélos donnaient "39 planifiés" au lieu de ~312.
    const velosPlanifiesLive = livraisons
      .filter((l) => l.statut === "planifiee")
      .reduce((s, l) => s + (l.nbVelos || 0), 0);
    const velosRestants = totalVelos - velosLivres - velosPlanifiesLive;
    // Clients restants (au moins 1 vélo non livré ni planifié) — calcul
    // live aussi via Map clientId → nbVelosPlanifies(live).
    const planifByClient = new Map<string, number>();
    for (const l of livraisons) {
      if (l.statut !== "planifiee") continue;
      const cid = l.clientId;
      if (!cid) continue;
      planifByClient.set(cid, (planifByClient.get(cid) || 0) + (l.nbVelos || 0));
    }
    const clientsRestants = allClientsFull.filter((c) => {
      const planif = planifByClient.get(c.id) || 0;
      const rest = c.stats.totalVelos - c.stats.livres - planif;
      return rest > 0;
    }).length;
    const tourneeIds = new Set(livraisons.filter((l) => l.tourneeId && l.statut !== "annulee").map((l) => l.tourneeId));
    const pct = totalVelos > 0 ? Math.round(((velosLivres + velosPlanifiesLive) / totalVelos) * 100) : 0;
    return { totalVelos, velosLivres, velosPlanifies: velosPlanifiesLive, velosRestants, clientsRestants, nbTournees: tourneeIds.size, pct };
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

  // Yoann 2026-05-01 : entrepôt le + proche du client cliqué (Haversine vol
  // d oiseau, suffisant pour la sélection — Maps Directions n améliore pas
  // l ordre relatif des entrepôts de manière significative). Filtre :
  // non-fournisseur, non-archivé, avec stock > 0 dans au moins 1 mode.
  const entrepotLePlusProche = useMemo(() => {
    if (!selectedClient || !selectedClient.lat || !selectedClient.lng) return null;
    const candidats = entrepotsList.filter(
      (e) =>
        e.role !== "fournisseur" &&
        e.role !== "ephemere" && // Yoann 2026-05-03 : stock client, pas dans nos tournées
        !e.archived &&
        e.lat != null &&
        e.lng != null &&
        e.stockCartons + e.stockVelosMontes > 0,
    );
    if (candidats.length === 0) return null;
    const haversine = (a1: number, a2: number, b1: number, b2: number) => {
      const R = 6371;
      const dLat = ((b1 - a1) * Math.PI) / 180;
      const dLng = ((b2 - a2) * Math.PI) / 180;
      const lat1 = (a1 * Math.PI) / 180;
      const lat2 = (b1 * Math.PI) / 180;
      const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
    };
    let best: { e: EntrepotMapPoint; dist: number } | null = null;
    for (const e of candidats) {
      const d = haversine(selectedClient.lat!, selectedClient.lng!, e.lat as number, e.lng as number);
      if (!best || d < best.dist) best = { e, dist: d };
    }
    return best;
  }, [selectedClient, entrepotsList]);
  const allTourneeIds = new Set<string>();
  if (tournee?.splits) {
    tournee.splits.forEach((sp) => sp.stops.forEach((s) => allTourneeIds.add(s.id)));
  }
  // Pour la polyline (route map), on prend la 1ère tournée par défaut
  const firstSplitStops = tournee?.splits?.[0]?.stops ?? tournee?.tournee ?? [];

  // Yoann 2026-05-01 — Phase 1.3 : fetch polyline Google Maps Directions
  // pour afficher la VRAIE route sur la carte (au lieu de la ligne droite
  // vol d oiseau). Refetch quand firstSplitStops change. Best-effort : si
  // Maps KO, fallback transparent vers ligne droite.
  const [routePolyline, setRoutePolyline] = useState<string | null>(null);
  useEffect(() => {
    if (!firstSplitStops || firstSplitStops.length < 2) {
      setRoutePolyline(null);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const r = (await gasPost("getRouting", {
          points: firstSplitStops.map((s) => ({ lat: s.lat, lng: s.lng })),
          directions: true,
        })) as { ok?: boolean; polylineEncoded?: string };
        if (alive) setRoutePolyline(r.ok && r.polylineEncoded ? r.polylineEncoded : null);
      } catch {
        if (alive) setRoutePolyline(null);
      }
    })();
    return () => { alive = false; };
  }, [firstSplitStops]);

  return (
    <div className="flex flex-col h-[calc(100vh-5rem)] lg:h-[calc(100vh-4rem)]">
      {/* Dashboard bandeau — Yoann 2026-05-03 : layout responsive
          (grid 3x2 mobile, flex-wrap desktop) pour ne plus déborder sur iPhone. */}
      <div className="bg-white border-b px-2 sm:px-4 py-2 sm:py-3 flex-shrink-0">
        <div className="grid grid-cols-3 sm:flex sm:flex-wrap gap-1.5 sm:gap-3 sm:items-center">
          <DashCard label="Commandés" value={dashStats.totalVelos} unit="vélos" color="gray" />
          <DashCard label="Livrés" value={dashStats.velosLivres} unit="vélos" color="green" />
          <DashCard label="Planifiés" value={dashStats.velosPlanifies} unit="vélos" color="blue" />
          <DashCard label="Restants" value={dashStats.velosRestants} unit="vélos" color={dashStats.velosRestants > 0 ? "orange" : "green"} />
          <DashCard label="Tournées" value={dashStats.nbTournees} color="purple" />
          <DashCard label="Clients à livrer" value={dashStats.clientsRestants} color="red" />
        </div>
        <div className="flex items-center gap-2 mt-2 sm:mt-0 sm:ml-auto sm:inline-flex sm:float-right">
          {/* Toggle vue (Yoann 2026-05-01) : clients / entrepôts / hybride */}
          <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden flex-shrink-0">
            <button
              onClick={() => setVue("clients")}
              className={`px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs font-medium ${
                vue === "clients" ? "bg-blue-600 text-white" : "bg-white text-gray-700 hover:bg-gray-50"
              }`}
              title="Vue clients à livrer uniquement"
            >
              🏢 Clients
            </button>
            <button
              onClick={() => setVue("entrepots")}
              className={`px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs font-medium border-l border-gray-300 ${
                vue === "entrepots" ? "bg-blue-600 text-white" : "bg-white text-gray-700 hover:bg-gray-50"
              }`}
              title="Vue entrepôts + stocks uniquement"
            >
              🏬 Entrepôts
            </button>
            <button
              onClick={() => setVue("hybride")}
              className={`px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs font-medium border-l border-gray-300 ${
                vue === "hybride" ? "bg-blue-600 text-white" : "bg-white text-gray-700 hover:bg-gray-50"
              }`}
              title="Vue hybride : clients + entrepôts en même temps"
            >
              🔀 Les deux
            </button>
          </div>
          <div className="flex-1 sm:w-32 sm:flex-initial h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-green-500 rounded-full transition-all"
              style={{ width: `${dashStats.pct}%` }}
            />
          </div>
          <span className="text-xs font-medium text-gray-600 flex-shrink-0">{dashStats.pct}%</span>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row flex-1 min-h-0">
      <div className="flex-1 relative min-h-[300px]">
        <MapView
          clients={clients}
          selectedId={selected}
          tourneeIds={allTourneeIds}
          tournee={firstSplitStops}
          routePolylineEncoded={routePolyline}
          onSelectClient={handleSelectClient}
          entrepots={entrepotsList
            .filter((e) => e.lat != null && e.lng != null)
            .map((e) => ({
              id: e.id,
              nom: e.nom,
              ville: e.ville,
              lat: e.lat as number,
              lng: e.lng as number,
              role: e.role,
              isPrimary: e.isPrimary,
              archived: e.archived,
              stockCartons: e.stockCartons,
              stockVelosMontes: e.stockVelosMontes,
            }))}
          hideClients={vue === "entrepots"} /* clients visibles en mode "clients" et "hybride" */
          selectedEntrepotId={selectedEntrepotId}
          onSelectEntrepot={(id) => {
            // Yoann 2026-05-01 : click marker entrepôt sur la map → ouvre
            // directement le modal Suggérer (au lieu de juste basculer la
            // vue sidebar). Plus rapide pour planifier une tournée.
            setSelectedEntrepotId(id);
            const ep = entrepotsList.find((x) => x.id === id);
            if (ep && ep.role !== "fournisseur" && ep.role !== "ephemere" && !ep.archived && ep.stockCartons + ep.stockVelosMontes > 0) {
              setQuickSuggestEntrepot(ep);
            } else {
              // Fournisseur / éphémère / archivé / vide → ancien comportement (sidebar)
              setVue("entrepots");
            }
          }}
        />
      </div>

      <div className="w-full lg:w-96 bg-white border-t lg:border-t-0 lg:border-l overflow-y-auto max-h-[50vh] lg:max-h-none">
        {(vue === "entrepots" || vue === "hybride") && <EntrepotsPanel />}
        {(vue === "clients" || vue === "hybride") && (
        <>
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
              <>
                <p className="text-xs text-gray-400 mt-1">{clients.length} résultat{clients.length !== 1 ? "s" : ""}</p>
                {clients.length > 0 && (
                  <ul className="mt-1 max-h-64 overflow-auto border border-gray-200 rounded-lg divide-y divide-gray-100 bg-white">
                    {clients.slice(0, 20).map((c) => {
                      const reste = c.nbVelos - c.velosLivres - (c.velosPlanifies || 0);
                      return (
                        <li key={c.id}>
                          <button
                            type="button"
                            onClick={() => { handleSelectClient(c.id); setSearch(""); }}
                            className="w-full text-left px-3 py-2 hover:bg-green-50 focus:bg-green-50 focus:outline-none"
                          >
                            <div className="text-sm font-medium text-gray-900 truncate">{c.entreprise}</div>
                            <div className="text-xs text-gray-500 truncate">
                              {c.ville ?? "—"}{c.codePostal ? ` · ${c.codePostal}` : ""} · {reste}v à planifier
                              {c.apporteur ? ` · ${c.apporteur}` : ""}
                            </div>
                          </button>
                        </li>
                      );
                    })}
                    {clients.length > 20 && (
                      <li className="px-3 py-1.5 text-xs text-gray-400 italic">+ {clients.length - 20} autres — affine la recherche</li>
                    )}
                  </ul>
                )}
              </>
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
                {/* Yoann 2026-05-01 : entrepôt le + proche du client cliqué.
                    Click → ouvre direct le modal Suggérer pour cet entrepôt. */}
                {entrepotLePlusProche && (
                  <div className="bg-blue-50 border border-blue-300 rounded-lg p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs text-blue-900 min-w-0">
                        🏬 <strong>Entrepôt le + proche</strong>
                        <div className="text-sm font-bold text-blue-900 mt-0.5 truncate">
                          {entrepotLePlusProche.e.nom}
                          <span className="ml-1 text-[11px] font-normal text-blue-700">
                            · {Math.round(entrepotLePlusProche.dist * 10) / 10} km · {entrepotLePlusProche.e.stockCartons + entrepotLePlusProche.e.stockVelosMontes} v dispo
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={() => setQuickSuggestEntrepot(entrepotLePlusProche.e)}
                        className="px-2 py-1 text-[11px] bg-indigo-600 text-white rounded hover:bg-indigo-700 font-semibold shrink-0"
                        title="Suggérer une tournée depuis cet entrepôt (le client cliqué fait probablement partie de la sélection)"
                      >
                        🤖 Suggérer
                      </button>
                    </div>
                  </div>
                )}

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
      {/* Yoann 2026-05-01 : modal Suggérer rendu au niveau parent pour pouvoir
          être déclenché depuis (a) click marker entrepôt, (b) bouton encart
          "+proche" sur client sélectionné. */}
      {quickSuggestEntrepot && (
        <SuggererTourneeModal
          entrepotId={quickSuggestEntrepot.id}
          entrepotNom={quickSuggestEntrepot.nom}
          stockCartons={quickSuggestEntrepot.stockCartons}
          stockVelosMontes={quickSuggestEntrepot.stockVelosMontes}
          onClose={() => setQuickSuggestEntrepot(null)}
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
    <div className={`px-2 py-1 sm:px-3 sm:py-1.5 rounded-lg min-w-0 ${colors[color] ?? colors.gray}`}>
      <div className="text-sm sm:text-lg font-bold leading-tight truncate">{value.toLocaleString("fr-FR")}</div>
      <div className="text-[9px] sm:text-[10px] uppercase tracking-wide opacity-70 truncate">{label}{unit ? ` (${unit})` : ""}</div>
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

// Vue entrepôts (Yoann 2026-05-01) : panneau sidebar qui liste les
// dépôts avec leurs stocks pour planifier les tournées en fonction du
// stock disponible. Subscribe direct Firestore.
function EntrepotsPanel() {
  type EntrepotMini = {
    id: string;
    nom: string;
    ville: string;
    adresse: string;
    role: "fournisseur" | "stock" | "ephemere";
    isPrimary: boolean;
    archived: boolean;
    stockCartons: number;
    stockVelosMontes: number;
    capaciteMax: number | null;
    groupeClient?: string | null;
  };
  const [entrepots, setEntrepots] = useState<EntrepotMini[]>([]);
  const [showStrategie, setShowStrategie] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      const { collection, onSnapshot } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      const unsub = onSnapshot(collection(db, "entrepots"), (snap) => {
        if (!alive) return;
        const rows: EntrepotMini[] = [];
        for (const d of snap.docs) {
          const data = d.data();
          rows.push({
            id: d.id,
            nom: String(data.nom || ""),
            ville: String(data.ville || ""),
            adresse: String(data.adresse || ""),
            role: data.role === "fournisseur" || data.role === "ephemere" ? data.role : "stock",
            isPrimary: !!data.isPrimary,
            archived: !!data.dateArchivage,
            stockCartons: Number(data.stockCartons || 0),
            stockVelosMontes: Number(data.stockVelosMontes || 0),
            capaciteMax: typeof data.capaciteMax === "number" ? data.capaciteMax : null,
            groupeClient: typeof data.groupeClient === "string" ? data.groupeClient : null,
          });
        }
        rows.sort((a, b) => {
          if (a.archived !== b.archived) return a.archived ? 1 : -1;
          if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
          return a.nom.localeCompare(b.nom);
        });
        setEntrepots(rows);
      });
      return () => unsub();
    })();
    return () => { alive = false; };
  }, []);
  const stockTracked = entrepots.filter((e) => e.role !== "fournisseur" && !e.archived);
  const totalCartons = stockTracked.reduce((s, e) => s + e.stockCartons, 0);
  const totalMontes = stockTracked.reduce((s, e) => s + e.stockVelosMontes, 0);
  const totalDispo = totalCartons + totalMontes;
  return (
    <div>
      <div className="p-4 border-b">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold text-lg">🏬 Entrepôts</h2>
          <button
            onClick={() => setShowStrategie(true)}
            className="px-2 py-1 text-[11px] bg-gradient-to-r from-purple-600 to-indigo-600 text-white rounded hover:opacity-90 font-semibold whitespace-nowrap"
            title="Demande à Gemini de proposer 3 stratégies de planification de la journée"
          >
            🧠 Stratégie IA
          </button>
        </div>
        <p className="text-sm text-gray-500 mt-1">
          Stock disponible par dépôt pour planifier les tournées.
        </p>
      </div>
      {showStrategie && (
        <StrategieGeminiModal onClose={() => setShowStrategie(false)} />
      )}
      <div className="p-3 border-b bg-gray-50">
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-white border rounded p-2 text-center">
            <div className="text-[10px] uppercase text-gray-500 font-semibold">Cartons</div>
            <div className="text-lg font-bold text-orange-700">{totalCartons}</div>
          </div>
          <div className="bg-white border rounded p-2 text-center">
            <div className="text-[10px] uppercase text-gray-500 font-semibold">Montés</div>
            <div className="text-lg font-bold text-emerald-700">{totalMontes}</div>
          </div>
          <div className="bg-white border rounded p-2 text-center">
            <div className="text-[10px] uppercase text-gray-500 font-semibold">Total dispo</div>
            <div className="text-lg font-bold text-gray-900">{totalDispo}</div>
          </div>
        </div>
      </div>
      <div className="divide-y">
        {entrepots.map((e) => {
          const isFournisseur = e.role === "fournisseur";
          const isEphemere = e.role === "ephemere";
          const total = e.stockCartons + e.stockVelosMontes;
          const occPct = e.capaciteMax && e.capaciteMax > 0
            ? Math.round((total / e.capaciteMax) * 100)
            : null;
          return (
            <div
              key={e.id}
              className={`p-3 ${
                e.archived ? "opacity-50"
                : e.isPrimary ? "bg-blue-50/30"
                : isEphemere ? "bg-purple-50/30"
                : ""
              }`}
            >
              <div className="flex items-start justify-between gap-2 mb-1">
                <div className="min-w-0">
                  <div className="font-semibold text-sm flex items-center gap-1">
                    {e.isPrimary ? "🏭" : isEphemere ? "🟣" : "📦"} {e.nom}
                    {e.archived && (
                      <span className="text-[9px] px-1 py-0.5 bg-gray-200 text-gray-600 rounded">archivé</span>
                    )}
                  </div>
                  <div className="text-[11px] text-gray-500 truncate">
                    {e.adresse}, {e.ville}
                  </div>
                  {isEphemere && e.groupeClient && (
                    <div className="text-[10px] text-purple-700 font-medium">
                      👥 Groupe : {e.groupeClient}
                    </div>
                  )}
                </div>
              </div>
              {isFournisseur ? (
                <div className="text-[11px] text-gray-500 italic">
                  Stock géré chez le fournisseur, pas tracé.
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <div className="bg-orange-50 border border-orange-200 rounded p-1.5 text-center">
                    <div className="text-[9px] uppercase text-orange-700 font-semibold">Cartons</div>
                    <div className="text-base font-bold text-orange-900">{e.stockCartons}</div>
                  </div>
                  <div className="bg-emerald-50 border border-emerald-200 rounded p-1.5 text-center">
                    <div className="text-[9px] uppercase text-emerald-700 font-semibold">Montés</div>
                    <div className="text-base font-bold text-emerald-900">{e.stockVelosMontes}</div>
                  </div>
                </div>
              )}
              {occPct != null && (
                <div className="mt-1.5">
                  <div className="text-[10px] text-gray-500 mb-0.5">
                    Occupation : {occPct}% ({total}/{e.capaciteMax})
                  </div>
                  <div className="w-full h-1 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${occPct > 90 ? "bg-red-500" : occPct > 70 ? "bg-orange-500" : "bg-emerald-500"}`}
                      style={{ width: `${Math.min(100, occPct)}%` }}
                    />
                  </div>
                </div>
              )}
              {/* Yoann 2026-05-01 : suggestion + planificateur journée
                  directement depuis la sidebar Carte, pour visualiser les
                  clients alentours pendant la planif. */}
              {!isFournisseur && !isEphemere && !e.archived && total > 0 && (
                <div className="mt-2">
                  <SuggererTourneePanel
                    entrepotId={e.id}
                    entrepotNom={e.nom}
                    stockCartons={e.stockCartons}
                    stockVelosMontes={e.stockVelosMontes}
                  />
                </div>
              )}
              {/* Yoann 2026-05-03 : éphémère = stock client (Firat Food etc),
                  livré par le client à ses propres magasins. Pas dans nos
                  tournées. On peut quand même planifier une session de
                  montage+livraison sur place (camion client + chef de chez
                  nous présent). */}
              {isEphemere && (
                <SessionSurSitePanel
                  entrepotId={e.id}
                  entrepotNom={e.nom}
                  groupeClient={e.groupeClient || e.nom}
                  stockTotal={total}
                />
              )}
            </div>
          );
        })}
        {entrepots.length === 0 && (
          <div className="p-6 text-center text-sm text-gray-400 italic">
            Aucun entrepôt configuré.
          </div>
        )}
      </div>
      <div className="p-3 border-t bg-gray-50 text-[11px] text-gray-500">
        💡 Pour gérer les stocks et passer commande à Tiffany, va sur la page
        <a href="/entrepots" className="text-blue-600 hover:underline ml-1">Entrepôts</a>.
      </div>
    </div>
  );
}

// StrategieGeminiModal — Yoann 2026-05-01 — Phase 3.1
// Demande à Gemini 3 plans de planification journée alternatifs avec narratif
// et tradeoffs. L IA voit l état complet : entrepôts + stocks + clients
// restants + capacités. Elle propose 3 stratégies différentes et recommande.
type GeminiPlan = {
  titre: string;
  strategie: string;
  narratif: string;
  params: {
    entrepotId: string;
    entrepotNom: string;
    modeCamion: string;
    modeMontage: string;
    maxTournees: number;
    monteursParTournee: number;
  };
  allocation?: {
    nbChauffeursUtilises?: number;
    nbChefsUtilises?: number;
    nbMonteursUtilises?: number;
    nbCamionsUtilises?: number;
    repartition?: string;
  };
  estimation: {
    velosLivresEstime: number;
    dureeJourneeEstime: number;
    scoreVelosParHeure: number;
    scoreVelosParPersonne?: number;
  };
};
type StrategieResult = {
  ok: boolean;
  error?: string;
  plans?: GeminiPlan[];
  recommandation?: string;
  alertes?: string[];
  model?: string;
};

function StrategieGeminiModal({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<StrategieResult | null>(null);
  const [dureeJourneeMin, setDureeJourneeMin] = useState(510);
  const [monteursParTournee, setMonteursParTournee] = useState(2);
  // Yoann 2026-05-03 : "Adopter ce plan" — ouvre PlanifierJourneeModal préfix
  const [adoptedPlan, setAdoptedPlan] = useState<GeminiPlan | null>(null);
  const [adoptedEntrepot, setAdoptedEntrepot] = useState<{ id: string; nom: string; stockCartons: number; stockVelosMontes: number } | null>(null);

  const adoptPlan = async (p: GeminiPlan) => {
    if (!p.params.entrepotId) {
      alert("Plan sans entrepôt — impossible d adopter");
      return;
    }
    try {
      const { collection, getDocs } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      const snap = await getDocs(collection(db, "entrepots"));
      const found = snap.docs.find((d) => d.id === p.params.entrepotId);
      if (!found) {
        alert(`Entrepôt ${p.params.entrepotId} introuvable`);
        return;
      }
      const d = found.data() as { nom?: string; stockCartons?: number; stockVelosMontes?: number };
      setAdoptedEntrepot({
        id: found.id,
        nom: String(d.nom || p.params.entrepotNom),
        stockCartons: Number(d.stockCartons || 0),
        stockVelosMontes: Number(d.stockVelosMontes || 0),
      });
      setAdoptedPlan(p);
    } catch (e) {
      alert("Erreur : " + (e instanceof Error ? e.message : String(e)));
    }
  };
  // Yoann 2026-05-02 : ressources réelles auto-chargées (équipe + flotte)
  // avec possibilité de override pour les absences du jour.
  const [nbChauffeurs, setNbChauffeurs] = useState<number>(0);
  const [nbChefs, setNbChefs] = useState<number>(0);
  const [nbMonteurs, setNbMonteurs] = useState<number>(0);
  const [nbCamions, setNbCamions] = useState<number>(0);
  const [autoLoaded, setAutoLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { collection, getDocs } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      let chauf = 0;
      let chefs = 0;
      let mont = 0;
      try {
        const eqSnap = await getDocs(collection(db, "equipe"));
        for (const d of eqSnap.docs) {
          const o = d.data() as { role?: string; actif?: boolean; aussiMonteur?: boolean };
          if (o.actif === false) continue;
          if (o.role === "chauffeur") chauf++;
          if (o.role === "chef") {
            chefs++;
            if (o.aussiMonteur) mont++;
          }
          if (o.role === "monteur") mont++;
        }
      } catch {}
      let cam = 0;
      try {
        const flSnap = await getDocs(collection(db, "flotte"));
        for (const d of flSnap.docs) {
          const o = d.data() as { actif?: boolean };
          if (o.actif === false) continue;
          cam++;
        }
      } catch {}
      if (!alive) return;
      setNbChauffeurs(chauf);
      setNbChefs(chefs);
      setNbMonteurs(mont);
      setNbCamions(cam);
      setAutoLoaded(true);
    })();
    return () => { alive = false; };
  }, []);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = (await gasPost("strategieGemini", {
        dureeJourneeMin,
        monteursParTournee,
        nbChauffeurs,
        nbChefs,
        nbMonteurs,
        nbCamions,
      })) as StrategieResult;
      setResult(r);
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const formatMin = (m: number) => `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, "0")}`;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[2000] p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-3xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-3">
          <div>
            <h2 className="text-lg font-semibold">🧠 Stratégie Gemini · 3 plans alternatifs</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              L IA logisticien analyse stocks + clients restants + capacités, propose 3 stratégies avec tradeoffs.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>

        {/* Ressources réelles du jour (Yoann 2026-05-02) — auto-chargées
            depuis Firestore equipe + flotte, ajustables pour les absences. */}
        <div className="bg-indigo-50 border border-indigo-200 rounded p-3 mb-3">
          <div className="text-xs font-semibold text-indigo-900 mb-2">
            👥 Ressources du jour {autoLoaded && <span className="text-[10px] font-normal text-indigo-600">(auto-chargées · ajustables si absences)</span>}
          </div>
          <div className="grid grid-cols-4 gap-2">
            <div>
              <label className="text-[10px] text-gray-600 block">🚐 Chauffeurs</label>
              <input
                type="number"
                value={nbChauffeurs}
                onChange={(e) => setNbChauffeurs(Number(e.target.value))}
                min={0}
                max={20}
                className="w-full px-2 py-1.5 border rounded text-sm bg-white text-center font-bold"
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-600 block">👷 Chefs</label>
              <input
                type="number"
                value={nbChefs}
                onChange={(e) => setNbChefs(Number(e.target.value))}
                min={0}
                max={20}
                className="w-full px-2 py-1.5 border rounded text-sm bg-white text-center font-bold"
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-600 block">🔧 Monteurs</label>
              <input
                type="number"
                value={nbMonteurs}
                onChange={(e) => setNbMonteurs(Number(e.target.value))}
                min={0}
                max={50}
                className="w-full px-2 py-1.5 border rounded text-sm bg-white text-center font-bold"
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-600 block">🚛 Camions</label>
              <input
                type="number"
                value={nbCamions}
                onChange={(e) => setNbCamions(Number(e.target.value))}
                min={0}
                max={20}
                className="w-full px-2 py-1.5 border rounded text-sm bg-white text-center font-bold"
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-3 bg-purple-50 border border-purple-200 rounded p-3">
          <div>
            <label className="text-xs text-gray-600">Journée chauffeur (min)</label>
            <input
              type="number"
              value={dureeJourneeMin}
              onChange={(e) => setDureeJourneeMin(Number(e.target.value))}
              min={120}
              max={720}
              step={30}
              className="w-full px-2 py-1.5 border rounded text-sm bg-white"
            />
            <div className="text-[10px] text-gray-500 mt-0.5">{formatMin(dureeJourneeMin)}</div>
          </div>
          <div>
            <label className="text-xs text-gray-600">Monteurs / tournée (préférence)</label>
            <input
              type="number"
              value={monteursParTournee}
              onChange={(e) => setMonteursParTournee(Number(e.target.value))}
              min={1}
              max={10}
              className="w-full px-2 py-1.5 border rounded text-sm bg-white"
            />
            <div className="text-[10px] text-gray-500 mt-0.5">
              {nbChauffeurs > 0 && nbMonteurs > 0 && `${nbChauffeurs} chauffeurs × ${monteursParTournee} = ${nbChauffeurs * monteursParTournee} monteurs requis (dispo : ${nbMonteurs})`}
            </div>
          </div>
        </div>

        <button
          onClick={run}
          disabled={busy}
          className="w-full px-3 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 text-white rounded-lg hover:opacity-90 disabled:opacity-50 font-semibold"
        >
          {busy ? "🧠 Gemini réfléchit..." : "🧠 Demander 3 stratégies à Gemini"}
        </button>

        {result && (
          <div className="mt-4">
            {result.error && (
              <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-800">
                ❌ {result.error}
              </div>
            )}
            {result.recommandation && (
              <div className="bg-amber-50 border border-amber-300 rounded p-3 mb-3">
                <div className="text-sm font-bold text-amber-900 mb-1">💡 Recommandation</div>
                <div className="text-xs text-amber-900">{result.recommandation}</div>
              </div>
            )}
            {result.alertes && result.alertes.length > 0 && (
              <div className="bg-rose-50 border border-rose-300 rounded p-3 mb-3">
                <div className="text-sm font-bold text-rose-900 mb-1">⚠️ Alertes</div>
                <ul className="text-xs text-rose-900 space-y-0.5">
                  {result.alertes.map((a, i) => <li key={i}>• {a}</li>)}
                </ul>
              </div>
            )}
            {result.plans && result.plans.length > 0 && (
              <div className="space-y-3">
                {result.plans.map((p, i) => (
                  <div key={i} className="border-2 border-purple-300 rounded-lg overflow-hidden">
                    <div className="bg-gradient-to-r from-purple-100 to-indigo-100 border-b border-purple-300 px-3 py-2">
                      <div className="text-sm font-bold text-purple-900">
                        Plan {String.fromCharCode(65 + i)} — {p.titre}
                      </div>
                      <div className="text-xs text-purple-700 mt-0.5 italic">{p.strategie}</div>
                    </div>
                    <div className="p-3 space-y-2">
                      <p className="text-xs text-gray-700 leading-relaxed">{p.narratif}</p>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                        <div className="bg-gray-50 border rounded p-1.5">
                          <div className="text-gray-500 uppercase text-[9px]">Entrepôt</div>
                          <div className="font-semibold truncate">{p.params.entrepotNom}</div>
                        </div>
                        <div className="bg-gray-50 border rounded p-1.5">
                          <div className="text-gray-500 uppercase text-[9px]">Camion</div>
                          <div className="font-semibold">{p.params.modeCamion} · {p.params.modeMontage}</div>
                        </div>
                        <div className="bg-emerald-50 border border-emerald-200 rounded p-1.5">
                          <div className="text-emerald-600 uppercase text-[9px]">Vélos estim.</div>
                          <div className="font-bold text-emerald-900">{p.estimation?.velosLivresEstime}v</div>
                        </div>
                        <div className="bg-blue-50 border border-blue-200 rounded p-1.5">
                          <div className="text-blue-600 uppercase text-[9px]">Durée estim.</div>
                          <div className="font-bold text-blue-900">{formatMin(p.estimation?.dureeJourneeEstime || 0)}</div>
                        </div>
                      </div>
                      {/* Allocation ressources (Yoann 2026-05-02) */}
                      {p.allocation && (
                        <div className="bg-indigo-50 border border-indigo-200 rounded p-2 text-[11px]">
                          <div className="font-semibold text-indigo-900 mb-1 text-[10px] uppercase">👥 Allocation ressources</div>
                          <div className="flex flex-wrap gap-2 mb-1">
                            {p.allocation.nbChauffeursUtilises != null && <span>🚐 <strong>{p.allocation.nbChauffeursUtilises}</strong> chauffeur{p.allocation.nbChauffeursUtilises > 1 ? "s" : ""}</span>}
                            {p.allocation.nbChefsUtilises != null && <span>👷 <strong>{p.allocation.nbChefsUtilises}</strong> chef{p.allocation.nbChefsUtilises > 1 ? "s" : ""}</span>}
                            {p.allocation.nbMonteursUtilises != null && <span>🔧 <strong>{p.allocation.nbMonteursUtilises}</strong> monteur{p.allocation.nbMonteursUtilises > 1 ? "s" : ""}</span>}
                            {p.allocation.nbCamionsUtilises != null && <span>🚛 <strong>{p.allocation.nbCamionsUtilises}</strong> camion{p.allocation.nbCamionsUtilises > 1 ? "s" : ""}</span>}
                          </div>
                          {p.allocation.repartition && (
                            <div className="text-indigo-800 italic leading-snug">{p.allocation.repartition}</div>
                          )}
                        </div>
                      )}
                      <div className="text-[10px] text-gray-500 italic pt-1 border-t flex flex-wrap gap-3 items-center justify-between">
                        <div className="flex flex-wrap gap-3">
                          <span>🤖 {p.params.maxTournees} tournée{p.params.maxTournees > 1 ? "s" : ""}</span>
                          <span>⚡ {p.estimation?.scoreVelosParHeure} v/h chauffeur</span>
                          {p.estimation?.scoreVelosParPersonne != null && <span>👤 {p.estimation.scoreVelosParPersonne} v/personne</span>}
                        </div>
                        <button
                          onClick={() => adoptPlan(p)}
                          className="px-2 py-1 text-[10px] bg-emerald-600 text-white rounded hover:bg-emerald-700 font-semibold not-italic"
                          title="Ouvre le planificateur journée pré-rempli avec les paramètres de ce plan"
                        >
                          ✓ Adopter ce plan
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {result.model && (
              <div className="mt-3 text-[10px] text-gray-400 italic text-center">
                Généré par {result.model}
              </div>
            )}
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <button onClick={onClose} className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50">Fermer</button>
        </div>
      </div>
      {adoptedPlan && adoptedEntrepot && (
        <PlanifierJourneeModal
          entrepotId={adoptedEntrepot.id}
          entrepotNom={adoptedEntrepot.nom}
          stockCartons={adoptedEntrepot.stockCartons}
          stockVelosMontes={adoptedEntrepot.stockVelosMontes}
          initialParams={{
            mode: adoptedPlan.params.modeCamion as "gros" | "moyen" | "petit" | "camionnette",
            modeMontage: (["client", "atelier", "client_redistribue"].includes(adoptedPlan.params.modeMontage)
              ? adoptedPlan.params.modeMontage
              : "atelier") as "client" | "atelier" | "client_redistribue",
            maxTournees: adoptedPlan.params.maxTournees,
            monteursParTournee: adoptedPlan.params.monteursParTournee,
          }}
          onClose={() => {
            setAdoptedPlan(null);
            setAdoptedEntrepot(null);
            onClose(); // ferme aussi le modal Stratégie
          }}
        />
      )}
    </div>
  );
}

// SessionSurSitePanel — Yoann 2026-05-03
// Pour les entrepôts éphémères (Firat Food etc) : permet de planifier
// une session de montage+livraison sur site. Le client utilise SON camion
// pour distribuer ses propres magasins ; on envoie un chef + des monteurs
// sur place. Pas de tournée AXDIS, pas de notre flotte.
type SessionSurSite = {
  id: string;
  datePrevue: string;
  nbVelos: number;
  nbMonteurs: number;
  nbCartons: number;
  chefAffecteId: string;
  chefAffecteNom: string;
  camionClient: boolean;
  notes: string;
  statut: string;
};

function SessionSurSitePanel({
  entrepotId,
  entrepotNom,
  groupeClient,
  stockTotal,
}: {
  entrepotId: string;
  entrepotNom: string;
  groupeClient: string;
  stockTotal: number;
}) {
  const [sessions, setSessions] = useState<SessionSurSite[]>([]);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { collection, onSnapshot, query, where } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      const q = query(collection(db, "sessionsSurSite"), where("entrepotEphId", "==", entrepotId));
      const unsub = onSnapshot(q, (snap) => {
        if (!alive) return;
        const rows: SessionSurSite[] = [];
        for (const d of snap.docs) {
          const data = d.data() as Record<string, unknown>;
          rows.push({
            id: d.id,
            datePrevue: String(data.datePrevue || ""),
            nbVelos: Number(data.nbVelos) || 0,
            nbMonteurs: Number(data.nbMonteurs) || 0,
            nbCartons: Number(data.nbCartons) || 0,
            chefAffecteId: String(data.chefAffecteId || ""),
            chefAffecteNom: String(data.chefAffecteNom || ""),
            camionClient: data.camionClient !== false,
            notes: String(data.notes || ""),
            statut: String(data.statut || "planifiee"),
          });
        }
        rows.sort((a, b) => (a.datePrevue || "").localeCompare(b.datePrevue || ""));
        setSessions(rows);
      });
      return () => unsub();
    })();
    return () => {
      alive = false;
    };
  }, [entrepotId]);

  const sessionsActives = sessions.filter((s) => s.statut !== "annulee");

  return (
    <div className="mt-2 bg-purple-50 border border-purple-200 rounded p-2">
      <div className="text-[10px] text-purple-900 mb-1.5">
        🟣 Stock client géré par le groupe — pas dans nos tournées
      </div>
      {sessionsActives.length > 0 && (
        <div className="space-y-1 mb-1.5">
          {sessionsActives.map((s) => {
            const d = s.datePrevue ? new Date(s.datePrevue) : null;
            const dateStr = d
              ? d.toLocaleString("fr-FR", {
                  weekday: "short",
                  day: "2-digit",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "?";
            return (
              <div
                key={s.id}
                className="bg-white border border-purple-200 rounded p-1.5 text-[10px] text-purple-900"
              >
                <div className="flex items-center justify-between">
                  <div className="font-semibold">📅 {dateStr}</div>
                  <button
                    onClick={async () => {
                      if (!confirm("Annuler cette session ?")) return;
                      await gasPost("cancelSessionSurSite", { id: s.id });
                    }}
                    className="text-red-600 hover:underline text-[9px]"
                  >
                    Annuler
                  </button>
                </div>
                <div className="text-purple-800">
                  {s.nbVelos} vélos · {s.nbMonteurs} monteurs
                  {s.nbCartons > 0 ? ` · ${s.nbCartons} cartons` : ""}
                </div>
                {s.chefAffecteNom && (
                  <div className="text-purple-700">👷 Chef : {s.chefAffecteNom}</div>
                )}
                {s.camionClient && <div className="text-purple-700">🚚 Camion client</div>}
                {s.notes && <div className="text-purple-600 italic">{s.notes}</div>}
              </div>
            );
          })}
        </div>
      )}
      <button
        onClick={() => setShowModal(true)}
        className="w-full bg-purple-600 hover:bg-purple-700 text-white text-[11px] font-medium rounded px-2 py-1.5"
      >
        📅 Planifier session sur site
      </button>
      {showModal && (
        <SessionSurSiteModal
          entrepotId={entrepotId}
          entrepotNom={entrepotNom}
          groupeClient={groupeClient}
          stockTotal={stockTotal}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
}

type EquipeChef = { id: string; nom: string };

function SessionSurSiteModal({
  entrepotId,
  entrepotNom,
  groupeClient,
  stockTotal,
  onClose,
}: {
  entrepotId: string;
  entrepotNom: string;
  groupeClient: string;
  stockTotal: number;
  onClose: () => void;
}) {
  const [date, setDate] = useState("");
  const [heure, setHeure] = useState("09:00");
  const [nbVelos, setNbVelos] = useState(stockTotal || 0);
  const [nbMonteurs, setNbMonteurs] = useState(2);
  const [nbCartons, setNbCartons] = useState(0);
  const [chefId, setChefId] = useState("");
  const [camionClient, setCamionClient] = useState(true);
  const [notes, setNotes] = useState("");
  const [chefs, setChefs] = useState<EquipeChef[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { collection, onSnapshot } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      const unsub = onSnapshot(collection(db, "equipe"), (snap) => {
        if (!alive) return;
        const rows: EquipeChef[] = [];
        for (const d of snap.docs) {
          const data = d.data() as { role?: string; actif?: boolean; nom?: string };
          if (data.role !== "chef") continue;
          if (data.actif === false) continue;
          rows.push({ id: d.id, nom: String(data.nom || "") });
        }
        rows.sort((a, b) => a.nom.localeCompare(b.nom));
        setChefs(rows);
      });
      return () => unsub();
    })();
    return () => {
      alive = false;
    };
  }, []);

  const submit = async () => {
    if (!date) {
      alert("Date obligatoire");
      return;
    }
    if (nbVelos <= 0) {
      alert("Nombre de vélos > 0");
      return;
    }
    setSubmitting(true);
    try {
      const datePrevue = `${date}T${heure}:00`;
      const chef = chefs.find((c) => c.id === chefId);
      const res = await gasPost("createSessionSurSite", {
        entrepotEphId: entrepotId,
        datePrevue,
        nbVelos,
        nbMonteurs,
        nbCartons,
        chefAffecteId: chefId,
        chefAffecteNom: chef ? chef.nom : "",
        camionClient,
        notes,
      });
      if (!res || res.ok === false) {
        alert("Erreur : " + (res?.error || "inconnue"));
        setSubmitting(false);
        return;
      }
      onClose();
    } catch (err) {
      alert("Erreur : " + (err instanceof Error ? err.message : String(err)));
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl max-w-md w-full p-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="text-base font-bold text-gray-900">
              📅 Planifier session sur site
            </h2>
            <div className="text-xs text-gray-500 mt-0.5">
              {entrepotNom}
              {groupeClient && groupeClient !== entrepotNom ? ` · ${groupeClient}` : ""}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">
            ×
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 mb-3">
          <div>
            <label className="text-[11px] uppercase text-gray-500 font-semibold">Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full mt-1 border rounded px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="text-[11px] uppercase text-gray-500 font-semibold">Heure</label>
            <input
              type="time"
              value={heure}
              onChange={(e) => setHeure(e.target.value)}
              className="w-full mt-1 border rounded px-2 py-1.5 text-sm"
            />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 mb-3">
          <div>
            <label className="text-[11px] uppercase text-gray-500 font-semibold">Vélos</label>
            <input
              type="number"
              min={1}
              value={nbVelos}
              onChange={(e) => setNbVelos(Number(e.target.value) || 0)}
              className="w-full mt-1 border rounded px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="text-[11px] uppercase text-gray-500 font-semibold">Monteurs</label>
            <input
              type="number"
              min={0}
              value={nbMonteurs}
              onChange={(e) => setNbMonteurs(Number(e.target.value) || 0)}
              className="w-full mt-1 border rounded px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="text-[11px] uppercase text-gray-500 font-semibold">Cartons</label>
            <input
              type="number"
              min={0}
              value={nbCartons}
              onChange={(e) => setNbCartons(Number(e.target.value) || 0)}
              className="w-full mt-1 border rounded px-2 py-1.5 text-sm"
            />
          </div>
        </div>

        <div className="mb-3">
          <label className="text-[11px] uppercase text-gray-500 font-semibold">
            Chef affecté
          </label>
          <select
            value={chefId}
            onChange={(e) => setChefId(e.target.value)}
            className="w-full mt-1 border rounded px-2 py-1.5 text-sm"
          >
            <option value="">— Choisir un chef —</option>
            {chefs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nom}
              </option>
            ))}
          </select>
        </div>

        <div className="mb-3">
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={camionClient}
              onChange={(e) => setCamionClient(e.target.checked)}
            />
            🚚 Camion fourni par le client
          </label>
        </div>

        <div className="mb-4">
          <label className="text-[11px] uppercase text-gray-500 font-semibold">
            Notes (optionnel)
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Adresse précise, contact, etc."
            className="w-full mt-1 border rounded px-2 py-1.5 text-sm"
          />
        </div>

        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50"
          >
            Annuler
          </button>
          <button
            onClick={submit}
            disabled={submitting}
            className="px-3 py-1.5 text-sm bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50"
          >
            {submitting ? "..." : "Planifier"}
          </button>
        </div>
      </div>
    </div>
  );
}
