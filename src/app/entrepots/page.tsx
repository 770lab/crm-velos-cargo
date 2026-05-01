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
          <div className="flex gap-2">
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
                {isAdmin && (
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
      const { collection, addDoc, doc, setDoc, serverTimestamp } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      const sharedSource = `transformation-atelier-${Date.now()}`;
      const baseNotes = notes.trim() || `Atelier monte ${n} vélos`;
      // 1. Mouvement -N cartons
      await addDoc(collection(db, "entrepots", entrepotId, "mouvements"), {
        type: "carton",
        quantite: -n,
        date,
        source: sharedSource,
        notes: `${baseNotes} (cartons -> montés)`,
        createdAt: serverTimestamp(),
        autoCreated: false,
      });
      // 2. Mouvement +N montés
      await addDoc(collection(db, "entrepots", entrepotId, "mouvements"), {
        type: "monte",
        quantite: n,
        date,
        source: sharedSource,
        notes: `${baseNotes} (cartons -> montés)`,
        createdAt: serverTimestamp(),
        autoCreated: false,
      });
      // 3. Update stockCartons + stockVelosMontes en 1 transaction côté client
      const { getDoc } = await import("firebase/firestore");
      const eRef = doc(db, "entrepots", entrepotId);
      const cur = (await getDoc(eRef)).data() as Record<string, unknown>;
      const newCartons = Math.max(0, Number(cur?.stockCartons || 0) - n);
      const newMontes = Math.max(0, Number(cur?.stockVelosMontes || 0) + n);
      await setDoc(
        eRef,
        {
          stockCartons: newCartons,
          stockVelosMontes: newMontes,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-[80] p-4"
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
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-[80] p-4"
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
      // 2. Met à jour le stock dénormalisé sur le doc parent (somme cumulée).
      // Pour simplicité : on lit le stock actuel + q (FieldValue.increment
      // serait idéal mais nécessite import). Workaround : recalcul via setDoc
      // depuis la valeur connue au moment du clic.
      const field = kind === "carton" ? "stockCartons" : "stockVelosMontes";
      const eSnap = await import("firebase/firestore").then((m) => m.getDoc(doc(db, "entrepots", entrepotId)));
      const cur = Number((eSnap.data() as Record<string, unknown>)?.[field] || 0);
      await setDoc(
        doc(db, "entrepots", entrepotId),
        { [field]: Math.max(0, cur + q), updatedAt: serverTimestamp() },
        { merge: true },
      );
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
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-[80] p-4"
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

function SessionAtelierModal({
  entrepotId,
  entrepotNom,
  onClose,
}: {
  entrepotId: string;
  entrepotNom: string;
  onClose: () => void;
}) {
  type Member = { id: string; nom: string; role: string; chefId?: string | null; aussiMonteur?: boolean };
  const [equipe, setEquipe] = useState<Member[]>([]);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [chefId, setChefId] = useState("");
  const [monteurIds, setMonteurIds] = useState<string[]>([]);
  const [quantitePrevue, setQuantitePrevue] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
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
      const { collection, addDoc, serverTimestamp } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      const monteurNoms = monteurIds.map((id) => equipe.find((m) => m.id === id)?.nom || "?");
      const chef = chefs.find((c) => c.id === chefId);
      const q = quantitePrevue ? parseInt(quantitePrevue, 10) : null;
      await addDoc(collection(db, "sessionsMontageAtelier"), {
        entrepotId,
        entrepotNom,
        date,
        monteurIds,
        monteurNoms,
        chefId: chef?.id || null,
        chefNom: chef?.nom || null,
        quantitePrevue: q && q > 0 ? q : null,
        notes: notes.trim() || null,
        statut: "planifiee",
        createdAt: serverTimestamp(),
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
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[80] p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-3">
          <h2 className="text-lg font-semibold">+ Planifier session montage atelier</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>
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
          <div>
            <label className="text-xs text-gray-600">Quantité prévue (vélos à monter)</label>
            <input
              type="number"
              value={quantitePrevue}
              onChange={(e) => setQuantitePrevue(e.target.value)}
              placeholder="Ex: 100"
              className="w-full px-2 py-1.5 border rounded text-sm"
            />
          </div>
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
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50">Annuler</button>
          <button
            onClick={submit}
            disabled={busy || monteurIds.length === 0}
            className="px-3 py-1.5 text-sm bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50 font-semibold"
          >
            {busy ? "..." : "🔧 Planifier la session"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Panel "🤖 Suggérer tournée" sur chaque card entrepôt (Yoann 2026-05-01).
// Au clic, ouvre un modal qui appelle suggestTourneeFromEntrepot et
// affiche les clients optimaux à livrer depuis cet entrepôt.
function SuggererTourneePanel({
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
  const totalDispo = stockCartons + stockVelosMontes;
  return (
    <>
      <div className="flex items-center justify-between gap-2 bg-indigo-50 border border-indigo-200 rounded p-1.5">
        <div className="text-[11px] text-indigo-900 truncate">
          🤖 <strong>Suggérer une tournée</strong>
          <span className="opacity-70 ml-1">· {totalDispo} vélos dispo</span>
        </div>
        <button
          onClick={() => setShowModal(true)}
          disabled={totalDispo <= 0}
          className="px-2 py-0.5 text-[11px] bg-indigo-600 text-white rounded hover:bg-indigo-700 font-semibold disabled:opacity-50 shrink-0"
          title={totalDispo <= 0 ? "Aucun stock dispo dans cet entrepôt" : "L'IA propose les clients optimaux à livrer depuis cet entrepôt"}
        >
          🤖 Suggérer
        </button>
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
  stops?: SuggestionStop[];
  candidatsHorsTournee?: Array<{ id: string; entreprise: string; ville: string; distance: number; velosRestants: number }>;
};

function SuggererTourneeModal({
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
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[80] p-4" onClick={onClose}>
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
              <option value="gros">Grand (132 cartons / 40 montés)</option>
              <option value="moyen">Moyen (54 cartons / 30 montés)</option>
              <option value="petit">Petit (20)</option>
              <option value="camionnette">Camionnette (20)</option>
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
                      <span className="ml-2 text-emerald-700">· 🛣 {result.distanceTotaleKm} km total</span>
                    )}
                  </div>
                  <div className="text-xs text-emerald-800 mt-1">
                    Capacité camion {mode} ({modeMontage}) : {result.capaciteCamion} v ·
                    Capacité effective (limitée par stock) : <strong>{result.capaciteEffective} v</strong>
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
                  💡 Distance vol d&apos;oiseau (Haversine) + nearest-neighbor + 2-opt.
                  Distances réelles via Google Maps Directions à venir.
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
