"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { gasGet, gasPost, gasUpload } from "@/lib/gas";
import { useData, type ClientRow } from "@/lib/data-context";
import MultiDepSelect from "@/components/multi-dep-select";
import AddClientModal from "@/components/add-client-modal";

const ALL_DOC_FIELDS: DocType[] = [
  "devisSignee", "kbisRecu", "attestationRecue", "signatureOk", "inscriptionBicycle", "parcelleCadastrale",
];

export default function ClientsPage() {
  const { clients: allClients, livraisons, loading, refresh } = useData();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [mailClient, setMailClient] = useState<ClientRow | null>(null);
  const [selectedDeps, setSelectedDeps] = useState<string[]>([]);
  const [codePostal, setCodePostal] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showSync, setShowSync] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const nextDeliveryByClient = useMemo(() => {
    const map = new Map<string, { date: string; nbVelos: number; tourneeId?: string | null; mode?: string | null }>();
    for (const l of livraisons) {
      if (!l.clientId || !l.datePrevue) continue;
      if (l.statut === "annulee" || l.statut === "livree") continue;
      const current = map.get(l.clientId);
      const nb = l._count?.velos ?? l.nbVelos ?? 0;
      if (!current || new Date(l.datePrevue) < new Date(current.date)) {
        map.set(l.clientId, { date: l.datePrevue, nbVelos: nb, tourneeId: l.tourneeId, mode: l.mode });
      } else if (current && new Date(l.datePrevue).getTime() === new Date(current.date).getTime()) {
        current.nbVelos += nb;
      }
    }
    return map;
  }, [livraisons]);

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
        (c) => ALL_DOC_FIELDS.some((f) => !c[f as keyof typeof c])
      );
    } else if (filter === "prets") {
      result = result.filter(
        (c) => ALL_DOC_FIELDS.every((f) => c[f as keyof typeof c])
      );
    } else if (filter === "livraison_prog") {
      result = result.filter((c) => nextDeliveryByClient.has(c.id));
    } else if (filter === "livraison_non_prog") {
      result = result.filter((c) => !nextDeliveryByClient.has(c.id) && (c.stats.totalVelos - c.stats.livres) > 0);
    }
    return result;
  }, [allClients, search, filter, nextDeliveryByClient]);

  const departements = Array.from(
    new Set(
      clients
        .map((c) => (c.departement == null || c.departement === "" ? null : String(c.departement)))
        .filter((d): d is string => d !== null)
    )
  ).sort((a, b) => a.localeCompare(b));

  const cpFilter = codePostal.trim();
  const filteredClients = clients.filter((c) => {
    if (selectedDeps.length > 0 && !(c.departement != null && selectedDeps.includes(String(c.departement)))) {
      return false;
    }
    if (cpFilter && !(c.codePostal != null && String(c.codePostal).startsWith(cpFilter))) {
      return false;
    }
    return true;
  });

  const exportCSV = () => {
    const docHeaders = ALL_DOC_FIELDS.map((f) => docLabels[f]);
    const headers = ["Entreprise", "Contact", "Email", "Téléphone", "Ville", "Département", "SIREN", "Apporteur", "Vélos commandés", "Vélos livrés", "Certificats", "Facturables", "Facturés", ...docHeaders];
    const rows = filteredClients.map((c) => [
      c.entreprise, c.contact || "", c.email || "", c.telephone || "", c.ville || "", c.departement || "", c.siren || "", c.apporteur || "",
      c.stats.totalVelos, c.stats.livres, c.stats.certificats, c.stats.facturables, c.stats.factures,
      ...ALL_DOC_FIELDS.map((f) => (c[f as keyof typeof c] ? "Oui" : "Non")),
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
          <p className="text-gray-500 mt-1">
            {filteredClients.length} clients
            {selectedDeps.length > 0 && ` (dép. ${[...selectedDeps].sort((a, b) => a.localeCompare(b)).join(", ")})`}
            {cpFilter && ` (CP ${cpFilter})`}
          </p>
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
            onClick={() => setShowSync(true)}
            className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm"
          >
            Synchroniser Drive
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
        <MultiDepSelect
          value={selectedDeps}
          onChange={setSelectedDeps}
          options={departements}
          className="sm:w-56"
          placeholder="Tous les dép."
        />
        <input
          type="text"
          inputMode="numeric"
          value={codePostal}
          onChange={(e) => setCodePostal(e.target.value)}
          placeholder="Code postal (ex. 75010)"
          className="sm:w-48 px-4 py-2 border border-gray-300 rounded-lg text-sm"
        />
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="px-4 py-2 border border-gray-300 rounded-lg text-sm"
        >
          <option value="all">Tous</option>
          <option value="docs_manquants">Documents manquants</option>
          <option value="prets">Dossiers complets</option>
          <option value="livraison_prog">Livraison programmée</option>
          <option value="livraison_non_prog">À programmer (vélos restants)</option>
        </select>
      </div>

      <BulkActionBar
        selectedIds={selectedIds}
        onClear={() => setSelectedIds(new Set())}
        busy={bulkBusy}
        onApply={async (data) => {
          setBulkBusy(true);
          // gasUpload (POST body) au lieu de gasPost (URL params) car l'URL
          // dépasse vite la limite avec >100 IDs.
          await gasUpload("bulkUpdateClients", { clientIds: [...selectedIds], data });
          await refresh("clients");
          setBulkBusy(false);
        }}
      />

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto">
        <table className="w-full min-w-[800px] text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="px-3 py-3 w-8">
                <input
                  type="checkbox"
                  aria-label="Sélectionner tous les clients filtrés"
                  checked={filteredClients.length > 0 && filteredClients.every((c) => selectedIds.has(c.id))}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedIds(new Set([...selectedIds, ...filteredClients.map((c) => c.id)]));
                    } else {
                      const ids = new Set(selectedIds);
                      filteredClients.forEach((c) => ids.delete(c.id));
                      setSelectedIds(ids);
                    }
                  }}
                />
              </th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Entreprise</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Ville</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Dép.</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Vélos</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Livraison</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Dossier</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Devis</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Kbis</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Liasse</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Livrés</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Bicycle</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Facturables</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Mail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filteredClients.map((c) => (
              <tr key={c.id} className={`hover:bg-gray-50 ${selectedIds.has(c.id) ? "bg-blue-50/50" : ""}`}>
                <td className="px-3 py-3 w-8">
                  <input
                    type="checkbox"
                    aria-label={`Sélectionner ${c.entreprise}`}
                    checked={selectedIds.has(c.id)}
                    onChange={(e) => {
                      const ids = new Set(selectedIds);
                      if (e.target.checked) ids.add(c.id);
                      else ids.delete(c.id);
                      setSelectedIds(ids);
                    }}
                  />
                </td>
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
                  <VelosCell livres={c.stats.livres} total={c.stats.totalVelos} planifies={c.stats.planifies ?? 0} />
                </td>
                <td className="text-center px-4 py-3 text-xs">
                  <DeliveryCell next={nextDeliveryByClient.get(c.id)} />
                </td>
                <td className="px-4 py-3">
                  <DocProgress client={c as unknown as Record<string, unknown>} />
                </td>
                <td className="text-center px-4 py-3">
                  <DocCell ok={c.devisSignee} lien={c.devisLien ?? null} clientId={c.id} docType="devisSignee" onChange={() => refresh("clients")} />
                </td>
                <td className="text-center px-4 py-3">
                  {(() => { const w = kbisWarning(c); return <DocCell ok={c.kbisRecu} lien={c.kbisLien ?? null} clientId={c.id} docType="kbisRecu" onChange={() => refresh("clients")} warning={w.warn} warningTitle={w.title} />; })()}
                </td>
                <td className="text-center px-4 py-3">
                  {(() => { const w = liasseWarning(c); return <DocCell ok={c.attestationRecue} lien={c.attestationLien ?? null} clientId={c.id} docType="attestationRecue" onChange={() => refresh("clients")} warning={w.warn} warningTitle={w.title} />; })()}
                </td>
                <td className="text-center px-4 py-3">
                  <LivresDot livres={c.stats.livres} total={c.stats.totalVelos} planifies={c.stats.planifies ?? 0} />
                </td>
                <td className="text-center px-4 py-3">
                  <DocCell ok={c.inscriptionBicycle} lien={c.bicycleLien ?? null} clientId={c.id} docType="inscriptionBicycle" onChange={() => refresh("clients")} />
                </td>
                <td className="text-center px-4 py-3">
                  <span className={c.stats.facturables > 0 ? "text-amber-600 font-medium" : ""}>
                    {c.stats.facturables}
                  </span>
                </td>
                <td className="text-center px-4 py-3">
                  <button
                    type="button"
                    onClick={() => setMailClient(c)}
                    disabled={!c.email}
                    title={c.email ? `Envoyer un mail de rappel à ${c.email}` : "Pas d'email"}
                    className="text-gray-500 hover:text-blue-600 disabled:opacity-30 disabled:cursor-not-allowed"
                    aria-label="Envoyer un mail"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="5" width="18" height="14" rx="2" />
                      <path d="m3 7 9 6 9-6" />
                    </svg>
                  </button>
                </td>
              </tr>
            ))}
            {filteredClients.length === 0 && (
              <tr>
                <td colSpan={14} className="px-4 py-12 text-center text-gray-400">
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
      {showSync && <SyncDriveModal onClose={() => { setShowSync(false); refresh("clients"); }} />}
      {mailClient && (
        <RappelMailModal
          client={mailClient}
          delivery={nextDeliveryByClient.get(mailClient.id)}
          onClose={() => setMailClient(null)}
        />
      )}
    </div>
  );
}

function DeliveryCell({ next }: { next?: { date: string; nbVelos: number; mode?: string | null } }) {
  if (!next) return <span className="text-gray-300">—</span>;
  const d = new Date(next.date);
  const label = d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "2-digit" });
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const isPast = d < now;
  return (
    <div className={`leading-tight ${isPast ? "text-red-600" : "text-blue-700"}`}>
      <div className="font-medium">{label}</div>
      <div className="text-[10px] text-gray-500">{next.nbVelos}v{next.mode ? ` · ${next.mode}` : ""}</div>
    </div>
  );
}

const DOCS_RAPPEL: { key: keyof ClientRow; label: string }[] = [
  { key: "devisSignee", label: "Devis signé" },
  { key: "kbisRecu", label: "Kbis récent (≤ 3 mois)" },
  { key: "attestationRecue", label: "Liasse fiscale avec effectif" },
  { key: "signatureOk", label: "Signature de l'engagement" },
  { key: "inscriptionBicycle", label: "Inscription plateforme Bicycle" },
  { key: "parcelleCadastrale", label: "Parcelle cadastrale" },
];

function RappelMailModal({
  client,
  delivery,
  onClose,
}: {
  client: ClientRow;
  delivery?: { date: string; nbVelos: number; mode?: string | null };
  onClose: () => void;
}) {
  const missing = DOCS_RAPPEL.filter((d) => !client[d.key]);
  const dateObj = delivery ? new Date(delivery.date) : null;
  const dateLabel = dateObj
    ? dateObj.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
    : null;
  const shortDateLabel = dateObj
    ? dateObj.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })
    : null;
  const deadline48h = dateObj ? new Date(dateObj.getTime() - 48 * 3600 * 1000) : null;
  const deadlineLabel = deadline48h
    ? deadline48h.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
    : null;

  const defaultSubject = shortDateLabel
    ? `Vélos Cargo — livraison du ${shortDateLabel} : documents à fournir sous 48h`
    : `Vélos Cargo — finalisation de votre dossier`;

  const blocManquants = missing.length > 0
    ? [
        ``,
        `Pour que nous puissions la maintenir, votre dossier CEE doit être complet.`,
        `Il nous manque à ce jour les documents suivants :`,
        ``,
        ...missing.map((m) => `  • ${m.label}`),
      ]
    : [
        ``,
        `Votre dossier est à ce jour complet de notre côté. Aucune action n'est requise, nous vous confirmerons la fenêtre de passage la veille.`,
      ];

  const blocDeadline = (dateObj && missing.length > 0)
    ? [
        ``,
        `⚠ Ces pièces doivent impérativement nous parvenir au plus tard 48 heures avant la date de livraison, soit le ${deadlineLabel}.`,
        ``,
        `Sans réception de l'intégralité des documents dans ce délai, la livraison sera automatiquement reportée — sans exception, et la nouvelle date ne pourra être repositionnée qu'en fonction de nos tournées disponibles. Ce délai nous est imposé par le montage du dossier CEE, il n'est pas négociable.`,
        ``,
        `Vous pouvez nous répondre directement à ce mail en y joignant les documents, ou les déposer sur votre espace Drive habituel.`,
      ]
    : [];

  const defaultBody = [
    `Bonjour${client.contact ? " " + client.contact : ""},`,
    ``,
    dateLabel
      ? `Votre livraison de ${delivery!.nbVelos} vélo${delivery!.nbVelos > 1 ? "s" : ""} cargo est programmée le ${dateLabel}.`
      : `Nous finalisons la préparation de votre dossier Vélos Cargo en vue de la livraison.`,
    ...blocManquants,
    ...blocDeadline,
    ``,
    `Rappel du process :`,
    `  1. Livraison des vélos sur votre site et vérification contradictoire.`,
    `  2. Signature du procès-verbal de livraison.`,
    `  3. Inscription sur la plateforme Bicycle et transmission de votre certificat d'économies d'énergie.`,
    ``,
    `Si un document manquant pose question (pièce introuvable, besoin d'un modèle, doute sur la version demandée), appelez-nous dès aujourd'hui : il est toujours plus simple d'anticiper que de décaler une tournée.`,
    ``,
    `Cordialement,`,
    `L'équipe Artisans Verts Energy`,
  ].join("\n");

  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState(defaultBody);

  const FROM_EMAIL = "velos-cargo@artisansverts.energy";
  const gmailUrl = `https://mail.google.com/mail/?authuser=${encodeURIComponent(FROM_EMAIL)}&view=cm&fs=1&to=${encodeURIComponent(client.email ?? "")}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  const copyBody = async () => {
    try {
      await navigator.clipboard.writeText(body);
    } catch {}
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-3">
          <div>
            <h2 className="text-lg font-semibold">Rappel livraison — {client.entreprise}</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              De : <span className="font-mono">{FROM_EMAIL}</span> → {client.email || <span className="text-red-600">aucun email renseigné</span>}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        {missing.length > 0 && (
          <div className="mb-3 bg-amber-50 border border-amber-200 rounded-lg p-2 text-xs text-amber-800">
            {missing.length} document{missing.length > 1 ? "s" : ""} manquant{missing.length > 1 ? "s" : ""} :
            {" " + missing.map((m) => m.label).join(", ")}
          </div>
        )}

        <label className="block text-xs font-medium text-gray-600 mb-1">Objet</label>
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="w-full px-3 py-2 border rounded-lg text-sm mb-3"
        />

        <label className="block text-xs font-medium text-gray-600 mb-1">Corps du mail</label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={14}
          className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
        />

        <div className="flex justify-between items-center gap-3 mt-4">
          <button
            type="button"
            onClick={copyBody}
            className="px-3 py-1.5 text-sm bg-gray-100 rounded-lg hover:bg-gray-200"
          >
            Copier le corps
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800"
            >
              Annuler
            </button>
            <a
              href={gmailUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setTimeout(onClose, 200)}
              title={`Ouvre Gmail sur ${FROM_EMAIL}. Si non connecté, Google demandera la connexion.`}
              className={`px-4 py-2 text-sm rounded-lg text-white ${client.email ? "bg-blue-600 hover:bg-blue-700" : "bg-gray-400 pointer-events-none"}`}
            >
              Ouvrir dans Gmail (velos-cargo@)
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

function DocProgress({ client }: { client: Record<string, unknown> }) {
  const count = ALL_DOC_FIELDS.filter((f) => (client as Record<string, unknown>)[f]).length;
  const total = ALL_DOC_FIELDS.length;
  const pct = (count / total) * 100;
  const color = count === total ? "bg-green-500" : count >= 10 ? "bg-blue-500" : count >= 5 ? "bg-amber-500" : count >= 1 ? "bg-orange-400" : "bg-gray-300";
  return (
    <div className="flex items-center gap-2 min-w-[80px]">
      <div className="flex-1 bg-gray-200 rounded-full h-2">
        <div className={`${color} h-2 rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-500 whitespace-nowrap">{count}/{total}</span>
    </div>
  );
}

function BulkActionBar({
  selectedIds,
  onClear,
  onApply,
  busy,
}: {
  selectedIds: Set<string>;
  onClear: () => void;
  onApply: (data: Record<string, boolean>) => void | Promise<void>;
  busy: boolean;
}) {
  if (selectedIds.size === 0) return null;
  const FIELDS: { key: string; label: string }[] = ALL_DOC_FIELDS.map((f) => ({ key: f, label: docLabels[f] }));
  const setAll = (val: boolean) => {
    const data: Record<string, boolean> = {};
    FIELDS.forEach((f) => (data[f.key] = val));
    onApply(data);
  };
  const setOne = (field: string, val: boolean) => {
    onApply({ [field]: val });
  };
  return (
    <div className="sticky top-0 z-30 mb-3 bg-blue-600 text-white rounded-lg shadow-md px-4 py-2 flex flex-wrap items-center gap-2">
      <span className="font-medium">{selectedIds.size} sélectionné{selectedIds.size > 1 ? "s" : ""}</span>
      <span className="hidden sm:inline text-blue-200">·</span>
      <button
        onClick={() => setAll(true)}
        disabled={busy}
        className="px-2 py-1 bg-emerald-500 rounded hover:bg-emerald-600 text-xs font-medium disabled:opacity-50"
      >
        ✓ Tout cocher
      </button>
      <button
        onClick={() => setAll(false)}
        disabled={busy}
        className="px-2 py-1 bg-red-500 rounded hover:bg-red-600 text-xs font-medium disabled:opacity-50"
      >
        ✗ Tout décocher
      </button>
      <span className="hidden sm:inline text-blue-200">|</span>
      {FIELDS.map((f) => (
        <span key={f.key} className="inline-flex items-center gap-0.5">
          <span className="text-xs">{f.label}</span>
          <button
            onClick={() => setOne(f.key, true)}
            disabled={busy}
            title={`Cocher ${f.label} pour les ${selectedIds.size} sélectionnés`}
            className="px-1.5 py-0.5 bg-white/20 hover:bg-emerald-500 rounded text-[11px] disabled:opacity-50"
          >
            ✓
          </button>
          <button
            onClick={() => setOne(f.key, false)}
            disabled={busy}
            title={`Décocher ${f.label} pour les ${selectedIds.size} sélectionnés`}
            className="px-1.5 py-0.5 bg-white/20 hover:bg-red-500 rounded text-[11px] disabled:opacity-50"
          >
            ✗
          </button>
        </span>
      ))}
      <span className="ml-auto" />
      {busy && <span className="text-xs">Mise à jour…</span>}
      <button
        onClick={onClear}
        disabled={busy}
        className="px-2 py-1 bg-white/10 hover:bg-white/20 rounded text-xs disabled:opacity-50"
      >
        Désélectionner
      </button>
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

function VelosCell({ livres, total, planifies }: { livres: number; total: number; planifies: number }) {
  const reste = Math.max(0, total - livres - planifies);
  return (
    <div className="leading-tight" title={`${livres} livrés · ${planifies} planifiés · ${reste} à planifier (sur ${total})`}>
      <div>{livres}/{total}</div>
      {planifies > 0 && (
        <div className="text-[10px] font-normal text-orange-600">+{planifies} planifié{planifies > 1 ? "s" : ""}</div>
      )}
    </div>
  );
}

function extractDriveId(url: string): string | null {
  const m1 = url.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/);
  if (m1) return m1[1];
  const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (m2) return m2[1];
  const m3 = url.match(/\/document\/d\/([a-zA-Z0-9_-]{10,})/);
  if (m3) return m3[1];
  return null;
}

type DocType = "devisSignee" | "kbisRecu" | "attestationRecue" | "inscriptionBicycle" | "signatureOk" | "parcelleCadastrale";

function DocCell({
  ok,
  lien,
  clientId,
  docType,
  onChange,
  warning,
  warningTitle,
}: {
  ok: boolean;
  lien: string | null;
  clientId: string;
  docType: DocType;
  onChange: () => void;
  warning?: boolean;
  warningTitle?: string;
}) {
  const [showUpload, setShowUpload] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const fileId = lien ? extractDriveId(lien) : null;
  const previewUrl = fileId ? `https://drive.google.com/file/d/${fileId}/preview` : null;
  const downloadUrl = fileId ? `https://drive.google.com/uc?export=download&id=${fileId}` : null;

  if (!ok || !lien) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowUpload(true)}
          title="Pas encore de document — cliquer pour uploader"
          className="inline-block w-3 h-3 rounded-full bg-red-400 hover:bg-red-500 hover:scale-125 transition-all cursor-pointer"
          aria-label="Uploader un document"
        />
        {showUpload && (
          <UploadDocModal
            clientId={clientId}
            docType={docType}
            onClose={() => setShowUpload(false)}
            onDone={() => { setShowUpload(false); onChange(); }}
          />
        )}
      </>
    );
  }

  const dotColor = warning
    ? "bg-orange-400 hover:bg-orange-500"
    : "bg-green-500 hover:bg-green-600";

  return (
    <>
      <button
        type="button"
        onClick={() => setShowPreview(true)}
        title={warningTitle || "Cliquer pour aperçu / télécharger"}
        className={`inline-block w-3 h-3 rounded-full ${dotColor} hover:scale-125 transition-all cursor-pointer`}
        aria-label="Voir le document"
      />
      {showPreview && (
        <PreviewDocModal
          previewUrl={previewUrl}
          downloadUrl={downloadUrl}
          openUrl={lien}
          onClose={() => setShowPreview(false)}
          onReplace={() => { setShowPreview(false); setShowUpload(true); }}
        />
      )}
      {showUpload && (
        <UploadDocModal
          clientId={clientId}
          docType={docType}
          onClose={() => setShowUpload(false)}
          onDone={() => { setShowUpload(false); onChange(); }}
        />
      )}
    </>
  );
}

const docLabels: Record<DocType, string> = {
  devisSignee: "Devis",
  kbisRecu: "Kbis",
  attestationRecue: "Liasse fiscale",
  signatureOk: "Signature",
  inscriptionBicycle: "Bicycle",
  parcelleCadastrale: "Parcelle",
};

function isDateOlderThan(dateStr: string | null | undefined, refDateStr: string | null | undefined, months: number): boolean {
  if (!dateStr) return true;
  const docDate = new Date(dateStr + "T00:00:00");
  const ref = refDateStr ? new Date(refDateStr + "T00:00:00") : new Date();
  const limit = new Date(ref);
  limit.setMonth(limit.getMonth() - months);
  return docDate < limit;
}

function kbisWarning(c: { kbisRecu: boolean; kbisDate?: string | null; dateEngagement?: string | null }): { warn: boolean; title: string } {
  if (!c.kbisRecu) return { warn: false, title: "" };
  if (!c.kbisDate) return { warn: true, title: "Date du KBIS non renseignée" };
  if (isDateOlderThan(c.kbisDate, c.dateEngagement, 3)) {
    return { warn: true, title: `KBIS de plus de 3 mois (${c.kbisDate})` };
  }
  return { warn: false, title: "" };
}

function liasseWarning(c: { attestationRecue: boolean; liasseFiscaleDate?: string | null; dateEngagement?: string | null; effectifMentionne: boolean }): { warn: boolean; title: string } {
  if (!c.attestationRecue) return { warn: false, title: "" };
  const reasons: string[] = [];
  if (!c.liasseFiscaleDate) {
    reasons.push("Date du document non renseignée");
  } else if (isDateOlderThan(c.liasseFiscaleDate, c.dateEngagement, 12)) {
    reasons.push(`Document de plus d'1 an (${c.liasseFiscaleDate})`);
  }
  if (!c.effectifMentionne) {
    reasons.push("Nombre de salariés non mentionné");
  }
  return { warn: reasons.length > 0, title: reasons.join(" · ") };
}

function UploadDocModal({
  clientId,
  docType,
  onClose,
  onDone,
}: {
  clientId: string;
  docType: DocType;
  onClose: () => void;
  onDone: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const fileData = await fileToBase64(file);
      const r = await gasPost("uploadDoc", {
        clientId,
        docType,
        fileName: file.name,
        fileData,
        mimeType: file.type || "application/pdf",
      });
      if (r.error) setError(r.error);
      else onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur upload");
    }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-2">Uploader « {docLabels[docType]} »</h2>
        <p className="text-sm text-gray-500 mb-4">
          Le fichier sera classé directement dans le bon sous-dossier Drive et la pastille passera au vert.
        </p>
        <input
          type="file"
          accept="application/pdf,image/*"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="w-full text-sm mb-3"
        />
        {file && <div className="text-xs text-gray-500 mb-3">Fichier : {file.name} ({Math.round(file.size / 1024)} Ko)</div>}
        {error && <div className="bg-red-50 border border-red-200 rounded p-2 text-xs text-red-700 mb-3">{error}</div>}
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600">Annuler</button>
          <button
            onClick={submit}
            disabled={!file || busy}
            className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 disabled:opacity-50"
          >
            {busy ? "Envoi…" : "Uploader"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PreviewDocModal({
  previewUrl,
  openUrl,
  onClose,
  onReplace,
}: {
  previewUrl: string | null;
  downloadUrl: string | null;
  openUrl: string;
  onClose: () => void;
  onReplace: () => void;
}) {
  // Note : on n'expose plus de bouton "Télécharger" direct. Le lien
  // drive.google.com/uc?export=download échoue en 403 si le fichier n'a
  // pas été partagé en ANYONE_WITH_LINK (cas des fichiers existants pas
  // uploadés via le CRM). À la place, on ouvre Drive : le viewer Drive
  // a son propre bouton ⬇ qui marche dans tous les cas (cookies + scope).
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl p-4 flex flex-col" style={{ width: "calc(100vw - 2rem)", height: "calc(100vh - 2rem)", maxWidth: "100%", maxHeight: "100%" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-2">
          <h2 className="text-lg font-semibold">Aperçu du document</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>
        </div>
        <div className="flex-1 min-h-0 bg-gray-100 rounded overflow-hidden">
          {previewUrl ? (
            <iframe src={previewUrl} className="w-full h-full border-0" allow="autoplay" />
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">
              Aperçu impossible (lien Drive non reconnu).{" "}
              <a className="text-blue-600 underline ml-1" href={openUrl} target="_blank" rel="noopener noreferrer">Ouvrir directement</a>
            </div>
          )}
        </div>
        <div className="flex justify-between items-center mt-3 gap-2">
          <button onClick={onReplace} className="px-3 py-1.5 text-sm border rounded text-gray-700 hover:bg-gray-50">
            Remplacer
          </button>
          <a
            href={openUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Ouvre Drive — le bouton ⬇ natif te permet ensuite de télécharger"
            className="px-3 py-1.5 text-sm bg-green-600 text-white rounded hover:bg-green-700"
          >
            Ouvrir dans Drive (puis ⬇)
          </a>
        </div>
      </div>
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // result = "data:mime;base64,xxxx" → on prend juste le base64
      const idx = result.indexOf(",");
      resolve(idx === -1 ? result : result.slice(idx + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function LivresDot({ livres, total, planifies }: { livres: number; total: number; planifies: number }) {
  if (total === 0) {
    return <span className="inline-block w-3 h-3 rounded-full bg-gray-300" title="Aucun vélo commandé" />;
  }
  const tousLivres = livres === total;
  const partielLivre = livres > 0 && !tousLivres;
  const planifie = !tousLivres && planifies > 0;

  let cls = "bg-red-400";
  if (tousLivres) cls = "bg-green-500";
  else if (partielLivre) cls = "bg-amber-500";
  else if (planifie) cls = "bg-orange-400 ring-2 ring-orange-200";

  const tooltip = `${livres}/${total} livrés${planifies > 0 ? ` · +${planifies} planifié${planifies > 1 ? "s" : ""}` : ""}`;
  return <span className={`inline-block w-3 h-3 rounded-full ${cls}`} title={tooltip} />;
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

interface SyncReport {
  updates?: { client: string; docType: string; file: string; by: string }[];
  orphans?: string[];
  fuzzyMatched?: { folder: string; matched: string; by: string }[];
  ambiguousFolders?: { folder: string; wouldMatch: string; strategy: string; nbCandidates: number }[];
  unknowns?: { folder: string; file: string }[];
  skippedFiles?: { folder: string; file: string; error: string }[];
  skippedFolders?: { folder: string; error: string }[];
  timeoutHit?: boolean;
  elapsedMs?: number;
  aiClassified?: number;
  aiQueueSize?: number;
  filesSeen?: number;
  error?: string;
  fatalError?: string | null;
}

type AiReason = "ok" | "noKey" | "unsupportedMime" | "tooBig" | "httpError" | "labelOther" | "noClientMatch" | "ambiguous" | "exception";

interface ClassifyProgress {
  total: number;
  processed: number;
  classified: number;
  running: boolean;
  done: boolean;
  reasons: Record<AiReason, number>;
}

const AI_REASON_LABELS: Record<AiReason, string> = {
  ok: "OK",
  noKey: "Clé Gemini absente",
  unsupportedMime: "Format non supporté (≠ PDF/image)",
  tooBig: "Fichier > 18 Mo",
  httpError: "Erreur HTTP Gemini",
  labelOther: "Classé AUTRE par l'IA",
  noClientMatch: "Pas de client matché",
  ambiguous: "Ambigu (plusieurs dossiers visent le même client)",
  exception: "Exception inattendue",
};

type GeminiTestResult = {
  apiKeyPresent: boolean;
  apiKeyLength: number;
  model: string;
  urlObfuscated: string | null;
  testMode?: string | null;
  httpCode: number | null;
  body: string | null;
  label: string | null;
  error: string | null;
};

function SyncDriveModal({ onClose }: { onClose: () => void }) {
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [ai, setAi] = useState<ClassifyProgress | null>(null);
  const [geminiTest, setGeminiTest] = useState<GeminiTestResult | null>(null);
  const [geminiTesting, setGeminiTesting] = useState(false);

  const runGeminiTest = async () => {
    setGeminiTesting(true);
    setGeminiTest(null);
    try {
      const data = await gasGet("testGemini", {});
      setGeminiTest(data);
    } catch (err) {
      setGeminiTest({
        apiKeyPresent: false, apiKeyLength: 0, model: "", urlObfuscated: null,
        httpCode: null, body: null, label: null,
        error: err instanceof Error ? err.message : "Erreur inconnue",
      });
    }
    setGeminiTesting(false);
  };

  const run = async () => {
    setLoading(true);
    setAi(null);
    try {
      const data = await gasPost("syncDrive", {});
      setReport(data);
    } catch (err) {
      setReport({ error: err instanceof Error ? err.message : "Erreur inconnue" });
    }
    setLoading(false);
  };

  const runAi = async () => {
    const total = report?.aiQueueSize ?? report?.unknowns?.length ?? 0;
    if (total === 0) return;
    const emptyReasons: Record<AiReason, number> = {
      ok: 0, noKey: 0, unsupportedMime: 0, tooBig: 0, httpError: 0, labelOther: 0, noClientMatch: 0, ambiguous: 0, exception: 0,
    };
    setAi({ total, processed: 0, classified: 0, running: true, done: false, reasons: { ...emptyReasons } });

    let processed = 0;
    let classified = 0;
    let remaining = total;
    const aggReasons = { ...emptyReasons };

    while (remaining > 0) {
      try {
        const data = await gasGet("classifyBatch", { limit: "20" });
        processed += data.processed ?? 0;
        classified += data.classified ?? 0;
        remaining = data.remaining ?? 0;
        if (data.reasons) {
          for (const k of Object.keys(aggReasons) as AiReason[]) {
            aggReasons[k] += data.reasons[k] ?? 0;
          }
        }
        setAi({ total, processed, classified, running: remaining > 0, done: remaining === 0, reasons: { ...aggReasons } });
        if ((data.processed ?? 0) === 0) break;
      } catch (err) {
        setAi({ total, processed, classified, running: false, done: false, reasons: { ...aggReasons } });
        console.error(err);
        return;
      }
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-semibold mb-2">Synchroniser les documents Drive</h2>
        <p className="text-sm text-gray-500 mb-4">
          Scanne les sous-dossiers de <strong>DOSSIER VELO</strong>, associe chaque fichier au client
          correspondant et coche automatiquement les 14 cases du dossier CEE.
          Les fichiers non reconnus par leur nom sont classés par IA.
        </p>

        {!report && !loading && (
          <div className="flex gap-2">
            <button
              onClick={run}
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm"
            >
              Lancer la synchronisation
            </button>
            <button
              onClick={runGeminiTest}
              disabled={geminiTesting}
              className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm disabled:opacity-50"
            >
              {geminiTesting ? "Test en cours…" : "Tester Gemini"}
            </button>
          </div>
        )}

        {geminiTest && (
          <div className={`mt-3 border rounded-lg p-3 text-xs font-mono whitespace-pre-wrap break-all ${
            geminiTest.httpCode === 200
              ? "bg-emerald-50 border-emerald-200 text-emerald-900"
              : "bg-red-50 border-red-200 text-red-900"
          }`}>
            <div className="font-sans font-semibold mb-2 text-sm">
              {geminiTest.httpCode === 200 ? "✓ Gemini OK" : `✗ Gemini KO (HTTP ${geminiTest.httpCode ?? "—"})`}
            </div>
            <div>apiKey : {geminiTest.apiKeyPresent ? `présente (${geminiTest.apiKeyLength} chars)` : "ABSENTE"}</div>
            <div>model : {geminiTest.model}</div>
            {geminiTest.testMode && <div>mode : {geminiTest.testMode}</div>}
            {geminiTest.urlObfuscated && <div>url : {geminiTest.urlObfuscated}</div>}
            <div>httpCode : {geminiTest.httpCode ?? "—"}</div>
            {geminiTest.label && <div>label IA : {geminiTest.label}</div>}
            {geminiTest.error && <div className="mt-2">error : {geminiTest.error}</div>}
            {geminiTest.body && (
              <details className="mt-2">
                <summary className="cursor-pointer font-sans">body réponse</summary>
                <pre className="mt-1">{geminiTest.body}</pre>
              </details>
            )}
          </div>
        )}

        {loading && (
          <p className="text-sm text-gray-500">Synchronisation en cours… (peut prendre quelques minutes)</p>
        )}

        {report && report.error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
            Erreur : {report.error}
          </div>
        )}

        {report && !report.error && (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Fichiers vus" value={report.filesSeen ?? 0} />
              <Stat label="Mises à jour" value={report.updates?.length ?? 0} />
              <Stat label="Classés par IA" value={report.aiClassified ?? 0} />
            </div>

            {report.orphans && report.orphans.length > 0 && (
              <details className="border rounded-lg p-2">
                <summary className="cursor-pointer font-medium">
                  Dossiers Drive sans client correspondant ({report.orphans.length})
                </summary>
                <ul className="mt-2 text-xs text-gray-600 space-y-1">
                  {report.orphans.map((o) => <li key={o}>• {o}</li>)}
                </ul>
              </details>
            )}

            {(report.aiQueueSize ?? 0) > 0 && !ai && (
              <div className="border border-purple-200 bg-purple-50 rounded-lg p-3">
                <p className="text-sm text-purple-900 mb-2">
                  {report.aiQueueSize} fichiers non reconnus par leur nom — peuvent être classifiés par Gemini.
                </p>
                <button
                  onClick={runAi}
                  className="px-3 py-1.5 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm"
                >
                  Classer par IA ({report.aiQueueSize})
                </button>
              </div>
            )}

            {ai && (
              <div className="border border-purple-200 bg-purple-50 rounded-lg p-3 text-sm">
                <div className="flex justify-between mb-1">
                  <span>Classification IA</span>
                  <span className="font-mono">
                    {ai.processed}/{ai.total} traités · {ai.classified} classifiés
                  </span>
                </div>
                <div className="w-full bg-purple-200 rounded-full h-2">
                  <div
                    className="bg-purple-600 h-2 rounded-full transition-all"
                    style={{ width: `${ai.total ? (ai.processed / ai.total) * 100 : 0}%` }}
                  />
                </div>
                {ai.done && <p className="text-xs mt-2 text-purple-700">Terminé.</p>}
                {ai.running && <p className="text-xs mt-2 text-purple-700">En cours…</p>}

                {ai.reasons && (ai.processed > 0) && (
                  <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                    {(Object.keys(ai.reasons) as AiReason[])
                      .filter((k) => ai.reasons[k] > 0)
                      .map((k) => (
                        <div key={k} className="flex justify-between">
                          <span className={k === "ok" ? "text-emerald-700" : k === "noKey" ? "text-red-700 font-medium" : "text-purple-800"}>
                            {AI_REASON_LABELS[k]}
                          </span>
                          <span className="font-mono">{ai.reasons[k]}</span>
                        </div>
                      ))}
                  </div>
                )}
                {ai.reasons?.noKey && ai.reasons.noKey > 0 && (
                  <p className="mt-2 text-xs text-red-700">
                    💡 Renseigner <code>GEMINI_API_KEY</code> dans Project Settings → Script Properties.
                  </p>
                )}
              </div>
            )}

            {report.fatalError && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
                ⚠ Le scan a planté en cours de route ({report.fatalError}). Le rapport ci-dessous est partiel.
              </div>
            )}

            {report.ambiguousFolders && report.ambiguousFolders.length > 0 && (
              <details className="border border-orange-300 bg-orange-50 rounded-lg p-2" open>
                <summary className="cursor-pointer font-medium text-orange-900">
                  ⚠ Ambiguïtés non résolues ({report.ambiguousFolders.length}) — aucun document n&apos;a été associé
                </summary>
                <p className="mt-2 text-xs text-orange-800">
                  Plusieurs dossiers Drive viseraient le même client en fuzzy (ex. dossiers d&apos;agences distinctes).
                  Pour ne pas mélanger les pinceaux, on n&apos;associe rien automatiquement. Renomme tes dossiers
                  pour qu&apos;ils matchent un nom client distinct, ou ajoute les agences dans la sheet Clients.
                </p>
                <ul className="mt-2 text-xs text-orange-800 space-y-1 max-h-48 overflow-y-auto">
                  {report.ambiguousFolders.map((m, i) => (
                    <li key={i}>
                      • <span className="font-mono">{m.folder}</span> → conflit avec {m.nbCandidates - 1} autre{m.nbCandidates - 1 > 1 ? "s" : ""} sur le client <span className="font-medium">{m.wouldMatch}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {report.fuzzyMatched && report.fuzzyMatched.length > 0 && (
              <details className="border border-amber-200 bg-amber-50 rounded-lg p-2">
                <summary className="cursor-pointer font-medium text-amber-900">
                  Dossiers matchés en fuzzy ({report.fuzzyMatched.length})
                </summary>
                <ul className="mt-2 text-xs text-amber-800 space-y-1">
                  {report.fuzzyMatched.map((m, i) => (
                    <li key={i}>• {m.folder} → <span className="font-medium">{m.matched}</span> <span className="text-amber-600">({m.by})</span></li>
                  ))}
                </ul>
              </details>
            )}

            {(report.skippedFiles?.length || report.skippedFolders?.length || report.timeoutHit) && (
              <details className="border border-red-200 bg-red-50 rounded-lg p-2">
                <summary className="cursor-pointer font-medium text-red-800">
                  Incidents Drive
                  {report.timeoutHit && " · timeout préventif"}
                  {(report.skippedFiles?.length ?? 0) + (report.skippedFolders?.length ?? 0) > 0 &&
                    ` · ${(report.skippedFiles?.length ?? 0) + (report.skippedFolders?.length ?? 0)} skip`}
                </summary>
                <ul className="mt-2 text-xs text-red-700 space-y-1">
                  {report.skippedFolders?.map((s, i) => (
                    <li key={`fo-${i}`}>📁 {s.folder} : {s.error}</li>
                  ))}
                  {report.skippedFiles?.map((s, i) => (
                    <li key={`fi-${i}`}>📄 [{s.folder}] {s.file} : {s.error}</li>
                  ))}
                </ul>
                {report.timeoutHit && (
                  <p className="mt-2 text-xs text-red-700">
                    ⚠ Le scan s&apos;est arrêté préventivement à 5 min. Relance pour continuer.
                  </p>
                )}
              </details>
            )}

            {report.unknowns && report.unknowns.length > 0 && (
              <details className="border rounded-lg p-2">
                <summary className="cursor-pointer font-medium">
                  Fichiers non classés ({report.unknowns.length})
                </summary>
                <ul className="mt-2 text-xs text-gray-600 space-y-1">
                  {report.unknowns.map((u, i) => (
                    <li key={i}>• [{u.folder}] {u.file}</li>
                  ))}
                </ul>
              </details>
            )}

            {report.updates && report.updates.length > 0 && (
              <details className="border rounded-lg p-2" open>
                <summary className="cursor-pointer font-medium">
                  Documents associés ({report.updates.length})
                </summary>
                <ul className="mt-2 text-xs text-gray-600 space-y-1 max-h-60 overflow-y-auto">
                  {report.updates.map((u, i) => (
                    <li key={i}>
                      • <span className="font-medium">{u.client}</span> — {u.docType}
                      {u.by === "ai" && <span className="ml-1 text-purple-600">(IA)</span>}
                    </li>
                  ))}
                </ul>
              </details>
            )}
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

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-center">
      <div className="text-2xl font-bold text-gray-900">{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}
