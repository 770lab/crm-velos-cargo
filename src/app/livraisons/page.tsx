"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { gasGet, gasPost } from "@/lib/gas";
import { useData, type LivraisonRow, type EquipeMember, type ClientPoint, type EquipeRole } from "@/lib/data-context";
import { useCurrentUser } from "@/lib/current-user";
import DateLoadPicker, { type DayLoad } from "@/components/date-load-picker";
import AddClientModal from "@/components/add-client-modal";
import DayPlannerModal from "@/components/day-planner-modal";

// Étapes accessibles par rôle.
//   - Préparateur (ex: AXDIS) : prépare au dépôt + aide au chargement du camion.
//   - Chauffeur (ex: Armel)   : charge le camion, livre, et peut donner un coup
//                                de main au montage pour arrondir son salaire.
//   - Chef d'équipe           : encadre charge/livre/montage côté terrain.
//   - Monteur                 : monte chez le client.
//   - Apporteur               : commercial, ne touche pas au flux logistique.
//   - Admin                   : accès total (Yoann notamment).
// Les boutons d'étape interdits restent visibles mais non cliquables (grisés).
type StageKey = "prepare" | "charge" | "livre" | "monte";
const STAGE_ACCESS: Record<EquipeRole, ReadonlySet<StageKey>> = {
  superadmin: new Set<StageKey>(["prepare", "charge", "livre", "monte"]),
  admin: new Set<StageKey>(["prepare", "charge", "livre", "monte"]),
  preparateur: new Set<StageKey>(["prepare", "charge"]),
  chef: new Set<StageKey>(["charge", "livre", "monte"]),
  chauffeur: new Set<StageKey>(["charge", "livre", "monte"]),
  monteur: new Set<StageKey>(["monte"]),
  apporteur: new Set<StageKey>([]),
};

type View = "jour" | "3jours" | "semaine" | "mois" | "liste";

// Labels courts pour le sélecteur de vue (limité par la largeur sur mobile :
// 5 modes au lieu de 3). Le label affiché reste compact, l'état est verbeux.
const VIEW_LABELS: Record<View, string> = {
  jour: "Jour",
  "3jours": "3 j",
  semaine: "Sem.",
  mois: "Mois",
  liste: "Liste",
};

interface Tournee {
  tourneeId: string | null;
  datePrevue: string | null;
  mode: string | null;
  livraisons: LivraisonRow[];
  totalVelos: number;
  nbMonteurs: number;
  statutGlobal: "planifiee" | "en_cours" | "livree" | "annulee" | "mixte";
  numero?: number;
}

// Une livraison appartient au user si celui-ci y est affecté selon son rôle.
// Admin voit tout, apporteur ne voit aucune livraison (commercial pur).
function livraisonMatchesUser(l: LivraisonRow, userId: string, role: EquipeRole): boolean {
  if (role === "admin" || role === "superadmin") return true;
  if (role === "apporteur") return false;
  switch (role) {
    case "chauffeur":
      return l.chauffeurId === userId;
    case "preparateur":
      return (l.preparateurIds || []).includes(userId);
    case "monteur":
      return (l.monteurIds || []).includes(userId);
    case "chef":
      if (l.chefEquipeId === userId) return true;
      return (l.chefEquipeIds || []).includes(userId);
    default:
      return false;
  }
}

export default function LivraisonsPage() {
  const { livraisons, carte, refresh } = useData();
  const currentUser = useCurrentUser();
  // Vue initiale :
  //  - localStorage gagne toujours (le user a explicitement choisi)
  //  - sinon "jour" pour les roles terrain (chauffeur / monteur / preparateur /
  //    chef) car ils ouvrent leur app pour bosser sur la journee, pas pour
  //    contempler 7 jours dont 6 ne les concernent pas
  //  - sinon "jour" sur mobile (< 768px, la grille 7 colonnes est illisible)
  //  - sinon "semaine" sur desktop admin
  // SSR-safe : on commence par "semaine" et on ajuste au mount via useEffect.
  const [view, setView] = useState<View>("semaine");
  const [viewInited, setViewInited] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (viewInited) return;
    const saved = window.localStorage.getItem("livraisons.view") as View | null;
    if (saved && ["jour", "3jours", "semaine", "mois", "liste"].includes(saved)) {
      setView(saved);
      setViewInited(true);
      return;
    }
    // Attend currentUser pour decider en fonction du role.
    if (!currentUser) return;
    const isAdminLike = currentUser.role === "admin" || currentUser.role === "superadmin";
    const isTerrain = !isAdminLike && currentUser.role !== "apporteur";
    if (isTerrain || window.innerWidth < 768) setView("jour");
    setViewInited(true);
  }, [currentUser, viewInited]);
  const setViewPersist = (v: View) => {
    setView(v);
    if (typeof window !== "undefined") window.localStorage.setItem("livraisons.view", v);
  };
  const [refDate, setRefDate] = useState<Date>(() => new Date());
  const [openTournee, setOpenTournee] = useState<Tournee | null>(null);
  const [search, setSearch] = useState("");
  const [showAddClient, setShowAddClient] = useState(false);
  const [showPlanner, setShowPlanner] = useState(false);

  useEffect(() => {
    refresh("livraisons");
    refresh("carte");
  }, [refresh]);

  // Filtrage des livraisons par utilisateur : chacun ne voit que ses dossiers.
  // Pendant l'hydratation (currentUser undefined), on n'affiche rien pour éviter
  // un flash où d'autres dossiers seraient brièvement visibles.
  const userLivraisons = useMemo(() => {
    if (!currentUser) return [] as LivraisonRow[];
    return livraisons.filter((l) => livraisonMatchesUser(l, currentUser.id, currentUser.role));
  }, [livraisons, currentUser]);

  const tournees = useMemo(() => {
    const list = groupByTournee(userLivraisons);
    // Numérotation séquentielle par jour : Tournée 1, 2, 3...
    const byDay = new Map<string, Tournee[]>();
    for (const t of list) {
      const dateKey = t.datePrevue ? isoDate(t.datePrevue) : "no-date";
      if (!byDay.has(dateKey)) byDay.set(dateKey, []);
      byDay.get(dateKey)!.push(t);
    }
    for (const sameDay of byDay.values()) {
      sameDay.sort((a, b) => String(a.tourneeId || "").localeCompare(String(b.tourneeId || "")));
      sameDay.forEach((t, i) => { t.numero = i + 1; });
    }
    return list;
  }, [userLivraisons]);

  const loadByDate = useMemo(() => {
    const map = new Map<string, { velos: number; tournees: Set<string>; modes: Set<string> }>();
    // On boucle sur userLivraisons (pas livraisons) pour que la charge affichée
    // au calendrier reflète uniquement les jours où le user a réellement des
    // dossiers — un préparateur ne doit pas voir une grosse pastille jaune sur
    // un jour où il n'a rien à préparer.
    for (const l of userLivraisons) {
      if (l.statut === "annulee" || !l.datePrevue) continue;
      const iso = isoDate(l.datePrevue);
      if (!map.has(iso)) map.set(iso, { velos: 0, tournees: new Set(), modes: new Set() });
      const e = map.get(iso)!;
      e.velos += l._count?.velos ?? l.nbVelos ?? 0;
      if (l.tourneeId) e.tournees.add(l.tourneeId);
      if (l.mode) e.modes.add(l.mode);
    }
    return new Map<string, DayLoad>(
      Array.from(map.entries()).map(([k, v]) => [k, { velos: v.velos, tournees: v.tournees.size, modes: Array.from(v.modes) }])
    );
  }, [userLivraisons]);

  const clientById = useMemo(() => {
    const map = new Map<string, typeof carte[number]>();
    for (const c of carte) map.set(c.id, c);
    return map;
  }, [carte]);

  const searchQuery = search.trim().toLowerCase();
  const filteredTournees = useMemo(() => {
    if (!searchQuery) return tournees;
    return tournees.filter((t) => {
      const hay = t.livraisons
        .map((l) => {
          const full = l.clientId ? clientById.get(l.clientId) : undefined;
          return [
            l.client.entreprise,
            l.client.ville ?? "",
            l.client.telephone ?? "",
            l.client.adresse ?? "",
            l.client.codePostal ?? "",
            full?.contact ?? "",
            full?.email ?? "",
            full?.apporteur ?? "",
            t.tourneeId ?? "",
          ].join(" ");
        })
        .join(" ")
        .toLowerCase();
      return hay.includes(searchQuery);
    });
  }, [tournees, searchQuery, clientById]);

  // Auto-navigation : quand une recherche filtre, naviguer à la date de la première tournée trouvée
  useEffect(() => {
    if (!searchQuery || filteredTournees.length === 0) return;
    const first = filteredTournees.find((t) => t.datePrevue);
    if (first?.datePrevue) {
      setRefDate(new Date(first.datePrevue));
    }
  }, [searchQuery, filteredTournees]);

  useEffect(() => {
    if (!openTournee) return;
    const key = (t: Tournee) => (t.tourneeId || "") + "|" + (t.datePrevue ? isoDate(t.datePrevue) : "no-date");
    const target = key(openTournee);
    setOpenTournee(filteredTournees.find((t) => key(t) === target) || tournees.find((t) => key(t) === target) || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tournees]);
  const tourneesByDate = useMemo(() => {
    const map = new Map<string, Tournee[]>();
    for (const t of filteredTournees) {
      if (!t.datePrevue) continue;
      const key = isoDate(t.datePrevue);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    }
    return map;
  }, [filteredTournees]);

  const livraisonsSansDate = userLivraisons.filter((l) => !l.datePrevue);

  // Tournees dans la fenetre de la vue active. Sert au compteur d'objectifs :
  // un monteur en vue Jour veut savoir combien de velos il a a monter aujourd'hui,
  // pas sur tout le mois.
  const windowedTournees = useMemo(() => {
    if (view === "liste") return filteredTournees;
    const start = new Date(refDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    if (view === "jour") {
      end.setDate(end.getDate() + 1);
    } else if (view === "3jours") {
      end.setDate(end.getDate() + 3);
    } else if (view === "semaine") {
      const sw = startOfWeek(refDate);
      sw.setHours(0, 0, 0, 0);
      start.setTime(sw.getTime());
      end.setTime(sw.getTime());
      end.setDate(end.getDate() + 7);
    } else {
      // mois
      start.setDate(1);
      end.setTime(start.getTime());
      end.setMonth(end.getMonth() + 1);
    }
    return filteredTournees.filter((t) => {
      if (!t.datePrevue) return false;
      const d = new Date(t.datePrevue);
      return d >= start && d < end;
    });
  }, [filteredTournees, view, refDate]);

  // Nb de velos a monter / livrer dans la fenetre, pour le compteur d'objectifs.
  const windowedVelos = useMemo(
    () => windowedTournees.reduce((sum, t) => sum + t.totalVelos, 0),
    [windowedTournees],
  );
  const windowedLivraisons = useMemo(
    () => windowedTournees.reduce((sum, t) => sum + t.livraisons.length, 0),
    [windowedTournees],
  );

  // Titre + sous-titre adaptes au role.
  // - monteur  : "Montage" + "X velos a monter"
  // - chauffeur: "Livraisons" + "Y livraisons a faire"
  // - autres   : "Livraisons" + "X tournees · Y livraisons" (vue admin)
  const role = currentUser?.role;
  const isMonteur = role === "monteur";
  const isChauffeur = role === "chauffeur";
  const pageTitle = isMonteur ? "Montage" : "Livraisons";
  // Suffixe de fenetre lisible ("aujourd'hui", "cette semaine", etc.) — vide en
  // mode liste car la liste affiche tout.
  const windowSuffix =
    view === "jour" ? "aujourd'hui"
      : view === "3jours" ? "sur 3 jours"
      : view === "semaine" ? "cette semaine"
      : view === "mois" ? "ce mois"
      : "";
  let pageSubtitle: string;
  if (isMonteur) {
    pageSubtitle = `${windowedVelos} vélo${windowedVelos > 1 ? "s" : ""} à monter${windowSuffix ? " " + windowSuffix : ""}`;
  } else if (isChauffeur) {
    pageSubtitle = `${windowedLivraisons} livraison${windowedLivraisons > 1 ? "s" : ""} · ${windowedTournees.length} tournée${windowedTournees.length > 1 ? "s" : ""}${windowSuffix ? " " + windowSuffix : ""}`;
  } else {
    pageSubtitle = view === "liste"
      ? `${filteredTournees.length} tournée${filteredTournees.length > 1 ? "s" : ""} · ${userLivraisons.length} livraison${userLivraisons.length > 1 ? "s" : ""}`
      : `${windowedTournees.length} tournée${windowedTournees.length > 1 ? "s" : ""} · ${windowedLivraisons} livraison${windowedLivraisons > 1 ? "s" : ""}${windowSuffix ? " " + windowSuffix : ""}`;
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900">{pageTitle}</h1>
          <p className="text-gray-500 mt-1 text-sm">{pageSubtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Boutons admin uniquement : ni un préparateur, ni un chauffeur,
              ni un monteur n'ont à planifier la journée ou créer un client. */}
          {(currentUser?.role === "admin" || currentUser?.role === "superadmin") && (
            <>
              <button
                onClick={() => setShowPlanner(true)}
                className="px-3 py-1.5 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm font-medium whitespace-nowrap"
                title="Annonce les ressources du jour et laisse Gemini proposer la ventilation optimale"
              >
                🪄 Planifier le jour
              </button>
              <button
                onClick={() => setShowAddClient(true)}
                className="px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-medium whitespace-nowrap"
              >
                + Nouveau client
              </button>
            </>
          )}
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher client, ville, tél..."
            className="px-3 py-1.5 border-2 border-green-300 rounded-lg text-sm w-56 focus:border-green-500 focus:outline-none"
          />
          <div className="inline-flex rounded-lg border bg-white overflow-hidden">
            {(["jour", "3jours", "semaine", "mois", "liste"] as View[]).map((v) => (
              <button
                key={v}
                onClick={() => setViewPersist(v)}
                className={`px-2 sm:px-3 py-1.5 text-xs sm:text-sm whitespace-nowrap ${
                  view === v ? "bg-green-600 text-white" : "text-gray-600 hover:bg-gray-50"
                }`}
              >
                {VIEW_LABELS[v]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {view !== "liste" && (
        <NavBar refDate={refDate} setRefDate={setRefDate} view={view} />
      )}

      {view === "jour" && (
        <DayView refDate={refDate} tourneesByDate={tourneesByDate} onOpen={setOpenTournee} />
      )}
      {view === "3jours" && (
        <MultiDayView refDate={refDate} tourneesByDate={tourneesByDate} onOpen={setOpenTournee} nbDays={3} />
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
          tourneeNumber={openTournee.numero ?? null}
          loadByDate={loadByDate}
          onClose={() => setOpenTournee(null)}
          onChanged={() => { refresh("livraisons"); refresh("carte"); }}
        />
      )}
      {showAddClient && (
        <AddClientModal
          onClose={() => {
            setShowAddClient(false);
            refresh("clients");
            refresh("carte");
          }}
        />
      )}
      {showPlanner && (
        <DayPlannerModal
          initialDate={refDate.toISOString().slice(0, 10)}
          onClose={() => setShowPlanner(false)}
          onApplied={() => {
            refresh("livraisons");
            refresh("carte");
          }}
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
    if (view === "jour") {
      return refDate.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    }
    if (view === "3jours") {
      const end = new Date(refDate);
      end.setDate(end.getDate() + 2);
      return `${refDate.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} — ${end.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" })}`;
    }
    if (view === "semaine") {
      const start = startOfWeek(refDate);
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      return `${start.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} — ${end.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" })}`;
    }
    return refDate.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  }, [refDate, view]);

  const moveBack = () => {
    const d = new Date(refDate);
    if (view === "jour") d.setDate(d.getDate() - 1);
    else if (view === "3jours") d.setDate(d.getDate() - 3);
    else if (view === "semaine") d.setDate(d.getDate() - 7);
    else d.setMonth(d.getMonth() - 1);
    setRefDate(d);
  };
  const moveFwd = () => {
    const d = new Date(refDate);
    if (view === "jour") d.setDate(d.getDate() + 1);
    else if (view === "3jours") d.setDate(d.getDate() + 3);
    else if (view === "semaine") d.setDate(d.getDate() + 7);
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

// Vue 1 jour : pleine largeur, idéale sur mobile. Affiche toutes les tournées
// du jour de refDate sans tronquer (contrairement à la WeekView où chaque
// colonne ne fait que 14% de la largeur écran).
function DayView({
  refDate,
  tourneesByDate,
  onOpen,
}: {
  refDate: Date;
  tourneesByDate: Map<string, Tournee[]>;
  onOpen: (t: Tournee) => void;
}) {
  const iso = isoDate(refDate);
  const list = tourneesByDate.get(iso) || [];
  const today = isoDate(new Date());
  const isToday = iso === today;

  return (
    <div className="bg-white rounded-xl border overflow-hidden">
      <div className={`px-4 py-3 border-b ${isToday ? "bg-blue-50 text-blue-800" : "bg-gray-50 text-gray-700"}`}>
        <div className="text-sm font-medium capitalize">
          {refDate.toLocaleDateString("fr-FR", { weekday: "long" })}
        </div>
        <div className="text-2xl font-bold">
          {refDate.getDate()}{" "}
          <span className="text-base font-normal text-gray-500 capitalize">
            {refDate.toLocaleDateString("fr-FR", { month: "long" })}
          </span>
        </div>
      </div>
      <div className="p-3 space-y-2 min-h-[40vh]">
        {list.length === 0 ? (
          <div className="text-sm text-gray-400 italic text-center py-8">Aucune tournée ce jour-là.</div>
        ) : (
          list.map((t) => (
            <TourneeCard key={t.tourneeId || t.livraisons[0].id} tournee={t} onClick={() => onOpen(t)} />
          ))
        )}
        <DayStaffingSummary tournees={list} />
      </div>
    </div>
  );
}

// Vue multi-jours (utilisée pour le mode "3 jours" — peut servir pour d'autres
// fenêtres si besoin). Plus lisible que la semaine sur mobile : 3 colonnes au
// lieu de 7, donc chaque colonne fait ~33% de la largeur.
function MultiDayView({
  refDate,
  tourneesByDate,
  onOpen,
  nbDays,
}: {
  refDate: Date;
  tourneesByDate: Map<string, Tournee[]>;
  onOpen: (t: Tournee) => void;
  nbDays: number;
}) {
  const days = Array.from({ length: nbDays }, (_, i) => {
    const d = new Date(refDate);
    d.setDate(d.getDate() + i);
    return d;
  });
  const today = isoDate(new Date());
  const colsClass = nbDays === 3 ? "grid-cols-3" : nbDays === 2 ? "grid-cols-2" : "grid-cols-1";

  return (
    <div className="bg-white rounded-xl border overflow-hidden">
      <div className={`grid ${colsClass} border-b bg-gray-50 text-xs text-gray-600`}>
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
      <div className={`grid ${colsClass} min-h-[60vh]`}>
        {days.map((d) => {
          const iso = isoDate(d);
          const list = tourneesByDate.get(iso) || [];
          return (
            <div key={iso} className="border-r last:border-r-0 p-2 space-y-1.5">
              {list.length === 0 && <div className="text-[11px] text-gray-300">—</div>}
              {list.map((t) => (
                <TourneeCard key={t.tourneeId || t.livraisons[0].id} tournee={t} onClick={() => onOpen(t)} compact />
              ))}
              <DayStaffingSummary tournees={list} />
            </div>
          );
        })}
      </div>
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
              <DayStaffingSummary tournees={list} />
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
              <td className="px-4 py-2">{t.mode ? (MODE_LABELS[t.mode] || t.mode) : "—"}</td>
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

function DayStaffingSummary({ tournees }: { tournees: Tournee[] }) {
  const active = tournees.filter((t) => t.statutGlobal !== "annulee" && t.statutGlobal !== "livree");
  if (active.length === 0) return null;

  type Groupe = { mode: string; tournees: Tournee[]; totalMin: number; totalVelos: number; capacite: number };
  const byMode = new Map<string, Groupe>();
  for (const t of active) {
    const key = t.mode || "autre";
    if (!byMode.has(key)) {
      byMode.set(key, {
        mode: key,
        tournees: [],
        totalMin: 0,
        totalVelos: 0,
        capacite: CAPACITES[key] ?? 0,
      });
    }
    const g = byMode.get(key)!;
    g.tournees.push(t);
    const tMonteurs = t.nbMonteurs > 0 ? t.nbMonteurs : MONTEURS_PAR_EQUIPE;
    g.totalMin += estimateTourneeMinutes(t, tMonteurs);
    g.totalVelos += t.totalVelos;
  }

  const ORDER: Record<string, number> = { gros: 0, moyen: 1, camionnette: 2, retrait: 3, autre: 4 };
  const groupes = Array.from(byMode.values()).sort((a, b) => (ORDER[a.mode] ?? 99) - (ORDER[b.mode] ?? 99));
  const nbEquipes = groupes.length;
  const nbMonteurs = active.reduce((sum, t) => sum + (t.nbMonteurs > 0 ? t.nbMonteurs : MONTEURS_PAR_EQUIPE), 0);
  const hasRetrait = groupes.some((g) => g.mode === "retrait");
  const plafond = nbEquipes > 2;

  return (
    <div className="mt-2 pt-2 border-t border-gray-200 space-y-1.5 text-[10px] leading-tight">
      <div className="font-semibold text-gray-700">
        {nbEquipes} équipe{nbEquipes > 1 ? "s" : ""} · {nbMonteurs} monteurs{hasRetrait ? " + 1 chef admin" : ""}
        {plafond && <span className="ml-1 text-red-700">⚠ dépasse 2 équipes</span>}
      </div>
      {groupes.map((g, idx) => {
        const isRetrait = g.mode === "retrait";
        const label = MODE_SHORT_LABELS[g.mode] || g.mode;
        const reste8h = JOURNEE_MIN - g.totalMin;
        const depasse10h = g.totalMin > JOURNEE_MAX;
        const capaLibre = g.capacite > 0 ? g.capacite - g.totalVelos : 0;
        const peutAjouter = !isRetrait && reste8h >= 120 && (g.capacite === 0 || capaLibre >= SEUIL_2EME_TOURNEE);
        const tightPalette = depasse10h
          ? "text-red-700"
          : reste8h < 60
          ? "text-amber-700"
          : isRetrait
          ? "text-purple-700"
          : "text-gray-700";
        return (
          <div key={g.mode + idx} className="space-y-0.5">
            <div className={tightPalette}>
              <span className="font-semibold">É{idx + 1} · {label}</span>
              <span className="opacity-75"> · {g.totalVelos}v · ~{formatDureeShort(g.totalMin)}</span>
            </div>
            <ul className="pl-2 space-y-0.5 text-gray-600">
              {g.tournees.map((t) => (
                <li key={t.tourneeId || t.livraisons[0].id} className="truncate">
                  · {t.livraisons[0]?.client.entreprise}
                  {t.livraisons.length > 1 ? ` +${t.livraisons.length - 1}` : ""}
                  <span className="opacity-60"> ({t.totalVelos}v)</span>
                </li>
              ))}
            </ul>
            {peutAjouter && (
              <div className="text-green-700 font-medium">
                + ~{formatDureeShort(reste8h)} libre → 2e tournée possible
              </div>
            )}
            {!peutAjouter && !depasse10h && !isRetrait && reste8h < 60 && reste8h >= 0 && (
              <div className="text-amber-700">journée pleine (~8h)</div>
            )}
            {depasse10h && (
              <div className="text-red-700 font-medium">
                ⚠ dépasse 10h{isRetrait ? " — ajouter 1 monteur" : " — à split"}
              </div>
            )}
          </div>
        );
      })}
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
  const libre = capaciteRestante(tournee.mode, tournee.totalVelos);
  const peutAjouter = libre >= SEUIL_2EME_TOURNEE && tournee.statutGlobal !== "livree" && tournee.statutGlobal !== "annulee";
  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded ${palette.bg} ${palette.border} border ${palette.text} ${
        compact ? "px-1.5 py-1 text-[11px]" : "px-2 py-1.5 text-xs"
      } hover:opacity-90 transition-opacity`}
    >
      <div className="flex items-start justify-between gap-1">
        <div className="min-w-0 flex-1">
          {tournee.livraisons.map((l, i) => {
            const fullText = compact
              ? `${i + 1}. ${l.client.entreprise}`
              : `${i + 1}. ${l.client.entreprise} · ${l._count.velos}v`;
            const len = fullText.length;
            const sizeClass = len <= 14 ? "text-[11px]" : len <= 20 ? "text-[10px]" : len <= 28 ? "text-[9px]" : "text-[8px]";
            return (
              <div key={l.id} className={`font-medium leading-tight break-words ${sizeClass}`} title={l.client.entreprise}>
                {compact ? (
                  <>
                    <span className="opacity-60">{i + 1}.</span> {l.client.entreprise}
                  </>
                ) : (
                  <>
                    <span className="opacity-60">{i + 1}.</span> {l.client.entreprise}
                    <span className="opacity-60 font-mono"> · {l._count.velos}v</span>
                  </>
                )}
              </div>
            );
          })}
        </div>
        <span className="font-mono opacity-70 whitespace-nowrap">{tournee.totalVelos}v/{tournee.livraisons.length}A</span>
      </div>
      {peutAjouter && (
        <div className="mt-0.5 inline-flex items-center gap-1 px-1 rounded bg-green-100 text-green-800 text-[9px] font-semibold leading-tight">
          +{libre}v libre · 2e tournée possible
        </div>
      )}
      {!compact && (
        <div className="text-[10px] opacity-75 truncate">
          {tournee.numero ? `🚛 Tournée ${tournee.numero}` : tournee.tourneeId ? `🚛 ${tournee.tourneeId}` : ""}
          {tournee.mode ? ` · ${MODE_LABELS[tournee.mode] || tournee.mode}` : ""}
        </div>
      )}
    </button>
  );
}

function modePalette(mode: string | null) {
  if (mode === "gros") return { bg: "bg-sky-100", border: "border-sky-300", text: "text-sky-900" };
  if (mode === "moyen") return { bg: "bg-orange-100", border: "border-orange-300", text: "text-orange-900" };
  if (mode === "camionnette") return { bg: "bg-teal-100", border: "border-teal-300", text: "text-teal-900" };
  if (mode === "retrait") return { bg: "bg-purple-100", border: "border-purple-300", text: "text-purple-900" };
  return { bg: "bg-gray-100", border: "border-gray-300", text: "text-gray-800" };
}

const MODE_LABELS: Record<string, string> = {
  gros: "Gros camion (132)",
  moyen: "Moyen (54)",
  camionnette: "Camionnette (20)",
  retrait: "Retrait client",
};

const CAPACITES: Record<string, number> = { gros: 132, moyen: 54, camionnette: 20 };
const SEUIL_2EME_TOURNEE = 10;

const MODE_SHORT_LABELS: Record<string, string> = {
  gros: "Gros",
  moyen: "Moyen",
  camionnette: "Camion.",
  retrait: "Retrait",
};

const JOURNEE_MIN = 480; // 8h
const JOURNEE_MAX = 600; // 10h
const MONTEURS_PAR_EQUIPE = 2;

function capaciteRestante(mode: string | null, totalVelos: number): number {
  const cap = mode ? CAPACITES[mode] ?? 0 : 0;
  return cap > 0 ? Math.max(0, cap - totalVelos) : 0;
}

function estimateTourneeMinutes(tournee: Tournee, monteurs: number = MONTEURS_PAR_EQUIPE): number {
  const totalMontage = tournee.totalVelos * MINUTES_PAR_VELO;
  const eff = Math.max(1, monteurs);
  if (tournee.mode === "retrait") {
    return totalMontage / eff;
  }
  const segments: { trajetMin: number }[] = [];
  for (let i = 0; i < tournee.livraisons.length; i++) {
    const curr = tournee.livraisons[i].client;
    const prevLat = i === 0 ? ENTREPOT.lat : (tournee.livraisons[i - 1].client.lat ?? 0);
    const prevLng = i === 0 ? ENTREPOT.lng : (tournee.livraisons[i - 1].client.lng ?? 0);
    if (prevLat && prevLng && curr.lat && curr.lng) {
      const km = haversineKm(prevLat, prevLng, curr.lat, curr.lng) * 1.3;
      segments.push({ trajetMin: Math.round(km / 0.5) });
    } else {
      segments.push({ trajetMin: 0 });
    }
  }
  const totalTrajet = segments.reduce((s, seg) => s + seg.trajetMin, 0);
  const simple = totalMontage / eff + totalTrajet;
  const plan = computeDeployPlan(tournee.livraisons, segments, monteurs);
  const hasParallel = plan.steps.some((s) => !s.camionAttend);
  return hasParallel ? plan.totalElapsed : simple;
}

function formatDureeShort(min: number): string {
  if (min <= 0) return "0min";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h${m > 0 ? String(m).padStart(2, "0") : ""}` : `${m}min`;
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

const MINUTES_PAR_VELO = 12;
const HEURES_JOURNEE = 8;
const SEUIL_SPLIT_MIN = 90;
const MAX_TEMPS_SUR_PLACE_MIN = 120; // 2h max chez un client, au-delà alerte effectif d'urgence
const ENTREPOT = { lat: 48.9545398, lng: 2.4557494, label: "AXDIS PRO – 2 Rue des Frères Lumière, 93150 Le Blanc-Mesnil" };

interface DeployStep {
  stopIndex: number;
  monteursAffectes: number;
  montageTotal: number;
  tempsSurPlace: number;
  camionAttend: boolean;
  arrivee: number;
  depart: number;
}

function computeDeployPlan(
  livraisons: { _count: { velos: number } }[],
  segments: { trajetMin: number }[],
  monteurs: number
): { steps: DeployStep[]; totalElapsed: number } {
  const steps: DeployStep[] = [];
  let camionTime = 0;
  let monteursDisponibles = monteurs;
  const equipeEnCours: { finAt: number; monteurs: number }[] = [];

  for (let i = 0; i < livraisons.length; i++) {
    camionTime += segments[i].trajetMin;

    // Récupérer les équipes qui ont fini
    for (let e = equipeEnCours.length - 1; e >= 0; e--) {
      if (equipeEnCours[e].finAt <= camionTime) {
        monteursDisponibles += equipeEnCours[e].monteurs;
        equipeEnCours.splice(e, 1);
      }
    }

    const montageTotal = livraisons[i]._count.velos * MINUTES_PAR_VELO;
    const effectifIci = Math.max(1, monteursDisponibles);
    const tempsSurPlace = montageTotal / effectifIci;

    if (tempsSurPlace > SEUIL_SPLIT_MIN && monteursDisponibles > 1 && i < livraisons.length - 1) {
      // Arrêt long : déployer une équipe, camion avance
      const monteursDeployes = Math.ceil(effectifIci / 2);
      const tempsDeploye = montageTotal / monteursDeployes;
      steps.push({
        stopIndex: i,
        monteursAffectes: monteursDeployes,
        montageTotal,
        tempsSurPlace: tempsDeploye,
        camionAttend: false,
        arrivee: camionTime,
        depart: camionTime,
      });
      equipeEnCours.push({ finAt: camionTime + tempsDeploye, monteurs: monteursDeployes });
      monteursDisponibles -= monteursDeployes;
    } else {
      // Arrêt court ou dernier : camion attend
      steps.push({
        stopIndex: i,
        monteursAffectes: effectifIci,
        montageTotal,
        tempsSurPlace,
        camionAttend: true,
        arrivee: camionTime,
        depart: camionTime + tempsSurPlace,
      });
      camionTime += tempsSurPlace;
    }
  }

  // Attendre les équipes encore déployées
  let maxFinish = camionTime;
  for (const e of equipeEnCours) {
    if (e.finAt > maxFinish) maxFinish = e.finAt;
  }

  return { steps, totalElapsed: maxFinish };
}

function TourneeModal({
  tournee,
  tourneeNumber,
  loadByDate,
  onClose,
  onChanged,
}: {
  tournee: Tournee;
  tourneeNumber: number | null;
  loadByDate: Map<string, DayLoad>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { carte: allClients, equipe, bonsEnlevement } = useData();
  // Étapes autorisées pour le user connecté. Si pas de user (cas SSR ou non
  // logué), on laisse tout cliquable — l'auth-gate gère déjà la redirection.
  const currentUser = useCurrentUser();
  const allowedStages: ReadonlySet<StageKey> = currentUser
    ? STAGE_ACCESS[currentUser.role]
    : new Set<StageKey>(["prepare", "charge", "livre", "monte"]);
  const [showRappel, setShowRappel] = useState(false);
  const clientInfo = useMemo(() => {
    const map = new Map<string, typeof allClients[number]>();
    for (const c of allClients) map.set(c.id, c);
    return map;
  }, [allClients]);
  const [busy, setBusy] = useState<string | null>(null);
  const monteurIdsAssignes = tournee.livraisons[0]?.monteurIds || [];
  const [monteurs, setMonteurs] = useState(() => {
    if (tournee.nbMonteurs > 0) return tournee.nbMonteurs;
    if (monteurIdsAssignes.length > 0) return monteurIdsAssignes.length;
    return MONTEURS_PAR_EQUIPE;
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingDate, setEditingDate] = useState(false);
  const [newDate, setNewDate] = useState(tournee.datePrevue ? isoDate(tournee.datePrevue) : "");
  const [addingClient, setAddingClient] = useState(false);
  const [clientSearch, setClientSearch] = useState("");
  const [progression, setProgression] = useState<{
    totals: { total: number; prepare: number; charge: number; livre: number; monte: number };
    clients?: { clientId: string; totals: { total: number; prepare: number; charge: number; livre: number; monte: number } }[];
  } | null>(null);

  useEffect(() => {
    if (!tournee.tourneeId) return;
    let alive = true;
    gasGet("getTourneeProgression", { tourneeId: tournee.tourneeId }).then((r) => {
      if (alive && r && !r.error && r.totals) setProgression(r);
    });
    return () => { alive = false; };
  }, [tournee.tourneeId]);


  const alreadyInTour = useMemo(
    () => new Set(tournee.livraisons.map((l) => l.clientId).filter((x): x is string => !!x)),
    [tournee.livraisons]
  );
  // Centroïde GPS des arrêts existants de la tournée (clients déjà planifiés
  // avec coords valides). Si la tournée est vide, on retombe sur l'entrepôt.
  const tourCentroid = useMemo(() => {
    const pts = tournee.livraisons
      .map((l) => ({ lat: l.client.lat, lng: l.client.lng }))
      .filter((p): p is { lat: number; lng: number } => !!p.lat && !!p.lng);
    if (pts.length === 0) return { lat: ENTREPOT.lat, lng: ENTREPOT.lng };
    const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
    const lng = pts.reduce((s, p) => s + p.lng, 0) / pts.length;
    return { lat, lng };
  }, [tournee.livraisons]);

  const eligibleClients = useMemo(() => {
    const libre = capaciteRestante(tournee.mode, tournee.totalVelos);
    const list = allClients
      .map((c) => {
        const reste = c.nbVelos - c.velosLivres - (c.velosPlanifies || 0);
        const distKm = c.lat && c.lng
          ? haversineKm(tourCentroid.lat, tourCentroid.lng, c.lat, c.lng)
          : Infinity;
        return { c, reste, distKm, fits: reste <= libre };
      })
      .filter(({ c, reste }) => reste > 0 && !alreadyInTour.has(c.id));
    const q = clientSearch.trim().toLowerCase();
    if (q) {
      return list
        .filter(({ c }) => `${c.entreprise} ${c.ville ?? ""} ${c.codePostal ?? ""} ${c.contact ?? ""}`.toLowerCase().includes(q))
        .map(({ c }) => c)
        .slice(0, 30);
    }
    // Pas de recherche : on classe par (1) tient dans le camion d'abord,
    // (2) plus proche du centroïde de la tournée, pour proposer en priorité
    // les clients qui complètent vraiment la tournée sans détour.
    return list
      .sort((a, b) => {
        if (a.fits !== b.fits) return a.fits ? -1 : 1;
        return a.distKm - b.distKm;
      })
      .map(({ c }) => c)
      .slice(0, 30);
  }, [allClients, alreadyInTour, clientSearch, tourCentroid, tournee.mode, tournee.totalVelos]);

  const addClient = async (clientId: string, reste: number) => {
    setBusy("add-" + clientId);
    await gasPost("createLivraison", {
      clientId,
      datePrevue: tournee.datePrevue,
      tourneeId: tournee.tourneeId,
      mode: tournee.mode,
      nbVelos: reste,
    });
    onChanged();
    setClientSearch("");
    setAddingClient(false);
    setBusy(null);
  };

  const loadByDateSansTournee = useMemo(() => {
    if (!tournee.datePrevue) return loadByDate;
    const iso = isoDate(tournee.datePrevue);
    const existing = loadByDate.get(iso);
    if (!existing) return loadByDate;
    const adjVelos = Math.max(0, existing.velos - tournee.totalVelos);
    const adjTournees = Math.max(0, existing.tournees - 1);
    const adjModes = tournee.mode ? existing.modes.filter((m) => m !== tournee.mode) : existing.modes;
    const next = new Map(loadByDate);
    if (adjVelos === 0 && adjTournees === 0) next.delete(iso);
    else next.set(iso, { velos: adjVelos, tournees: adjTournees, modes: adjModes });
    return next;
  }, [loadByDate, tournee.datePrevue, tournee.totalVelos, tournee.mode]);

  const changeDate = async () => {
    if (!newDate) return;
    setBusy("date");
    for (const l of tournee.livraisons) {
      await gasPost("updateLivraison", { id: l.id, data: { datePrevue: newDate } });
    }
    setEditingDate(false);
    onChanged();
    setBusy(null);
  };

  const toggleSelect = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const toggleAll = () => {
    if (selected.size === tournee.livraisons.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(tournee.livraisons.map((l) => l.id)));
    }
  };

  const updateStatut = async (id: string, statut: string) => {
    setBusy(id);
    const data: Record<string, unknown> = { statut };
    if (statut === "livree") data.dateEffective = new Date().toISOString();
    await gasPost("updateLivraison", { id, data });
    onChanged();
    setBusy(null);
  };

  const bulkAction = async (action: "livree" | "annulee" | "planifiee") => {
    if (selected.size === 0) return;
    const label = action === "annulee" ? "annuler" : action === "livree" ? "marquer livrées" : "restaurer";
    if (!confirm(`${label.charAt(0).toUpperCase() + label.slice(1)} ${selected.size} livraison${selected.size > 1 ? "s" : ""} ?`)) return;
    setBusy("bulk");
    for (const id of selected) {
      const l = tournee.livraisons.find((x) => x.id === id);
      if (!l) continue;
      if (action === "annulee" && l.statut !== "annulee") {
        await gasGet("deleteLivraison", { id });
      } else if (action === "livree" && l.statut !== "livree") {
        await gasPost("updateLivraison", { id, data: { statut: "livree", dateEffective: new Date().toISOString() } });
      } else if (action === "planifiee" && l.statut === "annulee") {
        await gasGet("restoreLivraison", { id });
      }
    }
    setSelected(new Set());
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

  const cancelAll = async () => {
    if (!confirm(`Annuler toute la tournée (${tournee.livraisons.length} livraisons) ? Les données sont conservées.`)) return;
    setBusy("cancelAll");
    if (tournee.tourneeId) {
      await gasGet("cancelTournee", { tourneeId: tournee.tourneeId });
    } else {
      for (const l of tournee.livraisons) {
        if (l.statut !== "annulee") {
          await gasGet("deleteLivraison", { id: l.id });
        }
      }
    }
    onChanged();
    setBusy(null);
    onClose();
  };

  const annuler = async (id: string) => {
    if (!confirm("Annuler cette livraison ?")) return;
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
  const [showPrint, setShowPrint] = useState(false);

  const isRetrait = tournee.mode === "retrait";

  // Segments routiers réels via Google Maps Distance Matrix (endpoint GAS
  // getRouting). Tableau ordonné : [ENTREPOT→arret0, arret0→arret1, ...,
  // arretN→ENTREPOT]. Null tant que l'appel n'est pas revenu — le rendu
  // utilise alors le fallback haversine ci-dessous.
  const [apiSegments, setApiSegments] = useState<{ distKm: number; trajetMin: number }[] | null>(null);

  useEffect(() => {
    const livs = tournee.livraisons;
    if (livs.length === 0) {
      setApiSegments(null);
      return;
    }
    let cancelled = false;
    setApiSegments(null);
    // On envoie TOUS les points (entrepôt + arrêts + entrepôt) y compris ceux
    // sans coords (le GAS renvoie {0,0,skip} pour ces segments-là).
    const points: { lat: number; lng: number }[] = [
      { lat: ENTREPOT.lat, lng: ENTREPOT.lng },
      ...livs.map((l) => ({ lat: l.client.lat ?? 0, lng: l.client.lng ?? 0 })),
      { lat: ENTREPOT.lat, lng: ENTREPOT.lng },
    ];
    gasPost("getRouting", { points })
      .then((r: { ok?: boolean; segments?: { distKm: number; trajetMin: number }[] }) => {
        if (cancelled) return;
        if (r.ok && r.segments && r.segments.length === points.length - 1) {
          setApiSegments(r.segments);
        }
      })
      .catch(() => {
        // Silencieux : on garde le fallback haversine, c'est mieux que rien.
      });
    return () => {
      cancelled = true;
    };
  }, [tournee.livraisons]);

  const segments = useMemo(() => {
    const segs: { distKm: number; trajetMin: number; fromLabel: string }[] = [];
    for (let i = 0; i < tournee.livraisons.length; i++) {
      const curr = tournee.livraisons[i].client;
      const prevLat = i === 0 ? ENTREPOT.lat : (tournee.livraisons[i - 1].client.lat ?? 0);
      const prevLng = i === 0 ? ENTREPOT.lng : (tournee.livraisons[i - 1].client.lng ?? 0);
      const fromLabel = i === 0 ? ENTREPOT.label : "";
      // Priorité 1 : segment routier réel renvoyé par Google Maps
      // (apiSegments[i] correspond à entrepôt→arret0 pour i=0, sinon arret[i-1]→arret[i]).
      const apiSeg = apiSegments?.[i];
      if (apiSeg && (apiSeg.distKm > 0 || apiSeg.trajetMin > 0)) {
        segs.push({ distKm: apiSeg.distKm, trajetMin: apiSeg.trajetMin, fromLabel });
        continue;
      }
      // Fallback haversine × 1.3 puis 30 km/h. Optimiste en zone urbaine
      // mais c'est le mieux qu'on a sans l'API (offline ou erreur Maps).
      if (prevLat && prevLng && curr.lat && curr.lng) {
        const d = haversineKm(prevLat, prevLng, curr.lat, curr.lng);
        const routeKm = d * 1.3;
        segs.push({ distKm: Math.round(routeKm * 10) / 10, trajetMin: Math.round(routeKm / 0.5), fromLabel });
      } else {
        segs.push({ distKm: 0, trajetMin: 0, fromLabel });
      }
    }
    return segs;
  }, [tournee.livraisons, apiSegments]);

  const retourSegment = useMemo(() => {
    if (tournee.livraisons.length === 0) return { distKm: 0, trajetMin: 0 };
    // apiSegments[N] = dernier arrêt → entrepôt (où N = nb de livraisons)
    const apiRetour = apiSegments?.[tournee.livraisons.length];
    if (apiRetour && (apiRetour.distKm > 0 || apiRetour.trajetMin > 0)) {
      return { distKm: apiRetour.distKm, trajetMin: apiRetour.trajetMin };
    }
    const last = tournee.livraisons[tournee.livraisons.length - 1].client;
    if (!last.lat || !last.lng) return { distKm: 0, trajetMin: 0 };
    const d = haversineKm(last.lat, last.lng, ENTREPOT.lat, ENTREPOT.lng);
    const routeKm = d * 1.3;
    return { distKm: Math.round(routeKm * 10) / 10, trajetMin: Math.round(routeKm / 0.5) };
  }, [tournee.livraisons, apiSegments]);

  const totalTrajetMin = segments.reduce((s, seg) => s + seg.trajetMin, 0) + retourSegment.trajetMin;
  const totalMontageMin = tournee.totalVelos * MINUTES_PAR_VELO;
  const montageAvecEffectif = totalMontageMin / monteurs;
  const totalJourneeSimple = montageAvecEffectif + totalTrajetMin;
  const minutesJournee = HEURES_JOURNEE * 60;
  const velosParMonteurJour = Math.floor(minutesJournee / MINUTES_PAR_VELO);
  const monteursNecessaires = Math.ceil((totalMontageMin + totalTrajetMin) / minutesJournee);
  const velosAvecEffectif = monteurs * velosParMonteurJour;

  const deployPlan = useMemo(
    () => computeDeployPlan(tournee.livraisons, segments, monteurs),
    [tournee.livraisons, segments, monteurs]
  );
  const hasParallel = deployPlan.steps.some((s) => !s.camionAttend);
  const totalJourneeEffectif = hasParallel ? deployPlan.totalElapsed : totalJourneeSimple;
  const faisableEnUnJour = totalJourneeEffectif <= minutesJournee;

  const fmtDuree = (min: number) => {
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return h > 0 ? `${h}h${m > 0 ? String(m).padStart(2, "0") : ""}` : `${m}min`;
  };

  if (showPrint) {
    return (
      <FeuilleDeRoute
        tournee={tournee}
        segments={segments}
        retourSegment={retourSegment}
        monteurs={monteurs}
        clientInfo={clientInfo}
        onBack={() => setShowPrint(false)}
      />
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-3">
          <div>
            <div className={`inline-flex items-center gap-2 ${palette.text}`}>
              <span className="text-lg font-semibold">
                {isRetrait ? "Retrait client" : "Tournée"} {tourneeNumber ? <span>{tourneeNumber}</span> : tournee.tourneeId ? <span className="font-mono text-sm">{tournee.tourneeId}</span> : "(sans id)"}
              </span>
            </div>
            <div className="text-sm text-gray-500 mt-1 flex items-center gap-2 flex-wrap">
              {editingDate ? (
                <div className="w-full max-w-md border rounded-lg p-3 bg-gray-50">
                  <DateLoadPicker
                    value={newDate}
                    onChange={setNewDate}
                    loadByDate={loadByDateSansTournee}
                  />
                  <div className="flex items-center justify-end gap-2 mt-2">
                    <button onClick={() => setEditingDate(false)} className="text-gray-500 hover:text-gray-700 text-xs">
                      annuler
                    </button>
                    <button
                      onClick={changeDate}
                      disabled={busy === "date" || !newDate}
                      className="px-3 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 disabled:opacity-50"
                    >
                      {busy === "date" ? "..." : "Déplacer la tournée"}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setEditingDate(true)}
                  className="hover:text-blue-600 hover:underline cursor-pointer"
                  title="Modifier la date"
                >
                  {tournee.datePrevue ? new Date(tournee.datePrevue).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "Sans date"}
                </button>
              )}
              <span>· {tournee.totalVelos} vélos · {tournee.livraisons.length} arrêts</span>
              {(() => {
                const libre = capaciteRestante(tournee.mode, tournee.totalVelos);
                if (libre < SEUIL_2EME_TOURNEE || tournee.statutGlobal === "livree" || tournee.statutGlobal === "annulee") return null;
                const cap = tournee.mode ? CAPACITES[tournee.mode] : 0;
                return (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-green-100 text-green-800 text-[10px] font-semibold">
                    +{libre}v libre sur {cap} · 2e tournée possible
                  </span>
                );
              })()}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {tournee.tourneeId && (
              <a
                href={`/tournee-execute?id=${encodeURIComponent(tournee.tourneeId)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-1 text-xs bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 flex items-center gap-1"
                title="Ouvrir l'écran mobile pour le chef d'équipe"
              >
                📱 Chef d&apos;équipe
              </a>
            )}
            <button
              onClick={() => setShowRappel(true)}
              className="px-3 py-1 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center gap-1"
              title="Envoie un rappel par mail à chaque client de la tournée avec sa fenêtre de passage estimée"
            >
              📧 Rappels veille
            </button>
            <button
              onClick={() => setShowPrint(true)}
              className="px-3 py-1 text-xs bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 flex items-center gap-1"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
              </svg>
              Feuille de route
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
          </div>
        </div>

        {/* Estimation temps + effectif */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-blue-900">Estimation journée</span>
            <span className="text-xs text-blue-600">{MINUTES_PAR_VELO} min/vélo · ~30 km/h en ville</span>
          </div>
          <div className="text-[10px] text-blue-700 flex items-center gap-1">
            <span>📍</span>
            <span className="truncate">Départ : {ENTREPOT.label}</span>
          </div>
          <div className="grid gap-2 text-center grid-cols-5">
            <div className="bg-white rounded-lg p-2">
              <div className="text-lg font-bold text-blue-900">{tournee.totalVelos}</div>
              <div className="text-[10px] text-blue-600">Vélos</div>
            </div>
            <div className="bg-white rounded-lg p-2">
              <div className="text-lg font-bold text-blue-900">{tournee.livraisons.length}</div>
              <div className="text-[10px] text-blue-600">Arrêts</div>
            </div>
            <div className="bg-white rounded-lg p-2">
              <div className="text-lg font-bold text-blue-900">{fmtDuree(montageAvecEffectif)}</div>
              <div className="text-[10px] text-blue-600">{isRetrait ? "Prépa + admin" : "Montage"}{monteurs > 1 ? ` (${monteurs}m.)` : ""}</div>
            </div>
            <div className="bg-white rounded-lg p-2">
              <div className="text-lg font-bold text-blue-900">{fmtDuree(totalTrajetMin)}</div>
              <div className="text-[10px] text-blue-600">Trajet</div>
            </div>
            <div className="bg-white rounded-lg p-2">
              <div className="text-lg font-bold text-blue-900">{fmtDuree(totalJourneeEffectif)}</div>
              <div className="text-[10px] text-blue-600">Total</div>
            </div>
          </div>

          <div className={`text-sm font-medium rounded-lg px-3 py-2 ${faisableEnUnJour ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>
            {faisableEnUnJour ? (
              <>Faisable en 1 jour — {fmtDuree(totalJourneeEffectif)} avec {monteurs} monteur{monteurs > 1 ? "s" : ""} · Capacité : {velosAvecEffectif} vélos</>
            ) : (
              <>Pas faisable en 1 jour — {fmtDuree(totalJourneeEffectif)} dépasse {HEURES_JOURNEE}h · Capacité max : {velosAvecEffectif} vélos</>
            )}
          </div>

          {hasParallel && !isRetrait && (
            <div className="bg-purple-50 border border-purple-200 rounded-lg p-2 space-y-1">
              <div className="text-xs font-medium text-purple-900">Plan de déploiement parallèle</div>
              <div className="text-[10px] text-purple-700 space-y-0.5">
                {deployPlan.steps.map((s, i) => {
                  const l = tournee.livraisons[s.stopIndex];
                  const tropLong = s.tempsSurPlace > MAX_TEMPS_SUR_PLACE_MIN;
                  const monteursNecessaires = Math.ceil(s.montageTotal / MAX_TEMPS_SUR_PLACE_MIN);
                  const renfortMin = Math.max(0, monteursNecessaires - s.monteursAffectes);
                  return (
                    <div key={i} className={`flex items-center gap-1 ${tropLong ? "bg-red-100 px-1 rounded" : ""}`}>
                      <span className="w-4 text-center font-bold">{s.stopIndex + 1}</span>
                      <span className="truncate flex-1">{l.client.entreprise}</span>
                      <span className={tropLong ? "text-red-700 font-bold" : ""}>{l._count.velos}v · {s.monteursAffectes} mont. · {fmtDuree(s.tempsSurPlace)}</span>
                      {tropLong ? (
                        <span className="text-red-700 font-bold ml-1" title={`${fmtDuree(s.tempsSurPlace)} sur place > ${MAX_TEMPS_SUR_PLACE_MIN / 60}h max. Prévoir +${renfortMin} monteur${renfortMin > 1 ? "s" : ""} en renfort pour tomber à ${fmtDuree(s.montageTotal / monteursNecessaires)}.`}>
                          ⚠ +{renfortMin} mont. urgence
                        </span>
                      ) : !s.camionAttend ? (
                        <span className="text-purple-600 font-medium ml-1">→ camion avance</span>
                      ) : (
                        <span className="text-gray-500 ml-1">camion attend</span>
                      )}
                    </div>
                  );
                })}
                {deployPlan.steps.some((s) => s.tempsSurPlace > MAX_TEMPS_SUR_PLACE_MIN) && (
                  <div className="pt-1 border-t border-red-300 text-red-800 font-medium bg-red-50 -mx-2 -mb-1 px-2 py-1 rounded-b">
                    ⚠ {deployPlan.steps.filter((s) => s.tempsSurPlace > MAX_TEMPS_SUR_PLACE_MIN).length} arrêt(s) dépassent {MAX_TEMPS_SUR_PLACE_MIN / 60}h sur place — prévoir un effectif d&apos;urgence pour ne pas bloquer le client.
                  </div>
                )}
                <div className="pt-1 border-t border-purple-200 font-medium">
                  Gain parallèle : {fmtDuree(totalJourneeSimple - totalJourneeEffectif)} économisés
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Bon d'enlèvement de la tournée (Axdis) */}
        {tournee.tourneeId && (() => {
          const be = bonsEnlevement.find((b) => b.tourneeId === tournee.tourneeId);
          if (!be) {
            return (
              <div className="mb-3 inline-flex items-center gap-2 text-sm px-3 py-2 rounded-lg border bg-gray-50 border-gray-200 text-gray-500">
                <span>📋</span>
                <span>Bon d&apos;enlèvement non reçu</span>
              </div>
            );
          }
          const qte = Number(be.quantite || 0);
          const match = qte === tournee.totalVelos;
          let cls = "bg-orange-50 border-orange-300 text-orange-800";
          let icon = "⚠";
          if (match) { cls = "bg-green-50 border-green-300 text-green-800"; icon = "✓"; }
          return (
            <div className={`mb-3 flex items-center gap-3 px-3 py-2 rounded-lg border ${cls}`}>
              <span className="text-lg">📋</span>
              <div className="flex-1 text-sm">
                <div className="font-medium">
                  Bon d&apos;enlèvement {be.fournisseur || ""} {be.numeroDoc ? `#${be.numeroDoc}` : ""} {icon}
                </div>
                <div className="text-xs opacity-80">
                  {be.tourneeRef || ""} · {qte} vélo{qte > 1 ? "s" : ""} {match ? "= " : "≠ "}{tournee.totalVelos} dans la tournée
                </div>
              </div>
              {be.driveUrl && (
                <a
                  href={be.driveUrl.split(" ||| ")[0]}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs underline hover:opacity-80"
                >
                  Voir le PDF
                </a>
              )}
            </div>
          );
        })()}

        {/* Suivi opérationnel global tournée */}
        {tournee.tourneeId && progression && progression.totals.total > 0 && (() => {
          const t = progression.totals;
          const stages: { key: string; label: string; emoji: string; value: number }[] = [
            { key: "prepare", label: "Prép.", emoji: "📦", value: t.prepare },
            { key: "charge", label: "Charg.", emoji: "🚚", value: t.charge },
            { key: "livre", label: "Livr.", emoji: "📍", value: t.livre },
            { key: "monte", label: "Mont.", emoji: "🔧", value: t.monte },
          ];
          return (
            <div className="flex flex-wrap items-center gap-2 mb-3">
              {stages.map((s) => {
                const done = t.total > 0 && s.value >= t.total;
                const inProgress = s.value > 0 && s.value < t.total;
                let cls = "bg-gray-100 text-gray-600 border-gray-200";
                if (done) cls = "bg-green-100 text-green-800 border-green-300";
                else if (inProgress) cls = "bg-blue-100 text-blue-800 border-blue-300";
                return (
                  <span key={s.key} className={`inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded-full border font-medium ${cls}`}>
                    <span>{s.emoji}</span>
                    <span>{s.label}</span>
                    <span className="font-mono">{s.value}/{t.total}</span>
                    {done && <span>✓</span>}
                  </span>
                );
              })}
            </div>
          );
        })()}

        {/* Affectation équipe */}
        {tournee.tourneeId && (
          <EquipeAssignBlock
            tourneeId={tournee.tourneeId}
            isRetrait={isRetrait}
            initialChauffeurId={tournee.livraisons[0]?.chauffeurId || null}
            initialChefEquipeIds={(() => {
              const ids = tournee.livraisons[0]?.chefEquipeIds;
              if (Array.isArray(ids) && ids.length > 0) return ids;
              const single = tournee.livraisons[0]?.chefEquipeId;
              return single ? [single] : [];
            })()}
            initialMonteurIds={tournee.livraisons[0]?.monteurIds || []}
            initialPreparateurIds={tournee.livraisons[0]?.preparateurIds || []}
            onSaved={onChanged}
            onMonteurCountChange={setMonteurs}
          />
        )}

        {/* Barre sélection */}
        <div className="flex items-center gap-3 mb-2">
          <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
            <input
              type="checkbox"
              checked={selected.size === tournee.livraisons.length && tournee.livraisons.length > 0}
              onChange={toggleAll}
            />
            Tout sélectionner
          </label>
          {selected.size > 0 && (
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-xs text-gray-500">{selected.size} sélectionnée{selected.size > 1 ? "s" : ""}</span>
              <button
                onClick={() => bulkAction("livree")}
                disabled={busy === "bulk"}
                className="px-2 py-1 text-xs bg-green-100 text-green-700 rounded-lg hover:bg-green-200 disabled:opacity-50"
              >
                Marquer livrées
              </button>
              <button
                onClick={() => bulkAction("annulee")}
                disabled={busy === "bulk"}
                className="px-2 py-1 text-xs bg-red-100 text-red-700 rounded-lg hover:bg-red-200 disabled:opacity-50"
              >
                Annuler
              </button>
              <button
                onClick={() => bulkAction("planifiee")}
                disabled={busy === "bulk"}
                className="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 disabled:opacity-50"
              >
                Restaurer
              </button>
            </div>
          )}
        </div>

        <div className="space-y-2">
          {tournee.livraisons.map((l, i) => (
            <div key={l.id}>
              {segments[i].distKm > 0 && (
                <div className="flex items-center gap-2 py-1 px-10 text-[10px] text-gray-400">
                  <div className="border-l-2 border-dashed border-gray-300 h-3" />
                  <span>{i === 0 ? `📍 ${ENTREPOT.label} → ` : "↓ "}{segments[i].distKm} km · ~{segments[i].trajetMin} min</span>
                </div>
              )}
              <div className={`border rounded-lg p-3 ${selected.has(l.id) ? "bg-blue-50 border-blue-300" : ""}`}>
                <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={selected.has(l.id)}
                  onChange={() => toggleSelect(l.id)}
                  className="shrink-0 mt-1"
                />
                <span className="w-9 h-9 sm:w-7 sm:h-7 rounded-full bg-green-600 text-white text-base sm:text-sm flex items-center justify-center font-semibold shrink-0">
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-base sm:font-medium leading-tight">{l.client.entreprise}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {[l.client.adresse, l.client.ville, l.client.codePostal].filter(Boolean).join(", ") || "—"}
                  </div>
                  {l.client.telephone && (
                    <div className="text-xs text-gray-400">{l.client.telephone}</div>
                  )}
                  {l.clientId && clientInfo.get(l.clientId)?.apporteur && (
                    <div className="text-[11px] sm:text-[10px] text-orange-600 font-medium mt-0.5">
                      Apporteur : {clientInfo.get(l.clientId)!.apporteur}
                    </div>
                  )}
                  {tournee.tourneeId && (() => {
                    const cp = progression?.clients?.find((c) => c.clientId === l.clientId)?.totals;
                    const tot = cp?.total ?? l._count.velos;
                    const tid = encodeURIComponent(tournee.tourneeId);
                    const cid = l.clientId ? `&clientId=${encodeURIComponent(l.clientId)}` : "";
                    // Effectif mobilisé par étape, basé sur l'équipe assignée à la
                    // tournée (preparateurIds, chauffeurId, chefEquipeIds, monteurIds
                    // — tous portés par la 1re livraison de la tournée).
                    // Mapping :
                    //   Prép. = nb préparateurs
                    //   Charg. = chauffeur(1) + monteurs (équipe au dépôt)
                    //   Livr. = chauffeur(1) + chefs (responsables remise client)
                    //   Mont. = monteurs déployés sur CET arrêt précis (deployPlan)
                    const liv0 = tournee.livraisons[0];
                    const nbPreparateurs = liv0?.preparateurIds?.length || 0;
                    const nbMonteursAssignes = liv0?.monteurIds?.length || monteurs;
                    const nbChefs = liv0?.chefEquipeIds?.length || 0;
                    const hasChauffeur = !!liv0?.chauffeurId;
                    const nbCharg = (hasChauffeur ? 1 : 0) + nbMonteursAssignes;
                    const nbLivr = (hasChauffeur ? 1 : 0) + nbChefs;
                    const nbMontIci = deployPlan.steps[i]?.monteursAffectes ?? nbMonteursAssignes;
                    const effectifs: Record<"prepare" | "charge" | "livre" | "monte", number> = {
                      prepare: nbPreparateurs,
                      charge: nbCharg,
                      livre: nbLivr,
                      monte: nbMontIci,
                    };
                    const stages: { key: "prepare" | "charge" | "livre" | "monte"; label: string; emoji: string; href: string | null }[] = [
                      { key: "prepare", label: "Prép.", emoji: "📦", href: `/crm-velos-cargo/preparation?tourneeId=${tid}${cid}` },
                      { key: "charge", label: "Charg.", emoji: "🚚", href: `/crm-velos-cargo/chargement?tourneeId=${tid}${cid}` },
                      { key: "livre", label: "Livr.", emoji: "📍", href: `/crm-velos-cargo/livraison?tourneeId=${tid}${cid}` },
                      { key: "monte", label: "Mont.", emoji: "🔧", href: `/crm-velos-cargo/montage?tourneeId=${tid}${cid}` },
                    ];
                    return (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {stages.map((s) => {
                          const v = cp ? cp[s.key] : 0;
                          const done = tot > 0 && v >= tot;
                          const inProgress = v > 0 && v < tot;
                          let cls = "bg-gray-100 text-gray-600 border-gray-200";
                          if (done) cls = "bg-green-100 text-green-800 border-green-300";
                          else if (inProgress) cls = "bg-blue-100 text-blue-800 border-blue-300";
                          // Rouge si étape précédente terminée mais celle-ci à 0 et tournée marquée livrée
                          const prevKey: typeof s.key | null =
                            s.key === "charge" ? "prepare" :
                            s.key === "livre" ? "charge" :
                            s.key === "monte" ? "livre" : null;
                          const prevDone = prevKey && cp ? cp[prevKey] >= tot : false;
                          const isLivreeStatut = l.statut === "livree";
                          if (isLivreeStatut && !done && (s.key === "livre" || (prevDone && v < tot))) {
                            cls = "bg-red-100 text-red-800 border-red-300";
                          }
                          const eff = effectifs[s.key];
                          // Une étape est cliquable si :
                          //   1. on a un href (l'étape correspond à une vraie page)
                          //   2. ET le rôle de l'utilisateur connecté l'autorise.
                          // Sinon, on rend un <span> grisé non cliquable. C'est ce
                          // qui empêche AXDIS (préparateur) de marquer une livraison
                          // ou Armel (chauffeur) de toucher à la préparation.
                          const isAllowedForRole = allowedStages.has(s.key);
                          const isClickable = !!s.href && isAllowedForRole;
                          const content = (
                            <span className="inline-flex items-center gap-1">
                              <span>{s.emoji}</span>
                              <span className="font-medium">{s.label}</span>
                              <span className="font-mono">{v}/{tot}</span>
                              {eff > 0 && <span className="opacity-70">({eff}p)</span>}
                              {done && <span>✓</span>}
                              {!isAllowedForRole && <span title="Action réservée à un autre rôle">🔒</span>}
                            </span>
                          );
                          return isClickable ? (
                            <a
                              key={s.key}
                              href={s.href!}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className={`text-sm sm:text-[10px] px-3 py-1.5 sm:px-2 sm:py-0.5 rounded-full border ${cls} hover:opacity-80 cursor-pointer font-medium`}
                            >{content}</a>
                          ) : (
                            <span
                              key={s.key}
                              className={`text-sm sm:text-[10px] px-3 py-1.5 sm:px-2 sm:py-0.5 rounded-full border ${cls} font-medium ${!isAllowedForRole ? "opacity-50 cursor-not-allowed" : ""}`}
                              title={!isAllowedForRole ? "Action réservée à un autre rôle" : undefined}
                            >{content}</span>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
                </div>
                <div className="flex items-center gap-2 mt-2 ml-12 sm:ml-0 sm:mt-0 flex-wrap">
                  <span className="text-sm font-medium bg-gray-100 px-2 py-0.5 rounded">
                    {l._count.velos} v.
                  </span>
                  {!isRetrait && monteurs > 1 && deployPlan.steps[i] && (
                    <span className={`text-[9px] ${deployPlan.steps[i].camionAttend ? "text-gray-400" : "text-purple-600 font-medium"}`}>
                      {fmtDuree(deployPlan.steps[i].tempsSurPlace)} · {deployPlan.steps[i].monteursAffectes}m
                      {!deployPlan.steps[i].camionAttend && " →"}
                    </span>
                  )}
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
                      className="text-emerald-500 hover:text-emerald-700 text-xs whitespace-nowrap"
                    >
                      ↺ restaurer
                    </button>
                  ) : (
                    <button
                      onClick={() => annuler(l.id)}
                      disabled={busy === l.id}
                      className="text-amber-500 hover:text-amber-700 text-xs whitespace-nowrap"
                    >
                      annuler
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
          {retourSegment.distKm > 0 && (
            <div className="flex items-center gap-2 py-1 px-10 text-[10px] text-gray-400">
              <div className="border-l-2 border-dashed border-gray-300 h-3" />
              <span>↩ retour {ENTREPOT.label} · {retourSegment.distKm} km · ~{retourSegment.trajetMin} min</span>
            </div>
          )}
        </div>

        <div className="mt-3">
          {addingClient ? (
            <div className="border rounded-lg p-3 bg-gray-50 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700">Ajouter un client à cette tournée</span>
                <button
                  onClick={() => { setAddingClient(false); setClientSearch(""); }}
                  className="text-gray-400 hover:text-gray-600 text-xs"
                >
                  annuler
                </button>
              </div>
              <input
                type="text"
                value={clientSearch}
                onChange={(e) => setClientSearch(e.target.value)}
                placeholder="Chercher un client (nom, ville, CP, contact)…"
                className="w-full px-3 py-1.5 border rounded-lg text-sm"
                autoFocus
              />
              <div className="max-h-48 overflow-y-auto divide-y border rounded-lg bg-white">
                {eligibleClients.length === 0 && (
                  <div className="px-3 py-4 text-xs text-gray-400 text-center">
                    {clientSearch ? "Aucun résultat" : "Aucun client disponible (tous déjà planifiés/livrés)"}
                  </div>
                )}
                {eligibleClients.map((c) => {
                  const reste = c.nbVelos - c.velosLivres - (c.velosPlanifies || 0);
                  const loadingRow = busy === "add-" + c.id;
                  const libre = capaciteRestante(tournee.mode, tournee.totalVelos);
                  const fits = reste <= libre;
                  const distKm = c.lat && c.lng
                    ? haversineKm(tourCentroid.lat, tourCentroid.lng, c.lat, c.lng)
                    : null;
                  return (
                    <button
                      key={c.id}
                      onClick={() => addClient(c.id, reste)}
                      disabled={!!busy}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-blue-50 text-left disabled:opacity-50"
                    >
                      <span className="flex-1 truncate">
                        <span className="font-medium">{c.entreprise}</span>
                        {c.ville && <span className="text-gray-400"> · {c.ville}</span>}
                      </span>
                      {distKm != null && (
                        <span className="text-[10px] text-gray-400 whitespace-nowrap">{distKm.toFixed(1)} km</span>
                      )}
                      <span
                        className={`text-xs font-medium whitespace-nowrap ${fits ? "text-blue-700" : "text-amber-600"}`}
                        title={fits ? "Rentre dans le camion" : `Dépasse la capacité (${libre}v libre)`}
                      >
                        + {reste}v{!fits && " ⚠"}
                      </span>
                      {loadingRow && <span className="text-xs text-gray-400">…</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <button
              onClick={() => setAddingClient(true)}
              className="w-full px-3 py-2 border border-dashed border-gray-300 rounded-lg text-sm text-gray-500 hover:bg-gray-50 hover:text-blue-600 hover:border-blue-300"
            >
              + Ajouter un client à cette tournée
            </button>
          )}
        </div>

        <div className="flex justify-between gap-3 mt-4 pt-3 border-t">
          <button
            onClick={cancelAll}
            disabled={busy === "cancelAll"}
            className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
          >
            {busy === "cancelAll" ? "Annulation…" : "Annuler toute la tournée"}
          </button>
          <button
            onClick={setAllLivrees}
            disabled={busy === "all"}
            className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
          >
            {busy === "all" ? "Mise à jour…" : "Tout marquer livré"}
          </button>
        </div>
      </div>
      {showRappel && (
        <RappelVeilleModal
          tournee={tournee}
          segments={segments}
          monteurs={monteurs}
          equipe={equipe}
          clientInfo={clientInfo}
          onClose={() => setShowRappel(false)}
        />
      )}
    </div>
  );
}

function FeuilleDeRoute({
  tournee,
  segments,
  retourSegment,
  monteurs,
  clientInfo,
  onBack,
}: {
  tournee: Tournee;
  segments: { distKm: number; trajetMin: number }[];
  retourSegment: { distKm: number; trajetMin: number };
  monteurs: number;
  clientInfo: Map<string, { apporteur: string | null; contact: string | null; email: string | null }>;
  onBack: () => void;
}) {
  const totalTrajet = segments.reduce((s, seg) => s + seg.trajetMin, 0) + retourSegment.trajetMin;
  const totalMontage = tournee.totalVelos * MINUTES_PAR_VELO;
  const totalDist = segments.reduce((s, seg) => s + seg.distKm, 0) + retourSegment.distKm;
  const fmtDuree = (min: number) => {
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return h > 0 ? `${h}h${m > 0 ? String(m).padStart(2, "0") : ""}` : `${m}min`;
  };

  return (
    <div className="fixed inset-0 bg-white z-50 overflow-auto">
      <div className="max-w-3xl mx-auto p-6 print:p-4">
        <div className="flex items-center justify-between mb-6 print:hidden">
          <button onClick={onBack} className="text-sm text-gray-500 hover:text-gray-700">← Retour</button>
          <button
            onClick={() => window.print()}
            className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700"
          >
            Imprimer / PDF
          </button>
        </div>

        <div className="text-center mb-6 border-b pb-4">
          <h1 className="text-xl font-bold">Feuille de route</h1>
          <div className="text-sm text-gray-600 mt-1">
            {tournee.datePrevue && new Date(tournee.datePrevue).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
            {tournee.numero ? <span className="ml-2 text-xs text-gray-500">— Tournée {tournee.numero}</span> : tournee.tourneeId ? <span className="ml-2 font-mono text-xs text-gray-400">[{tournee.tourneeId}]</span> : null}
          </div>
          <div className="text-xs text-gray-500 mt-1">Départ : {ENTREPOT.label}</div>
          <div className="flex justify-center gap-6 mt-3 text-sm">
            <span><strong>{tournee.livraisons.length}</strong> arrêts</span>
            <span><strong>{tournee.totalVelos}</strong> vélos</span>
            <span><strong>{Math.round(totalDist)}</strong> km</span>
            <span><strong>{fmtDuree(totalTrajet + totalMontage)}</strong> estimé</span>
            <span><strong>{monteurs}</strong> monteur{monteurs > 1 ? "s" : ""}</span>
          </div>
        </div>

        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b-2 text-left">
              <th className="py-2 w-8">#</th>
              <th className="py-2">Client</th>
              <th className="py-2">Adresse</th>
              <th className="py-2 w-20 text-center">Apporteur</th>
              <th className="py-2 w-16 text-center">Tél.</th>
              <th className="py-2 w-12 text-center">Vélos</th>
              <th className="py-2 w-16 text-center">Trajet</th>
              <th className="py-2 w-20 text-center">Fait</th>
            </tr>
          </thead>
          <tbody>
            {tournee.livraisons.map((l, i) => {
              const ci = l.clientId ? clientInfo.get(l.clientId) : null;
              return (
              <tr key={l.id} className="border-b">
                <td className="py-2 font-bold">{i + 1}</td>
                <td className="py-2">
                  <div className="font-medium">{l.client.entreprise}</div>
                  {ci?.contact && <div className="text-xs text-gray-600">{ci.contact}</div>}
                </td>
                <td className="py-2 text-xs text-gray-600">
                  {[l.client.adresse, l.client.codePostal, l.client.ville].filter(Boolean).join(", ")}
                </td>
                <td className="py-2 text-xs text-center text-orange-600 font-medium">
                  {ci?.apporteur || "—"}
                </td>
                <td className="py-2 text-xs text-center">{l.client.telephone || "—"}</td>
                <td className="py-2 text-center font-medium">{l._count.velos}</td>
                <td className="py-2 text-center text-xs text-gray-500">
                  {i > 0 && segments[i].distKm > 0 ? `${segments[i].distKm}km` : "—"}
                </td>
                <td className="py-2 text-center">
                  <div className="w-5 h-5 border-2 border-gray-400 rounded mx-auto" />
                </td>
              </tr>
              );
            })}
            {retourSegment.distKm > 0 && (
              <tr className="border-b bg-gray-50">
                <td className="py-2 text-gray-400">↩</td>
                <td className="py-2 font-medium text-gray-500" colSpan={2}>Retour entrepôt — {ENTREPOT.label}</td>
                <td className="py-2 text-center text-gray-400">—</td>
                <td className="py-2 text-center text-gray-400">—</td>
                <td className="py-2 text-center text-gray-400">—</td>
                <td className="py-2 text-center text-xs text-gray-500">{retourSegment.distKm}km</td>
                <td className="py-2" />
              </tr>
            )}
          </tbody>
        </table>

        <div className="mt-6 border-t pt-4">
          <div className="text-sm font-medium mb-2">Notes :</div>
          <div className="h-24 border border-gray-300 rounded" />
        </div>
      </div>
    </div>
  );
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

function optimizeStopOrder(livraisons: LivraisonRow[]): LivraisonRow[] {
  const withCoords = livraisons.filter((l) => l.client.lat && l.client.lng);
  const withoutCoords = livraisons.filter((l) => !l.client.lat || !l.client.lng);
  if (withCoords.length <= 1) return livraisons;

  const remaining = [...withCoords];
  const ordered: LivraisonRow[] = [];
  let curLat = ENTREPOT.lat;
  let curLng = ENTREPOT.lng;

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineKm(curLat, curLng, remaining[i].client.lat!, remaining[i].client.lng!);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    ordered.push(next);
    curLat = next.client.lat!;
    curLng = next.client.lng!;
  }

  return [...ordered, ...withoutCoords];
}

function groupByTournee(livraisons: LivraisonRow[]): Tournee[] {
  const groups = new Map<string, Tournee>();
  for (const l of livraisons) {
    if (l.statut === "annulee") continue;
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
        nbMonteurs: 0,
        statutGlobal: "planifiee",
      };
      groups.set(groupKey, g);
    }
    g.livraisons.push(l);
    g.totalVelos += l._count.velos;
    if (l.nbMonteurs && l.nbMonteurs > g.nbMonteurs) g.nbMonteurs = l.nbMonteurs;
  }

  for (const g of groups.values()) {
    const statuts = new Set(g.livraisons.map((l) => l.statut));
    if (statuts.size === 1) {
      g.statutGlobal = ([...statuts][0] as Tournee["statutGlobal"]) || "planifiee";
    } else {
      g.statutGlobal = "mixte";
    }
    if (g.livraisons.length > 1) {
      g.livraisons = optimizeStopOrder(g.livraisons);
    }
  }

  return Array.from(groups.values());
}

function EquipeAssignBlock({
  tourneeId,
  isRetrait,
  initialChauffeurId,
  initialChefEquipeIds,
  initialMonteurIds,
  initialPreparateurIds,
  onSaved,
  onMonteurCountChange,
}: {
  tourneeId: string;
  isRetrait: boolean;
  initialChauffeurId: string | null;
  initialChefEquipeIds: string[];
  initialMonteurIds: string[];
  initialPreparateurIds: string[];
  onSaved: () => void;
  onMonteurCountChange?: (count: number) => void;
}) {
  const { equipe } = useData();
  const [chauffeurId, setChauffeurId] = useState<string>(initialChauffeurId || "");
  const [chefEquipeIds, setChefEquipeIds] = useState<string[]>(initialChefEquipeIds);
  const [monteurIds, setMonteurIds] = useState<string[]>(initialMonteurIds);
  const [preparateurIds, setPreparateurIds] = useState<string[]>(initialPreparateurIds);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const chauffeurs = equipe.filter((m) => m.role === "chauffeur" && m.actif !== false);
  const chefs = equipe.filter((m) => m.role === "chef" && m.actif !== false);
  const monteurs = equipe.filter((m) => m.role === "monteur" && m.actif !== false);
  const preparateurs = equipe.filter((m) => m.role === "preparateur" && m.actif !== false);

  const hasEquipe = equipe.length > 0;
  const dirty =
    chauffeurId !== (initialChauffeurId || "") ||
    JSON.stringify([...chefEquipeIds].sort()) !== JSON.stringify([...initialChefEquipeIds].sort()) ||
    JSON.stringify([...monteurIds].sort()) !== JSON.stringify([...initialMonteurIds].sort()) ||
    JSON.stringify([...preparateurIds].sort()) !== JSON.stringify([...initialPreparateurIds].sort());

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await gasPost("assignTournee", {
        tourneeId,
        chauffeurId: chauffeurId || "",
        chefEquipeId: chefEquipeIds[0] || "",
        chefEquipeIds,
        monteurIds,
        preparateurIds,
      });
      if ((r as { error?: string }).error) throw new Error((r as { error?: string }).error);
      setSavedAt(new Date());
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const toggleChef = (id: string) => {
    setChefEquipeIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const toggleMonteur = (id: string) => {
    setMonteurIds((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      onMonteurCountChange?.(Math.max(1, next.length));
      return next;
    });
  };

  const togglePreparateur = (id: string) => {
    setPreparateurIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  return (
    <div className="bg-white border rounded-lg p-3 mb-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-gray-700">
          👷 Affectation équipe
          {!hasEquipe && <span className="ml-2 text-xs text-gray-400 font-normal">— ajoute d&apos;abord tes membres dans /equipe</span>}
        </span>
        {savedAt && !dirty && <span className="text-[11px] text-green-600">✓ enregistré</span>}
      </div>

      {!isRetrait && (
        <div className="mb-3">
          <label className="block text-xs text-gray-500 mb-1">🚚 Chauffeur</label>
          <select
            value={chauffeurId}
            onChange={(e) => setChauffeurId(e.target.value)}
            className="w-full px-3 py-2 border rounded-lg text-sm bg-white"
            disabled={!hasEquipe}
          >
            <option value="">— non affecté —</option>
            {chauffeurs.map((m) => (
              <option key={m.id} value={m.id}>
                {m.nom}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="mb-3">
        <label className="block text-xs text-gray-500 mb-1">
          👷 Chef{chefEquipeIds.length > 1 ? "s" : ""} d&apos;équipe <span className="text-gray-400">({chefEquipeIds.length} sélectionné{chefEquipeIds.length > 1 ? "s" : ""})</span>
        </label>
        {chefs.length === 0 ? (
          <div className="text-xs text-gray-400 italic">Aucun chef enregistré</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {chefs.map((m) => {
              const on = chefEquipeIds.includes(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => toggleChef(m.id)}
                  className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                    on
                      ? "bg-blue-600 text-white border-blue-600"
                      : "border-gray-300 text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  {on ? "✓ " : ""}
                  {m.nom}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="mb-3">
        <label className="block text-xs text-gray-500 mb-1">
          📦 Préparateurs <span className="text-gray-400">({preparateurIds.length} sélectionné{preparateurIds.length > 1 ? "s" : ""})</span>
        </label>
        {preparateurs.length === 0 ? (
          <div className="text-xs text-gray-400 italic">Aucun préparateur enregistré</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {preparateurs.map((m) => {
              const on = preparateurIds.includes(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => togglePreparateur(m.id)}
                  className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                    on
                      ? "bg-orange-600 text-white border-orange-600"
                      : "border-gray-300 text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  {on ? "✓ " : ""}
                  {m.nom}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <label className="block text-xs text-gray-500 mb-1">
          🔧 Monteurs <span className="text-gray-400">({monteurIds.length} sélectionné{monteurIds.length > 1 ? "s" : ""})</span>
        </label>
        {monteurs.length === 0 ? (
          <div className="text-xs text-gray-400 italic">Aucun monteur enregistré</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {monteurs.map((m) => {
              const on = monteurIds.includes(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => toggleMonteur(m.id)}
                  className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                    on
                      ? "bg-emerald-600 text-white border-emerald-600"
                      : "border-gray-300 text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  {on ? "✓ " : ""}
                  {m.nom}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {error && <div className="mt-2 text-xs text-red-600 bg-red-50 rounded p-2">{error}</div>}

      <div className="mt-3 flex justify-end">
        <button
          onClick={save}
          disabled={!dirty || saving || !hasEquipe}
          className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "..." : "Enregistrer l'affectation"}
        </button>
      </div>
    </div>
  );
}

const FROM_EMAIL_RAPPEL = "velos-cargo@artisansverts.energy";
const DEPART_DEPOT_HEURE = 9; // 9h00 du matin
const FENETRE_HEURES = 2;

function fmtHM(totalMinutesFromMidnight: number): string {
  const h = Math.floor(totalMinutesFromMidnight / 60);
  const m = Math.round(totalMinutesFromMidnight % 60);
  return `${String(h).padStart(2, "0")}h${String(m).padStart(2, "0")}`;
}

// Arrondit au quart d'heure supérieur ou inférieur le plus proche de :00/:30
function roundDown30(min: number): number {
  return Math.floor(min / 30) * 30;
}
function roundUp30(min: number): number {
  return Math.ceil(min / 30) * 30;
}

function RappelVeilleModal({
  tournee,
  segments,
  monteurs,
  equipe,
  clientInfo,
  onClose,
}: {
  tournee: Tournee;
  segments: { distKm: number; trajetMin: number }[];
  monteurs: number;
  equipe: EquipeMember[];
  clientInfo: Map<string, ClientPoint>;
  onClose: () => void;
}) {
  // Calcule l'arrivée estimée à chaque arrêt en partant de 9h00 du dépôt
  // arrivée[i] = 9h00 + sum(trajets[0..i]) + sum(montages[0..i-1])
  // montage à un arrêt = nbVelos * MINUTES_PAR_VELO / monteurs
  const stops = useMemo(() => {
    const startMin = DEPART_DEPOT_HEURE * 60;
    let cumul = startMin;
    return tournee.livraisons.map((l, i) => {
      cumul += segments[i]?.trajetMin || 0;
      const arrivee = cumul;
      const montageStop = ((l.nbVelos || 0) * MINUTES_PAR_VELO) / Math.max(1, monteurs);
      cumul += montageStop;
      return {
        livraison: l,
        arriveeMin: arrivee,
        finStopMin: cumul,
      };
    });
  }, [tournee, segments, monteurs]);

  const dateObj = tournee.datePrevue ? new Date(tournee.datePrevue) : null;
  const dateLabel = dateObj
    ? dateObj.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
    : "";

  // Auto-coche tout par défaut, sauf clients sans email
  const [selected, setSelected] = useState<Set<string>>(() => {
    const s = new Set<string>();
    stops.forEach((st) => {
      const cid = st.livraison.clientId;
      const fullClient = cid ? clientInfo.get(cid) : null;
      if (fullClient?.email) s.add(st.livraison.id);
    });
    return s;
  });

  const apporteurEmailDe = (apporteurNom: string | null | undefined) => {
    const name = (apporteurNom || "").trim().toLowerCase();
    if (!name) return null;
    const match = equipe.find(
      (m) => m.role === "apporteur" && m.actif !== false && (m.nom || "").trim().toLowerCase() === name,
    );
    return match?.email || null;
  };

  const buildMail = (st: typeof stops[number]) => {
    const cid = st.livraison.clientId;
    const c = cid ? clientInfo.get(cid) : null;
    const nbVelos = st.livraison.nbVelos || 0;
    const debut = fmtHM(roundDown30(st.arriveeMin));
    const fin = fmtHM(roundUp30(st.arriveeMin + FENETRE_HEURES * 60));
    const subject = `Rappel livraison vélos cargo le ${dateObj ? dateObj.toLocaleDateString("fr-FR", { day: "numeric", month: "long" }) : ""} — fenêtre ${debut}-${fin}`;
    const body = [
      `Bonjour${c?.contact ? " " + c.contact : ""},`,
      ``,
      `Petit rappel : votre livraison de ${nbVelos} vélo${nbVelos > 1 ? "s" : ""} cargo est confirmée pour ${dateLabel}.`,
      ``,
      `Fenêtre de passage estimée : entre ${debut} et ${fin}.`,
      `Adresse : ${c?.adresse || ""}${c?.codePostal ? ", " + c.codePostal : ""}${c?.ville ? " " + c.ville : ""}.`,
      ``,
      `Merci de prévoir une personne sur place pour la réception et la signature du procès-verbal de livraison.`,
      `En cas d'imprévu (retard, fenêtre serrée, accès difficile), répondez à ce mail ou appelez-nous.`,
      ``,
      `Cordialement,`,
      `L'équipe Artisans Verts Energy`,
    ].join("\n");
    const apEmail = apporteurEmailDe(c?.apporteur || null);
    const ccParam = apEmail ? `&cc=${encodeURIComponent(apEmail)}` : "";
    return {
      to: c?.email || "",
      cc: apEmail,
      subject,
      body,
      url: `https://mail.google.com/mail/?authuser=${encodeURIComponent(FROM_EMAIL_RAPPEL)}&view=cm&fs=1&to=${encodeURIComponent(c?.email || "")}${ccParam}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
    };
  };

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const stopHasEmail = (st: typeof stops[number]) => {
    const cid = st.livraison.clientId;
    const c = cid ? clientInfo.get(cid) : null;
    return !!c?.email;
  };

  const ouvrirTous = () => {
    const aOuvrir = stops.filter((st) => selected.has(st.livraison.id) && stopHasEmail(st));
    aOuvrir.forEach((st, idx) => {
      const url = buildMail(st).url;
      // léger délai entre chaque ouverture pour que Chrome n'en bloque pas
      setTimeout(() => window.open(url, "_blank"), idx * 250);
    });
  };

  const nbASelectionner = stops.filter((st) => selected.has(st.livraison.id) && stopHasEmail(st)).length;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] p-4" onClick={(e) => e.stopPropagation()}>
      <div className="bg-white rounded-xl p-6 w-full max-w-3xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-4">
          <div>
            <h2 className="text-lg font-semibold">📧 Rappels veille de livraison</h2>
            <div className="text-sm text-gray-600">
              {dateLabel} · départ dépôt {DEPART_DEPOT_HEURE}h00 · fenêtre client {FENETRE_HEURES}h · {monteurs} monteur{monteurs > 1 ? "s" : ""}
            </div>
            <div className="text-xs text-gray-500 mt-1">
              De : <span className="font-mono">{FROM_EMAIL_RAPPEL}</span> · CC apporteur auto si rattaché
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="space-y-2 mb-4">
          {stops.map((st, i) => {
            const cid = st.livraison.clientId;
            const c = cid ? clientInfo.get(cid) : null;
            const debut = fmtHM(roundDown30(st.arriveeMin));
            const fin = fmtHM(roundUp30(st.arriveeMin + FENETRE_HEURES * 60));
            const apEmail = apporteurEmailDe(c?.apporteur || null);
            const checked = selected.has(st.livraison.id);
            const sansEmail = !c?.email;
            return (
              <div
                key={st.livraison.id}
                className={`border rounded-lg p-3 flex items-start gap-3 ${sansEmail ? "bg-red-50 border-red-200" : checked ? "bg-blue-50 border-blue-200" : "bg-white"}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={sansEmail}
                  onChange={() => toggle(st.livraison.id)}
                  className="mt-1 h-4 w-4"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="font-mono text-xs text-gray-400">{i + 1}.</span>
                    <span className="font-medium text-sm truncate">{c?.entreprise || st.livraison.client.entreprise}</span>
                    <span className="text-xs text-blue-700 whitespace-nowrap">{debut}–{fin}</span>
                    <span className="text-xs text-gray-400">· {st.livraison.nbVelos || 0}v</span>
                  </div>
                  {(c?.contact || c?.telephone) && (
                    <div className="text-xs text-gray-700 mt-0.5">
                      👤 {c?.contact || <span className="text-gray-400">contact non renseigné</span>}
                      {c?.telephone && <> · 📞 <a href={`tel:${c.telephone}`} className="text-blue-700 hover:underline">{c.telephone}</a></>}
                    </div>
                  )}
                  <div className="text-xs text-gray-600 mt-0.5 truncate">
                    {c?.email ? (
                      <>→ {c.email}</>
                    ) : (
                      <span className="text-red-700">⚠ pas d&apos;email — à compléter sur la fiche client</span>
                    )}
                    {apEmail && <> · <span className="text-amber-700">CC : {apEmail}</span></>}
                    {c?.apporteur && !apEmail && (
                      <> · <span className="text-gray-400" title={`Pas de membre Équipe rôle apporteur "${c.apporteur}" avec email`}>apporteur &quot;{c.apporteur}&quot; non rattaché</span></>
                    )}
                  </div>
                </div>
                <a
                  href={buildMail(st).url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`text-xs px-2 py-1 rounded ${sansEmail ? "bg-gray-200 text-gray-400 pointer-events-none" : "bg-gray-100 text-gray-700 hover:bg-gray-200"}`}
                >
                  Ouvrir
                </a>
              </div>
            );
          })}
        </div>

        <div className="border-t pt-3 flex items-center justify-between gap-3">
          <div className="text-xs text-gray-500">
            {nbASelectionner} mail{nbASelectionner > 1 ? "s" : ""} prêt{nbASelectionner > 1 ? "s" : ""} à ouvrir.
            Si Chrome bloque, autorise les pop-ups pour ce site.
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
            >
              Fermer
            </button>
            <button
              onClick={ouvrirTous}
              disabled={nbASelectionner === 0}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              📧 Ouvrir {nbASelectionner} rappel{nbASelectionner > 1 ? "s" : ""}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
