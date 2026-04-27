"use client";

/**
 * Provider data alimenté par Firestore au lieu de GAS.
 *
 * Expose strictement la même interface que `data-context.tsx` (mêmes types,
 * même `useData()`, même `refresh(key)`), pour que les pages existantes
 * fonctionnent sans changement après bascule dans `app-shell.tsx`.
 *
 * Stratégie :
 *   - Lecture en temps réel via onSnapshot (collections clients, livraisons, equipe, camions, verifications)
 *   - Stats calculées côté client à partir des clients/livraisons/vélos
 *   - carte dérivée depuis clients
 *   - bonsEnlevement : lu depuis Firestore (peut être vide)
 *
 * Rien n'est écrit ici — les écritures sont gérées dans les pages
 * (qui passeront progressivement de gasPost à des writes Firestore directs).
 */

import {
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";
import {
  collection,
  onSnapshot,
  query,
  where,
  type DocumentData,
  type QuerySnapshot,
  type Timestamp,
} from "firebase/firestore";
import { db } from "./firebase";
import {
  DataContext,
  type Stats,
  type ClientRow,
  type ClientPoint,
  type LivraisonRow,
  type EquipeMember,
  type Camion,
  type BonEnlevement,
} from "./data-context";

// ---------- mappers Firestore → API existante ----------

function tsToIso(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "toDate" in value &&
    typeof (value as Timestamp).toDate === "function"
  ) {
    return (value as Timestamp).toDate().toISOString();
  }
  return null;
}

function asInt(v: unknown): number {
  // Tolère les floats stockés par erreur en base (ex: nbVelosCommandes = 25.25
  // observé en prod 2026-04-28 sur certains imports) en arrondissant à l'entier
  // le plus proche. Sans ça, les sommes affichaient "6 358,25 commandés" au
  // lieu d'un entier sur le bandeau /carte.
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function clientFromDoc(id: string, d: DocumentData): ClientRow {
  return {
    id,
    entreprise: d.entreprise ?? "",
    siren: d.siren ?? null,
    contact: d.contact ?? null,
    email: d.email ?? null,
    telephone: d.telephone ?? null,
    ville: d.ville ?? null,
    codePostal: d.codePostal ?? null,
    departement: d.departement ?? null,
    apporteur: d.apporteur ?? null,
    devisSignee: !!d.docs?.devisSignee,
    kbisRecu: !!d.docs?.kbisRecu,
    attestationRecue: !!d.docs?.attestationRecue,
    signatureOk: !!d.docs?.signatureOk,
    inscriptionBicycle: !!d.docs?.inscriptionBicycle,
    parcelleCadastrale: !!d.docs?.parcelleCadastrale,
    effectifMentionne: !!d.effectifMentionne,
    devisLien: d.docLinks?.devis ?? null,
    kbisLien: d.docLinks?.kbis ?? null,
    attestationLien: d.docLinks?.attestation ?? null,
    signatureLien: d.docLinks?.signature ?? null,
    bicycleLien: d.docLinks?.bicycle ?? null,
    parcelleCadastraleLien: d.docLinks?.parcelleCadastrale ?? null,
    kbisDate: d.docDates?.kbis ?? null,
    dateEngagement: d.docDates?.engagement ?? null,
    liasseFiscaleDate: d.docDates?.liasseFiscale ?? null,
    nbVelosCommandes: asInt(d.nbVelosCommandes),
    stats: {
      totalVelos: asInt(d.stats?.totalVelos),
      livres: asInt(d.stats?.livres),
      montes: asInt(d.stats?.montes),
      blSignes: asInt(d.stats?.blSignes),
      totalLivraisonsLivrees: asInt(d.stats?.totalLivraisonsLivrees),
      certificats: asInt(d.stats?.certificats),
      facturables: asInt(d.stats?.facturables),
      factures: asInt(d.stats?.factures),
      planifies: asInt(d.stats?.planifies),
    },
  };
}

function pointFromClient(c: ClientRow, d: DocumentData): ClientPoint | null {
  const lat = typeof d.latitude === "number" ? d.latitude : null;
  const lng = typeof d.longitude === "number" ? d.longitude : null;
  if (lat == null || lng == null) return null;
  return {
    id: c.id,
    entreprise: c.entreprise,
    contact: c.contact,
    apporteur: c.apporteur,
    ville: c.ville,
    departement: c.departement,
    adresse: d.adresse ?? null,
    codePostal: c.codePostal,
    lat,
    lng,
    nbVelos: c.nbVelosCommandes,
    modeLivraison: d.modeLivraison ?? "",
    telephone: c.telephone,
    email: c.email,
    docsComplets:
      c.devisSignee && c.kbisRecu && c.attestationRecue && c.signatureOk,
    velosLivres: c.stats.livres,
    velosPlanifies: asInt(c.stats.planifies),
  };
}

function livraisonFromDoc(id: string, d: DocumentData): LivraisonRow {
  return {
    id,
    clientId: d.clientId ?? null,
    datePrevue: tsToIso(d.datePrevue),
    dateEffective: tsToIso(d.dateEffective),
    statut: d.statut ?? "planifiee",
    notes: d.notes ?? null,
    nbVelos: asInt(d.nbVelos),
    tourneeId: d.tourneeId ?? null,
    mode: d.mode ?? null,
    chauffeurId: d.chauffeurId ?? null,
    chefEquipeId: d.chefEquipeId ?? null,
    chefEquipeIds: Array.isArray(d.chefEquipeIds) ? d.chefEquipeIds : [],
    monteurIds: Array.isArray(d.monteurIds) ? d.monteurIds : [],
    preparateurIds: Array.isArray(d.preparateurIds) ? d.preparateurIds : [],
    nbMonteurs: d.nbMonteurs ?? 0,
    tourneeNumero: typeof d.tourneeNumero === "number" ? d.tourneeNumero : null,
    client: {
      entreprise: d.clientSnapshot?.entreprise ?? "",
      ville: d.clientSnapshot?.ville ?? null,
      adresse: d.clientSnapshot?.adresse ?? null,
      codePostal: d.clientSnapshot?.codePostal ?? null,
      departement: d.clientSnapshot?.departement ?? null,
      telephone: d.clientSnapshot?.telephone ?? null,
      lat: d.clientSnapshot?.lat ?? null,
      lng: d.clientSnapshot?.lng ?? null,
    },
    _count: { velos: asInt(d.nbVelos) },
  };
}

function equipeFromDoc(id: string, d: DocumentData): EquipeMember {
  return {
    id,
    nom: d.nom ?? "",
    role: d.role,
    telephone: d.telephone ?? null,
    email: d.email ?? null,
    actif: !!d.actif,
    notes: d.notes ?? null,
    createdAt: tsToIso(d.createdAt),
    hasCode: true, // tous ont un PIN après seed
    salaireJournalier: d.salaireJournalier ?? null,
    primeVelo: d.primeVelo ?? null,
  };
}

function camionFromDoc(id: string, d: DocumentData): Camion {
  return {
    id,
    nom: d.nom ?? "",
    type: d.type,
    capaciteVelos: asInt(d.capaciteVelos),
    peutEntrerParis: !!d.peutEntrerParis,
    actif: !!d.actif,
    notes: d.notes ?? null,
    createdAt: tsToIso(d.createdAt),
  };
}

function bonFromDoc(id: string, d: DocumentData): BonEnlevement {
  return {
    id,
    receivedAt: tsToIso(d.receivedAt) ?? "",
    fournisseur: d.fournisseur ?? "",
    numeroDoc: d.numeroDoc ?? "",
    dateDoc: d.dateDoc ?? "",
    tourneeRef: d.tourneeRef ?? "",
    tourneeDate: d.tourneeDate ?? "",
    tourneeNumero: d.tourneeNumero ?? "",
    tourneeId: d.tourneeId ?? "",
    quantite: d.quantite ?? "",
    driveUrl: d.storageUrl ?? d.driveUrl ?? "",
    fileName: d.fileName ?? "",
    fromEmail: d.fromEmail ?? "",
    subject: d.subject ?? "",
    messageId: d.messageId ?? "",
  };
}

// ---------- stats agrégées côté client ----------

function computeStats(
  clients: ClientRow[],
  livraisons: LivraisonRow[],
): Stats {
  const totalClients = clients.length;
  let totalVelos = 0;
  let velosLivres = 0;
  let velosPlanifies = 0;
  let certificatsRecus = 0;
  let velosFacturables = 0;
  let velosFactures = 0;
  let clientsDocsComplets = 0;
  for (const c of clients) {
    totalVelos += c.stats.totalVelos;
    velosLivres += c.stats.livres;
    velosPlanifies += asInt(c.stats.planifies);
    certificatsRecus += c.stats.certificats;
    velosFacturables += c.stats.facturables;
    velosFactures += c.stats.factures;
    if (c.devisSignee && c.kbisRecu && c.attestationRecue && c.signatureOk) {
      clientsDocsComplets++;
    }
  }
  const livraisonsParStatut: Record<string, number> = {};
  for (const l of livraisons) {
    livraisonsParStatut[l.statut] = (livraisonsParStatut[l.statut] || 0) + 1;
  }
  const progression =
    totalVelos > 0 ? Math.round((velosLivres / totalVelos) * 100) : 0;
  return {
    totalClients,
    totalVelos,
    velosLivres,
    velosPlanifies,
    certificatsRecus,
    velosFacturables,
    velosFactures,
    clientsDocsComplets,
    progression,
    livraisonsParStatut,
  };
}

// ---------- provider ----------

export function FirebaseDataProvider({ children }: { children: ReactNode }) {
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [carte, setCarte] = useState<ClientPoint[]>([]);
  const [livraisons, setLivraisons] = useState<LivraisonRow[]>([]);
  const [equipe, setEquipe] = useState<EquipeMember[]>([]);
  const [flotte, setFlotte] = useState<Camion[]>([]);
  const [bonsEnlevement, setBonsEnlevement] = useState<BonEnlevement[]>([]);
  const [loadedFlags, setLoadedFlags] = useState({
    clients: false,
    livraisons: false,
    equipe: false,
    flotte: false,
    bonsEnlevement: false,
  });

  // Snapshots temps réel
  useEffect(() => {
    const handleClients = (snap: QuerySnapshot) => {
      const rows: ClientRow[] = [];
      const points: ClientPoint[] = [];
      snap.forEach((doc) => {
        const data = doc.data();
        const row = clientFromDoc(doc.id, data);
        rows.push(row);
        const pt = pointFromClient(row, data);
        if (pt) points.push(pt);
      });
      setClients(rows);
      setCarte(points);
      setLoadedFlags((f) => ({ ...f, clients: true }));
    };

    const unsubClients = onSnapshot(collection(db, "clients"), handleClients);
    const unsubLivraisons = onSnapshot(collection(db, "livraisons"), (snap) => {
      const rows: LivraisonRow[] = [];
      snap.forEach((doc) => rows.push(livraisonFromDoc(doc.id, doc.data())));
      setLivraisons(rows);
      setLoadedFlags((f) => ({ ...f, livraisons: true }));
    });
    const unsubEquipe = onSnapshot(
      query(collection(db, "equipe"), where("actif", "==", true)),
      (snap) => {
        const rows: EquipeMember[] = [];
        snap.forEach((doc) => rows.push(equipeFromDoc(doc.id, doc.data())));
        setEquipe(rows);
        setLoadedFlags((f) => ({ ...f, equipe: true }));
      },
    );
    const unsubCamions = onSnapshot(collection(db, "camions"), (snap) => {
      const rows: Camion[] = [];
      snap.forEach((doc) => rows.push(camionFromDoc(doc.id, doc.data())));
      setFlotte(rows);
      setLoadedFlags((f) => ({ ...f, flotte: true }));
    });
    const unsubBons = onSnapshot(collection(db, "bonsEnlevement"), (snap) => {
      const rows: BonEnlevement[] = [];
      snap.forEach((doc) => rows.push(bonFromDoc(doc.id, doc.data())));
      setBonsEnlevement(rows);
      setLoadedFlags((f) => ({ ...f, bonsEnlevement: true }));
    });

    return () => {
      unsubClients();
      unsubLivraisons();
      unsubEquipe();
      unsubCamions();
      unsubBons();
    };
  }, []);

  // Pas de refresh manuel : Firestore est déjà temps réel.
  // On garde un no-op compatible avec l'API existante.
  const refresh = useCallback(async () => {
    // intentionnellement vide
  }, []);

  const stats = computeStats(clients, livraisons);
  const loading = !Object.values(loadedFlags).every(Boolean);

  if (loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <svg
            viewBox="0 0 64 40"
            fill="none"
            className="w-20 h-20 text-green-600 mx-auto mb-4 animate-pulse"
          >
            <circle cx="12" cy="30" r="9" stroke="currentColor" strokeWidth="2.5" />
            <circle cx="12" cy="30" r="2" fill="currentColor" />
            <circle cx="52" cy="30" r="9" stroke="currentColor" strokeWidth="2.5" />
            <circle cx="52" cy="30" r="2" fill="currentColor" />
            <path
              d="M12 30 L28 14 L42 14 L52 30"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path d="M28 14 L24 30" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
          <p className="text-gray-500 text-sm">Chargement Firestore…</p>
        </div>
      </div>
    );
  }

  return (
    <DataContext.Provider
      value={{
        stats,
        clients,
        carte,
        livraisons,
        equipe,
        flotte,
        bonsEnlevement,
        loading: false,
        refresh,
      }}
    >
      {children}
    </DataContext.Provider>
  );
}
