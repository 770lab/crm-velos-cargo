"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

interface Velo {
  id: string;
  reference: string | null;
  qrCode: string | null;
  certificatRecu: boolean;
  certificatNumero: string | null;
  photoQrPrise: boolean;
  facturable: boolean;
  facture: boolean;
  livraison: { id: string; datePrevue: string | null; statut: string } | null;
}

interface ClientDetail {
  id: string;
  entreprise: string;
  contact: string | null;
  email: string | null;
  telephone: string | null;
  adresse: string | null;
  ville: string | null;
  codePostal: string | null;
  nbVelosCommandes: number;
  kbisRecu: boolean;
  attestationRecue: boolean;
  signatureOk: boolean;
  inscriptionBicycle: boolean;
  notes: string | null;
  velos: Velo[];
}

export default function ClientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [client, setClient] = useState<ClientDetail | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    fetch(`/api/clients/${id}`)
      .then((r) => r.json())
      .then(setClient);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleDoc = async (field: string, value: boolean) => {
    await fetch(`/api/clients/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value }),
    });
    load();
  };

  const bulkAction = async (action: string) => {
    if (selected.size === 0) return;
    await fetch(`/api/clients/${id}/velos`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bulkAction: action, veloIds: Array.from(selected) }),
    });
    setSelected(new Set());
    load();
  };

  const deleteClient = async () => {
    if (!confirm("Supprimer ce client et tous ses vélos ?")) return;
    await fetch(`/api/clients/${id}`, { method: "DELETE" });
    router.push("/clients");
  };

  if (!client) {
    return <div className="text-gray-400 p-8">Chargement...</div>;
  }

  const velosLivres = client.velos.filter((v) => v.photoQrPrise).length;
  const certRecus = client.velos.filter((v) => v.certificatRecu).length;
  const facturables = client.velos.filter((v) => v.facturable).length;

  const toggleAll = () => {
    if (selected.size === client.velos.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(client.velos.map((v) => v.id)));
    }
  };

  return (
    <div>
      <div className="mb-6">
        <Link href="/clients" className="text-sm text-gray-500 hover:text-gray-700">
          &larr; Retour aux clients
        </Link>
      </div>

      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{client.entreprise}</h1>
          <div className="flex gap-4 mt-2 text-sm text-gray-500">
            {client.contact && <span>{client.contact}</span>}
            {client.email && <span>{client.email}</span>}
            {client.telephone && <span>{client.telephone}</span>}
          </div>
          {(client.adresse || client.ville) && (
            <div className="text-sm text-gray-400 mt-1">
              {[client.adresse, client.codePostal, client.ville].filter(Boolean).join(", ")}
            </div>
          )}
        </div>
        <button
          onClick={deleteClient}
          className="px-3 py-1 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50"
        >
          Supprimer
        </button>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-8">
        <DocCard
          label="Kbis"
          ok={client.kbisRecu}
          onToggle={() => toggleDoc("kbisRecu", !client.kbisRecu)}
        />
        <DocCard
          label="Attestation salariés"
          ok={client.attestationRecue}
          onToggle={() => toggleDoc("attestationRecue", !client.attestationRecue)}
        />
        <DocCard
          label="Signature électronique"
          ok={client.signatureOk}
          onToggle={() => toggleDoc("signatureOk", !client.signatureOk)}
        />
        <DocCard
          label="Inscription Bicycle"
          ok={client.inscriptionBicycle}
          onToggle={() => toggleDoc("inscriptionBicycle", !client.inscriptionBicycle)}
        />
      </div>

      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="bg-white rounded-xl border p-4 text-center">
          <div className="text-2xl font-bold">{velosLivres}/{client.velos.length}</div>
          <div className="text-sm text-gray-500">Livrés</div>
        </div>
        <div className="bg-white rounded-xl border p-4 text-center">
          <div className="text-2xl font-bold">{certRecus}/{client.velos.length}</div>
          <div className="text-sm text-gray-500">Certificats reçus</div>
        </div>
        <div className="bg-white rounded-xl border p-4 text-center">
          <div className="text-2xl font-bold text-amber-600">{facturables}</div>
          <div className="text-sm text-gray-500">Facturables</div>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b bg-gray-50">
          <h2 className="font-semibold">Vélos ({client.velos.length})</h2>
          {selected.size > 0 && (
            <div className="flex gap-2">
              <button
                onClick={() => bulkAction("marquer_certificat")}
                className="px-3 py-1 text-xs bg-purple-100 text-purple-700 rounded-lg hover:bg-purple-200"
              >
                Certificat reçu
              </button>
              <button
                onClick={() => bulkAction("marquer_photo_qr")}
                className="px-3 py-1 text-xs bg-emerald-100 text-emerald-700 rounded-lg hover:bg-emerald-200"
              >
                Photo QR faite
              </button>
              <button
                onClick={() => bulkAction("marquer_facturable")}
                className="px-3 py-1 text-xs bg-amber-100 text-amber-700 rounded-lg hover:bg-amber-200"
              >
                Facturable
              </button>
              <button
                onClick={() => bulkAction("marquer_facture")}
                className="px-3 py-1 text-xs bg-teal-100 text-teal-700 rounded-lg hover:bg-teal-200"
              >
                Facturé
              </button>
            </div>
          )}
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="px-4 py-2 w-10">
                <input
                  type="checkbox"
                  checked={selected.size === client.velos.length && client.velos.length > 0}
                  onChange={toggleAll}
                />
              </th>
              <th className="text-left px-4 py-2 font-medium text-gray-600">Réf.</th>
              <th className="text-center px-4 py-2 font-medium text-gray-600">QR Code</th>
              <th className="text-center px-4 py-2 font-medium text-gray-600">Certificat</th>
              <th className="text-center px-4 py-2 font-medium text-gray-600">Photo QR</th>
              <th className="text-center px-4 py-2 font-medium text-gray-600">Facturable</th>
              <th className="text-center px-4 py-2 font-medium text-gray-600">Facturé</th>
              <th className="text-center px-4 py-2 font-medium text-gray-600">Livraison</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {client.velos.map((v) => (
              <tr key={v.id} className="hover:bg-gray-50">
                <td className="px-4 py-2">
                  <input
                    type="checkbox"
                    checked={selected.has(v.id)}
                    onChange={() => {
                      const next = new Set(selected);
                      next.has(v.id) ? next.delete(v.id) : next.add(v.id);
                      setSelected(next);
                    }}
                  />
                </td>
                <td className="px-4 py-2 font-mono text-xs">{v.reference || "-"}</td>
                <td className="text-center px-4 py-2 text-xs text-gray-500">{v.qrCode || "-"}</td>
                <td className="text-center px-4 py-2">
                  <StatusBadge ok={v.certificatRecu} />
                </td>
                <td className="text-center px-4 py-2">
                  <StatusBadge ok={v.photoQrPrise} />
                </td>
                <td className="text-center px-4 py-2">
                  <StatusBadge ok={v.facturable} />
                </td>
                <td className="text-center px-4 py-2">
                  <StatusBadge ok={v.facture} />
                </td>
                <td className="text-center px-4 py-2 text-xs">
                  {v.livraison ? (
                    <span
                      className={`px-2 py-1 rounded-full ${
                        v.livraison.statut === "livree"
                          ? "bg-green-100 text-green-700"
                          : v.livraison.statut === "en_cours"
                            ? "bg-blue-100 text-blue-700"
                            : "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {v.livraison.statut}
                    </span>
                  ) : (
                    <span className="text-gray-300">-</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DocCard({ label, ok, onToggle }: { label: string; ok: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={`rounded-xl border p-4 text-left transition-colors ${
        ok ? "bg-green-50 border-green-200" : "bg-white border-gray-200 hover:border-gray-300"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`w-3 h-3 rounded-full ${ok ? "bg-green-500" : "bg-red-400"}`} />
        <span className="text-sm font-medium">{label}</span>
      </div>
      <div className="text-xs text-gray-500 mt-1">
        {ok ? "Reçu" : "En attente"}
      </div>
    </button>
  );
}

function StatusBadge({ ok }: { ok: boolean }) {
  return (
    <span className={`inline-block w-3 h-3 rounded-full ${ok ? "bg-green-500" : "bg-gray-200"}`} />
  );
}
