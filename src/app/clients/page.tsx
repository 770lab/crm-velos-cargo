"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

interface ClientRow {
  id: string;
  entreprise: string;
  siren: string | null;
  contact: string | null;
  email: string | null;
  telephone: string | null;
  ville: string | null;
  departement: string | null;
  apporteur: string | null;
  devisSignee: boolean;
  kbisRecu: boolean;
  attestationRecue: boolean;
  signatureOk: boolean;
  inscriptionBicycle: boolean;
  nbVelosCommandes: number;
  stats: {
    totalVelos: number;
    livres: number;
    certificats: number;
    facturables: number;
    factures: number;
  };
}

export default function ClientsPage() {
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const loadClients = useCallback(() => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (filter !== "all") params.set("filter", filter);
    fetch(`/api/clients?${params}`)
      .then((r) => r.json())
      .then(setClients);
  }, [search, filter]);

  useEffect(() => {
    loadClients();
  }, [loadClients]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Clients</h1>
          <p className="text-gray-500 mt-1">{clients.length} clients</p>
        </div>
        <div className="flex gap-3">
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

      <div className="flex gap-4 mb-6">
        <input
          type="text"
          placeholder="Rechercher..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-sm"
        />
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

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Entreprise</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Ville</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Dép.</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Vélos</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Devis</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Kbis</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Attest.</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Bicycle</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Livrés</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Facturables</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {clients.map((c) => (
              <tr key={c.id} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  <Link
                    href={`/clients/${c.id}`}
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
            {clients.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-12 text-center text-gray-400">
                  Aucun client. Importez votre tableau ou ajoutez un client.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showAdd && <AddClientModal onClose={() => { setShowAdd(false); loadClients(); }} />}
      {showImport && <ImportModal onClose={() => { setShowImport(false); loadClients(); }} />}
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
    await fetch("/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
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

    const res = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows }),
    });
    const data = await res.json();
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
