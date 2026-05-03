"use client";

// Yoann 2026-05-03 — Base totale FNUCI du parc.
// Demande : "il me faut un bouton dans la page client avec la base totale,
// de tout les fnuci de mon parc. on les collecte à chaque préparation donc
// un total serait pas difficile à mettre en place".
//
// Liste TOUS les vélos avec un FNUCI (incluant annulés). Permet de :
// - Chercher un FNUCI précis ("d où sort ce numéro ?")
// - Voir l état de chaque vélo (préparé / chargé / livré / annulé)
// - Filtrer par client, apporteur, statut
// - Export CSV pour archivage CEE
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

type VeloRow = {
  id: string;
  fnuci: string;
  clientId: string;
  clientNom: string;
  clientVille: string;
  apporteur: string;
  datePreparation: string | null;
  dateChargement: string | null;
  dateLivraisonScan: string | null;
  dateMontage: string | null;
  annule: boolean;
  annuleReason: string | null;
  cartonToken: string | null;
};

function isoOrNull(x: unknown): string | null {
  if (!x) return null;
  if (x instanceof Date) return x.toISOString();
  const t = x as { toDate?: () => Date };
  if (t?.toDate) return t.toDate().toISOString();
  if (typeof x === "string") return x;
  return null;
}

export default function ParcFnuciPage() {
  const [rows, setRows] = useState<VeloRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterStatut, setFilterStatut] = useState<"tous" | "prepare" | "charge" | "livre" | "annule">("tous");
  const [filterApporteur, setFilterApporteur] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      const { collection, getDocs } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      // 1. Charge tous les clients pour mapper clientId → nom
      const cSnap = await getDocs(collection(db, "clients"));
      const clientMap = new Map<string, { entreprise: string; ville: string; apporteur: string }>();
      for (const d of cSnap.docs) {
        const o = d.data() as Record<string, unknown>;
        clientMap.set(d.id, {
          entreprise: String(o.entreprise || ""),
          ville: String(o.ville || ""),
          apporteur: String(o.apporteur || ""),
        });
      }
      // 2. Charge tous les vélos avec FNUCI (1 query — tri client-side)
      const vSnap = await getDocs(collection(db, "velos"));
      const list: VeloRow[] = [];
      for (const d of vSnap.docs) {
        const v = d.data() as Record<string, unknown>;
        const fnuci = typeof v.fnuci === "string" ? v.fnuci : null;
        if (!fnuci) continue; // skip vélos vierges
        const cid = String(v.clientId || "");
        const c = clientMap.get(cid) || { entreprise: "?", ville: "", apporteur: "" };
        list.push({
          id: d.id,
          fnuci,
          clientId: cid,
          clientNom: c.entreprise,
          clientVille: c.ville,
          apporteur: c.apporteur,
          datePreparation: isoOrNull(v.datePreparation),
          dateChargement: isoOrNull(v.dateChargement),
          dateLivraisonScan: isoOrNull(v.dateLivraisonScan),
          dateMontage: isoOrNull(v.dateMontage),
          annule: v.annule === true,
          annuleReason: typeof v.annuleReason === "string" ? v.annuleReason : null,
          cartonToken: typeof v.cartonToken === "string" ? v.cartonToken : null,
        });
      }
      // Tri par datePreparation desc (plus récents en haut)
      list.sort((a, b) => (b.datePreparation || "").localeCompare(a.datePreparation || ""));
      if (alive) {
        setRows(list);
        setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const apporteurs = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) if (r.apporteur) s.add(r.apporteur);
    return [...s].sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    return rows.filter((r) => {
      if (q) {
        const matchFnuci = r.fnuci.includes(q);
        const matchClient = r.clientNom.toUpperCase().includes(q);
        const matchVille = r.clientVille.toUpperCase().includes(q);
        if (!matchFnuci && !matchClient && !matchVille) return false;
      }
      if (filterApporteur && r.apporteur !== filterApporteur) return false;
      if (filterStatut === "annule" && !r.annule) return false;
      if (filterStatut === "livre" && (!r.dateLivraisonScan || r.annule)) return false;
      if (filterStatut === "charge" && (!r.dateChargement || r.dateLivraisonScan || r.annule)) return false;
      if (filterStatut === "prepare" && (!r.datePreparation || r.dateChargement || r.annule)) return false;
      return true;
    });
  }, [rows, search, filterApporteur, filterStatut]);

  const stats = useMemo(() => {
    let total = 0, prepares = 0, charges = 0, livres = 0, annules = 0;
    for (const r of rows) {
      total++;
      if (r.annule) { annules++; continue; }
      if (r.dateLivraisonScan) livres++;
      else if (r.dateChargement) charges++;
      else if (r.datePreparation) prepares++;
    }
    return { total, prepares, charges, livres, annules };
  }, [rows]);

  const exportCsv = () => {
    const headers = ["FNUCI", "Client", "Ville", "Apporteur", "Préparé", "Chargé", "Livré", "Monté", "Annulé", "Raison annulation"];
    const lines = [headers.join(";")];
    for (const r of filtered) {
      lines.push([
        r.fnuci,
        `"${r.clientNom.replace(/"/g, '""')}"`,
        `"${r.clientVille.replace(/"/g, '""')}"`,
        r.apporteur,
        r.datePreparation || "",
        r.dateChargement || "",
        r.dateLivraisonScan || "",
        r.dateMontage || "",
        r.annule ? "Oui" : "",
        r.annuleReason || "",
      ].join(";"));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `parc-fnuci-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) return <div className="p-6 text-center text-gray-500">Chargement parc FNUCI…</div>;

  const fmtDate = (iso: string | null): string => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString("fr-FR");
  };

  return (
    <div className="max-w-6xl mx-auto p-4 space-y-4">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">🔢 Parc FNUCI</h1>
          <p className="text-sm text-gray-500 mt-1">
            Base totale de tous les FNUCI scannés / affiliés sur le parc.
            Inclut les vélos annulés pour traçabilité.
          </p>
        </div>
        <Link href="/clients" className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50">← Retour clients</Link>
      </div>

      {/* Stats globales */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <div className="bg-gray-100 border rounded p-2 text-center">
          <div className="text-xl font-bold">{stats.total}</div>
          <div className="text-[10px] uppercase text-gray-600">Total FNUCI</div>
        </div>
        <div className="bg-amber-50 border border-amber-200 rounded p-2 text-center">
          <div className="text-xl font-bold text-amber-900">{stats.prepares}</div>
          <div className="text-[10px] uppercase text-amber-700">Préparés</div>
        </div>
        <div className="bg-blue-50 border border-blue-200 rounded p-2 text-center">
          <div className="text-xl font-bold text-blue-900">{stats.charges}</div>
          <div className="text-[10px] uppercase text-blue-700">Chargés</div>
        </div>
        <div className="bg-emerald-50 border border-emerald-200 rounded p-2 text-center">
          <div className="text-xl font-bold text-emerald-900">{stats.livres}</div>
          <div className="text-[10px] uppercase text-emerald-700">Livrés</div>
        </div>
        <div className="bg-rose-50 border border-rose-200 rounded p-2 text-center">
          <div className="text-xl font-bold text-rose-900">{stats.annules}</div>
          <div className="text-[10px] uppercase text-rose-700">Annulés</div>
        </div>
      </div>

      {/* Filtres */}
      <div className="bg-white border rounded-lg p-3 space-y-2">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Recherche FNUCI / client / ville"
            className="px-3 py-2 border rounded text-sm"
          />
          <select
            value={filterApporteur}
            onChange={(e) => setFilterApporteur(e.target.value)}
            className="px-3 py-2 border rounded text-sm bg-white"
          >
            <option value="">Tous apporteurs</option>
            {apporteurs.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <select
            value={filterStatut}
            onChange={(e) => setFilterStatut(e.target.value as typeof filterStatut)}
            className="px-3 py-2 border rounded text-sm bg-white"
          >
            <option value="tous">Tous statuts</option>
            <option value="prepare">Préparés (pas chargés)</option>
            <option value="charge">Chargés (pas livrés)</option>
            <option value="livre">Livrés</option>
            <option value="annule">Annulés</option>
          </select>
        </div>
        <div className="flex items-center justify-between text-sm">
          <div className="text-gray-600">
            <strong>{filtered.length}</strong> résultat{filtered.length > 1 ? "s" : ""} sur {rows.length} total
          </div>
          <button
            onClick={exportCsv}
            disabled={filtered.length === 0}
            className="px-3 py-1.5 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 disabled:opacity-50 font-semibold"
          >
            📥 Export CSV
          </button>
        </div>
      </div>

      {/* Tableau */}
      <div className="bg-white border rounded-lg overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-2 py-2 font-medium">FNUCI</th>
              <th className="text-left px-2 py-2 font-medium">Client</th>
              <th className="text-left px-2 py-2 font-medium">Ville</th>
              <th className="text-left px-2 py-2 font-medium">Apporteur</th>
              <th className="text-center px-2 py-2 font-medium">Préparé</th>
              <th className="text-center px-2 py-2 font-medium">Chargé</th>
              <th className="text-center px-2 py-2 font-medium">Livré</th>
              <th className="text-center px-2 py-2 font-medium">Statut</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filtered.slice(0, 500).map((r) => {
              const statut = r.annule ? "annulé"
                : r.dateLivraisonScan ? "livré"
                : r.dateChargement ? "chargé"
                : r.datePreparation ? "préparé"
                : "?";
              const statutColor = r.annule ? "bg-rose-100 text-rose-700"
                : r.dateLivraisonScan ? "bg-emerald-100 text-emerald-800"
                : r.dateChargement ? "bg-blue-100 text-blue-800"
                : r.datePreparation ? "bg-amber-100 text-amber-800"
                : "bg-gray-100 text-gray-600";
              return (
                <tr key={r.id} className={`hover:bg-gray-50 ${r.annule ? "opacity-60" : ""}`}>
                  <td className="px-2 py-1 font-mono font-bold">{r.fnuci}</td>
                  <td className="px-2 py-1">
                    <a
                      href={`/clients/detail?id=${encodeURIComponent(r.clientId)}`}
                      className="text-blue-600 hover:underline truncate"
                      target="_blank"
                      rel="noreferrer"
                    >
                      {r.clientNom}
                    </a>
                  </td>
                  <td className="px-2 py-1 text-gray-600">{r.clientVille}</td>
                  <td className="px-2 py-1 text-gray-600">{r.apporteur}</td>
                  <td className="px-2 py-1 text-center text-[10px] text-gray-500">{fmtDate(r.datePreparation)}</td>
                  <td className="px-2 py-1 text-center text-[10px] text-gray-500">{fmtDate(r.dateChargement)}</td>
                  <td className="px-2 py-1 text-center text-[10px] text-gray-500">{fmtDate(r.dateLivraisonScan)}</td>
                  <td className="px-2 py-1 text-center">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${statutColor}`}>
                      {statut}
                    </span>
                    {r.annule && r.annuleReason && (
                      <div className="text-[9px] text-rose-600 italic mt-0.5" title={r.annuleReason}>
                        {r.annuleReason.slice(0, 30)}{r.annuleReason.length > 30 ? "…" : ""}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length > 500 && (
          <div className="px-3 py-2 text-xs text-gray-500 italic text-center bg-gray-50 border-t">
            Affichage limité à 500 lignes. Utilise les filtres ou Export CSV pour la suite ({filtered.length - 500} restants).
          </div>
        )}
      </div>
    </div>
  );
}
