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
  siren: string | null;
  operationNumero: string | null;
  referenceOperation: string | null;
  apporteur: string | null;
  departement: string | null;
  devisSignee: boolean;
  kbisRecu: boolean;
  attestationRecue: boolean;
  signatureOk: boolean;
  inscriptionBicycle: boolean;
  devisLien: string | null;
  kbisLien: string | null;
  attestationLien: string | null;
  signatureLien: string | null;
  bicycleLien: string | null;
  notes: string | null;
  velos: Velo[];
}

const DOC_CONFIG = [
  {
    field: "devisSignee",
    lienField: "devisLien",
    label: "Devis signée",
    description: "Le client signe le devis. Maria reçoit le document dans son Drive.",
    step: 1,
  },
  {
    field: "kbisRecu",
    lienField: "kbisLien",
    label: "Kbis",
    description: "Extrait Kbis de moins de 3 mois. Le client l'envoie par email ou Drive.",
    step: 2,
  },
  {
    field: "attestationRecue",
    lienField: "attestationLien",
    label: "Attestation salariés",
    description: "Attestation du nombre de salariés. Document fourni par le client.",
    step: 3,
  },
  {
    field: "signatureOk",
    lienField: "signatureLien",
    label: "Signature électronique",
    description: "Contrat signé électroniquement via la plateforme de signature.",
    step: 4,
  },
  {
    field: "inscriptionBicycle",
    lienField: "bicycleLien",
    label: "Inscription Bicycle",
    description: "Le client s'inscrit sur Bicycle pour les certificats d'homologation.",
    step: 5,
  },
];

export default function ClientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [client, setClient] = useState<ClientDetail | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/clients/${id}`)
      .then((r) => r.json())
      .then(setClient);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const updateField = async (field: string, value: unknown) => {
    setSaving(field);
    await fetch(`/api/clients/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value }),
    });
    load();
    setSaving(null);
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
  const docsValides = [client.devisSignee, client.kbisRecu, client.attestationRecue, client.signatureOk, client.inscriptionBicycle].filter(Boolean).length;

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
            {client.siren && <span>SIREN: {client.siren}</span>}
            {client.email && <span>{client.email}</span>}
            {client.telephone && <span>{client.telephone}</span>}
          </div>
          {(client.adresse || client.ville) && (
            <div className="text-sm text-gray-400 mt-1">
              {[client.adresse, client.codePostal, client.ville, client.departement ? `(${client.departement})` : null].filter(Boolean).join(", ")}
            </div>
          )}
          {(client.apporteur || client.operationNumero) && (
            <div className="text-sm text-gray-400 mt-1">
              {client.apporteur && <span>Apporteur: {client.apporteur}</span>}
              {client.operationNumero && <span> — Op. n°{client.operationNumero}</span>}
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

      {/* Progression documents */}
      <div className="bg-white rounded-xl border p-4 mb-6">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-semibold text-gray-900">Dossier administratif</h2>
          <span className="text-sm font-medium text-gray-600">{docsValides}/5 validés</span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div
            className="bg-green-500 h-2 rounded-full transition-all"
            style={{ width: `${(docsValides / 5) * 100}%` }}
          />
        </div>
        <p className="text-xs text-gray-400 mt-2">
          Chaque document arrive dans le Google Drive partagé. Collez le lien Drive ci-dessous puis cliquez &quot;Valider&quot; pour confirmer la réception.
        </p>
      </div>

      {/* Document cards */}
      <div className="space-y-3 mb-8">
        {DOC_CONFIG.map((doc) => {
          const isValid = client[doc.field as keyof ClientDetail] as boolean;
          const lien = (client[doc.lienField as keyof ClientDetail] as string) || "";
          return (
            <DocCardExpanded
              key={doc.field}
              step={doc.step}
              label={doc.label}
              description={doc.description}
              validated={isValid}
              lien={lien}
              saving={saving === doc.field || saving === doc.lienField}
              onToggle={() => updateField(doc.field, !isValid)}
              onSaveLien={(url) => updateField(doc.lienField, url)}
            />
          );
        })}
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

function DocCardExpanded({
  step,
  label,
  description,
  validated,
  lien,
  saving,
  onToggle,
  onSaveLien,
}: {
  step: number;
  label: string;
  description: string;
  validated: boolean;
  lien: string;
  saving: boolean;
  onToggle: () => void;
  onSaveLien: (url: string) => void;
}) {
  const [editLien, setEditLien] = useState(lien);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setEditLien(lien);
  }, [lien]);

  return (
    <div
      className={`rounded-xl border p-4 transition-colors ${
        validated
          ? "bg-green-50 border-green-200"
          : "bg-white border-gray-200"
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${
            validated
              ? "bg-green-500 text-white"
              : "bg-gray-200 text-gray-500"
          }`}
        >
          {validated ? "✓" : step}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <h3 className="font-medium text-gray-900">{label}</h3>
            <button
              onClick={onToggle}
              disabled={saving}
              className={`px-3 py-1 text-xs font-medium rounded-lg transition-colors ${
                validated
                  ? "bg-green-100 text-green-700 hover:bg-red-100 hover:text-red-700"
                  : "bg-blue-600 text-white hover:bg-blue-700"
              } disabled:opacity-50`}
            >
              {saving ? "..." : validated ? "Validé — annuler ?" : "Valider"}
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-1">{description}</p>

          {/* Lien Drive */}
          <div className="mt-3">
            {!editing && !lien && (
              <button
                onClick={() => setEditing(true)}
                className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
                Ajouter le lien Google Drive
              </button>
            )}
            {!editing && lien && (
              <div className="flex items-center gap-2 text-xs">
                <svg className="w-3.5 h-3.5 text-green-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
                <a
                  href={lien}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline truncate max-w-xs"
                >
                  Voir le document
                </a>
                <button
                  onClick={() => setEditing(true)}
                  className="text-gray-400 hover:text-gray-600 ml-1"
                >
                  modifier
                </button>
              </div>
            )}
            {editing && (
              <div className="flex gap-2">
                <input
                  type="url"
                  placeholder="https://drive.google.com/..."
                  value={editLien}
                  onChange={(e) => setEditLien(e.target.value)}
                  className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded-lg"
                  autoFocus
                />
                <button
                  onClick={() => {
                    onSaveLien(editLien);
                    setEditing(false);
                  }}
                  className="px-2 py-1 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                >
                  OK
                </button>
                <button
                  onClick={() => { setEditLien(lien); setEditing(false); }}
                  className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700"
                >
                  Annuler
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ ok }: { ok: boolean }) {
  return (
    <span className={`inline-block w-3 h-3 rounded-full ${ok ? "bg-green-500" : "bg-gray-200"}`} />
  );
}
