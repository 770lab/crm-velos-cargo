"use client";

import { useEffect, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  deleteDoc,
  serverTimestamp,
  Timestamp,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/current-user";

// Yoann 2026-05-01 : 4 entrepôts utilisés pour la logistique CEE.
// - AXDIS PRO (Le Blanc-Mesnil) : entrepôt source, cartons reçus de Tiffany
// - Nanterre / Lisses / Chelles : stocks vélos montés (post-pré-assemblage)
//
// Stock géré manuellement pour l'instant (compteur cartons / vélos montés
// avec boutons +/-). Auto-décrément/incrément à venir avec markVeloCharge
// + bons d'enlèvement.

type EntrepotRole = "fournisseur" | "stock" | "ephemere";

type Entrepot = {
  id: string;
  slug: string;
  nom: string;
  adresse: string;
  ville: string;
  codePostal: string;
  lat?: number | null;
  lng?: number | null;
  isPrimary: boolean;
  role: EntrepotRole;
  notes?: string;
  stockCartons: number;
  stockVelosMontes: number;
  capaciteMax?: number | null;
  active: boolean;
  // Champs spécifiques rôle "ephemere" (entrepôt client temporaire) :
  // entrepôt monté chez un client tête de groupe (ex Firat Food Roissy)
  // qui sert de point de départ pour livrer toute la chaîne du groupe.
  // S'archive quand le stock atteint 0 et qu'on a fini les livraisons.
  groupeClient?: string; // ex: "Firat Food", "L'Africa"
  clientPrincipalId?: string; // ID Firestore du client tête de groupe
  dateCreation?: string; // YYYY-MM-DD, posée à la livraison du camion complet
  dateArchivage?: string | null; // YYYY-MM-DD, posée quand stock vidé
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
};

const ROLE_LABELS: Record<EntrepotRole, { label: string; badge: string; color: string }> = {
  fournisseur: { label: "Fournisseur (cartons reçus)", badge: "SOURCE", color: "bg-blue-100 text-blue-800" },
  stock: { label: "Stock vélos montés (atelier permanent)", badge: "STOCK MONTÉ", color: "bg-emerald-100 text-emerald-800" },
  ephemere: { label: "Entrepôt éphémère (chez client tête de groupe)", badge: "ÉPHÉMÈRE", color: "bg-purple-100 text-purple-800" },
};

const fmt = (n: number) => new Intl.NumberFormat("fr-FR").format(n || 0);

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export default function EntrepotsPage() {
  const user = useCurrentUser();
  const [entrepots, setEntrepots] = useState<Entrepot[]>([]);
  const [editing, setEditing] = useState<Entrepot | "new" | null>(null);
  const [showStockCible, setShowStockCible] = useState(false);
  const [showFlotte, setShowFlotte] = useState(false);
  const [showSimulation, setShowSimulation] = useState(false);

  useEffect(() => {
    const q = collection(db, "entrepots");
    const unsub = onSnapshot(q, (snap) => {
      const rows: Entrepot[] = [];
      for (const d of snap.docs) {
        const data = d.data();
        rows.push({
          id: d.id,
          slug: String(data.slug || ""),
          nom: String(data.nom || ""),
          adresse: String(data.adresse || ""),
          ville: String(data.ville || ""),
          codePostal: String(data.codePostal || ""),
          lat: typeof data.lat === "number" ? data.lat : null,
          lng: typeof data.lng === "number" ? data.lng : null,
          isPrimary: !!data.isPrimary,
          role:
            data.role === "fournisseur" || data.role === "ephemere"
              ? data.role
              : "stock",
          notes: typeof data.notes === "string" ? data.notes : undefined,
          stockCartons: Number(data.stockCartons || 0),
          stockVelosMontes: Number(data.stockVelosMontes || 0),
          capaciteMax: typeof data.capaciteMax === "number" ? data.capaciteMax : null,
          active: data.active !== false,
          groupeClient: typeof data.groupeClient === "string" ? data.groupeClient : undefined,
          clientPrincipalId:
            typeof data.clientPrincipalId === "string" ? data.clientPrincipalId : undefined,
          dateCreation: typeof data.dateCreation === "string" ? data.dateCreation : undefined,
          dateArchivage:
            typeof data.dateArchivage === "string" ? data.dateArchivage : null,
        });
      }
      // Tri : archivés tout en bas, puis primary, puis stock permanent,
      // puis éphémères actifs (en cours), enfin alpha.
      const roleWeight: Record<EntrepotRole, number> = { fournisseur: 0, stock: 1, ephemere: 2 };
      rows.sort((a, b) => {
        const aArch = !!a.dateArchivage;
        const bArch = !!b.dateArchivage;
        if (aArch !== bArch) return aArch ? 1 : -1;
        if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
        if (roleWeight[a.role] !== roleWeight[b.role]) return roleWeight[a.role] - roleWeight[b.role];
        return a.nom.localeCompare(b.nom);
      });
      setEntrepots(rows);
    });
    return () => unsub();
  }, []);

  const isAdmin = user?.role === "admin" || user?.role === "superadmin";

  // (boutons +/-/setStock supprimés Yoann 2026-05-01 — remplacés par
  // "Entrée de stock" datée. Le stock affiché est dénormalisé sur le doc
  // parent via addMouvement / removeMouvement.)

  const removeEntrepot = async (e: Entrepot) => {
    if (e.isPrimary) {
      alert("Impossible de supprimer l'entrepôt source AXDIS.");
      return;
    }
    if (!confirm(`Supprimer définitivement l'entrepôt « ${e.nom} » ?`)) return;
    await deleteDoc(doc(db, "entrepots", e.id));
  };

  // Yoann 2026-05-03 : remet stock à 0 pour nettoyer les tests (mouvements
  // traçables conservés pour audit).
  const resetStockEntrepot = async (e: Entrepot) => {
    const total = e.stockCartons + e.stockVelosMontes;
    if (total === 0) {
      alert("Stock déjà à zéro");
      return;
    }
    if (!confirm(`⚠️ Remettre à 0 le stock de ${e.nom} ?\n\nActuel : ${e.stockCartons} cartons + ${e.stockVelosMontes} montés = ${total} vélos\n\nL historique des mouvements est conservé (2 mouvements négatifs ajoutés).`)) return;
    try {
      const { gasPost } = await import("@/lib/gas");
      const r = (await gasPost("resetStockEntrepot", { entrepotId: e.id })) as { ok?: boolean; error?: string };
      if (r.error) alert("Erreur : " + r.error);
    } catch (err) {
      alert("Erreur : " + (err instanceof Error ? err.message : String(err)));
    }
  };

  const archiveEntrepot = async (e: Entrepot) => {
    const today = new Date().toISOString().slice(0, 10);
    if (e.stockCartons + e.stockVelosMontes > 0) {
      if (!confirm(`Stock non vide (${e.stockCartons} cartons + ${e.stockVelosMontes} montés). Archiver quand même ?`)) return;
    }
    await setDoc(
      doc(db, "entrepots", e.id),
      { dateArchivage: today, active: false, updatedAt: serverTimestamp() },
      { merge: true },
    );
  };

  const unarchiveEntrepot = async (e: Entrepot) => {
    await setDoc(
      doc(db, "entrepots", e.id),
      { dateArchivage: null, active: true, updatedAt: serverTimestamp() },
      { merge: true },
    );
  };

  // Exclut les entrepôts "fournisseur" (AXDIS) du total — pas de gestion
  // de stock côté Yoann (Yoann 2026-05-01).
  const stockTrackedEntrepots = entrepots.filter((e) => e.role !== "fournisseur");
  const totalCartons = stockTrackedEntrepots.reduce((s, e) => s + e.stockCartons, 0);
  const totalMontes = stockTrackedEntrepots.reduce((s, e) => s + e.stockVelosMontes, 0);

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Entrepôts</h1>
          <p className="text-sm text-gray-500 mt-1">
            Gestion des stocks par dépôt. AXDIS = entrepôt source (cartons), les
            autres = stocks de vélos montés post-atelier.
          </p>
        </div>
        {isAdmin && (
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => setShowFlotte(true)}
              className="px-3 py-2 bg-slate-700 text-white rounded-lg text-sm font-medium hover:bg-slate-800"
              title="Gère les camions de la flotte (capacités, restrictions Paris)"
            >
              🚛 Flotte
            </button>
            <button
              onClick={() => setShowStockCible(true)}
              className="px-3 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 text-white rounded-lg text-sm font-medium hover:opacity-90"
              title="Calcule pour chaque entrepôt le stock cartons + montés à avoir pour servir les clients dans 100 km autour de Paris"
            >
              🎯 Stock cible Paris
            </button>
            <button
              onClick={() => setShowSimulation(true)}
              className="px-3 py-2 bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white rounded-lg text-sm font-medium hover:opacity-90"
              title="Simulation macro : tous clients dans 130km Paris → stock cible par entrepôt + nb tournées + nb jours nécessaires"
            >
              🚀 Simulation Opération
            </button>
            <RescanBonsButton />
            <button
              onClick={() => setEditing("new")}
              className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
            >
              + Nouvel entrepôt
            </button>
          </div>
        )}
      </div>

      {/* KPIs globaux */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div className="bg-white rounded-xl border p-4">
          <div className="text-xs text-gray-500 uppercase tracking-wide">Entrepôts actifs</div>
          <div className="text-2xl font-bold mt-1">{entrepots.filter((e) => e.active).length}</div>
        </div>
        <div className="bg-white rounded-xl border p-4">
          <div className="text-xs text-gray-500 uppercase tracking-wide">Stock cartons total</div>
          <div className="text-2xl font-bold mt-1 text-orange-700">{fmt(totalCartons)}</div>
        </div>
        <div className="bg-white rounded-xl border p-4">
          <div className="text-xs text-gray-500 uppercase tracking-wide">Vélos montés total</div>
          <div className="text-2xl font-bold mt-1 text-emerald-700">{fmt(totalMontes)}</div>
        </div>
        <div className="bg-white rounded-xl border p-4">
          <div className="text-xs text-gray-500 uppercase tracking-wide">Capacité totale</div>
          <div className="text-2xl font-bold mt-1 text-gray-700">
            {fmt(totalCartons + totalMontes)}
            <span className="text-sm font-normal text-gray-500 ml-1">vélos</span>
          </div>
        </div>
      </div>

      {/* Cartes entrepôts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {entrepots.map((e) => (
          <div key={e.id} className={`bg-white rounded-xl border-2 p-4 ${
            e.dateArchivage ? "border-gray-200 opacity-60"
            : e.isPrimary ? "border-blue-300 bg-blue-50/30"
            : e.role === "ephemere" ? "border-purple-300 bg-purple-50/30"
            : "border-gray-200"
          }`}>
            <div className="flex items-start justify-between gap-2 mb-3">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-lg font-bold">{e.nom}</h2>
                  {e.isPrimary && (
                    <span className="text-[10px] px-1.5 py-0.5 bg-blue-100 text-blue-800 rounded font-semibold">
                      {ROLE_LABELS.fournisseur.badge}
                    </span>
                  )}
                  {!e.isPrimary && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${ROLE_LABELS[e.role].color}`}>
                      {ROLE_LABELS[e.role].badge}
                    </span>
                  )}
                  {!e.active && !e.dateArchivage && (
                    <span className="text-[10px] px-1.5 py-0.5 bg-gray-200 text-gray-600 rounded font-semibold">
                      INACTIF
                    </span>
                  )}
                  {e.dateArchivage && (
                    <span className="text-[10px] px-1.5 py-0.5 bg-gray-300 text-gray-700 rounded font-semibold">
                      ARCHIVÉ {e.dateArchivage}
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-600 mt-1">
                  {e.adresse}, {e.codePostal} {e.ville}
                </div>
                {e.role === "ephemere" && (e.groupeClient || e.dateCreation) && (
                  <div className="text-[11px] text-purple-700 mt-0.5 font-medium">
                    {e.groupeClient && <>👥 Groupe : {e.groupeClient}</>}
                    {e.dateCreation && <> · ouvert le {e.dateCreation}</>}
                  </div>
                )}
                {e.notes && <div className="text-[11px] text-gray-500 mt-1 italic">{e.notes}</div>}
              </div>
              {isAdmin && (
                <div className="flex gap-1 shrink-0">
                  <button
                    onClick={() => setEditing(e)}
                    className="text-xs px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded"
                    title="Modifier"
                  >
                    ✏️
                  </button>
                  {/* Yoann 2026-05-03 : Reset stock à 0 (pour nettoyer les
                      stocks de test sans perdre l historique des mouvements). */}
                  {e.role !== "fournisseur" && (e.stockCartons > 0 || e.stockVelosMontes > 0) && (
                    <button
                      onClick={() => resetStockEntrepot(e)}
                      className="text-xs px-2 py-1 bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 rounded"
                      title={`Remet stockCartons (${e.stockCartons}) et stockVelosMontes (${e.stockVelosMontes}) à 0. Crée 2 mouvements traçables.`}
                    >
                      🔄 Reset
                    </button>
                  )}
                  {/* Archive/réouverture rapide pour les éphémères */}
                  {e.role === "ephemere" && !e.dateArchivage && (
                    <button
                      onClick={() => archiveEntrepot(e)}
                      className="text-xs px-2 py-1 bg-purple-100 hover:bg-purple-200 text-purple-800 rounded"
                      title="Archiver l'entrepôt éphémère (à faire quand stock vidé + livraisons groupe terminées)"
                    >
                      📦 Archiver
                    </button>
                  )}
                  {e.role === "ephemere" && e.dateArchivage && (
                    <button
                      onClick={() => unarchiveEntrepot(e)}
                      className="text-xs px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded"
                      title="Rouvrir l'entrepôt éphémère"
                    >
                      ↺
                    </button>
                  )}
                  {!e.isPrimary && (
                    <button
                      onClick={() => removeEntrepot(e)}
                      className="text-xs px-2 py-1 bg-red-100 hover:bg-red-200 text-red-700 rounded"
                      title="Supprimer définitivement"
                    >
                      🗑
                    </button>
                  )}
                </div>
              )}
            </div>

            {e.role === "fournisseur" ? (
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-[12px] text-gray-600">
                <strong>📋 Pas de gestion de stock</strong> — c&apos;est l&apos;inventaire
                du fournisseur. Yoann prépare les commandes directement depuis
                leur stock, pas besoin de tracker les cartons ici.
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <StockPanel
                    entrepotId={e.id}
                    kind="carton"
                    value={e.stockCartons}
                    editable={isAdmin}
                  />
                  <StockPanel
                    entrepotId={e.id}
                    kind="monte"
                    value={e.stockVelosMontes}
                    editable={isAdmin}
                  />
                </div>
                {isAdmin && (
                  <TransformPanel
                    entrepotId={e.id}
                    stockCartons={e.stockCartons}
                  />
                )}
                <SessionsAtelierPanel
                  entrepotId={e.id}
                  entrepotNom={e.nom}
                  editable={isAdmin}
                />
                {/* Yoann 2026-05-03 : pas de Suggérer/Journée sur les
                    éphémères (livrés directement par le client à ses propres
                    magasins, hors flotte LUZE). */}
                {isAdmin && e.role !== "ephemere" && (
                  <SuggererTourneePanel
                    entrepotId={e.id}
                    entrepotNom={e.nom}
                    stockCartons={e.stockCartons}
                    stockVelosMontes={e.stockVelosMontes}
                  />
                )}
                {isAdmin && (
                  <CommandeCamionPanel
                    entrepotId={e.id}
                    entrepotNom={e.nom}
                    entrepotAdresse={`${e.adresse}, ${e.codePostal} ${e.ville}`}
                  />
                )}
              </>
            )}

            {e.capaciteMax && e.capaciteMax > 0 && (
              <div className="mt-3 text-[11px] text-gray-500">
                Capacité max : {fmt(e.capaciteMax)} vélos · occupé{" "}
                {Math.round(((e.stockCartons + e.stockVelosMontes) / e.capaciteMax) * 100)}%
              </div>
            )}
          </div>
        ))}
        {entrepots.length === 0 && (
          <div className="col-span-2 text-center text-sm text-gray-400 italic py-12">
            Aucun entrepôt. Lance le seed ou ajoute-en un.
          </div>
        )}
      </div>

      {editing && (
        <EntrepotModal
          entrepot={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {showStockCible && <StockCibleModal onClose={() => setShowStockCible(false)} />}
      {showFlotte && <FlotteModal onClose={() => setShowFlotte(false)} />}
      {showSimulation && <SimulationOperationModal onClose={() => setShowSimulation(false)} />}
    </div>
  );
}

// Bouton admin pour rétro-scanner les bons existants et auto-matcher
// avec les commandesCamion (parsing "VELO CARGO - COMMANDE N").
// Yoann 2026-05-01 Phase 3.
function RescanBonsButton() {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (busy) return;
    if (!confirm("Re-scanner tous les bons d'enlèvement existants pour les lier aux commandes camion correspondantes ?\n\nCa relit chaque bon, parse la référence 'VELO CARGO - COMMANDE N' et incrémente le stockCartons sur l'entrepôt destinataire.")) return;
    setBusy(true);
    try {
      const { getFunctions, httpsCallable } = await import("firebase/functions");
      const { firebaseApp } = await import("@/lib/firebase");
      const fn = httpsCallable(getFunctions(firebaseApp, "europe-west1"), "rescanBonsForCommandes");
      const r = (await fn({})) as { data?: { ok?: boolean; scanned?: number; matched?: number } };
      const sc = r.data?.scanned ?? 0;
      const ma = r.data?.matched ?? 0;
      alert(`✓ Re-scan terminé\n${sc} bons scannés · ${ma} matches déclenchés\n\nLes stocks vont s'incrémenter dans les secondes qui suivent (trigger Cloud Function).`);
    } catch (e) {
      alert("Erreur : " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      onClick={run}
      disabled={busy}
      className="px-3 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
      title="Rétro-matcher les bons d'enlèvement aux commandes camion (à lancer une seule fois après déploiement Phase 3)"
    >
      {busy ? "Scan…" : "🔄 Re-scan bons"}
    </button>
  );
}

// Mouvement de stock : entrée (positive) ou sortie/correction (négative).
// Source manuelle ou auto (futur : auto-detect montage / tournée / bon Axdis).
type Mouvement = {
  id: string;
  type: "carton" | "monte";
  quantite: number; // signé : +N entrée, -N sortie
  date: string; // YYYY-MM-DD
  source: string; // "manuelle" | "bon-axdis-XXX" | "tournee-XXX" | "montage-XXX"
  notes?: string;
  createdAt?: Timestamp;
  createdByNom?: string;
};

// Bouton de transformation cartons -> vélos montés (Yoann 2026-05-01).
// Le stock arrive toujours en cartons. Quand l atelier monte N vélos,
// le bouton fait la balance auto : -N cartons + +N montés en une seule
// transaction, avec 2 mouvements traçables (source="transformation-atelier").
function TransformPanel({
  entrepotId,
  stockCartons,
}: {
  entrepotId: string;
  stockCartons: number;
}) {
  const [showModal, setShowModal] = useState(false);
  return (
    <>
      <div className="flex items-center justify-between gap-2 bg-blue-50 border border-blue-200 rounded p-1.5">
        <div className="text-[11px] text-blue-900 truncate">
          🔧 <strong>Transformer cartons → montés</strong>
        </div>
        <button
          onClick={() => setShowModal(true)}
          disabled={stockCartons <= 0}
          className="px-2 py-0.5 text-[11px] bg-blue-600 text-white rounded hover:bg-blue-700 font-semibold disabled:opacity-50 shrink-0"
          title={stockCartons <= 0 ? "Aucun carton à transformer" : "Saisir N vélos montés depuis les cartons"}
        >
          → Monter
        </button>
      </div>
      {showModal && (
        <TransformModal
          entrepotId={entrepotId}
          stockCartons={stockCartons}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  );
}

function TransformModal({
  entrepotId,
  stockCartons,
  onClose,
}: {
  entrepotId: string;
  stockCartons: number;
  onClose: () => void;
}) {
  const [quantite, setQuantite] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const n = parseInt(quantite.replace(",", "."), 10);
    if (!Number.isFinite(n) || n <= 0) {
      alert("Quantité invalide");
      return;
    }
    if (n > stockCartons) {
      alert(`Tu n'as que ${stockCartons} cartons en stock.`);
      return;
    }
    setBusy(true);
    try {
      // Yoann 2026-05-03 : passé en increment atomique côté serveur
      // (avant : getDoc + setDoc avec calcul côté client → race condition
      // si 2 transformations rapides ou snapshot stale → cartons pas
      // décrémentés). FieldValue.increment garantit l atomicité.
      const { collection, addDoc, doc, updateDoc, increment, serverTimestamp } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      const sharedSource = `transformation-atelier-${Date.now()}`;
      const baseNotes = notes.trim() || `Atelier monte ${n} vélos`;
      // 1. Mouvement -N cartons (traçabilité)
      await addDoc(collection(db, "entrepots", entrepotId, "mouvements"), {
        type: "carton",
        quantite: -n,
        date,
        source: sharedSource,
        notes: `${baseNotes} (cartons -> montés)`,
        createdAt: serverTimestamp(),
        autoCreated: false,
      });
      // 2. Mouvement +N montés (traçabilité)
      await addDoc(collection(db, "entrepots", entrepotId, "mouvements"), {
        type: "monte",
        quantite: n,
        date,
        source: sharedSource,
        notes: `${baseNotes} (cartons -> montés)`,
        createdAt: serverTimestamp(),
        autoCreated: false,
      });
      // 3. Update atomique des 2 stocks (increment serveur)
      await updateDoc(doc(db, "entrepots", entrepotId), {
        stockCartons: increment(-n),
        stockVelosMontes: increment(n),
        updatedAt: serverTimestamp(),
      });
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-[2000] p-4"
      onClick={onClose}
    >
      <div className="bg-white rounded-2xl p-5 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-3">
          <h2 className="text-lg font-semibold">🔧 Transformer cartons → montés</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>
        <div className="space-y-3">
          <div className="bg-orange-50 border border-orange-200 rounded p-2 text-[11px]">
            <strong>Stock cartons disponible : {stockCartons}</strong>
            <br />
            <span className="opacity-80">
              Le bouton fera : -N cartons + +N vélos montés (balance automatique).
              2 mouvements seront créés en source &laquo; transformation-atelier &raquo;.
            </span>
          </div>
          <div>
            <label className="text-xs text-gray-600">Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full px-2 py-1.5 border rounded text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">
              Quantité de vélos montés
              <span className="text-gray-400"> (max {stockCartons})</span>
            </label>
            <input
              type="number"
              value={quantite}
              onChange={(e) => setQuantite(e.target.value)}
              max={stockCartons}
              min={1}
              placeholder="Ex: 50"
              className="w-full px-2 py-1.5 border rounded text-sm"
              autoFocus
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Notes (optionnel)</label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder='Ex: "Session matin avec 4 monteurs"'
              className="w-full px-2 py-1.5 border rounded text-sm"
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50">
            Annuler
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 font-semibold"
          >
            {busy ? "..." : `🔧 Monter ${quantite || "N"} vélos`}
          </button>
        </div>
      </div>
    </div>
  );
}

function StockPanel({
  entrepotId,
  kind,
  value,
  editable,
}: {
  entrepotId: string;
  kind: "carton" | "monte";
  value: number;
  editable: boolean;
}) {
  const [mouvements, setMouvements] = useState<Mouvement[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    const q = query(
      collection(db, "entrepots", entrepotId, "mouvements"),
      orderBy("createdAt", "desc"),
    );
    const unsub = onSnapshot(q, (snap) => {
      const rows: Mouvement[] = [];
      for (const d of snap.docs) {
        const data = d.data();
        if (data.type !== kind) continue;
        rows.push({
          id: d.id,
          type: data.type === "monte" ? "monte" : "carton",
          quantite: Number(data.quantite || 0),
          date: String(data.date || ""),
          source: String(data.source || "manuelle"),
          notes: typeof data.notes === "string" ? data.notes : undefined,
          createdAt: data.createdAt instanceof Timestamp ? data.createdAt : undefined,
          createdByNom: typeof data.createdByNom === "string" ? data.createdByNom : undefined,
        });
      }
      setMouvements(rows);
    });
    return () => unsub();
  }, [entrepotId, kind]);

  const colorClasses =
    kind === "carton"
      ? "bg-orange-50 border-orange-200 text-orange-800"
      : "bg-emerald-50 border-emerald-200 text-emerald-800";
  const label = kind === "carton" ? "Cartons" : "Vélos montés";

  return (
    <>
      <div className={`rounded-lg border p-2 ${colorClasses}`}>
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-[10px] uppercase tracking-wide opacity-70 font-semibold">
            {label}
          </div>
          <div className="text-xl font-bold text-gray-900">{fmt(value)}</div>
        </div>
        {editable && (
          <div className="mt-1 flex gap-1">
            <button
              onClick={() => setShowModal(true)}
              className="flex-1 px-1.5 py-0.5 bg-white border rounded text-[10px] hover:bg-gray-50 font-medium"
            >
              + Entrée
            </button>
            <button
              onClick={() => setShowHistory((v) => !v)}
              className="px-1.5 py-0.5 bg-white border rounded text-[10px] hover:bg-gray-50"
              title="Voir l'historique"
            >
              {showHistory ? "▲" : "▼"} {mouvements.length}
            </button>
          </div>
        )}
        {showHistory && mouvements.length > 0 && (
          <div className="mt-2 max-h-48 overflow-y-auto bg-white rounded border border-gray-200 divide-y text-[11px]">
            {mouvements.slice(0, 30).map((m) => (
              <MouvementLine
                key={m.id}
                entrepotId={entrepotId}
                m={m}
                editable={editable}
              />
            ))}
          </div>
        )}
        {showHistory && mouvements.length === 0 && (
          <div className="mt-2 px-2 py-2 text-[11px] text-gray-500 italic text-center bg-white rounded border border-gray-200">
            Aucun mouvement.
          </div>
        )}
      </div>
      {showModal && (
        <MouvementModal
          entrepotId={entrepotId}
          kind={kind}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  );
}

function MouvementLine({
  entrepotId,
  m,
  editable,
}: {
  entrepotId: string;
  m: Mouvement;
  editable: boolean;
}) {
  const isAuto = m.source !== "manuelle";
  const remove = async () => {
    if (!confirm(`Supprimer ce mouvement (${m.quantite > 0 ? "+" : ""}${m.quantite}) ?`)) return;
    await deleteDoc(doc(db, "entrepots", entrepotId, "mouvements", m.id));
    // Décrémente le stock dénormalisé : on retire la quantité du mouvement.
    const field = m.type === "carton" ? "stockCartons" : "stockVelosMontes";
    const { getDoc: getDocFn } = await import("firebase/firestore");
    const eSnap = await getDocFn(doc(db, "entrepots", entrepotId));
    const cur = Number((eSnap.data() as Record<string, unknown>)?.[field] || 0);
    await setDoc(
      doc(db, "entrepots", entrepotId),
      { [field]: Math.max(0, cur - m.quantite), updatedAt: serverTimestamp() },
      { merge: true },
    );
  };
  return (
    <div className="px-2 py-1.5 flex items-center gap-2">
      <div className="text-[10px] text-gray-500 shrink-0 w-20">{m.date}</div>
      <div
        className={`text-xs font-bold shrink-0 w-12 text-right ${
          m.quantite > 0 ? "text-emerald-700" : "text-red-700"
        }`}
      >
        {m.quantite > 0 ? "+" : ""}
        {m.quantite}
      </div>
      <div className="flex-1 min-w-0 truncate">
        {isAuto ? (
          <span className="text-purple-700 font-medium">{m.source}</span>
        ) : (
          <span className="text-gray-700">{m.notes || "—"}</span>
        )}
        {m.createdByNom && (
          <span className="text-gray-400 text-[10px] ml-1">par {m.createdByNom}</span>
        )}
      </div>
      {editable && !isAuto && (
        <button
          onClick={remove}
          className="text-red-400 hover:text-red-700 text-[10px] shrink-0"
          title="Supprimer ce mouvement"
        >
          ×
        </button>
      )}
    </div>
  );
}

// Commande de camion complet à Tiffany (Yoann 2026-05-01). Numéro
// incrémental global "VELO CARGO - COMMANDE N" pour matching avec les
// bons de retour AXDIS. Pas d'envoi mail auto (Cloud Function à coder
// plus tard) — pour l'instant on ouvre un mailto: pré-rempli.
type CommandeCamion = {
  id: string;
  numero: number;
  entrepotDestinataireId: string;
  entrepotDestinataireNom: string;
  quantite: number;
  reference: string;
  dateCommande: string;
  dateLivraisonSouhaitee?: string | null;
  statut: "envoyee" | "recue" | "annulee";
  notes?: string;
  bonRetourNumero?: string | null;
  createdAt?: Timestamp;
};

const TIFFANY_EMAIL = "Tiffany@axdis.fr";

function CommandeCamionPanel({
  entrepotId,
  entrepotNom,
  entrepotAdresse,
}: {
  entrepotId: string;
  entrepotNom: string;
  entrepotAdresse: string;
}) {
  const [commandes, setCommandes] = useState<CommandeCamion[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    const q = query(
      collection(db, "commandesCamion"),
      orderBy("createdAt", "desc"),
    );
    const unsub = onSnapshot(q, (snap) => {
      const rows: CommandeCamion[] = [];
      for (const d of snap.docs) {
        const data = d.data();
        if (data.entrepotDestinataireId !== entrepotId) continue;
        rows.push({
          id: d.id,
          numero: Number(data.numero || 0),
          entrepotDestinataireId: String(data.entrepotDestinataireId || ""),
          entrepotDestinataireNom: String(data.entrepotDestinataireNom || ""),
          quantite: Number(data.quantite || 0),
          reference: String(data.reference || ""),
          dateCommande: String(data.dateCommande || ""),
          dateLivraisonSouhaitee:
            typeof data.dateLivraisonSouhaitee === "string" ? data.dateLivraisonSouhaitee : null,
          statut: data.statut === "recue" || data.statut === "annulee" ? data.statut : "envoyee",
          notes: typeof data.notes === "string" ? data.notes : undefined,
          bonRetourNumero:
            typeof data.bonRetourNumero === "string" ? data.bonRetourNumero : null,
          createdAt: data.createdAt instanceof Timestamp ? data.createdAt : undefined,
        });
      }
      setCommandes(rows);
    });
    return () => unsub();
  }, [entrepotId]);

  const enCours = commandes.filter((c) => c.statut === "envoyee").length;
  const recues = commandes.filter((c) => c.statut === "recue").length;

  return (
    <>
      <div className="bg-blue-50 border border-blue-200 rounded p-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] text-blue-900 font-medium truncate">
            🚚 <strong>Camion Tiffany</strong>
            <span className="ml-1 text-blue-700">
              {enCours > 0 && `${enCours} en cours · `}
              {recues > 0 && `${recues} reçue${recues > 1 ? "s" : ""}`}
              {enCours === 0 && recues === 0 && "aucune"}
            </span>
          </div>
          <div className="flex gap-1 shrink-0">
            {commandes.length > 0 && (
              <button
                onClick={() => setShowHistory((v) => !v)}
                className="text-[10px] px-1.5 py-0.5 bg-white border border-blue-300 rounded hover:bg-blue-50"
              >
                {showHistory ? "▲" : "▼"} {commandes.length}
              </button>
            )}
            <button
              onClick={() => setShowModal(true)}
              className="text-[10px] px-2 py-0.5 bg-blue-600 text-white rounded hover:bg-blue-700 font-semibold"
            >
              + Commander
            </button>
          </div>
        </div>
        {showHistory && commandes.length > 0 && (
          <div className="mt-2 max-h-48 overflow-y-auto bg-white rounded border border-blue-200 divide-y text-[11px]">
            {commandes.map((c) => (
              <CommandeLine key={c.id} c={c} />
            ))}
          </div>
        )}
      </div>
      {showModal && (
        <CommandeCamionModal
          entrepotId={entrepotId}
          entrepotNom={entrepotNom}
          entrepotAdresse={entrepotAdresse}
          existingCommandes={commandes}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  );
}

function CommandeLine({ c }: { c: CommandeCamion }) {
  const markRecue = async () => {
    const numBon = prompt(
      `N° du bon de retour AXDIS (référence ${c.reference}) :`,
      c.bonRetourNumero || "",
    );
    if (numBon === null) return;
    await setDoc(
      doc(db, "commandesCamion", c.id),
      {
        statut: "recue",
        bonRetourNumero: numBon.trim() || null,
        dateRecue: new Date().toISOString(),
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
  };
  const cancel = async () => {
    if (!confirm(`Annuler la ${c.reference} ?`)) return;
    await setDoc(
      doc(db, "commandesCamion", c.id),
      { statut: "annulee", updatedAt: serverTimestamp() },
      { merge: true },
    );
  };
  const remove = async () => {
    if (!confirm(`Supprimer définitivement la ${c.reference} ?`)) return;
    await deleteDoc(doc(db, "commandesCamion", c.id));
  };
  const statutColor =
    c.statut === "recue"
      ? "bg-emerald-100 text-emerald-800"
      : c.statut === "annulee"
        ? "bg-gray-100 text-gray-500"
        : "bg-amber-100 text-amber-800";
  const statutLabel =
    c.statut === "recue" ? "✓ reçue" : c.statut === "annulee" ? "✕ annulée" : "⏳ envoyée";
  return (
    <div className="px-2 py-1.5 flex items-center gap-2">
      <div className="font-mono font-bold text-blue-900 shrink-0 w-20">{c.reference}</div>
      <div className="text-[11px] text-gray-600 shrink-0 w-12 text-right">{c.quantite}v</div>
      <div className="text-[10px] text-gray-500 shrink-0 w-20">{c.dateCommande}</div>
      <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${statutColor}`}>
        {statutLabel}
      </span>
      <div className="flex-1 min-w-0 truncate text-[10px] text-gray-500">
        {c.bonRetourNumero ? `Bon ${c.bonRetourNumero}` : c.notes || ""}
      </div>
      <div className="flex gap-1 shrink-0">
        {c.statut === "envoyee" && (
          <>
            <button
              onClick={markRecue}
              className="text-[10px] px-1.5 py-0.5 bg-emerald-100 hover:bg-emerald-200 text-emerald-700 rounded"
              title="Marquer comme reçue (bon AXDIS arrivé)"
            >
              ✓
            </button>
            <button
              onClick={cancel}
              className="text-[10px] px-1.5 py-0.5 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded"
              title="Annuler la commande"
            >
              ✕
            </button>
          </>
        )}
        {c.statut !== "envoyee" && (
          <button
            onClick={remove}
            className="text-[10px] px-1.5 py-0.5 text-red-400 hover:text-red-700 rounded"
            title="Supprimer"
          >
            🗑
          </button>
        )}
      </div>
    </div>
  );
}

function CommandeCamionModal({
  entrepotId,
  entrepotNom,
  entrepotAdresse,
  existingCommandes,
  onClose,
}: {
  entrepotId: string;
  entrepotNom: string;
  entrepotAdresse: string;
  existingCommandes: CommandeCamion[];
  onClose: () => void;
}) {
  const user = useCurrentUser();
  const [quantite, setQuantite] = useState("132");
  const [dateLivraisonSouhaitee, setDateLivraisonSouhaitee] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const q = parseInt(quantite.replace(",", "."), 10);
    if (!Number.isFinite(q) || q <= 0) {
      alert("Quantité invalide");
      return;
    }
    if (q < 50) {
      alert(
        "Minimum AXDIS = 5 palettes = 50 vélos.\n\n" +
          "En dessous Tiffany ne peut pas affréter un camion dédié.",
      );
      return;
    }
    setBusy(true);
    try {
      // 1. Compteur global incrémental.
      const allSnap = await import("firebase/firestore").then((m) =>
        m.getDocs(collection(db, "commandesCamion")),
      );
      let maxNum = 0;
      for (const d of allSnap.docs) {
        const n = Number(d.data().numero || 0);
        if (n > maxNum) maxNum = n;
      }
      const numero = maxNum + 1;
      const reference = `VELO CARGO - COMMANDE ${numero}`;
      const today = new Date().toISOString().slice(0, 10);
      // 2. Crée le doc
      const docRef = await addDoc(collection(db, "commandesCamion"), {
        numero,
        reference,
        entrepotDestinataireId: entrepotId,
        entrepotDestinataireNom: entrepotNom,
        entrepotDestinataireAdresse: entrepotAdresse,
        quantite: q,
        dateCommande: today,
        dateLivraisonSouhaitee: dateLivraisonSouhaitee || null,
        statut: "envoyee",
        notes: notes.trim() || null,
        commandePar: user?.nom || null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      // 3. Envoi SMTP via Cloud Function (depuis velos-cargo@artisansverts.energy,
      // pas le mail perso de l'utilisateur). Yoann 2026-05-01.
      const { getFunctions, httpsCallable } = await import("firebase/functions");
      const { firebaseApp } = await import("@/lib/firebase");
      const fn = httpsCallable(getFunctions(firebaseApp, "europe-west1"), "sendCommandeCamion");
      try {
        const r = (await fn({ commandeId: docRef.id })) as {
          data?: { ok?: boolean; sentTo?: string; messageId?: string };
        };
        const sentTo = r.data?.sentTo || TIFFANY_EMAIL;
        alert(`✓ Commande ${reference} envoyée à ${sentTo}`);
      } catch (e) {
        // Fallback : mailto si la Cloud Function plante (réseau, secret, etc.)
        const errMsg = e instanceof Error ? e.message : String(e);
        const useMailto = confirm(
          `Échec envoi SMTP : ${errMsg}\n\nLa commande ${reference} a été enregistrée en base.\n\nOuvrir un mailto: pour envoyer manuellement depuis ton client mail ?`,
        );
        if (useMailto) {
          const subject = encodeURIComponent(reference);
          const livraisonLine = dateLivraisonSouhaitee
            ? `Livraison souhaitée : ${dateLivraisonSouhaitee}\n`
            : "";
          const notesLine = notes.trim() ? `\nNotes : ${notes.trim()}\n` : "";
          const palettes = Math.ceil(q / 10);
          const body = encodeURIComponent(
            `Bonjour Tiffany,\n\n` +
              `Merci de préparer ${q} vélos cargo (${palettes} palette${palettes > 1 ? "s" : ""}) pour livraison à :\n\n` +
              `${entrepotNom}\n${entrepotAdresse}\n\n` +
              livraisonLine +
              `Référence à reporter sur le bon de commande : ${reference}\n` +
              notesLine +
              `\nSi pas de place, merci de me dire combien tu peux mettre (min 5 palettes = 50 vélos).\n\n` +
              `Cordialement,\n${user?.nom || "Yoann"}`,
          );
          window.open(`mailto:${TIFFANY_EMAIL}?subject=${subject}&body=${body}`, "_blank");
        }
      }
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const lastNum = existingCommandes.reduce((max, c) => (c.numero > max ? c.numero : max), 0);
  const nextNum = lastNum + 1;

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-[2000] p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl p-5 w-full max-w-md max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-start mb-3">
          <h2 className="text-lg font-semibold">🚚 Commander un camion complet</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">
            ×
          </button>
        </div>
        <div className="space-y-3">
          <div className="bg-blue-50 border border-blue-200 rounded p-2 text-[11px] text-blue-900">
            Référence générée : <strong>VELO CARGO - COMMANDE {nextNum}</strong>
            <br />
            Destination : <strong>{entrepotNom}</strong>
            <br />
            <span className="opacity-80">{entrepotAdresse}</span>
          </div>
          <div>
            <label className="text-xs text-gray-600">Quantité (vélos)</label>
            <input
              type="number"
              value={quantite}
              onChange={(e) => setQuantite(e.target.value)}
              min={50}
              step={10}
              className="w-full px-2 py-1.5 border rounded text-sm"
              placeholder="132 (camion PL standard)"
            />
            <div className="text-[10px] text-gray-500 mt-0.5 leading-tight">
              <strong>Minimum 5 palettes = 50 vélos</strong> · 132 = 1 PL standard
              · 528 = 4 PL livraison directe usine.
              <br />
              1 palette ≈ 10 vélos. Tiffany peut renvoyer une quantité réduite si
              pas de place — l&apos;email l&apos;invite à proposer un ajustement.
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-600">Date livraison souhaitée (optionnel)</label>
            <input
              type="date"
              value={dateLivraisonSouhaitee}
              onChange={(e) => setDateLivraisonSouhaitee(e.target.value)}
              className="w-full px-2 py-1.5 border rounded text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Notes (optionnel)</label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder='Ex: "ASAP - prévu pour gros déploiement"'
              className="w-full px-2 py-1.5 border rounded text-sm"
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50">
            Annuler
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 font-semibold"
          >
            {busy ? "Envoi…" : "📧 Envoyer à Tiffany"}
          </button>
        </div>
      </div>
    </div>
  );
}

function MouvementModal({
  entrepotId,
  kind,
  onClose,
}: {
  entrepotId: string;
  kind: "carton" | "monte";
  onClose: () => void;
}) {
  const user = useCurrentUser();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [quantite, setQuantite] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const q = parseInt(quantite.replace(",", "."), 10);
    if (!Number.isFinite(q) || q === 0) {
      alert("Quantité invalide (positive pour entrée, négative pour correction)");
      return;
    }
    if (!date) {
      alert("Date obligatoire");
      return;
    }
    setBusy(true);
    try {
      // 1. Crée le mouvement en sous-collection
      await addDoc(collection(db, "entrepots", entrepotId, "mouvements"), {
        type: kind,
        quantite: q,
        date,
        source: "manuelle",
        notes: notes.trim() || null,
        createdAt: serverTimestamp(),
        createdByNom: user?.nom || null,
      });
      // 2. Update atomique du stock dénormalisé via FieldValue.increment
      // (Yoann 2026-05-03 : remplace le getDoc + setDoc qui était sujet à
      // race condition, observée le 2026-05-03 sur transformation cartons→
      // montés). Si q est négatif (correction), increment l'applique tel quel.
      const field = kind === "carton" ? "stockCartons" : "stockVelosMontes";
      const { updateDoc, increment } = await import("firebase/firestore");
      await updateDoc(doc(db, "entrepots", entrepotId), {
        [field]: increment(q),
        updatedAt: serverTimestamp(),
      });
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const labelKind = kind === "carton" ? "cartons" : "vélos montés";

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-[2000] p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl p-5 w-full max-w-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-start mb-3">
          <h2 className="text-lg font-semibold">+ Entrée de stock {labelKind}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">
            ×
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-600">Date d&apos;entrée</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full px-2 py-1.5 border rounded text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">
              Quantité <span className="text-gray-400">(positive = entrée, négative = correction)</span>
            </label>
            <input
              type="number"
              value={quantite}
              onChange={(e) => setQuantite(e.target.value)}
              placeholder="Ex: 132"
              className="w-full px-2 py-1.5 border rounded text-sm"
              autoFocus
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Notes (optionnel)</label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder='Ex: "Camion PL #354510 reçu"'
              className="w-full px-2 py-1.5 border rounded text-sm"
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50"
          >
            Annuler
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? "Enregistrement…" : "Enregistrer"}
          </button>
        </div>
      </div>
    </div>
  );
}

function EntrepotModal({
  entrepot,
  onClose,
}: {
  entrepot: Entrepot | null;
  onClose: () => void;
}) {
  const isNew = entrepot === null;
  const [nom, setNom] = useState(entrepot?.nom || "");
  const [adresse, setAdresse] = useState(entrepot?.adresse || "");
  const [codePostal, setCodePostal] = useState(entrepot?.codePostal || "");
  const [ville, setVille] = useState(entrepot?.ville || "");
  const [role, setRole] = useState<EntrepotRole>(entrepot?.role || "stock");
  const [notes, setNotes] = useState(entrepot?.notes || "");
  const [capaciteMax, setCapaciteMax] = useState<string>(
    entrepot?.capaciteMax ? String(entrepot.capaciteMax) : "",
  );
  const [active, setActive] = useState(entrepot?.active !== false);
  const [groupeClient, setGroupeClient] = useState(entrepot?.groupeClient || "");
  const [dateCreation, setDateCreation] = useState(
    entrepot?.dateCreation || new Date().toISOString().slice(0, 10),
  );
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!nom.trim() || !ville.trim()) {
      alert("Nom et ville obligatoires");
      return;
    }
    setBusy(true);
    try {
      const data: Record<string, unknown> = {
        slug: entrepot?.slug || slugify(nom),
        nom: nom.trim(),
        adresse: adresse.trim(),
        codePostal: codePostal.trim(),
        ville: ville.trim(),
        role,
        notes: notes.trim() || null,
        capaciteMax: capaciteMax ? parseInt(capaciteMax, 10) : null,
        active,
        updatedAt: serverTimestamp(),
      };
      if (role === "ephemere") {
        data.groupeClient = groupeClient.trim() || null;
        data.dateCreation = dateCreation || null;
      } else {
        data.groupeClient = null;
        data.dateCreation = null;
      }
      if (isNew) {
        data.isPrimary = false;
        data.stockCartons = 0;
        data.stockVelosMontes = 0;
        data.dateArchivage = null;
        data.createdAt = serverTimestamp();
      }
      if (isNew) {
        const ref = doc(collection(db, "entrepots"));
        await setDoc(ref, data);
      } else {
        await setDoc(doc(db, "entrepots", entrepot!.id), data, { merge: true });
      }
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-[70] p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl p-5 w-full max-w-md max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-start mb-3">
          <h2 className="text-lg font-semibold">
            {isNew ? "+ Nouvel entrepôt" : `Modifier ${entrepot?.nom}`}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">
            ×
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-600">Nom *</label>
            <input
              type="text"
              value={nom}
              onChange={(e) => setNom(e.target.value)}
              className="w-full px-2 py-1.5 border rounded text-sm"
              placeholder="Ex: Nanterre"
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Adresse</label>
            <input
              type="text"
              value={adresse}
              onChange={(e) => setAdresse(e.target.value)}
              className="w-full px-2 py-1.5 border rounded text-sm"
              placeholder="N° + rue"
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-xs text-gray-600">CP</label>
              <input
                type="text"
                value={codePostal}
                onChange={(e) => setCodePostal(e.target.value)}
                className="w-full px-2 py-1.5 border rounded text-sm"
              />
            </div>
            <div className="col-span-2">
              <label className="text-xs text-gray-600">Ville *</label>
              <input
                type="text"
                value={ville}
                onChange={(e) => setVille(e.target.value)}
                className="w-full px-2 py-1.5 border rounded text-sm"
              />
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-600">Rôle</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as EntrepotRole)}
              className="w-full px-2 py-1.5 border rounded text-sm"
            >
              <option value="stock">Stock vélos montés (atelier permanent)</option>
              <option value="fournisseur">Fournisseur (cartons reçus)</option>
              <option value="ephemere">Éphémère (chez client tête de groupe)</option>
            </select>
          </div>
          {role === "ephemere" && (
            <div className="bg-purple-50 border border-purple-200 rounded p-2 space-y-2">
              <div className="text-[11px] text-purple-800 leading-relaxed">
                💡 <strong>Mini-AXDIS chez le client tête de groupe</strong>
                (ex : Firat Food Roissy → tous les magasins du groupe).
                Workflow identique à AXDIS :
                <ol className="list-decimal pl-4 mt-1 space-y-0.5">
                  <li>Camion complet livré ici (cartons)</li>
                  <li>Préparateur Yoann sur place → assignation FNUCI</li>
                  <li>Monteurs Yoann sur place <strong>une seule fois</strong> pour tous les montages</li>
                  <li>Le client redistribue lui-même avec son camion vers ses magasins</li>
                  <li>Chef d&apos;équipe Yoann suit pour BL signature + traçabilité COFRAC</li>
                </ol>
                <div className="mt-1">
                  Avantage : monteurs ne se déplacent qu&apos;une fois, chauffeur Yoann pas mobilisé sur la distribution.
                </div>
                <div className="mt-1">À archiver une fois la chaîne entièrement livrée.</div>
              </div>
              <div>
                <label className="text-xs text-gray-600">Nom du groupe / chaîne</label>
                <input
                  type="text"
                  value={groupeClient}
                  onChange={(e) => setGroupeClient(e.target.value)}
                  placeholder="Ex: Firat Food, L'Africa, …"
                  className="w-full px-2 py-1.5 border rounded text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-gray-600">Date d&apos;ouverture (livraison du camion complet)</label>
                <input
                  type="date"
                  value={dateCreation}
                  onChange={(e) => setDateCreation(e.target.value)}
                  className="w-full px-2 py-1.5 border rounded text-sm"
                />
              </div>
            </div>
          )}
          <div>
            <label className="text-xs text-gray-600">Capacité max (vélos, optionnel)</label>
            <input
              type="number"
              value={capaciteMax}
              onChange={(e) => setCapaciteMax(e.target.value)}
              className="w-full px-2 py-1.5 border rounded text-sm"
              placeholder="500"
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full px-2 py-1.5 border rounded text-sm"
              rows={2}
            />
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            Actif (utilisable pour les tournées)
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50">
            Annuler
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? "Enregistrement…" : "Enregistrer"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Sessions montage atelier (Yoann 2026-05-01) : journées planifiées où
// des monteurs viennent monter en masse à un entrepôt. Affiche les
// sessions à venir + permet d en planifier de nouvelles.
type SessionAtelier = {
  id: string;
  date: string;
  monteurIds: string[];
  monteurNoms: string[];
  chefId?: string | null;
  chefNom?: string;
  quantitePrevue?: number | null;
  quantiteReelle?: number | null;
  statut: "planifiee" | "en_cours" | "terminee" | "annulee";
  notes?: string;
};

function SessionsAtelierPanel({
  entrepotId,
  entrepotNom,
  editable,
}: {
  entrepotId: string;
  entrepotNom: string;
  editable: boolean;
}) {
  const [sessions, setSessions] = useState<SessionAtelier[]>([]);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { collection, query, where, onSnapshot, orderBy } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      const q = query(
        collection(db, "sessionsMontageAtelier"),
        where("entrepotId", "==", entrepotId),
        orderBy("date", "desc"),
      );
      const unsub = onSnapshot(q, (snap) => {
        if (!alive) return;
        const rows: SessionAtelier[] = [];
        for (const d of snap.docs) {
          const data = d.data();
          rows.push({
            id: d.id,
            date: String(data.date || ""),
            monteurIds: Array.isArray(data.monteurIds) ? data.monteurIds : [],
            monteurNoms: Array.isArray(data.monteurNoms) ? data.monteurNoms : [],
            chefId: typeof data.chefId === "string" ? data.chefId : null,
            chefNom: typeof data.chefNom === "string" ? data.chefNom : undefined,
            quantitePrevue: typeof data.quantitePrevue === "number" ? data.quantitePrevue : null,
            quantiteReelle: typeof data.quantiteReelle === "number" ? data.quantiteReelle : null,
            statut: ["en_cours", "terminee", "annulee"].includes(data.statut) ? data.statut : "planifiee",
            notes: typeof data.notes === "string" ? data.notes : undefined,
          });
        }
        setSessions(rows);
      });
      return () => unsub();
    })();
    return () => { alive = false; };
  }, [entrepotId]);

  const aVenir = sessions.filter((s) => s.statut === "planifiee" || s.statut === "en_cours");
  const passees = sessions.filter((s) => s.statut === "terminee" || s.statut === "annulee");

  const removeSession = async (id: string) => {
    if (!confirm("Supprimer cette session de montage atelier ?")) return;
    const { doc, deleteDoc } = await import("firebase/firestore");
    const { db } = await import("@/lib/firebase");
    await deleteDoc(doc(db, "sessionsMontageAtelier", id));
  };
  const updateStatut = async (id: string, statut: SessionAtelier["statut"]) => {
    const { doc, setDoc, serverTimestamp } = await import("firebase/firestore");
    const { db } = await import("@/lib/firebase");
    await setDoc(doc(db, "sessionsMontageAtelier", id), { statut, updatedAt: serverTimestamp() }, { merge: true });
  };

  // Yoann 2026-05-01 : compact, "à venir" derrière toggle (cohérent avec
  // CommandeCamionPanel) — header 1 ligne quand vide ou collapsed.
  const [showOpen, setShowOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  return (
    <>
      <div className="bg-amber-50 border border-amber-200 rounded p-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] text-amber-900 font-medium truncate">
            🔧 <strong>Sessions atelier</strong>
            <span className="ml-1 text-amber-700">
              {aVenir.length > 0 && `${aVenir.length} à venir · `}
              {passees.length > 0 && `${passees.length} passée${passees.length > 1 ? "s" : ""}`}
              {sessions.length === 0 && "aucune"}
            </span>
          </div>
          <div className="flex gap-1 shrink-0">
            {aVenir.length > 0 && (
              <button
                onClick={() => setShowOpen((v) => !v)}
                className="text-[10px] px-1.5 py-0.5 bg-white border border-amber-300 rounded hover:bg-amber-50"
                title="Voir/masquer les sessions à venir"
              >
                {showOpen ? "▲" : "▼"} {aVenir.length}
              </button>
            )}
            {passees.length > 0 && (
              <button
                onClick={() => setShowHistory((v) => !v)}
                className="text-[10px] px-1.5 py-0.5 bg-white border border-amber-300 rounded hover:bg-amber-50 opacity-70"
                title="Historique"
              >
                {showHistory ? "▲" : "▼"} {passees.length}
              </button>
            )}
            {editable && (
              <button
                onClick={() => setShowModal(true)}
                className="text-[10px] px-2 py-0.5 bg-amber-600 text-white rounded hover:bg-amber-700 font-semibold"
              >
                + Planifier
              </button>
            )}
          </div>
        </div>
        {showOpen && aVenir.length > 0 && (
          <div className="space-y-1 mt-1.5">
            {aVenir.map((s) => (
              <SessionLine
                key={s.id}
                s={s}
                editable={editable}
                onRemove={removeSession}
                onUpdateStatut={updateStatut}
              />
            ))}
          </div>
        )}
        {showHistory && passees.length > 0 && (
          <div className="space-y-1 mt-1.5 opacity-70">
            {passees.map((s) => (
              <SessionLine
                key={s.id}
                s={s}
                editable={editable}
                onRemove={removeSession}
                onUpdateStatut={updateStatut}
              />
            ))}
          </div>
        )}
      </div>
      {showModal && (
        <SessionAtelierModal
          entrepotId={entrepotId}
          entrepotNom={entrepotNom}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  );
}

function SessionLine({
  s,
  editable,
  onRemove,
  onUpdateStatut,
}: {
  s: SessionAtelier;
  editable: boolean;
  onRemove: (id: string) => void;
  onUpdateStatut: (id: string, statut: SessionAtelier["statut"]) => void;
}) {
  const statutClasses: Record<SessionAtelier["statut"], string> = {
    planifiee: "bg-blue-100 text-blue-800",
    en_cours: "bg-emerald-100 text-emerald-800",
    terminee: "bg-gray-200 text-gray-700",
    annulee: "bg-red-100 text-red-700 line-through",
  };
  return (
    <div className="bg-white border border-amber-200 rounded px-2 py-1 text-[11px] flex items-center gap-2">
      <span className="font-mono font-bold shrink-0">{s.date}</span>
      <span className={`px-1 py-0.5 rounded text-[10px] font-semibold shrink-0 ${statutClasses[s.statut]}`}>
        {s.statut === "planifiee" ? "📅" : s.statut === "en_cours" ? "🔧" : s.statut === "terminee" ? "✓" : "✕"}
      </span>
      {s.quantitePrevue && (
        <span className="text-gray-600 shrink-0">
          {s.quantiteReelle != null ? `${s.quantiteReelle}/${s.quantitePrevue}` : `${s.quantitePrevue}`}v
        </span>
      )}
      <span className="flex-1 min-w-0 truncate text-gray-700">
        {s.chefNom && <span className="font-semibold">{s.chefNom}</span>}
        {s.chefNom && s.monteurNoms.length > 0 && " · "}
        {s.monteurNoms.length > 0
          ? <span>{s.monteurNoms.length}m: {s.monteurNoms.join(", ")}</span>
          : <span className="italic text-gray-400">aucun monteur</span>}
        {s.notes ? ` — ${s.notes}` : ""}
      </span>
      {editable && (
        <div className="flex gap-1 shrink-0">
          {s.statut === "planifiee" && (
            <button
              onClick={() => onUpdateStatut(s.id, "en_cours")}
              className="text-[10px] px-1 py-0.5 bg-emerald-100 text-emerald-700 rounded hover:bg-emerald-200"
              title="Démarrer la session"
            >
              ▶
            </button>
          )}
          {s.statut === "en_cours" && (
            <button
              onClick={() => onUpdateStatut(s.id, "terminee")}
              className="text-[10px] px-1 py-0.5 bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
              title="Terminer"
            >
              ✓
            </button>
          )}
          <button
            onClick={() => onRemove(s.id)}
            className="text-[10px] px-1 text-red-400 hover:text-red-700"
            title="Supprimer"
          >
            🗑
          </button>
        </div>
      )}
    </div>
  );
}

// Yoann 2026-05-03 : exporté + mode édition (si existingSessionId fourni,
// charge le doc et update au lieu de create).
export function SessionAtelierModal({
  entrepotId,
  entrepotNom,
  existingSessionId,
  onClose,
}: {
  entrepotId: string;
  entrepotNom: string;
  existingSessionId?: string;
  onClose: () => void;
}) {
  type Member = { id: string; nom: string; role: string; chefId?: string | null; aussiMonteur?: boolean };
  const [equipe, setEquipe] = useState<Member[]>([]);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [chefId, setChefId] = useState("");
  const [monteurIds, setMonteurIds] = useState<string[]>([]);
  const [quantitePrevue, setQuantitePrevue] = useState("");
  const [quantiteReelle, setQuantiteReelle] = useState("");
  const [statut, setStatut] = useState<"planifiee" | "en_cours" | "terminee" | "annulee">("planifiee");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingExisting, setLoadingExisting] = useState(!!existingSessionId);

  // Charge la session existante si on est en mode édition
  useEffect(() => {
    if (!existingSessionId) return;
    let alive = true;
    (async () => {
      const { doc, getDoc } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      const snap = await getDoc(doc(db, "sessionsMontageAtelier", existingSessionId));
      if (!alive || !snap.exists()) {
        if (alive) setLoadingExisting(false);
        return;
      }
      const d = snap.data() as Record<string, unknown>;
      setDate(String(d.date || ""));
      setChefId(typeof d.chefId === "string" ? d.chefId : "");
      setMonteurIds(Array.isArray(d.monteurIds) ? d.monteurIds : []);
      setQuantitePrevue(d.quantitePrevue != null ? String(d.quantitePrevue) : "");
      setQuantiteReelle(d.quantiteReelle != null ? String(d.quantiteReelle) : "");
      const st = String(d.statut || "planifiee");
      setStatut(["en_cours", "terminee", "annulee"].includes(st) ? (st as "en_cours" | "terminee" | "annulee") : "planifiee");
      setNotes(typeof d.notes === "string" ? d.notes : "");
      setLoadingExisting(false);
    })();
    return () => { alive = false; };
  }, [existingSessionId]);
  // Détection conflit (Yoann 2026-05-01) : monteurId -> "tournée X (Client)" ou
  // "atelier Y" pour ce jour. Affiché en warning sur les boutons + bandeau.
  const [conflits, setConflits] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let alive = true;
    (async () => {
      const { collection, getDocs } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      const snap = await getDocs(collection(db, "equipe"));
      if (!alive) return;
      const rows: Member[] = snap.docs
        .map((d) => {
          const data = d.data() as Record<string, unknown>;
          return {
            id: d.id,
            nom: String(data.nom || ""),
            role: String(data.role || ""),
            chefId: typeof data.chefId === "string" ? data.chefId : null,
            aussiMonteur: data.aussiMonteur === true,
            actif: data.actif !== false,
          };
        })
        .filter((m) => (m as { actif: boolean }).actif);
      setEquipe(rows);
    })();
    return () => { alive = false; };
  }, []);

  // Charge les conflits monteur pour la date sélectionnée :
  //  - livraisons.monteurIds dont datePrevue commence par YYYY-MM-DD
  //  - autres sessionsMontageAtelier ce jour (même date string)
  // Ignore livraisons/sessions annulées et la session courante (en édition).
  useEffect(() => {
    if (!date) {
      setConflits(new Map());
      return;
    }
    let alive = true;
    (async () => {
      const { collection, query, where, getDocs } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      const conf = new Map<string, string>();
      try {
        const livQ = query(
          collection(db, "livraisons"),
          where("datePrevue", ">=", date),
          where("datePrevue", "<", date + "￿"),
        );
        const livSnap = await getDocs(livQ);
        for (const d of livSnap.docs) {
          const l = d.data() as {
            monteurIds?: string[];
            statut?: string;
            tourneeNumero?: number;
            clientSnapshot?: { entreprise?: string };
          };
          if (l.statut === "annulee") continue;
          const ids = Array.isArray(l.monteurIds) ? l.monteurIds : [];
          for (const id of ids) {
            if (!id) continue;
            const label = `🚚 tournée ${l.tourneeNumero ?? "?"} · ${l.clientSnapshot?.entreprise ?? "?"}`;
            if (!conf.has(id)) conf.set(id, label);
          }
        }
      } catch {}
      try {
        const sQ = query(collection(db, "sessionsMontageAtelier"), where("date", "==", date));
        const sSnap = await getDocs(sQ);
        for (const d of sSnap.docs) {
          const s = d.data() as { monteurIds?: string[]; statut?: string; entrepotNom?: string; entrepotId?: string };
          if (s.statut === "annulee") continue;
          if (s.entrepotId === entrepotId) continue; // même entrepôt = doublon, pas conflit
          const ids = Array.isArray(s.monteurIds) ? s.monteurIds : [];
          for (const id of ids) {
            if (!id) continue;
            const label = `🔧 atelier ${s.entrepotNom ?? "?"}`;
            if (!conf.has(id)) conf.set(id, label);
          }
        }
      } catch {}
      if (alive) setConflits(conf);
    })();
    return () => { alive = false; };
  }, [date, entrepotId]);

  const chefs = equipe.filter((m) => m.role === "chef");
  const monteurs = equipe.filter((m) => m.role === "monteur" || (m.role === "chef" && m.aussiMonteur));
  const teamsByChef = new Map<string, Member[]>();
  for (const m of monteurs) {
    if (!m.chefId) continue;
    if (!teamsByChef.has(m.chefId)) teamsByChef.set(m.chefId, []);
    teamsByChef.get(m.chefId)!.push(m);
  }

  const toggleMonteur = (id: string) => {
    setMonteurIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const toggleTeam = (chefId: string) => {
    const team = teamsByChef.get(chefId) || [];
    const teamIds = team.map((m) => m.id);
    const allSelected = teamIds.every((id) => monteurIds.includes(id));
    if (allSelected) {
      setMonteurIds((prev) => prev.filter((id) => !teamIds.includes(id)));
    } else {
      setMonteurIds((prev) => Array.from(new Set([...prev, ...teamIds])));
    }
  };

  const submit = async () => {
    if (!date) {
      alert("Date obligatoire");
      return;
    }
    if (monteurIds.length === 0) {
      alert("Sélectionne au moins 1 monteur");
      return;
    }
    // Confirmation explicite si certains monteurs sélectionnés sont déjà
    // engagés sur une tournée ou un autre atelier le même jour.
    const conflictSel = monteurIds.filter((id) => conflits.has(id));
    if (conflictSel.length > 0) {
      const labels = conflictSel
        .map((id) => `• ${equipe.find((m) => m.id === id)?.nom || "?"} : ${conflits.get(id)}`)
        .join("\n");
      if (!confirm(`⚠️ ${conflictSel.length} conflit${conflictSel.length > 1 ? "s" : ""} ce jour :\n\n${labels}\n\nContinuer quand même ?`)) {
        return;
      }
    }
    setBusy(true);
    try {
      const { collection, addDoc, doc, setDoc, serverTimestamp } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      const monteurNoms = monteurIds.map((id) => equipe.find((m) => m.id === id)?.nom || "?");
      const chef = chefs.find((c) => c.id === chefId);
      const q = quantitePrevue ? parseInt(quantitePrevue, 10) : null;
      const qr = quantiteReelle ? parseInt(quantiteReelle, 10) : null;
      const payload = {
        entrepotId,
        entrepotNom,
        date,
        monteurIds,
        monteurNoms,
        chefId: chef?.id || null,
        chefNom: chef?.nom || null,
        quantitePrevue: q && q > 0 ? q : null,
        quantiteReelle: qr && qr > 0 ? qr : null,
        notes: notes.trim() || null,
        statut,
        updatedAt: serverTimestamp(),
      };
      if (existingSessionId) {
        // Mode édition : merge update sur le doc existant
        await setDoc(doc(db, "sessionsMontageAtelier", existingSessionId), payload, { merge: true });
      } else {
        // Mode création
        await addDoc(collection(db, "sessionsMontageAtelier"), {
          ...payload,
          createdAt: serverTimestamp(),
        });
      }
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Suppression (mode édition uniquement) — soft delete via statut=annulee
  const cancelSession = async () => {
    if (!existingSessionId) return;
    if (!confirm(`Annuler cette session atelier du ${date} ?`)) return;
    setBusy(true);
    try {
      const { doc, setDoc, serverTimestamp } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      await setDoc(doc(db, "sessionsMontageAtelier", existingSessionId), {
        statut: "annulee",
        updatedAt: serverTimestamp(),
      }, { merge: true });
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[2000] p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-3">
          <h2 className="text-lg font-semibold">
            {existingSessionId ? "🔧 Gérer session atelier" : "+ Planifier session montage atelier"}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>
        {loadingExisting && (
          <div className="bg-blue-50 border border-blue-200 rounded p-2 text-[11px] text-blue-900 mb-2">
            Chargement de la session…
          </div>
        )}
        <div className="space-y-3">
          <div className="bg-amber-50 border border-amber-200 rounded p-2 text-[11px] text-amber-900">
            📍 Entrepôt : <strong>{entrepotNom}</strong>
            <br />
            <span className="opacity-80">
              Les monteurs assignés verront cette journée dans leur planning et sauront qu&apos;ils
              doivent venir monter à cet entrepôt.
            </span>
          </div>
          <div>
            <label className="text-xs text-gray-600">Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full px-2 py-1.5 border rounded text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Chef d&apos;équipe (optionnel)</label>
            <select
              value={chefId}
              onChange={(e) => setChefId(e.target.value)}
              className="w-full px-2 py-1.5 border rounded text-sm"
            >
              <option value="">— Aucun —</option>
              {chefs.map((c) => (
                <option key={c.id} value={c.id}>{c.nom}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-600">Quantité prévue</label>
              <input
                type="number"
                value={quantitePrevue}
                onChange={(e) => setQuantitePrevue(e.target.value)}
                placeholder="Ex: 100"
                className="w-full px-2 py-1.5 border rounded text-sm"
              />
            </div>
            {existingSessionId && (
              <div>
                <label className="text-xs text-gray-600">Quantité réelle (montés)</label>
                <input
                  type="number"
                  value={quantiteReelle}
                  onChange={(e) => setQuantiteReelle(e.target.value)}
                  placeholder="Réel"
                  className="w-full px-2 py-1.5 border rounded text-sm"
                />
              </div>
            )}
          </div>
          {existingSessionId && (
            <div>
              <label className="text-xs text-gray-600">Statut</label>
              <select
                value={statut}
                onChange={(e) => setStatut(e.target.value as typeof statut)}
                className="w-full px-2 py-1.5 border rounded text-sm bg-white"
              >
                <option value="planifiee">📅 Planifiée</option>
                <option value="en_cours">🔧 En cours</option>
                <option value="terminee">✓ Terminée</option>
                <option value="annulee">✕ Annulée</option>
              </select>
            </div>
          )}
          <div>
            <label className="text-xs text-gray-600 block mb-1">Monteurs assignés ({monteurIds.length} sélectionnés)</label>
            {conflits.size > 0 && (
              <div className="mb-2 bg-amber-100 border border-amber-300 rounded p-2 text-[10px] text-amber-900">
                ⚠️ <strong>{conflits.size} monteur{conflits.size > 1 ? "s" : ""}</strong> déjà engagé{conflits.size > 1 ? "s" : ""} ce jour-là (signalé en orange ci-dessous).
              </div>
            )}
            {teamsByChef.size > 0 && (
              <div className="mb-2 flex flex-wrap gap-1">
                <span className="text-[10px] text-gray-500 self-center">Sélection rapide :</span>
                {Array.from(teamsByChef.entries()).map(([chefIdKey, team]) => {
                  const chef = chefs.find((c) => c.id === chefIdKey);
                  if (!chef) return null;
                  const teamIds = team.map((m) => m.id);
                  const allSel = teamIds.every((id) => monteurIds.includes(id));
                  const someSel = teamIds.some((id) => monteurIds.includes(id));
                  return (
                    <button
                      key={chefIdKey}
                      type="button"
                      onClick={() => toggleTeam(chefIdKey)}
                      className={`text-[10px] px-2 py-0.5 rounded-full border ${
                        allSel ? "bg-blue-600 text-white border-blue-600"
                        : someSel ? "bg-blue-100 text-blue-800 border-blue-300"
                        : "bg-white text-gray-700 border-gray-300 hover:bg-blue-50"
                      }`}
                    >
                      {allSel ? "✓" : someSel ? "◐" : "+"} {chef.nom} ({team.length})
                    </button>
                  );
                })}
              </div>
            )}
            <div className="flex flex-wrap gap-1 max-h-40 overflow-y-auto">
              {monteurs.map((m) => {
                const on = monteurIds.includes(m.id);
                const chef = m.chefId ? chefs.find((c) => c.id === m.chefId) : null;
                const conflit = conflits.get(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => toggleMonteur(m.id)}
                    title={conflit ? `Déjà engagé ce jour : ${conflit}` : undefined}
                    className={`text-[10px] px-2 py-0.5 rounded-full border ${
                      on ? "bg-emerald-600 text-white border-emerald-600"
                        : conflit
                          ? "bg-amber-50 border-amber-400 text-amber-900 hover:bg-amber-100"
                          : "bg-white border-gray-300 text-gray-700 hover:bg-gray-50"
                    }`}
                  >
                    {on && "✓ "}{conflit && !on && "⚠️ "}{m.nom}
                    {chef && <span className={`ml-1 text-[9px] ${on ? "opacity-80" : "opacity-50"}`}>· {chef.nom}</span>}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-600">Notes (optionnel)</label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder='Ex: "Préparation Firat Food + LAV"'
              className="w-full px-2 py-1.5 border rounded text-sm"
            />
          </div>
        </div>
        <div className="mt-4 flex justify-between gap-2">
          <div className="flex gap-2 flex-wrap">
            {existingSessionId && statut !== "annulee" && (
              <a
                href={`/atelier?id=${encodeURIComponent(existingSessionId)}`}
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 font-semibold"
                title="Page scan chef : affilier les FNUCI aux clients pendant la session atelier"
              >
                📷 Ouvrir l atelier
              </a>
            )}
            {existingSessionId && statut !== "annulee" && (
              <button
                onClick={cancelSession}
                disabled={busy}
                className="px-3 py-1.5 text-sm border border-red-300 text-red-700 rounded hover:bg-red-50"
                title="Annule cette session (soft delete, statut=annulee)"
              >
                ✕ Annuler la session
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50">Fermer</button>
            <button
              onClick={submit}
              disabled={busy || monteurIds.length === 0}
              className="px-3 py-1.5 text-sm bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50 font-semibold"
            >
              {busy ? "..." : existingSessionId ? "✓ Sauvegarder" : "🔧 Planifier la session"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Panel "🤖 Suggérer tournée" sur chaque card entrepôt (Yoann 2026-05-01).
// Au clic, ouvre un modal qui appelle suggestTourneeFromEntrepot et
// affiche les clients optimaux à livrer depuis cet entrepôt.
// Exporté pour réutilisation dans /carte sidebar (Yoann 2026-05-01) — il
// veut suggérer depuis la carte pour voir visuellement les clients alentours.
export function SuggererTourneePanel({
  entrepotId,
  entrepotNom,
  stockCartons,
  stockVelosMontes,
}: {
  entrepotId: string;
  entrepotNom: string;
  stockCartons: number;
  stockVelosMontes: number;
}) {
  const [showModal, setShowModal] = useState(false);
  const [showJourneeModal, setShowJourneeModal] = useState(false);
  const totalDispo = stockCartons + stockVelosMontes;
  return (
    <>
      <div className="flex items-center justify-between gap-2 bg-indigo-50 border border-indigo-200 rounded p-1.5">
        <div className="text-[11px] text-indigo-900 truncate">
          🤖 <strong>Suggérer</strong>
          <span className="opacity-70 ml-1">· {totalDispo} v dispo</span>
        </div>
        <div className="flex gap-1 shrink-0">
          <button
            onClick={() => setShowModal(true)}
            disabled={totalDispo <= 0}
            className="px-2 py-0.5 text-[11px] bg-indigo-600 text-white rounded hover:bg-indigo-700 font-semibold disabled:opacity-50"
            title={totalDispo <= 0 ? "Aucun stock dispo" : "1 tournée optimale depuis cet entrepôt"}
          >
            🤖 1 tournée
          </button>
          <button
            onClick={() => setShowJourneeModal(true)}
            disabled={totalDispo <= 0}
            className="px-2 py-0.5 text-[11px] bg-purple-600 text-white rounded hover:bg-purple-700 font-semibold disabled:opacity-50"
            title="Planifie 2-3 tournées dans la journée chauffeur (8h30) pour maximiser les vélos livrés"
          >
            📅 Journée
          </button>
        </div>
      </div>
      {showModal && (
        <SuggererTourneeModal
          entrepotId={entrepotId}
          entrepotNom={entrepotNom}
          stockCartons={stockCartons}
          stockVelosMontes={stockVelosMontes}
          onClose={() => setShowModal(false)}
        />
      )}
      {showJourneeModal && (
        <PlanifierJourneeModal
          entrepotId={entrepotId}
          entrepotNom={entrepotNom}
          stockCartons={stockCartons}
          stockVelosMontes={stockVelosMontes}
          onClose={() => setShowJourneeModal(false)}
        />
      )}
    </>
  );
}

type SuggestionStop = {
  id: string;
  entreprise: string;
  ville: string;
  lat: number;
  lng: number;
  nbVelos: number;
  distance: number;
  velosRestantsApres: number;
};
type SuggestionResult = {
  ok: boolean;
  error?: string;
  entrepot?: { nom: string; ville: string; adresse: string; stockDispo: number };
  mode?: string;
  modeMontage?: string;
  capaciteCamion?: number;
  capaciteEffective?: number;
  totalVelos?: number;
  nbStops?: number;
  distanceTotaleKm?: number;
  dureeTotaleMin?: number | null;
  routingSource?: "haversine" | "maps";
  routingError?: string | null;
  velosParHeure?: number | null;
  velosParKm?: number | null;
  tauxRemplissage?: number | null;
  stops?: SuggestionStop[];
  candidatsHorsTournee?: Array<{ id: string; entreprise: string; ville: string; distance: number; velosRestants: number }>;
};

// Yoann 2026-05-01 : exporté pour réutilisation depuis /carte (click client →
// suggestion automatique depuis l entrepôt le + proche).
export function SuggererTourneeModal({
  entrepotId,
  entrepotNom,
  stockCartons,
  stockVelosMontes,
  onClose,
}: {
  entrepotId: string;
  entrepotNom: string;
  stockCartons: number;
  stockVelosMontes: number;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"gros" | "moyen" | "petit" | "camionnette">("moyen");
  const [modeMontage, setModeMontage] = useState<"client" | "atelier" | "client_redistribue">(
    stockVelosMontes > 0 ? "atelier" : "client",
  );
  const [maxDistance, setMaxDistance] = useState(50);
  const [useMaps, setUseMaps] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SuggestionResult | null>(null);
  // Création tournée (Yoann 2026-05-01) : date par défaut = aujourd'hui Paris.
  const [datePrevue, setDatePrevue] = useState(() => {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  });
  const [creating, setCreating] = useState(false);
  const [createdInfo, setCreatedInfo] = useState<{ tourneeId: string; livraisonsCount: number } | null>(null);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const { gasPost } = await import("@/lib/gas");
      const r = (await gasPost("suggestTourneeFromEntrepot", {
        entrepotId,
        mode,
        modeMontage,
        maxDistance,
        useMaps,
      })) as SuggestionResult;
      setResult(r);
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const stockSelectMontage = modeMontage === "client" ? stockCartons : stockVelosMontes;

  const createTournee = async () => {
    if (!result?.ok || !result.stops || result.stops.length === 0) return;
    if (!datePrevue) {
      alert("Choisis une date prévue");
      return;
    }
    if (!confirm(`Créer la tournée ${result.stops.length} arrêts / ${result.totalVelos} vélos pour le ${datePrevue} ?`)) return;
    setCreating(true);
    try {
      const { gasPost } = await import("@/lib/gas");
      // mode camion → mode tournée GAS : "client" | "atelier_*" — on garde
      // simplement le modeMontage choisi (client / atelier / client_redistribue)
      // côté tournée pour traçabilité, et on passe entrepotOrigineId.
      const r = (await gasPost("createTournee", {
        datePrevue,
        mode: modeMontage,
        modeMontage,
        entrepotOrigineId: entrepotId,
        notes: `Auto-suggérée depuis entrepôt ${entrepotNom} (camion ${mode}, ${maxDistance}km max)`,
        statut: "planifiee",
        stops: result.stops.map((s, i) => ({
          clientId: s.id,
          nbVelos: s.nbVelos,
          ordre: i + 1,
        })),
      })) as { ok?: boolean; tourneeId?: string; livraisonsCount?: number; error?: string };
      if (r.error || !r.tourneeId) {
        alert("Erreur création : " + (r.error || "inconnue"));
      } else {
        setCreatedInfo({ tourneeId: r.tourneeId, livraisonsCount: r.livraisonsCount || 0 });
      }
    } catch (e) {
      alert("Erreur : " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[2000] p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-3">
          <h2 className="text-lg font-semibold">🤖 Suggérer une tournée depuis {entrepotNom}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>

        {/* Paramètres */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3 bg-indigo-50 border border-indigo-200 rounded p-3">
          <div>
            <label className="text-xs text-gray-600">Type de camion</label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as typeof mode)}
              className="w-full px-2 py-1.5 border rounded text-sm bg-white"
            >
              <option value="gros">Grand (77 cartons / 40 montés) — interdit Paris</option>
              <option value="petit">Petit (44 cartons / 20 montés) — accès Paris</option>
              <option value="moyen">Moyen (54 cartons / 30 montés)</option>
              <option value="camionnette">Camionnette (44 cartons / 20 montés)</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-600">Mode montage</label>
            <select
              value={modeMontage}
              onChange={(e) => setModeMontage(e.target.value as typeof modeMontage)}
              className="w-full px-2 py-1.5 border rounded text-sm bg-white"
            >
              <option value="client">📦 Cartons + montage chez client</option>
              <option value="atelier">🔧 Vélos déjà montés</option>
              <option value="client_redistribue">🟣 Éphémère (client redistribue)</option>
            </select>
            <div className="text-[10px] text-gray-500 mt-0.5">
              Stock dispo : <strong>{stockSelectMontage}</strong> {modeMontage === "client" ? "cartons" : "montés"}
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-600">Distance max (km)</label>
            <input
              type="number"
              value={maxDistance}
              onChange={(e) => setMaxDistance(Number(e.target.value))}
              min={5}
              max={200}
              step={5}
              className="w-full px-2 py-1.5 border rounded text-sm"
            />
          </div>
        </div>

        <label className="flex items-start gap-2 mb-3 px-1 cursor-pointer">
          <input
            type="checkbox"
            checked={useMaps}
            onChange={(e) => setUseMaps(e.target.checked)}
            className="mt-0.5"
          />
          <span className="text-[11px] text-gray-700">
            🗺 <strong>Routing Google Maps réel</strong> (distance route + durée trajet)
            <br />
            <span className="text-gray-500">
              Sinon : vol d&apos;oiseau Haversine (gratuit, instantané, ±20 % moins précis).
              Coût Maps : ~1 appel par suggestion (Distance Matrix).
            </span>
          </span>
        </label>

        <button
          onClick={run}
          disabled={busy || stockSelectMontage <= 0}
          className="w-full px-3 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 font-semibold"
        >
          {busy ? "🤖 Calcul..." : "🤖 Calculer la tournée optimale"}
        </button>

        {/* Résultat */}
        {result && (
          <div className="mt-4">
            {result.error ? (
              <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-800">
                ❌ {result.error}
              </div>
            ) : result.ok && result.stops ? (
              <>
                <div className="bg-emerald-50 border border-emerald-300 rounded p-3 mb-3">
                  <div className="text-sm font-bold text-emerald-900">
                    ✓ Tournée optimale : {result.nbStops} arrêts · {result.totalVelos} vélos
                    {typeof result.distanceTotaleKm === "number" && (
                      <span className="ml-2 text-emerald-700">· 🛣 {result.distanceTotaleKm} km</span>
                    )}
                    {typeof result.dureeTotaleMin === "number" && result.dureeTotaleMin > 0 && (
                      <span className="ml-2 text-emerald-700">· ⏱ {Math.floor(result.dureeTotaleMin / 60)}h{String(result.dureeTotaleMin % 60).padStart(2, "0")}</span>
                    )}
                  </div>
                  <div className="text-xs text-emerald-800 mt-1">
                    Capacité {mode} ({modeMontage}) : {result.capaciteCamion} v · Effective : <strong>{result.capaciteEffective} v</strong>
                    {result.routingSource === "maps" && (
                      <span className="ml-2 text-blue-700">🗺 routing Maps réel</span>
                    )}
                    {result.routingSource === "haversine" && useMaps && result.routingError && (
                      <span className="ml-2 text-amber-700">⚠️ Maps KO ({result.routingError}) — fallback Haversine</span>
                    )}
                  </div>
                  {/* KPIs rentabilité (Yoann 2026-05-01 — Phase 2.3) */}
                  <div className="grid grid-cols-3 gap-2 mt-2 text-[10px]">
                    {result.velosParHeure != null && (
                      <div className="bg-white border border-emerald-200 rounded p-1 text-center">
                        <div className="font-bold text-emerald-900 text-sm">{result.velosParHeure}</div>
                        <div className="text-emerald-700 uppercase">v/h chauffeur</div>
                      </div>
                    )}
                    {result.velosParKm != null && (
                      <div className="bg-white border border-emerald-200 rounded p-1 text-center">
                        <div className="font-bold text-emerald-900 text-sm">{result.velosParKm}</div>
                        <div className="text-emerald-700 uppercase">v/km</div>
                      </div>
                    )}
                    {result.tauxRemplissage != null && (
                      <div className={`border rounded p-1 text-center ${result.tauxRemplissage >= 90 ? "bg-emerald-100 border-emerald-400" : result.tauxRemplissage >= 60 ? "bg-amber-50 border-amber-300" : "bg-red-50 border-red-300"}`}>
                        <div className="font-bold text-sm">{result.tauxRemplissage}%</div>
                        <div className="uppercase text-gray-600">remplissage</div>
                      </div>
                    )}
                  </div>
                </div>
                <div className="border rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b text-xs text-gray-600">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium">#</th>
                        <th className="text-left px-3 py-2 font-medium">Client</th>
                        <th className="text-left px-3 py-2 font-medium">Ville</th>
                        <th className="text-right px-3 py-2 font-medium">Vélos</th>
                        <th className="text-right px-3 py-2 font-medium">Distance</th>
                        <th className="text-right px-3 py-2 font-medium">Reste après</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {result.stops.map((s, i) => (
                        <tr key={s.id} className="hover:bg-gray-50">
                          <td className="px-3 py-1.5 text-gray-400">{i + 1}</td>
                          <td className="px-3 py-1.5 font-medium">{s.entreprise}</td>
                          <td className="px-3 py-1.5 text-xs text-gray-600">{s.ville}</td>
                          <td className="px-3 py-1.5 text-right font-semibold text-emerald-700">{s.nbVelos}</td>
                          <td className="px-3 py-1.5 text-right text-xs text-gray-600">{s.distance} km</td>
                          <td className="px-3 py-1.5 text-right text-xs text-gray-500">{s.velosRestantsApres}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {result.candidatsHorsTournee && result.candidatsHorsTournee.length > 0 && (
                  <details className="mt-3">
                    <summary className="text-xs text-gray-500 cursor-pointer hover:underline">
                      Voir les {result.candidatsHorsTournee.length} candidats hors tournée (capacité atteinte)
                    </summary>
                    <ul className="mt-1 text-[11px] text-gray-600 space-y-0.5">
                      {result.candidatsHorsTournee.map((c) => (
                        <li key={c.id}>
                          {c.entreprise} ({c.ville}) — {c.distance} km, {c.velosRestants} vélos restants
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {/* Création tournée — Yoann 2026-05-01 */}
                {createdInfo ? (
                  <div className="mt-3 bg-emerald-100 border border-emerald-400 rounded p-3">
                    <div className="text-sm font-bold text-emerald-900">
                      ✓ Tournée créée : {createdInfo.livraisonsCount} livraisons planifiées le {datePrevue}
                    </div>
                    <a
                      href="/livraisons"
                      className="inline-block mt-1 text-xs text-emerald-700 underline hover:text-emerald-900"
                    >
                      → Voir dans Livraisons
                    </a>
                  </div>
                ) : (
                  <div className="mt-3 bg-amber-50 border border-amber-200 rounded p-3 flex items-end gap-2 flex-wrap">
                    <div className="flex-1 min-w-[150px]">
                      <label className="text-xs text-gray-600 block">Date prévue</label>
                      <input
                        type="date"
                        value={datePrevue}
                        onChange={(e) => setDatePrevue(e.target.value)}
                        className="w-full px-2 py-1.5 border rounded text-sm bg-white"
                      />
                    </div>
                    <button
                      onClick={createTournee}
                      disabled={creating}
                      className="px-3 py-1.5 bg-emerald-600 text-white rounded text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {creating ? "Création..." : `✓ Créer la tournée (${result.nbStops} stops)`}
                    </button>
                  </div>
                )}
                <div className="mt-2 text-[11px] text-gray-500 italic">
                  💡 nearest-neighbor + 2-opt sur matrice {result.routingSource === "maps" ? "Google Maps Distance Matrix (route réelle)" : "Haversine (vol d'oiseau)"}.
                </div>
              </>
            ) : (
              <div className="text-sm text-gray-500 italic">Aucun résultat</div>
            )}
          </div>
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

// PlanifierJourneeModal — Yoann 2026-05-01.
// Multi-tournées sur 8h30 chauffeur. Maximise vélos livrés/jour en
// chaînant 2-3 tournées (montés=15min/stop, cartons=12min×N/nbMonteurs).
type JourneeStop = {
  id: string;
  entreprise: string;
  ville: string;
  lat: number;
  lng: number;
  nbVelos: number;
  distance: number;
};
type JourneeTournee = {
  index: number;
  capaciteEffective: number;
  totalVelos: number;
  nbStops: number;
  distanceKm: number;
  dureeRouteMin: number;
  dureeArretsMin: number;
  dureeTotalMin: number;
  routingSource: "haversine" | "maps";
  velosParHeure?: number;
  velosParKm?: number;
  tauxRemplissage?: number;
  stops: JourneeStop[];
};
type JourneeResult = {
  ok: boolean;
  error?: string;
  entrepot?: { id: string; nom: string; stockDispo: number; stockRestantApres: number };
  mode?: string;
  modeMontage?: string;
  capaciteCamion?: number;
  dureeJourneeMin?: number;
  dureeJourneeUtilisee?: number;
  tempsLibreMin?: number;
  nbTournees?: number;
  totalVelosJournee?: number;
  totalKmJournee?: number;
  velosParHeureJournee?: number;
  velosParKmJournee?: number;
  monteursParTournee?: number;
  tournees?: JourneeTournee[];
};

// Yoann 2026-05-03 : exporté + accepte initialParams pour pré-remplir depuis
// l action "Adopter ce plan" du modal Stratégie Gemini.
export function PlanifierJourneeModal({
  entrepotId,
  entrepotNom,
  stockCartons,
  stockVelosMontes,
  initialParams,
  onClose,
}: {
  entrepotId: string;
  entrepotNom: string;
  stockCartons: number;
  stockVelosMontes: number;
  initialParams?: {
    mode?: "gros" | "moyen" | "petit" | "camionnette";
    modeMontage?: "client" | "atelier" | "client_redistribue";
    maxTournees?: number;
    monteursParTournee?: number;
  };
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"gros" | "moyen" | "petit" | "camionnette">(initialParams?.mode || "moyen");
  const [modeMontage, setModeMontage] = useState<"client" | "atelier" | "client_redistribue">(
    initialParams?.modeMontage || (stockVelosMontes > 0 ? "atelier" : "client"),
  );
  const [maxDistance, setMaxDistance] = useState(50);
  const [maxTournees, setMaxTournees] = useState(initialParams?.maxTournees || 3);
  const [dureeJourneeMin, setDureeJourneeMin] = useState(510); // 8h30
  const [monteursParTournee, setMonteursParTournee] = useState(initialParams?.monteursParTournee || 2);
  const [useMaps, setUseMaps] = useState(true); // par défaut Maps activé pour cette planif (durées route critiques)
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<JourneeResult | null>(null);
  const [datePrevue, setDatePrevue] = useState(() => {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ count: number } | null>(null);

  const stockSelectMontage = modeMontage === "client" ? stockCartons : stockVelosMontes;

  const run = async () => {
    setBusy(true);
    setResult(null);
    setCreated(null);
    try {
      const { gasPost } = await import("@/lib/gas");
      const r = (await gasPost("planifierJourneeCamion", {
        entrepotId,
        mode,
        modeMontage,
        maxDistance,
        maxTournees,
        dureeJourneeMin,
        monteursParTournee,
        useMaps,
      })) as JourneeResult;
      setResult(r);
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const createAll = async () => {
    if (!result?.ok || !result.tournees || result.tournees.length === 0) return;
    if (!datePrevue) {
      alert("Choisis une date prévue");
      return;
    }
    if (!confirm(`Créer les ${result.tournees.length} tournées (${result.totalVelosJournee} vélos) le ${datePrevue} ?`)) return;
    setCreating(true);
    try {
      const { gasPost } = await import("@/lib/gas");
      const tournees = result.tournees.map((t) => ({
        datePrevue,
        mode: modeMontage,
        modeMontage,
        entrepotOrigineId: entrepotId,
        notes: `T${t.index}/${result.tournees!.length} auto-planifiée depuis ${entrepotNom} · ${t.totalVelos}v · ${Math.round(t.dureeTotalMin)}min`,
        statut: "planifiee",
        stops: t.stops.map((s, i) => ({ clientId: s.id, nbVelos: s.nbVelos, ordre: i + 1 })),
      }));
      const r = (await gasPost("createTournees", {
        tournees,
        mode: modeMontage,
      })) as { count?: number; tournees?: Array<{ tourneeId: string }>; error?: string };
      if (r.error) {
        alert("Erreur création : " + r.error);
      } else {
        setCreated({ count: r.count || tournees.length });
      }
    } catch (e) {
      alert("Erreur : " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setCreating(false);
    }
  };

  const formatMin = (m: number) => `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, "0")}`;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[2000] p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-3xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-3">
          <h2 className="text-lg font-semibold">📅 Planifier la journée camion · {entrepotNom}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3 bg-purple-50 border border-purple-200 rounded p-3">
          <div>
            <label className="text-xs text-gray-600">Camion</label>
            <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} className="w-full px-2 py-1.5 border rounded text-sm bg-white">
              <option value="gros">Grand</option>
              <option value="moyen">Moyen</option>
              <option value="petit">Petit</option>
              <option value="camionnette">Camionnette</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-600">Mode</label>
            <select value={modeMontage} onChange={(e) => setModeMontage(e.target.value as typeof modeMontage)} className="w-full px-2 py-1.5 border rounded text-sm bg-white">
              <option value="client">📦 Cartons</option>
              <option value="atelier">🔧 Montés</option>
              <option value="client_redistribue">🟣 Éphémère</option>
            </select>
            <div className="text-[10px] text-gray-500 mt-0.5">Stock : {stockSelectMontage}</div>
          </div>
          <div>
            <label className="text-xs text-gray-600">Max tournées</label>
            <input type="number" value={maxTournees} onChange={(e) => setMaxTournees(Number(e.target.value))} min={1} max={5} className="w-full px-2 py-1.5 border rounded text-sm" />
          </div>
          <div>
            <label className="text-xs text-gray-600">Journée (min)</label>
            <input type="number" value={dureeJourneeMin} onChange={(e) => setDureeJourneeMin(Number(e.target.value))} min={120} max={720} step={30} className="w-full px-2 py-1.5 border rounded text-sm" />
            <div className="text-[10px] text-gray-500 mt-0.5">{formatMin(dureeJourneeMin)}</div>
          </div>
          <div>
            <label className="text-xs text-gray-600">Distance max (km)</label>
            <input type="number" value={maxDistance} onChange={(e) => setMaxDistance(Number(e.target.value))} min={5} max={200} step={5} className="w-full px-2 py-1.5 border rounded text-sm" />
          </div>
          <div>
            <label className="text-xs text-gray-600">Monteurs/tournée</label>
            <input type="number" value={monteursParTournee} onChange={(e) => setMonteursParTournee(Number(e.target.value))} min={1} max={10} className="w-full px-2 py-1.5 border rounded text-sm" />
            <div className="text-[10px] text-gray-500 mt-0.5">{modeMontage === "client" ? "(impacte temps arrêt)" : "(infos seulement)"}</div>
          </div>
          <div className="col-span-2">
            <label className="flex items-start gap-2 text-[11px] text-gray-700 cursor-pointer mt-3">
              <input type="checkbox" checked={useMaps} onChange={(e) => setUseMaps(e.target.checked)} className="mt-0.5" />
              <span>
                🗺 <strong>Routing Maps réel</strong> (durées route précises — recommandé pour la planif journée)
              </span>
            </label>
          </div>
        </div>

        <button onClick={run} disabled={busy || stockSelectMontage <= 0} className="w-full px-3 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 font-semibold">
          {busy ? "🤖 Calcul..." : `📅 Planifier la journée (max ${maxTournees} tournées)`}
        </button>

        {result && (
          <div className="mt-4">
            {result.error ? (
              <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-800">❌ {result.error}</div>
            ) : result.ok && result.tournees && result.tournees.length > 0 ? (
              <>
                <div className="bg-emerald-50 border border-emerald-300 rounded p-3 mb-3">
                  <div className="text-base font-bold text-emerald-900">
                    ✓ {result.nbTournees} tournée{(result.nbTournees ?? 0) > 1 ? "s" : ""} · {result.totalVelosJournee} vélos / jour
                  </div>
                  <div className="text-xs text-emerald-800 mt-1 grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <div>🛣 {result.totalKmJournee} km total</div>
                    <div>⏱ {formatMin(result.dureeJourneeUtilisee || 0)} utilisé</div>
                    <div className="text-emerald-600">💤 {formatMin(result.tempsLibreMin || 0)} libre</div>
                    <div>📦 {result.entrepot?.stockRestantApres ?? "?"} reste en stock</div>
                  </div>
                  {/* KPIs globaux journée (Yoann 2026-05-01 — Phase 2.3) */}
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    {result.velosParHeureJournee != null && (
                      <div className="bg-white border border-emerald-200 rounded px-2 py-1 text-center">
                        <span className="text-base font-bold text-emerald-900">{result.velosParHeureJournee}</span>
                        <span className="text-[10px] text-emerald-700 ml-1 uppercase">vélos / heure chauffeur</span>
                      </div>
                    )}
                    {result.velosParKmJournee != null && (
                      <div className="bg-white border border-emerald-200 rounded px-2 py-1 text-center">
                        <span className="text-base font-bold text-emerald-900">{result.velosParKmJournee}</span>
                        <span className="text-[10px] text-emerald-700 ml-1 uppercase">vélos / km roulés</span>
                      </div>
                    )}
                  </div>
                </div>

                {result.tournees.map((t) => (
                  <div key={t.index} className="border rounded-lg mb-3 overflow-hidden">
                    <div className="bg-purple-100 border-b border-purple-300 px-3 py-2 text-sm flex items-center justify-between gap-2">
                      <div className="font-bold text-purple-900">Tournée {t.index}</div>
                      <div className="text-xs text-purple-800 flex gap-3 flex-wrap justify-end">
                        <span><strong>{t.totalVelos}</strong>v / {t.capaciteEffective}</span>
                        <span>📍 {t.nbStops} stops</span>
                        <span>🛣 {t.distanceKm} km</span>
                        <span title="Durée trajet route">🚗 {formatMin(t.dureeRouteMin)}</span>
                        <span title="Durée totale arrêts">🛑 {formatMin(t.dureeArretsMin)}</span>
                        <span title="Durée totale tournée"><strong>⏱ {formatMin(t.dureeTotalMin)}</strong></span>
                        {t.velosParHeure != null && <span title="Productivité chauffeur">⚡ {t.velosParHeure} v/h</span>}
                        {t.tauxRemplissage != null && <span title="Taux remplissage camion" className={t.tauxRemplissage >= 90 ? "text-emerald-700 font-bold" : t.tauxRemplissage >= 60 ? "text-amber-700" : "text-red-700"}>📊 {t.tauxRemplissage}%</span>}
                        {t.routingSource === "maps" && <span className="text-blue-700">🗺</span>}
                      </div>
                    </div>
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50 border-b text-gray-600">
                        <tr>
                          <th className="text-left px-3 py-1.5 font-medium">#</th>
                          <th className="text-left px-3 py-1.5 font-medium">Client</th>
                          <th className="text-left px-3 py-1.5 font-medium">Ville</th>
                          <th className="text-right px-3 py-1.5 font-medium">Vélos</th>
                          <th className="text-right px-3 py-1.5 font-medium">Distance</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {t.stops.map((s, i) => (
                          <tr key={s.id} className="hover:bg-gray-50">
                            <td className="px-3 py-1 text-gray-400">{i + 1}</td>
                            <td className="px-3 py-1 font-medium">{s.entreprise}</td>
                            <td className="px-3 py-1 text-gray-600">{s.ville}</td>
                            <td className="px-3 py-1 text-right font-semibold text-emerald-700">{s.nbVelos}</td>
                            <td className="px-3 py-1 text-right text-gray-600">{s.distance} km</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}

                {/* Création batch */}
                {created ? (
                  <div className="bg-emerald-100 border border-emerald-400 rounded p-3 mt-3">
                    <div className="text-sm font-bold text-emerald-900">
                      ✓ {created.count} tournée{created.count > 1 ? "s" : ""} créée{created.count > 1 ? "s" : ""} le {datePrevue}
                    </div>
                    <a href="/livraisons" className="inline-block mt-1 text-xs text-emerald-700 underline hover:text-emerald-900">
                      → Voir dans Livraisons
                    </a>
                  </div>
                ) : (
                  <div className="bg-amber-50 border border-amber-200 rounded p-3 flex items-end gap-2 flex-wrap mt-3">
                    <div className="flex-1 min-w-[140px]">
                      <label className="text-xs text-gray-600 block">Date prévue</label>
                      <input type="date" value={datePrevue} onChange={(e) => setDatePrevue(e.target.value)} className="w-full px-2 py-1.5 border rounded text-sm bg-white" />
                    </div>
                    <button
                      onClick={createAll}
                      disabled={creating}
                      className="px-3 py-1.5 bg-emerald-600 text-white rounded text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {creating ? "Création..." : `✓ Créer les ${result.nbTournees} tournées`}
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="bg-amber-50 border border-amber-200 rounded p-3 text-sm text-amber-800">
                ⚠️ Aucune tournée ne tient dans la journée avec ces paramètres.
                Augmente la durée de journée OU baisse le mode camion / mode montage.
              </div>
            )}
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <button onClick={onClose} className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50">Fermer</button>
        </div>
      </div>
    </div>
  );
}

// StockCibleModal — Yoann 2026-05-03
// Calcule pour chaque entrepôt le stock cartons + montés cible pour servir
// les clients dans un rayon (par défaut 100 km autour de Paris). Voronoi :
// chaque client est attribué à l entrepôt le + proche, puis on décompose
// la demande en gros volumes (>30v → cartons) et petits volumes (≤30v → montés).
type StockCibleResult = {
  ok?: boolean;
  error?: string;
  rayonKm?: number;
  center?: { lat: number; lng: number; label: string };
  seuilGrosVolume?: number;
  nbEntrepots?: number;
  nbClientsRayon?: number;
  totalDemande?: number;
  totalCibleCartons?: number;
  totalCibleMontes?: number;
  entrepots?: Array<{
    entrepotId: string;
    nom: string;
    ville: string;
    stockActuel: { cartons: number; montes: number; total: number };
    demande: { totale: number; grosVolumes: number; petitsVolumes: number; nbClients: number; nbGros: number; nbPetits: number };
    cible: { cartons: number; montes: number; total: number; buffer: string };
    ecart: { cartons: number; montes: number; total: number };
    capaciteAtteinte: boolean;
    capaciteMax: number | null;
  }>;
};

function StockCibleModal({ onClose }: { onClose: () => void }) {
  const [rayonKm, setRayonKm] = useState(100);
  const [seuilGrosVolume, setSeuilGrosVolume] = useState(30);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<StockCibleResult | null>(null);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const { gasPost } = await import("@/lib/gas");
      const r = (await gasPost("suggestionStockEntrepot", {
        rayonKm,
        seuilGrosVolume,
      })) as StockCibleResult;
      setResult(r);
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[2000] p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-3xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-3">
          <div>
            <h2 className="text-lg font-semibold">🎯 Stock cible · Opération Paris</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Pour chaque entrepôt, suggère le stock cartons + montés à avoir pour servir les clients dans le rayon (Voronoi : chaque client → entrepôt le + proche).
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-3 bg-emerald-50 border border-emerald-200 rounded p-3">
          <div>
            <label className="text-xs text-gray-600">Rayon autour de Paris (km)</label>
            <input
              type="number"
              value={rayonKm}
              onChange={(e) => setRayonKm(Number(e.target.value))}
              min={5}
              max={500}
              step={10}
              className="w-full px-2 py-1.5 border rounded text-sm bg-white"
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Seuil gros volume (vélos)</label>
            <input
              type="number"
              value={seuilGrosVolume}
              onChange={(e) => setSeuilGrosVolume(Number(e.target.value))}
              min={5}
              max={200}
              className="w-full px-2 py-1.5 border rounded text-sm bg-white"
            />
            <div className="text-[10px] text-gray-500 mt-0.5">
              {seuilGrosVolume}v+ par client = cartons (montage chez client) ; sinon montés
            </div>
          </div>
        </div>

        <button
          onClick={run}
          disabled={busy}
          className="w-full px-3 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 text-white rounded-lg hover:opacity-90 disabled:opacity-50 font-semibold"
        >
          {busy ? "🎯 Calcul..." : "🎯 Calculer le stock cible"}
        </button>

        {result && (
          <div className="mt-4">
            {result.error ? (
              <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-800">❌ {result.error}</div>
            ) : result.ok && result.entrepots ? (
              <>
                <div className="bg-emerald-50 border border-emerald-300 rounded p-3 mb-3">
                  <div className="text-sm font-bold text-emerald-900">
                    ✓ {result.nbEntrepots} entrepôts · {result.nbClientsRayon} clients dans {result.rayonKm} km · {result.totalDemande} vélos demandés
                  </div>
                  <div className="text-xs text-emerald-800 mt-1">
                    Stock cible total recommandé : <strong className="text-orange-700">{result.totalCibleCartons} cartons</strong> + <strong className="text-emerald-700">{result.totalCibleMontes} montés</strong>
                  </div>
                </div>
                <div className="space-y-2">
                  {result.entrepots.map((e) => (
                    <div key={e.entrepotId} className="border rounded-lg overflow-hidden">
                      <div className="bg-gray-50 border-b px-3 py-2 flex items-center justify-between">
                        <div>
                          <div className="text-sm font-bold">{e.nom}</div>
                          <div className="text-[11px] text-gray-500">{e.ville}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-bold text-gray-900">{e.demande.nbClients} clients</div>
                          <div className="text-[10px] text-gray-500">{e.demande.totale} vélos demandés</div>
                        </div>
                      </div>
                      <div className="p-3 grid grid-cols-3 gap-2 text-xs">
                        <div className="bg-orange-50 border border-orange-200 rounded p-2">
                          <div className="text-[10px] text-orange-700 uppercase font-semibold">Cartons (gros vol.)</div>
                          <div className="flex items-baseline gap-1 mt-1">
                            <span className="text-base font-bold text-orange-900">{e.cible.cartons}</span>
                            <span className="text-[10px] text-gray-500">/ {e.stockActuel.cartons} actuel</span>
                          </div>
                          {e.ecart.cartons > 0 && (
                            <div className="text-[10px] text-red-700 font-semibold mt-0.5">↑ +{e.ecart.cartons} à approvisionner</div>
                          )}
                          {e.ecart.cartons < 0 && (
                            <div className="text-[10px] text-emerald-700 mt-0.5">↓ {Math.abs(e.ecart.cartons)} en surstock</div>
                          )}
                          <div className="text-[10px] text-gray-500 mt-1">{e.demande.nbGros} clients &gt; {result.seuilGrosVolume}v</div>
                        </div>
                        <div className="bg-emerald-50 border border-emerald-200 rounded p-2">
                          <div className="text-[10px] text-emerald-700 uppercase font-semibold">Montés (petits vol.)</div>
                          <div className="flex items-baseline gap-1 mt-1">
                            <span className="text-base font-bold text-emerald-900">{e.cible.montes}</span>
                            <span className="text-[10px] text-gray-500">/ {e.stockActuel.montes} actuel</span>
                          </div>
                          {e.ecart.montes > 0 && (
                            <div className="text-[10px] text-red-700 font-semibold mt-0.5">↑ +{e.ecart.montes} à monter</div>
                          )}
                          {e.ecart.montes < 0 && (
                            <div className="text-[10px] text-emerald-700 mt-0.5">↓ {Math.abs(e.ecart.montes)} en surstock</div>
                          )}
                          <div className="text-[10px] text-gray-500 mt-1">{e.demande.nbPetits} clients ≤ {result.seuilGrosVolume}v</div>
                        </div>
                        <div className="bg-gray-100 border rounded p-2">
                          <div className="text-[10px] text-gray-700 uppercase font-semibold">Total cible</div>
                          <div className="flex items-baseline gap-1 mt-1">
                            <span className="text-base font-bold">{e.cible.total}</span>
                            <span className="text-[10px] text-gray-500">/ {e.stockActuel.total} actuel</span>
                          </div>
                          {e.capaciteAtteinte && e.capaciteMax != null && (
                            <div className="text-[10px] text-red-700 font-semibold mt-0.5">⚠️ &gt; capacité ({e.capaciteMax}v)</div>
                          )}
                          <div className="text-[10px] text-gray-500 mt-1">buffer {e.cible.buffer}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 text-[11px] text-gray-500 italic">
                  💡 Voronoi simple : chaque client est attribué à l entrepôt le + proche (Haversine vol d oiseau). Préférence Yoann : montés pour petits volumes (≤ {result.seuilGrosVolume}v), cartons pour gros volumes (montage chez client). Buffer +10% pour absorber les imprévus.
                </div>
              </>
            ) : (
              <div className="text-sm text-gray-500 italic">Aucun résultat</div>
            )}
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <button onClick={onClose} className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50">Fermer</button>
        </div>
      </div>
    </div>
  );
}

// FlotteModal — Yoann 2026-05-03
// Gestion CRUD des camions de la flotte (collection flotte). Permet
// d ajouter / éditer / désactiver sans passer par Firestore console.
type CamionFlotte = {
  id: string;
  nom: string;
  type: string;
  capaciteCartons: number;
  capaciteVelosMontes: number;
  peutEntrerParis: boolean;
  actif: boolean;
  notes: string;
};

function FlotteModal({ onClose }: { onClose: () => void }) {
  const [camions, setCamions] = useState<CamionFlotte[]>([]);
  const [editing, setEditing] = useState<CamionFlotte | "new" | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const { collection, onSnapshot } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      const unsub = onSnapshot(collection(db, "flotte"), (snap) => {
        if (!alive) return;
        const rows: CamionFlotte[] = [];
        for (const d of snap.docs) {
          const data = d.data();
          rows.push({
            id: d.id,
            nom: String(data.nom || ""),
            type: String(data.type || "moyen"),
            capaciteCartons: Number(data.capaciteCartons || data.capaciteVelos || 0),
            capaciteVelosMontes: Number(data.capaciteVelosMontes || 0),
            peutEntrerParis: data.peutEntrerParis === true,
            actif: data.actif !== false,
            notes: String(data.notes || ""),
          });
        }
        rows.sort((a, b) => a.nom.localeCompare(b.nom));
        setCamions(rows);
      });
      return () => unsub();
    })();
    return () => { alive = false; };
  }, []);
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[2000] p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-3xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-3">
          <div>
            <h2 className="text-lg font-semibold">🚛 Flotte de camions</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Capacités utilisées pour les tournées (cartons et vélos montés). Toggle Paris pour les contraintes poids lourd.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>
        <div className="space-y-2">
          {camions.map((c) => (
            <div key={c.id} className={`border rounded p-3 ${c.actif ? "" : "opacity-50 bg-gray-50"}`}>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="font-bold">
                    {c.peutEntrerParis ? "🚐" : "🚛"} {c.nom} <span className="text-xs font-normal text-gray-500">({c.type})</span>
                    {!c.actif && <span className="ml-2 text-[10px] px-1.5 py-0.5 bg-gray-200 rounded">inactif</span>}
                  </div>
                  <div className="text-xs text-gray-600 mt-0.5">
                    📦 {c.capaciteCartons} cartons · 🔧 {c.capaciteVelosMontes} montés ·{" "}
                    {c.peutEntrerParis ? "✅ Paris OK" : "❌ interdit Paris"}
                  </div>
                  {c.notes && <div className="text-[11px] text-gray-500 italic mt-1">{c.notes}</div>}
                </div>
                <button
                  onClick={() => setEditing(c)}
                  className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded"
                >
                  ✏️ Modifier
                </button>
              </div>
            </div>
          ))}
          {camions.length === 0 && (
            <div className="text-sm text-gray-400 italic text-center py-6">Aucun camion configuré.</div>
          )}
        </div>
        <div className="mt-4 flex justify-between gap-2">
          <button
            onClick={() => setEditing("new")}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 font-semibold"
          >
            + Nouveau camion
          </button>
          <button onClick={onClose} className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50">Fermer</button>
        </div>
      </div>
      {editing && (
        <CamionEditModal
          camion={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function CamionEditModal({ camion, onClose }: { camion: CamionFlotte | null; onClose: () => void }) {
  const [nom, setNom] = useState(camion?.nom || "");
  const [type, setType] = useState(camion?.type || "moyen");
  const [capaciteCartons, setCapaciteCartons] = useState(String(camion?.capaciteCartons || ""));
  const [capaciteVelosMontes, setCapaciteVelosMontes] = useState(String(camion?.capaciteVelosMontes || ""));
  const [peutEntrerParis, setPeutEntrerParis] = useState(camion?.peutEntrerParis ?? true);
  const [actif, setActif] = useState(camion?.actif ?? true);
  const [notes, setNotes] = useState(camion?.notes || "");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!nom.trim()) {
      alert("Nom obligatoire");
      return;
    }
    setBusy(true);
    try {
      const { collection, addDoc, doc, setDoc, serverTimestamp } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      const cc = parseInt(capaciteCartons, 10) || 0;
      const cm = parseInt(capaciteVelosMontes, 10) || 0;
      const payload = {
        nom: nom.trim(),
        type,
        capaciteCartons: cc,
        capaciteVelosMontes: cm,
        capaciteVelos: Math.max(cc, cm), // legacy field
        peutEntrerParis,
        actif,
        notes: notes.trim() || null,
        updatedAt: serverTimestamp(),
      };
      if (camion?.id) {
        await setDoc(doc(db, "flotte", camion.id), payload, { merge: true });
      } else {
        await addDoc(collection(db, "flotte"), { ...payload, createdAt: serverTimestamp() });
      }
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[2100] p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-3">
          {camion?.id ? `✏️ ${camion.nom}` : "+ Nouveau camion"}
        </h2>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-600">Nom</label>
            <input
              type="text"
              value={nom}
              onChange={(e) => setNom(e.target.value)}
              placeholder="Ex: Petit camion · Grand camion"
              className="w-full px-2 py-1.5 border rounded text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Type</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="w-full px-2 py-1.5 border rounded text-sm bg-white"
            >
              <option value="petit">Petit</option>
              <option value="moyen">Moyen</option>
              <option value="gros">Gros</option>
              <option value="camionnette">Camionnette</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-600">📦 Capacité cartons</label>
              <input
                type="number"
                value={capaciteCartons}
                onChange={(e) => setCapaciteCartons(e.target.value)}
                placeholder="Ex: 77"
                className="w-full px-2 py-1.5 border rounded text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-gray-600">🔧 Capacité montés</label>
              <input
                type="number"
                value={capaciteVelosMontes}
                onChange={(e) => setCapaciteVelosMontes(e.target.value)}
                placeholder="Ex: 40"
                className="w-full px-2 py-1.5 border rounded text-sm"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={peutEntrerParis}
              onChange={(e) => setPeutEntrerParis(e.target.checked)}
            />
            <span className="text-sm">✅ Peut entrer dans Paris (et petites rues)</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={actif}
              onChange={(e) => setActif(e.target.checked)}
            />
            <span className="text-sm">Camion actif (utilisé dans les tournées)</span>
          </label>
          <div>
            <label className="text-xs text-gray-600">Notes</label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Ex: POIDS LOURD restrictions Paris"
              className="w-full px-2 py-1.5 border rounded text-sm"
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50">Annuler</button>
          <button
            onClick={submit}
            disabled={busy || !nom.trim()}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 font-semibold"
          >
            {busy ? "..." : "✓ Sauvegarder"}
          </button>
        </div>
      </div>
    </div>
  );
}

// SimulationOperationModal — Yoann 2026-05-03
// Simulation macro 1 clic : tous clients dans 130km Paris → calcul stock
// cible par entrepôt + nb tournées requises + nb jours pour livrer le tout
// avec la flotte et l équipe disponibles.
type SimulationResult = {
  ok?: boolean;
  error?: string;
  rayonKm?: number;
  seuilGrosVolume?: number;
  nbEntrepots?: number;
  nbCamions?: number;
  nbChauffeurs?: number;
  nbVehiculesParJour?: number;
  capMontesMoyenne?: number;
  capCartonsMoyenne?: number;
  totalClients?: number;
  totalVelos?: number;
  totalTournees?: number;
  totalTourneesMontes?: number;
  totalTourneesCartons?: number;
  joursEstimes?: number;
  joursPourMontes?: number;
  joursPourCartons?: number;
  totalCibleCartons?: number;
  totalCibleMontes?: number;
  entrepots?: Array<{
    entrepotId: string;
    nom: string;
    ville: string;
    stockActuel: { cartons: number; montes: number; total: number };
    cibleStock: { cartons: number; montes: number; total: number };
    ecartStock: { cartons: number; montes: number };
    demande: { totale: number; grosVolumes: number; petitsVolumes: number; nbClients: number; nbClientsParis: number };
    tournees: { montes: number; cartons: number; total: number };
  }>;
};

function SimulationOperationModal({ onClose }: { onClose: () => void }) {
  const [rayonKm, setRayonKm] = useState(130);
  const [seuilGrosVolume, setSeuilGrosVolume] = useState(30);
  const [nbChauffeurs, setNbChauffeurs] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SimulationResult | null>(null);
  // Yoann 2026-05-03 : sélection précise des camions à utiliser pour cette
  // simulation (au lieu d utiliser la moyenne de toute la flotte active).
  type CamionMini = { id: string; nom: string; capaciteCartons: number; capaciteVelosMontes: number; peutEntrerParis: boolean };
  const [camionsFlotte, setCamionsFlotte] = useState<CamionMini[]>([]);
  const [camionIdsSelectionnes, setCamionIdsSelectionnes] = useState<Set<string>>(new Set());
  // Génération planning (mode + dates de range)
  const [showGenererPlanning, setShowGenererPlanning] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { collection, getDocs } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      const snap = await getDocs(collection(db, "flotte"));
      if (!alive) return;
      const rows: CamionMini[] = [];
      const initialSel = new Set<string>();
      for (const d of snap.docs) {
        const o = d.data() as { nom?: string; capaciteCartons?: number; capaciteVelosMontes?: number; capaciteVelos?: number; peutEntrerParis?: boolean; actif?: boolean };
        if (o.actif === false) continue;
        rows.push({
          id: d.id,
          nom: String(o.nom || ""),
          capaciteCartons: Number(o.capaciteCartons || o.capaciteVelos || 50),
          capaciteVelosMontes: Number(o.capaciteVelosMontes || 25),
          peutEntrerParis: o.peutEntrerParis === true,
        });
        initialSel.add(d.id);
      }
      setCamionsFlotte(rows);
      setCamionIdsSelectionnes(initialSel);
    })();
    return () => { alive = false; };
  }, []);

  const toggleCamion = (id: string) => {
    setCamionIdsSelectionnes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const { gasPost } = await import("@/lib/gas");
      const r = (await gasPost("simulationOperationComplete", {
        rayonKm,
        seuilGrosVolume,
        nbChauffeurs: nbChauffeurs === "" ? undefined : nbChauffeurs,
        camionIds: Array.from(camionIdsSelectionnes),
      })) as SimulationResult;
      setResult(r);
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[2000] p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-4xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-3">
          <div>
            <h2 className="text-lg font-semibold">🚀 Simulation Opération Paris</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              En 1 clic : pour tous les clients dans le rayon, calcule stock cible par entrepôt + nb tournées requises + nb jours pour boucler l opération avec ta flotte et ton équipe actuelles.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>

        <div className="grid grid-cols-3 gap-3 mb-3 bg-violet-50 border border-violet-200 rounded p-3">
          <div>
            <label className="text-xs text-gray-600">Rayon Paris (km)</label>
            <input
              type="number"
              value={rayonKm}
              onChange={(e) => setRayonKm(Number(e.target.value))}
              min={5}
              max={500}
              step={10}
              className="w-full px-2 py-1.5 border rounded text-sm bg-white"
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Seuil gros vol. (vélos)</label>
            <input
              type="number"
              value={seuilGrosVolume}
              onChange={(e) => setSeuilGrosVolume(Number(e.target.value))}
              min={5}
              max={200}
              className="w-full px-2 py-1.5 border rounded text-sm bg-white"
            />
            <div className="text-[10px] text-gray-500 mt-0.5">{seuilGrosVolume}v+ = cartons (montage chez client)</div>
          </div>
          <div>
            <label className="text-xs text-gray-600">Nb chauffeurs (override)</label>
            <input
              type="number"
              value={nbChauffeurs}
              onChange={(e) => setNbChauffeurs(e.target.value === "" ? "" : Number(e.target.value))}
              placeholder="auto = équipe Firestore"
              min={0}
              max={20}
              className="w-full px-2 py-1.5 border rounded text-sm bg-white"
            />
          </div>
        </div>

        {/* Yoann 2026-05-03 : sélecteur camions précis */}
        {camionsFlotte.length > 0 && (
          <div className="mb-3 bg-slate-50 border border-slate-200 rounded p-3">
            <div className="text-xs font-semibold text-slate-700 mb-2">
              🚛 Camions à utiliser ({camionIdsSelectionnes.size} sélectionnés sur {camionsFlotte.length})
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {camionsFlotte.map((c) => {
                const sel = camionIdsSelectionnes.has(c.id);
                return (
                  <label
                    key={c.id}
                    className={`flex items-center gap-2 p-2 rounded border cursor-pointer ${sel ? "bg-violet-50 border-violet-300" : "bg-white border-gray-200 hover:bg-gray-50"}`}
                  >
                    <input
                      type="checkbox"
                      checked={sel}
                      onChange={() => toggleCamion(c.id)}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold truncate">
                        {c.peutEntrerParis ? "🚐" : "🚛"} {c.nom}
                      </div>
                      <div className="text-[10px] text-gray-600">
                        📦 {c.capaciteCartons} cartons · 🔧 {c.capaciteVelosMontes} montés ·{" "}
                        {c.peutEntrerParis ? "Paris OK" : "❌ Paris"}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        <button
          onClick={run}
          disabled={busy || camionIdsSelectionnes.size === 0}
          className="w-full px-3 py-2 bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white rounded-lg hover:opacity-90 disabled:opacity-50 font-semibold"
        >
          {busy ? "🚀 Simulation..." : `🚀 Lancer la simulation complète (${camionIdsSelectionnes.size} camion${camionIdsSelectionnes.size > 1 ? "s" : ""})`}
        </button>

        {result && (
          <div className="mt-4">
            {result.error ? (
              <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-800">❌ {result.error}</div>
            ) : result.ok && result.entrepots ? (
              <>
                {/* Synthèse globale */}
                <div className="bg-gradient-to-r from-violet-50 to-fuchsia-50 border-2 border-violet-300 rounded-lg p-4 mb-4">
                  <div className="text-base font-bold text-violet-900 mb-2">
                    📊 Synthèse · {result.totalClients} clients dans {result.rayonKm} km
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <div className="bg-white border border-violet-200 rounded p-2 text-center">
                      <div className="text-2xl font-bold text-violet-900">{result.totalVelos}</div>
                      <div className="text-[10px] uppercase text-violet-600">Vélos à livrer</div>
                    </div>
                    <div className="bg-white border border-fuchsia-200 rounded p-2 text-center">
                      <div className="text-2xl font-bold text-fuchsia-900">{result.totalTournees}</div>
                      <div className="text-[10px] uppercase text-fuchsia-600">Tournées totales</div>
                      <div className="text-[9px] text-gray-500 mt-0.5">{result.totalTourneesMontes} montés · {result.totalTourneesCartons} cartons</div>
                    </div>
                    <div className="bg-white border border-blue-200 rounded p-2 text-center">
                      <div className="text-2xl font-bold text-blue-900">{result.joursEstimes}</div>
                      <div className="text-[10px] uppercase text-blue-600">Jours estimés</div>
                      <div className="text-[9px] text-gray-500 mt-0.5">avec {result.nbVehiculesParJour} véh./jour</div>
                    </div>
                    <div className="bg-white border border-emerald-200 rounded p-2 text-center">
                      <div className="text-2xl font-bold text-emerald-900">
                        {result.totalCibleCartons! + result.totalCibleMontes!}
                      </div>
                      <div className="text-[10px] uppercase text-emerald-600">Stock total cible</div>
                      <div className="text-[9px] text-gray-500 mt-0.5">
                        {result.totalCibleCartons} cartons + {result.totalCibleMontes} montés
                      </div>
                    </div>
                  </div>
                  <div className="text-[11px] text-violet-700 mt-2 italic">
                    💡 {result.nbChauffeurs} chauffeur{(result.nbChauffeurs ?? 0) > 1 ? "s" : ""} · {result.nbCamions} camion{(result.nbCamions ?? 0) > 1 ? "s" : ""}.
                    Capacités moyennes : {result.capMontesMoyenne}v montés / {result.capCartonsMoyenne}v cartons.
                    Hypothèse : 1 véh. = ~1.5 tournée montés/jour OU 1 tournée cartons/jour.
                  </div>
                </div>

                {/* Détail par entrepôt */}
                <div className="space-y-2">
                  {result.entrepots.map((e) => (
                    <div key={e.entrepotId} className="border rounded-lg overflow-hidden">
                      <div className="bg-gray-50 border-b px-3 py-2 flex items-center justify-between">
                        <div>
                          <div className="text-sm font-bold">{e.nom}</div>
                          <div className="text-[11px] text-gray-500">{e.ville}{e.demande.nbClientsParis > 0 ? ` · ${e.demande.nbClientsParis} client${e.demande.nbClientsParis > 1 ? "s" : ""} Paris ⚠️` : ""}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-bold">{e.demande.nbClients} clients · {e.demande.totale}v</div>
                          <div className="text-[10px] text-gray-500">
                            <strong>{e.tournees.total} tournées</strong> ({e.tournees.montes}m + {e.tournees.cartons}c)
                          </div>
                        </div>
                      </div>
                      <div className="p-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                        <div className="bg-orange-50 border border-orange-200 rounded p-2">
                          <div className="text-[9px] text-orange-700 uppercase font-semibold">Cartons cible</div>
                          <div className="text-base font-bold text-orange-900 mt-0.5">{e.cibleStock.cartons}</div>
                          <div className="text-[10px] text-gray-500">/ {e.stockActuel.cartons} actuel</div>
                          {e.ecartStock.cartons > 0 && <div className="text-[10px] text-red-700 font-semibold">↑ +{e.ecartStock.cartons}</div>}
                        </div>
                        <div className="bg-emerald-50 border border-emerald-200 rounded p-2">
                          <div className="text-[9px] text-emerald-700 uppercase font-semibold">Montés cible</div>
                          <div className="text-base font-bold text-emerald-900 mt-0.5">{e.cibleStock.montes}</div>
                          <div className="text-[10px] text-gray-500">/ {e.stockActuel.montes} actuel</div>
                          {e.ecartStock.montes > 0 && <div className="text-[10px] text-red-700 font-semibold">↑ +{e.ecartStock.montes} à monter</div>}
                        </div>
                        <div className="bg-fuchsia-50 border border-fuchsia-200 rounded p-2">
                          <div className="text-[9px] text-fuchsia-700 uppercase font-semibold">Tournées</div>
                          <div className="text-base font-bold text-fuchsia-900 mt-0.5">{e.tournees.total}</div>
                          <div className="text-[10px] text-gray-500">{e.tournees.montes}m · {e.tournees.cartons}c</div>
                        </div>
                        <div className="bg-blue-50 border border-blue-200 rounded p-2">
                          <div className="text-[9px] text-blue-700 uppercase font-semibold">Demande</div>
                          <div className="text-base font-bold text-blue-900 mt-0.5">{e.demande.totale}v</div>
                          <div className="text-[10px] text-gray-500">{e.demande.petitsVolumes}m + {e.demande.grosVolumes}c</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Yoann 2026-05-03 : bouton Générer planning depuis simulation */}
                <div className="mt-3 bg-gradient-to-r from-emerald-50 to-teal-50 border-2 border-emerald-300 rounded-lg p-3 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-bold text-emerald-900">📅 Générer le planning automatiquement</div>
                    <div className="text-[11px] text-emerald-800 mt-0.5">
                      Crée les vraies tournées dans /livraisons sur les dates que tu choisis (semaine par semaine, jour par jour, etc.).
                    </div>
                  </div>
                  <button
                    onClick={() => setShowGenererPlanning(true)}
                    className="shrink-0 px-3 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 font-semibold text-sm"
                  >
                    📅 Générer planning
                  </button>
                </div>

                <div className="mt-3 text-[11px] text-gray-500 italic">
                  💡 Voronoi : chaque client → entrepôt le + proche. Volumes &gt; {result.seuilGrosVolume}v → cartons (gros, montage chez client) ; sinon montés (rapide). Hypothèse capacités moyennes flotte.
                </div>
              </>
            ) : (
              <div className="text-sm text-gray-500 italic">Aucun résultat</div>
            )}
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <button onClick={onClose} className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50">Fermer</button>
        </div>
      </div>
      {showGenererPlanning && result?.ok && (
        <GenererPlanningModal
          rayonKm={rayonKm}
          seuilGrosVolume={seuilGrosVolume}
          camionIds={Array.from(camionIdsSelectionnes)}
          nbChauffeurs={nbChauffeurs === "" ? null : nbChauffeurs}
          onClose={() => setShowGenererPlanning(false)}
        />
      )}
    </div>
  );
}

// GenererPlanningModal — Yoann 2026-05-03
// Sélection multi-dates + génération en mode preview puis apply.
// Permet de planifier semaine par semaine, jour par jour, ou range custom.
type GenererPlanningProps = {
  rayonKm: number;
  seuilGrosVolume: number;
  camionIds: string[];
  nbChauffeurs: number | null;
  onClose: () => void;
};
type PlanningStop = { clientId: string; entreprise: string; nbVelos: number; ville: string; estParis: boolean };
type PlanningTournee = {
  entrepotId: string;
  entrepotNom: string;
  modeMontage: "atelier" | "client";
  camionId: string;
  camionNom: string;
  capacite: number;
  totalVelos: number;
  nbStops: number;
  monteursRequis?: number;
  stops: PlanningStop[];
};
type PlanningJour = {
  date: string;
  nbTournees: number;
  totalVelos: number;
  nbSlotsCartons?: number;
  velosCartonsJour?: number;
  nbMonteursRequisJour?: number;
  tournees: PlanningTournee[];
};
type ClientMultiCamion = {
  clientId: string;
  entreprise: string;
  ville: string;
  reste: number;
};
type TransfertSuggere = {
  deEntrepotId: string;
  deEntrepotNom: string;
  versEntrepotId: string;
  versEntrepotNom: string;
  type: "carton" | "monte";
  quantite: number;
  distanceKm: number;
  beneficeJours: number;
};
type ReapproEntrepot = {
  entrepotId: string;
  entrepotNom: string;
  stockInitialCartons: number;
  stockInitialMontes: number;
  consommationCartons: number;
  consommationMontes: number;
  stockApresCartons: number;
  stockApresMontes: number;
  besoinReapproCartons: number;
  besoinReapproMontes: number;
  dateLimiteReapproCartons: string | null;
  dateLimiteReapproMontes: string | null;
};
type CamionUtilise = {
  id: string;
  nom: string;
  capaciteCartons: number;
  capaciteVelosMontes: number;
  peutEntrerParis: boolean;
};
type ClientBloque = {
  clientId: string;
  entreprise: string;
  ville: string;
  reste: number;
  modeRequis: "atelier" | "client";
  entrepotPrevu: string;
};
type GenererPlanningResult = {
  ok?: boolean;
  error?: string;
  apply?: boolean;
  nbTotalSlots?: number;
  nbSlotsPlanifies?: number;
  nbSlotsNonPlanifies?: number;
  capaciteTotaleJournees?: number;
  tourneesParJour?: number;
  nbVehiculesParJour?: number;
  totalTourneesPlanifiees?: number;
  totalVelosPlanifies?: number;
  tourneesCreees?: number;
  livraisonsCreees?: number;
  erreurs?: string[];
  camionsUtilises?: CamionUtilise[];
  reappros?: ReapproEntrepot[];
  transferts?: TransfertSuggere[];
  clientsBloques?: ClientBloque[];
  clientsMultiCamion?: ClientMultiCamion[];
  capaMaxMontes?: number;
  capaMaxCartons?: number;
  leadTimeJours?: number;
  tourneesParVehMontes?: number;
  tourneesParVehCartons?: number;
  ratioMontes?: number;
  dates?: string[];
  planning?: PlanningJour[];
};

function GenererPlanningModal({ rayonKm, seuilGrosVolume, camionIds, nbChauffeurs, onClose }: GenererPlanningProps) {
  // Date picker multi-dates : 1 input liste les dates sélectionnées.
  // Helpers pour preset Aujourd hui / Cette semaine / Semaine prochaine.
  const todayIso = () => {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  };
  const startOfWeekIso = (offset = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + offset * 7);
    const day = d.getDay() || 7; // lundi=1, dimanche=7
    d.setDate(d.getDate() - (day - 1));
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  };
  const addDays = (iso: string, n: number) => {
    const d = new Date(iso);
    d.setDate(d.getDate() + n);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  };
  const [dates, setDates] = useState<Set<string>>(() => new Set([todayIso()]));
  const [leadTimeJours, setLeadTimeJours] = useState(3); // Yoann 2026-05-03 : Tiffany livre en ~3j
  const [datePicker, setDatePicker] = useState(todayIso());

  const presetCetteSemaine = () => {
    const start = startOfWeekIso(0);
    const newSet = new Set<string>();
    for (let i = 0; i < 5; i++) newSet.add(addDays(start, i)); // lun-ven
    setDates(newSet);
  };
  const presetSemaineProchaine = () => {
    const start = startOfWeekIso(1);
    const newSet = new Set<string>();
    for (let i = 0; i < 5; i++) newSet.add(addDays(start, i));
    setDates(newSet);
  };
  const addDate = () => {
    if (datePicker) setDates((prev) => new Set([...prev, datePicker]));
  };
  const removeDate = (d: string) => {
    setDates((prev) => {
      const n = new Set(prev);
      n.delete(d);
      return n;
    });
  };

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GenererPlanningResult | null>(null);

  const run = async (apply: boolean) => {
    if (dates.size === 0) {
      alert("Sélectionne au moins 1 date");
      return;
    }
    if (apply) {
      if (!confirm(`Créer ${result?.totalTourneesPlanifiees ?? "?"} tournées en base sur les dates sélectionnées ?\n\nLes livraisons seront créées en statut "planifiee" et visibles dans /livraisons.`)) return;
    }
    setBusy(true);
    if (!apply) setResult(null); // preview = remplace
    try {
      const { gasPost } = await import("@/lib/gas");
      const r = (await gasPost("genererPlanningOperation", {
        rayonKm,
        seuilGrosVolume,
        camionIds,
        nbChauffeurs: nbChauffeurs ?? undefined,
        leadTimeJours,
        dates: [...dates].sort(),
        apply,
      })) as GenererPlanningResult;
      setResult(r);
      if (apply && r.ok && r.tourneesCreees) {
        setTimeout(() => alert(`✓ ${r.tourneesCreees} tournées créées · ${r.livraisonsCreees} livraisons. Va sur /livraisons pour les voir.`), 100);
      }
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[2100] p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-4xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-3">
          <div>
            <h2 className="text-lg font-semibold">📅 Générer le planning</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Sélectionne les dates où tu veux générer les tournées (jour par jour, semaine par semaine, ou range custom).
              Mode preview d abord, apply explicite ensuite.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>

        {/* Sélecteur dates */}
        <div className="bg-emerald-50 border border-emerald-200 rounded p-3 mb-3">
          <div className="text-xs font-semibold text-emerald-900 mb-2">📅 Dates de planification ({dates.size} jour{dates.size > 1 ? "s" : ""})</div>
          <div className="flex flex-wrap gap-2 mb-2">
            <button
              onClick={() => setDates(new Set([todayIso()]))}
              className="px-2 py-1 text-[11px] bg-white border border-emerald-300 rounded hover:bg-emerald-100"
            >
              Aujourd&apos;hui
            </button>
            <button
              onClick={() => setDates(new Set([addDays(todayIso(), 1)]))}
              className="px-2 py-1 text-[11px] bg-white border border-emerald-300 rounded hover:bg-emerald-100"
            >
              Demain
            </button>
            <button
              onClick={presetCetteSemaine}
              className="px-2 py-1 text-[11px] bg-white border border-emerald-300 rounded hover:bg-emerald-100"
            >
              Cette semaine (lun-ven)
            </button>
            <button
              onClick={presetSemaineProchaine}
              className="px-2 py-1 text-[11px] bg-white border border-emerald-300 rounded hover:bg-emerald-100"
            >
              Semaine prochaine
            </button>
            <button
              onClick={() => setDates(new Set())}
              className="px-2 py-1 text-[11px] bg-rose-50 border border-rose-300 rounded hover:bg-rose-100 text-rose-700"
            >
              Tout effacer
            </button>
          </div>
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <input
              type="date"
              value={datePicker}
              onChange={(e) => setDatePicker(e.target.value)}
              className="px-2 py-1.5 border rounded text-sm"
            />
            <button
              onClick={addDate}
              className="px-2 py-1.5 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-700"
            >
              + Ajouter
            </button>
            <div className="ml-auto flex items-center gap-1 text-xs text-gray-700">
              <label htmlFor="leadtime" title="Délai entre commande Tiffany et arrivée en stock (utilisé pour calculer la date limite de commande)">
                ⏱ Lead time Tiffany :
              </label>
              <input
                id="leadtime"
                type="number"
                value={leadTimeJours}
                onChange={(e) => setLeadTimeJours(Number(e.target.value))}
                min={0}
                max={30}
                className="w-14 px-1 py-1 border rounded text-sm text-center"
              />
              <span className="text-gray-500">jours</span>
            </div>
          </div>
          {dates.size > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {[...dates].sort().map((d) => (
                <span
                  key={d}
                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-white border border-emerald-300 rounded text-[11px]"
                >
                  {d}
                  <button onClick={() => removeDate(d)} className="text-rose-500 hover:text-rose-700">×</button>
                </span>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={() => run(false)}
          disabled={busy || dates.size === 0}
          className="w-full px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-semibold mb-3"
        >
          {busy ? "🔍 Calcul..." : "🔍 Preview du planning (sans créer)"}
        </button>

        {result && (
          <div>
            {result.error ? (
              <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-800">❌ {result.error}</div>
            ) : result.ok && result.planning ? (
              <>
                <div className="bg-emerald-50 border border-emerald-300 rounded p-3 mb-3">
                  <div className="text-base font-bold text-emerald-900">
                    {result.apply ? "✓ Planning CRÉÉ" : "🔍 Preview"} · {result.totalTourneesPlanifiees} tournées · {result.totalVelosPlanifies} vélos
                  </div>
                  <div className="text-xs text-emerald-800 mt-1">
                    {result.dates?.length} jour{(result.dates?.length || 0) > 1 ? "s" : ""} · {result.tourneesParJour} tournées/jour ({result.nbVehiculesParJour} véh.) · capacité totale = {result.capaciteTotaleJournees} tournées
                  </div>
                  {result.ratioMontes != null && (
                    <div className="text-[11px] text-emerald-700 mt-0.5">
                      📊 Mix : {Math.round((result.ratioMontes ?? 0) * 100)}% montés (~{result.tourneesParVehMontes}/véh./j) · {Math.round((1 - (result.ratioMontes ?? 0)) * 100)}% cartons (~{result.tourneesParVehCartons}/véh./j)
                    </div>
                  )}
                  {(result.nbSlotsNonPlanifies ?? 0) > 0 && (
                    <div className="text-xs text-amber-800 mt-1 font-semibold">
                      ⚠️ {result.nbSlotsNonPlanifies} tournées non planifiées (manque de jours sélectionnés). Ajoute plus de dates ou plus de véhicules.
                    </div>
                  )}
                  {result.apply && result.tourneesCreees != null && (
                    <div className="text-xs text-emerald-900 mt-1 font-semibold">
                      ✓ {result.tourneesCreees} tournées et {result.livraisonsCreees} livraisons créées en base.
                    </div>
                  )}
                  {result.erreurs && result.erreurs.length > 0 && (
                    <div className="text-xs text-rose-800 mt-1">
                      Erreurs : {result.erreurs.join(" · ")}
                    </div>
                  )}
                  {result.camionsUtilises && result.camionsUtilises.length > 0 && (
                    <div className="text-[11px] text-emerald-700 mt-1">
                      🚛 {result.camionsUtilises.length} camion{result.camionsUtilises.length > 1 ? "s" : ""} utilisé{result.camionsUtilises.length > 1 ? "s" : ""} : {result.camionsUtilises.map((c) => `${c.peutEntrerParis ? "🚐" : "🚛"} ${c.nom}`).join(" · ")}
                    </div>
                  )}
                </div>

                {/* Yoann 2026-05-03 : suggestions réappro par entrepôt */}
                {result.reappros && result.reappros.length > 0 && (
                  <div className="bg-amber-50 border border-amber-300 rounded p-3 mb-3">
                    <div className="text-sm font-bold text-amber-900 mb-2">
                      📦 Recommandations stock par entrepôt
                    </div>
                    <div className="space-y-2">
                      {result.reappros.map((r) => {
                        const needsReappro = r.besoinReapproCartons > 0 || r.besoinReapproMontes > 0;
                        return (
                          <div
                            key={r.entrepotId}
                            className={`p-2 rounded border ${needsReappro ? "bg-rose-50 border-rose-200" : "bg-white border-gray-200"}`}
                          >
                            <div className="flex items-center justify-between gap-2 text-xs">
                              <div className="font-bold">{r.entrepotNom}</div>
                              <div className="text-gray-600">
                                Stock initial : 📦 {r.stockInitialCartons}c · 🔧 {r.stockInitialMontes}m
                              </div>
                            </div>
                            <div className="grid grid-cols-2 gap-2 mt-1 text-[10px]">
                              <div>
                                Conso cartons : <strong>{r.consommationCartons}</strong> → reste{" "}
                                <span className={r.stockApresCartons < 0 ? "text-rose-700 font-bold" : "text-emerald-700"}>
                                  {r.stockApresCartons}
                                </span>
                                {r.besoinReapproCartons > 0 && (
                                  <div className="text-rose-800 font-semibold">
                                    ⚠️ Commander Tiffany : <strong>+{r.besoinReapproCartons} cartons</strong>
                                    {r.dateLimiteReapproCartons && (
                                      <span> avant <strong>{r.dateLimiteReapproCartons}</strong></span>
                                    )}
                                  </div>
                                )}
                              </div>
                              <div>
                                Conso montés : <strong>{r.consommationMontes}</strong> → reste{" "}
                                <span className={r.stockApresMontes < 0 ? "text-rose-700 font-bold" : "text-emerald-700"}>
                                  {r.stockApresMontes}
                                </span>
                                {r.besoinReapproMontes > 0 && (
                                  <div className="text-rose-800 font-semibold">
                                    ⚠️ Monter en atelier : <strong>+{r.besoinReapproMontes} vélos</strong>
                                    {r.dateLimiteReapproMontes && (
                                      <span> avant <strong>{r.dateLimiteReapproMontes}</strong></span>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Yoann 2026-05-03 : suggestions équilibrage cross-dépôt */}
                {result.transferts && result.transferts.length > 0 && (
                  <div className="bg-cyan-50 border border-cyan-300 rounded p-3 mb-3">
                    <div className="text-sm font-bold text-cyan-900 mb-1">
                      💡 {result.transferts.length} transfert{result.transferts.length > 1 ? "s" : ""} cross-dépôt suggéré{result.transferts.length > 1 ? "s" : ""}
                    </div>
                    <div className="text-[11px] text-cyan-800 mb-2">
                      Plutôt que de commander Tiffany (lead time {result.leadTimeJours}j), un transfert depuis un entrepôt voisin avec stock résiduel comble la rupture immédiatement.
                    </div>
                    <div className="space-y-0.5 text-[11px]">
                      {result.transferts.map((t, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <span className="font-bold text-cyan-700">{t.quantite} {t.type === "carton" ? "📦 cartons" : "🔧 montés"}</span>
                          <span>{t.deEntrepotNom}</span>
                          <span className="text-cyan-500">→</span>
                          <span className="font-semibold">{t.versEntrepotNom}</span>
                          <span className="text-gray-500">({t.distanceKm} km)</span>
                          <span className="text-emerald-700 italic">économise {t.beneficeJours}j vs Tiffany</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Yoann 2026-05-03 : clients trop gros pour 1 seul camion (multi-camions parallèles requis) */}
                {result.clientsMultiCamion && result.clientsMultiCamion.length > 0 && (
                  <div className="bg-purple-50 border border-purple-300 rounded p-3 mb-3">
                    <div className="text-sm font-bold text-purple-900 mb-1">
                      🚚🚚 {result.clientsMultiCamion.length} client{result.clientsMultiCamion.length > 1 ? "s" : ""} nécessite{result.clientsMultiCamion.length > 1 ? "nt" : ""} 2 camions parallèles
                    </div>
                    <div className="text-[11px] text-purple-800 mb-1">
                      Volume &gt; capa max 1 camion ({result.capaMaxCartons}v en cartons). À planifier manuellement avec 2 camions le même jour. Mode cartons recommandé (capa supérieure aux montés).
                    </div>
                    <div className="space-y-0.5 text-[11px]">
                      {result.clientsMultiCamion.map((c) => (
                        <div key={c.clientId} className="flex items-center gap-2">
                          <a
                            href={`/clients/detail?id=${encodeURIComponent(c.clientId)}`}
                            target="_blank"
                            rel="noreferrer"
                            className="font-semibold hover:underline"
                          >
                            {c.entreprise}
                          </a>
                          <span className="text-gray-500">{c.ville}</span>
                          <span className="font-bold text-purple-700">{c.reste}v</span>
                          <span className="text-[10px] text-gray-500 italic">→ Prévoir 2 camions + monteurs sur place</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Yoann 2026-05-03 : clients non plannifiés faute de stock */}
                {result.clientsBloques && result.clientsBloques.length > 0 && (
                  <div className="bg-rose-50 border border-rose-300 rounded p-3 mb-3">
                    <div className="text-sm font-bold text-rose-900 mb-1">
                      ⚠️ {result.clientsBloques.length} client{result.clientsBloques.length > 1 ? "s" : ""} non plannifié{result.clientsBloques.length > 1 ? "s" : ""} faute de stock
                    </div>
                    <div className="text-[11px] text-rose-800 mb-2">
                      Stock actuel insuffisant pour les servir. Commande Tiffany {result.leadTimeJours ? `${result.leadTimeJours}j` : ""} avant la prochaine livraison prévue (voir dates limites ci-dessus).
                    </div>
                    <details className="text-[11px]">
                      <summary className="cursor-pointer text-rose-700 hover:underline">
                        Voir la liste détaillée
                      </summary>
                      <div className="mt-2 max-h-48 overflow-y-auto bg-white rounded border border-rose-200 divide-y">
                        {result.clientsBloques.map((c) => (
                          <div key={c.clientId} className="px-2 py-1 flex items-center gap-2 text-[11px]">
                            <span className="text-gray-500">
                              {c.modeRequis === "atelier" ? "🔧" : "📦"}
                            </span>
                            <a
                              href={`/clients/detail?id=${encodeURIComponent(c.clientId)}`}
                              target="_blank"
                              rel="noreferrer"
                              className="font-semibold hover:underline truncate flex-1"
                            >
                              {c.entreprise}
                            </a>
                            <span className="text-gray-500 text-[10px]">{c.ville}</span>
                            <span className="font-bold text-rose-700">{c.reste}v</span>
                            <span className="text-[10px] text-gray-500">→ {c.entrepotPrevu}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  </div>
                )}

                <div className="space-y-2">
                  {result.planning.map((j) => (
                    <div key={j.date} className="border rounded-lg overflow-hidden">
                      <div className="bg-gray-50 border-b px-3 py-2 flex items-center justify-between">
                        <div className="font-bold">{j.date}</div>
                        <div className="text-xs text-gray-600 flex flex-wrap gap-2 justify-end items-center">
                          <span>{j.nbTournees} tournée{j.nbTournees > 1 ? "s" : ""} · {j.totalVelos} vélos</span>
                          {(j.nbMonteursRequisJour ?? 0) > 0 && (
                            <span className="px-1.5 py-0.5 bg-amber-100 text-amber-900 rounded font-semibold">
                              🔧 {j.nbMonteursRequisJour} monteurs requis
                            </span>
                          )}
                        </div>
                      </div>
                      {j.tournees.length === 0 ? (
                        <div className="p-3 text-xs text-gray-400 italic">Pas de tournée ce jour-là.</div>
                      ) : (
                        <div className="divide-y">
                          {j.tournees.map((t, i) => (
                            <div key={i} className="p-2 text-xs flex items-start justify-between gap-2">
                              <div className="flex-1 min-w-0">
                                <div className="font-semibold truncate">
                                  {t.modeMontage === "atelier" ? "🔧" : "📦"} {t.entrepotNom} · {t.camionNom}
                                  <span className="text-gray-500 font-normal ml-1">({t.totalVelos}/{t.capacite}v · {t.nbStops} stops)</span>
                                </div>
                                <div className="text-[10px] text-gray-600 mt-0.5">
                                  {t.stops.slice(0, 5).map((s) => `${s.entreprise} (${s.nbVelos}v${s.estParis ? " ⚠️" : ""})`).join(" · ")}
                                  {t.stops.length > 5 ? ` … +${t.stops.length - 5}` : ""}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {!result.apply && result.totalTourneesPlanifiees != null && result.totalTourneesPlanifiees > 0 && (
                  <button
                    onClick={() => run(true)}
                    disabled={busy}
                    className="w-full mt-3 px-3 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 font-semibold"
                  >
                    {busy ? "Création..." : `✓ Créer le planning en base (${result.totalTourneesPlanifiees} tournées)`}
                  </button>
                )}
              </>
            ) : (
              <div className="text-sm text-gray-500 italic">Aucun résultat</div>
            )}
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <button onClick={onClose} className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50">Fermer</button>
        </div>
      </div>
    </div>
  );
}
