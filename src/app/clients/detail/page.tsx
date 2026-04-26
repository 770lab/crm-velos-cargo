"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { gasGet, gasPost, gasUpload } from "@/lib/gas";

export default function ClientDetailWrapper() {
  return (
    <Suspense fallback={<div className="text-gray-400 p-8">Chargement...</div>}>
      <ClientDetailPage />
    </Suspense>
  );
}

interface Velo {
  id: string;
  reference: string | null;
  qrCode: string | null;
  certificatRecu: boolean;
  certificatNumero: string | null;
  photoQrPrise: boolean;
  facturable: boolean;
  facture: boolean;
  /** True dès que les 3 photos montage (étiquette + QR vélo + vélo monté) ont été
   *  prises — pour pouvoir voir d'un coup d'œil quels vélos sont montés. */
  monte?: boolean;
  /** True quand le scan livraison a été enregistré côté chauffeur. */
  livre?: boolean;
  /** URLs Drive directes des photos montage (null si pas encore prise). */
  urlPhotoMontageEtiquette?: string | null;
  urlPhotoMontageQrVelo?: string | null;
  photoMontageUrl?: string | null;
  /** URL Drive du Bon de Livraison signé (1 par tournée, attaché au vélo via tourneeIdScan). */
  urlBlSigne?: string | null;
  livraison: {
    id: string;
    datePrevue: string | null;
    statut: string;
    dateEffective?: string | null;
    urlBlSigne?: string | null;
  } | null;
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
  parcelleCadastrale: boolean;
  effectifMentionne: boolean;
  devisLien: string | null;
  kbisLien: string | null;
  attestationLien: string | null;
  signatureLien: string | null;
  bicycleLien: string | null;
  parcelleCadastraleLien: string | null;
  kbisDate: string | null;
  dateEngagement: string | null;
  liasseFiscaleDate: string | null;
  notes: string | null;
  velos: Velo[];
}

function isDocExpired(dateStr: string | null, refDateStr: string | null, months: number): boolean {
  if (!dateStr) return false;
  const docDate = new Date(dateStr + "T00:00:00");
  const ref = refDateStr ? new Date(refDateStr + "T00:00:00") : new Date();
  const limit = new Date(ref);
  limit.setMonth(limit.getMonth() - months);
  return docDate < limit;
}

const DOC_CONFIG = [
  { field: "devisSignee", lienField: "devisLien", label: "Devis signé", description: "Devis complété et signé par le client.", step: 1 },
  { field: "kbisRecu", lienField: "kbisLien", label: "Extrait K / Kbis / RNE", description: "Extrait Kbis, RNE, JOAFE ou équivalent de moins de 3 mois.", step: 2 },
  { field: "attestationRecue", lienField: "attestationLien", label: "Liasse fiscale / Effectifs", description: "Liasse fiscale du dernier exercice, registre du personnel ou attestation d'effectifs (ETP).", step: 3 },
  { field: "signatureOk", lienField: "signatureLien", label: "Signature contrat", description: "Contrat signé électroniquement via la plateforme.", step: 4 },
  { field: "inscriptionBicycle", lienField: "bicycleLien", label: "Certificat Bicycle / FNUCI", description: "Certificat d'identification du vélo au nom de l'acquéreur.", step: 5 },
  { field: "parcelleCadastrale", lienField: "parcelleCadastraleLien", label: "Parcelle cadastrale", description: "Parcelle cadastrale ou Géoportail du lieu de livraison au client final.", step: 6 },
];

const TOTAL_DOCS = DOC_CONFIG.length;

function ClientDetailPage() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id") || "";
  const router = useRouter();
  const [client, setClient] = useState<ClientDetail | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(() => {
    gasGet("getClient", { id }).then(setClient);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const updateField = async (field: string, value: unknown) => {
    setSaving(field);
    await gasPost("updateClient", { id, data: { [field]: value } });
    load();
    setSaving(null);
  };

  const bulkAction = async (action: string) => {
    if (selected.size === 0) return;
    await gasPost("updateVelos", { bulkAction: action, veloIds: Array.from(selected) });
    setSelected(new Set());
    load();
  };

  const deleteClient = async () => {
    if (!confirm("Supprimer ce client et tous ses vélos ?")) return;
    await gasGet("deleteClient", { id });
    router.push("/clients");
  };

  if (!client) {
    return <div className="text-gray-400 p-8">Chargement...</div>;
  }

  const velosLivres = client.velos.filter((v) => v.photoQrPrise).length;
  const certRecus = client.velos.filter((v) => v.certificatRecu).length;
  const facturables = client.velos.filter((v) => v.facturable).length;
  const docsValides = DOC_CONFIG.filter((d) => client[d.field as keyof ClientDetail] as boolean).length;

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
          <span className="text-sm font-medium text-gray-600">{docsValides}/{TOTAL_DOCS} validés</span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div
            className="bg-green-500 h-2 rounded-full transition-all"
            style={{ width: `${(docsValides / TOTAL_DOCS) * 100}%` }}
          />
        </div>
        <p className="text-xs text-gray-400 mt-2">
          Checklist dossier CEE complet (process TRA-EQ-131). Uploadez ou collez le lien Drive de chaque document.
        </p>
      </div>

      {/* Document cards */}
      <div className="space-y-3 mb-8">
        {DOC_CONFIG.map((doc) => {
          const isValid = client[doc.field as keyof ClientDetail] as boolean;
          const lien = (client[doc.lienField as keyof ClientDetail] as string) || "";
          const isExpired = doc.field === "kbisRecu"
            ? isValid && isDocExpired(client.kbisDate, client.dateEngagement, 3)
            : doc.field === "attestationRecue"
            ? isValid && isDocExpired(client.liasseFiscaleDate, client.dateEngagement, 12)
            : false;
          return (
            <DocCardExpanded
              key={doc.field}
              step={doc.step}
              label={doc.label}
              description={doc.description}
              validated={isValid}
              expired={isExpired}
              lien={lien}
              saving={saving === doc.field || saving === doc.lienField}
              onToggle={() => updateField(doc.field, !isValid)}
              onSaveLien={(url) => updateField(doc.lienField, url)}
              onUpload={async (file) => {
                setSaving(doc.field);
                const reader = new FileReader();
                const base64 = await new Promise<string>((resolve) => {
                  reader.onload = () => resolve((reader.result as string).split(",")[1]);
                  reader.readAsDataURL(file);
                });
                await gasUpload("uploadDoc", {
                  clientId: id,
                  docType: doc.field,
                  fileName: file.name,
                  fileData: base64,
                  mimeType: file.type,
                });
                load();
                setSaving(null);
              }}
              onAutoFetch={doc.field === "parcelleCadastrale" ? async () => {
                setSaving(doc.field);
                const res = await gasGet("fetchParcelle", { id });
                if (res.error) {
                  alert("Erreur : " + res.error);
                } else {
                  // Affichage explicite des 3 composants de la ref cadastrale +
                  // avertissement : si le user valide la mauvaise parcelle, il
                  // peut ne pas etre paye sur le dossier CEE. Le lien stocke
                  // pointe maintenant directement sur la parcelle exacte
                  // (cadastre.data.gouv.fr) au lieu d'une vue France entiere.
                  const parts = [
                    `Commune INSEE : ${res.commune || "—"}`,
                    `Section : ${res.section || "—"}`,
                    `Numéro : ${res.numero || "—"}`,
                    res.contenance ? `Contenance : ${res.contenance} m²` : "",
                  ].filter(Boolean).join("\n");
                  alert(
                    "Parcelle cadastrale trouvée :\n\n" + parts +
                    "\n\n⚠️ Vérifie sur la carte que c'est bien la parcelle du lieu de livraison avant de valider — un mauvais identifiant peut bloquer le paiement du dossier CEE."
                  );
                }
                load();
                setSaving(null);
              } : undefined}
            />
          );
        })}
      </div>

      {/* Dates de validité et effectif */}
      <div className="bg-white rounded-xl border p-4 mb-8 space-y-3">
        <h3 className="font-semibold text-sm text-gray-700">Dates de validité</h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Date engagement (devis)</label>
            <input
              type="date"
              value={client.dateEngagement || ""}
              onChange={(e) => updateField("dateEngagement", e.target.value || "")}
              className="w-full px-2 py-1.5 border rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Date du KBIS</label>
            <input
              type="date"
              value={client.kbisDate || ""}
              onChange={(e) => updateField("kbisDate", e.target.value || "")}
              className={`w-full px-2 py-1.5 border rounded-lg text-sm ${
                client.kbisDate && client.kbisRecu && isDocExpired(client.kbisDate, client.dateEngagement, 3)
                  ? "border-orange-400 bg-orange-50" : ""
              }`}
            />
            {client.kbisDate && client.kbisRecu && isDocExpired(client.kbisDate, client.dateEngagement, 3) && (
              <p className="text-[10px] text-orange-600 mt-0.5">KBIS de plus de 3 mois</p>
            )}
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Date liasse / registre</label>
            <input
              type="date"
              value={client.liasseFiscaleDate || ""}
              onChange={(e) => updateField("liasseFiscaleDate", e.target.value || "")}
              className={`w-full px-2 py-1.5 border rounded-lg text-sm ${
                client.liasseFiscaleDate && client.attestationRecue && isDocExpired(client.liasseFiscaleDate, client.dateEngagement, 12)
                  ? "border-orange-400 bg-orange-50" : ""
              }`}
            />
            {client.liasseFiscaleDate && client.attestationRecue && isDocExpired(client.liasseFiscaleDate, client.dateEngagement, 12) && (
              <p className="text-[10px] text-orange-600 mt-0.5">Document de plus d&apos;1 an</p>
            )}
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 px-2 py-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={client.effectifMentionne || false}
                onChange={(e) => updateField("effectifMentionne", e.target.checked)}
              />
              <span className={`text-sm ${!client.effectifMentionne && client.attestationRecue ? "text-orange-600 font-medium" : "text-gray-700"}`}>
                Effectif mentionné
              </span>
            </label>
          </div>
        </div>
      </div>

      {/* Bons de livraison signes par le client. Le chauffeur les prend en
          photo a la livraison ; il y en a 1 par tournee (un meme client peut
          avoir plusieurs tournees s'il y a plusieurs gros camions). On
          deduplique par tourneeId via velo.livraison. */}
      <BlSignesSection velos={client.velos} />

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
              <th className="text-center px-4 py-2 font-medium text-gray-600">Certificat</th>
              <th className="text-center px-4 py-2 font-medium text-gray-600">Photos montage</th>
              <th className="text-center px-4 py-2 font-medium text-gray-600">Monté</th>
              <th className="text-center px-4 py-2 font-medium text-gray-600">Livraison</th>
              <th className="text-center px-4 py-2 font-medium text-gray-600">BL signé</th>
              <th className="text-center px-4 py-2 font-medium text-gray-600">Facturable</th>
              <th className="text-center px-4 py-2 font-medium text-gray-600">Facturé</th>
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
                <td className="text-center px-4 py-2">
                  <StatusBadge ok={v.certificatRecu} />
                </td>
                <td className="text-center px-4 py-2">
                  <PhotoLinks
                    etiquette={v.urlPhotoMontageEtiquette}
                    qrVelo={v.urlPhotoMontageQrVelo}
                    monte={v.photoMontageUrl}
                  />
                </td>
                <td className="text-center px-4 py-2">
                  <StatusBadge ok={!!v.monte} />
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
                <td className="text-center px-4 py-2">
                  {v.urlBlSigne ? (
                    <a
                      href={v.urlBlSigne}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                      title="Voir le BL signé"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6M7 4h10a2 2 0 012 2v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6a2 2 0 012-2z" />
                      </svg>
                    </a>
                  ) : (
                    <StatusBadge ok={false} />
                  )}
                </td>
                <td className="text-center px-4 py-2">
                  <StatusBadge ok={v.facturable} />
                </td>
                <td className="text-center px-4 py-2">
                  <StatusBadge ok={v.facture} />
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
  source,
  validated,
  expired,
  lien,
  saving,
  onToggle,
  onSaveLien,
  onUpload,
  onAutoFetch,
}: {
  step: number;
  label: string;
  description: string;
  source?: string;
  validated: boolean;
  expired?: boolean;
  lien: string;
  saving: boolean;
  onToggle: () => void;
  onSaveLien: (url: string) => void;
  onUpload: (file: File) => void;
  onAutoFetch?: () => void;
}) {
  const [editLien, setEditLien] = useState(lien);
  const [editing, setEditing] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    setEditLien(lien);
  }, [lien]);

  return (
    <div
      className={`rounded-xl border p-4 transition-colors ${
        validated && expired
          ? "bg-orange-50 border-orange-200"
          : validated
          ? "bg-green-50 border-green-200"
          : "bg-white border-gray-200"
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${
            validated && expired
              ? "bg-orange-500 text-white"
              : validated
              ? "bg-green-500 text-white"
              : "bg-gray-200 text-gray-500"
          }`}
        >
          {validated ? (expired ? "!" : "✓") : step}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <h3 className="font-medium text-gray-900">{label}</h3>
            <button
              onClick={onToggle}
              disabled={saving}
              className={`px-3 py-1 text-xs font-medium rounded-lg transition-colors ${
                validated && expired
                  ? "bg-orange-100 text-orange-700 hover:bg-red-100 hover:text-red-700"
                  : validated
                  ? "bg-green-100 text-green-700 hover:bg-red-100 hover:text-red-700"
                  : "bg-blue-600 text-white hover:bg-blue-700"
              } disabled:opacity-50`}
            >
              {saving ? "..." : validated && expired ? "Périmé — renouveler" : validated ? "Validé — annuler ?" : "Valider"}
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            {description}
            {source && <span className="ml-1 text-gray-400">— {source}</span>}
          </p>

          {/* Auto-fetch (parcelle cadastrale) */}
          {onAutoFetch && !validated && (
            <button
              onClick={onAutoFetch}
              disabled={saving}
              className="mt-2 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 rounded-lg transition-colors disabled:opacity-50"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              {saving ? "Recherche en cours..." : "Récupérer automatiquement via cadastre.gouv.fr"}
            </button>
          )}

          {/* Upload ou lien Drive */}
          <div className="mt-3">
            {!editing && !lien && (
              <div className="flex items-center gap-3">
                <label className="text-xs text-green-700 bg-green-50 hover:bg-green-100 px-3 py-1.5 rounded-lg cursor-pointer flex items-center gap-1.5 transition-colors">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  {uploading ? "Envoi..." : "Uploader un fichier"}
                  <input
                    type="file"
                    accept=".pdf,.jpg,.jpeg,.png,.webp"
                    className="hidden"
                    disabled={uploading || saving}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      setUploading(true);
                      await onUpload(file);
                      setUploading(false);
                    }}
                  />
                </label>
                <span className="text-xs text-gray-400">ou</span>
                <button
                  onClick={() => setEditing(true)}
                  className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                  </svg>
                  Coller un lien Drive
                </button>
              </div>
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

// Section "Bons de livraison signes" placee en haut de la fiche client.
// Le chauffeur prend en photo le BL tamponne par le client a la livraison ;
// il y en a 1 par tournee (un client gros peut avoir plusieurs tournees).
// On deduplique via velo.livraison.tourneeId pour eviter les doublons quand
// plusieurs velos partagent la meme livraison.
function BlSignesSection({ velos }: { velos: Velo[] }) {
  const seenTournees = new Set<string>();
  const bls: Array<{ tourneeId: string; datePrevue: string | null; statut: string; urlBlSigne: string | null }> = [];
  for (const v of velos) {
    const liv = v.livraison;
    if (!liv) continue;
    const key = liv.id || `t-${liv.datePrevue || ""}`;
    if (seenTournees.has(key)) continue;
    seenTournees.add(key);
    bls.push({
      tourneeId: (liv as { tourneeId?: string }).tourneeId || liv.id,
      datePrevue: liv.datePrevue,
      statut: liv.statut,
      urlBlSigne: liv.urlBlSigne || null,
    });
  }

  if (bls.length === 0) return null;

  return (
    <div className="bg-white rounded-xl border p-4 mb-6">
      <h2 className="font-semibold text-gray-900 mb-3">📋 Bons de livraison signés</h2>
      <div className="space-y-2">
        {bls.map((b) => (
          <div
            key={b.tourneeId + "-" + (b.datePrevue || "")}
            className={`flex items-center justify-between gap-3 px-3 py-2 rounded-lg border ${
              b.urlBlSigne ? "bg-emerald-50 border-emerald-200" : "bg-gray-50 border-gray-200"
            }`}
          >
            <div className="text-sm">
              <div className="font-medium text-gray-900">
                Tournée du {b.datePrevue ? new Date(b.datePrevue).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "—"}
              </div>
              <div className="text-xs text-gray-500">
                {b.statut === "livree" ? "Livrée" : b.statut === "en_cours" ? "En cours" : b.statut === "planifiee" ? "Planifiée" : b.statut}
                {" · "}Tournée <span className="font-mono">{b.tourneeId}</span>
              </div>
            </div>
            {b.urlBlSigne ? (
              <a
                href={b.urlBlSigne}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-medium text-emerald-700 bg-white border border-emerald-300 rounded-lg px-3 py-1.5 hover:bg-emerald-100 whitespace-nowrap"
              >
                📄 Voir le BL signé
              </a>
            ) : (
              <span className="text-xs text-gray-500 italic whitespace-nowrap">Pas encore tamponné</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// 3 mini-pastilles cliquables pour les photos preuve du workflow montage :
// étiquette carton (E), QR vélo (Q), vélo monté (M). Vert si présente avec lien
// Drive cliquable, gris sinon. Permet de relire la preuve sans quitter la fiche.
function PhotoLinks({
  etiquette,
  qrVelo,
  monte,
}: {
  etiquette?: string | null;
  qrVelo?: string | null;
  monte?: string | null;
}) {
  const items: Array<{ url: string | null | undefined; letter: string; label: string }> = [
    { url: etiquette, letter: "E", label: "Photo étiquette carton" },
    { url: qrVelo, letter: "Q", label: "Photo QR vélo" },
    { url: monte, letter: "M", label: "Photo vélo monté" },
  ];
  return (
    <div className="inline-flex gap-1">
      {items.map((it) =>
        it.url ? (
          <a
            key={it.letter}
            href={it.url}
            target="_blank"
            rel="noopener noreferrer"
            title={it.label}
            className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold hover:bg-emerald-200"
          >
            {it.letter}
          </a>
        ) : (
          <span
            key={it.letter}
            title={it.label + " — non disponible"}
            className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 text-gray-300 text-[10px] font-bold"
          >
            {it.letter}
          </span>
        ),
      )}
    </div>
  );
}
