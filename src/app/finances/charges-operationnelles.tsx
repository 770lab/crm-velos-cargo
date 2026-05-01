"use client";

import { useEffect, useMemo, useState } from "react";
import {
  collection,
  query,
  where,
  onSnapshot,
  addDoc,
  deleteDoc,
  doc,
  serverTimestamp,
  Timestamp,
  setDoc,
  getDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase";

// Référence prix par défaut (PDF Axdis 2026-04-28 : 385 € HT/vélo + 17,40 € HT
// éco-contribution = 402,40 € HT/vélo). Stocké en Firestore config/finances
// pour pouvoir évoluer sans déploiement.
const COUT_VELO_HT_DEFAULT = 402.4;
// Prix de vente TTC par vélo livré (Yoann 30-04 00h03 : 650 € TTC = 541,67 HT
// avec TVA 20%). Encaissements = vélos livrés × prix vente HT.
const PRIX_VENTE_VELO_TTC_DEFAULT = 650;
const TVA_RATE = 0.2;

export const CATEGORIES_FRAIS = {
  vehicules: {
    label: "Véhicules",
    color: "bg-blue-100 text-blue-800 border-blue-300",
    sousCats: ["Location camion", "Carburant", "Péages", "Entretien", "Assurance"],
  },
  personnel: {
    label: "Personnel",
    color: "bg-emerald-100 text-emerald-800 border-emerald-300",
    sousCats: ["Salaires", "Cotisations", "Tickets resto", "Formations", "Indé / sous-traitance"],
  },
  marketing: {
    label: "Marketing & commercial",
    color: "bg-purple-100 text-purple-800 border-purple-300",
    sousCats: ["Apporteur (commission)", "Publicité", "Salons"],
  },
  divers: {
    label: "Divers",
    color: "bg-gray-100 text-gray-800 border-gray-300",
    sousCats: ["Autre"],
  },
} as const;

type CatKey = keyof typeof CATEGORIES_FRAIS;

type Frais = {
  id: string;
  date: string; // YYYY-MM-DD
  categorie: CatKey;
  sousCategorie: string;
  libelle: string;
  montantHT: number;
  tournee?: string | null;
  createdAt?: number | null;
};

type BonRow = {
  id: string;
  dateDoc: string;
  numeroDoc: number | string;
  tourneeRef: string;
  quantite: number;
  fournisseur: string;
};

const fmt = (n: number) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(n || 0);

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export function ChargesOperationnellesSection({
  from,
  to,
  coutMainOeuvre = 0,
}: {
  from: string;
  to: string;
  /** Coût total main d'œuvre (salaires + primes + commissions apporteurs)
   * sur la période. Si fourni > 0, on affiche le coût total / vélo livré
   * incluant cette main d'œuvre (sinon on n'affiche que le coût hors masse
   * salariale comme avant). */
  coutMainOeuvre?: number;
}) {
  const [frais, setFrais] = useState<Frais[]>([]);
  const [bons, setBons] = useState<BonRow[]>([]);
  const [veloLivresCount, setVeloLivresCount] = useState(0);
  const [coutVeloHT, setCoutVeloHT] = useState<number>(COUT_VELO_HT_DEFAULT);
  const [prixVenteVeloTTC, setPrixVenteVeloTTC] = useState<number>(PRIX_VENTE_VELO_TTC_DEFAULT);
  const [showAdd, setShowAdd] = useState(false);
  const [editConfig, setEditConfig] = useState(false);
  const [editVente, setEditVente] = useState(false);

  // Charge la config (prix achat + prix vente) une fois.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await getDoc(doc(db, "config", "finances"));
        if (cancelled) return;
        const data = s.data() || {};
        if (typeof data.coutVeloHT === "number" && data.coutVeloHT > 0) setCoutVeloHT(data.coutVeloHT);
        if (typeof data.prixVenteVeloTTC === "number" && data.prixVenteVeloTTC > 0) setPrixVenteVeloTTC(data.prixVenteVeloTTC);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  // Subscribe frais sur la période.
  useEffect(() => {
    const q = query(
      collection(db, "frais"),
      where("date", ">=", from),
      where("date", "<=", to),
    );
    const unsub = onSnapshot(q, (snap) => {
      const rows: Frais[] = [];
      for (const d of snap.docs) {
        const data = d.data() as Record<string, unknown>;
        rows.push({
          id: d.id,
          date: String(data.date || ""),
          categorie: (data.categorie as CatKey) || "divers",
          sousCategorie: String(data.sousCategorie || ""),
          libelle: String(data.libelle || ""),
          montantHT: Number(data.montantHT || 0),
          tournee: typeof data.tournee === "string" ? data.tournee : null,
          createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toMillis() : null,
        });
      }
      rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      setFrais(rows);
    });
    return () => unsub();
  }, [from, to]);

  // Bons Tiffany sur la période (champ dateDoc en string YYYY-MM-DD).
  useEffect(() => {
    const q = query(
      collection(db, "bonsEnlevement"),
      where("dateDoc", ">=", from),
      where("dateDoc", "<=", to),
    );
    const unsub = onSnapshot(q, (snap) => {
      const rows: BonRow[] = [];
      for (const d of snap.docs) {
        const data = d.data() as Record<string, unknown>;
        rows.push({
          id: d.id,
          dateDoc: String(data.dateDoc || ""),
          numeroDoc: data.numeroDoc as number | string,
          tourneeRef: String(data.tourneeRef || ""),
          quantite: Number(data.quantite || 0),
          fournisseur: String(data.fournisseur || ""),
        });
      }
      rows.sort((a, b) => (a.dateDoc < b.dateDoc ? 1 : -1));
      setBons(rows);
    });
    return () => unsub();
  }, [from, to]);

  // Vélos livrés sur la période = collection velos avec dateLivraisonScan
  // dans [from, to]. Firestore ne permet pas un range Timestamp + un autre
  // index facile, mais on filtre côté client puisque le volume reste
  // raisonnable (~5k vélos total).
  useEffect(() => {
    const q = collection(db, "velos");
    const unsub = onSnapshot(q, (snap) => {
      let count = 0;
      const fromTs = new Date(`${from}T00:00:00`).getTime();
      const toTs = new Date(`${to}T23:59:59`).getTime();
      for (const d of snap.docs) {
        const data = d.data() as Record<string, unknown>;
        if (data.statut === "annule" || data.annule === true) continue;
        const dl = data.dateLivraisonScan;
        if (!dl) continue;
        const t = dl instanceof Timestamp ? dl.toMillis() : new Date(String(dl)).getTime();
        if (t >= fromTs && t <= toTs) count++;
      }
      setVeloLivresCount(count);
    });
    return () => unsub();
  }, [from, to]);

  // Achats commandés (cash sorti) = somme bons Tiffany de la période.
  const totalAchatsCommandes = bons.reduce((s, b) => s + b.quantite * coutVeloHT, 0);
  const totalAchatsCommandesQte = bons.reduce((s, b) => s + b.quantite, 0);
  // Coût des vélos LIVRÉS (économique, aligné avec encaissements de la période).
  // C'est ce qu'on utilise pour le calcul marge — sinon le coût/vélo livré
  // explose artificiellement quand on commande 47 vélos en 1 fois pour
  // n'en livrer que 13 dans le mois (Yoann 30-04 00h10).
  const coutVelosLivres = veloLivresCount * coutVeloHT;
  const totalFraisOps = frais.reduce((s, f) => s + f.montantHT, 0);
  const totalCharges = coutVelosLivres + totalFraisOps;
  // Coût LOGISTIQUE par vélo (Yoann 2026-05-01) = ce que coûte la livraison
  // d'un vélo, EXCLUDING le coût d'achat AXDIS du vélo lui-même.
  // = (frais ops camion/carburant/etc. + masse salariale équipe terrain
  //    + commissions apporteurs) / nombre de vélos livrés sur la période.
  // Exemple Yoann : 2 camions × 100 €/j + 5 chauffeurs × 100 € + 2 × 130 €
  //                 = 960 € / nb vélos livrés ce jour = coût logistique/vélo.
  const totalLogistique = totalFraisOps + coutMainOeuvre;
  const coutLogistiqueParVelo = veloLivresCount > 0 ? totalLogistique / veloLivresCount : 0;
  const prixVenteHT = prixVenteVeloTTC / (1 + TVA_RATE);
  const encaissementsHT = veloLivresCount * prixVenteHT;
  const margeBruteHT = encaissementsHT - totalCharges;
  const margeParVeloLivre = veloLivresCount > 0 ? margeBruteHT / veloLivresCount : 0;
  // Cash flow vélos = écart entre cash sorti et coût livré reconnu.
  // Si positif → on a payé d'avance pour livrer plus tard.
  const cashFlowVelos = totalAchatsCommandes - coutVelosLivres;

  // Agrégat par catégorie pour la répartition.
  const fraisParCat = useMemo(() => {
    const m: Record<string, number> = {};
    for (const f of frais) m[f.categorie] = (m[f.categorie] || 0) + f.montantHT;
    return m;
  }, [frais]);

  const removeFrais = async (id: string) => {
    if (!confirm("Supprimer ce frais ?")) return;
    await deleteDoc(doc(db, "frais", id));
  };

  const saveCoutVelo = async (val: number) => {
    setCoutVeloHT(val);
    await setDoc(doc(db, "config", "finances"), { coutVeloHT: val }, { merge: true });
    setEditConfig(false);
  };

  const savePrixVente = async (val: number) => {
    setPrixVenteVeloTTC(val);
    await setDoc(doc(db, "config", "finances"), { prixVenteVeloTTC: val }, { merge: true });
    setEditVente(false);
  };

  return (
    <>
      {/* KPIs charges - calcul économique (au prorata des vélos livrés) */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-3">
        <KpiCard label="Vélos livrés" value={String(veloLivresCount)} />
        <KpiCard
          label="Coût vélos livrés"
          value={fmt(coutVelosLivres)}
          accent="text-orange-700"
          hint={`${veloLivresCount} × ${fmt(coutVeloHT)}`}
        />
        <KpiCard
          label="Frais opérationnels"
          value={fmt(totalFraisOps)}
          accent="text-blue-700"
          hint="camion + carburant + etc."
        />
        <KpiCard
          label="Main d'œuvre"
          value={coutMainOeuvre > 0 ? fmt(coutMainOeuvre) : "—"}
          accent="text-indigo-700"
          hint="salaires + primes + apporteurs"
        />
        <KpiCard
          label="Coût logistique / vélo"
          value={coutMainOeuvre > 0 ? fmt(coutLogistiqueParVelo) : fmt(veloLivresCount > 0 ? totalFraisOps / veloLivresCount : 0)}
          accent="text-gray-900"
          hint={
            coutMainOeuvre > 0
              ? `${fmt(totalLogistique)} / ${veloLivresCount} vélos`
              : `${fmt(totalFraisOps)} / ${veloLivresCount} (sans main d'œuvre)`
          }
        />
      </div>

      {/* Total charges (hors masse salariale) en sous-titre — sert de
          référence pour la marge brute affichée plus bas. */}
      <div className="mb-3 text-[11px] text-gray-500 px-1">
        Total charges hors masse salariale (achats + frais ops) :{" "}
        <strong className="text-red-700">{fmt(totalCharges)}</strong>
        {coutMainOeuvre > 0 && (
          <>
            {" "}· Charges all-in (avec main d&apos;œuvre) :{" "}
            <strong className="text-red-800">{fmt(totalCharges + coutMainOeuvre)}</strong>
          </>
        )}
      </div>

      {/* Note pédagogique sur le calcul */}
      {totalAchatsCommandes > coutVelosLivres && (
        <div className="mb-3 px-3 py-2 rounded-lg border border-amber-200 bg-amber-50 text-[11px] text-amber-800 flex items-start gap-2">
          <span>ℹ️</span>
          <div className="flex-1">
            Cash sorti pour les vélos sur la période : <strong>{fmt(totalAchatsCommandes)}</strong>
            ({totalAchatsCommandesQte} vélos commandés à Axdis).
            Mais on ne reconnaît que <strong>{fmt(coutVelosLivres)}</strong> dans les charges
            ({veloLivresCount} vélos livrés × {fmt(coutVeloHT)}) — les
            <strong> {totalAchatsCommandesQte - veloLivresCount} vélos restants </strong>
            sont en stock et leur coût sera imputé quand ils seront livrés.
            Avance de trésorerie : <strong>{fmt(cashFlowVelos)}</strong>.
            <br />
            Le calcul de marge n&apos;intègre PAS la masse salariale tant qu&apos;elle
            n&apos;est pas saisie en pointeuse (section ci-dessous).
          </div>
        </div>
      )}

      {/* Bandeau Marge */}
      <div className={`mb-6 rounded-xl border p-4 flex items-center justify-between gap-3 ${
        margeBruteHT >= 0 ? "bg-emerald-50 border-emerald-200" : "bg-red-50 border-red-200"
      }`}>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wide font-semibold text-emerald-700">
            Marge brute (avant main d&apos;œuvre)
          </div>
          <div className={`text-3xl font-bold mt-0.5 ${margeBruteHT >= 0 ? "text-emerald-900" : "text-red-900"}`}>
            {fmt(margeBruteHT)}
          </div>
          <div className="text-[11px] text-gray-600 mt-1">
            Encaissements <strong>{fmt(encaissementsHT)}</strong> HT
            {" "}− charges <strong>{fmt(totalCharges)}</strong>
            {" "}· <strong>{fmt(margeParVeloLivre)}</strong> par vélo livré
          </div>
        </div>
        <div className="text-right text-[11px] text-gray-600">
          <div>Prix de vente :</div>
          {editVente ? (
            <input
              type="number"
              step="0.01"
              defaultValue={prixVenteVeloTTC}
              className="px-2 py-0.5 border rounded text-xs w-24 mt-1"
              onKeyDown={(e) => {
                if (e.key === "Enter") savePrixVente(Number((e.target as HTMLInputElement).value));
                if (e.key === "Escape") setEditVente(false);
              }}
              autoFocus
            />
          ) : (
            <button onClick={() => setEditVente(true)} className="hover:underline font-medium text-emerald-800">
              {fmt(prixVenteVeloTTC)} TTC<br />
              <span className="text-[10px] text-gray-500">{fmt(prixVenteHT)} HT · modifier</span>
            </button>
          )}
        </div>
      </div>

      {/* Achats vélos Axdis */}
      <div className="mb-6 bg-white rounded-xl border overflow-hidden">
        <div className="px-4 py-2.5 border-b bg-orange-50 flex items-center justify-between">
          <h2 className="text-sm font-semibold flex items-center gap-2">🚲 Achats vélos commandés (Axdis)</h2>
          <div className="flex items-center gap-3 text-[11px] text-orange-700">
            {editConfig ? (
              <span className="flex items-center gap-1">
                <input
                  type="number"
                  step="0.01"
                  defaultValue={coutVeloHT}
                  className="px-2 py-0.5 border rounded text-[11px] w-20"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveCoutVelo(Number((e.target as HTMLInputElement).value));
                    if (e.key === "Escape") setEditConfig(false);
                  }}
                  autoFocus
                />
                <span>€ HT/vélo (Entrée pour valider)</span>
              </span>
            ) : (
              <button onClick={() => setEditConfig(true)} className="hover:underline">
                {fmt(coutVeloHT)} HT/vélo · modifier
              </button>
            )}
            <span>·</span>
            <span>
              {totalAchatsCommandesQte} vélos · <span className="font-semibold">{fmt(totalAchatsCommandes)}</span> cash
            </span>
          </div>
        </div>
        {bons.length === 0 ? (
          <div className="p-6 text-sm text-gray-400 italic text-center">Aucun bon Axdis sur cette période.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b text-[11px] text-gray-600">
              <tr>
                <th className="text-left px-3 py-1.5 font-medium">Date</th>
                <th className="text-left px-3 py-1.5 font-medium">N° doc</th>
                <th className="text-left px-3 py-1.5 font-medium">Tournée</th>
                <th className="text-right px-3 py-1.5 font-medium">Qté</th>
                <th className="text-right px-3 py-1.5 font-medium">Coût HT</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {bons.map((b) => (
                <tr key={b.id}>
                  <td className="px-3 py-1.5">{b.dateDoc}</td>
                  <td className="px-3 py-1.5 font-mono text-xs">{String(b.numeroDoc)}</td>
                  <td className="px-3 py-1.5 text-xs text-gray-600">{b.tourneeRef}</td>
                  <td className="px-3 py-1.5 text-right">{b.quantite}</td>
                  <td className="px-3 py-1.5 text-right font-medium">{fmt(b.quantite * coutVeloHT)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Frais opérationnels */}
      <div className="mb-6 bg-white rounded-xl border overflow-hidden">
        <div className="px-4 py-2.5 border-b bg-blue-50 flex items-center justify-between">
          <h2 className="text-sm font-semibold flex items-center gap-2">💼 Frais opérationnels</h2>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-blue-700">
              {frais.length} ligne{frais.length > 1 ? "s" : ""} · <span className="font-semibold">{fmt(totalFraisOps)}</span>
            </span>
            <button
              onClick={() => setShowAdd(true)}
              className="px-2.5 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              + Ajouter
            </button>
          </div>
        </div>

        {/* Récap par catégorie */}
        {Object.keys(fraisParCat).length > 0 && (
          <div className="px-4 py-2 border-b bg-gray-50 flex flex-wrap gap-2 text-[11px]">
            {Object.entries(fraisParCat).map(([cat, total]) => {
              const c = CATEGORIES_FRAIS[cat as CatKey];
              if (!c) return null;
              return (
                <span key={cat} className={`px-2 py-0.5 rounded border ${c.color}`}>
                  {c.label} : <strong>{fmt(total)}</strong>
                </span>
              );
            })}
          </div>
        )}

        {frais.length === 0 ? (
          <div className="p-6 text-sm text-gray-400 italic text-center">
            Aucun frais saisi sur cette période. Clique « + Ajouter ».
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b text-[11px] text-gray-600">
              <tr>
                <th className="text-left px-3 py-1.5 font-medium">Date</th>
                <th className="text-left px-3 py-1.5 font-medium">Catégorie</th>
                <th className="text-left px-3 py-1.5 font-medium">Libellé</th>
                <th className="text-right px-3 py-1.5 font-medium">Montant HT</th>
                <th className="w-8"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {frais.map((f) => {
                const c = CATEGORIES_FRAIS[f.categorie];
                return (
                  <tr key={f.id} className="hover:bg-gray-50">
                    <td className="px-3 py-1.5 whitespace-nowrap">{f.date}</td>
                    <td className="px-3 py-1.5">
                      <span className={`px-2 py-0.5 rounded text-[11px] border ${c?.color || ""}`}>
                        {c?.label || f.categorie}
                      </span>
                      {f.sousCategorie && <span className="text-[11px] text-gray-500 ml-2">{f.sousCategorie}</span>}
                    </td>
                    <td className="px-3 py-1.5 text-xs text-gray-700">{f.libelle}</td>
                    <td className="px-3 py-1.5 text-right font-medium">{fmt(f.montantHT)}</td>
                    <td className="px-2 text-right">
                      <button
                        onClick={() => removeFrais(f.id)}
                        className="text-red-500 hover:text-red-700 text-xs"
                        title="Supprimer"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showAdd && <AddFraisModal onClose={() => setShowAdd(false)} />}
    </>
  );
}

function AddFraisModal({ onClose }: { onClose: () => void }) {
  const [date, setDate] = useState(isoDay(new Date()));
  const [categorie, setCategorie] = useState<CatKey>("vehicules");
  const [sousCategorie, setSousCategorie] = useState<string>(CATEGORIES_FRAIS.vehicules.sousCats[0]);
  const [libelle, setLibelle] = useState("");
  const [montantHT, setMontantHT] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const sousCats = CATEGORIES_FRAIS[categorie].sousCats;

  const submit = async () => {
    const m = parseFloat(montantHT.replace(",", "."));
    if (!isFinite(m) || m <= 0) {
      alert("Montant invalide");
      return;
    }
    if (!libelle.trim()) {
      alert("Mets un libellé court");
      return;
    }
    setBusy(true);
    try {
      await addDoc(collection(db, "frais"), {
        date,
        categorie,
        sousCategorie,
        libelle: libelle.trim(),
        montantHT: m,
        createdAt: serverTimestamp(),
      });
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[70] p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-3">
          <h2 className="text-lg font-semibold">+ Ajouter un frais</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-600">Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full px-2 py-1.5 border rounded text-sm" />
          </div>
          <div>
            <label className="text-xs text-gray-600">Catégorie</label>
            <select
              value={categorie}
              onChange={(e) => {
                const c = e.target.value as CatKey;
                setCategorie(c);
                setSousCategorie(CATEGORIES_FRAIS[c].sousCats[0]);
              }}
              className="w-full px-2 py-1.5 border rounded text-sm"
            >
              {(Object.keys(CATEGORIES_FRAIS) as CatKey[]).map((k) => (
                <option key={k} value={k}>{CATEGORIES_FRAIS[k].label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-600">Sous-catégorie</label>
            <select
              value={sousCategorie}
              onChange={(e) => setSousCategorie(e.target.value)}
              className="w-full px-2 py-1.5 border rounded text-sm"
            >
              {sousCats.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-600">Libellé</label>
            <input
              type="text"
              value={libelle}
              onChange={(e) => setLibelle(e.target.value)}
              placeholder='Ex: "Plein essence camion 30/04"'
              className="w-full px-2 py-1.5 border rounded text-sm"
              autoFocus
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Montant HT (€)</label>
            <input
              type="number"
              step="0.01"
              value={montantHT}
              onChange={(e) => setMontantHT(e.target.value)}
              placeholder="0.00"
              className="w-full px-2 py-1.5 border rounded text-sm"
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50">Annuler</button>
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

function KpiCard({ label, value, accent, hint }: { label: string; value: string; accent?: string; hint?: string }) {
  return (
    <div className="bg-white rounded-xl border px-4 py-3">
      <div className="text-[10px] uppercase tracking-wide text-gray-500 font-medium">{label}</div>
      <div className={`text-lg font-semibold mt-1 ${accent || "text-gray-900"}`}>{value}</div>
      {hint && <div className="text-[10px] text-gray-400 mt-0.5">{hint}</div>}
    </div>
  );
}
