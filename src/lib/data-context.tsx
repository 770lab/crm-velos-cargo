"use client";

import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from "react";
import { gasGet } from "./gas";

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
  nbVelosCommandes: number;
  stats: {
    totalVelos: number;
    livres: number;
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
  monteurIds?: string[];
  nbMonteurs?: number;
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

type EquipeRole = "chauffeur" | "chef" | "monteur";

interface EquipeMember {
  id: string;
  nom: string;
  role: EquipeRole;
  telephone: string | null;
  email: string | null;
  actif: boolean;
  notes: string | null;
  createdAt?: string | null;
}

interface DataState {
  stats: Stats | null;
  clients: ClientRow[];
  carte: ClientPoint[];
  livraisons: LivraisonRow[];
  equipe: EquipeMember[];
  loading: boolean;
  refresh: (key?: "stats" | "clients" | "carte" | "livraisons" | "equipe") => Promise<void>;
}

const DataContext = createContext<DataState>({
  stats: null,
  clients: [],
  carte: [],
  livraisons: [],
  equipe: [],
  loading: true,
  refresh: async () => {},
});

export function useData() {
  return useContext(DataContext);
}

export { type Stats, type ClientRow, type ClientPoint, type LivraisonRow, type EquipeMember, type EquipeRole };

export function DataProvider({ children }: { children: ReactNode }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [carte, setCarte] = useState<ClientPoint[]>([]);
  const [livraisons, setLivraisons] = useState<LivraisonRow[]>([]);
  const [equipe, setEquipe] = useState<EquipeMember[]>([]);
  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [s, c, ca, l, e] = await Promise.all([
      gasGet("getStats"),
      gasGet("getClients"),
      gasGet("getCarte"),
      gasGet("getLivraisons"),
      gasGet("listEquipe").catch(() => ({ items: [] })),
    ]);
    setStats(s);
    setClients(c);
    setCarte(ca);
    setLivraisons(l);
    setEquipe(Array.isArray(e?.items) ? e.items : []);
    setLoading(false);
  }, []);

  const refresh = useCallback(async (key?: "stats" | "clients" | "carte" | "livraisons" | "equipe") => {
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
    <DataContext.Provider value={{ stats, clients, carte, livraisons, equipe, loading, refresh }}>
      {children}
    </DataContext.Provider>
  );
}
