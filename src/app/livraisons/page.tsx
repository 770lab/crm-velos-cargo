"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { collection, doc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { gasGet, gasPost } from "@/lib/gas";
import { useData, type LivraisonRow, type EquipeMember, type ClientPoint, type EquipeRole } from "@/lib/data-context";
import { useCurrentUser } from "@/lib/current-user";
import { callGemini } from "@/lib/gemini-client";
import { openWhatsApp, tplValidationLivraison, tplBriefChauffeur } from "@/lib/whatsapp";
import DateLoadPicker, { type DayLoad } from "@/components/date-load-picker";
import AddClientModal from "@/components/add-client-modal";
import DayPlannerModal from "@/components/day-planner-modal";
// Yoann 2026-05-03 : édition session atelier au click depuis la card calendrier
import { SessionAtelierModal, PlanifierJourneeModal } from "@/app/entrepots/page";

import { BASE_PATH } from "@/lib/base-path";
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
  // Chauffeur = charge + livre uniquement. Si un même humain doit aussi
  // monter, on lui crée une 2e entrée dans /equipe avec role=monteur
  // (pas de double-rôle sur un seul compte, par design).
  chauffeur: new Set<StageKey>(["charge", "livre"]),
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
  /** Si non null, le bouton "Envoyer commande à AXDIS" a déjà été cliqué.
   *  Toutes les livraisons d'une tournée partagent la valeur (même write). */
  bonCommandeEnvoyeAt?: string | null;
}

// Une livraison appartient au user si celui-ci y est affecté selon son rôle.
// Admin/superadmin voit tout. Apporteur voit les livraisons des clients qu'il
// a apportés (jointure via clientApporteur === userName).
function livraisonMatchesUser(
  l: LivraisonRow,
  userId: string,
  role: EquipeRole,
  userName?: string,
  clientApporteur?: string | null,
  /** Yoann 2026-05-03 : pour un chef d équipe, on étend la visibilité aux
   *  tournées où l un de ses monteurs est affecté (pas juste où il est chef).
   *  Permet au chef de voir le planning complet de SES équipes. */
  mesMonteursIds?: string[],
): boolean {
  if (role === "admin" || role === "superadmin") return true;
  if (role === "apporteur") {
    // Filtre commercial : un apporteur ne voit QUE ses propres dossiers
    // (commissions sensibles cf. memory crm_velos_cargo_apporteurs).
    return !!(userName && clientApporteur && clientApporteur === userName);
  }
  switch (role) {
    case "chauffeur":
      return l.chauffeurId === userId;
    case "preparateur":
      return (l.preparateurIds || []).includes(userId);
    case "monteur":
      return (l.monteurIds || []).includes(userId);
    case "chef": {
      if (l.chefEquipeId === userId) return true;
      if ((l.chefEquipeIds || []).includes(userId)) return true;
      // Tournée où un de mes monteurs est affecté → je la vois aussi
      if (mesMonteursIds && mesMonteursIds.length > 0) {
        const monteurs = l.monteurIds || [];
        for (const mid of mesMonteursIds) {
          if (monteurs.includes(mid)) return true;
        }
      }
      return false;
    }
    default:
      return false;
  }
}

export default function LivraisonsPage() {
  const { livraisons, carte, equipe, refresh } = useData();
  const currentUser = useCurrentUser();
  // Map client.id → ClientPoint pour le brief journée (avoir adresse, tel,
  // apporteur facilement accessibles depuis l'extérieur de la TourneeModal).
  const clientInfo = useMemo(() => {
    const m = new Map<string, typeof carte[number]>();
    for (const c of carte) m.set(c.id, c);
    return m;
  }, [carte]);
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
  // Pré-remplissage du champ search depuis ?q= (utile depuis la fiche client
  // « 📅 Voir dans le planning ») — fait une seule fois au mount. Si ?clientId=
  // est aussi présent, on cible la tournée qui contient ce client (plus loin).
  const [pendingClientFocus, setPendingClientFocus] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    const q = sp.get("q");
    if (q) setSearch(q);
    const cid = sp.get("clientId");
    if (cid) setPendingClientFocus(cid);
  }, []);
  // Filtre admin par chauffeur : "" = tous, sinon id d'un membre équipe.
  // Inutile pour les rôles terrain (eux ne voient que leurs tournées via
  // userLivraisons ci-dessous). On expose le dropdown UNIQUEMENT pour admin.
  // Filtres intervenants (multi) : array de "chauffeur:<id>" / "chef:<id>" /
  // "monteur:<id>" / "preparateur:<id>" / "apporteur:<nomLower>". Une tournée
  // est visible si AU MOINS UN filtre matche. Permet de comparer visuellement
  // plusieurs charges (ex: ricky + ETHAN sur la même semaine).
  const [filtresIntervenants, setFiltresIntervenants] = useState<string[]>([]);
  // Yoann 2026-05-03 : carte entrepots (id -> nom) chargée pour le filtre
  // par entrepôt source. Pas dans data-context (pas utilisé ailleurs).
  const [entrepotsMap, setEntrepotsMap] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    const unsub = onSnapshot(collection(db, "entrepots"), (snap) => {
      const m = new Map<string, string>();
      for (const d of snap.docs) {
        const data = d.data() as { nom?: string; dateArchivage?: unknown };
        if (data.dateArchivage) continue;
        m.set(d.id, String(data.nom || d.id));
      }
      setEntrepotsMap(m);
    }, () => {
      // erreur permissions / réseau : pas grave, le filtre entrepôt sera vide
    });
    return () => unsub();
  }, []);
  // Compat : pour le chaînage des départs par chauffeur (ne s'active que si
  // un seul chauffeur est sélectionné).
  const filtreChauffeurId = (() => {
    const cs = filtresIntervenants.filter((f) => f.startsWith("chauffeur:"));
    return cs.length === 1 ? cs[0].slice("chauffeur:".length) : "";
  })();
  const [showAddClient, setShowAddClient] = useState(false);
  const [showPlanner, setShowPlanner] = useState(false);
  const [showBriefJour, setShowBriefJour] = useState(false);
  const [showFeuilleJour, setShowFeuilleJour] = useState(false);
  const [showWhatsAppClients, setShowWhatsAppClients] = useState(false);
  const [feuilleJourData, setFeuilleJourData] = useState<{ date: Date; chauffeurId: string } | null>(null);
  const [batchAxdis, setBatchAxdis] = useState<{ date: Date; tournees: Tournee[] } | null>(null);
  // Yoann 2026-05-03 : "+ Tournée" depuis /livraisons. Étape 1 = pick entrepôt,
  // étape 2 = PlanifierJourneeModal sur l entrepôt choisi.
  const [showPickEntrepot, setShowPickEntrepot] = useState(false);
  const [entrepotPourPlan, setEntrepotPourPlan] = useState<{ id: string; nom: string; stockCartons: number; stockVelosMontes: number; isFournisseur: boolean } | null>(null);

  useEffect(() => {
    refresh("livraisons");
    refresh("carte");
  }, [refresh]);

  // Filtrage des livraisons par utilisateur : chacun ne voit que ses dossiers.
  // Pendant l'hydratation (currentUser undefined), on n'affiche rien pour éviter
  // un flash où d'autres dossiers seraient brièvement visibles.
  // Pour le rôle apporteur, on a besoin de l'apporteur du client (pas dans
  // LivraisonRow) → jointure via la carte clients.
  const apporteurByClientId = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const c of carte) m.set(c.id, c.apporteur);
    return m;
  }, [carte]);
  // Yoann 2026-05-03 : pour le rôle chef, on calcule la liste des monteurs
  // sous lui (chefId === currentUser.id) pour étendre la visibilité aux
  // tournées où ils sont affectés.
  const mesMonteursIds = useMemo(() => {
    if (currentUser?.role !== "chef") return [] as string[];
    return equipe
      .filter((m) => m.role === "monteur" && m.chefId === currentUser.id && m.actif !== false)
      .map((m) => m.id);
  }, [currentUser?.role, currentUser?.id, equipe]);

  const userLivraisons = useMemo(() => {
    if (!currentUser) return [] as LivraisonRow[];
    return livraisons.filter((l) => {
      const apporteur = l.clientId ? apporteurByClientId.get(l.clientId) ?? null : null;
      return livraisonMatchesUser(l, currentUser.id, currentUser.role, currentUser.nom, apporteur, mesMonteursIds);
    });
  }, [livraisons, currentUser, apporteurByClientId, mesMonteursIds]);

  const tournees = useMemo(() => {
    const list = groupByTournee(userLivraisons);
    // Numérotation : on lit `tourneeNumero` PERSISTÉ sur les livraisons (champ
    // attribué une fois pour toutes à la création de la tournée). Si on annule
    // une tournée intermédiaire, les autres GARDENT leur numéro.
    // Fallback : pour les tournées sans tourneeNumero (avant migration), on
    // recalcule chronologiquement à partir du max existant + 1.
    let maxPersisted = 0;
    for (const t of list) {
      const persisted = t.livraisons.find((l) => l.tourneeNumero != null)?.tourneeNumero ?? null;
      if (persisted != null) {
        t.numero = persisted;
        if (persisted > maxPersisted) maxPersisted = persisted;
      }
    }
    const orphans = list.filter((t) => t.numero == null);
    orphans
      .sort((a, b) => {
        const da = a.datePrevue ? new Date(a.datePrevue).getTime() : Number.POSITIVE_INFINITY;
        const db = b.datePrevue ? new Date(b.datePrevue).getTime() : Number.POSITIVE_INFINITY;
        if (da !== db) return da - db;
        return String(a.tourneeId || "").localeCompare(String(b.tourneeId || ""));
      })
      .forEach((t, i) => { t.numero = maxPersisted + i + 1; });
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

  // Filtre admin "Chauffeur : X" — appliqué APRÈS le filtre recherche.
  // Une tournée appartient au chauffeur si la 1re livraison porte son id
  // (toutes les livraisons d'une même tournée partagent chauffeurId).
  // Liste des chauffeurs présents = ceux qui apparaissent dans les tournées
  // visibles après le filtre rôle utilisateur (userLivraisons).
  const chauffeursPresents = useMemo(() => {
    const ids = new Set<string>();
    for (const t of tournees) {
      const cid = t.livraisons[0]?.chauffeurId;
      if (cid) ids.add(cid);
    }
    return equipe
      .filter((m) => ids.has(m.id))
      .sort((a, b) => (a.nom || "").localeCompare(b.nom || ""));
  }, [tournees, equipe]);

  // Présence des autres intervenants dans les tournées visibles, pour le
  // dropdown filtre intervenant (= dynamique, ne propose que les noms qui
  // ont effectivement des tournées).
  const intervenantsPresents = useMemo(() => {
    const chefIds = new Set<string>();
    const monteurIds = new Set<string>();
    const prepIds = new Set<string>();
    const apporteursLower = new Set<string>();
    const entrepotIds = new Set<string>();
    for (const t of tournees) {
      const liv0 = t.livraisons[0];
      for (const id of liv0?.chefEquipeIds || []) chefIds.add(id);
      if (liv0?.chefEquipeId) chefIds.add(liv0.chefEquipeId);
      for (const id of liv0?.monteurIds || []) monteurIds.add(id);
      for (const id of liv0?.preparateurIds || []) prepIds.add(id);
      const eid = liv0?.entrepotOrigineId;
      if (eid) entrepotIds.add(eid);
      for (const l of t.livraisons) {
        const a = (l as { apporteurLower?: string }).apporteurLower;
        if (a) apporteursLower.add(a.toLowerCase());
      }
    }
    const filterByIds = (ids: Set<string>) =>
      equipe.filter((m) => ids.has(m.id)).sort((a, b) => (a.nom || "").localeCompare(b.nom || ""));
    const apporteurs = equipe
      .filter((m) => m.role === "apporteur" && apporteursLower.has((m.nom || "").trim().toLowerCase()))
      .sort((a, b) => (a.nom || "").localeCompare(b.nom || ""));
    const entrepots = Array.from(entrepotIds)
      .map((id) => ({ id, nom: entrepotsMap.get(id) || id }))
      .sort((a, b) => a.nom.localeCompare(b.nom));
    return {
      chefs: filterByIds(chefIds),
      monteurs: filterByIds(monteurIds),
      preparateurs: filterByIds(prepIds),
      apporteurs,
      entrepots,
    };
  }, [tournees, equipe, entrepotsMap]);

  const chauffeurFilteredTournees = useMemo(() => {
    if (filtresIntervenants.length === 0) return filteredTournees;
    const matchOne = (t: Tournee, filter: string) => {
      const [role, key] = filter.split(":");
      const liv0 = t.livraisons[0];
      switch (role) {
        case "chauffeur":
          return liv0?.chauffeurId === key;
        case "chef":
          return (liv0?.chefEquipeIds || []).includes(key) || liv0?.chefEquipeId === key;
        case "monteur":
          return (liv0?.monteurIds || []).includes(key);
        case "preparateur":
          return (liv0?.preparateurIds || []).includes(key);
        case "apporteur":
          return t.livraisons.some(
            (l) => ((l as { apporteurLower?: string }).apporteurLower || "").toLowerCase() === key,
          );
        case "entrepot":
          return liv0?.entrepotOrigineId === key;
        default:
          return false;
      }
    };
    // OR : la tournée est visible si AU MOINS UN filtre matche.
    return filteredTournees.filter((t) => filtresIntervenants.some((f) => matchOne(t, f)));
  }, [filteredTournees, filtresIntervenants]);

  // Chaînage des départs par chauffeur. Quand un chauffeur a 2+ tournées
  // dans la même journée (ex Armel le 4 mai), T2 ne peut PAS démarrer à 8h30
  // comme T1 — il faut attendre que T1 soit finie + 30 min de rechargement.
  // Sans ça, mes calculs computeArrivalTimes affichent T1 et T2 du même
  // chauffeur démarrant à la même heure (incohérent — cf. retour Yoann
  // 29-04 02h23). On chaîne par tourneeNumero ascendant (= ordre de création
  // qui reflète l'ordre Gemini).
  const tourneeDepartures = useMemo(() => {
    const result = new Map<string, { min: number; max: number }>();
    const byDayDriver = new Map<string, Tournee[]>();
    for (const t of chauffeurFilteredTournees) {
      if (!t.datePrevue) continue;
      // Tournée annulée → ne compte pas dans le chaînage. Sinon T3 d'Armel
      // resterait positionnée à 20h même après annulation de T2 (Yoann 29-04
      // 02h41 : "si j'annule, ça recalcule tout seul ?"). Réponse oui MAIS
      // il faut exclure les annulées d'abord.
      if (t.statutGlobal === "annulee") continue;
      const cid = t.livraisons[0]?.chauffeurId;
      if (!cid) continue; // pas de chaînage sans chauffeur (retraits, non assignés)
      const day = isoDate(t.datePrevue);
      const key = `${day}|${cid}`;
      if (!byDayDriver.has(key)) byDayDriver.set(key, []);
      byDayDriver.get(key)!.push(t);
    }
    for (const ts of byDayDriver.values()) {
      ts.sort((a, b) => (a.numero || 0) - (b.numero || 0));
      let curMin = DEPART_MIN_DEFAULT;
      let curMax = DEPART_MAX_DEFAULT;
      for (const t of ts) {
        // Heure de départ custom posée sur la tournée. Si présente, on
        // FORCE curMin/curMax à cette heure (peut être plus tôt OU plus tard
        // que le défaut 8h30 — bug 2026-04-29 où Math.max empêchait de
        // descendre sous 8h30).
        const customHM = t.livraisons[0]?.heureDepartTournee;
        if (customHM && /^\d{2}:\d{2}$/.test(customHM)) {
          const [hh, mm] = customHM.split(":").map((n) => parseInt(n, 10));
          const minOfDay = hh * 60 + mm;
          curMin = minOfDay;
          curMax = minOfDay + 30;
        }
        const tourneeKey = (t.tourneeId || "no-tid") + "|" + (t.datePrevue ? isoDate(t.datePrevue) : "");
        result.set(tourneeKey, { min: curMin, max: curMax });
        const monteurs = t.nbMonteurs > 0 ? t.nbMonteurs : MONTEURS_PAR_EQUIPE;
        // estimateDureeChauffeur (vs estimateTourneeMinutes) : ne compte pas
        // le montage du dernier client. Le chauffeur file au dépôt dès le
        // déchargement, l'équipe reste sur place pour finir le montage +
        // pause. Yoann 29-04 02h46.
        const dureeMin = estimateDureeChauffeur(t, monteurs);
        // La pause déjeuner du chauffeur est implicitement prise pendant son
        // trajet retour ou au dépôt avant T2. On ne l'ajoute donc PAS au
        // chaînage (sinon double-comptage). Si T2 traverse midi à son tour,
        // computeArrivalTimes décalera ses arrêts post-midi de 45 min.
        curMin += dureeMin + 30; // 30 min recharge dépôt avant T2
        curMax += dureeMin + 30;
      }
    }
    return result;
  }, [chauffeurFilteredTournees]);

  // Auto-navigation : quand une recherche filtre, naviguer à la date de la première tournée trouvée
  useEffect(() => {
    if (!searchQuery || filteredTournees.length === 0) return;
    const first = filteredTournees.find((t) => t.datePrevue);
    if (first?.datePrevue) {
      setRefDate(new Date(first.datePrevue));
    }
  }, [searchQuery, filteredTournees]);

  // Si on arrive depuis la fiche client (?clientId=...), trouver la tournée
  // PROCHAINE à venir qui contient ce client + ouvrir la modale + scroller à
  // la card du client. Préfère statut planifiee à venir, sinon dernière en
  // date toutes statuts confondus (au cas où le client a déjà été livré).
  useEffect(() => {
    if (!pendingClientFocus || tournees.length === 0) return;
    const now = Date.now();
    const candidates = tournees.filter((t) =>
      t.livraisons.some((l) => l.clientId === pendingClientFocus),
    );
    if (candidates.length === 0) return;
    const upcoming = candidates
      .filter((t) => t.datePrevue && new Date(t.datePrevue).getTime() >= now - 24 * 3600 * 1000)
      .sort((a, b) => (a.datePrevue && b.datePrevue ? new Date(a.datePrevue).getTime() - new Date(b.datePrevue).getTime() : 0));
    const past = candidates
      .filter((t) => !upcoming.includes(t))
      .sort((a, b) => (a.datePrevue && b.datePrevue ? new Date(b.datePrevue).getTime() - new Date(a.datePrevue).getTime() : 0));
    const target = upcoming[0] || past[0];
    if (target?.datePrevue) setRefDate(new Date(target.datePrevue));
    setOpenTournee(target);
    // pendingClientFocus reste set ; la 2e useEffect (scroll) le clear.
  }, [pendingClientFocus, tournees]);

  // Scroll auto vers la card du client ciblé une fois la modale ouverte.
  // L'id `liv-card-<clientId>` est posé sur chaque card dans la modale.
  useEffect(() => {
    if (!openTournee || !pendingClientFocus) return;
    // Laisse à React le temps de rendre la modale
    const tid = setTimeout(() => {
      const el = document.getElementById(`liv-card-${pendingClientFocus}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("ring-2", "ring-blue-400");
        setTimeout(() => el.classList.remove("ring-2", "ring-blue-400"), 2000);
      }
      setPendingClientFocus(null);
    }, 400);
    return () => clearTimeout(tid);
  }, [openTournee, pendingClientFocus]);

  useEffect(() => {
    if (!openTournee) return;
    const key = (t: Tournee) => (t.tourneeId || "") + "|" + (t.datePrevue ? isoDate(t.datePrevue) : "no-date");
    const target = key(openTournee);
    setOpenTournee(filteredTournees.find((t) => key(t) === target) || tournees.find((t) => key(t) === target) || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tournees]);
  // Sessions atelier (Yoann 2026-05-01) : chargées au niveau LivraisonsPage
  // pour les afficher sur le calendrier + dans le bandeau monteur.
  type SessionAtelierMini = {
    id: string;
    date: string;
    heureDebut?: string | null;
    heureFin?: string | null;
    entrepotId: string;
    entrepotNom: string;
    monteurIds: string[];
    monteurNoms: string[];
    chefId?: string | null;
    chefNom?: string | null;
    chefAdminTerrainId?: string | null;
    chefAdminTerrainNom?: string | null;
    tourneeIds?: string[];
    tourneeNumeros?: number[];
    quantitePrevue?: number | null;
    statut: "planifiee" | "en_cours" | "terminee" | "annulee";
  };
  const [sessionsAtelier, setSessionsAtelier] = useState<SessionAtelierMini[]>([]);
  useEffect(() => {
    // Yoann 2026-05-03 : RBAC apporteur — sessionsMontageAtelier est
    // bloqué pour les apporteurs côté rules. On skip le onSnapshot pour
    // éviter "Missing permissions" + cacher la card côté UI (interne
    // logistique, pas du métier apporteur).
    if (currentUser?.role === "apporteur") return;
    const unsub = onSnapshot(collection(db, "sessionsMontageAtelier"), (snap) => {
      const rows: SessionAtelierMini[] = [];
      for (const d of snap.docs) {
        const data = d.data();
        rows.push({
          id: d.id,
          date: String(data.date || ""),
          heureDebut: typeof data.heureDebut === "string" ? data.heureDebut : null,
          heureFin: typeof data.heureFin === "string" ? data.heureFin : null,
          entrepotId: String(data.entrepotId || ""),
          entrepotNom: String(data.entrepotNom || "?"),
          monteurIds: Array.isArray(data.monteurIds) ? data.monteurIds : [],
          monteurNoms: Array.isArray(data.monteurNoms) ? data.monteurNoms : [],
          chefId: typeof data.chefId === "string" ? data.chefId : null,
          chefNom: typeof data.chefNom === "string" ? data.chefNom : null,
          chefAdminTerrainId: typeof data.chefAdminTerrainId === "string" ? data.chefAdminTerrainId : null,
          chefAdminTerrainNom: typeof data.chefAdminTerrainNom === "string" ? data.chefAdminTerrainNom : null,
          tourneeIds: Array.isArray(data.tourneeIds) ? data.tourneeIds : [],
          tourneeNumeros: Array.isArray(data.tourneeNumeros) ? data.tourneeNumeros : [],
          quantitePrevue: typeof data.quantitePrevue === "number" ? data.quantitePrevue : null,
          statut: ["en_cours", "terminee", "annulee"].includes(data.statut)
            ? data.statut
            : "planifiee",
        });
      }
      setSessionsAtelier(rows);
    });
    return () => unsub();
  }, [currentUser?.role]);
  const sessionsByDate = useMemo(() => {
    const m = new Map<string, SessionAtelierMini[]>();
    // Yoann 2026-05-03 : pour un chef d équipe, on filtre les sessions
    // atelier visibles à celles où au moins un de ses monteurs est
    // dans monteurIds (ou s il est lui-même chef de la session).
    const isChef = currentUser?.role === "chef";
    const mesIds = new Set(mesMonteursIds);
    for (const s of sessionsAtelier) {
      if (s.statut === "annulee") continue;
      if (!s.date) continue;
      if (isChef) {
        const isMine =
          s.chefId === currentUser?.id ||
          (s.monteurIds || []).some((id) => mesIds.has(id));
        if (!isMine) continue;
      }
      if (!m.has(s.date)) m.set(s.date, []);
      m.get(s.date)!.push(s);
    }
    return m;
  }, [sessionsAtelier, currentUser?.role, currentUser?.id, mesMonteursIds]);

  const tourneesByDate = useMemo(() => {
    const map = new Map<string, Tournee[]>();
    for (const t of chauffeurFilteredTournees) {
      if (!t.datePrevue) continue;
      const key = isoDate(t.datePrevue);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    }
    // Tri des tournées dans chaque colonne jour :
    //   1. Retraits TOUJOURS en haut (Yoann 29-04 02h13) — ils ouvrent la
    //      journée pour libérer rapidement le dépôt.
    //   2. Ensuite par HEURE DE DÉPART EFFECTIVE (Yoann 29-04 02h32) :
    //      du matin vers le soir. Pour les tournées chaînées d'un même
    //      chauffeur, T2 et T3 apparaissent donc plus bas dans la colonne.
    for (const arr of map.values()) {
      arr.sort((a, b) => {
        const ar = a.mode === "retrait" ? 0 : 1;
        const br = b.mode === "retrait" ? 0 : 1;
        if (ar !== br) return ar - br;
        const da = tourneeDepartures.get(tourneeKeyForDeparture(a))?.min ?? DEPART_MIN_DEFAULT;
        const db = tourneeDepartures.get(tourneeKeyForDeparture(b))?.min ?? DEPART_MIN_DEFAULT;
        return da - db;
      });
    }
    return map;
  }, [chauffeurFilteredTournees, tourneeDepartures]);

  const livraisonsSansDate = userLivraisons.filter((l) => !l.datePrevue);

  // Tournees dans la fenetre de la vue active. Sert au compteur d'objectifs :
  // un monteur en vue Jour veut savoir combien de velos il a a monter aujourd'hui,
  // pas sur tout le mois.
  const windowedTournees = useMemo(() => {
    if (view === "liste") return chauffeurFilteredTournees;
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
    return chauffeurFilteredTournees.filter((t) => {
      if (!t.datePrevue) return false;
      const d = new Date(t.datePrevue);
      return d >= start && d < end;
    });
  }, [chauffeurFilteredTournees, view, refDate]);

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
    // Demande Yoann 2026-05-01 : ajouter le nb de vélos au sous-titre pour
    // avoir le volume en un coup d'œil (la métrique business critique = vélos
    // livrés, pas livraisons).
    const totalLivraisonsAll = userLivraisons.length;
    const totalVelosAll = userLivraisons.reduce((s, l) => s + (l._count?.velos ?? l.nbVelos ?? 0), 0);
    pageSubtitle = view === "liste"
      ? `${chauffeurFilteredTournees.length} tournée${chauffeurFilteredTournees.length > 1 ? "s" : ""} · ${totalLivraisonsAll} livraison${totalLivraisonsAll > 1 ? "s" : ""} · ${totalVelosAll} vélo${totalVelosAll > 1 ? "s" : ""}`
      : `${windowedTournees.length} tournée${windowedTournees.length > 1 ? "s" : ""} · ${windowedLivraisons} livraison${windowedLivraisons > 1 ? "s" : ""} · ${windowedVelos} vélo${windowedVelos > 1 ? "s" : ""}${windowSuffix ? " " + windowSuffix : ""}`;
  }

  const isApporteurReadOnly = currentUser?.role === "apporteur";

  return (
    <TourneeDeparturesContext.Provider value={tourneeDepartures}>
    <div>
      {isApporteurReadOnly && (
        <div className="mb-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-900">
          👁 <strong>Mode lecture seule</strong> — vous consultez vos dossiers ; toute modification est désactivée.
        </div>
      )}
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
                onClick={() => setShowBriefJour(true)}
                className="px-3 py-1.5 bg-purple-100 text-purple-800 border border-purple-300 rounded-lg hover:bg-purple-200 text-sm font-medium whitespace-nowrap"
                title="Génère un brief texte de toutes les tournées du jour visible (à copier dans WhatsApp/mail)"
              >
                📋 Brief du jour
              </button>
              <button
                onClick={() => setShowWhatsAppClients(true)}
                className="px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-medium whitespace-nowrap"
                title="Liste des clients du jour avec bouton WhatsApp pour leur envoyer un rappel"
              >
                📱 WhatsApp clients
              </button>
              <BLFranckBatchBtn tournees={chauffeurFilteredTournees} />
              <button
                onClick={() => setShowFeuilleJour(true)}
                className="px-3 py-1.5 bg-blue-100 text-blue-800 border border-blue-300 rounded-lg hover:bg-blue-200 text-sm font-medium whitespace-nowrap"
                title="Imprime une feuille de route consolidée par chauffeur (toutes ses tournées de la journée enchaînées)"
              >
                📄 Feuille de route chauffeur
              </button>
              <button
                onClick={() => setShowPickEntrepot(true)}
                className="px-3 py-1.5 bg-emerald-700 text-white rounded-lg hover:bg-emerald-800 text-sm font-medium whitespace-nowrap"
                title="Ajouter une tournée directement depuis le planning (sans changer de page)"
              >
                + Tournée
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
          {/* Filtre intervenant — admin/superadmin uniquement. Permet de voir
              le planning du point de vue d'un chauffeur, chef, monteur,
              préparateur ou apporteur (= valider/optimiser). Les rôles
              terrain ont déjà leur filtrage via userLivraisons. */}
          {(currentUser?.role === "admin" || currentUser?.role === "superadmin") && (
            chauffeursPresents.length > 0 ||
            intervenantsPresents.chefs.length > 0 ||
            intervenantsPresents.monteurs.length > 0 ||
            intervenantsPresents.preparateurs.length > 0 ||
            intervenantsPresents.apporteurs.length > 0 ||
            intervenantsPresents.entrepots.length > 0
          ) && (
            <MultiIntervenantSelect
              value={filtresIntervenants}
              onChange={setFiltresIntervenants}
              groups={[
                { label: "🚐 Chauffeurs", role: "chauffeur", options: chauffeursPresents.map((c) => ({ key: c.id, label: c.nom })) },
                { label: "🚦 Chefs d'équipe", role: "chef", options: intervenantsPresents.chefs.map((c) => ({ key: c.id, label: c.nom })) },
                { label: "🔧 Monteurs", role: "monteur", options: intervenantsPresents.monteurs.map((m) => ({ key: m.id, label: m.nom })) },
                { label: "📦 Préparateurs", role: "preparateur", options: intervenantsPresents.preparateurs.map((p) => ({ key: p.id, label: p.nom })) },
                { label: "🤝 Apporteurs", role: "apporteur", options: intervenantsPresents.apporteurs.map((a) => ({ key: (a.nom || "").trim().toLowerCase(), label: a.nom })) },
                { label: "🏬 Entrepôts source", role: "entrepot", options: intervenantsPresents.entrepots.map((e) => ({ key: e.id, label: e.nom })) },
              ]}
            />
          )}
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

      {currentUser?.id && currentUser?.role === "monteur" && (
        <SessionsAtelierBanner monteurId={currentUser.id} />
      )}

      {view === "jour" && (
        <DayView
          refDate={refDate}
          tourneesByDate={tourneesByDate}
          sessionsByDate={sessionsByDate}
          onOpen={setOpenTournee}
          onBatchAxdis={(d, ts) => setBatchAxdis({ date: d, tournees: ts })}
          canBatchAxdis={currentUser?.role !== "chef" && currentUser?.role !== "apporteur"}
        />
      )}
      {view === "3jours" && (
        <MultiDayView
          refDate={refDate}
          tourneesByDate={tourneesByDate}
          sessionsByDate={sessionsByDate}
          onOpen={setOpenTournee}
          nbDays={3}
          onBatchAxdis={(d, ts) => setBatchAxdis({ date: d, tournees: ts })}
          canBatchAxdis={currentUser?.role !== "chef" && currentUser?.role !== "apporteur"}
        />
      )}
      {view === "semaine" && (
        <WeekView
          refDate={refDate}
          tourneesByDate={tourneesByDate}
          sessionsByDate={sessionsByDate}
          onOpen={setOpenTournee}
          onBatchAxdis={(d, ts) => setBatchAxdis({ date: d, tournees: ts })}
          canBatchAxdis={currentUser?.role !== "chef" && currentUser?.role !== "apporteur"}
        />
      )}
      {view === "mois" && (
        <MonthView refDate={refDate} tourneesByDate={tourneesByDate} sessionsByDate={sessionsByDate} onOpen={setOpenTournee} />
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
      {/* Yoann 2026-05-03 — étape 1 du "+ Tournée" : choisir l entrepôt
          de départ. La liste se charge depuis Firestore. Click → ouvre
          PlanifierJourneeModal sur l entrepôt sélectionné. */}
      {showPickEntrepot && (
        <PickEntrepotModal
          onClose={() => setShowPickEntrepot(false)}
          onPick={(e) => {
            setEntrepotPourPlan(e);
            setShowPickEntrepot(false);
          }}
        />
      )}
      {entrepotPourPlan && (
        <PlanifierJourneeModal
          entrepotId={entrepotPourPlan.id}
          entrepotNom={entrepotPourPlan.nom}
          stockCartons={entrepotPourPlan.stockCartons}
          stockVelosMontes={entrepotPourPlan.stockVelosMontes}
          isFournisseur={entrepotPourPlan.isFournisseur}
          onClose={() => {
            setEntrepotPourPlan(null);
            refresh("livraisons");
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
      {batchAxdis && (
        <BatchAxdisModal
          date={batchAxdis.date}
          tournees={batchAxdis.tournees}
          onClose={() => setBatchAxdis(null)}
          onChanged={() => refresh("livraisons")}
        />
      )}
      {showBriefJour && (
        <BriefJourneeModal
          refDate={refDate}
          tournees={chauffeurFilteredTournees}
          equipe={equipe}
          clientInfo={clientInfo}
          tourneeDepartures={tourneeDepartures}
          sessionsAtelier={sessionsAtelier}
          onClose={() => setShowBriefJour(false)}
        />
      )}
      {showWhatsAppClients && (
        <WhatsAppClientsModal
          refDate={refDate}
          tournees={chauffeurFilteredTournees}
          clientInfo={clientInfo}
          tourneeDepartures={tourneeDepartures}
          equipe={equipe}
          onClose={() => setShowWhatsAppClients(false)}
        />
      )}
      {showFeuilleJour && !feuilleJourData && (
        <FeuilleJourChooserModal
          refDate={refDate}
          tournees={chauffeurFilteredTournees}
          equipe={equipe}
          onChoose={(date, chauffeurId) => setFeuilleJourData({ date, chauffeurId })}
          onClose={() => setShowFeuilleJour(false)}
        />
      )}
      {feuilleJourData && (
        <FeuilleDeRouteJournee
          date={feuilleJourData.date}
          chauffeurId={feuilleJourData.chauffeurId}
          tournees={chauffeurFilteredTournees}
          equipe={equipe}
          clientInfo={clientInfo}
          tourneeDepartures={tourneeDepartures}
          onBack={() => { setFeuilleJourData(null); setShowFeuilleJour(false); }}
        />
      )}
    </div>
    </TourneeDeparturesContext.Provider>
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
// Yoann 2026-05-01 : type partagé entre MonthView/WeekView/DayView/MultiDayView.
// Auparavant MonthView seul rendait les sessions atelier en cards orange.
type SessionAtelierItem = {
  id: string;
  entrepotId: string;
  entrepotNom: string;
  statut: string;
  heureDebut?: string | null;
  heureFin?: string | null;
  quantitePrevue?: number | null;
  monteurNoms: string[];
  tourneeNumeros?: number[];
};
type SessionsByDate = Map<string, SessionAtelierItem[]>;

function SessionAtelierCard({ s }: { s: SessionAtelierItem }) {
  // Yoann 2026-05-03 : click pour ouvrir le modal d édition (gérer monteurs,
  // chef, statut, quantité, notes). Le modal est exporté depuis /entrepots
  // (mode édition via existingSessionId).
  const [showEdit, setShowEdit] = useState(false);
  // Format créneau "HH:MM-HH:MM" → "HhMM-HhMM" pour cohérence affichage tournée.
  const fmtH = (s: string | null | undefined): string => {
    if (!s) return "";
    const m = /^(\d{2}):(\d{2})$/.exec(s);
    if (!m) return s;
    const h = parseInt(m[1], 10);
    const mn = m[2];
    return `${h}h${mn === "00" ? "" : mn}`;
  };
  const creneau = (() => {
    if (s.heureDebut && s.heureFin) return `${fmtH(s.heureDebut)}-${fmtH(s.heureFin)}`;
    if (s.heureDebut) return `dès ${fmtH(s.heureDebut)}`;
    if (s.heureFin) return `jusqu'à ${fmtH(s.heureFin)}`;
    return "";
  })();
  return (
    <>
    <div
      role="button"
      onClick={(e) => { e.stopPropagation(); setShowEdit(true); }}
      className="bg-amber-50 border border-amber-300 rounded px-1.5 py-1 text-[10px] leading-tight cursor-pointer hover:bg-amber-100 hover:border-amber-400"
      title={`Atelier ${s.entrepotNom}${creneau ? ` · ${creneau}` : ""} · ${s.monteurNoms.length} monteurs : ${s.monteurNoms.join(", ")} — clique pour gérer`}
    >
      <div className="font-semibold text-amber-900 truncate">
        🔧 Atelier {s.entrepotNom}
        {creneau && <span className="ml-1 font-normal opacity-90">· {creneau}</span>}
      </div>
      <div className="text-amber-700 opacity-80 truncate">
        {s.monteurNoms.length} monteur{s.monteurNoms.length > 1 ? "s" : ""}
        {s.quantitePrevue ? ` · ${s.quantitePrevue}v` : ""}
      </div>
      {s.tourneeNumeros && s.tourneeNumeros.length > 0 && (
        <div className="text-amber-800 opacity-90 truncate">
          → T{s.tourneeNumeros.join(", T")}
        </div>
      )}
    </div>
    {showEdit && (
      <SessionAtelierModal
        entrepotId={s.entrepotId}
        entrepotNom={s.entrepotNom}
        existingSessionId={s.id}
        onClose={() => setShowEdit(false)}
      />
    )}
    </>
  );
}

function DayView({
  refDate,
  tourneesByDate,
  sessionsByDate,
  onOpen,
  onBatchAxdis,
  canBatchAxdis = true,
}: {
  refDate: Date;
  tourneesByDate: Map<string, Tournee[]>;
  sessionsByDate?: SessionsByDate;
  onOpen: (t: Tournee) => void;
  onBatchAxdis: (date: Date, tournees: Tournee[]) => void;
  canBatchAxdis?: boolean;
}) {
  const iso = isoDate(refDate);
  const list = tourneesByDate.get(iso) || [];
  const sessions = sessionsByDate?.get(iso) || [];
  const today = isoDate(new Date());
  const isToday = iso === today;

  return (
    <div className="bg-white rounded-xl border overflow-hidden">
      <div className={`px-4 py-3 border-b flex items-start justify-between gap-2 ${isToday ? "bg-blue-50 text-blue-800" : "bg-gray-50 text-gray-700"}`}>
        <div>
          <div className="text-sm font-medium capitalize">
            {refDate.toLocaleDateString("fr-FR", { weekday: "long" })}
          </div>
          <div className="text-2xl font-bold">
            {refDate.getDate()}{" "}
            <span className="text-base font-normal text-gray-500 capitalize">
              {refDate.toLocaleDateString("fr-FR", { month: "long" })}
            </span>
          </div>
          {list.length > 0 && (() => {
            const nbVelos = list.reduce((sum, t) => sum + (t.totalVelos || 0), 0);
            return nbVelos > 0 ? (
              <div className="text-sm font-semibold mt-0.5">
                🚲 {nbVelos} vélo{nbVelos > 1 ? "s" : ""}
              </div>
            ) : null;
          })()}
        </div>
        {canBatchAxdis && list.length > 0 && (() => {
          const allSent = list.every((t) => !!t.bonCommandeEnvoyeAt);
          return (
            <button
              onClick={() => onBatchAxdis(new Date(refDate), list)}
              className={`self-center px-3 py-1.5 text-xs rounded-lg whitespace-nowrap text-white ${
                allSent ? "bg-emerald-600 hover:bg-emerald-700" : "bg-amber-600 hover:bg-amber-700"
              }`}
              title={
                allSent
                  ? `Les ${list.length} commandes AXDIS ont déjà été envoyées · clique pour renvoyer`
                  : `Envoyer les ${list.length} commandes AXDIS du jour (1 mail par tournée)`
              }
            >
              {allSent ? "✅" : "📧"} {list.length} commande{list.length > 1 ? "s" : ""} AXDIS
            </button>
          );
        })()}
      </div>
      <div className="p-3 space-y-2 min-h-[40vh]">
        {list.length === 0 && sessions.length === 0 && (
          <div className="text-sm text-gray-400 italic text-center py-8">Aucune tournée ni session atelier ce jour-là.</div>
        )}
        {/* Yoann 2026-05-03 : sessions atelier TOUJOURS en haut de la colonne
            (avant les tournées) pour visibilité immédiate du montage planifié. */}
        {sessions.length > 0 && (
          <div className="space-y-1 pb-2 mb-2 border-b border-amber-200">
            <div className="text-[11px] font-semibold text-amber-900 mb-1">
              🔧 {sessions.length} session{sessions.length > 1 ? "s" : ""} atelier
            </div>
            {sessions.map((s) => <SessionAtelierCard key={s.id} s={s} />)}
          </div>
        )}
        {list.map((t) => (
          <TourneeCard key={t.tourneeId || t.livraisons[0].id} tournee={t} onClick={() => onOpen(t)} />
        ))}
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
  sessionsByDate,
  onOpen,
  nbDays,
  onBatchAxdis,
  canBatchAxdis = true,
}: {
  refDate: Date;
  tourneesByDate: Map<string, Tournee[]>;
  sessionsByDate?: SessionsByDate;
  onOpen: (t: Tournee) => void;
  nbDays: number;
  onBatchAxdis: (date: Date, tournees: Tournee[]) => void;
  canBatchAxdis?: boolean;
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
          const list = tourneesByDate.get(iso) || [];
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
              {list.length > 0 && (() => {
                // Total vélos du jour = somme des vélos de toutes les tournées
                // de la colonne. Demande Yoann 2026-05-01 : volume jour visible
                // direct (le client demande "j'ai combien de vélos demain").
                const nbVelos = list.reduce((sum, t) => sum + (t.totalVelos || 0), 0);
                const allSent = list.every((t) => !!t.bonCommandeEnvoyeAt);
                return (
                  <>
                    {nbVelos > 0 && (
                      <div className="mt-1 text-[11px] font-semibold text-gray-700">
                        🚲 {nbVelos} vélo{nbVelos > 1 ? "s" : ""}
                      </div>
                    )}
                    {canBatchAxdis && (
                    <button
                      onClick={() => onBatchAxdis(new Date(d), list)}
                      className={`mt-1 w-full px-1.5 py-0.5 text-[10px] text-white rounded ${
                        allSent ? "bg-emerald-600 hover:bg-emerald-700" : "bg-amber-600 hover:bg-amber-700"
                      }`}
                      title={allSent ? `Déjà envoyées · clique pour renvoyer` : `Envoyer les ${list.length} commandes AXDIS de ce jour`}
                    >
                      {allSent ? "✅" : "📧"} {list.length} AXDIS
                    </button>
                    )}
                  </>
                );
              })()}
            </div>
          );
        })}
      </div>
      <div className={`grid ${colsClass} min-h-[60vh]`}>
        {days.map((d) => {
          const iso = isoDate(d);
          const list = tourneesByDate.get(iso) || [];
          const sessions = sessionsByDate?.get(iso) || [];
          return (
            <div key={iso} className="border-r last:border-r-0 p-2 space-y-1.5">
              {list.length === 0 && sessions.length === 0 && <div className="text-[11px] text-gray-300">—</div>}
              {/* Sessions atelier en haut (Yoann 2026-05-03) */}
              {sessions.map((s) => <SessionAtelierCard key={s.id} s={s} />)}
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
  sessionsByDate,
  onOpen,
  onBatchAxdis,
  canBatchAxdis = true,
}: {
  refDate: Date;
  tourneesByDate: Map<string, Tournee[]>;
  sessionsByDate?: SessionsByDate;
  onOpen: (t: Tournee) => void;
  onBatchAxdis: (date: Date, tournees: Tournee[]) => void;
  canBatchAxdis?: boolean;
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
          const list = tourneesByDate.get(iso) || [];
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
              {list.length > 0 && (() => {
                // Total vélos du jour = somme des vélos de toutes les tournées
                // de la colonne. Demande Yoann 2026-05-01 : volume jour visible
                // direct (le client demande "j'ai combien de vélos demain").
                const nbVelos = list.reduce((sum, t) => sum + (t.totalVelos || 0), 0);
                const allSent = list.every((t) => !!t.bonCommandeEnvoyeAt);
                return (
                  <>
                    {nbVelos > 0 && (
                      <div className="mt-1 text-[11px] font-semibold text-gray-700">
                        🚲 {nbVelos} vélo{nbVelos > 1 ? "s" : ""}
                      </div>
                    )}
                    {canBatchAxdis && (
                    <button
                      onClick={() => onBatchAxdis(new Date(d), list)}
                      className={`mt-1 w-full px-1.5 py-0.5 text-[10px] text-white rounded ${
                        allSent ? "bg-emerald-600 hover:bg-emerald-700" : "bg-amber-600 hover:bg-amber-700"
                      }`}
                      title={allSent ? `Déjà envoyées · clique pour renvoyer` : `Envoyer les ${list.length} commandes AXDIS de ce jour`}
                    >
                      {allSent ? "✅" : "📧"} {list.length} AXDIS
                    </button>
                    )}
                  </>
                );
              })()}
            </div>
          );
        })}
      </div>
      <div className="grid grid-cols-7 min-h-[60vh]">
        {days.map((d) => {
          const iso = isoDate(d);
          const list = tourneesByDate.get(iso) || [];
          const sessions = sessionsByDate?.get(iso) || [];
          return (
            <div key={iso} className="border-r last:border-r-0 p-2 space-y-1.5">
              {list.length === 0 && sessions.length === 0 && <div className="text-[11px] text-gray-300">—</div>}
              {/* Sessions atelier en haut (Yoann 2026-05-03) */}
              {sessions.map((s) => <SessionAtelierCard key={s.id} s={s} />)}
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
  sessionsByDate,
  onOpen,
}: {
  refDate: Date;
  tourneesByDate: Map<string, Tournee[]>;
  sessionsByDate?: SessionsByDate;
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
              {/* Sessions atelier en haut (Yoann 2026-05-03) */}
              {sessionsByDate?.get(iso)?.map((s) => (
                <SessionAtelierCard key={s.id} s={s} />
              ))}
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

  // Compte les chefs d'équipe distincts sur la journée (union de chefEquipeId
  // legacy + chefEquipeIds[]). Avant : on mettait juste "+1 chef admin" si une
  // tournée était en retrait, ce qui était faux (3 chefs distincts pouvaient
  // être assignés sans qu'aucun ne s'affiche, cf. retour Yoann 2026-04-29).
  const chefsSet = new Set<string>();
  for (const t of active) {
    for (const l of t.livraisons) {
      if (l.chefEquipeId) chefsSet.add(l.chefEquipeId);
      for (const cid of l.chefEquipeIds || []) {
        if (cid) chefsSet.add(cid);
      }
    }
  }
  const nbChefs = chefsSet.size;

  // Une "ligne" du résumé regroupe les tournées par TYPE (gros / moyen /
  // camionnette / retrait). Sert à voir d'un coup d'œil la charge par
  // catégorie de véhicule. Une vraie tournée = un camion = un chauffeur.
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
  const nbMonteurs = active.reduce((sum, t) => sum + (t.nbMonteurs > 0 ? t.nbMonteurs : MONTEURS_PAR_EQUIPE), 0);
  const nbCamions = active.filter((t) => t.mode !== "retrait").length;
  const nbRetraits = active.filter((t) => t.mode === "retrait").length;

  const MODE_EMOJI: Record<string, string> = {
    gros: "🚚",
    moyen: "🚐",
    camionnette: "🚙",
    retrait: "📍",
    autre: "🚛",
  };
  const MODE_HUMAN: Record<string, string> = {
    gros: "Gros camion",
    moyen: "Camion moyen",
    camionnette: "Camionnette",
    retrait: "Retrait au dépôt",
    autre: "Tournée",
  };

  // Ligne d'en-tête en français normal — pas de jargon "É1 / É2".
  const tourneeWord = nbCamions > 1 ? "tournées" : "tournée";
  const retraitWord = nbRetraits > 1 ? "retraits" : "retrait";
  const headParts: string[] = [];
  if (nbCamions > 0) headParts.push(`${nbCamions} ${tourneeWord} en route`);
  if (nbRetraits > 0) headParts.push(`${nbRetraits} ${retraitWord} au dépôt`);

  return (
    <div className="mt-2 pt-2 border-t border-gray-200 space-y-1.5 text-[10px] leading-tight">
      <div className="font-semibold text-gray-700">
        {headParts.join(" + ")}
      </div>
      <div className="text-[10px] text-gray-500">
        {nbChefs} chef{nbChefs > 1 ? "s" : ""} d&apos;équipe · {nbMonteurs} monteur{nbMonteurs > 1 ? "s" : ""}
      </div>
      {groupes.map((g, idx) => {
        const isRetrait = g.mode === "retrait";
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
        const emoji = MODE_EMOJI[g.mode] || MODE_EMOJI.autre;
        const human = MODE_HUMAN[g.mode] || MODE_HUMAN.autre;
        const veloWord = g.totalVelos > 1 ? "vélos" : "vélo";
        return (
          <div key={g.mode + idx} className="space-y-0.5">
            <div className={tightPalette}>
              <span className="font-semibold">{emoji} {human}</span>
              <span className="opacity-75"> · {g.totalVelos} {veloWord} · environ {formatDureeShort(g.totalMin)}</span>
            </div>
            <ul className="pl-2 space-y-0.5 text-gray-600">
              {g.tournees.map((t) => {
                const nbAutres = t.livraisons.length - 1;
                return (
                  <li key={t.tourneeId || t.livraisons[0].id} className="truncate">
                    → {t.livraisons[0]?.client.entreprise}
                    {nbAutres > 0 && ` + ${nbAutres} autre${nbAutres > 1 ? "s client(s)" : " client"}`}
                    <span className="opacity-60"> ({t.totalVelos} {t.totalVelos > 1 ? "vélos" : "vélo"})</span>
                  </li>
                );
              })}
            </ul>
            {peutAjouter && (
              <div className="text-green-700 font-medium">
                Il reste environ {formatDureeShort(reste8h)} libres — on peut caler une 2e tournée
              </div>
            )}
            {!peutAjouter && !depasse10h && !isRetrait && reste8h < 60 && reste8h >= 0 && (
              <div className="text-amber-700">Journée pleine (8h chargées)</div>
            )}
            {depasse10h && (
              <div className="text-red-700 font-medium">
                ⚠ Dépasse 10h — {isRetrait ? "ajoute un monteur en plus" : "il faudrait splitter cette tournée"}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Estimation des heures d'arrivée chez chaque client d'une tournée.
// Hypothèse Yoann (29-04) : premier chargement entre 8h30 et 9h00. La fourchette
// se propage tout au long de la tournée (mêmes 30 min d'incertitude au départ
// → mêmes 30 min sur chaque arrivée). Vitesse 30 km/h = 2 min/km, distance
// haversine × 1.3 (facteur réseau routier), montage 12 min/vélo répartis sur
// nbMonteurs. Pour mode "retrait", pas de fourchette (le client vient au dépôt).
//
// PAUSE DÉJEUNER (Yoann 29-04 02h09) : 45 min de pause moyenne. On l'insère
// quand l'heure d'arrivée chez un client franchit 12h00 → 45 min de décalage
// sur tous les arrêts suivants.
const DEPART_MIN_DEFAULT = 8 * 60 + 30; // 8h30
const DEPART_MAX_DEFAULT = 9 * 60; // 9h00
const PAUSE_DEJEUNER_DEBUT = 12 * 60; // 12h00 = début de la fenêtre de pause
const PAUSE_DEJEUNER_DUREE = 45; // 45 min de pause moyenne (cf. retour Yoann)

// Map des départs réels par tournée (chaînés par chauffeur). Calculé dans
// LivraisonsPage et exposé via context pour que TourneeCard sache quand
// commencer pour T2/T3 d'un même chauffeur.
type DepartureMap = Map<string, { min: number; max: number }>;
const TourneeDeparturesContext = createContext<DepartureMap | null>(null);

function tourneeKeyForDeparture(t: Tournee): string {
  return (t.tourneeId || "no-tid") + "|" + (t.datePrevue ? isoDate(t.datePrevue) : "");
}

function computeArrivalTimes(
  tournee: Tournee,
  monteurs: number,
  departMin: number = DEPART_MIN_DEFAULT,
  departMax: number = DEPART_MAX_DEFAULT,
): Array<{ minMin: number; maxMin: number } | null> {
  if (tournee.mode === "retrait") return tournee.livraisons.map(() => null);
  const eff = Math.max(1, monteurs);
  let cumulMin = 0;
  // pausePrise se déclenche dès que l'arrivée chez un client franchit 12h00 :
  // on insère PAUSE_DEJEUNER_DUREE AVANT cet arrêt, ce qui décale tous les
  // arrêts suivants. Approximation : on déclenche sur la borne min (départ
  // 8h30) ; la borne max bénéficie du même décalage. On garde 1 seul
  // pausePrise pour ne pas la prendre 2x.
  let pausePrise = false;
  let prev = { lat: ENTREPOT.lat, lng: ENTREPOT.lng };
  const out: Array<{ minMin: number; maxMin: number } | null> = [];
  for (let i = 0; i < tournee.livraisons.length; i++) {
    const liv = tournee.livraisons[i];
    const c = liv.client;
    if (c.lat && c.lng && prev.lat && prev.lng) {
      const km = haversineKm(prev.lat, prev.lng, c.lat, c.lng) * 1.3;
      cumulMin += km / 0.5; // 30 km/h = 0.5 km/min
    }
    // Heure d'arrivée brute (sans pause), bornes min et max.
    let arriveeMin = departMin + cumulMin;
    let arriveeMax = departMax + cumulMin;
    if (!pausePrise && arriveeMin >= PAUSE_DEJEUNER_DEBUT) {
      // L'arrivée chez ce client tombe à 12h ou plus tard : on prend la pause
      // AVANT cet arrêt. Décale aussi le cumul pour les arrêts suivants.
      cumulMin += PAUSE_DEJEUNER_DUREE;
      arriveeMin += PAUSE_DEJEUNER_DUREE;
      arriveeMax += PAUSE_DEJEUNER_DUREE;
      pausePrise = true;
    }
    // La fourchette annoncée au client = fenêtre de présence du chauffeur.
    // borne min = arrivée min (au plus tôt il peut être chez vous)
    // borne max = arrivée max + temps de montage chez ce client
    //            (au plus tard il aura terminé chez vous)
    // Yoann 29-04 02h25 : avant on arrondissait juste l'arrivée → toutes les
    // fourchettes étaient de 30 min indépendamment du nb de vélos. Maintenant
    // un client à 1 vélo a ~30 min de fenêtre, à 10 vélos ~1h30 → annonce juste.
    // Source de vérité du nb vélos pour le calcul de montage : _count.velos
    // (toujours défini après backfill data-context). liv.nbVelos est optionnel
    // et undefined sur des livraisons importées du sheet GAS → si on l'utilise
    // on obtient montage=0 et toutes les arrivées des clients consécutifs
    // s'écrasent sur la même heure. Bug observé Yoann 29-04 02h38.
    const nbVelosClient = liv._count?.velos ?? liv.nbVelos ?? 0;
    // Yoann 2026-05-03 : mode atelier = 2 min/vélo (juste décharger)
    const minVeloLiv = minutesParVelo(liv.modeMontage);
    const montageMin = (nbVelosClient * minVeloLiv) / eff;
    out.push({
      // floor au :30 inférieur pour la borne min (arrondi prudent : on ne
      // promet pas plus tôt que ce qui est réaliste)
      minMin: Math.floor(arriveeMin / 30) * 30,
      // ceil au :30 supérieur pour la borne max (on ne promet pas plus tard
      // que ce qui couvre le temps de montage chez le client)
      maxMin: Math.ceil((arriveeMax + montageMin) / 30) * 30,
    });
    cumulMin += montageMin;
    if (c.lat && c.lng) prev = { lat: c.lat, lng: c.lng };
  }
  return out;
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
  // Couleur de la carte = couleur du chauffeur (sauf retrait = violet).
  // On résout l'ID chauffeur via la collection equipe déjà chargée par useData.
  // carte sert à récupérer l'apporteur de chaque client (affiché sur chaque
  // ligne — cf. retour Yoann 29-04 02h19).
  const { equipe, carte: carteClients } = useData();
  const chauffeurId = tournee.livraisons[0]?.chauffeurId;
  const chauffeurNom = chauffeurId
    ? equipe.find((m) => m.id === chauffeurId)?.nom || null
    : null;
  const apporteurByClientIdLocal = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const c of carteClients) m.set(c.id, c.apporteur);
    return m;
  }, [carteClients]);
  const palette = modePalette(tournee.mode, chauffeurNom);
  const libre = capaciteRestante(tournee.mode, tournee.totalVelos);
  const peutAjouter = libre >= SEUIL_2EME_TOURNEE && tournee.statutGlobal !== "livree" && tournee.statutGlobal !== "annulee";
  // Fourchette horaire estimée chez chaque client. Le départ est SOIT
  // 8h30-9h00 (1re tournée du chauffeur ce jour-là), SOIT chaîné après la
  // tournée précédente du même chauffeur (cas T2/T3 d'Armel le 4 mai).
  // Voir TourneeDeparturesContext rempli par LivraisonsPage.
  const monteursTournee = tournee.nbMonteurs > 0 ? tournee.nbMonteurs : MONTEURS_PAR_EQUIPE;
  const departures = useContext(TourneeDeparturesContext);
  const dep = departures?.get(tourneeKeyForDeparture(tournee));
  const departMinEffectif = dep?.min ?? DEPART_MIN_DEFAULT;
  const departMaxEffectif = dep?.max ?? DEPART_MAX_DEFAULT;
  const arrivals = computeArrivalTimes(tournee, monteursTournee, departMinEffectif, departMaxEffectif);
  // Si le départ est nettement plus tard que 9h, c'est une 2e+ tournée du
  // chauffeur. On affiche un petit bandeau pour rappeler le contexte.
  const isSecondaryTourneeForDriver = departMinEffectif > DEPART_MAX_DEFAULT + 30;
  // Heure de fin estimée = présence max chez le dernier client + trajet retour
  // dépôt. Si > 18h00 (Yoann 29-04 02h32 : "18h max retour à AXDIS"), la
  // tournée est INFAISABLE et on l'affiche en rouge plein.
  const FIN_JOURNEE_MAX = 18 * 60; // 18h00
  const lastArr = arrivals.length > 0 ? arrivals[arrivals.length - 1] : null;
  let finRetourDepotMin: number | null = null;
  if (lastArr && tournee.mode !== "retrait") {
    const lastClient = tournee.livraisons[tournee.livraisons.length - 1]?.client;
    let trajetRetourMin = 0;
    if (lastClient && lastClient.lat && lastClient.lng) {
      const km = haversineKm(lastClient.lat, lastClient.lng, ENTREPOT.lat, ENTREPOT.lng) * 1.3;
      trajetRetourMin = Math.round(km / 0.5);
    }
    finRetourDepotMin = lastArr.maxMin + trajetRetourMin;
  }
  const tourneeInfaisable = finRetourDepotMin != null && finRetourDepotMin > FIN_JOURNEE_MAX;
  // Check affectation : on regarde la 1re livraison (les affectations sont
  // par tournée, donc toutes ses livraisons partagent les mêmes équipes via
  // assignTournee).
  // Mode "retrait" (client vient chercher) : pas besoin de chauffeur.
  // Préparateur requis sur TOUTES les tournées : les vélos doivent être
  // préparés avant retrait/livraison (cf. retour Yoann 2026-04-28).
  const ref = tournee.livraisons[0];
  const missing: string[] = [];
  if (ref) {
    const isRetrait = tournee.mode === "retrait";
    // Yoann 2026-05-03 : modeMontage="atelier" = vélos pré-assemblés en
    // session atelier d'entrepôt. Pas de monteur sur la tournée → ne pas
    // signaler "Manque monteur" (faux positif). Préparateur reste requis
    // (sortie/chargement matin).
    const isAtelier = ref.modeMontage === "atelier";
    if (!isRetrait && !ref.chauffeurId) missing.push("chauffeur");
    const hasChef = !!ref.chefEquipeId || (ref.chefEquipeIds && ref.chefEquipeIds.length > 0);
    if (!hasChef) missing.push("chef");
    if (!isAtelier && (!ref.monteurIds || ref.monteurIds.length === 0)) missing.push("monteur");
    if (!ref.preparateurIds || ref.preparateurIds.length === 0) missing.push("préparateur");
  }
  const affectIncomplete = missing.length > 0 && tournee.statutGlobal !== "livree" && tournee.statutGlobal !== "annulee";
  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded ${palette.bg} ${palette.border} border ${palette.text} ${
        compact ? "px-1.5 py-1 text-[11px]" : "px-2 py-1.5 text-xs"
      } hover:opacity-90 transition-opacity ${affectIncomplete || tourneeInfaisable ? "ring-2 ring-red-500 ring-offset-1" : ""}`}
    >
      {tourneeInfaisable && (
        <div
          className="block w-full mb-1 rounded bg-red-600 text-white text-[10px] font-bold leading-tight px-1.5 py-1 text-center"
          title={`Fin estimée à ${fmtHM(finRetourDepotMin!)} — dépasse 18h max`}
        >
          ⛔ INFAISABLE — fin {fmtHM(finRetourDepotMin!)} {">"} 18h max
        </div>
      )}
      {affectIncomplete && (
        <div
          className="inline-flex items-center gap-1 px-1 mb-0.5 rounded bg-red-100 text-red-800 text-[9px] font-bold leading-tight"
          title={`Affectation incomplète : manque ${missing.join(", ")}`}
        >
          ⚠️ Manque {missing.join(" + ")}
        </div>
      )}
      <div className="flex items-start justify-between gap-1">
        <div className="min-w-0 flex-1">
          {tournee.livraisons.map((l, i) => {
            const fullText = compact
              ? `${i + 1}. ${l.client.entreprise}`
              : `${i + 1}. ${l.client.entreprise} · ${l._count.velos}v`;
            const len = fullText.length;
            const sizeClass = len <= 14 ? "text-[11px]" : len <= 20 ? "text-[10px]" : len <= 28 ? "text-[9px]" : "text-[8px]";
            const arr = arrivals[i];
            const apporteurNom = l.clientId ? apporteurByClientIdLocal.get(l.clientId) || null : null;
            return (
              <div key={l.id} className={`font-medium leading-tight break-words ${sizeClass}`} title={l.client.entreprise}>
                {compact ? (
                  <>
                    <span className="opacity-60">{i + 1}.</span> {l.client.entreprise}
                    {arr && (
                      <span className="opacity-50 font-mono ml-1">
                        {arr.minMin === arr.maxMin ? fmtHM(arr.minMin) : `${fmtHM(arr.minMin)}–${fmtHM(arr.maxMin)}`}
                      </span>
                    )}
                    {apporteurNom && (
                      <span className="opacity-50 ml-1">· {apporteurNom}</span>
                    )}
                  </>
                ) : (
                  <>
                    <span className="opacity-60">{i + 1}.</span> {l.client.entreprise}
                    <span className="opacity-60 font-mono"> · {l._count.velos}v</span>
                    {arr && (
                      <span className="opacity-50 font-mono ml-1">
                        · {arr.minMin === arr.maxMin ? fmtHM(arr.minMin) : `${fmtHM(arr.minMin)}–${fmtHM(arr.maxMin)}`}
                      </span>
                    )}
                    {apporteurNom && (
                      <span className="opacity-50 ml-1">· {apporteurNom}</span>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex flex-col items-end leading-tight whitespace-nowrap">
          <span className="font-mono opacity-70">{tournee.totalVelos}v/{tournee.livraisons.length}A</span>
          {tournee.numero != null && (
            <span className="font-mono text-[9px] opacity-60 mt-0.5">T{tournee.numero}</span>
          )}
        </div>
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

// Palette d'une carte tournée. Évolution 2026-04-29 (cf. screenshot Yoann) :
// la couleur reflète maintenant le CHAUFFEUR (avant : type de camion).
//   • mode "retrait"            → violet (le client vient lui-même, pas de chauffeur)
//   • chauffeur Armel           → vert
//   • chauffeur Zinedine        → bleu
//   • autre / inconnu / absent  → gris neutre
// Pour ajouter un futur chauffeur, étends CHAUFFEUR_COLORS (clé = 1er token du
// nom en minuscules). Match insensible à la casse + au prénom seul.
const CHAUFFEUR_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  armel: { bg: "bg-green-100", border: "border-green-300", text: "text-green-900" },
  zinedine: { bg: "bg-blue-100", border: "border-blue-300", text: "text-blue-900" },
};

function modePalette(mode: string | null, chauffeurNom?: string | null) {
  if (mode === "retrait") return { bg: "bg-purple-100", border: "border-purple-300", text: "text-purple-900" };
  if (chauffeurNom) {
    const key = chauffeurNom.trim().toLowerCase().split(/\s+/)[0];
    if (CHAUFFEUR_COLORS[key]) return CHAUFFEUR_COLORS[key];
  }
  return { bg: "bg-gray-100", border: "border-gray-300", text: "text-gray-800" };
}

const MODE_LABELS: Record<string, string> = {
  gros: "Gros camion (165)",
  moyen: "Moyen (54)",
  camionnette: "Camionnette (20)",
  retrait: "Retrait client",
};

// Capacité Gros camion FB444MH (Iveco Eurocargo 19T) : caisse utile 850×248 cm,
// optimum 5×3 = 15 palettes 160×80 cm, × 11 vélos/palette = 165 vélos.
const CAPACITES: Record<string, number> = { gros: 165, moyen: 54, camionnette: 20 };
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
  const minVelo = minutesParVelo(tournee.livraisons[0]?.modeMontage);
  const totalMontage = tournee.totalVelos * minVelo;
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

// Durée de la tournée du POINT DE VUE DU CHAUFFEUR (vs estimateTourneeMinutes
// qui mesure la durée totale équipe). Le chauffeur ne reste PAS pour le
// montage du dernier client : dès que les cartons sont déchargés, il file au
// dépôt pour démarrer la T2 (Yoann 29-04 02h46 — "il fonce directement").
// L'équipe reste sur place finir le montage et prendre sa pause.
//
// Calcul : trajets dépôt→1→2→…→N→dépôt + montages chez clients 1..N-1
// (le chauffeur attend l'équipe pour repartir vers le client suivant) +
// déchargement chez client N (1 min/vélo, on pose les cartons et c'est tout).
//
// Sert à positionner T2 d'un même chauffeur dans le chaînage tourneeDepartures :
// avec cette mesure, T2 démarre plus tôt que si on attendait que l'équipe
// finisse le montage du dernier client de T1.
function estimateDureeChauffeur(tournee: Tournee, monteurs: number): number {
  if (tournee.mode === "retrait") return 0;
  const livs = tournee.livraisons;
  if (livs.length === 0) return 0;
  const eff = Math.max(1, monteurs);
  let totalTrajet = 0;
  let prev = { lat: ENTREPOT.lat, lng: ENTREPOT.lng };
  for (const liv of livs) {
    const c = liv.client;
    if (c.lat && c.lng && prev.lat && prev.lng) {
      const km = haversineKm(prev.lat, prev.lng, c.lat, c.lng) * 1.3;
      totalTrajet += km / 0.5;
      prev = { lat: c.lat, lng: c.lng };
    }
  }
  // Retour dépôt après le dernier client (depuis prev = dernier client).
  if (prev.lat && prev.lng) {
    const km = haversineKm(prev.lat, prev.lng, ENTREPOT.lat, ENTREPOT.lng) * 1.3;
    totalTrajet += km / 0.5;
  }
  // Yoann 2026-05-03 : en mode atelier (vélos pré-assemblés), pas de
  // montage chez le client → on prend MINUTES_PAR_VELO_ATELIER (~2 min)
  // pour TOUS les clients y compris intermédiaires (juste décharger).
  const minVelo = minutesParVelo(livs[0]?.modeMontage);
  let temps = 0;
  for (let i = 0; i < livs.length; i++) {
    const nbV = livs[i]._count?.velos ?? livs[i].nbVelos ?? 0;
    if (i < livs.length - 1) {
      // Clients intermédiaires : le chauffeur attend que les monteurs finissent
      // (toute l'équipe repart ensemble vers le client suivant dans le camion).
      temps += (nbV * minVelo) / eff;
    } else {
      // Dernier client : juste le déchargement (≈ 1 min/vélo). L'équipe
      // reste sur place pour le montage, le chauffeur file au dépôt.
      temps += nbV * 1;
    }
  }
  return Math.round(totalTrajet + temps);
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
// Yoann 2026-05-03 : en mode atelier (vélos pré-assemblés en entrepôt), le
// temps sur place se réduit à décharger + signer BL ; on prend 2 min/vélo
// au lieu de 12. Sans ça, le système croyait qu'une livraison de 22 vélos
// montés prenait 3h alors qu'il faut ~45 min en réalité.
const MINUTES_PAR_VELO_ATELIER = 2;
function minutesParVelo(mode: string | null | undefined): number {
  return mode === "atelier" ? MINUTES_PAR_VELO_ATELIER : MINUTES_PAR_VELO;
}
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
  livraisons: { _count: { velos: number }; modeMontage?: string | null }[],
  segments: { trajetMin: number }[],
  monteurs: number,
  modeMontageOverride?: string | null
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

    // Yoann 2026-05-03 : minutes par vélo varie selon modeMontage de la
    // livraison (atelier = 2 min/vélo car juste déchargement, client = 12).
    // Override possible au niveau tournée (modeMontageOverride) qui prime.
    const liv = livraisons[i] as { _count: { velos: number }; modeMontage?: string | null };
    const minVelo = minutesParVelo(modeMontageOverride ?? liv.modeMontage);
    const montageTotal = livraisons[i]._count.velos * minVelo;
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
  const { carte: allClients, equipe, bonsEnlevement, livraisons: allLivraisons } = useData();
  // Étapes autorisées pour le user connecté. Si pas de user (cas SSR ou non
  // logué), on laisse tout cliquable — l'auth-gate gère déjà la redirection.
  const currentUser = useCurrentUser();
  const allowedStages: ReadonlySet<StageKey> = currentUser
    ? STAGE_ACCESS[currentUser.role]
    : new Set<StageKey>(["prepare", "charge", "livre", "monte"]);
  // Permissions par rôle pour les blocs admin / équipe de la modale (cf.
  // demande Yoann 2026-04-29 « ça pollue ») :
  //   - admin/superadmin/chef/préparateur : tout (mails + bon Axdis + BL + CSV)
  //   - chauffeur                         : bon Axdis seulement + récap équipe
  //   - chef monteur (ricky)              : bloc équipe en édition
  //   - monteur normal                    : ni admin blocs, ni équipe
  const perms = useMemo(() => {
    const role = currentUser?.role;
    const isApporteurLocal = role === "apporteur";
    const isChefMonteurLocal = role === "monteur" && currentUser?.estChefMonteur === true;
    // Yoann 2026-05-03 : tous les chefs (monteur + admin terrain) sont
    // en lecture seule sur /livraisons. Chef monteur peut en plus
    // modifier les monteurs de SON équipe (canEditEquipe).
    const isFullAdmin = role === "admin" || role === "superadmin";
    const isChefAny = role === "chef";
    const isChefMonteurEquipe = isChefAny && currentUser?.chefDeMonteurs === true;
    const canSeeAdminBlocs = !isApporteurLocal && !isChefAny && (isFullAdmin || role === "preparateur");
    const canSeeBonAxdis = !isApporteurLocal && !isChefAny && (canSeeAdminBlocs || role === "chauffeur");
    // canEditEquipe : seul chef monteur peut modifier ses monteurs.
    // Chef admin terrain : lecture seule (pas de modif équipe).
    const canEditEquipe = !isApporteurLocal && (isFullAdmin || isChefMonteurLocal || isChefMonteurEquipe);
    const canSeeEquipeRecap = !isApporteurLocal && (canEditEquipe || role === "chauffeur" || role === "preparateur" || isChefAny);
    return { canSeeAdminBlocs, canSeeBonAxdis, canEditEquipe, canSeeEquipeRecap, isApporteurLocal, isChefTerrain: isChefAny };
  }, [currentUser?.role, currentUser?.estChefMonteur, currentUser?.chefDeMonteurs]);
  const [showRappel, setShowRappel] = useState(false);
  const [showBrief, setShowBrief] = useState(false);
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
  // Modal liste FNUCI client (Yoann 2026-05-01) — accès rapide aux FNUCI
  // de tous les vélos d'une livraison + état des étapes + copie CSV.
  const [fnuciListClient, setFnuciListClient] = useState<{ clientId: string; entreprise: string } | null>(null);
  // Modal saisie manuelle bon d'enlèvement (30-04 10h15) : quand le pipeline
  // gas-inbox/Gemini échoue (mail non extrait, doc mal classé), Yoann saisit
  // le bon directement depuis l'UI au lieu d'aller bidouiller le Sheet GAS.
  const [manualBonOpen, setManualBonOpen] = useState(false);
  // Modal report (29-04 14h56) : liste des livraisons en cours de report.
  // null = modal fermée. Sert pour le report 1 livraison ET le report bulk.
  const [reportTargets, setReportTargets] = useState<Array<{ id: string; entreprise: string }> | null>(null);
  const [reportDate, setReportDate] = useState<string>("");
  const [editingDate, setEditingDate] = useState(false);
  const [newDate, setNewDate] = useState(tournee.datePrevue ? isoDate(tournee.datePrevue) : "");
  const [addingClient, setAddingClient] = useState(false);
  const [clientSearch, setClientSearch] = useState("");
  // Suggestion Gemini : clientId mis en évidence + raison à afficher.
  // On NE l'ajoute PAS automatiquement (irréversible) — Yoann valide d'un clic.
  const [suggestion, setSuggestion] = useState<{ clientId: string; raison: string } | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [progression, setProgression] = useState<{
    totals: { total: number; prepare: number; charge: number; livre: number; monte: number };
    datePrevue?: string | null;
    clients?: {
      clientId: string;
      entreprise?: string;
      totals: { total: number; prepare: number; charge: number; livre: number; monte: number };
      velos?: {
        veloId: string;
        fnuci: string | null;
        datePreparation?: string | null;
        dateChargement?: string | null;
        photoChargementUrl?: string | null;
      }[];
    }[];
  } | null>(null);
  // Galerie photos CEE chargement (preuve TRA-EQ-131).
  const [galleryOpen, setGalleryOpen] = useState(false);

  useEffect(() => {
    // Reset systématique : sans ça, en passant d'une tournée avec tourneeId
    // valide à une autre où la livraison a tourneeId=null (cas Yoann 2026-05-01,
    // ANADOLU reportée), la progression précédente "bleed" et affiche
    // 13/13 ✓ alors que la tournée en cours n'a rien de comptable.
    setProgression(null);
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

  // Calcul live des vélos planifiés par client à partir des livraisons réelles
  // (statut=planifiee, non annulées). Évite de dépendre du compteur persisté
  // `stats.planifies` qui peut dériver si une livraison a été créée/annulée
  // sans MAJ du compteur — bug 2026-04-28 : SMART/ZAPHYR proposés alors qu'ils
  // étaient déjà dans une tournée.
  const planifiesParClient = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of allLivraisons) {
      if (l.statut !== "planifiee") continue;
      const cid = l.clientId;
      if (!cid) continue;
      m.set(cid, (m.get(cid) || 0) + (l.nbVelos || 0));
    }
    return m;
  }, [allLivraisons]);

  const eligibleClients = useMemo(() => {
    const libre = capaciteRestante(tournee.mode, tournee.totalVelos);
    const list = allClients
      .map((c) => {
        const planifiesLive = planifiesParClient.get(c.id) || 0;
        const reste = c.nbVelos - c.velosLivres - planifiesLive;
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
  }, [allClients, alreadyInTour, clientSearch, tourCentroid, tournee.mode, tournee.totalVelos, planifiesParClient]);

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
    setSuggestion(null);
    setSuggestionError(null);
    setAddingClient(false);
    setBusy(null);
  };

  // Demande à Gemini de choisir le meilleur client de remplacement parmi les
  // 10 plus proches déjà filtrés (eligibleClients pré-trié par centroïde +
  // capacité). Renvoie {clientId, raison} qu'on met en évidence dans la liste
  // — Yoann valide d'un clic. Pas d'auto-ajout (irréversible si Gemini se
  // trompe). Dépend de callGemini (Cloud Function europe-west1, déjà déployée).
  const suggestBest = async () => {
    if (!eligibleClients.length) return;
    setSuggesting(true);
    setSuggestion(null);
    setSuggestionError(null);
    try {
      const top = eligibleClients.slice(0, 10);
      const libre = capaciteRestante(tournee.mode, tournee.totalVelos);
      const arrets = tournee.livraisons.map((l) => ({
        entreprise: l.client.entreprise,
        ville: l.client.ville || "",
        codePostal: l.client.codePostal || "",
        nbVelos: l.nbVelos,
        lat: l.client.lat ?? null,
        lng: l.client.lng ?? null,
      }));
      const candidats = top.map((c) => {
        const planifiesLive = planifiesParClient.get(c.id) || 0;
        const reste = c.nbVelos - c.velosLivres - planifiesLive;
        const distKm =
          c.lat && c.lng
            ? haversineKm(tourCentroid.lat, tourCentroid.lng, c.lat, c.lng)
            : null;
        return {
          clientId: c.id,
          entreprise: c.entreprise,
          ville: c.ville || "",
          codePostal: c.codePostal || "",
          nbVelosRestant: reste,
          distanceKm: distKm != null ? Math.round(distKm * 10) / 10 : null,
          lat: c.lat ?? null,
          lng: c.lng ?? null,
        };
      });
      const prompt = `Tu es l'optimiseur de tournées de livraison vélos cargo en Île-de-France.

Un client a annulé sa livraison dans une tournée déjà planifiée. Il faut
le remplacer par un autre client en attente, en minimisant le détour
géographique et en remplissant le camion au mieux.

Capacité restante du camion : ${libre} vélos.

ARRÊTS DÉJÀ DANS LA TOURNÉE :
${JSON.stringify(arrets)}

CANDIDATS DE REMPLACEMENT (déjà triés par proximité) :
${JSON.stringify(candidats)}

Choisis LE MEILLEUR candidat selon, par ordre d'importance :
  1. Détour minimal (proche des arrêts existants, même bassin urbain)
  2. Remplissage du camion sans dépasser ${libre} vélos
  3. Cohérence (codes postaux/villes proches des autres arrêts)

Réponds STRICTEMENT en JSON sans markdown, format :
{ "clientId": "<id du candidat choisi>", "raison": "<phrase courte FR>" }`;

      const r = await callGemini(prompt);
      if (!r.ok) {
        setSuggestionError(`Gemini : ${r.error}`);
        return;
      }
      const text = r.text.trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        setSuggestionError("Réponse Gemini non-JSON");
        return;
      }
      let parsed: { clientId?: string; raison?: string };
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        setSuggestionError("JSON Gemini invalide");
        return;
      }
      const clientId = parsed.clientId;
      if (!clientId || !candidats.find((c) => c.clientId === clientId)) {
        setSuggestionError("Gemini a proposé un client hors liste");
        return;
      }
      setSuggestion({
        clientId,
        raison: parsed.raison || "Choix optimal selon Gemini",
      });
    } catch (e) {
      setSuggestionError(e instanceof Error ? e.message : String(e));
    } finally {
      setSuggesting(false);
    }
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
    // Parallèle : N round-trips simultanés au lieu de N séquentiels.
    // Une tournée a typiquement 1-8 arrêts → gain ~5× sur 4G.
    await Promise.all(
      tournee.livraisons.map((l) =>
        gasPost("updateLivraison", { id: l.id, data: { datePrevue: newDate } }),
      ),
    );
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
    let raisonBulk = "";
    if (action === "annulee") {
      const raison = prompt(`Raison de l'annulation pour ces ${selected.size} livraison${selected.size > 1 ? "s" : ""} ? (obligatoire)`);
      if (raison === null) return;
      raisonBulk = raison.trim();
      if (!raisonBulk) { alert("Une raison est obligatoire pour annuler."); return; }
    } else {
      if (!confirm(`${label.charAt(0).toUpperCase() + label.slice(1)} ${selected.size} livraison${selected.size > 1 ? "s" : ""} ?`)) return;
    }
    setBusy("bulk");
    const ids = Array.from(selected);
    // Parallèle pour réduire la latence sur N livraisons (avant : N×latence, maintenant : 1×latence).
    await Promise.all(
      ids.map(async (id) => {
        const l = tournee.livraisons.find((x) => x.id === id);
        if (!l) return;
        if (action === "annulee" && l.statut !== "annulee") {
          await gasGet("deleteLivraison", { id, raisonAnnulation: raisonBulk });
        } else if (action === "livree" && l.statut !== "livree") {
          await gasPost("updateLivraison", { id, data: { statut: "livree", dateEffective: new Date().toISOString() } });
        } else if (action === "planifiee" && l.statut === "annulee") {
          await gasGet("restoreLivraison", { id });
        }
      }),
    );
    setSelected(new Set());
    onChanged();
    setBusy(null);
  };

  const setAllLivrees = async () => {
    const aFaire = tournee.livraisons.filter((l) => l.statut !== "livree");
    if (aFaire.length === 0) return;
    const ok = confirm(
      `Marquer ${aFaire.length} livraison${aFaire.length > 1 ? "s" : ""} comme « livrée » SANS aucun scan vélo ?\n\n` +
      `Cette action ne touche PAS aux vélos eux-mêmes (les compteurs Prép/Charg/Livr resteront à 0).\n` +
      `À utiliser seulement pour réconcilier une tournée ancienne ou en cas exceptionnel.\n\n` +
      `OK pour confirmer, Annuler pour revenir.`,
    );
    if (!ok) return;
    setBusy("all");
    const now = new Date().toISOString();
    await Promise.all(
      aFaire.map((l) => gasPost("updateLivraison", { id: l.id, data: { statut: "livree", dateEffective: now } })),
    );
    onChanged();
    setBusy(null);
    onClose();
  };

  const cancelAll = async () => {
    const raison = prompt(`Raison de l'annulation de la tournée (${tournee.livraisons.length} livraisons) ? (obligatoire)`);
    if (raison === null) return;
    const raisonClean = raison.trim();
    if (!raisonClean) { alert("Une raison est obligatoire pour annuler."); return; }
    setBusy("cancelAll");
    if (tournee.tourneeId) {
      await gasGet("cancelTournee", { tourneeId: tournee.tourneeId, raisonAnnulation: raisonClean });
    } else {
      await Promise.all(
        tournee.livraisons
          .filter((l) => l.statut !== "annulee")
          .map((l) => gasGet("deleteLivraison", { id: l.id, raisonAnnulation: raisonClean })),
      );
    }
    onChanged();
    setBusy(null);
    onClose();
  };

  const annuler = async (id: string) => {
    const raison = prompt("Raison de l'annulation ? (obligatoire)");
    if (raison === null) return; // Annulé via Échap
    const raisonClean = raison.trim();
    if (!raisonClean) {
      alert("Une raison est obligatoire pour annuler.");
      return;
    }
    setBusy(id);
    await gasGet("deleteLivraison", { id, raisonAnnulation: raisonClean });
    onChanged();
    setBusy(null);
  };

  // Reporter une livraison à un autre jour (29-04 14h56) : ouvre le modal de
  // sélection de date. Le modal est partagé entre report d'1 livraison (clic
  // sur la ligne) et report en bulk (cases à cocher + bouton barre d'action).
  // Détache de la tournée courante (tourneeId=null) et écrit la nouvelle
  // datePrevue. La livraison redevient "à planifier" pour cette nouvelle date.
  const reporter = (id: string, currentEntreprise: string) => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    setReportDate(tomorrow.toISOString().slice(0, 10));
    setReportTargets([{ id, entreprise: currentEntreprise }]);
  };

  const reporterBulk = () => {
    if (selected.size === 0) return;
    const targets: Array<{ id: string; entreprise: string }> = [];
    for (const l of tournee.livraisons) {
      if (selected.has(l.id) && l.statut !== "annulee") {
        targets.push({ id: l.id, entreprise: l.client?.entreprise || "?" });
      }
    }
    if (targets.length === 0) return;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    setReportDate(tomorrow.toISOString().slice(0, 10));
    setReportTargets(targets);
  };

  const executeReport = async () => {
    if (!reportTargets || !reportDate) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
      alert("Date invalide.");
      return;
    }
    const parsed = new Date(`${reportDate}T09:00:00`);
    if (Number.isNaN(parsed.getTime())) {
      alert("Date invalide.");
      return;
    }
    setBusy("report");
    try {
      const isoDt = parsed.toISOString();
      // Parallèle : 1 round-trip par livraison, mais en simultané (4G typique
      // = 5-10 livraisons en moins de 2 sec).
      await Promise.all(
        reportTargets.map((t) =>
          gasPost("updateLivraison", {
            id: t.id,
            data: {
              datePrevue: isoDt,
              tourneeId: null,
              statut: "planifiee",
              dateEffective: null,
            },
          }),
        ),
      );
      setReportTargets(null);
      setReportDate("");
      setSelected(new Set()); // reset la sélection après bulk
      onChanged();
    } catch (e) {
      alert("Report échoué : " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(null);
    }
  };

  const restaurer = async (id: string) => {
    setBusy(id);
    await gasGet("restoreLivraison", { id });
    onChanged();
    setBusy(null);
  };

  const toggleDejaChargee = async (id: string, current: boolean) => {
    setBusy(id);
    try {
      await gasPost("updateLivraison", { id, data: { dejaChargee: !current } });
      onChanged();
    } catch (e) {
      alert("Échec : " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(null);
    }
  };

  // Toggles workflow opérationnel admin (Yoann 2026-05-01) :
  // - dossierConfirme : bureau a vérifié docs CEE complets
  // - depose : dossier déposé pour remboursement CEE (= prise de paiement)
  const toggleDossierConfirme = async (id: string, current: string | null | undefined) => {
    setBusy(id);
    try {
      const now = new Date().toISOString();
      const data = current
        ? { dossierConfirmeAt: null, dossierConfirmePar: null }
        : { dossierConfirmeAt: now, dossierConfirmePar: currentUser?.nom || null };
      await gasPost("updateLivraison", { id, data });
      onChanged();
    } catch (e) {
      alert("Échec : " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(null);
    }
  };
  const toggleDepose = async (id: string, current: string | null | undefined) => {
    setBusy(id);
    try {
      const now = new Date().toISOString();
      const data = current
        ? { deposeAt: null, deposePar: null }
        : { deposeAt: now, deposePar: currentUser?.nom || null };
      await gasPost("updateLivraison", { id, data });
      onChanged();
    } catch (e) {
      alert("Échec : " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(null);
    }
  };

  const validateClient = async (id: string, status: "validee_orale" | "validee_mail" | "non_contacte", currentUserName: string) => {
    setBusy(id);
    let par: string | null = currentUserName || null;
    let note: string | null = null;
    if (status !== "non_contacte") {
      const who = prompt(`Qui a contacté le client ? (chef d'équipe / apporteur / nom)`, par || "");
      if (who === null) { setBusy(null); return; }
      par = who.trim() || par;
      const n = prompt("Note (optionnelle, ex: « ok pour 9h », « rappelle demain ») :", "");
      note = n?.trim() || null;
    }
    await gasPost("setLivraisonValidation", { id, status, par, note });
    onChanged();
    setBusy(null);
  };

  // Cohérent avec TourneeCard : couleur = chauffeur (sauf retrait = violet).
  const chauffeurIdModal = tournee.livraisons[0]?.chauffeurId;
  const chauffeurNomModal = chauffeurIdModal
    ? equipe.find((m) => m.id === chauffeurIdModal)?.nom || null
    : null;
  const palette = modePalette(tournee.mode, chauffeurNomModal);
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
                {isRetrait
                  ? `Retrait ${tournee.livraisons[0]?.client?.entreprise || "client"}`
                  : <>Tournée {tourneeNumber ? <span>{tourneeNumber}</span> : tournee.tourneeId ? <span className="font-mono text-sm">{tournee.tourneeId}</span> : "(sans id)"}</>}
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
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
            {(!perms.isApporteurLocal && !perms.isChefTerrain) && tournee.tourneeId && (
              <a
                href={`/tournee-execute?id=${encodeURIComponent(tournee.tourneeId)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="px-2 sm:px-3 py-1 text-[11px] sm:text-xs bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 flex items-center gap-1"
                title="Ouvrir l'écran mobile pour le chef d'équipe"
              >
                📱 Chef d&apos;équipe
              </a>
            )}
            {(!perms.isApporteurLocal && !perms.isChefTerrain) && (
              <button
                onClick={() => setShowRappel(true)}
                className="px-2 sm:px-3 py-1 text-[11px] sm:text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center gap-1"
                title="Envoie un rappel par mail à chaque client de la tournée avec sa fenêtre de passage estimée"
              >
                📧 Rappels veille
              </button>
            )}
            {perms.canSeeAdminBlocs && (
              <button
                onClick={() => setShowBrief(true)}
                className="px-2 sm:px-3 py-1 text-[11px] sm:text-xs bg-purple-600 text-white rounded-lg hover:bg-purple-700 flex items-center gap-1"
                title="Génère un brief texte à copier-coller pour les équipes (WhatsApp / mail)"
              >
                📋 Brief équipe
              </button>
            )}
            {(!perms.isApporteurLocal && !perms.isChefTerrain) && (
            <button
              onClick={async () => {
                const { url } = buildAxdisCommandeMail(tournee);
                window.open(url, "_blank");
                try {
                  await markBonCommandeEnvoye(tournee);
                  onChanged();
                } catch (e) {
                  console.error("markBonCommandeEnvoye failed", e);
                }
              }}
              className={`px-2 sm:px-3 py-1 text-[11px] sm:text-xs rounded-lg flex items-center gap-1 ${
                tournee.bonCommandeEnvoyeAt
                  ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-200"
                  : "bg-amber-600 text-white hover:bg-amber-700"
              }`}
              title={
                tournee.bonCommandeEnvoyeAt
                  ? `Déjà envoyé le ${new Date(tournee.bonCommandeEnvoyeAt).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}. Clique pour renvoyer.`
                  : `Pré-remplit un mail à ${AXDIS_EMAIL} avec la commande de cette tournée`
              }
            >
              {tournee.bonCommandeEnvoyeAt ? "✅ Commande AXDIS envoyée" : "📧 Commande AXDIS"}
            </button>
            )}
            {(!perms.isApporteurLocal && !perms.isChefTerrain) && (
            <button
              onClick={() => setShowPrint(true)}
              className="px-2 sm:px-3 py-1 text-[11px] sm:text-xs bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 flex items-center gap-1"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
              </svg>
              Feuille de route
            </button>
            )}
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-auto">×</button>
          </div>
        </div>

        {/* Estimation temps + effectif */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-blue-900">Estimation journée</span>
            <span className="text-xs text-blue-600">{MINUTES_PAR_VELO} min/vélo · ~30 km/h en ville</span>
          </div>
          <div className="text-[10px] text-blue-700 flex items-center gap-1 flex-wrap">
            <span>📍</span>
            <span className="truncate">Départ : {ENTREPOT.label}</span>
            {perms.canEditEquipe && (() => {
              // Permet de décaler l'heure de départ tournée (ex : marchandise
              // qui n'arrive qu'à 11h30). Posée sur TOUTES les livraisons de
              // la tournée. Affecte tourneeDepartures + computeArrivalTimes.
              const cur = tournee.livraisons[0]?.heureDepartTournee || "";
              const lids = tournee.livraisons.map((l) => l.id);
              const setHeure = async (val: string | null) => {
                setBusy("heureDepart");
                try {
                  await Promise.all(
                    lids.map((id) =>
                      gasPost("updateLivraison", { id, data: { heureDepartTournee: val } }),
                    ),
                  );
                  onChanged();
                } finally { setBusy(null); }
              };
              return (
                <span className="ml-auto inline-flex items-center gap-1.5">
                  <span className="text-blue-700">·</span>
                  <span className="text-blue-900 font-medium">🕐 Départ</span>
                  <input
                    type="time"
                    value={cur}
                    onChange={(e) => setHeure(e.target.value || null)}
                    className="px-1.5 py-0.5 border rounded text-[11px] bg-white"
                    title="Heure de démarrage de la journée — laisse vide pour 8h30 par défaut"
                  />
                  {cur && (
                    <button
                      onClick={() => setHeure(null)}
                      className="text-[10px] text-gray-500 underline"
                      title="Restaurer le défaut 8h30"
                    >
                      reset
                    </button>
                  )}
                </span>
              );
            })()}
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
        {perms.canSeeBonAxdis && tournee.tourneeId && (() => {
          // Matching priorisé : (1) lien direct via tourneeId si renseigné par
          // le sync Cloud Function, (2) fallback via tourneeNumero (les bons
          // arrivés via gas-inbox+Gemini Vision n'ont QUE le numéro extrait du
          // PDF — "VELO CARGO - TOURNEE X"). Cf. memory crm_velos_cargo_axdis_workflow.
          const be = bonsEnlevement.find((b) => {
            if (b.tourneeId && b.tourneeId === tournee.tourneeId) return true;
            if (tournee.numero != null && b.tourneeNumero != null) {
              return Number(b.tourneeNumero) === tournee.numero;
            }
            return false;
          });
          if (!be) {
            return (
              <div className="mb-3 flex items-center gap-2 flex-wrap text-sm px-3 py-2 rounded-lg border bg-gray-50 border-gray-200 text-gray-500">
                <span>📋</span>
                <span>Bon d&apos;enlèvement non reçu</span>
                <button
                  type="button"
                  onClick={async () => {
                    setBusy("syncBons");
                    try {
                      const r = (await gasPost("syncBonsNow", {})) as { ok?: boolean; bons?: number; verifs?: number; error?: string };
                      if (r.error) {
                        alert(`Sync échouée : ${r.error}`);
                      } else {
                        // Le badge se mettra à jour automatiquement via le listener
                        // Firestore onSnapshot. On informe juste que la sync est OK.
                        if ((r.bons ?? 0) === 0) {
                          alert("Sync OK — aucun bon trouvé pour l'instant côté GAS. Tiffany n'a peut-être pas encore répondu, ou le mail n'a pas été classé BON_ENLEVEMENT.");
                        }
                      }
                    } catch (e) {
                      alert("Sync échouée : " + (e instanceof Error ? e.message : String(e)));
                    } finally {
                      setBusy(null);
                    }
                  }}
                  disabled={busy === "syncBons"}
                  className="text-xs px-2 py-0.5 rounded border border-gray-300 hover:bg-gray-100 disabled:opacity-50"
                  title="Force une sync immédiate des bons reçus depuis GAS (sans attendre le cron 15 min)"
                >
                  {busy === "syncBons" ? "⏳" : "🔄 Sync maintenant"}
                </button>
                <button
                  type="button"
                  onClick={() => setManualBonOpen(true)}
                  className="text-xs px-2 py-0.5 rounded border border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100"
                  title="Saisir le bon manuellement (quand le pipeline auto échoue)"
                >
                  ✏️ Saisir manuellement
                </button>
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

        {/* Bons de livraison clients (29-04 13h30) : un BL par client de la
            tournée, tous générés en une page A4 chacun via /bl?tourneeId=...
            avec page-break-after entre chaque client → impression groupée. */}
        {perms.canSeeAdminBlocs && tournee.tourneeId && progression?.clients && progression.clients.length > 0 && (
          <div className="mb-3 flex items-center gap-3 px-3 py-2 rounded-lg border bg-blue-50 border-blue-300 text-blue-900">
            <span className="text-lg">📄</span>
            <div className="flex-1 text-sm">
              <div className="font-medium">Bons de livraison clients</div>
              <div className="text-xs opacity-80">
                {progression.clients.length} BL · 1 page A4 par client (numérotation BL-{new Date().getFullYear()}-XXXXX séquentielle)
              </div>
            </div>
            <a
              href={`${BASE_PATH}/bl?tourneeId=${encodeURIComponent(tournee.tourneeId)}`}
              className="text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 font-medium whitespace-nowrap"
            >
              🖨️ Imprimer tous
            </a>
            <SendBlFranckTourneeBtn
              tourneeId={tournee.tourneeId}
              clients={progression.clients.map((c) => ({
                clientId: c.clientId,
                entreprise: c.entreprise || "?",
              }))}
              livraisons={tournee.livraisons}
            />
          </div>
        )}

        {/* Envoi auto du CSV préparation à Tiffany via Cloud Function nodemailer
            (29-04 14h14) : visible dès que la prep est terminée (prepare === total).
            La CF récupère les vélos en Firestore admin, génère le CSV et envoie
            par mail à Tiffany@axdis.fr avec le CSV en pièce jointe. Pas de
            manipulation manuelle, vraie auto. */}
        {perms.canSeeAdminBlocs && tournee.tourneeId && progression && progression.totals.total > 0 && progression.totals.prepare >= progression.totals.total && (() => {
          const sentAt = tournee.livraisons[0]?.csvAxdisSentAt;
          const sentTo = tournee.livraisons[0]?.csvAxdisSentTo;
          const sentDate = sentAt ? new Date(sentAt) : null;
          return (
          <div className={`mb-3 px-3 py-2.5 rounded-lg border space-y-2 ${
            sentAt
              ? "bg-emerald-100 border-emerald-500 text-emerald-900"
              : "bg-emerald-50 border-emerald-300 text-emerald-900"
          }`}>
            <div className="flex items-center gap-3">
              <span className="text-lg">{sentAt ? "✅" : "📤"}</span>
              <div className="flex-1 text-sm">
                <div className="font-medium">
                  {sentAt
                    ? `Mail envoyé à ${sentTo || "Tiffany"}`
                    : "Envoyer le CSV préparation à Tiffany"}
                </div>
                <div className="text-xs opacity-80">
                  {sentAt && sentDate
                    ? `Envoyé le ${sentDate.toLocaleDateString("fr-FR")} à ${sentDate.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })} · ${progression.totals.prepare} vélos`
                    : `${progression.totals.prepare} vélos préparés · pièce jointe Client / FNUCI / Date de livraison`}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  // Téléchargement local du CSV (même contenu que celui envoyé à
                  // Tiffany — Client;FNUCI;Date de livraison). On reconstruit
                  // côté frontend depuis progression.clients[].velos[] pour ne pas
                  // dépendre du SMTP : utile pour vérifier ou conserver une
                  // copie locale avant envoi.
                  if (!progression || !tournee.tourneeId) return;
                  const dp = progression.datePrevue
                    ? new Date(progression.datePrevue).toLocaleDateString("fr-FR")
                    : "";
                  const escape = (s: string) => /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
                  const lines = ["Client;FNUCI;Date de livraison"];
                  for (const c of progression.clients ?? []) {
                    const cName = c.entreprise || "";
                    for (const v of c.velos ?? []) {
                      if (!v.fnuci) continue;
                      lines.push(`${escape(cName)};${escape(v.fnuci)};${escape(dp)}`);
                    }
                  }
                  const csv = "﻿" + lines.join("\r\n");
                  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  const dateStr = new Date().toISOString().slice(0, 10);
                  const num = tournee.numero ?? tournee.tourneeId.slice(0, 8);
                  a.href = url;
                  a.download = `preparation-tournee-${num}-${dateStr}.csv`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                className="text-xs px-3 py-1.5 rounded bg-white border border-emerald-300 text-emerald-700 hover:bg-emerald-50 font-medium whitespace-nowrap"
                title="Télécharger une copie locale du CSV"
              >
                💾 CSV
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (!tournee.tourneeId) return;
                  setBusy("exportCsvPrep");
                  try {
                    const { httpsCallable, getFunctions } = await import("firebase/functions");
                    const { firebaseApp } = await import("@/lib/firebase");
                    const fn = httpsCallable<
                      { tourneeId: string },
                      { ok: true; messageId: string; sentTo: string; velosCount: number; filename: string; ref: string }
                    >(getFunctions(firebaseApp, "europe-west1"), "sendPreparationCsv");
                    const r = await fn({ tourneeId: tournee.tourneeId });
                    const d = r.data;
                    alert(
                      `✅ Mail envoyé à ${d.sentTo}\n` +
                        `Tournée : ${d.ref}\n` +
                        `${d.velosCount} vélos · pièce jointe ${d.filename}\n` +
                        `(copies en CC : toi + Maria)`,
                    );
                  } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    if (msg.includes("GMAIL_APP_PASSWORD")) {
                      alert(
                        "⚠ Le secret Gmail n'est pas encore configuré.\n" +
                          "Génère un mot de passe d'application sur https://myaccount.google.com/apppasswords " +
                          "(connecté en velos-cargo@artisansverts.energy) puis partage-le pour qu'il soit posé en secret Firebase.",
                      );
                    } else {
                      alert("Envoi échoué : " + msg);
                    }
                  } finally {
                    setBusy(null);
                  }
                }}
                disabled={busy === "exportCsvPrep"}
                className="text-xs px-3 py-1.5 rounded bg-emerald-600 text-white hover:bg-emerald-700 font-medium whitespace-nowrap disabled:opacity-50"
              >
                {busy === "exportCsvPrep" ? "⏳ Envoi…" : sentAt ? "↻ Renvoyer" : "📤 Envoyer à Tiffany"}
              </button>
            </div>
          </div>
          );
        })()}

        {/* Galerie photos CEE chargement (preuve TRA-EQ-131 pour COFRAC).
            Visible aux admin/superadmin uniquement (perms.canSeeAdminBlocs)
            dès qu'au moins 1 vélo de la tournée a une photoChargementUrl. */}
        {perms.canSeeAdminBlocs && tournee.tourneeId && progression && (() => {
          const photos: Array<{ veloId: string; fnuci: string | null; clientName: string; url: string }> = [];
          for (const c of progression.clients ?? []) {
            for (const v of c.velos ?? []) {
              if (v.photoChargementUrl) {
                photos.push({
                  veloId: v.veloId,
                  fnuci: v.fnuci,
                  clientName: c.entreprise || "?",
                  url: v.photoChargementUrl,
                });
              }
            }
          }
          if (photos.length === 0) return null;
          return (
            <div className="mb-3 border border-purple-200 bg-purple-50 rounded-lg">
              <button
                type="button"
                onClick={() => setGalleryOpen((v) => !v)}
                className="w-full flex items-center justify-between px-3 py-2 text-sm text-purple-900 font-medium hover:bg-purple-100 rounded-lg"
              >
                <span>📷 Photos CEE chargement ({photos.length})</span>
                <span className="text-xs">{galleryOpen ? "▲ replier" : "▼ déplier"}</span>
              </button>
              {galleryOpen && (
                <div className="px-3 pb-3 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                  {photos.map((p) => (
                    <a
                      key={p.veloId}
                      href={p.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block bg-white border border-purple-200 rounded overflow-hidden hover:border-purple-400"
                      title={`${p.clientName} · ${p.fnuci || "(pas de FNUCI)"}`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.url} alt={p.fnuci || "photo CEE"} className="w-full h-24 object-cover" />
                      <div className="px-2 py-1 text-[10px] text-purple-900">
                        <div className="font-mono truncate">{p.fnuci || "—"}</div>
                        <div className="truncate text-purple-700">{p.clientName}</div>
                      </div>
                    </a>
                  ))}
                </div>
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
                  <span key={s.key} className={`inline-flex items-center gap-1 text-[11px] sm:text-sm px-2 py-1 sm:px-3 sm:py-1.5 rounded-full border font-medium ${cls}`}>
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

        {/* Affectation équipe — visible selon perms */}
        {tournee.tourneeId && perms.canSeeEquipeRecap && !perms.canEditEquipe && (() => {
          // Récap lecture seule pour chauffeur / préparateur : juste les noms
          // de l'équipe affectée, sans bouton modifier. Pas le « gros carré »
          // d'admin.
          const liv0 = tournee.livraisons[0];
          const findMember = (id: string | null | undefined) => id ? equipe.find((m) => m.id === id) : undefined;
          const find = (id: string | null | undefined) => findMember(id)?.nom || null;
          const chauffeurMember = liv0?.chauffeurId && liv0.chauffeurId !== "__client__"
            ? findMember(liv0.chauffeurId)
            : undefined;
          // Sentinel "__client__" = camion client (Yoann 2026-05-01) :
          // pas de chauffeur Yoann, le client redistribue lui-même.
          const chauffeur = liv0?.chauffeurId === "__client__"
            ? "🚚 Chauffeur client"
            : find(liv0?.chauffeurId);
          const chefIds = (liv0?.chefEquipeIds && liv0.chefEquipeIds.length > 0)
            ? liv0.chefEquipeIds
            : (liv0?.chefEquipeId ? [liv0.chefEquipeId] : []);
          const chefs = chefIds.map(find).filter((x): x is string => !!x);
          const monteurs = (liv0?.monteurIds || []).map(find).filter((x): x is string => !!x);
          const preps = (liv0?.preparateurIds || []).map(find).filter((x): x is string => !!x);
          const renderLine = (icon: string, label: string, names: string[]) =>
            names.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 items-baseline">
                <span className="text-[11px] uppercase tracking-wide text-gray-500 w-24">{icon} {label}</span>
                <span className="text-sm text-gray-800">{names.join(", ")}</span>
              </div>
            ) : null;
          // Yoann 2026-05-03 : bouton WhatsApp pour chaque membre équipe
          // (chauffeur, chef, monteurs, préparateurs). Brief jour-J court,
          // l'utilisateur peut copier-coller le détail derrière.
          const totalVelos = tournee.totalVelos;
          const nbClients = tournee.livraisons.length;
          const heureDepart = liv0?.heureDepartTournee || null;
          const datePrev = liv0?.datePrevue || null;
          const sendBriefTo = (member: EquipeMember | undefined) => {
            if (!member?.telephone) return;
            const ok = openWhatsApp(member.telephone, tplBriefChauffeur({
              prenom: member.nom || null,
              datePrevue: datePrev,
              nbClients,
              nbVelos: totalVelos,
              heureDepart,
              signature: currentUser?.nom || "Vélos Cargo",
            }));
            if (!ok) alert(`Numéro de téléphone invalide pour ${member.nom}.`);
          };
          const renderMemberPill = (member: EquipeMember | undefined, fallbackName?: string) => {
            const name = member?.nom || fallbackName || "?";
            return (
              <span key={member?.id || name} className="inline-flex items-center gap-1 bg-white border border-gray-200 rounded px-1.5 py-0.5 text-xs">
                <span>{name}</span>
                {member?.telephone && (
                  <button
                    onClick={(e) => { e.stopPropagation(); sendBriefTo(member); }}
                    className="text-green-600 hover:text-green-700 leading-none"
                    title={`WhatsApp ${member.nom} (${member.telephone})`}
                  >
                    📱
                  </button>
                )}
              </span>
            );
          };
          const renderEquipeLine = (icon: string, label: string, members: Array<{ id: string; nom: string }>) => {
            if (members.length === 0) return null;
            return (
              <div className="flex flex-wrap gap-1.5 items-center">
                <span className="text-[11px] uppercase tracking-wide text-gray-500 w-24">{icon} {label}</span>
                <div className="flex flex-wrap gap-1">
                  {members.map((m) => renderMemberPill(findMember(m.id)))}
                </div>
              </div>
            );
          };
          const chefMembers = chefIds.map((id) => ({ id, nom: find(id) || "?" })).filter((m) => m.nom !== "?");
          const monteurMembers = (liv0?.monteurIds || []).map((id) => ({ id, nom: find(id) || "?" })).filter((m) => m.nom !== "?");
          const prepMembers = (liv0?.preparateurIds || []).map((id) => ({ id, nom: find(id) || "?" })).filter((m) => m.nom !== "?");
          return (
            <div className="mb-3 px-3 py-2 rounded-lg border bg-gray-50 space-y-1">
              {chauffeur && (
                <div className="flex flex-wrap gap-1.5 items-center">
                  <span className="text-[11px] uppercase tracking-wide text-gray-500 w-24">🚐 Chauffeur</span>
                  {liv0?.chauffeurId === "__client__" ? (
                    <span className="text-sm text-gray-800">{chauffeur}</span>
                  ) : (
                    renderMemberPill(chauffeurMember, chauffeur)
                  )}
                </div>
              )}
              {renderEquipeLine("🚦", "Chef d'équipe", chefMembers)}
              {renderEquipeLine("🔧", "Monteurs", monteurMembers)}
              {renderEquipeLine("📦", "Préparateurs", prepMembers)}
            </div>
          );
        })()}

        {tournee.tourneeId && perms.canEditEquipe && (() => {
          // Détecte une "tournée virtuelle" : tournee.tourneeId provient de
          // parseTourneeFromNotes (legacy) mais aucune livraison n'a ce
          // tourneeId persisté (ex: livraison reportée → tourneeId=null en
          // Firestore). Dans ce cas on passe tourneeId="" et on s'appuie sur
          // livraisonIds pour appliquer l'affectation par livraison.
          const hasRealTourneeId = tournee.livraisons.some((l) => l.tourneeId === tournee.tourneeId);
          const livIds = tournee.livraisons.map((l) => l.id);
          const liv0 = tournee.livraisons[0];
          return (
          <>
          <TourneeEntrepotSelect
            livraisonIds={livIds}
            initialEntrepotId={liv0?.entrepotOrigineId || null}
            initialMode={liv0?.modeMontage || null}
            onSaved={onChanged}
          />
          <EquipeAssignBlock
            tourneeId={hasRealTourneeId ? tournee.tourneeId : ""}
            livraisonIds={livIds}
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
          </>
          );
        })()}

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
            <div className="flex items-center gap-2 ml-auto flex-wrap">
              <span className="text-xs text-gray-500">{selected.size} sélectionnée{selected.size > 1 ? "s" : ""}</span>
              <button
                onClick={() => bulkAction("livree")}
                disabled={busy === "bulk"}
                className="px-2 py-1 text-xs bg-green-100 text-green-700 rounded-lg hover:bg-green-200 disabled:opacity-50"
              >
                Marquer livrées
              </button>
              <button
                onClick={reporterBulk}
                disabled={busy === "bulk" || busy === "report"}
                className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded-lg hover:bg-blue-200 disabled:opacity-50"
              >
                📅 Reporter
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
              {(() => {
                // Carte verte si les 4 étapes (prép, charg, livr, mont) sont à 100%.
                // Lit la progression du client correspondant. Le statut "annulee" et
                // "selected" priment sur le surlignage vert.
                const cp = progression?.clients?.find((c) => c.clientId === l.clientId)?.totals;
                const tot = cp?.total ?? l._count.velos;
                const allDone = !!cp && tot > 0
                  && cp.prepare >= tot && cp.charge >= tot && cp.livre >= tot && cp.monte >= tot;
                const wrapperCls = selected.has(l.id)
                  ? "bg-blue-50 border-blue-300"
                  : allDone
                    ? "bg-emerald-50 border-emerald-400"
                    : "";
                return (
              <div id={l.clientId ? `liv-card-${l.clientId}` : undefined} className={`border rounded-lg p-3 transition-all ${wrapperCls}`}>
                <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={selected.has(l.id)}
                  onChange={() => toggleSelect(l.id)}
                  className="shrink-0 mt-1"
                />
                <span className={`w-9 h-9 sm:w-7 sm:h-7 rounded-full text-white text-base sm:text-sm flex items-center justify-center font-semibold shrink-0 ${allDone ? "bg-emerald-600" : "bg-green-600"}`}>
                  {allDone ? "✓" : i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <a
                    href={l.clientId ? `${BASE_PATH}/clients/detail?id=${encodeURIComponent(l.clientId)}` : undefined}
                    onClick={(e) => e.stopPropagation()}
                    className="font-bold text-base sm:font-medium leading-tight hover:underline hover:text-blue-700 cursor-pointer block"
                    title="Ouvrir la fiche client"
                  >{l.client.entreprise}</a>
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
                  {l.statut === "annulee" && l.raisonAnnulation && (
                    <div className="mt-1 px-2 py-1 text-[11px] bg-amber-50 border border-amber-200 rounded text-amber-800">
                      ⊘ Annulée : {l.raisonAnnulation}
                    </div>
                  )}
                  {l.statut !== "annulee" && (!perms.isApporteurLocal && !perms.isChefTerrain) && (
                    <div className="mt-1">
                      {l.dejaChargee ? (
                        <div className="px-2 py-1 text-[11px] bg-indigo-50 border border-indigo-200 rounded text-indigo-800 flex items-center gap-2 flex-wrap">
                          <span className="font-medium">📦 Déjà chargée</span>
                          <span className="opacity-75">départ direct chez le client (~8h00)</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); toggleDejaChargee(l.id, true); }}
                            disabled={busy === l.id}
                            className="ml-auto text-[10px] underline opacity-60 hover:opacity-100"
                            title="Retirer le statut « déjà chargée »"
                          >
                            retirer
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleDejaChargee(l.id, false); }}
                          disabled={busy === l.id}
                          className="px-2 py-0.5 text-[11px] text-indigo-700 border border-indigo-300 rounded hover:bg-indigo-50"
                          title="Marquer la marchandise comme déjà dans le camion (saute le chargement, arrivée 8h)"
                        >
                          📦 Marquer « déjà chargée »
                        </button>
                      )}
                    </div>
                  )}
                  {/* Validation préalable client (téléphone / mail). Sans ça,
                      on n'envoie pas l'équipe — bandeau rouge si non validé. */}
                  {l.statut !== "annulee" && perms.canSeeAdminBlocs && (() => {
                    const v = l.validationClient;
                    if (v?.status === "validee_orale" || v?.status === "validee_mail") {
                      const dt = v.at ? new Date(v.at).toLocaleDateString("fr-FR") : "";
                      const icon = v.status === "validee_mail" ? "📧" : "📞";
                      const label = v.status === "validee_mail" ? "Mail reçu" : "Validé par téléphone";
                      return (
                        <div className="mt-1 px-2 py-1 text-[11px] bg-emerald-50 border border-emerald-200 rounded text-emerald-800 flex items-center gap-2 flex-wrap">
                          <span className="font-medium">{icon} {label}</span>
                          {v.par && <span className="opacity-75">par {v.par}</span>}
                          {dt && <span className="opacity-50">· {dt}</span>}
                          {v.note && <span className="opacity-75 italic">— « {v.note} »</span>}
                          <button
                            onClick={(e) => { e.stopPropagation(); validateClient(l.id, "non_contacte", currentUser?.nom || ""); }}
                            className="ml-auto text-[10px] underline opacity-60 hover:opacity-100"
                            title="Réinitialiser la validation"
                          >
                            modifier
                          </button>
                        </div>
                      );
                    }
                    return (
                      <div className="mt-1 px-2 py-1.5 text-[11px] bg-red-50 border border-red-300 rounded text-red-800">
                        <div className="font-medium mb-1">⚠ Client pas encore validé — pas de livraison sans confirmation</div>
                        <div className="flex gap-1.5 flex-wrap">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const tel = l.client?.telephone || null;
                              const c = l.clientId ? clientInfo.get(l.clientId) : null;
                              const adresse = [l.client?.adresse, l.client?.codePostal, l.client?.ville]
                                .filter(Boolean).join(", ");
                              const ok = openWhatsApp(tel, tplValidationLivraison({
                                contact: c?.contact || null,
                                entreprise: l.client?.entreprise || "",
                                nbVelos: l.nbVelos || l._count.velos || 0,
                                datePrevue: l.datePrevue,
                                creneau: null,
                                adresse: adresse || null,
                                signature: currentUser?.nom || "Vélos Cargo",
                              }));
                              if (!ok) alert(`Pas de numéro de téléphone valide pour ${l.client?.entreprise || "ce client"}.`);
                            }}
                            className="px-2 py-0.5 text-[11px] bg-white border border-green-400 text-green-700 rounded hover:bg-green-50"
                            title="Ouvre WhatsApp avec un message de validation pré-rempli"
                          >
                            📱 WhatsApp
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); validateClient(l.id, "validee_orale", currentUser?.nom || ""); }}
                            className="px-2 py-0.5 text-[11px] bg-white border border-emerald-300 text-emerald-700 rounded hover:bg-emerald-50"
                          >
                            📞 Validé par téléphone
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); validateClient(l.id, "validee_mail", currentUser?.nom || ""); }}
                            className="px-2 py-0.5 text-[11px] bg-white border border-emerald-300 text-emerald-700 rounded hover:bg-emerald-50"
                          >
                            📧 Mail reçu
                          </button>
                        </div>
                      </div>
                    );
                  })()}
                  {/* Workflow admin (Yoann 2026-05-01) : 2 toggles
                      complémentaires à "Validé par téléphone" pour traquer
                      les étapes administratives qui causent des oublis :
                      - 📁 Dossier complet : bureau a vérifié les docs CEE
                      - 💰 À déposer / 📥 Déposé : dossier remis pour
                        remboursement CEE (= prise de paiement) */}
                  {l.statut !== "annulee" && perms.canSeeAdminBlocs && (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleDossierConfirme(l.id, l.dossierConfirmeAt); }}
                        disabled={busy === l.id}
                        className={`px-2 py-0.5 text-[11px] rounded border ${
                          l.dossierConfirmeAt
                            ? "bg-emerald-100 border-emerald-400 text-emerald-800"
                            : "bg-white border-gray-300 text-gray-600 hover:bg-gray-50"
                        }`}
                        title={
                          l.dossierConfirmeAt
                            ? `Confirmé par ${l.dossierConfirmePar || "?"} · ${new Date(l.dossierConfirmeAt).toLocaleDateString("fr-FR")} (clic pour retirer)`
                            : "Marquer le dossier comme complet (bureau a vérifié devis + Kbis + attestation + signature)"
                        }
                      >
                        {l.dossierConfirmeAt ? "✅" : "☐"} Dossier complet
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleDepose(l.id, l.deposeAt); }}
                        disabled={busy === l.id}
                        className={`px-2 py-0.5 text-[11px] rounded border ${
                          l.deposeAt
                            ? "bg-emerald-100 border-emerald-400 text-emerald-800"
                            : "bg-amber-50 border-amber-300 text-amber-800 hover:bg-amber-100"
                        }`}
                        title={
                          l.deposeAt
                            ? `Déposé par ${l.deposePar || "?"} · ${new Date(l.deposeAt).toLocaleDateString("fr-FR")} (clic pour retirer)`
                            : "Marquer comme déposé (dossier remis pour remboursement CEE — prise de paiement)"
                        }
                      >
                        {l.deposeAt ? "📥 Déposé" : "💰 À déposer"}
                      </button>
                      {/* Liste FNUCI du client (Yoann 2026-05-01) :
                          accès rapide à tous les FNUCI assignés + état
                          stage par vélo. Utile pour COFRAC + traçabilité. */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (l.clientId) {
                            setFnuciListClient({
                              clientId: l.clientId,
                              entreprise: l.client.entreprise || "?",
                            });
                          }
                        }}
                        className="px-2 py-0.5 text-[11px] rounded border bg-white border-blue-300 text-blue-700 hover:bg-blue-50"
                        title="Voir tous les FNUCI du client (état stage par vélo, copier au format CSV pour COFRAC)"
                      >
                        📋 FNUCI
                      </button>
                      {/* Envoi BL à Franck (Yoann 2026-05-01) : déplacé du
                          terrain vers cette page admin. C'est Naomi (compta)
                          qui clique après préparation des BL — pas auto. */}
                      {l.clientId && tournee.tourneeId && (
                        <SendBlFranckBtn
                          tourneeId={tournee.tourneeId}
                          clientId={l.clientId}
                          clientName={l.client.entreprise || "?"}
                        />
                      )}
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
                      { key: "prepare", label: "Prép.", emoji: "📦", href: `${BASE_PATH}/preparation?tourneeId=${tid}${cid}` },
                      { key: "charge", label: "Charg.", emoji: "🚚", href: `${BASE_PATH}/chargement?tourneeId=${tid}${cid}` },
                      { key: "livre", label: "Livr.", emoji: "📍", href: `${BASE_PATH}/livraison?tourneeId=${tid}${cid}` },
                      { key: "monte", label: "Mont.", emoji: "🔧", href: `${BASE_PATH}/montage?tourneeId=${tid}${cid}` },
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
                  {perms.isApporteurLocal ? (
                    <span className="text-xs px-2 py-1 bg-gray-100 text-gray-700 rounded">
                      {l.statut === "planifiee" ? "Planifiée"
                        : l.statut === "en_cours" ? "En cours"
                        : l.statut === "livree" ? "Livrée"
                        : l.statut === "annulee" ? "Annulée" : l.statut}
                    </span>
                  ) : (
                    <>
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
                        <>
                          <button
                            onClick={() => reporter(l.id, l.client?.entreprise || "ce client")}
                            disabled={busy === l.id}
                            className="text-blue-500 hover:text-blue-700 text-xs whitespace-nowrap"
                            title="Reporter cette livraison à un autre jour (sort de la tournée courante)"
                          >
                            📅 reporter
                          </button>
                          <button
                            onClick={() => annuler(l.id)}
                            disabled={busy === l.id}
                            className="text-amber-500 hover:text-amber-700 text-xs whitespace-nowrap"
                          >
                            annuler
                          </button>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
                );
              })()}
            </div>
          ))}
          {retourSegment.distKm > 0 && (
            <div className="flex items-center gap-2 py-1 px-10 text-[10px] text-gray-400">
              <div className="border-l-2 border-dashed border-gray-300 h-3" />
              <span>↩ retour {ENTREPOT.label} · {retourSegment.distKm} km · ~{retourSegment.trajetMin} min</span>
            </div>
          )}
        </div>

        {(!perms.isApporteurLocal && !perms.isChefTerrain) && (
        <div className="mt-3">
          {addingClient ? (
            <div className="border rounded-lg p-3 bg-gray-50 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700">Ajouter un client à cette tournée</span>
                <button
                  onClick={() => { setAddingClient(false); setClientSearch(""); setSuggestion(null); setSuggestionError(null); }}
                  className="text-gray-400 hover:text-gray-600 text-xs"
                >
                  annuler
                </button>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={clientSearch}
                  onChange={(e) => setClientSearch(e.target.value)}
                  placeholder="Chercher un client (nom, ville, CP, contact)…"
                  className="flex-1 px-3 py-1.5 border rounded-lg text-sm"
                  autoFocus
                />
                {/* Bouton "auto" : Gemini choisit le meilleur candidat parmi
                    les 10 plus proches (Maps déjà appliqué côté tri haversine).
                    Met le résultat en évidence dans la liste — pas d'auto-ajout. */}
                <button
                  onClick={suggestBest}
                  disabled={suggesting || eligibleClients.length === 0}
                  title="Demander à Gemini de choisir le meilleur remplaçant"
                  className="px-3 py-1.5 bg-violet-600 text-white text-sm rounded-lg hover:bg-violet-700 disabled:opacity-50 whitespace-nowrap"
                >
                  {suggesting ? "🪄 …" : "🪄 Auto"}
                </button>
              </div>
              {suggestionError && (
                <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">
                  ⚠ {suggestionError}
                </div>
              )}
              {suggestion && (
                <div className="text-xs bg-violet-50 border border-violet-300 rounded px-2 py-1.5 text-violet-900">
                  🪄 <span className="font-semibold">Suggestion Gemini :</span> {suggestion.raison}
                  <div className="text-[10px] text-violet-700 mt-0.5">Clique sur la ligne mise en évidence pour confirmer.</div>
                </div>
              )}
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
                  const isSuggested = suggestion?.clientId === c.id;
                  return (
                    <button
                      key={c.id}
                      onClick={() => addClient(c.id, reste)}
                      disabled={!!busy}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left disabled:opacity-50 ${
                        isSuggested
                          ? "bg-violet-100 hover:bg-violet-200 ring-2 ring-violet-400"
                          : "hover:bg-blue-50"
                      }`}
                    >
                      {isSuggested && <span className="text-violet-600">🪄</span>}
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
        )}

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
            title="Réconciliation manuelle — sans scan, à utiliser uniquement en cas exceptionnel"
          >
            {busy === "all" ? "Mise à jour…" : "Tout marquer livré ⚠ sans scan"}
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
      {showBrief && (
        <BriefEquipeModal
          tournee={tournee}
          tourneeNumber={tourneeNumber}
          monteurs={monteurs}
          equipe={equipe}
          clientInfo={clientInfo}
          deployPlan={deployPlan}
          onClose={() => setShowBrief(false)}
        />
      )}
      {manualBonOpen && (
        <ManualBonModal
          tourneeId={tournee.tourneeId || ""}
          tourneeNumero={tournee.numero ?? null}
          totalVelos={tournee.totalVelos}
          onClose={() => setManualBonOpen(false)}
          onSaved={() => {
            setManualBonOpen(false);
            onChanged();
          }}
        />
      )}
      {fnuciListClient && (
        <FnuciListModal
          clientId={fnuciListClient.clientId}
          entreprise={fnuciListClient.entreprise}
          progression={progression}
          onClose={() => setFnuciListClient(null)}
        />
      )}
      {reportTargets && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-[70] p-4"
          onClick={() => { if (busy !== "report") { setReportTargets(null); setReportDate(""); } }}
        >
          <div
            className="bg-white rounded-xl p-5 w-full max-w-md space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div>
              <h3 className="text-lg font-bold text-gray-900">📅 Reporter</h3>
              <p className="text-sm text-gray-600 mt-1">
                {reportTargets.length === 1
                  ? <>Reporter la livraison de <strong>{reportTargets[0].entreprise}</strong> à un autre jour.</>
                  : <><strong>{reportTargets.length} livraisons</strong> seront reportées :</>}
              </p>
              {reportTargets.length > 1 && (
                <ul className="mt-2 max-h-32 overflow-y-auto bg-gray-50 rounded p-2 text-xs space-y-0.5 border border-gray-200">
                  {reportTargets.map((t) => (
                    <li key={t.id} className="text-gray-700">· {t.entreprise}</li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-amber-700 mt-2">
                ⚠ Sortent de la tournée courante et redeviennent &quot;à planifier&quot; pour la nouvelle date.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Nouvelle date</label>
              <input
                type="date"
                value={reportDate}
                onChange={(e) => setReportDate(e.target.value)}
                min={new Date().toISOString().slice(0, 10)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                autoFocus
              />
              {reportDate && /^\d{4}-\d{2}-\d{2}$/.test(reportDate) && (() => {
                const dt = new Date(`${reportDate}T09:00:00`);
                if (Number.isNaN(dt.getTime())) return null;
                return (
                  <p className="text-xs text-gray-500 mt-1 capitalize">
                    {dt.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
                  </p>
                );
              })()}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => { setReportTargets(null); setReportDate(""); }}
                disabled={busy === "report"}
                className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-50"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={executeReport}
                disabled={busy === "report" || !reportDate}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium"
              >
                {busy === "report"
                  ? "⏳ Report…"
                  : `Reporter ${reportTargets.length > 1 ? `${reportTargets.length} livraisons` : "la livraison"}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Modal de saisie manuelle d'un bon d'enlèvement (30-04 10h15). Yoann renseigne
// numéro de bon + quantité + URL Drive optionnelle quand le pipeline auto
// (gas-inbox → Gemini → Sheet GAS → syncFromGas → Firestore) a échoué pour un
// mail. Écrit directement dans bonsEnlevement avec manual: true.
function ManualBonModal({
  tourneeId,
  tourneeNumero,
  totalVelos,
  onClose,
  onSaved,
}: {
  tourneeId: string;
  tourneeNumero: number | null;
  totalVelos: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [numeroDoc, setNumeroDoc] = useState("");
  const [quantite, setQuantite] = useState<string>(String(totalVelos));
  const [driveUrl, setDriveUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!numeroDoc.trim()) {
      setErr("Numéro du bon obligatoire");
      return;
    }
    const q = parseInt(quantite, 10);
    if (!q || q <= 0) {
      setErr("Quantité invalide");
      return;
    }
    setBusy(true);
    try {
      const r = (await gasPost("addBonEnlevementManual", {
        tourneeId,
        tourneeNumero,
        numeroDoc: numeroDoc.trim(),
        quantite: q,
        driveUrl: driveUrl.trim() || undefined,
      })) as { ok?: boolean; error?: string };
      if (r.error) {
        setErr(r.error);
        return;
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-[70] p-4"
      onClick={() => { if (!busy) onClose(); }}
    >
      <form
        className="bg-white rounded-xl p-5 w-full max-w-md space-y-4"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <div>
          <h3 className="text-lg font-bold text-gray-900">📋 Saisir manuellement le bon d&apos;enlèvement</h3>
          <p className="text-xs text-gray-600 mt-1">
            À utiliser quand le mail Tiffany est arrivé mais que le pipeline auto
            n&apos;a pas réussi à l&apos;extraire (Gemini ou classification ratée).
            Tournée {tourneeNumero != null ? `n°${tourneeNumero}` : tourneeId}, {totalVelos} vélos prévus.
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Numéro du bon AXDIS *
          </label>
          <input
            type="text"
            value={numeroDoc}
            onChange={(e) => setNumeroDoc(e.target.value)}
            placeholder="ex : 354785"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            autoFocus
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Quantité de vélos *
          </label>
          <input
            type="number"
            value={quantite}
            onChange={(e) => setQuantite(e.target.value)}
            min={1}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          />
          {parseInt(quantite, 10) !== totalVelos && parseInt(quantite, 10) > 0 && (
            <p className="text-[11px] text-amber-700 mt-1">
              ⚠ Différent du nombre de vélos dans la tournée ({totalVelos}). Vérifie.
            </p>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            URL Drive du PDF (optionnel)
          </label>
          <input
            type="url"
            value={driveUrl}
            onChange={(e) => setDriveUrl(e.target.value)}
            placeholder="https://drive.google.com/..."
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          />
          <p className="text-[11px] text-gray-500 mt-1">
            Si tu colles l&apos;URL, le bouton &quot;Voir le PDF&quot; sera dispo. Sinon laisse vide.
          </p>
        </div>
        {err && (
          <div className="bg-red-50 border border-red-200 text-red-800 text-sm rounded p-2">
            {err}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-50"
          >
            Annuler
          </button>
          <button
            type="submit"
            disabled={busy}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium"
          >
            {busy ? "⏳ Enregistrement…" : "Enregistrer"}
          </button>
        </div>
      </form>
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
  const totalMontage = tournee.totalVelos * minutesParVelo(tournee.livraisons[0]?.modeMontage);
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
    // Toutes les livraisons d'une tournée partagent bonCommandeEnvoyeAt (write
    // simultané sur tout le groupe). On expose la 1re valeur trouvée.
    g.bonCommandeEnvoyeAt = g.livraisons.find((l) => l.bonCommandeEnvoyeAt)?.bonCommandeEnvoyeAt ?? null;
  }

  return Array.from(groups.values());
}

// Sélecteur entrepôt origine + mode montage pour la tournée (Yoann
// 2026-05-01). Mass-update toutes les livraisons de la tournée car elles
// partagent forcément le même point de départ.
type EntrepotMini = {
  id: string;
  nom: string;
  ville: string;
  role: "fournisseur" | "stock" | "ephemere";
  isPrimary: boolean;
  active: boolean;
  archived: boolean;
};
function TourneeEntrepotSelect({
  livraisonIds,
  initialEntrepotId,
  initialMode,
  onSaved,
}: {
  livraisonIds: string[];
  initialEntrepotId: string | null | undefined;
  initialMode: "client" | "atelier" | "client_redistribue" | null | undefined;
  onSaved?: () => void;
}) {
  const [entrepots, setEntrepots] = useState<EntrepotMini[]>([]);
  const [entrepotId, setEntrepotId] = useState<string>(initialEntrepotId || "");
  const [mode, setMode] = useState<"client" | "atelier" | "client_redistribue">(
    initialMode || "client",
  );
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, "entrepots"), (snap) => {
      const rows: EntrepotMini[] = [];
      for (const d of snap.docs) {
        const data = d.data();
        rows.push({
          id: d.id,
          nom: String(data.nom || ""),
          ville: String(data.ville || ""),
          role: data.role === "fournisseur" || data.role === "ephemere" ? data.role : "stock",
          isPrimary: !!data.isPrimary,
          active: data.active !== false,
          archived: !!data.dateArchivage,
        });
      }
      // Tri : actifs non-archivés d'abord, primary en haut
      rows.sort((a, b) => {
        if (a.archived !== b.archived) return a.archived ? 1 : -1;
        if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
        return a.nom.localeCompare(b.nom);
      });
      setEntrepots(rows);
    });
    return () => unsub();
  }, []);

  const dirty =
    (entrepotId || null) !== (initialEntrepotId || null) ||
    mode !== (initialMode || "client");

  const save = async () => {
    if (!livraisonIds.length) return;
    setBusy(true);
    try {
      await Promise.all(
        livraisonIds.map((id) =>
          gasPost("updateLivraison", {
            id,
            data: {
              entrepotOrigineId: entrepotId || null,
              modeMontage: mode,
            },
          }),
        ),
      );
      setSavedAt(Date.now());
      if (onSaved) onSaved();
    } catch (e) {
      alert("Échec : " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  const selected = entrepots.find((e) => e.id === entrepotId);

  return (
    <div className="bg-white border rounded-lg p-3 mb-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-gray-700">
          🏬 Entrepôt origine + mode montage
        </span>
        {savedAt && !dirty && <span className="text-[11px] text-green-600">✓ enregistré</span>}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Entrepôt départ tournée</label>
          <select
            value={entrepotId}
            onChange={(e) => setEntrepotId(e.target.value)}
            className="w-full px-3 py-2 border rounded-lg text-sm bg-white"
          >
            <option value="">— AXDIS par défaut (héritage)</option>
            {entrepots.map((e) => (
              <option key={e.id} value={e.id} disabled={e.archived || !e.active}>
                {e.isPrimary ? "🏭 " : e.role === "ephemere" ? "🟣 " : "📦 "}
                {e.nom} ({e.ville})
                {e.archived ? " — archivé" : !e.active ? " — inactif" : ""}
              </option>
            ))}
          </select>
          {selected && selected.role === "ephemere" && (
            <div className="text-[11px] text-purple-700 mt-1">
              Entrepôt éphémère : préparation + montage sur place, puis client redistribue.
            </div>
          )}
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Mode de montage</label>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as "client" | "atelier" | "client_redistribue")}
            className="w-full px-3 py-2 border rounded-lg text-sm bg-white"
          >
            <option value="client">📦 Cartons + montage chez le client (équipe complète)</option>
            <option value="atelier">🔧 Vélos pré-assemblés atelier (chauffeur seul + chef)</option>
            <option value="client_redistribue">🟣 Éphémère : client redistribue, chef Yoann à bord</option>
          </select>
        </div>
      </div>
      <div className="mt-3 flex justify-end">
        <button
          onClick={save}
          disabled={!dirty || busy}
          className="px-3 py-1.5 text-xs font-medium rounded-lg disabled:opacity-50 bg-blue-600 text-white hover:bg-blue-700"
        >
          {busy ? "Enregistrement…" : "Enregistrer"}
        </button>
      </div>
    </div>
  );
}

function EquipeAssignBlock({
  tourneeId,
  livraisonIds,
  isRetrait,
  initialChauffeurId,
  initialChefEquipeIds,
  initialMonteurIds,
  initialPreparateurIds,
  onSaved,
  onMonteurCountChange,
}: {
  tourneeId: string;
  /** IDs des livraisons composant la tournée — utilisés en fallback quand
   *  tourneeId est vide (tournée virtuelle issue d'un report) pour appliquer
   *  l'affectation livraison-par-livraison. */
  livraisonIds?: string[];
  isRetrait: boolean;
  initialChauffeurId: string | null;
  initialChefEquipeIds: string[];
  initialMonteurIds: string[];
  initialPreparateurIds: string[];
  onSaved: () => void;
  onMonteurCountChange?: (count: number) => void;
}) {
  const { equipe } = useData();
  const currentUser = useCurrentUser();
  // Filtre les IDs orphelins (anciens membres supprimés ou jamais migrés)
  // dès l'initialisation : sinon le compteur affiche "1 sélectionné" sans
  // qu'aucun pill ne soit highlighté → l'utilisateur ne peut pas le retirer.
  // Au prochain save, la liste nettoyée écrasera la version Firestore.
  const validIds = new Set(equipe.map((m) => m.id));
  const cleanArr = (arr: string[]) => arr.filter((id) => validIds.has(id));
  const [chauffeurId, setChauffeurId] = useState<string>(
    initialChauffeurId && validIds.has(initialChauffeurId) ? initialChauffeurId : "",
  );
  const [chefEquipeIds, setChefEquipeIds] = useState<string[]>(cleanArr(initialChefEquipeIds));
  const [monteurIds, setMonteurIds] = useState<string[]>(cleanArr(initialMonteurIds));
  const [preparateurIds, setPreparateurIds] = useState<string[]>(cleanArr(initialPreparateurIds));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const chauffeurs = equipe.filter((m) => m.role === "chauffeur" && m.actif !== false);
  const chefs = equipe.filter((m) => m.role === "chef" && m.actif !== false);
  // Liste monteurs : monteurs déclarés + chefs polyvalents (aussiMonteur=true)
  // Yoann 2026-05-01 : un chef peut aussi être monteur sans dupliquer son
  // compte. Salaire compté une seule fois (sur le rôle chef principal).
  const monteurs = equipe.filter(
    (m) => m.actif !== false && (m.role === "monteur" || (m.role === "chef" && m.aussiMonteur === true)),
  );
  const preparateurs = equipe.filter((m) => m.role === "preparateur" && m.actif !== false);

  const hasEquipe = equipe.length > 0;
  // Compare contre les versions nettoyées des props initiales : si la liste
  // Firestore contient un ID orphelin, on veut que le bouton "Enregistrer"
  // s'active automatiquement pour que l'user puisse purger d'un clic.
  const dirty =
    chauffeurId !== (initialChauffeurId && validIds.has(initialChauffeurId) ? initialChauffeurId : "") ||
    JSON.stringify([...chefEquipeIds].sort()) !== JSON.stringify(cleanArr(initialChefEquipeIds).sort()) ||
    JSON.stringify([...monteurIds].sort()) !== JSON.stringify(cleanArr(initialMonteurIds).sort()) ||
    JSON.stringify([...preparateurIds].sort()) !== JSON.stringify(cleanArr(initialPreparateurIds).sort());

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const fields = {
        chauffeurId: chauffeurId || "",
        chefEquipeId: chefEquipeIds[0] || "",
        chefEquipeIds,
        monteurIds,
        preparateurIds,
      };
      // Cas standard : la tournée a un tourneeId Firestore → bulk update.
      // Cas tournée virtuelle (livraison reportée → tourneeId=null côté Firestore,
      // groupée en virtuel par le frontend par date+chauffeur) : on n'a pas de
      // tourneeId, donc on fait l'assignment par livraisonId, sur chaque
      // livraison de la "tournée virtuelle".
      if (tourneeId) {
        const r = await gasPost("assignTournee", { tourneeId, ...fields });
        if ((r as { error?: string }).error) throw new Error((r as { error?: string }).error);
      } else {
        if (!livraisonIds || livraisonIds.length === 0) {
          throw new Error("Aucune livraison à mettre à jour");
        }
        const results = await Promise.all(
          livraisonIds.map((lid) => gasPost("assignTournee", { livraisonId: lid, ...fields })),
        );
        for (const r of results) {
          if ((r as { error?: string }).error) throw new Error((r as { error?: string }).error);
        }
      }
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
          <label className="block text-xs text-gray-500 mb-1">
            🚚 Chauffeur
            {currentUser?.role === "chef" && <span className="ml-1 text-[10px] text-gray-400">(lecture seule)</span>}
          </label>
          <select
            value={chauffeurId}
            onChange={(e) => setChauffeurId(e.target.value)}
            className="w-full px-3 py-2 border rounded-lg text-sm bg-white disabled:bg-gray-50 disabled:text-gray-500"
            disabled={!hasEquipe || currentUser?.role === "chef"}
          >
            <option value="">— non affecté —</option>
            <option value="__client__">🚚 Chauffeur du client (camion client)</option>
            {chauffeurs.map((m) => (
              <option key={m.id} value={m.id}>
                {m.nom}
              </option>
            ))}
          </select>
          {chauffeurId === "__client__" && (
            <div className="mt-1 text-[11px] text-purple-700">
              Le client redistribue avec son propre camion. Pas de chauffeur Yoann mobilisé.
              Le chef d&apos;équipe Yoann l&apos;accompagne pour BL signature + COFRAC.
            </div>
          )}
        </div>
      )}

      {/* Yoann 2026-05-03 : chef d équipe (Ricky/Nordine) ne peut PAS
          modifier les chefs / préparateurs / chauffeur, seulement ses
          monteurs. Les pills sont visibles mais grisées + non cliquables. */}
      <div className="mb-3">
        <label className="block text-xs text-gray-500 mb-1">
          👷 Chef{chefEquipeIds.length > 1 ? "s" : ""} d&apos;équipe <span className="text-gray-400">({chefEquipeIds.length} sélectionné{chefEquipeIds.length > 1 ? "s" : ""})</span>
          {currentUser?.role === "chef" && <span className="ml-1 text-[10px] text-gray-400">(lecture seule)</span>}
        </label>
        {chefs.length === 0 ? (
          <div className="text-xs text-gray-400 italic">Aucun chef enregistré</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {chefs.map((m) => {
              const on = chefEquipeIds.includes(m.id);
              const lock = currentUser?.role === "chef";
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => { if (!lock) toggleChef(m.id); }}
                  disabled={lock}
                  className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                    lock && !on
                      ? "bg-gray-50 border-gray-200 text-gray-400 cursor-not-allowed"
                      : on
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
          {currentUser?.role === "chef" && <span className="ml-1 text-[10px] text-gray-400">(lecture seule)</span>}
        </label>
        {preparateurs.length === 0 ? (
          <div className="text-xs text-gray-400 italic">Aucun préparateur enregistré</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {preparateurs.map((m) => {
              const on = preparateurIds.includes(m.id);
              const lock = currentUser?.role === "chef";
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => { if (!lock) togglePreparateur(m.id); }}
                  disabled={lock}
                  className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                    lock && !on
                      ? "bg-gray-50 border-gray-200 text-gray-400 cursor-not-allowed"
                      : on
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
          <>
            {/* Auto-sélection par chef d équipe (Yoann 2026-05-01) :
                regroupe les monteurs par chefId, propose un bouton par chef
                qui a au moins 1 monteur rattaché. Click = toggle de toute
                la team (si tous coches -> tous decochés, sinon tous coches).
                Garde les monteurs déjà sélectionnés des autres chefs. */}
            {(() => {
              const teamsByChef = new Map<string, { chef: typeof chefs[number]; monteurs: typeof monteurs }>();
              for (const m of monteurs) {
                if (!m.chefId) continue;
                const chef = chefs.find((c) => c.id === m.chefId);
                if (!chef) continue;
                if (!teamsByChef.has(chef.id)) teamsByChef.set(chef.id, { chef, monteurs: [] });
                teamsByChef.get(chef.id)!.monteurs.push(m);
              }
              const teams = Array.from(teamsByChef.values());
              if (teams.length === 0) return null;
              // Calcul masse salariale prévisionnelle par team :
              // somme des salaires journaliers des monteurs sélectionnés de
              // chaque team. Yoann 2026-05-01.
              const fmtEur = (n: number) => `${Math.round(n)} €`;
              const totalSelectedAcrossAllTeams = monteurs
                .filter((m) => monteurIds.includes(m.id))
                .reduce((s, m) => s + (m.salaireJournalier || 0), 0);
              return (
                <div className="mb-2">
                  <div className="flex flex-wrap gap-1.5 items-center">
                    <span className="text-[11px] text-gray-500">Sélection rapide par équipe :</span>
                    {teams.map(({ chef, monteurs: teamMonteurs }) => {
                      const allSelected = teamMonteurs.every((m) => monteurIds.includes(m.id));
                      const someSelected = teamMonteurs.some((m) => monteurIds.includes(m.id));
                      const teamIds = teamMonteurs.map((m) => m.id);
                      // Coût total team si TOUS les monteurs sélectionnés
                      const teamFullCost = teamMonteurs.reduce((s, m) => s + (m.salaireJournalier || 0), 0);
                      // Coût actuel = somme des salaires des monteurs déjà cochés de cette team
                      const teamCurrentCost = teamMonteurs
                        .filter((m) => monteurIds.includes(m.id))
                        .reduce((s, m) => s + (m.salaireJournalier || 0), 0);
                      return (
                        <button
                          key={chef.id}
                          type="button"
                          onClick={() => {
                            setMonteurIds((prev) => {
                              let next: string[];
                              if (allSelected) {
                                next = prev.filter((id) => !teamIds.includes(id));
                              } else {
                                next = Array.from(new Set([...prev, ...teamIds]));
                              }
                              onMonteurCountChange?.(Math.max(1, next.length));
                              return next;
                            });
                          }}
                          className={`text-[11px] px-2 py-1 rounded-full border ${
                            allSelected
                              ? "bg-blue-600 text-white border-blue-600"
                              : someSelected
                                ? "bg-blue-100 text-blue-800 border-blue-300"
                                : "bg-white text-gray-700 border-gray-300 hover:bg-blue-50"
                          }`}
                          title={`Team ${chef.nom} : ${teamMonteurs.map((m) => `${m.nom} (${m.salaireJournalier || 0}€/j)`).join(", ")}\n\nCoût total team complète : ${fmtEur(teamFullCost)}/j`}
                        >
                          {allSelected ? "✓" : someSelected ? "◐" : "+"} Team {chef.nom} ({teamMonteurs.length})
                          <span className={`ml-1 ${allSelected ? "opacity-90" : "opacity-70"}`}>
                            {someSelected
                              ? `· ${fmtEur(teamCurrentCost)}${!allSelected ? `/${fmtEur(teamFullCost)}` : ""}/j`
                              : `· ${fmtEur(teamFullCost)}/j`}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {/* Bandeau total équipe terrain sélectionnée. Inclut tous les
                      monteurs cochés (team + indépendants). */}
                  {monteurIds.length > 0 && (
                    <div className="mt-1.5 text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded px-2 py-1 inline-block">
                      💶 Coût monteurs sélectionnés : <strong>{fmtEur(totalSelectedAcrossAllTeams)}/j</strong>
                      <span className="opacity-70"> ({monteurIds.length} monteur{monteurIds.length > 1 ? "s" : ""})</span>
                    </div>
                  )}
                </div>
              );
            })()}
            <div className="flex flex-wrap gap-1.5">
              {monteurs.map((m) => {
                const on = monteurIds.includes(m.id);
                const chef = m.chefId ? chefs.find((c) => c.id === m.chefId) : null;
                const isChefPolyvalent = m.role === "chef" && m.aussiMonteur;
                // Yoann 2026-05-03 : chef d équipe ne peut sélectionner que
                // SES monteurs. Visibles mais grisés / non-cliquables sinon.
                const horsEquipe =
                  currentUser?.role === "chef" && m.chefId !== currentUser?.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => { if (!horsEquipe) toggleMonteur(m.id); }}
                    disabled={horsEquipe}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                      horsEquipe
                        ? "bg-gray-100 border-gray-200 text-gray-400 cursor-not-allowed"
                        : on
                          ? "bg-emerald-600 text-white border-emerald-600"
                          : isChefPolyvalent
                            ? "bg-purple-50 border-purple-300 text-purple-800 hover:bg-purple-100"
                            : "border-gray-300 text-gray-700 hover:bg-gray-50"
                    }`}
                    title={
                      horsEquipe
                        ? "Hors équipe — seul son chef peut le sélectionner"
                        : isChefPolyvalent
                          ? `${m.nom} — Chef polyvalent (peut aussi monter sur place)`
                          : chef
                            ? `Team ${chef.nom}`
                            : "Monteur indépendant"
                    }
                  >
                    {on ? "✓ " : ""}
                    {m.nom}
                    {isChefPolyvalent && <span className={`ml-1 text-[10px] ${on ? "opacity-80" : "opacity-60"}`}>· chef</span>}
                    {chef && <span className={`ml-1 text-[10px] ${on ? "opacity-80" : "opacity-50"}`}>· {chef.nom}</span>}
                  </button>
                );
              })}
            </div>
          </>
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

// Mail sortant à AXDIS (Tiffany) pour passer la commande de la veille.
// La référence textuelle "VELO CARGO - TOURNEE X" sert de clé de matching
// quand le bon de commande reviendra par mail (à brancher plus tard).
const AXDIS_EMAIL = "Tiffany@axdis.fr";

function tourneeRefAxdis(numero: number | null | undefined, fallbackTourneeId: string | null): string {
  if (typeof numero === "number") return `VELO CARGO - TOURNEE ${numero}`;
  return `VELO CARGO - ${fallbackTourneeId || "SANS-NUMERO"}`;
}

function buildAxdisCommandeMail(tournee: Tournee): { subject: string; body: string; url: string } {
  const ref = tourneeRefAxdis(tournee.numero ?? null, tournee.tourneeId);
  // Cas retrait dédié à un client : on enrichit le subject + body avec le
  // nom du client (Yoann 2026-05-01 : "TOURNEE 19" tout seul prête à
  // confusion pour Tiffany — elle ne sait pas qui c'est). La référence
  // technique reste inchangée pour matching trigger.
  const isRetrait = tournee.mode === "retrait";
  const livActives = tournee.livraisons.filter((l) => l.statut !== "annulee");
  const clientUnique = livActives.length === 1 ? (livActives[0].client?.entreprise || null) : null;
  const contextLabel = isRetrait
    ? clientUnique
      ? `RETRAIT ${clientUnique.toUpperCase()}`
      : "RETRAIT"
    : null;
  const subject = contextLabel
    ? `Commande ${ref} - ${contextLabel}`
    : `Commande ${ref}`;
  const body = [
    `Bonjour Tiffany,`,
    ``,
    isRetrait && clientUnique
      ? `Merci de préparer la commande pour le RETRAIT chez ${clientUnique} :`
      : isRetrait
        ? `Merci de préparer la commande pour le RETRAIT de demain :`
        : `Merci de préparer la commande pour la tournée de demain :`,
    ``,
    `  → ${tournee.totalVelos} vélos`,
    ``,
    `Référence à reporter sur le bon de commande :`,
    ref + (contextLabel ? ` (${contextLabel})` : ""),
    ``,
    `Merci,`,
    `Yoann`,
  ].join("\n");
  const url =
    `https://mail.google.com/mail/?authuser=${encodeURIComponent(FROM_EMAIL_RAPPEL)}` +
    `&view=cm&fs=1&to=${encodeURIComponent(AXDIS_EMAIL)}` +
    `&su=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(body)}`;
  return { subject, body, url };
}

async function markBonCommandeEnvoye(tournee: Tournee): Promise<void> {
  const now = new Date().toISOString();
  await Promise.all(
    tournee.livraisons.map((l) =>
      gasPost("updateLivraison", { id: l.id, data: { bonCommandeEnvoyeAt: now } }),
    ),
  );
}

function BatchAxdisModal({
  date,
  tournees,
  onClose,
  onChanged,
}: {
  date: Date;
  tournees: Tournee[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [sentLocal, setSentLocal] = useState<Set<string>>(() => {
    const s = new Set<string>();
    tournees.forEach((t) => {
      if (t.bonCommandeEnvoyeAt) s.add(keyForTournee(t));
    });
    return s;
  });
  const dateLabel = date.toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const totalVelos = tournees.reduce((sum, t) => sum + t.totalVelos, 0);

  const sendOne = async (t: Tournee) => {
    const k = keyForTournee(t);
    setBusy(k);
    try {
      const { url } = buildAxdisCommandeMail(t);
      window.open(url, "_blank");
      await markBonCommandeEnvoye(t);
      setSentLocal((prev) => {
        const next = new Set(prev);
        next.add(k);
        return next;
      });
      onChanged();
    } catch (e) {
      console.error("BatchAxdis sendOne failed", e);
      alert(`Échec écriture Firestore pour tournée ${t.numero}. Le mail s'est ouvert quand même — réessaie pour marquer "envoyé".`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-start mb-4">
          <div>
            <h2 className="text-lg font-bold text-gray-900 capitalize">Commandes AXDIS — {dateLabel}</h2>
            <p className="text-sm text-gray-600">
              {tournees.length} tournée{tournees.length > 1 ? "s" : ""} · {totalVelos} vélos au total · 1 mail par tournée
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded p-2 text-[11px] text-amber-900 mb-3">
          Clique <strong>Ouvrir le mail</strong> sur chaque ligne. Gmail s&apos;ouvre dans un nouvel onglet, tu cliques <strong>Envoyer</strong>, puis tu reviens ici pour la tournée suivante.
        </div>

        <ul className="space-y-2">
          {tournees.map((t) => {
            const k = keyForTournee(t);
            const sent = sentLocal.has(k);
            const ref = tourneeRefAxdis(t.numero ?? null, t.tourneeId);
            return (
              <li
                key={k}
                className={`flex items-center justify-between gap-3 border rounded-lg px-3 py-2 ${
                  sent ? "bg-emerald-50 border-emerald-300" : "bg-white border-gray-200"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm">
                    {sent && <span className="mr-1">✅</span>}
                    {ref}
                  </div>
                  <div className="text-xs text-gray-600">
                    {t.totalVelos} vélos · {t.livraisons.length} arrêt{t.livraisons.length > 1 ? "s" : ""}
                  </div>
                </div>
                <button
                  onClick={() => sendOne(t)}
                  disabled={busy === k}
                  className={`px-3 py-1.5 text-xs rounded-lg whitespace-nowrap ${
                    sent
                      ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-200"
                      : "bg-amber-600 text-white hover:bg-amber-700"
                  } disabled:opacity-50`}
                >
                  {busy === k ? "..." : sent ? "📧 Renvoyer" : "📧 Ouvrir le mail"}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="mt-4 flex justify-end">
          <button onClick={onClose} className="px-4 py-1.5 bg-gray-100 text-gray-700 rounded-lg text-sm hover:bg-gray-200">
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}

function keyForTournee(t: Tournee): string {
  return (t.tourneeId || `solo-${t.livraisons[0]?.id || "x"}`) + "|" + (t.datePrevue || "no-date");
}

function fmtHM(totalMinutesFromMidnight: number): string {
  const total = Math.max(0, totalMinutesFromMidnight);
  const h = Math.floor(total / 60);
  const m = Math.round(total % 60);
  // Format compact "8h30" (sans zéro-padding sur l'heure) — utilisé partout
  // (cartes tournée, fenêtres de livraison, etc.).
  return `${h}h${String(m).padStart(2, "0")}`;
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
      const montageStop = ((l.nbVelos || 0) * minutesParVelo(l.modeMontage)) / Math.max(1, monteurs);
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

  // Chef d'équipe joignable le jour J — on cherche dans l'ordre des
  // chefEquipeIds le premier qui (a) existe encore dans /equipe (b) a un
  // téléphone renseigné. NB : chefEquipeIds peut contenir des IDs orphelins
  // (anciens membres supprimés non purgés de la liste) — on les saute. Si
  // on ne trouve personne avec un tél, on retombe sur le wording générique.
  const chefEquipeRef = (() => {
    const liv0 = tournee.livraisons[0];
    if (!liv0) return null;
    const candidateIds: string[] = [
      ...(liv0.chefEquipeIds || []),
      ...(liv0.chefEquipeId ? [liv0.chefEquipeId] : []),
    ];
    // 1er passage : chercher quelqu'un qui existe ET a un téléphone
    for (const id of candidateIds) {
      const m = equipe.find((x) => x.id === id);
      if (m && m.telephone) {
        return { nom: m.nom || "", telephone: m.telephone };
      }
    }
    // 2e passage : prendre le 1er chef qui existe (au moins on peut le nommer)
    for (const id of candidateIds) {
      const m = equipe.find((x) => x.id === id);
      if (m) return { nom: m.nom || "", telephone: "" };
    }
    return null;
  })();

  const buildMail = (st: typeof stops[number]) => {
    const cid = st.livraison.clientId;
    const c = cid ? clientInfo.get(cid) : null;
    const nbVelos = st.livraison.nbVelos || 0;
    const debut = fmtHM(roundDown30(st.arriveeMin));
    const fin = fmtHM(roundUp30(st.arriveeMin + FENETRE_HEURES * 60));
    const subject = `Rappel livraison vélos cargo le ${dateObj ? dateObj.toLocaleDateString("fr-FR", { day: "numeric", month: "long" }) : ""} — fenêtre ${debut}-${fin}`;
    const chefContact = chefEquipeRef?.telephone
      ? `${chefEquipeRef.nom ? chefEquipeRef.nom + " " : ""}au ${chefEquipeRef.telephone}`
      : null;
    const body = [
      `Bonjour${c?.contact ? " " + c.contact : ""},`,
      ``,
      `Petit rappel : votre livraison de ${nbVelos} vélo${nbVelos > 1 ? "s" : ""} cargo est confirmée pour ${dateLabel}.`,
      ``,
      `Fenêtre de passage estimée : entre ${debut} et ${fin}.`,
      `Adresse : ${c?.adresse || ""}${c?.codePostal ? ", " + c.codePostal : ""}${c?.ville ? " " + c.ville : ""}.`,
      ``,
      `Merci de prévoir une personne sur place pour la réception et la signature du procès-verbal de livraison.`,
      `⚠️ Le tampon de l'entreprise est impératif sur le PV au moment de la livraison — sans tampon, le dossier CEE ne peut pas être finalisé.`,
      ``,
      chefContact
        ? `En cas d'imprévu (retard, fenêtre serrée, accès difficile), appelez directement le chef d'équipe ${chefContact}, ou répondez à ce mail.`
        : `En cas d'imprévu (retard, fenêtre serrée, accès difficile), répondez à ce mail ou appelez-nous.`,
      ``,
      `Cordialement,`,
      `L'équipe Artisans Verts Energy`,
      ``,
      `———————————————`,
      `* Rappel important : les vélos cargo livrés dans le cadre de cette opération CEE sont strictement personnels à votre société. Toute revente, cession ou mise en location à un tiers est formellement interdite et peut entraîner la révocation des aides perçues.`,
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

// Multi-select dropdown intervenants (chauffeur/chef/monteur/préparateur/apporteur).
// Pattern : bouton qui affiche le résumé, panneau qui s'ouvre avec checkboxes
// groupées par rôle. Tous les groupes filtrent par OR (tournée visible si au
// moins un filtre matche).
// Modale « Brief du jour » : génère un texte narratif POUR TOUTES les
// tournées de la date affichée. Trie par heure de départ chaînée et met en
// évidence les enchaînements chauffeur (T1 puis T2 du même chauffeur).
type SessionAtelierForBrief = {
  id: string;
  date: string;
  heureDebut?: string | null;
  heureFin?: string | null;
  entrepotId: string;
  entrepotNom: string;
  monteurIds: string[];
  monteurNoms: string[];
  chefId?: string | null;
  chefNom?: string | null;
  chefAdminTerrainId?: string | null;
  chefAdminTerrainNom?: string | null;
  tourneeNumeros?: number[];
  quantitePrevue?: number | null;
  statut: "planifiee" | "en_cours" | "terminee" | "annulee";
};

function BriefJourneeModal({
  refDate,
  tournees,
  equipe,
  clientInfo,
  tourneeDepartures,
  sessionsAtelier = [],
  onClose,
}: {
  refDate: Date;
  tournees: Tournee[];
  equipe: EquipeMember[];
  clientInfo: Map<string, ClientPoint>;
  tourneeDepartures: DepartureMap;
  sessionsAtelier?: SessionAtelierForBrief[];
  onClose: () => void;
}) {
  // Permet de générer le brief pour n'importe quel jour. Défaut = date
  // visible dans le planning (refDate) si elle a des tournées, sinon le
  // prochain jour avec des tournées dans la semaine. Avant : défaut = demain
  // mais à minuit "demain" devenait le surlendemain → brief vide pour la
  // journée actuelle (Yoann 30-04 00h00).
  const tomorrow = useMemo(() => {
    const d = new Date(refDate);
    d.setDate(d.getDate() + 1);
    return d;
  }, [refDate]);
  const initialDate = useMemo(() => {
    const refIso = isoDate(refDate);
    const isPlanned = (iso: string) => tournees.some(
      (t) => t.datePrevue && isoDate(t.datePrevue) === iso && t.statutGlobal !== "annulee",
    );
    if (isPlanned(refIso)) return refIso;
    // sinon cherche le prochain jour planifié dans les 14 jours suivants
    for (let i = 1; i <= 14; i++) {
      const d = new Date(refDate); d.setDate(d.getDate() + i);
      const iso = isoDate(d);
      if (isPlanned(iso)) return iso;
    }
    return refIso;
  }, [refDate, tournees]);
  const [selectedDate, setSelectedDate] = useState<string>(initialDate);
  const briefDate = useMemo(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) return tomorrow;
    return new Date(`${selectedDate}T12:00:00`);
  }, [selectedDate, tomorrow]);

  // Yoann 2026-05-03 — Notes logistique du jour (cascades inter-équipes,
  // ex : "ETHAN finit FIRAT puis rejoint Armel pour montage in situ pendant
  // que Zinédine fait des navettes"). Affichées en haut du brief WhatsApp
  // ET injectées dans le prompt strategieGemini côté backend.
  // Persistance Firestore sur briefsJour/{date} via setBriefJourNotes.
  const currentUser = useCurrentUser();
  const [notesJour, setNotesJour] = useState<string>("");
  const [notesJourLoaded, setNotesJourLoaded] = useState<string>(""); // dernière valeur sauvegardée
  const [notesJourSaving, setNotesJourSaving] = useState(false);
  const [notesJourSavedAt, setNotesJourSavedAt] = useState<number | null>(null);
  const notesDirty = notesJour !== notesJourLoaded;

  // Charge la note Firestore en live (onSnapshot) pour la date sélectionnée
  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) return;
    const unsub = onSnapshot(doc(db, "briefsJour", selectedDate), (snap) => {
      const data = snap.exists() ? (snap.data() as { notes?: string }) : null;
      const txt = String(data?.notes || "");
      setNotesJour(txt);
      setNotesJourLoaded(txt);
    }, () => {
      // si erreur (rules / réseau), on garde la note locale en cours
    });
    return unsub;
  }, [selectedDate]);

  const saveNotesJour = useCallback(async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) return;
    setNotesJourSaving(true);
    try {
      const r = await gasPost("setBriefJourNotes", {
        date: selectedDate,
        notes: notesJour,
        updatedBy: currentUser?.nom || null,
      });
      if (r && (r as { ok?: boolean }).ok) {
        setNotesJourLoaded(notesJour);
        setNotesJourSavedAt(Date.now());
      }
    } catch {
      // erreur réseau : on laisse le bouton actif pour retry
    } finally {
      setNotesJourSaving(false);
    }
  }, [selectedDate, notesJour, currentUser]);

  // Auto-save debounced 2s : si la note locale diverge de la valeur Firestore
  // pendant > 2s sans nouvelle frappe, on persiste automatiquement.
  useEffect(() => {
    if (!notesDirty) return;
    const t = setTimeout(() => {
      void saveNotesJour();
    }, 2000);
    return () => clearTimeout(t);
  }, [notesDirty, notesJour, saveNotesJour]);

  // Yoann 2026-05-03 — Dictée vocale (Yoann en voiture, mains libres).
  // Why: speech-to-text natif évite de taper le brief au volant.
  // webkitSpeechRecognition supporté Chrome Mac/Android + Safari iOS 14.5+,
  // mode continu fr-FR, append des transcripts finaux à la note existante.
  // L'interim s'affiche en grisé pour feedback live.
  const recognitionRef = useRef<unknown>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [interimText, setInterimText] = useState("");
  const speechSupported = useMemo(() => {
    if (typeof window === "undefined") return false;
    return "webkitSpeechRecognition" in window || "SpeechRecognition" in window;
  }, []);
  const toggleRecording = useCallback(() => {
    if (typeof window === "undefined") return;
    const w = window as unknown as {
      SpeechRecognition?: new () => unknown;
      webkitSpeechRecognition?: new () => unknown;
    };
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR) {
      alert("Ton navigateur ne supporte pas la dictée vocale. Utilise Chrome ou Safari iOS récent.");
      return;
    }
    if (isRecording) {
      try {
        (recognitionRef.current as { stop?: () => void } | null)?.stop?.();
      } catch {
        // ignore
      }
      return;
    }
    const r = new SR() as {
      lang: string;
      continuous: boolean;
      interimResults: boolean;
      onresult: (ev: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void;
      onerror: (e: { error?: string }) => void;
      onend: () => void;
      start: () => void;
      stop: () => void;
    };
    r.lang = "fr-FR";
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (ev) => {
      let finalChunk = "";
      let interimChunk = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        const txt = res[0].transcript;
        if (res.isFinal) finalChunk += txt;
        else interimChunk += txt;
      }
      setInterimText(interimChunk);
      if (finalChunk) {
        setNotesJour((prev) => {
          const t = finalChunk.trim();
          if (!t) return prev;
          const sep = prev && !/\s$/.test(prev) ? " " : "";
          return prev + sep + t;
        });
      }
    };
    r.onerror = (e) => {
      console.error("[dictée]", e?.error || e);
      setIsRecording(false);
      setInterimText("");
    };
    r.onend = () => {
      setIsRecording(false);
      setInterimText("");
    };
    recognitionRef.current = r;
    try {
      r.start();
      setIsRecording(true);
    } catch (e) {
      console.error("[dictée] start failed", e);
    }
  }, [isRecording]);
  // Stop micro à l'unmount pour ne pas laisser le permission ouvert.
  useEffect(() => {
    return () => {
      try {
        (recognitionRef.current as { stop?: () => void } | null)?.stop?.();
      } catch {
        // ignore
      }
    };
  }, []);

  // Yoann 2026-05-03 — Réécriture du brief par Gemini à partir de la note.
  // Why: la note dictée contient les cascades inter-équipes (qui finit où, qui
  // rejoint qui, à quelle heure). Plutôt que de l'afficher brute en tête, on
  // demande à Gemini d'intégrer ces infos dans le corps du brief (annotations
  // par tournée/client) tout en gardant strictement les données structurelles
  // (clients, vélos, adresses, horaires de base).
  const [briefRewritten, setBriefRewritten] = useState<string | null>(null);
  const [rewriting, setRewriting] = useState(false);
  const [rewriteError, setRewriteError] = useState<string | null>(null);
  // Reset la version réécrite si la date change — le brief sous-jacent a changé.
  useEffect(() => {
    setBriefRewritten(null);
    setRewriteError(null);
  }, [selectedDate]);

  const findName = (id: string | null | undefined) =>
    id ? equipe.find((m) => m.id === id)?.nom || "?" : null;
  const fmtHM = (mins: number) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}h${String(m).padStart(2, "0")}`;
  };

  // Yoann 2026-05-03 — useMemo retourne 2 variantes :
  //   text     : brief complet avec section "NOTES DU JOUR" en tête (affichage par défaut)
  //   textBare : même brief SANS la note brute (envoyé à Gemini pour réécriture
  //              afin d'éviter que Gemini ne garde la note en double).
  const { text, textBare } = useMemo(() => {
    const dayISOref = isoDate(briefDate);
    const dateStr = briefDate.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });

    // Filtre tournées du jour, statut non annulé
    const ofDay = tournees.filter((t) => {
      if (!t.datePrevue) return false;
      if (t.statutGlobal === "annulee") return false;
      return isoDate(t.datePrevue) === dayISOref;
    });
    if (ofDay.length === 0) {
      const empty = `Aucune tournée planifiée pour ${dateStr}.`;
      return { text: empty, textBare: empty };
    }

    // Tri par heure de départ chaînée
    const sorted = [...ofDay].sort((a, b) => {
      const da = tourneeDepartures.get(tourneeKeyForDeparture(a))?.min ?? DEPART_MIN_DEFAULT;
      const db = tourneeDepartures.get(tourneeKeyForDeparture(b))?.min ?? DEPART_MIN_DEFAULT;
      return da - db;
    });

    // Label MATIN / APRÈS-MIDI selon l'heure de FIN réelle de la tournée.
    // Règle Yoann (29-04 23h54) : termine ≤ 13h → MATIN, sinon APRÈS-MIDI.
    // En cas de collision (2 tournées matin pour le même chauffeur), on
    // suffixe " 2", " 3"… dans l'ordre chronologique.
    const tKey = (t: Tournee) => t.tourneeId || t.livraisons[0]?.id || "";
    const CUTOFF_MATIN_MIN = 13 * 60;
    const computeEndMin = (t: Tournee): number => {
      const dep = tourneeDepartures.get(tourneeKeyForDeparture(t));
      const departMax = dep?.max ?? DEPART_MAX_DEFAULT;
      const liv0 = t.livraisons[0];
      const monteursCount = (liv0?.monteurIds || []).length || 1;
      const plan = computeDeployPlan(t.livraisons, computeSegments(t.livraisons), monteursCount);
      return departMax + Math.round(plan.totalElapsed);
    };
    const baseSlot = (t: Tournee) =>
      computeEndMin(t) <= CUTOFF_MATIN_MIN ? "MATIN" : "APRÈS-MIDI";
    const slotByTourneeId = new Map<string, string>();
    {
      const byChauf = new Map<string, Tournee[]>();
      for (const t of sorted) {
        const cid = t.livraisons[0]?.chauffeurId || "_unassigned";
        if (!byChauf.has(cid)) byChauf.set(cid, []);
        byChauf.get(cid)!.push(t);
      }
      for (const [, list] of byChauf) {
        if (list.length === 1) {
          slotByTourneeId.set(tKey(list[0]), "");
          continue;
        }
        const counts = { MATIN: 0, "APRÈS-MIDI": 0 } as Record<string, number>;
        const totals: Record<string, number> = { MATIN: 0, "APRÈS-MIDI": 0 };
        for (const t of list) totals[baseSlot(t)]++;
        for (const t of list) {
          const slot = baseSlot(t);
          counts[slot]++;
          const lbl = totals[slot] > 1 ? `${slot} ${counts[slot]}` : slot;
          slotByTourneeId.set(tKey(t), lbl);
        }
      }
    }

    const lines: string[] = [];
    lines.push(`📅 *PLANNING DU ${dateStr.toUpperCase()}*`);
    const totalVelos = sorted.reduce((s, t) => s + t.totalVelos, 0);
    const allChauffeurs = new Set<string>();
    for (const t of sorted) {
      const c = t.livraisons[0]?.chauffeurId;
      if (c) allChauffeurs.add(c);
    }
    lines.push(`${sorted.length} tournée${sorted.length > 1 ? "s" : ""} · ${totalVelos} vélos · ${allChauffeurs.size} chauffeur${allChauffeurs.size > 1 ? "s" : ""}`);
    // Yoann 2026-05-03 — Sessions atelier du jour : insérées dans le brief
    // pour que Gemini ait visibilité (qui monte où, quand). Les monteurs
    // affectés à une session atelier ne sont PAS sur la tournée → critical
    // contexte pour le résumé.
    const sessionsDuJour = (sessionsAtelier || []).filter(
      (s) => s.date === dayISOref && s.statut !== "annulee",
    );
    if (sessionsDuJour.length > 0) {
      lines.push("");
      lines.push("🔧 *SESSIONS ATELIER DU JOUR*");
      for (const s of sessionsDuJour) {
        const chef = s.chefNom ? `chef ${s.chefNom}` : null;
        const chefAdmin = s.chefAdminTerrainNom ? `admin terrain ${s.chefAdminTerrainNom}` : null;
        const monteurs = (s.monteurNoms || []).filter(Boolean);
        const equipeStr = [
          chef,
          chefAdmin,
          monteurs.length > 0 ? `${monteurs.length} monteur${monteurs.length > 1 ? "s" : ""} (${monteurs.join(", ")})` : null,
        ]
          .filter(Boolean)
          .join(" + ");
        const fmtH = (h: string | null | undefined): string => {
          if (!h) return "";
          const m = /^(\d{2}):(\d{2})$/.exec(h);
          if (!m) return h;
          const hh = parseInt(m[1], 10);
          const mn = m[2];
          return `${hh}h${mn === "00" ? "" : mn}`;
        };
        let creneau = "";
        if (s.heureDebut && s.heureFin) creneau = ` ${fmtH(s.heureDebut)}–${fmtH(s.heureFin)}`;
        else if (s.heureDebut) creneau = ` dès ${fmtH(s.heureDebut)}`;
        else if (s.heureFin) creneau = ` jusqu'à ${fmtH(s.heureFin)}`;
        const qte = s.quantitePrevue ? ` · ${s.quantitePrevue} vélos prévus` : "";
        const tournees = (s.tourneeNumeros && s.tourneeNumeros.length > 0)
          ? ` → prépare T${s.tourneeNumeros.join(", T")}`
          : "";
        lines.push(`• Atelier ${s.entrepotNom}${creneau} · ${equipeStr || "(personnel à affecter)"}${qte}${tournees}`);
      }
    }
    // Marqueur insertion note pour générer textBare (sans note) en parallèle.
    const NOTE_PLACEHOLDER = "__NOTE_BLOCK_PLACEHOLDER__";
    lines.push(NOTE_PLACEHOLDER);
    lines.push("");
    lines.push("═".repeat(40));

    let tNum = 0;
    for (const t of sorted) {
      tNum++;
      const liv0 = t.livraisons[0];
      const dep = tourneeDepartures.get(tourneeKeyForDeparture(t));
      const departMin = dep?.min ?? DEPART_MIN_DEFAULT;
      const departMax = dep?.max ?? DEPART_MAX_DEFAULT;
      const monteurNames = (liv0?.monteurIds || []).map(findName).filter(Boolean);
      const monteursCount = monteurNames.length || 1;
      const arrivals = computeArrivalTimes(t, monteursCount, departMin, departMax);
      const deployPlan = computeDeployPlan(t.livraisons, computeSegments(t.livraisons), monteursCount);

      const chauffeur = findName(liv0?.chauffeurId);
      const chefIds = (liv0?.chefEquipeIds && liv0.chefEquipeIds.length > 0)
        ? liv0.chefEquipeIds
        : (liv0?.chefEquipeId ? [liv0.chefEquipeId] : []);
      const chefs = chefIds.map(findName).filter(Boolean);
      const prepNames = (liv0?.preparateurIds || []).map(findName).filter(Boolean);
      const heureDepart = liv0?.heureDepartTournee || fmtHM(departMin);
      const dejaCharge = !!liv0?.dejaChargee;

      lines.push("");
      const slot = slotByTourneeId.get(tKey(t)) || "";
      const labelTitre = chauffeur
        ? (slot ? `TOURNÉE ${slot} ${chauffeur.toUpperCase()}` : `TOURNÉE ${chauffeur.toUpperCase()}`)
        : `TOURNÉE ${t.numero ?? tNum}`;
      lines.push(`🚛 *${labelTitre}* — ${t.totalVelos} vélos · ${t.livraisons.length} arrêt${t.livraisons.length > 1 ? "s" : ""}`);
      lines.push(`📍 Départ ${dejaCharge ? "DIRECT chez le client (déjà chargé la veille)" : "AXDIS PRO Le Blanc-Mesnil"} à *${heureDepart}*`);
      if (chauffeur) lines.push(`🚐 Chauffeur : *${chauffeur}*`);
      if (chefs.length > 0) lines.push(`🚦 Chef d'équipe : *${chefs.join(", ")}*`);
      if (monteurNames.length > 0) lines.push(`🔧 Monteurs (${monteurNames.length}) : ${monteurNames.join(", ")}`);
      if (prepNames.length > 0) lines.push(`📦 Préparation matin : ${prepNames.join(", ")}`);
      lines.push("");
      for (let i = 0; i < t.livraisons.length; i++) {
        const l = t.livraisons[i];
        const c = l.clientId ? clientInfo.get(l.clientId) : null;
        const arr = arrivals[i];
        const adresse = [l.client.adresse, l.client.codePostal, l.client.ville].filter(Boolean).join(", ");
        const tel = l.client.telephone || "";
        const apporteur = c?.apporteur || "";
        const monteursIci = deployPlan.steps[i]?.monteursAffectes ?? monteursCount;
        const tempsMontage = deployPlan.steps[i]?.tempsSurPlace ?? 0;
        lines.push(`  *${i + 1}.* ${l.client.entreprise}`);
        lines.push(`     📍 ${adresse || "—"}`);
        if (tel) lines.push(`     📞 ${tel}`);
        if (apporteur) lines.push(`     🤝 ${apporteur}`);
        if (arr) lines.push(`     ⏰ ${fmtHM(arr.minMin)} – ${fmtHM(arr.maxMin)}`);
        lines.push(`     🚲 ${l.nbVelos || l._count.velos} vélos · ${monteursIci}m sur place${tempsMontage ? ` · ~${Math.round(tempsMontage)}min` : ""}`);
        const valid = l.validationClient;
        if (!valid) lines.push(`     ⚠ CLIENT NON VALIDÉ`);
        else if (valid.status === "validee_mail") lines.push(`     📧 Validé par mail (${valid.par || "?"})`);
        else lines.push(`     📞 Validé tél (${valid.par || "?"})`);
      }
    }

    lines.push("");
    lines.push("═".repeat(40));
    lines.push("Bonne tournée à tous 🚴‍♂️");
    const raw = lines.join("\n");
    const notesTrim = notesJour.trim();
    const noteBlock = notesTrim
      ? `\n📝 *NOTES DU JOUR*\n${notesTrim}`
      : "";
    return {
      text: raw.replace(NOTE_PLACEHOLDER, noteBlock),
      // textBare : strip placeholder + ligne vide précédente si vide
      textBare: raw.replace(`\n${NOTE_PLACEHOLDER}`, "").replace(NOTE_PLACEHOLDER, ""),
    };
  }, [briefDate, tournees, equipe, clientInfo, tourneeDepartures, notesJour, sessionsAtelier]);
  void findName;

  // Brief affiché : version Gemini si présente, sinon brief auto.
  const briefDisplayed = briefRewritten ?? text;

  // Yoann 2026-05-03 — Demande à Gemini de réécrire le brief en intégrant la
  // note dictée (cascades, horaires, qui rejoint qui). Contraintes strictes :
  // ne JAMAIS inventer client/vélo/adresse/horaire ; garder le format WhatsApp ;
  // peut ajouter une section narrative + annotations par tournée/client.
  // Décode une réponse Gemini qui peut arriver wrappée en JSON string
  // (`"...\n..."`), en fence markdown (` ```...``` `) ou avec des `\n`
  // littéraux non échappés. Garantit qu'on récupère du texte brut avec de
  // vrais retours à la ligne, prêt à coller dans WhatsApp.
  const decodeGeminiBrief = (raw: string): string => {
    let s = raw.trim();
    // 1) Strip markdown fences ``` lang ... ```
    if (s.startsWith("```")) {
      s = s.replace(/^```[a-zA-Z]*\n?/, "").replace(/```\s*$/, "").trim();
    }
    // 2) Si Gemini renvoie un OBJET JSON {"brief": "..."} ou similaire,
    // extraire la première string sous une clé sémantique (brief/text/output/...)
    // ou la première string trouvée. Réessaie avec parse récursif.
    if (s.startsWith("{") || s.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(s);
        const findString = (v: unknown): string | null => {
          if (typeof v === "string") return v;
          if (Array.isArray(v)) {
            for (const item of v) {
              const r = findString(item);
              if (r) return r;
            }
            return null;
          }
          if (v && typeof v === "object") {
            const obj = v as Record<string, unknown>;
            const keys = ["brief", "text", "output", "result", "content", "message"];
            for (const k of keys) {
              if (typeof obj[k] === "string") return obj[k] as string;
            }
            for (const k of Object.keys(obj)) {
              const r = findString(obj[k]);
              if (r) return r;
            }
          }
          return null;
        };
        const found = findString(parsed);
        if (found) s = found;
      } catch {
        // pas du JSON valide, on continue avec la string brute
      }
    }
    // 3) Si la réponse est une string JSON quotée ("..." avec \n échappés), la parser
    if (s.startsWith('"') && s.endsWith('"') && s.length > 1) {
      try {
        const parsed = JSON.parse(s);
        if (typeof parsed === "string") s = parsed;
      } catch {
        s = s.slice(1, -1);
      }
    }
    // 4) Décoder les \n littéraux (backslash+n) — artefact d'encodage fréquent.
    // Personne n'écrit "\n" volontairement dans un brief WhatsApp.
    if (s.includes("\\n") || s.includes("\\t")) {
      s = s
        .replace(/\\r\\n/g, "\n")
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
    return s.trim();
  };

  const rewriteBriefFromNotes = useCallback(async () => {
    const note = notesJour.trim();
    if (!note) {
      alert("Ajoute d'abord ta note (texte ou dictée) puis clique sur Appliquer.");
      return;
    }
    if (!textBare || textBare.startsWith("Aucune tournée")) {
      alert("Pas de tournée planifiée pour ce jour.");
      return;
    }
    setRewriting(true);
    setRewriteError(null);
    try {
      // textBare ne contient PAS la section "NOTES DU JOUR" — la note est
      // passée séparément pour que Gemini la fonde dans le corps du brief.
      const prompt = [
        "Tu es l'assistant logistique de Vélos Cargo (Artisans Verts Energy).",
        "Tu reçois 2 entrées :",
        "1) BRIEF AUTO : planning du jour généré par le CRM (format technique).",
        "2) NOTE : texte dicté par Yoann (le boss) qui décrit l'orchestration de la journée : qui démarre où, qui rejoint qui, qui pré-monte, qui livre, navettes inter-équipes, etc.",
        "",
        "OBJECTIF : produire UN SEUL brief NARRATIF UNIFIÉ, court et lisible style WhatsApp, qui mélange dans UN flow chronologique :",
        "- la cascade décrite par Yoann (qui fait quoi, quand, où, avec qui, dans quel ordre)",
        "- les SESSIONS ATELIER du jour (montage en entrepôt, listées sous '🔧 SESSIONS ATELIER DU JOUR' dans le brief auto). C'est CRITIQUE : les monteurs affectés à une session atelier NE SONT PAS sur la tournée, ils montent en entrepôt. Le chauffeur récupère des vélos déjà montés.",
        "- les données opérationnelles essentielles (clients, adresses, horaires, vélos, validations)",
        "",
        "INTERDIT ABSOLU : faire un résumé/stratégie en tête PUIS répéter le détail des tournées en dessous. C'est UN seul brief intégré. Pas de doublon.",
        "",
        "STRUCTURE OBLIGATOIRE :",
        "1. Ligne 1 : `📅 *PLANNING DU <JOUR DATE>*`",
        "2. Ligne 2 : `<N> tournées · <V> vélos · <C> chauffeurs`",
        "3. Ligne vide.",
        "4. Sections `🌅 *MATIN*` puis `🌆 *APRÈS-MIDI*` (matin = départ ≤13h, après-midi = >13h). Si une seule existe, n'affiche que celle-là.",
        "5. À l'intérieur de chaque section, pour chaque tournée DANS L'ORDRE CHRONOLOGIQUE des heures de départ :",
        "",
        "   Format d'un bloc tournée (compact, narratif) :",
        "   ```",
        "   🚛 *<CHAUFFEUR>* · <chef d'équipe si pertinent> · <N> monteur(s) <noms entre parenthèses> · <V> vélos",
        "   📍 Départ <lieu> à *<HHhMM>* — <courte phrase de cascade tirée de la note si pertinente : ex \"part direct au parking de Halle Market pour pré-monter\", \"rejoint Armel après Firat vers 11h\", etc.>",
        "      • <CLIENT 1> · <Ville/CP> · <Nv> vélos · <HHhMM-HHhMM> <📞 tél> <⚠ si non validé>",
        "      • <CLIENT 2> · ...",
        "   ```",
        "",
        "5bis. Pour chaque session atelier (pré-montage en entrepôt), insère un bloc dédié dans le créneau temporel cohérent (matin pour ateliers ouverts le matin, etc.) :",
        "   Format compact :",
        "   `🔧 *Atelier <ENTREPÔT>* · <chef si pertinent> · <N> monteurs (<noms>) · <V> vélos prévus · <créneau si renseigné>`",
        "   Mentionne que les vélos seront montés sur place (prêts à charger). Si une tournée du jour part de cet entrepôt après la session, fais le lien explicite (ex : \"vélos prêts pour la tournée Zinedine\").",
        "",
        "6. Termine par une ligne vide puis `Bonne tournée à tous 🚴‍♂️`.",
        "",
        "STYLE :",
        "- Compact, lisible sur mobile WhatsApp. Une tournée tient sur 5-12 lignes max.",
        "- La cascade s'exprime dans la phrase de départ ou en ligne `→` après les arrêts (\"→ ETHAN rejoint Armel ici à 11h pour finir à 5\").",
        "- Pas de tableau/colonne. Pas d'emoji superflu (un seul par ligne max).",
        "- Reformule la note de Yoann en français propre (corrige les fautes de dictée : Etha→Ethan, garsils→Gursil singh, monteur von→monteurs vont, avecsur→avec sur, etc.) en t'aidant des noms réels déjà présents dans le BRIEF AUTO.",
        "- Pour les tournées NON concernées par la note, fais le bloc compact sans annotation cascade.",
        "",
        "RÈGLES STRICTES (zéro tolérance) :",
        "- INTERDIT d'inventer ou modifier : noms de clients, adresses, téléphones, nb de vélos, statuts de validation. Recopie ces données à l'identique du BRIEF AUTO. Tu peux raccourcir l'adresse (juste rue + ville) mais pas inventer.",
        "- AUTORISÉ d'ajuster les horaires de départ ou les affectations chauffeur/chef/monteurs UNIQUEMENT si la note les précise EXPLICITEMENT.",
        "- Si la note dit \"pas besoin de monteur sur place\" pour une tournée, écris-le clairement et ne liste pas de monteurs pour ce bloc.",
        "",
        "FORMAT DE SORTIE (CRITIQUE — VIOLATION = REJET) :",
        "- Réponds UNIQUEMENT en TEXTE BRUT pur.",
        "- Ta réponse DOIT commencer par le caractère 📅 et finir par le caractère 🚴‍♂️ — RIEN avant, RIEN après.",
        "- INTERDIT ABSOLU : envelopper en JSON (`{\"brief\": \"...\"}`, `{\"text\": \"...\"}`, etc.).",
        "- INTERDIT ABSOLU : envelopper en string quotée (`\"...\"`).",
        "- INTERDIT ABSOLU : envelopper en bloc markdown (```...```).",
        "- INTERDIT ABSOLU : échapper les retours à la ligne en `\\n` littéraux. Utilise de VRAIS retours à la ligne.",
        "- INTERDIT : ajouter un commentaire ou intro avant le brief, ou une signature après.",
        "",
        "=== BRIEF AUTO (données techniques de référence — à recopier sans modifier les chiffres/adresses/téléphones) ===",
        textBare,
        "",
        "=== NOTE DE YOANN (orchestration narrative à intégrer dans le flow) ===",
        note,
        "",
        "=== BRIEF NARRATIF UNIFIÉ (commence par 📅, finit par 🚴‍♂️, texte brut sans wrap) ===",
      ].join("\n");
      const r = await callGemini(prompt);
      if (r.ok && r.text) {
        const out = decodeGeminiBrief(r.text);
        if (!out) {
          setRewriteError("Réponse Gemini vide après décodage");
        } else {
          setBriefRewritten(out);
        }
      } else {
        setRewriteError(r.ok ? "Réponse Gemini vide" : (r.error || "Erreur Gemini"));
      }
    } catch (e) {
      setRewriteError(e instanceof Error ? e.message : "Erreur réseau");
    } finally {
      setRewriting(false);
    }
  }, [notesJour, textBare]);

  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(briefDisplayed);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[70] p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-3xl max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-3 gap-3">
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold flex items-center gap-2">📋 Brief du jour</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Toutes les tournées du jour choisi, triées par heure de départ. Format
              compatible WhatsApp (*gras*).
            </p>
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <label className="text-xs font-medium text-gray-700">Jour :</label>
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="px-2 py-1 border rounded text-sm"
              />
              <button
                onClick={() => setSelectedDate(isoDate(refDate))}
                className="text-[11px] px-2 py-1 text-gray-600 border border-gray-200 rounded hover:bg-gray-50"
                title="Date du jour visible dans le planning"
              >
                Aujourd&apos;hui
              </button>
              <button
                onClick={() => setSelectedDate(isoDate(tomorrow))}
                className="text-[11px] px-2 py-1 text-gray-600 border border-gray-200 rounded hover:bg-gray-50"
                title="Brief du soir = lendemain par défaut"
              >
                Demain
              </button>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>
        {/* Yoann 2026-05-03 — Notes logistique du jour : cascades inter-équipes,
            navettes, enchaînements monteur. Persisté Firestore briefsJour/{date},
            réinjecté dans le brief WhatsApp + prompt strategieGemini. */}
        <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <div className="flex items-center justify-between mb-1.5 gap-2">
            <label className="text-xs font-semibold text-amber-900 flex items-center gap-1.5">
              📝 Notes logistique du jour
              <span className="text-[10px] font-normal text-amber-700">(cascades inter-équipes, navettes, enchaînements — lues par Gemini)</span>
            </label>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-amber-700">
                {notesJourSaving
                  ? "💾 Sauvegarde…"
                  : notesDirty
                    ? "● Non sauvegardé"
                    : notesJourSavedAt
                      ? "✓ Sauvegardé"
                      : ""}
              </span>
              {speechSupported && (
                <button
                  onClick={toggleRecording}
                  className={`text-[11px] px-2 py-1 rounded font-medium flex items-center gap-1 ${
                    isRecording
                      ? "bg-red-600 text-white animate-pulse"
                      : "bg-white text-amber-700 border border-amber-300 hover:bg-amber-100"
                  }`}
                  title={isRecording ? "Arrêter la dictée" : "Dicter (mains libres en voiture)"}
                >
                  <span>{isRecording ? "⏹️" : "🎤"}</span>
                  <span>{isRecording ? "Stop" : "Dicter"}</span>
                </button>
              )}
              <button
                onClick={() => void saveNotesJour()}
                disabled={!notesDirty || notesJourSaving}
                className={`text-[11px] px-2 py-1 rounded font-medium ${
                  !notesDirty || notesJourSaving
                    ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                    : "bg-amber-600 text-white hover:bg-amber-700"
                }`}
              >
                💾 Sauvegarder
              </button>
            </div>
          </div>
          <textarea
            value={notesJour}
            onChange={(e) => setNotesJour(e.target.value)}
            placeholder="Ex : ETHAN finit FIRAT 11h puis rejoint Armel chez ALDI pour montage in situ pendant que Zinédine fait des navettes Lisses↔Chelles."
            className="w-full h-20 px-2 py-1.5 border border-amber-300 rounded text-xs resize-y bg-white"
          />
          {isRecording && (
            <div className="mt-1 text-[11px] text-amber-800 flex items-start gap-1.5">
              <span className="text-red-600 animate-pulse">●</span>
              <span className="italic text-gray-600">
                {interimText || "À l'écoute…"}
              </span>
            </div>
          )}
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <button
              onClick={() => void rewriteBriefFromNotes()}
              disabled={rewriting || !notesJour.trim()}
              className={`text-[11px] px-3 py-1.5 rounded font-semibold flex items-center gap-1 ${
                rewriting || !notesJour.trim()
                  ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                  : "bg-purple-600 text-white hover:bg-purple-700"
              }`}
              title="Réécrit le brief avec Gemini en intégrant tes notes (cascades, horaires, qui fait quoi)"
            >
              <span>🤖</span>
              <span>{rewriting ? "Réécriture en cours…" : "Appliquer au brief (Gemini)"}</span>
            </button>
            {briefRewritten && (
              <button
                onClick={() => setBriefRewritten(null)}
                className="text-[11px] px-2 py-1.5 rounded font-medium bg-white text-gray-600 border border-gray-300 hover:bg-gray-50"
                title="Revenir au brief auto-calculé"
              >
                ↺ Brief auto
              </button>
            )}
            {rewriteError && (
              <span className="text-[10px] text-red-600">⚠ {rewriteError}</span>
            )}
          </div>
        </div>
        {briefRewritten && (
          <div className="mb-2 px-3 py-1.5 bg-purple-50 border border-purple-200 rounded text-[11px] text-purple-800 flex items-center gap-2">
            <span>🤖</span>
            <span><strong>Brief réécrit par Gemini</strong> à partir de tes notes — relis avant d&apos;envoyer.</span>
          </div>
        )}
        <textarea
          value={briefDisplayed}
          onChange={(e) => {
            // Si l'utilisateur édite manuellement le brief réécrit, on garde
            // sa version éditée. Sinon (brief auto), on ignore l'édition (cohérent
            // avec le comportement initial readOnly).
            if (briefRewritten !== null) setBriefRewritten(e.target.value);
          }}
          readOnly={briefRewritten === null}
          className={`w-full h-[50vh] px-3 py-2 border rounded-lg font-mono text-xs whitespace-pre overflow-auto ${
            briefRewritten ? "border-purple-300 bg-purple-50/30" : ""
          }`}
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            onClick={copy}
            className={`px-4 py-2 rounded-lg text-sm font-medium ${
              copied ? "bg-green-600 text-white" : "bg-purple-600 text-white hover:bg-purple-700"
            }`}
          >
            {copied ? "✓ Copié dans le presse-papier" : "📋 Copier le brief complet"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Yoann 2026-05-03 — Modale "WhatsApp clients du jour" : liste les clients
// avec une livraison planifiée le jour choisi, leur numéro, leur statut de
// validation. Bouton 📱 par client pour ouvrir WhatsApp avec un message de
// rappel pré-rempli (créneau + adresse + nb vélos).
function WhatsAppClientsModal({
  refDate,
  tournees,
  clientInfo,
  tourneeDepartures,
  equipe,
  onClose,
}: {
  refDate: Date;
  tournees: Tournee[];
  clientInfo: Map<string, ClientPoint>;
  tourneeDepartures: DepartureMap;
  equipe: EquipeMember[];
  onClose: () => void;
}) {
  const currentUser = useCurrentUser();
  const tomorrow = useMemo(() => {
    const d = new Date(refDate); d.setDate(d.getDate() + 1); return d;
  }, [refDate]);
  const initialDate = useMemo(() => {
    const refIso = isoDate(refDate);
    const isPlanned = (iso: string) => tournees.some(
      (t) => t.datePrevue && isoDate(t.datePrevue) === iso && t.statutGlobal !== "annulee",
    );
    if (isPlanned(refIso)) return refIso;
    return isoDate(tomorrow);
  }, [refDate, tournees, tomorrow]);
  const [selectedDate, setSelectedDate] = useState<string>(initialDate);
  void equipe;

  // Liste des livraisons du jour avec infos client
  const items = useMemo(() => {
    const day = selectedDate;
    type Row = {
      livraisonId: string;
      tourneeId: string;
      clientId: string | null;
      entreprise: string;
      contact: string | null;
      telephone: string | null;
      adresse: string;
      nbVelos: number;
      creneau: string | null;
      validee: boolean;
      datePrevue: string | null;
    };
    const rows: Row[] = [];
    for (const t of tournees) {
      if (!t.datePrevue) continue;
      if (t.statutGlobal === "annulee") continue;
      if (isoDate(t.datePrevue) !== day) continue;
      const dep = tourneeDepartures.get(tourneeKeyForDeparture(t));
      const departMin = dep?.min ?? DEPART_MIN_DEFAULT;
      const departMax = dep?.max ?? DEPART_MAX_DEFAULT;
      const monteursCount = (t.livraisons[0]?.monteurIds || []).length || 1;
      const arrivals = computeArrivalTimes(t, monteursCount, departMin, departMax);
      const fmtHM = (mins: number) => {
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return `${h}h${String(m).padStart(2, "0")}`;
      };
      for (let i = 0; i < t.livraisons.length; i++) {
        const l = t.livraisons[i];
        if (l.statut === "annulee") continue;
        const c = l.clientId ? clientInfo.get(l.clientId) : null;
        const adresse = [l.client?.adresse, l.client?.codePostal, l.client?.ville].filter(Boolean).join(", ");
        const arr = arrivals[i];
        const creneau = arr ? `${fmtHM(arr.minMin)}-${fmtHM(arr.maxMin)}` : null;
        rows.push({
          livraisonId: l.id,
          tourneeId: t.tourneeId || "",
          clientId: l.clientId || null,
          entreprise: l.client?.entreprise || "?",
          contact: c?.contact || null,
          telephone: l.client?.telephone || c?.telephone || null,
          adresse,
          nbVelos: l.nbVelos || l._count.velos || 0,
          creneau,
          validee: !!l.validationClient,
          datePrevue: l.datePrevue,
        });
      }
    }
    return rows.sort((a, b) => a.entreprise.localeCompare(b.entreprise));
  }, [selectedDate, tournees, clientInfo, tourneeDepartures]);

  const sendOne = (row: typeof items[number]) => {
    const ok = openWhatsApp(row.telephone, tplValidationLivraison({
      contact: row.contact,
      entreprise: row.entreprise,
      nbVelos: row.nbVelos,
      datePrevue: row.datePrevue,
      creneau: row.creneau,
      adresse: row.adresse || null,
      signature: currentUser?.nom || "Vélos Cargo",
    }));
    if (!ok) alert(`Pas de numéro de téléphone valide pour ${row.entreprise}.`);
  };

  // Ouverture en série avec délai pour contourner le bloqueur de pop-ups
  // navigateur. Le 1er onglet ouvre direct (action user), les suivants
  // après un setTimeout — Chrome autorise jusqu'à ~5 onglets en série
  // depuis un même clic en général.
  const sendAll = () => {
    const valid = items.filter((r) => !!r.telephone);
    if (valid.length === 0) { alert("Aucun numéro à contacter."); return; }
    if (!confirm(`Ouvrir WhatsApp pour ${valid.length} client(s) ? Le navigateur risque de bloquer si > 5 — clique sur "Toujours autoriser les pop-ups".`)) return;
    for (let i = 0; i < valid.length; i++) {
      const row = valid[i];
      setTimeout(() => sendOne(row), i * 350);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[70] p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-3xl max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-3 gap-3">
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold flex items-center gap-2">📱 WhatsApp clients du jour</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Envoie un rappel WhatsApp à chaque client livré ce jour-là (date + créneau + adresse + nb vélos pré-remplis).
              Tu valides l&apos;envoi dans WhatsApp.
            </p>
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <label className="text-xs font-medium text-gray-700">Jour :</label>
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="px-2 py-1 border rounded text-sm"
              />
              <button
                onClick={() => setSelectedDate(isoDate(refDate))}
                className="text-[11px] px-2 py-1 text-gray-600 border border-gray-200 rounded hover:bg-gray-50"
              >
                Aujourd&apos;hui
              </button>
              <button
                onClick={() => setSelectedDate(isoDate(tomorrow))}
                className="text-[11px] px-2 py-1 text-gray-600 border border-gray-200 rounded hover:bg-gray-50"
              >
                Demain
              </button>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>

        {items.length === 0 ? (
          <div className="text-center py-12 text-gray-400 italic text-sm">
            Aucun client à livrer ce jour-là.
          </div>
        ) : (
          <>
            <div className="mb-3 flex items-center justify-between gap-2 flex-wrap">
              <div className="text-xs text-gray-600">
                {items.length} client{items.length > 1 ? "s" : ""} ·
                {" "}{items.filter((r) => r.telephone).length} avec téléphone ·
                {" "}{items.filter((r) => !r.telephone).length} sans
              </div>
              <button
                onClick={sendAll}
                disabled={items.filter((r) => !!r.telephone).length === 0}
                className="px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-medium disabled:opacity-50"
                title="Ouvre WhatsApp pour tous les clients d'un coup (navigateur peut bloquer si > 5)"
              >
                📱 Tous ({items.filter((r) => !!r.telephone).length})
              </button>
            </div>
            <div className="space-y-1.5">
              {items.map((row) => (
                <div
                  key={row.livraisonId}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${
                    row.telephone ? "bg-white" : "bg-gray-50 opacity-70"
                  } ${row.validee ? "border-emerald-200" : "border-amber-200"}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">
                      {row.entreprise}
                      {row.validee ? (
                        <span className="ml-1.5 text-[10px] text-emerald-700 font-normal">✓ validé</span>
                      ) : (
                        <span className="ml-1.5 text-[10px] text-amber-700 font-normal">⚠ non validé</span>
                      )}
                    </div>
                    <div className="text-[11px] text-gray-500 truncate">
                      {row.contact && <>👤 {row.contact} · </>}
                      {row.telephone ? <>📞 {row.telephone}</> : <span className="text-red-600">📞 aucun téléphone</span>}
                      {row.creneau && <> · ⏰ {row.creneau}</>}
                      {" · "}🚲 {row.nbVelos}v
                    </div>
                  </div>
                  <button
                    onClick={() => sendOne(row)}
                    disabled={!row.telephone}
                    className="px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 text-xs font-semibold disabled:bg-gray-300 disabled:text-gray-500 disabled:cursor-not-allowed"
                    title={row.telephone ? "Ouvrir WhatsApp" : "Aucun téléphone — ajoute-le sur la fiche client"}
                  >
                    📱 WhatsApp
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Modale qui demande au user pour quel chauffeur sortir la feuille du jour.
// Sélecteur date (par défaut demain) + liste cliquable des chauffeurs ayant
// au moins une tournée non-annulée ce jour-là.
function FeuilleJourChooserModal({
  refDate,
  tournees,
  equipe,
  onChoose,
  onClose,
}: {
  refDate: Date;
  tournees: Tournee[];
  equipe: EquipeMember[];
  onChoose: (date: Date, chauffeurId: string) => void;
  onClose: () => void;
}) {
  const tomorrow = useMemo(() => {
    const d = new Date(refDate); d.setDate(d.getDate() + 1); return d;
  }, [refDate]);
  const initialDate = useMemo(() => {
    const refIso = isoDate(refDate);
    const isPlanned = (iso: string) => tournees.some(
      (t) => t.datePrevue && isoDate(t.datePrevue) === iso && t.statutGlobal !== "annulee",
    );
    if (isPlanned(refIso)) return refIso;
    for (let i = 1; i <= 14; i++) {
      const d = new Date(refDate); d.setDate(d.getDate() + i);
      const iso = isoDate(d);
      if (isPlanned(iso)) return iso;
    }
    return refIso;
  }, [refDate, tournees]);
  const [selectedDate, setSelectedDate] = useState<string>(initialDate);
  const briefDate = useMemo(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) return tomorrow;
    return new Date(`${selectedDate}T12:00:00`);
  }, [selectedDate, tomorrow]);
  const dayISO = isoDate(briefDate);

  const chauffeursDuJour = useMemo(() => {
    const counts = new Map<string, { count: number; velos: number }>();
    for (const t of tournees) {
      if (!t.datePrevue || isoDate(t.datePrevue) !== dayISO) continue;
      if (t.statutGlobal === "annulee") continue;
      const cid = t.livraisons[0]?.chauffeurId;
      if (!cid) continue;
      if (!counts.has(cid)) counts.set(cid, { count: 0, velos: 0 });
      const c = counts.get(cid)!;
      c.count++; c.velos += t.totalVelos;
    }
    return Array.from(counts.entries())
      .map(([id, c]) => ({ id, name: equipe.find((m) => m.id === id)?.nom || "?", ...c }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [tournees, equipe, dayISO]);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[70] p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-3">
          <h2 className="text-lg font-semibold flex items-center gap-2">📄 Feuille de route chauffeur</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>
        <div className="mb-3 flex items-center gap-2 flex-wrap">
          <label className="text-xs font-medium text-gray-700">Jour :</label>
          <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} className="px-2 py-1 border rounded text-sm" />
          <button onClick={() => setSelectedDate(isoDate(refDate))} className="text-[11px] px-2 py-1 text-gray-600 border rounded hover:bg-gray-50">Aujourd&apos;hui</button>
          <button onClick={() => setSelectedDate(isoDate(tomorrow))} className="text-[11px] px-2 py-1 text-gray-600 border rounded hover:bg-gray-50">Demain</button>
        </div>
        {chauffeursDuJour.length === 0 ? (
          <div className="text-sm text-gray-500 py-4 text-center">Aucune tournée pour cette date.</div>
        ) : (
          <div className="space-y-2">
            <div className="text-xs text-gray-500 mb-1">Choisis un chauffeur :</div>
            {chauffeursDuJour.map((c) => (
              <button
                key={c.id}
                onClick={() => onChoose(briefDate, c.id)}
                className="w-full text-left px-3 py-2 border rounded-lg hover:bg-blue-50 hover:border-blue-300 flex justify-between items-center"
              >
                <span className="font-medium">{c.name}</span>
                <span className="text-xs text-gray-500">{c.count} tournée{c.count > 1 ? "s" : ""} · {c.velos} vélos</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Feuille de route consolidée pour UN chauffeur sur la journée. Toutes ses
// tournées enchaînées dans un même PDF, avec un en-tête de section par
// tournée (matin/après-midi). Yoann 29-04 23h54 : éviter d'imprimer 4
// feuilles séparées (3 Armel + 1 Zinedine).
function FeuilleDeRouteJournee({
  date,
  chauffeurId,
  tournees,
  equipe,
  clientInfo,
  tourneeDepartures,
  onBack,
}: {
  date: Date;
  chauffeurId: string;
  tournees: Tournee[];
  equipe: EquipeMember[];
  clientInfo: Map<string, ClientPoint>;
  tourneeDepartures: DepartureMap;
  onBack: () => void;
}) {
  const dayISO = isoDate(date);
  const chauffeurName = equipe.find((m) => m.id === chauffeurId)?.nom || "?";
  const findName = (id: string | null | undefined) =>
    id ? equipe.find((m) => m.id === id)?.nom || null : null;
  const fmtHM = (mins: number) => `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}`;

  const dayTournees = useMemo(() => {
    return tournees
      .filter((t) => t.datePrevue && isoDate(t.datePrevue) === dayISO)
      .filter((t) => t.statutGlobal !== "annulee")
      .filter((t) => t.livraisons[0]?.chauffeurId === chauffeurId)
      .sort((a, b) => {
        const da = tourneeDepartures.get(tourneeKeyForDeparture(a))?.min ?? DEPART_MIN_DEFAULT;
        const db = tourneeDepartures.get(tourneeKeyForDeparture(b))?.min ?? DEPART_MIN_DEFAULT;
        return da - db;
      });
  }, [tournees, dayISO, chauffeurId, tourneeDepartures]);

  // Slot label (MATIN/APRÈS-MIDI) basé sur l'heure de fin réelle, ≤ 13h = MATIN.
  const slotMap = useMemo(() => {
    const CUTOFF = 13 * 60;
    const endOf = (t: Tournee) => {
      const dep = tourneeDepartures.get(tourneeKeyForDeparture(t));
      const departMax = dep?.max ?? DEPART_MAX_DEFAULT;
      const monteurs = (t.livraisons[0]?.monteurIds || []).length || 1;
      const plan = computeDeployPlan(t.livraisons, computeSegments(t.livraisons), monteurs);
      return departMax + Math.round(plan.totalElapsed);
    };
    const totals: Record<string, number> = { MATIN: 0, "APRÈS-MIDI": 0 };
    for (const t of dayTournees) totals[endOf(t) <= CUTOFF ? "MATIN" : "APRÈS-MIDI"]++;
    const counts: Record<string, number> = { MATIN: 0, "APRÈS-MIDI": 0 };
    const map = new Map<string, string>();
    for (const t of dayTournees) {
      const slot = endOf(t) <= CUTOFF ? "MATIN" : "APRÈS-MIDI";
      counts[slot]++;
      const key = t.tourneeId || t.livraisons[0]?.id || "";
      map.set(key, totals[slot] > 1 ? `${slot} ${counts[slot]}` : slot);
    }
    return map;
  }, [dayTournees, tourneeDepartures]);

  const totalVelos = dayTournees.reduce((s, t) => s + t.totalVelos, 0);
  const totalArrets = dayTournees.reduce((s, t) => s + t.livraisons.length, 0);
  const dateStr = date.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

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

        <div className="text-center mb-5 border-b pb-3">
          <h1 className="text-xl font-bold">Feuille de route — {chauffeurName.toUpperCase()}</h1>
          <div className="text-sm text-gray-600 mt-1">{dateStr}</div>
          <div className="flex justify-center gap-6 mt-3 text-sm">
            <span><strong>{dayTournees.length}</strong> tournée{dayTournees.length > 1 ? "s" : ""}</span>
            <span><strong>{totalArrets}</strong> arrêts</span>
            <span><strong>{totalVelos}</strong> vélos</span>
          </div>
        </div>

        {dayTournees.map((t, ti) => {
          const liv0 = t.livraisons[0];
          const dep = tourneeDepartures.get(tourneeKeyForDeparture(t));
          const departMin = dep?.min ?? DEPART_MIN_DEFAULT;
          const departMax = dep?.max ?? DEPART_MAX_DEFAULT;
          const monteurs = (liv0?.monteurIds || []).length || 1;
          const segs = computeSegments(t.livraisons);
          const arrivals = computeArrivalTimes(t, monteurs, departMin, departMax);
          const heureDepart = liv0?.heureDepartTournee || fmtHM(departMin);
          const dejaCharge = !!liv0?.dejaChargee;
          const slot = slotMap.get(t.tourneeId || t.livraisons[0]?.id || "") || "";
          const chefIds = (liv0?.chefEquipeIds && liv0.chefEquipeIds.length > 0)
            ? liv0.chefEquipeIds
            : (liv0?.chefEquipeId ? [liv0.chefEquipeId] : []);
          const chefs = chefIds.map(findName).filter(Boolean);
          const monteurNames = (liv0?.monteurIds || []).map(findName).filter(Boolean);

          return (
            <section key={t.tourneeId || ti} className="mb-6 print:break-inside-avoid">
              <div className="bg-blue-50 border border-blue-300 rounded-lg p-3 mb-2">
                <div className="font-bold text-blue-900">
                  {slot ? `Tournée ${slot}` : `Tournée ${ti + 1}`} — {t.totalVelos} vélos · {t.livraisons.length} arrêt{t.livraisons.length > 1 ? "s" : ""}
                </div>
                <div className="text-xs text-blue-700 mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
                  <span>📍 Départ {dejaCharge ? "DIRECT chez le client (camion déjà chargé la veille)" : ENTREPOT.label} à {heureDepart}</span>
                  {chefs.length > 0 && <span>🚦 Chef : {chefs.join(", ")}</span>}
                  {monteurNames.length > 0 && <span>🔧 Monteurs ({monteurNames.length}) : {monteurNames.join(", ")}</span>}
                </div>
              </div>

              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b-2 text-left text-xs">
                    <th className="py-1.5 w-8">#</th>
                    <th className="py-1.5">Client</th>
                    <th className="py-1.5">Adresse</th>
                    <th className="py-1.5 w-20 text-center">Apporteur</th>
                    <th className="py-1.5 w-20 text-center">Tél.</th>
                    <th className="py-1.5 w-12 text-center">Vélos</th>
                    <th className="py-1.5 w-20 text-center">Arrivée</th>
                    <th className="py-1.5 w-12 text-center">Fait</th>
                  </tr>
                </thead>
                <tbody>
                  {t.livraisons.map((l, i) => {
                    const ci = l.clientId ? clientInfo.get(l.clientId) : null;
                    const arr = arrivals[i];
                    return (
                      <tr key={l.id} className="border-b">
                        <td className="py-1.5 font-bold">{i + 1}</td>
                        <td className="py-1.5">
                          <div className="font-medium">{l.client.entreprise}</div>
                          {ci?.contact && <div className="text-[10px] text-gray-600">{ci.contact}</div>}
                        </td>
                        <td className="py-1.5 text-xs text-gray-600">
                          {[l.client.adresse, l.client.codePostal, l.client.ville].filter(Boolean).join(", ")}
                        </td>
                        <td className="py-1.5 text-xs text-center text-orange-600 font-medium">{ci?.apporteur || "—"}</td>
                        <td className="py-1.5 text-xs text-center">{l.client.telephone || "—"}</td>
                        <td className="py-1.5 text-center font-medium">{l._count.velos}</td>
                        <td className="py-1.5 text-xs text-center text-gray-600">
                          {arr ? `${fmtHM(arr.minMin)}–${fmtHM(arr.maxMin)}` : "—"}
                        </td>
                        <td className="py-1.5 text-center">
                          <div className="w-5 h-5 border-2 border-gray-400 rounded mx-auto" />
                        </td>
                      </tr>
                    );
                  })}
                  {segs.length > 0 && (() => {
                    // Retour entrepôt entre 2 tournées (sauf pour la dernière)
                    const isLast = ti === dayTournees.length - 1;
                    if (isLast) return null;
                    const last = t.livraisons[t.livraisons.length - 1];
                    if (!last?.client.lat || !last?.client.lng) return null;
                    const distRetour = haversineKm(last.client.lat, last.client.lng, ENTREPOT.lat, ENTREPOT.lng);
                    return (
                      <tr className="border-b bg-gray-50">
                        <td className="py-1.5 text-gray-400">↩</td>
                        <td className="py-1.5 text-gray-500" colSpan={5}>Retour entrepôt — {ENTREPOT.label} (recharge tournée suivante)</td>
                        <td className="py-1.5 text-xs text-center text-gray-500">{Math.round(distRetour * 10) / 10} km</td>
                        <td className="py-1.5" />
                      </tr>
                    );
                  })()}
                </tbody>
              </table>
            </section>
          );
        })}

        <div className="mt-6 border-t pt-4">
          <div className="text-sm font-medium mb-2">Notes :</div>
          <div className="h-24 border border-gray-300 rounded" />
        </div>
      </div>
    </div>
  );
}

// Helper segments (utilisé par BriefJourneeModal pour computeDeployPlan).
// Réplique la logique de TourneeCard ; sortie identique.
function computeSegments(livraisons: LivraisonRow[]): { distKm: number; trajetMin: number }[] {
  const result: { distKm: number; trajetMin: number }[] = [];
  let prev = ENTREPOT;
  for (const l of livraisons) {
    const lat = l.client.lat ?? null;
    const lng = l.client.lng ?? null;
    if (lat == null || lng == null) {
      result.push({ distKm: 0, trajetMin: 0 });
      continue;
    }
    const distKm = haversineKm(prev.lat, prev.lng, lat, lng);
    const trajetMin = Math.round((distKm / 30) * 60);
    result.push({ distKm: Math.round(distKm * 10) / 10, trajetMin });
    prev = { lat, lng, label: "" };
  }
  return result;
}

// Modale « Brief équipe » : génère un texte narratif à copier-coller dans
// WhatsApp / mail pour briefer les équipes la veille au soir.
// Bouton "Envoyer BL à Franck" — placé sur chaque livraison du modal
// admin Livraisons (Yoann 2026-05-01). Workflow : Naomi (compta) prépare
// les BL et clique pour envoyer à Franck pour impression. Plus sur le
// terrain (chauffeur ne doit pas déclencher l envoi).
function SendBlFranckBtn({
  tourneeId,
  clientId,
  clientName,
}: {
  tourneeId: string;
  clientId: string;
  clientName: string;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ numeroBL: string; velosCount: number } | null>(null);

  const send = async () => {
    if (!confirm(`Envoyer le BL de ${clientName} à Franck@axdis.fr pour impression ?`)) return;
    setBusy(true);
    try {
      const { httpsCallable, getFunctions } = await import("firebase/functions");
      const { firebaseApp } = await import("@/lib/firebase");
      const fn = httpsCallable<
        { tourneeId: string; clientId: string },
        { ok: true; messageId: string; sentTo: string; numeroBL: string; velosCount: number; clientName: string }
      >(getFunctions(firebaseApp, "europe-west1"), "sendBlToFranck");
      const r = await fn({ tourneeId, clientId });
      setDone({ numeroBL: r.data.numeroBL, velosCount: r.data.velosCount });
    } catch (e) {
      alert("Erreur : " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <span
        className="px-2 py-0.5 text-[11px] rounded border bg-emerald-100 border-emerald-400 text-emerald-800"
        title={`BL ${done.numeroBL} · ${done.velosCount} vélos · envoyé à Franck@axdis.fr`}
      >
        ✓ BL envoyé
      </span>
    );
  }
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        send();
      }}
      disabled={busy}
      className="px-2 py-0.5 text-[11px] rounded border bg-white border-purple-300 text-purple-700 hover:bg-purple-50 disabled:opacity-60"
      title="Envoyer le BL à Franck@axdis.fr pour impression (réservé Naomi/admin — workflow compta)"
    >
      {busy ? "⏳ Envoi…" : "📤 BL à Franck"}
    </button>
  );
}

// Yoann 2026-05-04 : bouton "Envoyer tous les BL de cette tournée à Franck".
// Placé dans la modal tournée à côté de "Imprimer tous". Itère sur les clients
// de la tournée et envoie un BL par client via sendBlToFranck. Persiste
// blFranckEnvoyeAt sur chaque livraison pour éviter les doublons.
function SendBlFranckTourneeBtn({
  tourneeId,
  clients,
  livraisons,
}: {
  tourneeId: string;
  clients: Array<{ clientId: string; entreprise: string }>;
  livraisons: LivraisonRow[];
}) {
  const [busy, setBusy] = useState(false);
  // Filtre : exclut les clients dont la livraison a déjà blFranckEnvoyeAt.
  const restantsAEnvoyer = useMemo(() => {
    return clients.filter((c) => {
      const liv = livraisons.find((l) => l.clientId === c.clientId);
      const sent = (liv as { blFranckEnvoyeAt?: string | null } | undefined)?.blFranckEnvoyeAt;
      return !sent;
    });
  }, [clients, livraisons]);

  const sendAll = async () => {
    if (restantsAEnvoyer.length === 0) {
      alert("Tous les BL de cette tournée ont déjà été envoyés.");
      return;
    }
    const lines = restantsAEnvoyer.map((c) => `• ${c.entreprise}`).join("\n");
    if (!confirm(`Envoyer ${restantsAEnvoyer.length} BL à Franck@axdis.fr ?\n\n${lines}`)) return;
    setBusy(true);
    let okCount = 0;
    const failed: string[] = [];
    try {
      const { httpsCallable, getFunctions } = await import("firebase/functions");
      const { firebaseApp, db } = await import("@/lib/firebase");
      const { collection, query, where, getDocs, updateDoc, serverTimestamp } = await import("firebase/firestore");
      const fn = httpsCallable<
        { tourneeId: string; clientId: string },
        { ok: true; numeroBL: string; velosCount: number }
      >(getFunctions(firebaseApp, "europe-west1"), "sendBlToFranck");
      for (const c of restantsAEnvoyer) {
        try {
          await fn({ tourneeId, clientId: c.clientId });
          try {
            const livSnap = await getDocs(query(
              collection(db, "livraisons"),
              where("tourneeId", "==", tourneeId),
              where("clientId", "==", c.clientId),
            ));
            for (const ld of livSnap.docs) {
              await updateDoc(ld.ref, {
                blFranckEnvoyeAt: new Date().toISOString(),
                updatedAt: serverTimestamp(),
              });
            }
          } catch (persistErr) {
            console.error("[BL Franck tournée] persist failed", c, persistErr);
          }
          okCount++;
        } catch (err) {
          failed.push(`${c.entreprise} (${err instanceof Error ? err.message : "?"})`);
        }
      }
      alert(
        `✅ ${okCount}/${restantsAEnvoyer.length} envoyés${
          failed.length > 0 ? `\n❌ Échecs :\n${failed.join("\n")}` : ""
        }`
      );
    } finally {
      setBusy(false);
    }
  };

  const allSent = restantsAEnvoyer.length === 0;
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        void sendAll();
      }}
      disabled={busy || allSent}
      className={`text-xs px-3 py-1.5 rounded font-medium whitespace-nowrap ${
        allSent
          ? "bg-emerald-100 text-emerald-700 cursor-default"
          : "bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50"
      }`}
      title={allSent
        ? "Tous les BL de cette tournée déjà envoyés à Franck"
        : `Envoyer les ${restantsAEnvoyer.length} BL non encore envoyés à Franck@axdis.fr`}
    >
      {busy
        ? "⏳ Envoi…"
        : allSent
          ? "✅ Tous envoyés"
          : `📤 Envoyer ${restantsAEnvoyer.length} BL à Franck`}
    </button>
  );
}

// Yoann 2026-05-04 : bouton mass "Envoyer tous les BL prêts à Franck".
// Critère "prêt" : livraison non-annulée, datePrevue dans la fenêtre visible,
// counts.prepares >= nbVelos (toutes les étiquettes posées). Évite les doublons
// avec blFranckEnvoyeAt persisté en Firestore après chaque envoi réussi.
function BLFranckBatchBtn({ tournees }: { tournees: Tournee[] }) {
  const [busy, setBusy] = useState(false);
  const eligibles = useMemo(() => {
    type R = { tourneeId: string; clientId: string; clientName: string };
    const out: R[] = [];
    for (const t of tournees) {
      const tid = t.tourneeId;
      if (!tid) continue;
      if (t.statutGlobal === "annulee") continue;
      for (const l of t.livraisons) {
        if (!l.clientId) continue;
        if (l.statut === "annulee") continue;
        const counts = (l as { counts?: { prepares?: number } }).counts;
        const nbPrep = Number(counts?.prepares || 0);
        const nb = Number(l.nbVelos || l._count?.velos || 0);
        if (nb <= 0 || nbPrep < nb) continue;
        // Skip si déjà envoyé
        const sentAt = (l as { blFranckEnvoyeAt?: string | null }).blFranckEnvoyeAt;
        if (sentAt) continue;
        out.push({
          tourneeId: tid,
          clientId: l.clientId,
          clientName: l.client?.entreprise || "?",
        });
      }
    }
    return out;
  }, [tournees]);

  const sendAll = async () => {
    if (eligibles.length === 0) {
      alert("Aucun BL prêt à envoyer (préparation pas encore complète, ou déjà envoyés).");
      return;
    }
    const lines = eligibles.map((e) => `• ${e.clientName}`).join("\n");
    if (!confirm(`Envoyer ${eligibles.length} BL à Franck@axdis.fr ?\n\n${lines}`)) return;
    setBusy(true);
    let okCount = 0;
    const failed: string[] = [];
    try {
      const { httpsCallable, getFunctions } = await import("firebase/functions");
      const { firebaseApp, db } = await import("@/lib/firebase");
      const { collection, query, where, getDocs, updateDoc, serverTimestamp } = await import("firebase/firestore");
      const fn = httpsCallable<
        { tourneeId: string; clientId: string },
        { ok: true; numeroBL: string; velosCount: number }
      >(getFunctions(firebaseApp, "europe-west1"), "sendBlToFranck");
      for (const e of eligibles) {
        try {
          await fn({ tourneeId: e.tourneeId, clientId: e.clientId });
          // Persiste blFranckEnvoyeAt sur la livraison correspondante
          // (la cloud function n'écrit pas ce champ → on le pose côté client
          // pour ne pas re-envoyer au prochain batch).
          try {
            const livSnap = await getDocs(query(
              collection(db, "livraisons"),
              where("tourneeId", "==", e.tourneeId),
              where("clientId", "==", e.clientId),
            ));
            for (const ld of livSnap.docs) {
              await updateDoc(ld.ref, {
                blFranckEnvoyeAt: new Date().toISOString(),
                updatedAt: serverTimestamp(),
              });
            }
          } catch (persistErr) {
            console.error("[BL Franck batch] persist failed", e, persistErr);
          }
          okCount++;
        } catch (err) {
          failed.push(`${e.clientName} (${err instanceof Error ? err.message : "?"})`);
        }
      }
      const summary = `✅ ${okCount}/${eligibles.length} envoyés${
        failed.length > 0 ? `\n❌ Échecs :\n${failed.join("\n")}` : ""
      }`;
      alert(summary);
    } finally {
      setBusy(false);
    }
  };

  const label = eligibles.length > 0
    ? `📤 BL Franck (${eligibles.length} prêt${eligibles.length > 1 ? "s" : ""})`
    : "📤 BL Franck";

  return (
    <button
      onClick={sendAll}
      disabled={busy || eligibles.length === 0}
      className="px-3 py-1.5 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm font-medium whitespace-nowrap disabled:opacity-50"
      title={eligibles.length > 0
        ? `Envoie en lot les ${eligibles.length} BL prêts (préparation complète) à Franck@axdis.fr`
        : "Aucun BL prêt à envoyer (préparation incomplète ou déjà envoyés)"}
    >
      {busy ? "⏳ Envoi en cours…" : label}
    </button>
  );
}

// Modal liste FNUCI d'un client (Yoann 2026-05-01). Affiche tous les
// vélos du client présents dans la progression de la tournée avec leur
// FNUCI et l'état des 4 étapes (prép / charg / livr / mont). Permet
// de copier la liste au format CSV pour Tiffany / COFRAC.
type FnuciListProgression = {
  clients?: {
    clientId: string;
    entreprise?: string;
    velos?: {
      veloId: string;
      fnuci: string | null;
      datePreparation?: string | null;
      dateChargement?: string | null;
    }[];
    totals: { total: number; prepare: number; charge: number; livre: number; monte: number };
  }[];
} | null;
function FnuciListModal({
  clientId,
  entreprise,
  progression,
  onClose,
}: {
  clientId: string;
  entreprise: string;
  progression: FnuciListProgression;
  onClose: () => void;
}) {
  const cp = progression?.clients?.find((c) => c.clientId === clientId);
  const velos = cp?.velos || [];
  const withFnuci = velos.filter((v) => v.fnuci);
  const sansFnuci = velos.filter((v) => !v.fnuci);

  const copyCsv = async () => {
    const lines = ["Entreprise;FNUCI"];
    for (const v of withFnuci) lines.push(`${entreprise};${v.fnuci}`);
    const text = lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      alert(`✓ ${withFnuci.length} FNUCI copiés au presse-papier (format CSV)`);
    } catch {
      // Fallback : prompt avec le texte
      window.prompt("Copie manuelle (Ctrl+A puis Ctrl+C) :", text);
    }
  };

  const copyList = async () => {
    const text = withFnuci.map((v) => v.fnuci).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      alert(`✓ ${withFnuci.length} FNUCI copiés au presse-papier (1 par ligne)`);
    } catch {
      window.prompt("Copie manuelle :", text);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-[70] p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl p-5 w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-start mb-3">
          <div>
            <h2 className="text-lg font-semibold">📋 FNUCI de {entreprise}</h2>
            {cp && (
              <div className="text-xs text-gray-500 mt-0.5">
                {withFnuci.length}/{cp.totals.total} vélos avec FNUCI assigné · Prép {cp.totals.prepare}/{cp.totals.total} · Charg {cp.totals.charge}/{cp.totals.total} · Livr {cp.totals.livre}/{cp.totals.total} · Mont {cp.totals.monte}/{cp.totals.total}
              </div>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>

        {!cp ? (
          <div className="py-6 text-center text-sm text-gray-500 italic">
            Aucune donnée de progression pour ce client. Ouvre la tournée pour charger les vélos.
          </div>
        ) : (
          <>
            <div className="flex gap-2 mb-3">
              <button
                onClick={copyList}
                disabled={withFnuci.length === 0}
                className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                📋 Copier ({withFnuci.length} FNUCI)
              </button>
              <button
                onClick={copyCsv}
                disabled={withFnuci.length === 0}
                className="px-3 py-1.5 text-xs bg-white border border-blue-300 text-blue-700 rounded hover:bg-blue-50 disabled:opacity-50"
              >
                📊 Copier en CSV (Entreprise;FNUCI)
              </button>
            </div>

            {withFnuci.length > 0 && (
              <div className="border rounded-lg overflow-hidden mb-3">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium text-gray-600">#</th>
                      <th className="text-left px-3 py-2 font-medium text-gray-600">FNUCI</th>
                      <th className="text-center px-2 py-2 font-medium text-gray-600">Prép</th>
                      <th className="text-center px-2 py-2 font-medium text-gray-600">Charg</th>
                      <th className="text-center px-2 py-2 font-medium text-gray-600">Livr</th>
                      <th className="text-center px-2 py-2 font-medium text-gray-600">Mont</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {withFnuci.map((v, i) => {
                      const stages = v as unknown as Record<string, string | null>;
                      const ok = (k: string) => (stages[k] ? "✓" : "—");
                      return (
                        <tr key={v.veloId} className="hover:bg-gray-50">
                          <td className="px-3 py-1.5 text-gray-400">{i + 1}</td>
                          <td className="px-3 py-1.5 font-mono font-bold">{v.fnuci}</td>
                          <td className="text-center px-2 py-1.5">{ok("datePreparation")}</td>
                          <td className="text-center px-2 py-1.5">{ok("dateChargement")}</td>
                          <td className="text-center px-2 py-1.5">{ok("dateLivraisonScan")}</td>
                          <td className="text-center px-2 py-1.5">{ok("dateMontage")}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {sansFnuci.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded p-2 text-[11px] text-amber-800">
                ⚠ {sansFnuci.length} vélo{sansFnuci.length > 1 ? "s" : ""} sans FNUCI assigné
                (slot vide sur la commande). Scanne-les depuis la prep pour
                affecter un FNUCI.
              </div>
            )}
          </>
        )}

        <div className="mt-4 flex justify-end">
          <button onClick={onClose} className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50">
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}

function BriefEquipeModal({
  tournee,
  tourneeNumber,
  monteurs,
  equipe,
  clientInfo,
  deployPlan,
  onClose,
}: {
  tournee: Tournee;
  tourneeNumber: number | null;
  monteurs: number;
  equipe: EquipeMember[];
  clientInfo: Map<string, ClientPoint>;
  deployPlan: { steps: DeployStep[]; totalElapsed: number };
  onClose: () => void;
}) {
  const departures = useContext(TourneeDeparturesContext);
  const dep = departures?.get(tourneeKeyForDeparture(tournee));
  const departMin = dep?.min ?? DEPART_MIN_DEFAULT;
  const departMax = dep?.max ?? DEPART_MAX_DEFAULT;
  const arrivals = computeArrivalTimes(tournee, monteurs, departMin, departMax);
  const findName = (id: string | null | undefined) =>
    id ? equipe.find((m) => m.id === id)?.nom || "?" : null;
  const fmtHM = (mins: number) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}h${String(m).padStart(2, "0")}`;
  };

  const text = useMemo(() => {
    const liv0 = tournee.livraisons[0];
    const dateStr = tournee.datePrevue
      ? new Date(tournee.datePrevue).toLocaleDateString("fr-FR", {
          weekday: "long", day: "numeric", month: "long",
        })
      : "";
    const chauffeur = findName(liv0?.chauffeurId);
    const chefIds = (liv0?.chefEquipeIds && liv0.chefEquipeIds.length > 0)
      ? liv0.chefEquipeIds
      : (liv0?.chefEquipeId ? [liv0.chefEquipeId] : []);
    const chefs = chefIds.map(findName).filter(Boolean);
    const monteurNames = (liv0?.monteurIds || []).map(findName).filter(Boolean);
    const prepNames = (liv0?.preparateurIds || []).map(findName).filter(Boolean);
    const totalVelos = tournee.totalVelos;
    const heureDepart = liv0?.heureDepartTournee || "8h30";
    const dejaCharge = !!liv0?.dejaChargee;

    const lines: string[] = [];
    lines.push(`🚛 *TOURNÉE ${tourneeNumber ?? ""}* — ${dateStr.toUpperCase()}`);
    lines.push(`${totalVelos} vélos · ${tournee.livraisons.length} arrêt${tournee.livraisons.length > 1 ? "s" : ""}`);
    lines.push("");
    lines.push(`📍 Départ : ${dejaCharge ? "direct chez le client (camion déjà chargé)" : "AXDIS PRO Le Blanc-Mesnil"} à *${heureDepart}*`);
    lines.push("");
    if (chauffeur) lines.push(`🚐 *Chauffeur* : ${chauffeur}`);
    if (chefs.length > 0) lines.push(`🚦 *Chef d'équipe* : ${chefs.join(", ")}`);
    if (monteurNames.length > 0) lines.push(`🔧 *Monteurs* (${monteurNames.length}) : ${monteurNames.join(", ")}`);
    if (prepNames.length > 0) lines.push(`📦 *Préparateurs* : ${prepNames.join(", ")}`);
    lines.push("");
    lines.push("─".repeat(30));

    for (let i = 0; i < tournee.livraisons.length; i++) {
      const l = tournee.livraisons[i];
      const c = l.clientId ? clientInfo.get(l.clientId) : null;
      const arr = arrivals[i];
      const adresse = [l.client.adresse, l.client.codePostal, l.client.ville]
        .filter(Boolean).join(", ");
      const tel = l.client.telephone || "";
      const apporteur = c?.apporteur || "";
      const monteursIci = deployPlan.steps[i]?.monteursAffectes ?? monteurNames.length;
      const tempsMontage = deployPlan.steps[i]?.tempsSurPlace ?? 0;
      lines.push("");
      lines.push(`*ARRÊT ${i + 1}* — ${l.client.entreprise}`);
      lines.push(`  📍 ${adresse || "—"}`);
      if (tel) lines.push(`  📞 ${tel}`);
      if (apporteur) lines.push(`  🤝 Apporteur : ${apporteur}`);
      if (arr) {
        lines.push(`  ⏰ Arrivée prévue : ${fmtHM(arr.minMin)} – ${fmtHM(arr.maxMin)}`);
      }
      lines.push(`  🚲 ${l.nbVelos || l._count.velos} vélos · ${monteursIci} monteur${monteursIci > 1 ? "s" : ""} sur place${tempsMontage ? ` · ~${Math.round(tempsMontage)}min` : ""}`);
      const valid = l.validationClient;
      if (valid) {
        const icon = valid.status === "validee_mail" ? "📧" : "📞";
        lines.push(`  ${icon} Client validé par ${valid.par || "?"}`);
      } else {
        lines.push(`  ⚠ CLIENT NON VALIDÉ — confirmer avant de partir`);
      }
    }
    lines.push("");
    lines.push("─".repeat(30));
    lines.push("Bonne tournée 🚴‍♂️");
    return lines.join("\n");
  }, [tournee, tourneeNumber, arrivals, equipe, clientInfo, deployPlan]);
  void findName;

  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[70] p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-2xl max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-3">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">📋 Brief équipe</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Texte à envoyer aux équipes la veille (WhatsApp, mail). Format Markdown léger
              compatible WhatsApp (*gras*).
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>
        <textarea
          value={text}
          readOnly
          className="w-full h-96 px-3 py-2 border rounded-lg font-mono text-xs whitespace-pre overflow-auto"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            onClick={copy}
            className={`px-4 py-2 rounded-lg text-sm font-medium ${
              copied ? "bg-green-600 text-white" : "bg-purple-600 text-white hover:bg-purple-700"
            }`}
          >
            {copied ? "✓ Copié dans le presse-papier" : "📋 Copier le brief"}
          </button>
        </div>
      </div>
    </div>
  );
}

function MultiIntervenantSelect({
  value,
  onChange,
  groups,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  groups: { label: string; role: string; options: { key: string; label: string }[] }[];
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  };

  const selectedLabels = value
    .map((v) => {
      for (const g of groups) {
        const opt = g.options.find((o) => `${g.role}:${o.key}` === v);
        if (opt) return opt.label;
      }
      return null;
    })
    .filter((x): x is string => !!x);

  const summary = selectedLabels.length === 0
    ? "👁️ Tous les intervenants"
    : selectedLabels.length === 1
      ? `👁️ ${selectedLabels[0]}`
      : `👁️ ${selectedLabels.length} intervenants`;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="px-3 py-1.5 border-2 border-gray-200 rounded-lg text-sm bg-white focus:border-green-500 focus:outline-none flex items-center gap-2 max-w-[260px]"
        title="Filtrer par un ou plusieurs intervenants"
      >
        <span className="truncate">{summary}</span>
        <span className="text-gray-400 text-xs">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 mt-1 z-30 w-72 max-h-[60vh] overflow-auto bg-white border rounded-lg shadow-lg p-2 text-sm">
          {value.length > 0 && (
            <div className="flex justify-between items-center px-2 py-1 mb-1 border-b">
              <span className="text-xs text-gray-500">{value.length} sélectionné{value.length > 1 ? "s" : ""}</span>
              <button onClick={() => onChange([])} className="text-xs text-red-600 hover:underline">Tout effacer</button>
            </div>
          )}
          {groups.filter((g) => g.options.length > 0).map((g) => (
            <div key={g.role} className="mb-1.5 last:mb-0">
              <div className="text-[11px] uppercase font-semibold text-gray-500 px-2 py-0.5">{g.label}</div>
              {g.options.map((opt) => {
                const id = `${g.role}:${opt.key}`;
                const checked = value.includes(id);
                return (
                  <label
                    key={id}
                    className={`flex items-center gap-2 px-2 py-1 rounded cursor-pointer ${checked ? "bg-emerald-50" : "hover:bg-gray-50"}`}
                  >
                    <input type="checkbox" checked={checked} onChange={() => toggle(id)} />
                    <span className="truncate">{opt.label}</span>
                  </label>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Bandeau sessions atelier (Yoann 2026-05-01) : affiche au monteur ses
// sessions de montage atelier à venir (planifiees ou en cours), pour
// qu il sache où aller quel jour.
function SessionsAtelierBanner({ monteurId }: { monteurId: string }) {
  type S = {
    id: string;
    entrepotNom: string;
    date: string;
    statut: string;
    quantitePrevue?: number | null;
    chefNom?: string;
    monteurNoms: string[];
    notes?: string;
  };
  const [sessions, setSessions] = useState<S[]>([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      const { collection, query, where, onSnapshot, orderBy } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      const today = new Date().toISOString().slice(0, 10);
      const q = query(
        collection(db, "sessionsMontageAtelier"),
        where("monteurIds", "array-contains", monteurId),
        where("date", ">=", today),
        orderBy("date", "asc"),
      );
      const unsub = onSnapshot(q, (snap) => {
        if (!alive) return;
        const rows: S[] = [];
        for (const d of snap.docs) {
          const data = d.data();
          if (data.statut === "annulee" || data.statut === "terminee") continue;
          rows.push({
            id: d.id,
            entrepotNom: String(data.entrepotNom || "?"),
            date: String(data.date || ""),
            statut: String(data.statut || "planifiee"),
            quantitePrevue: typeof data.quantitePrevue === "number" ? data.quantitePrevue : null,
            chefNom: typeof data.chefNom === "string" ? data.chefNom : undefined,
            monteurNoms: Array.isArray(data.monteurNoms) ? data.monteurNoms : [],
            notes: typeof data.notes === "string" ? data.notes : undefined,
          });
        }
        setSessions(rows);
      });
      return () => unsub();
    })();
    return () => { alive = false; };
  }, [monteurId]);

  if (sessions.length === 0) return null;
  return (
    <div className="mb-4 bg-amber-50 border-2 border-amber-300 rounded-xl p-3">
      <div className="text-sm font-bold text-amber-900 mb-2">
        🔧 Tes sessions montage atelier à venir ({sessions.length})
      </div>
      <div className="space-y-2">
        {sessions.map((s) => (
          <div key={s.id} className="bg-white border border-amber-200 rounded-lg p-2 text-xs">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono font-bold">{s.date}</span>
              <span className="text-amber-700 font-semibold">→ Atelier {s.entrepotNom}</span>
              {s.quantitePrevue && (
                <span className="text-gray-600">· {s.quantitePrevue} vélos prévus</span>
              )}
              {s.chefNom && <span className="text-gray-600">· Chef : {s.chefNom}</span>}
            </div>
            <div className="mt-1 text-gray-600">
              Avec : {s.monteurNoms.length} monteur{s.monteurNoms.length > 1 ? "s" : ""}
              {s.notes && <span className="italic"> · {s.notes}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// PickEntrepotModal — Yoann 2026-05-03
// Étape 1 du bouton "+ Tournée" depuis /livraisons : on choisit
// l entrepôt de départ. Liste filtrée (non-fournisseur, non-éphémère,
// non-archivé, avec stock > 0). Click → renvoie l entrepôt au parent
// qui ouvrira PlanifierJourneeModal.
function PickEntrepotModal({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (e: { id: string; nom: string; stockCartons: number; stockVelosMontes: number; isFournisseur: boolean }) => void;
}) {
  type Row = {
    id: string;
    nom: string;
    ville: string;
    role: string;
    isPrimary: boolean;
    archived: boolean;
    stockCartons: number;
    stockVelosMontes: number;
  };
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      const { collection, onSnapshot } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      const unsub = onSnapshot(collection(db, "entrepots"), (snap) => {
        if (!alive) return;
        const list: Row[] = [];
        for (const d of snap.docs) {
          const data = d.data();
          list.push({
            id: d.id,
            nom: String(data.nom || ""),
            ville: String(data.ville || ""),
            role: String(data.role || "stock"),
            isPrimary: !!data.isPrimary,
            archived: !!data.dateArchivage,
            stockCartons: Number(data.stockCartons || 0),
            stockVelosMontes: Number(data.stockVelosMontes || 0),
          });
        }
        list.sort((a, b) => {
          if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
          return a.nom.localeCompare(b.nom);
        });
        setRows(list);
      });
      return () => unsub();
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Yoann 2026-05-03 : on inclut les fournisseurs (AXDIS PRO = point de
  // départ historique des tournées, stock illimité côté planificateur).
  // On exclut juste éphémères (Firat = camion client) + archivés.
  const eligibles = rows.filter(
    (r) => !r.archived && r.role !== "ephemere",
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl max-w-lg w-full p-5 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="text-base font-bold text-gray-900">+ Nouvelle tournée</h2>
            <div className="text-xs text-gray-500 mt-0.5">Choisis l&apos;entrepôt de départ</div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">
            ×
          </button>
        </div>
        {eligibles.length === 0 ? (
          <div className="text-sm text-gray-500 italic py-6 text-center">
            Aucun entrepôt éligible (non-fournisseur, non-éphémère, non-archivé).
          </div>
        ) : (
          <div className="space-y-2">
            {eligibles.map((e) => {
              const isFournisseur = e.role === "fournisseur";
              const total = e.stockCartons + e.stockVelosMontes;
              const empty = !isFournisseur && total === 0;
              return (
                <button
                  key={e.id}
                  onClick={() =>
                    onPick({
                      id: e.id,
                      nom: e.nom,
                      stockCartons: e.stockCartons,
                      stockVelosMontes: e.stockVelosMontes,
                      isFournisseur,
                    })
                  }
                  className={`w-full text-left p-3 border rounded-lg transition ${
                    empty
                      ? "bg-gray-50 border-gray-200 hover:bg-gray-100"
                      : isFournisseur
                        ? "bg-amber-50 border-amber-300 hover:bg-amber-100"
                        : "bg-white border-blue-300 hover:bg-blue-50"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-sm flex items-center gap-1">
                        {isFournisseur ? "🚛" : e.isPrimary ? "🏭" : "📦"} {e.nom}
                        {isFournisseur && <span className="text-[9px] px-1 py-0.5 bg-amber-200 text-amber-900 rounded uppercase">Fournisseur</span>}
                      </div>
                      <div className="text-[11px] text-gray-500">{e.ville}</div>
                    </div>
                    {isFournisseur ? (
                      <div className="text-[10px] text-amber-800 font-medium italic flex-shrink-0">
                        Stock ∞
                      </div>
                    ) : (
                      <div className="flex gap-2 text-[11px] flex-shrink-0">
                        <div className="bg-orange-50 border border-orange-200 rounded px-2 py-1 text-center">
                          <div className="font-bold text-orange-900">{e.stockCartons}</div>
                          <div className="text-[9px] uppercase text-orange-700">Cartons</div>
                        </div>
                        <div className="bg-emerald-50 border border-emerald-200 rounded px-2 py-1 text-center">
                          <div className="font-bold text-emerald-900">{e.stockVelosMontes}</div>
                          <div className="text-[9px] uppercase text-emerald-700">Montés</div>
                        </div>
                      </div>
                    )}
                  </div>
                  {empty && (
                    <div className="text-[10px] text-gray-500 italic mt-1">Stock vide — planif possible mais pas de tournée réelle</div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
