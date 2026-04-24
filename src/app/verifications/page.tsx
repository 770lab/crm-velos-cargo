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

export default function VerificationsPage() {
  const { clients, refresh } = useData();
  const [items, setItems] = useState<Verification[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("pending");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectFor, setRejectFor] = useState<Verification | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await gasGet("listVerifications", { status: tab, limit: "200" });
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
          onClick={load}
          className="ml-auto px-3 py-1.5 text-xs border rounded-lg text-gray-600 hover:bg-gray-50"
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
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-gray-400 text-sm">
          {tab === "pending" ? "Aucune vérification en attente." : "Aucun élément."}
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((v) => (
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

  if (urls.length <= 1) {
    return (
      <a
        href={urls[0] || driveUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1"
      >
        📎 {fileName || "Document"}
      </a>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {urls.map((url, i) => (
        <a
          key={i}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1 bg-blue-50 px-2 py-1 rounded"
        >
          📎 {names[i] || `Document ${i + 1}`}
        </a>
      ))}
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
