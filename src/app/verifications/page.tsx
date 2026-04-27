"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { gasGet, gasPost } from "@/lib/gas";
import { useData } from "@/lib/data-context";

type VerifStatus = "pending" | "validated" | "rejected" | "unassigned" | "";

interface Verification {
  id: string;
  receivedAt?: string;
  clientId?: string;
  entreprise?: string;
  docType?: string;
  driveUrl?: string;
  fileName?: string;
  fromEmail?: string;
  subject?: string;
  effectifDetected?: number | string;
  nbVelosBefore?: number | string;
  nbVelosAfter?: number | string;
  status?: VerifStatus;
  notes?: string;
  messageId?: string;
}

type Tab = "pending" | "validated" | "rejected" | "all";

interface BulkClientBreakdown {
  clientId: string;
  entreprise: string;
  fresh: number;
  linkOnly: number;
  skipExisting: number;
  total: number;
  byDocType: Record<string, number>;
}

interface BulkPreview {
  wouldValidate: number;
  validated?: number;
  fresh: number;        // flag posé + lien rempli
  linkOnly: number;     // flag déjà coché, on rajoute juste le lien
  skipExisting: number; // déjà OK, juste sortie de la file
  skipped: number;
  skipReasons: { notPending: number; noClient: number; clientNotFound: number; unknownDocType: number; excluded?: number };
  byDocType: Record<string, number>;
  clientsTouched: number;
  clientsUpdated?: number;
  clientsBreakdown?: BulkClientBreakdown[];
  sample: Array<{ id: string; clientId: string; docType: string; fileName: string; action?: string }>;
  dryRun: boolean;
}

export default function VerificationsPage() {
  const { clients, refresh } = useData();
  const [items, setItems] = useState<Verification[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("pending");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectFor, setRejectFor] = useState<Verification | null>(null);
  const [bulkPreview, setBulkPreview] = useState<BulkPreview | null>(null);
  const [bulkExcluded, setBulkExcluded] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await gasGet("listVerifications", { status: tab, limit: "1000" });
      const r = res as { items?: Verification[]; error?: string };
      if (r.error) throw new Error(r.error);
      setItems(Array.isArray(r.items) ? r.items : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    load();
  }, [load]);

  const clientsById = useMemo(() => {
    const map = new Map<string, string>();
    clients.forEach((c) => map.set(c.id, c.entreprise));
    return map;
  }, [clients]);

  // Recherche multi-tokens : "kbis btyl" → match toutes les lignes contenant
  // kbis ET btyl (insensible à la casse), n'importe où dans entreprise/docType/
  // fileName/subject/fromEmail/raison sociale du client matché.
  const filteredItems = useMemo(() => {
    const tokens = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return items;
    return items.filter((v) => {
      const haystack = [
        v.entreprise,
        v.docType,
        v.fileName,
        v.subject,
        v.fromEmail,
        v.clientId ? clientsById.get(v.clientId) : "",
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return tokens.every((t) => haystack.includes(t));
    });
  }, [items, search, clientsById]);

  const openBulkPreview = async () => {
    setBulkLoading(true);
    try {
      const res = await gasPost("bulkAutoValidate", { dryRun: true });
      const r = res as BulkPreview & { error?: string };
      if (r.error) throw new Error(r.error);
      setBulkPreview(r);
      setBulkExcluded(new Set());
    } catch (e) {
      alert("Erreur preview : " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBulkLoading(false);
    }
  };

  const refreshBulkPreview = async (excluded: Set<string>) => {
    setBulkLoading(true);
    try {
      const res = await gasPost("bulkAutoValidate", { dryRun: true, excludeClientIds: Array.from(excluded) });
      const r = res as BulkPreview & { error?: string };
      if (r.error) throw new Error(r.error);
      setBulkPreview(r);
    } catch (e) {
      alert("Erreur preview : " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBulkLoading(false);
    }
  };

  const runBulk = async () => {
    setBulkLoading(true);
    try {
      const res = await gasPost("bulkAutoValidate", { dryRun: false, excludeClientIds: Array.from(bulkExcluded) });
      const r = res as BulkPreview & { error?: string };
      if (r.error) throw new Error(r.error);
      setBulkPreview(null);
      setBulkExcluded(new Set());
      await load();
      refresh("clients");
      refresh("stats");
      alert(`${r.validated ?? 0} vérifications validées · ${r.clientsUpdated ?? 0} fiches client mises à jour.`);
    } catch (e) {
      alert("Erreur : " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBulkLoading(false);
    }
  };

  const validate = async (v: Verification) => {
    setBusyId(v.id);
    try {
      const res = await gasPost("validateVerification", { id: v.id });
      if ((res as { error?: string }).error) throw new Error((res as { error?: string }).error);
      await load();
      refresh("clients");
      refresh("stats");
    } catch (e) {
      alert("Erreur : " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">À vérifier</h1>
        <p className="text-sm text-gray-500 mt-1">
          Documents classés automatiquement depuis les emails — valide ou rejette chaque extraction avant
          que les chiffres ne soient définitivement pris en compte.
        </p>
      </div>

      <div className="mb-4 relative">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍 Rechercher (ex: kbis btyl, attestation thecarsociety, devis 2025-13565...)"
          className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
        />
        {search && (
          <button
            onClick={() => setSearch("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700 px-2 text-sm"
            aria-label="Effacer"
          >
            ×
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 mb-4 border-b">
        {([
          { id: "pending", label: "En attente" },
          { id: "validated", label: "Validés" },
          { id: "rejected", label: "Rejetés" },
          { id: "all", label: "Tout" },
        ] as const).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm border-b-2 transition-colors ${
              tab === t.id
                ? "border-green-600 text-green-700 font-semibold"
                : "border-transparent text-gray-500 hover:text-gray-800"
            }`}
          >
            {t.label}
          </button>
        ))}
        <button
          onClick={openBulkPreview}
          disabled={bulkLoading}
          className="ml-auto px-3 py-1.5 text-xs border border-indigo-200 bg-indigo-50 text-indigo-700 rounded-lg hover:bg-indigo-100 disabled:opacity-50"
          title="Auto-valider toutes les vérifications avec clientId + docType reconnu"
        >
          {bulkLoading ? "..." : "🪄 Auto-valider en lot"}
        </button>
        <button
          onClick={load}
          className="px-3 py-1.5 text-xs border rounded-lg text-gray-600 hover:bg-gray-50"
        >
          ↻ Rafraîchir
        </button>
      </div>

      {error && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg p-3 mb-4">
          <div className="font-semibold mb-1">Impossible de charger les vérifications</div>
          <div className="text-xs">{error}</div>
          <div className="text-xs mt-2 text-amber-700">
            Cette page dépend du GAS Inbox Watcher et de l&apos;action <code>listVerifications</code> côté CRM
            GAS. Si l&apos;action n&apos;est pas encore déployée, redeploye le script (Déployer → Gérer → ✏️
            → Nouvelle version).
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-400 text-sm">Chargement...</div>
      ) : filteredItems.length === 0 ? (
        <div className="text-center py-12 text-gray-400 text-sm">
          {search ? (
            <>Aucun résultat pour <span className="font-mono">&quot;{search}&quot;</span>.</>
          ) : tab === "pending" ? (
            "Aucune vérification en attente."
          ) : (
            "Aucun élément."
          )}
        </div>
      ) : (
        <>
          {search && (
            <div className="text-xs text-gray-500 mb-2">
              {filteredItems.length} résultat{filteredItems.length > 1 ? "s" : ""} sur {items.length}
            </div>
          )}
          <div className="space-y-3">
            {filteredItems.map((v) => (
              <VerifCard
                key={v.id}
                verif={v}
                clientName={v.clientId ? clientsById.get(v.clientId) || v.entreprise : v.entreprise}
                busy={busyId === v.id}
                tab={tab}
                onValidate={() => validate(v)}
                onReject={() => setRejectFor(v)}
              />
            ))}
          </div>
        </>
      )}

      {rejectFor && (
        <RejectModal
          verif={rejectFor}
          onClose={() => setRejectFor(null)}
          onDone={async () => {
            setRejectFor(null);
            await load();
            refresh("clients");
            refresh("stats");
          }}
        />
      )}

      {bulkPreview && (
        <BulkConfirmModal
          preview={bulkPreview}
          loading={bulkLoading}
          excluded={bulkExcluded}
          onToggleClient={(clientId) => {
            setBulkExcluded((prev) => {
              const next = new Set(prev);
              if (next.has(clientId)) next.delete(clientId); else next.add(clientId);
              return next;
            });
          }}
          onRefresh={() => refreshBulkPreview(bulkExcluded)}
          onClose={() => { setBulkPreview(null); setBulkExcluded(new Set()); }}
          onConfirm={runBulk}
        />
      )}
    </div>
  );
}

function BulkConfirmModal({
  preview,
  loading,
  excluded,
  onToggleClient,
  onRefresh,
  onClose,
  onConfirm,
}: {
  preview: BulkPreview;
  loading: boolean;
  excluded: Set<string>;
  onToggleClient: (clientId: string) => void;
  onRefresh: () => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const docTypes = Object.entries(preview.byDocType).sort((a, b) => b[1] - a[1]);
  const reasons = preview.skipReasons;
  const breakdown = preview.clientsBreakdown || [];
  const [expanded, setExpanded] = useState(false);
  const [clientFilter, setClientFilter] = useState("");
  const filteredBreakdown = breakdown.filter((c) =>
    !clientFilter || c.entreprise.toLowerCase().includes(clientFilter.toLowerCase())
  );
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-start mb-3">
          <h2 className="text-lg font-semibold">🪄 Auto-validation en lot</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">
            ×
          </button>
        </div>

        <p className="text-sm text-gray-600 mb-4">
          Mode <strong>safe</strong> : on coche le flag manquant et on remplit les liens vides, mais on
          n&apos;écrase <em>jamais</em> un lien que tu as déjà classé manuellement.
        </p>

        <div className="grid grid-cols-3 gap-2 mb-4">
          <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-center">
            <div className="text-[10px] uppercase font-semibold text-green-700">Fiches remplies</div>
            <div className="text-xl font-bold text-green-800">{preview.fresh}</div>
            <div className="text-[10px] text-green-600 mt-1">flag + lien</div>
          </div>
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-center">
            <div className="text-[10px] uppercase font-semibold text-blue-700">Liens ajoutés</div>
            <div className="text-xl font-bold text-blue-800">{preview.linkOnly}</div>
            <div className="text-[10px] text-blue-600 mt-1">sur flag déjà coché</div>
          </div>
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-center">
            <div className="text-[10px] uppercase font-semibold text-gray-700">Déjà OK</div>
            <div className="text-xl font-bold text-gray-800">{preview.skipExisting}</div>
            <div className="text-[10px] text-gray-600 mt-1">sortie de la file</div>
          </div>
        </div>

        <div className="text-xs text-gray-500 mb-4">
          Total à valider : <strong>{preview.wouldValidate}</strong> · Clients touchés : <strong>{preview.clientsTouched}</strong>
        </div>

        {docTypes.length > 0 && (
          <div className="mb-4">
            <div className="text-xs font-semibold text-gray-600 mb-2">Par type de document</div>
            <div className="flex flex-wrap gap-1.5">
              {docTypes.map(([dt, n]) => (
                <span key={dt} className="text-xs bg-indigo-100 text-indigo-800 px-2 py-1 rounded">
                  {dt} : {n}
                </span>
              ))}
            </div>
          </div>
        )}

        {preview.skipped > 0 && (
          <div className="mb-4 text-xs text-gray-600 bg-gray-50 rounded-lg p-3">
            <div className="font-semibold mb-1">Ignorés ({preview.skipped})</div>
            <ul className="space-y-0.5">
              {reasons.notPending > 0 && <li>• Déjà traités : {reasons.notPending}</li>}
              {reasons.noClient > 0 && <li>• Client non identifié : {reasons.noClient}</li>}
              {reasons.clientNotFound > 0 && <li>• Client introuvable dans la base : {reasons.clientNotFound}</li>}
              {reasons.unknownDocType > 0 && <li>• Type de doc inconnu : {reasons.unknownDocType}</li>}
              {reasons.excluded != null && reasons.excluded > 0 && <li>• Clients exclus manuellement : {reasons.excluded}</li>}
            </ul>
          </div>
        )}

        {breakdown.length > 0 && (
          <div className="mb-4 border rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="w-full flex items-center justify-between px-3 py-2 bg-gray-50 hover:bg-gray-100 text-sm font-medium text-gray-700"
            >
              <span>👁 Détail par client ({breakdown.length})</span>
              <span className="text-xs text-gray-500">{expanded ? "▲ replier" : "▼ déplier"}</span>
            </button>
            {expanded && (
              <div className="p-3 space-y-2 max-h-[40vh] overflow-y-auto">
                <div className="flex items-center gap-2 mb-2">
                  <input
                    type="search"
                    value={clientFilter}
                    onChange={(e) => setClientFilter(e.target.value)}
                    placeholder="Filtrer par nom..."
                    className="flex-1 px-2 py-1 text-xs border rounded"
                  />
                  {excluded.size > 0 && (
                    <button
                      onClick={onRefresh}
                      disabled={loading}
                      className="text-xs px-2 py-1 bg-amber-100 text-amber-800 rounded hover:bg-amber-200 disabled:opacity-50"
                      title="Recalculer les chiffres en tenant compte des clients décochés"
                    >
                      ↻ Recalculer ({excluded.size} exclu{excluded.size > 1 ? "s" : ""})
                    </button>
                  )}
                </div>
                <div className="text-[10px] text-gray-500 mb-1">
                  Décoche un client pour l&apos;exclure de la validation en lot. Les vérifications resteront dans la file pour traitement manuel.
                </div>
                {filteredBreakdown.map((c) => {
                  const isExcluded = excluded.has(c.clientId);
                  const dt = Object.entries(c.byDocType).sort((a, b) => b[1] - a[1]);
                  return (
                    <label
                      key={c.clientId}
                      className={`flex items-start gap-2 p-2 rounded border cursor-pointer ${
                        isExcluded ? "bg-red-50 border-red-200 opacity-60" : "bg-white border-gray-200 hover:bg-gray-50"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={!isExcluded}
                        onChange={() => onToggleClient(c.clientId)}
                        className="mt-0.5"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-900 truncate">
                          {c.entreprise || c.clientId}
                        </div>
                        <div className="text-[11px] text-gray-500 mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5">
                          {c.fresh > 0 && <span className="text-green-700">+{c.fresh} flag</span>}
                          {c.linkOnly > 0 && <span className="text-blue-700">+{c.linkOnly} lien</span>}
                          {c.skipExisting > 0 && <span className="text-gray-500">{c.skipExisting} déjà OK</span>}
                          <span className="text-gray-400">·</span>
                          {dt.map(([type, n]) => (
                            <span key={type} className="text-indigo-700">{type}:{n}</span>
                          ))}
                        </div>
                      </div>
                    </label>
                  );
                })}
                {filteredBreakdown.length === 0 && (
                  <div className="text-xs text-gray-400 text-center py-2">Aucun client ne matche le filtre.</div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">
            Annuler
          </button>
          <button
            onClick={onConfirm}
            disabled={loading || preview.wouldValidate === 0}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700 disabled:opacity-50"
          >
            {loading ? "En cours..." : `Valider ${preview.wouldValidate} vérification${preview.wouldValidate > 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function VerifCard({
  verif,
  clientName,
  busy,
  tab,
  onValidate,
  onReject,
}: {
  verif: Verification;
  clientName?: string;
  busy: boolean;
  tab: Tab;
  onValidate: () => void;
  onReject: () => void;
}) {
  const before = toNumber(verif.nbVelosBefore);
  const after = toNumber(verif.nbVelosAfter);
  const diff = isFinite(before) && isFinite(after) ? after - before : null;
  const status = verif.status || "pending";

  return (
    <div className="bg-white border rounded-xl p-4 shadow-sm">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-[240px]">
          <div className="flex items-center gap-2 flex-wrap">
            <StatusPill status={status} />
            <DocTypeBadge docType={verif.docType} />
            <span className="text-xs text-gray-500">{formatDate(verif.receivedAt)}</span>
          </div>
          <div className="mt-2 text-base font-semibold">
            {clientName || verif.entreprise || <span className="text-orange-600">Client non identifié</span>}
          </div>
          {verif.subject && (
            <div className="text-xs text-gray-500 mt-0.5 truncate" title={verif.subject}>
              {verif.subject}
            </div>
          )}
          {verif.fromEmail && (
            <div className="text-xs text-gray-400 mt-0.5">de {verif.fromEmail}</div>
          )}
        </div>

        {diff !== null && diff !== 0 && (
          <div
            className={`rounded-lg px-3 py-2 text-sm ${
              diff > 0
                ? "bg-blue-50 text-blue-800 border border-blue-200"
                : "bg-amber-50 text-amber-800 border border-amber-200"
            }`}
          >
            <div className="text-[10px] uppercase font-semibold tracking-wide opacity-70">Effectif</div>
            <div className="font-semibold">
              {before} → {after}
              <span className="ml-1 text-xs opacity-80">
                ({diff > 0 ? "+" : ""}
                {diff})
              </span>
            </div>
          </div>
        )}

        {verif.effectifDetected != null && verif.effectifDetected !== "" && diff === null && (
          <div className="bg-gray-50 rounded-lg px-3 py-2 text-sm">
            <div className="text-[10px] uppercase font-semibold tracking-wide text-gray-500">Effectif détecté</div>
            <div className="font-semibold">{String(verif.effectifDetected)}</div>
          </div>
        )}
      </div>

      <div className="flex items-center flex-wrap gap-2 mt-3 pt-3 border-t">
        {verif.driveUrl ? (
          <DriveLinks driveUrl={verif.driveUrl} fileName={verif.fileName} />
        ) : (
          <span className="text-xs text-gray-400">Pas de fichier attaché</span>
        )}

        {verif.clientId && (
          <Link
            href={`/clients?focus=${verif.clientId}`}
            className="text-xs text-gray-600 hover:underline inline-flex items-center gap-1"
          >
            → Voir le client
          </Link>
        )}

        {verif.notes && (
          <span className="text-xs text-gray-500 italic truncate max-w-[300px]" title={verif.notes}>
            {verif.notes}
          </span>
        )}

        {tab !== "validated" && tab !== "rejected" && status === "pending" && (
          <div className="ml-auto flex gap-2">
            <button
              onClick={onReject}
              disabled={busy}
              className="px-3 py-1.5 text-xs border border-red-200 text-red-700 rounded-lg hover:bg-red-50 disabled:opacity-50"
            >
              Rejeter
            </button>
            <button
              onClick={onValidate}
              disabled={busy}
              className="px-3 py-1.5 text-xs bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
            >
              {busy ? "..." : "Valider"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function RejectModal({
  verif,
  onClose,
  onDone,
}: {
  verif: Verification;
  onClose: () => void;
  onDone: () => void;
}) {
  const before = toNumber(verif.nbVelosBefore);
  const after = toNumber(verif.nbVelosAfter);
  const hasEffectifChange = isFinite(before) && isFinite(after) && before !== after;
  const [revert, setRevert] = useState<boolean>(hasEffectifChange);
  const [notes, setNotes] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await gasPost("rejectVerification", { id: verif.id, revertNbVelos: revert, notes });
      if ((res as { error?: string }).error) throw new Error((res as { error?: string }).error);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl p-6 w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-start mb-3">
          <h2 className="text-lg font-semibold">Rejeter la vérification</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">
            ×
          </button>
        </div>

        <div className="bg-gray-50 rounded-lg p-3 mb-4 text-sm">
          <div className="font-medium">{verif.entreprise || "Client"}</div>
          <div className="text-xs text-gray-500 mt-0.5">
            {verif.docType} · {verif.fileName}
          </div>
        </div>

        {hasEffectifChange && (
          <label className="flex items-start gap-2 p-3 bg-amber-50 rounded-lg mb-3 cursor-pointer">
            <input
              type="checkbox"
              checked={revert}
              onChange={(e) => setRevert(e.target.checked)}
              className="mt-0.5"
            />
            <div>
              <div className="text-sm font-medium">Annuler la modification d&apos;effectif</div>
              <div className="text-xs text-gray-600">
                Revenir de {after} à {before} vélos sur le client.
              </div>
            </div>
          </label>
        )}

        <label className="block text-sm font-medium text-gray-700 mb-1">Motif (optionnel)</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Ex: mauvais client, effectif déjà corrigé, doublon..."
          className="w-full px-3 py-2 border rounded-lg text-sm"
        />

        {error && <div className="mt-2 text-xs text-red-600 bg-red-50 rounded-lg p-2">{error}</div>}

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">
            Annuler
          </button>
          <button
            onClick={confirm}
            disabled={loading}
            className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm hover:bg-red-700 disabled:opacity-50"
          >
            {loading ? "..." : "Confirmer le rejet"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DriveLinks({ driveUrl, fileName }: { driveUrl: string; fileName?: string }) {
  const urls = driveUrl.split(" ||| ").filter(Boolean);
  const names = (fileName || "").split(", ").filter(Boolean);

  if (names.length <= 1) {
    return (
      <a
        href={urls[0] || driveUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1"
      >
        📎 {names[0] || fileName || "Document"}
      </a>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {names.map((name, i) => {
        const url = urls[i];
        return url ? (
          <a
            key={i}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1 bg-blue-50 px-2 py-1 rounded"
          >
            📎 {name}
          </a>
        ) : (
          <span key={i} className="text-xs text-gray-500 inline-flex items-center gap-1 bg-gray-50 px-2 py-1 rounded">
            📎 {name}
          </span>
        );
      })}
    </div>
  );
}

function StatusPill({ status }: { status: VerifStatus }) {
  const cfg: Record<string, { label: string; cls: string }> = {
    pending: { label: "En attente", cls: "bg-orange-100 text-orange-800" },
    validated: { label: "Validé", cls: "bg-green-100 text-green-800" },
    rejected: { label: "Rejeté", cls: "bg-red-100 text-red-800" },
    unassigned: { label: "Non assigné", cls: "bg-gray-100 text-gray-600" },
    "": { label: "En attente", cls: "bg-orange-100 text-orange-800" },
  };
  const c = cfg[status] || cfg.pending;
  return <span className={`text-[10px] uppercase font-semibold px-2 py-0.5 rounded ${c.cls}`}>{c.label}</span>;
}

function DocTypeBadge({ docType }: { docType?: string }) {
  if (!docType) return null;
  const labels: Record<string, string> = {
    dsn: "DSN",
    kbis: "KBIS",
    attestation: "Attestation",
    devis: "Devis",
    signature: "Signature",
    inscription: "Inscription",
    parcelle: "Parcelle",
    other: "Autre",
  };
  const label = labels[docType.toLowerCase()] || docType;
  return (
    <span className="text-[10px] uppercase font-semibold px-2 py-0.5 rounded bg-indigo-100 text-indigo-800">
      {label}
    </span>
  );
}

function toNumber(v: unknown): number {
  if (v == null || v === "") return NaN;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return isFinite(n) ? n : NaN;
}

function formatDate(iso?: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (!isFinite(d.getTime())) return iso;
    return d.toLocaleDateString("fr-FR", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
