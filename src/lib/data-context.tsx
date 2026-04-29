"use client";

import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from "react";
import { gasGet } from "./gas";

interface Stats {
  totalClients: number;
  totalVelos: number;
  velosLivres: number;
  velosPlanifies: number;
  certificatsRecus: number;
  velosFacturables: number;
  velosFactures: number;
  clientsDocsComplets: number;
  progression: number;
  livraisonsParStatut: Record<string, number>;
}

interface ClientRow {
  id: string;
  entreprise: string;
  siren: string | null;
  contact: string | null;
  email: string | null;
  telephone: string | null;
  ville: string | null;
  codePostal: string | null;
  departement: string | null;
  apporteur: string | null;
  devisSignee: boolean;
  kbisRecu: boolean;
  attestationRecue: boolean;
  signatureOk: boolean;
  inscriptionBicycle: boolean;
  parcelleCadastrale: boolean;
  effectifMentionne: boolean;
  devisLien?: string | null;
  kbisLien?: string | null;
  attestationLien?: string | null;
  signatureLien?: string | null;
  bicycleLien?: string | null;
  parcelleCadastraleLien?: string | null;
  kbisDate?: string | null;
  dateEngagement?: string | null;
  liasseFiscaleDate?: string | null;
  /** ISO date du dernier clic "Ouvrir dans Gmail" depuis le bouton enveloppe
   *  /clients. Pas une preuve d'envoi (Gmail s'ouvre dans un onglet séparé)
   *  mais un signal "rappel composé / envoyé" pour colorer l'icône en vert. */
  mailRappelEnvoyeAt?: string | null;
  nbVelosCommandes: number;
  /** Statut métier du client. "annulee" = commande annulée (soft cancel
   *  via cancelClient — restaurable via restoreClient). null/absent = actif. */
  statut?: string | null;
  raisonAnnulation?: string | null;
  annuleeAt?: string | null;
  stats: {
    totalVelos: number;
    livres: number;
    /** Vélos avec dateMontage remplie (les 3 photos preuve montage uploadées). */
    montes?: number;
    /** Livraisons effectivement livrées de ce client qui ont leur photo BL signé. */
    blSignes?: number;
    /** Total des livraisons en statut "livree" pour ce client (dénominateur du BL). */
    totalLivraisonsLivrees?: number;
    certificats: number;
    facturables: number;
    factures: number;
    planifies?: number;
  };
}

interface ClientPoint {
  id: string;
  entreprise: string;
  contact: string | null;
  apporteur: string | null;
  ville: string | null;
  departement: string | null;
  adresse: string | null;
  codePostal: string | null;
  lat: number;
  lng: number;
  nbVelos: number;
  modeLivraison: string;
  telephone: string | null;
  email: string | null;
  docsComplets: boolean;
  velosLivres: number;
  velosPlanifies: number;
}

interface LivraisonRow {
  id: string;
  clientId?: string | null;
  datePrevue: string | null;
  dateEffective: string | null;
  statut: string;
  notes: string | null;
  nbVelos?: number;
  tourneeId?: string | null;
  mode?: string | null;
  chauffeurId?: string | null;
  chefEquipeId?: string | null;
  chefEquipeIds?: string[];
  monteurIds?: string[];
  preparateurIds?: string[];
  nbMonteurs?: number;
  /** Numéro stable de tournée persisté côté Firestore (1, 2, 3, …) — attribué
   *  à la création et qui ne bouge plus, même si une tournée antérieure est
   *  annulée. null pour les livraisons importées avant la migration. */
  tourneeNumero?: number | null;
  /** ISO timestamp du dernier click sur le bouton "Envoyer commande à AXDIS".
   *  Sert à : (1) afficher un état "déjà envoyé" sur le bouton,
   *  (2) servir de clé de matching quand on auto-importera les bons en retour. */
  bonCommandeEnvoyeAt?: string | null;
  /** Raison de l'annulation (saisie au moment du clic sur "annuler" /
   *  "Annuler la tournée"). null tant que la livraison n'est pas annulée. */
  raisonAnnulation?: string | null;
  /** Validation préalable client : confirmation que le client est joignable
   *  et OK pour la date prévue. Sans ça, on ne livre pas (pas de déplacement
   *  inutile). Posée par le chef d'équipe ou l'apporteur. */
  validationClient?: {
    status: "validee_orale" | "validee_mail";
    par: string | null;
    note: string | null;
    at: string;
  } | null;
  client: {
    entreprise: string;
    ville: string | null;
    adresse: string | null;
    codePostal?: string | null;
    departement?: string | null;
    telephone?: string | null;
    lat?: number | null;
    lng?: number | null;
  };
  _count: { velos: number };
}

// superadmin : voit tout y compris Finances et masse salariale.
// admin      : gestion operationnelle complete MAIS sans acces aux donnees
//              financieres sensibles (salaires, primes, masse salariale).
// Les autres roles sont des roles terrain (chauffeur, chef, etc.).
type EquipeRole = "superadmin" | "admin" | "chauffeur" | "chef" | "monteur" | "apporteur" | "preparateur";

interface EquipeMember {
  id: string;
  nom: string;
  role: EquipeRole;
  telephone: string | null;
  email: string | null;
  actif: boolean;
  notes: string | null;
  createdAt?: string | null;
  hasCode?: boolean;
  /** EUR/jour de travail, sert au calcul de la masse salariale par tournée. */
  salaireJournalier?: number | null;
  /** EUR par vélo (0-5). Pour chauffeurs/chefs : tous les vélos de la tournée.
   *  Pour monteurs : split entre les monteurs de l'équipe sur la tournée. */
  primeVelo?: number | null;
}

type CamionType = "gros" | "moyen" | "petit" | "retrait";

interface Camion {
  id: string;
  nom: string;
  type: CamionType;
  capaciteVelos: number;
  peutEntrerParis: boolean;
  actif: boolean;
  notes: string | null;
  createdAt?: string | null;
}

interface BonEnlevement {
  id: string;
  receivedAt: string;
  fournisseur: string;
  numeroDoc: string;
  dateDoc: string;
  tourneeRef: string;
  tourneeDate: string;
  tourneeNumero: number | string;
  tourneeId: string;
  quantite: number | string;
  driveUrl: string;
  fileName: string;
  fromEmail: string;
  subject: string;
  messageId: string;
}

interface DataState {
  stats: Stats | null;
  clients: ClientRow[];
  carte: ClientPoint[];
  livraisons: LivraisonRow[];
  equipe: EquipeMember[];
  flotte: Camion[];
  bonsEnlevement: BonEnlevement[];
  loading: boolean;
  refresh: (key?: "stats" | "clients" | "carte" | "livraisons" | "equipe" | "flotte" | "bonsEnlevement") => Promise<void>;
}

export const DataContext = createContext<DataState>({
  stats: null,
  clients: [],
  carte: [],
  livraisons: [],
  equipe: [],
  flotte: [],
  bonsEnlevement: [],
  loading: true,
  refresh: async () => {},
});

export function useData() {
  return useContext(DataContext);
}

export type { Stats, ClientRow, ClientPoint, LivraisonRow, EquipeMember, EquipeRole, Camion, CamionType, BonEnlevement, DataState };

export function DataProvider({ children }: { children: ReactNode }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [carte, setCarte] = useState<ClientPoint[]>([]);
  const [livraisons, setLivraisons] = useState<LivraisonRow[]>([]);
  const [equipe, setEquipe] = useState<EquipeMember[]>([]);
  const [flotte, setFlotte] = useState<Camion[]>([]);
  const [bonsEnlevement, setBonsEnlevement] = useState<BonEnlevement[]>([]);
  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [s, c, ca, l, e, f, b] = await Promise.all([
      gasGet("getStats"),
      gasGet("getClients"),
      gasGet("getCarte"),
      gasGet("getLivraisons"),
      gasGet("listEquipe").catch(() => ({ items: [] })),
      gasGet("listFlotte").catch(() => ({ items: [] })),
      gasGet("getBonsEnlevement").catch(() => ({ items: [] })),
    ]);
    setStats(s);
    setClients(c);
    setCarte(ca);
    setLivraisons(l);
    setEquipe(Array.isArray(e?.items) ? e.items : []);
    setFlotte(Array.isArray(f?.items) ? f.items : []);
    setBonsEnlevement(Array.isArray(b?.items) ? b.items : []);
    setLoading(false);
  }, []);

  const refresh = useCallback(async (key?: "stats" | "clients" | "carte" | "livraisons" | "equipe" | "flotte" | "bonsEnlevement") => {
    if (!key) {
      await loadAll();
      return;
    }
    const fetchers = {
      stats: async () => setStats(await gasGet("getStats")),
      clients: async () => setClients(await gasGet("getClients")),
      carte: async () => setCarte(await gasGet("getCarte")),
      livraisons: async () => setLivraisons(await gasGet("getLivraisons")),
      equipe: async () => {
        const e = await gasGet("listEquipe").catch(() => ({ items: [] }));
        setEquipe(Array.isArray(e?.items) ? e.items : []);
      },
      flotte: async () => {
        const f = await gasGet("listFlotte").catch(() => ({ items: [] }));
        setFlotte(Array.isArray(f?.items) ? f.items : []);
      },
      bonsEnlevement: async () => {
        const b = await gasGet("getBonsEnlevement").catch(() => ({ items: [] }));
        setBonsEnlevement(Array.isArray(b?.items) ? b.items : []);
      },
    };
    await fetchers[key]();
  }, [loadAll]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  if (loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <svg viewBox="0 0 64 40" fill="none" className="w-20 h-20 text-green-600 mx-auto mb-4 animate-pulse">
            <circle cx="12" cy="30" r="9" stroke="currentColor" strokeWidth="2.5" />
            <circle cx="12" cy="30" r="2" fill="currentColor" />
            <circle cx="52" cy="30" r="9" stroke="currentColor" strokeWidth="2.5" />
            <circle cx="52" cy="30" r="2" fill="currentColor" />
            <path d="M12 30 L28 14 L42 14 L52 30" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M28 14 L24 30" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            <path d="M42 14 L46 8 L50 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M24 12 L32 12" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            <rect x="30" y="18" width="18" height="10" rx="2" stroke="currentColor" strokeWidth="2" fill="currentColor" fillOpacity="0.15" />
          </svg>
          <p className="text-gray-500 text-sm">Chargement des données...</p>
        </div>
      </div>
    );
  }

  return (
    <DataContext.Provider value={{ stats, clients, carte, livraisons, equipe, flotte, bonsEnlevement, loading, refresh }}>
      {children}
    </DataContext.Provider>
  );
}
