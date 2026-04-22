"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { gasPost } from "@/lib/gas";
import { useData } from "@/lib/data-context";

export default function ClientsPage() {
  const { clients: allClients, loading, refresh } = useData();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [departement, setDepartement] = useState("all");
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const clients = useMemo(() => {
    let result = allClients;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (c) =>
          c.entreprise.toLowerCase().includes(q) ||
          c.contact?.toLowerCase().includes(q) ||
          c.email?.toLowerCase().includes(q) ||
          c.ville?.toLowerCase().includes(q)
      );
    }
    if (filter === "docs_manquants") {
      result = result.filter(
        (c) => !c.devisSignee || !c.kbisRecu || !c.attestationRecue || !c.signatureOk || !c.inscriptionBicycle
      );
    } else if (filter === "prets") {
      result = result.filter(
        (c) => c.devisSignee && c.kbisRecu && c.attestationRecue && c.signatureOk && c.inscriptionBicycle
      );
    }
    return result;
  }, [allClients, search, filter]);

  const departements = Array.from(
    new Set(clients.map((c) => c.departement).filter((d): d is string => typeof d === "string" && d.length > 0))
  ).sort((a, b) => a.localeCompare(b));

  const filteredClients = departement === "all"
    ? clients
    : clients.filter((c) => c.departement === departement);

  const exportCSV = () => {
    const headers = ["Entreprise", "Contact", "Email", "Téléphone", "Ville", "Département", "SIREN", "Apporteur", "Vélos commandés", "Vélos livrés", "Certificats", "Facturables", "Facturés", "Devis", "Kbis", "Attestation", "Signature", "Bicycle"];
    const rows = filteredClients.map((c) => [
      c.entreprise, c.contact || "", c.email || "", c.telephone || "", c.ville || "", c.departement || "", c.siren || "", c.apporteur || "",
      c.stats.totalVelos, c.stats.livres, c.stats.certificats, c.stats.facturables, c.stats.factures,
      c.devisSignee ? "Oui" : "Non", c.kbisRecu ? "Oui" : "Non", c.attestationRecue ? "Oui" : "Non", c.signatureOk ? "Oui" : "Non", c.inscriptionBicycle ? "Oui" : "Non",
    ]);
    const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `clients-velos-cargo-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Clients</h1>
          <p className="text-gray-500 mt-1">{filteredClients.length} clients{departement !== "all" ? ` (dép. ${departement})` : ""}</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={exportCSV}
            className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm"
          >
            Exporter CSV
          </button>
          <button
            onClick={() => setShowImport(true)}
            className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm"
          >
            Importer CSV
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm"
          >
            + Nouveau client
          </button>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <input
          type="text"
          placeholder="Rechercher..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-sm"
        />
        <select
          value={departement}
          onChange={(e) => setDepartement(e.target.value)}
          className="px-4 py-2 border border-gray-300 rounded-lg text-sm"
        >
          <option value="all">Tous les dép.</option>
          {departements.map((d) => (
            <option key={d} value={d!}>{d}</option>
          ))}
        </select>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="px-4 py-2 border border-gray-300 rounded-lg text-sm"
        >
          <option value="all">Tous</option>
          <option value="docs_manquants">Documents manquants</option>
          <option value="prets">Dossiers complets</option>
        </select>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto">
        <table className="w-full min-w-[800px] text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Entreprise</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Ville</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Dép.</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Vélos</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Dossier</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Devis</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Kbis</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Attest.</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Bicycle</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Livrés</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Facturables</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filteredClients.map((c) => (
              <tr key={c.id} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  <Link
                    href={`/clients/detail?id=${c.id}`}
                    className="text-blue-600 hover:underline font-medium"
                  >
                    {c.entreprise}
                  </Link>
                  {c.contact && (
                    <div className="text-xs text-gray-400">{c.contact}</div>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-600">{c.ville || "-"}</td>
                <td className="text-center px-4 py-3 text-gray-500">{c.departement || "-"}</td>
                <td className="text-center px-4 py-3 font-medium">
                  {c.stats.livres}/{c.stats.totalVelos}
                </td>
                <td className="px-4 py-3">
                  <DocProgress devis={c.devisSignee} kbis={c.kbisRecu} attestation={c.attestationRecue} signature={c.signatureOk} bicycle={c.inscriptionBicycle} />
                </td>
                <td className="text-center px-4 py-3">
                  <StatusDot ok={c.devisSignee} />
                </td>
                <td className="text-center px-4 py-3">
                  <StatusDot ok={c.kbisRecu} />
                </td>
                <td className="text-center px-4 py-3">
                  <StatusDot ok={c.attestationRecue} />
                </td>
                <td className="text-center px-4 py-3">
                  <StatusDot ok={c.inscriptionBicycle} />
                </td>
                <td className="text-center px-4 py-3">
                  <span className={c.stats.livres === c.stats.totalVelos && c.stats.totalVelos > 0 ? "text-green-600 font-medium" : ""}>
                    {c.stats.livres}
                  </span>
                </td>
                <td className="text-center px-4 py-3">
                  <span className={c.stats.facturables > 0 ? "text-amber-600 font-medium" : ""}>
                    {c.stats.facturables}
                  </span>
                </td>
              </tr>
            ))}
            {filteredClients.length === 0 && (
              <tr>
                <td colSpan={11} className="px-4 py-12 text-center text-gray-400">
                  {clients.length === 0
                    ? (loading ? "Chargement..." : "Aucun client. Importez votre tableau ou ajoutez un client.")
                    : "Aucun client trouvé pour ces filtres."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showAdd && <AddClientModal onClose={() => { setShowAdd(false); refresh("clients"); }} />}
      {showImport && <ImportModal onClose={() => { setShowImport(false); refresh("clients"); }} />}
    </div>
  );
}

function DocProgress({ devis, kbis, attestation, signature, bicycle }: { devis: boolean; kbis: boolean; attestation: boolean; signature: boolean; bicycle: boolean }) {
  const count = [devis, kbis, attestation, signature, bicycle].filter(Boolean).length;
  const pct = (count / 5) * 100;
  const color = count === 5 ? "bg-green-500" : count >= 3 ? "bg-blue-500" : count >= 1 ? "bg-amber-500" : "bg-gray-300";
  return (
    <div className="flex items-center gap-2 min-w-[80px]">
      <div className="flex-1 bg-gray-200 rounded-full h-2">
        <div className={`${color} h-2 rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-500 whitespace-nowrap">{count}/5</span>
    </div>
  );
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block w-3 h-3 rounded-full ${
        ok ? "bg-green-500" : "bg-red-400"
      }`}
    />
  );
}

function AddClientModal({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState({
    entreprise: "",
    contact: "",
    email: "",
    telephone: "",
    adresse: "",
    ville: "",
    codePostal: "",
    nbVelosCommandes: 0,
  });
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    await gasPost("createClient", form);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-lg">
        <h2 className="text-lg font-semibold mb-4">Nouveau client</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            required
            placeholder="Entreprise *"
            value={form.entreprise}
            onChange={(e) => setForm({ ...form, entreprise: e.target.value })}
            className="w-full px-3 py-2 border rounded-lg text-sm"
          />
          <div className="grid grid-cols-2 gap-3">
            <input
              placeholder="Contact"
              value={form.contact}
              onChange={(e) => setForm({ ...form, contact: e.target.value })}
              className="px-3 py-2 border rounded-lg text-sm"
            />
            <input
              placeholder="Email"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="px-3 py-2 border rounded-lg text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input
              placeholder="Téléphone"
              value={form.telephone}
              onChange={(e) => setForm({ ...form, telephone: e.target.value })}
              className="px-3 py-2 border rounded-lg text-sm"
            />
            <input
              placeholder="Nombre de vélos"
              type="number"
              min={0}
              value={form.nbVelosCommandes}
              onChange={(e) => setForm({ ...form, nbVelosCommandes: parseInt(e.target.value) || 0 })}
              className="px-3 py-2 border rounded-lg text-sm"
            />
          </div>
          <input
            placeholder="Adresse"
            value={form.adresse}
            onChange={(e) => setForm({ ...form, adresse: e.target.value })}
            className="w-full px-3 py-2 border rounded-lg text-sm"
          />
          <div className="grid grid-cols-2 gap-3">
            <input
              placeholder="Ville"
              value={form.ville}
              onChange={(e) => setForm({ ...form, ville: e.target.value })}
              className="px-3 py-2 border rounded-lg text-sm"
            />
            <input
              placeholder="Code postal"
              value={form.codePostal}
              onChange={(e) => setForm({ ...form, codePostal: e.target.value })}
              className="px-3 py-2 border rounded-lg text-sm"
            />
          </div>
          <div className="flex justify-end gap-3 pt-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800"
            >
              Annuler
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 disabled:opacity-50"
            >
              {loading ? "Création..." : "Créer"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ImportModal({ onClose }: { onClose: () => void }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ importedClients: number; importedVelos: number } | null>(null);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    const text = await file.text();
    const lines = text.split("\n").filter((l) => l.trim());
    if (lines.length < 2) {
      alert("Fichier vide ou invalide");
      setLoading(false);
      return;
    }

    const headers = lines[0].split(/[;\t,]/).map((h) => h.trim().toLowerCase());
    const rows = lines.slice(1).map((line) => {
      const cols = line.split(/[;\t,]/);
      const row: Record<string, string> = {};
      headers.forEach((h, i) => {
        row[h] = cols[i]?.trim() || "";
      });

      return {
        entreprise: row["entreprise"] || row["société"] || row["societe"] || row["nom"] || row["client"] || "",
        contact: row["contact"] || row["interlocuteur"] || "",
        email: row["email"] || row["mail"] || "",
        telephone: row["telephone"] || row["tel"] || row["téléphone"] || "",
        adresse: row["adresse"] || row["adress"] || "",
        ville: row["ville"] || row["city"] || "",
        codePostal: row["code postal"] || row["cp"] || row["codepostal"] || "",
        nbVelos: row["nb velos"] || row["nb_velos"] || row["nbvelos"] || row["vélos"] || row["velos"] || row["nombre de vélos"] || row["quantité"] || row["quantite"] || "0",
      };
    }).filter((r) => r.entreprise);

    const data = await gasPost("importClients", { rows });
    setResult(data);
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-lg">
        <h2 className="text-lg font-semibold mb-4">Importer un fichier CSV</h2>
        <p className="text-sm text-gray-500 mb-4">
          Colonnes attendues : entreprise, contact, email, telephone, adresse, ville, code postal, nb velos
        </p>
        {!result ? (
          <>
            <input
              type="file"
              accept=".csv,.tsv,.txt"
              onChange={handleFile}
              disabled={loading}
              className="w-full text-sm"
            />
            {loading && <p className="mt-3 text-sm text-gray-500">Import en cours...</p>}
          </>
        ) : (
          <div className="bg-green-50 border border-green-200 rounded-lg p-4">
            <p className="text-green-700 font-medium">Import terminé</p>
            <p className="text-sm text-green-600">
              {result.importedClients} clients, {result.importedVelos} vélos créés
            </p>
          </div>
        )}
        <div className="flex justify-end mt-4">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm bg-gray-100 rounded-lg hover:bg-gray-200"
          >
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}
