"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { gasGet, gasPost, gasUpload } from "@/lib/gas";

interface EquipeMember {
  id: string;
  nom: string;
  role: string;
  telephone?: string | null;
}

interface VeloRow {
  id: string;
  clientId: string;
  fnuci?: string | null;
  photoVeloUrl?: string | null;
  photoFnuciUrl?: string | null;
  photoQrPrise?: boolean | string;
  livre?: boolean;
}

interface LivraisonExec {
  id: string;
  clientId: string;
  statut?: string;
  nbVelos?: number;
  client: {
    id?: string;
    entreprise: string;
    ville: string | null;
    adresse: string | null;
    codePostal?: string | null;
    telephone?: string | null;
    contact?: string | null;
    lat?: number | null;
    lng?: number | null;
  } | null;
  velos: VeloRow[];
}

interface TourneeExecution {
  tourneeId: string;
  datePrevue: string | null;
  mode: string | null;
  livraisons: LivraisonExec[];
  equipe: {
    chauffeur: EquipeMember | null;
    chefEquipe: EquipeMember | null;
    monteurs: EquipeMember[];
  };
}

export default function TourneeExecuteWrapper() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center text-gray-500">Chargement…</div>}>
      <TourneeExecutePage />
    </Suspense>
  );
}

function TourneeExecutePage() {
  const search = useSearchParams();
  const tourneeId = search.get("id") || "";
  const [data, setData] = useState<TourneeExecution | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openLiv, setOpenLiv] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tourneeId) {
      setError("Paramètre ?id= manquant");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await gasGet("getTourneeExecution", { tourneeId });
      if ((r as { error?: string }).error) throw new Error((r as { error?: string }).error);
      setData(r as TourneeExecution);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [tourneeId]);

  useEffect(() => {
    load();
  }, [load]);

  const totals = useMemo(() => {
    if (!data) return { done: 0, total: 0 };
    let done = 0;
    let total = 0;
    for (const l of data.livraisons) {
      for (const v of l.velos) {
        total++;
        if (v.livre) done++;
      }
    }
    return { done, total };
  }, [data]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="text-gray-500 text-sm">Chargement de la tournée…</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-gray-50 p-4">
        <div className="max-w-md mx-auto bg-white border rounded-xl p-4">
          <h1 className="font-bold mb-2">Impossible de charger la tournée</h1>
          <p className="text-xs text-red-600 bg-red-50 p-2 rounded">{error || "Tournée introuvable"}</p>
          <div className="mt-3 flex gap-2">
            <button onClick={load} className="px-3 py-2 text-sm border rounded-lg">↻ Réessayer</button>
            <Link href="/livraisons" className="px-3 py-2 text-sm bg-gray-100 rounded-lg">← Retour</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-20">
      <header className="bg-white border-b sticky top-0 z-10">
        <div className="max-w-xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <Link href="/livraisons" className="text-sm text-gray-600 hover:text-gray-900">← Livraisons</Link>
            <span className="text-xs text-gray-500">Tournée {data.tourneeId}</span>
          </div>
          <div className="mt-1">
            <h1 className="text-lg font-bold">
              {data.datePrevue ? new Date(data.datePrevue).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" }) : "Sans date"}
            </h1>
            <div className="text-xs text-gray-500 flex gap-2 flex-wrap">
              {data.mode && <span className="capitalize">{data.mode}</span>}
              <span>· {data.livraisons.length} arrêts · {totals.total} vélos</span>
            </div>
          </div>

          {/* Progress bar */}
          <div className="mt-2">
            <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
              <span>Progression</span>
              <span className="font-medium text-gray-700">
                {totals.done}/{totals.total} vélos finalisés
              </span>
            </div>
            <div className="h-2 bg-gray-200 rounded overflow-hidden">
              <div
                className="h-full bg-emerald-500 transition-all"
                style={{ width: totals.total ? `${(totals.done / totals.total) * 100}%` : "0%" }}
              />
            </div>
          </div>

          {/* Equipe */}
          <div className="mt-3 text-[11px] text-gray-500 flex flex-wrap gap-x-3 gap-y-1">
            {data.equipe.chauffeur && <span>🚚 {data.equipe.chauffeur.nom}</span>}
            {data.equipe.chefEquipe && <span>👷 {data.equipe.chefEquipe.nom}</span>}
            {data.equipe.monteurs.length > 0 && (
              <span>🔧 {data.equipe.monteurs.map((m) => m.nom).join(", ")}</span>
            )}
            {!data.equipe.chauffeur && !data.equipe.chefEquipe && data.equipe.monteurs.length === 0 && (
              <span className="text-amber-600">⚠ Aucune équipe affectée — assigne depuis /livraisons</span>
            )}
          </div>
        </div>
      </header>

      <div className="max-w-xl mx-auto p-4 space-y-3">
        {data.livraisons.map((liv, i) => (
          <LivraisonCard
            key={liv.id}
            liv={liv}
            index={i}
            open={openLiv === liv.id}
            onToggle={() => setOpenLiv((p) => (p === liv.id ? null : liv.id))}
            onChanged={load}
          />
        ))}
      </div>
    </div>
  );
}

function LivraisonCard({
  liv,
  index,
  open,
  onToggle,
  onChanged,
}: {
  liv: LivraisonExec;
  index: number;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const done = liv.velos.filter((v) => v.livre).length;
  const total = liv.velos.length;
  const allDone = total > 0 && done === total;

  const mapsUrl = liv.client?.lat && liv.client?.lng
    ? `https://www.google.com/maps/dir/?api=1&destination=${liv.client.lat},${liv.client.lng}`
    : null;
  const telUrl = liv.client?.telephone ? `tel:${liv.client.telephone.replace(/\s/g, "")}` : null;

  return (
    <div className={`bg-white border rounded-xl overflow-hidden ${allDone ? "opacity-75" : ""}`}>
      <button
        onClick={onToggle}
        className="w-full text-left p-4 flex items-center gap-3"
      >
        <span
          className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm ${
            allDone ? "bg-emerald-600 text-white" : "bg-gray-900 text-white"
          }`}
        >
          {allDone ? "✓" : index + 1}
        </span>
        <div className="flex-1 min-w-0">
          <div className="font-semibold truncate">{liv.client?.entreprise || "?"}</div>
          <div className="text-xs text-gray-500 truncate">
            {liv.client?.adresse ? `${liv.client.adresse}, ` : ""}
            {liv.client?.codePostal} {liv.client?.ville}
          </div>
        </div>
        <div className="text-right">
          <div className={`text-sm font-semibold ${allDone ? "text-emerald-700" : "text-gray-700"}`}>
            {done}/{total}
          </div>
          <div className="text-[10px] text-gray-400">{open ? "▲" : "▼"}</div>
        </div>
      </button>

      {open && (
        <div className="border-t bg-gray-50">
          {/* Actions rapides */}
          <div className="flex gap-2 p-3 border-b bg-white">
            {mapsUrl && (
              <a
                href={mapsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 text-center px-3 py-2 text-xs bg-blue-600 text-white rounded-lg"
              >
                🗺️ Itinéraire
              </a>
            )}
            {telUrl && (
              <a
                href={telUrl}
                className="flex-1 text-center px-3 py-2 text-xs bg-green-600 text-white rounded-lg"
              >
                📞 {liv.client?.telephone}
              </a>
            )}
          </div>

          {/* Rappel inscription plateforme Bicycle — à dire au client */}
          <div className="mx-3 mt-3 bg-amber-50 border border-amber-200 rounded-lg p-2.5 text-xs text-amber-900">
            <div className="font-semibold mb-0.5">⚠️ À dire au client</div>
            Indiquer qu&apos;il devra procéder à l&apos;inscription sur la plateforme Bicycle
            pour valider l&apos;immatriculation de chaque vélo après livraison.
          </div>

          <div className="p-3 space-y-2">
            {liv.velos.map((v, vi) => (
              <VeloRow key={v.id} velo={v} index={vi} onChanged={onChanged} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function VeloRow({ velo, index, onChanged }: { velo: VeloRow; index: number; onChanged: () => void }) {
  const [fnuci, setFnuci] = useState<string>(velo.fnuci || "");
  const [photoVeloUrl, setPhotoVeloUrl] = useState<string>(velo.photoVeloUrl || "");
  const [photoFnuciUrl, setPhotoFnuciUrl] = useState<string>(velo.photoFnuciUrl || "");
  const [uploading, setUploading] = useState<null | "velo" | "fnuci">(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [livre, setLivre] = useState<boolean>(!!velo.livre);

  const handleFile = async (kind: "velo" | "fnuci", file: File) => {
    setUploading(kind);
    setError(null);
    try {
      const base64 = await fileToBase64(file);
      const r = await gasUpload("uploadVeloPhoto", {
        veloId: velo.id,
        kind,
        fileName: file.name,
        fileData: base64,
        mimeType: file.type || "image/jpeg",
      });
      const body = r as { error?: string; url?: string };
      if (body.error) throw new Error(body.error);
      if (body.url) {
        if (kind === "velo") setPhotoVeloUrl(body.url);
        else setPhotoFnuciUrl(body.url);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(null);
    }
  };

  const saveFnuci = async (value: string) => {
    setFnuci(value);
    if (!value.trim() || value === velo.fnuci) return;
    try {
      await gasPost("setVeloFnuci", { veloId: velo.id, fnuci: value.trim() });
    } catch {
      // non bloquant
    }
  };

  const markLivre = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await gasPost("markVeloLivre", {
        veloId: velo.id,
        fnuci: fnuci.trim(),
        photoVeloUrl,
        photoFnuciUrl,
      });
      const body = r as { error?: string; missing?: string[]; ok?: boolean };
      if (body.error) {
        const missing = body.missing ? ` (manque : ${body.missing.join(", ")})` : "";
        throw new Error(body.error + missing);
      }
      setLivre(true);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const canMark = fnuci.trim() && photoVeloUrl && photoFnuciUrl && !livre;

  return (
    <div className={`bg-white border rounded-lg p-3 ${livre ? "border-emerald-300 bg-emerald-50" : ""}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-500">Vélo #{index + 1}</span>
        {livre && <span className="text-xs font-semibold text-emerald-700">✓ livré</span>}
      </div>

      <label className="block text-xs text-gray-500 mb-1">FNUCI (identifiant unique)</label>
      <input
        type="text"
        inputMode="text"
        value={fnuci}
        onChange={(e) => setFnuci(e.target.value)}
        onBlur={() => saveFnuci(fnuci)}
        placeholder="ex: FR-VC-2026-XXXX"
        className="w-full px-3 py-2 border rounded-lg text-sm mb-3"
        disabled={livre}
      />

      <div className="grid grid-cols-2 gap-2">
        <PhotoSlot
          label="📷 Photo vélo"
          url={photoVeloUrl}
          uploading={uploading === "velo"}
          disabled={livre}
          onFile={(f) => handleFile("velo", f)}
        />
        <PhotoSlot
          label="🏷️ Photo étiquette"
          url={photoFnuciUrl}
          uploading={uploading === "fnuci"}
          disabled={livre}
          onFile={(f) => handleFile("fnuci", f)}
        />
      </div>

      {error && <div className="mt-2 text-xs text-red-600 bg-red-50 rounded p-2">{error}</div>}

      {!livre && (
        <button
          onClick={markLivre}
          disabled={!canMark || saving}
          className="mt-3 w-full px-3 py-2.5 bg-emerald-600 text-white rounded-lg text-sm font-medium disabled:opacity-50"
        >
          {saving ? "..." : canMark ? "Marquer livré" : "FNUCI + 2 photos requis"}
        </button>
      )}
    </div>
  );
}

function PhotoSlot({
  label,
  url,
  uploading,
  disabled,
  onFile,
}: {
  label: string;
  url: string;
  uploading: boolean;
  disabled: boolean;
  onFile: (f: File) => void;
}) {
  const has = !!url;
  return (
    <label
      className={`block cursor-pointer rounded-lg border-2 border-dashed p-3 text-center text-xs transition-colors ${
        disabled
          ? "border-gray-200 bg-gray-50 text-gray-400 cursor-not-allowed"
          : has
          ? "border-emerald-400 bg-emerald-50 text-emerald-800"
          : "border-gray-300 hover:border-blue-400 text-gray-600"
      }`}
    >
      <input
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        disabled={disabled || uploading}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
      {uploading ? (
        <span>⏳ Upload…</span>
      ) : has ? (
        <>
          <div className="font-medium">✓ {label}</div>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-[10px] text-blue-600 underline"
          >
            voir
          </a>
        </>
      ) : (
        <span>{label}</span>
      )}
    </label>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("Erreur lecture fichier"));
    reader.readAsDataURL(file);
  });
}
