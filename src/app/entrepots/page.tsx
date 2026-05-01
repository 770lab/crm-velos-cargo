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
          <button
            onClick={() => setEditing("new")}
            className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
          >
            + Nouvel entrepôt
          </button>
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
      <div className={`rounded-lg border p-3 ${colorClasses}`}>
        <div className="text-[11px] uppercase tracking-wide opacity-70 font-semibold">
          {label}
        </div>
        <div className="text-3xl font-bold mt-0.5 text-gray-900">{fmt(value)}</div>
        {editable && (
          <div className="mt-2 flex gap-1">
            <button
              onClick={() => setShowModal(true)}
              className="flex-1 px-2 py-1 bg-white border rounded text-xs hover:bg-gray-50 font-medium"
            >
              + Entrée
            </button>
            <button
              onClick={() => setShowHistory((v) => !v)}
              className="px-2 py-1 bg-white border rounded text-xs hover:bg-gray-50"
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
