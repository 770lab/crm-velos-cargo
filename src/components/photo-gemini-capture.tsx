"use client";
import { useCallback, useRef, useState } from "react";
import { gasUpload } from "@/lib/gas";

// Capture photo iOS → upload GAS → Gemini Vision extrait les FNUCI → marquage
// d'étape pour chaque code reconnu. Solution de remplacement au scan QR direct
// (Strich/zbar/jsQR) qui n'arrive pas à lire les BicyCode plastifiés sur iOS
// Safari. Gemini lit à la fois le QR et le texte imprimé en clair → double
// redondance, et le serveur valide chaque code par regex avant de toucher au
// sheet → zéro hallucination dans la base.
//
// Phase 1 : 1 photo = 1 sticker. Phase 2 : 1 photo = N stickers (le prompt
// Gemini retourne déjà une liste, donc Phase 2 est gratuite). Phase 3 :
// multi-upload (input multiple), géré via une boucle de fichiers.

export type GeminiEtape = "preparation" | "chargement" | "livraisonScan";

type ExtractResp =
  | {
      ok: true;
      extracted: string[];
      invalid: string[];
      results: Array<{ fnuci: string; result: unknown }>;
      rawGeminiText?: string;
    }
  | { error: string; rawText?: string; body?: string };

type PhotoStatus =
  | { kind: "idle" }
  | { kind: "uploading"; index: number; total: number; fileName: string }
  | { kind: "done"; resp: ExtractResp; fileName: string };

export type GeminiClientOption = {
  clientId: string;
  entreprise: string;
  total: number;
  prepare: number;
};

export default function PhotoGeminiCapture({
  tourneeId,
  userId,
  etape,
  onAfter,
  disabled,
  clients,
}: {
  tourneeId: string;
  userId: string | null;
  etape: GeminiEtape;
  onAfter?: () => void;
  disabled?: boolean;
  /** Clients de la tournée. Si fourni, l'opérateur peut sélectionner un client
   * pour assigner automatiquement les FNUCI extraits à ce client (workflow
   * préparateur en stock). */
  clients?: GeminiClientOption[];
}) {
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const galleryRef = useRef<HTMLInputElement | null>(null);
  const [history, setHistory] = useState<PhotoStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [forceClientId, setForceClientId] = useState<string>("");

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      if (!tourneeId) return;
      setBusy(true);
      const fileArr = Array.from(files);
      const total = fileArr.length;

      // Préparer toutes les entrées en "uploading" d'un coup pour que l'opérateur
      // voie tout de suite combien de photos vont être traitées.
      const initial: PhotoStatus[] = fileArr.map((f, i) => ({
        kind: "uploading",
        index: i + 1,
        total,
        fileName: f.name || `photo-${i + 1}`,
      }));
      setHistory((h) => [...initial, ...h]);

      // On lance les uploads en PARALLÈLE — Gemini Vision encaisse, le bottleneck
      // est sur GAS UrlFetchApp donc paralléliser raccourcit drastiquement le
      // temps total pour 10-60 photos. setHistory met à jour chaque ligne dès
      // qu'une réponse arrive (pas de blocage en cascade).
      const results = await Promise.all(
        fileArr.map(async (file, i) => {
          const fileName = file.name || `photo-${i + 1}`;
          try {
            const compressed = await compressImage(file, 1280, 0.8);
            const resp = (await gasUpload("extractFnuciFromImage", {
              imageBase64: compressed.base64,
              mimeType: compressed.mimeType,
              tourneeId,
              userId,
              etape,
              forceClientId: forceClientId || undefined,
            })) as ExtractResp;
            const done: PhotoStatus = { kind: "done", resp, fileName };
            setHistory((h) => updateAt(h, total - i - 1 + (h.length - total), done));
            return done;
          } catch (e) {
            const done: PhotoStatus = {
              kind: "done",
              resp: { error: e instanceof Error ? e.message : String(e) },
              fileName,
            };
            setHistory((h) => updateAt(h, total - i - 1 + (h.length - total), done));
            return done;
          }
        }),
      );
      void results;
      setBusy(false);
      if (onAfter) onAfter();
      if (cameraRef.current) cameraRef.current.value = "";
      if (galleryRef.current) galleryRef.current.value = "";
    },
    [tourneeId, userId, etape, onAfter, forceClientId],
  );

  return (
    <div className="space-y-2">
      {clients && clients.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-2 space-y-1">
          <label className="text-[11px] font-semibold text-amber-900">
            Pour quel client ? (assignation auto des FNUCI extraits)
          </label>
          <select
            value={forceClientId}
            onChange={(e) => setForceClientId(e.target.value)}
            className="w-full border border-amber-300 rounded px-2 py-1.5 text-sm bg-white"
          >
            <option value="">— Aucun (mode standard, FNUCI doit déjà exister) —</option>
            {clients.map((c) => {
              const free = c.total - c.prepare;
              return (
                <option key={c.clientId} value={c.clientId} disabled={free <= 0}>
                  {c.entreprise} ({c.prepare}/{c.total}{free <= 0 ? " — plein" : ` — ${free} libre${free > 1 ? "s" : ""}`})
                </option>
              );
            })}
          </select>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => cameraRef.current?.click()}
          className="px-3 py-3 bg-amber-600 text-white rounded-lg font-medium hover:bg-amber-700 disabled:opacity-60 text-sm"
        >
          📷 Caméra
        </button>
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => galleryRef.current?.click()}
          className="px-3 py-3 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-60 text-sm"
        >
          🖼️ Galerie (plusieurs)
        </button>
      </div>
      {busy && (
        <div className="text-center text-xs text-amber-700 font-medium animate-pulse">
          📤 Gemini analyse en parallèle…
        </div>
      )}
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
      <input
        ref={galleryRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
      <p className="text-[11px] text-gray-500 text-center">
        📷 Caméra : 1 photo à la fois. 🖼️ Galerie : sélectionne plusieurs photos d'un coup (déjà prises avec l'app Photo iOS). Gemini lit chaque code et marque chaque vélo.
      </p>

      {history.length > 0 && (
        <div className="mt-2 space-y-2 max-h-96 overflow-y-auto">
          {history.map((h, i) => (
            <PhotoResultCard key={i} status={h} />
          ))}
        </div>
      )}
    </div>
  );
}

function updateAt<T>(arr: T[], index: number, value: T): T[] {
  if (index < 0 || index >= arr.length) return arr;
  const copy = arr.slice();
  copy[index] = value;
  return copy;
}

function PhotoResultCard({ status }: { status: PhotoStatus }) {
  if (status.kind === "idle") return null;
  if (status.kind === "uploading") {
    return (
      <div className="text-xs bg-blue-50 border border-blue-200 rounded px-2 py-1.5 text-blue-800">
        📤 {status.fileName} ({status.index}/{status.total}) — Gemini analyse…
      </div>
    );
  }
  const resp = status.resp;
  if ("error" in resp) {
    return (
      <div className="text-xs bg-red-50 border border-red-200 rounded px-2 py-1.5 text-red-800">
        ❌ {status.fileName} — {resp.error}
        {resp.rawText && (
          <div className="mt-1 font-mono text-[10px] break-all opacity-70">
            raw: {resp.rawText.slice(0, 200)}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="text-xs bg-gray-50 border border-gray-200 rounded px-2 py-2 space-y-1">
      <div className="font-medium text-gray-800">
        📷 {status.fileName} — {resp.extracted.length} code{resp.extracted.length > 1 ? "s" : ""} extrait
        {resp.extracted.length > 1 ? "s" : ""}
      </div>
      {resp.results.length === 0 && (
        <div className="text-gray-500 italic">Aucun FNUCI valide trouvé.</div>
      )}
      {resp.results.map((r, i) => (
        <FnuciResultLine key={i} fnuci={r.fnuci} result={r.result} />
      ))}
      {resp.invalid.length > 0 && (
        <div className="text-orange-700 text-[11px]">
          ⚠️ Codes ignorés (format invalide) : {resp.invalid.join(", ")}
        </div>
      )}
    </div>
  );
}

function FnuciResultLine({ fnuci, result }: { fnuci: string; result: unknown }) {
  const r = result as
    | {
        ok?: true;
        alreadyDone?: boolean;
        clientName?: string | null;
        date?: string;
      }
    | { error: string; code?: string };

  if (r && "ok" in r && r.ok) {
    const tag = r.alreadyDone ? "↺ déjà fait" : "✓ marqué";
    const color = r.alreadyDone ? "text-amber-700" : "text-green-700";
    return (
      <div className={`flex items-center justify-between gap-2 ${color}`}>
        <span className="font-mono">{fnuci}</span>
        <span className="text-[11px]">
          {tag}
          {r.clientName ? ` · ${r.clientName}` : ""}
        </span>
      </div>
    );
  }
  if (r && "error" in r) {
    return (
      <div className="flex items-center justify-between gap-2 text-red-700">
        <span className="font-mono">{fnuci}</span>
        <span className="text-[11px]">
          ❌ {r.code || r.error}
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-2 text-gray-600">
      <span className="font-mono">{fnuci}</span>
      <span className="text-[11px]">?</span>
    </div>
  );
}

// Resize l'image à maxSize px (côté le plus long) et ré-encode en JPEG quality.
// iPhone produit du HEIC ~3 MB ou JPEG ~2 MB → après compression à 1280 / 0.8 on
// tombe vers 100-200 KB. Gain x10-x15 sur l'upload GAS, qui était le bottleneck.
async function compressImage(
  file: File,
  maxSize: number,
  quality: number,
): Promise<{ base64: string; mimeType: string }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("image load failed"));
    im.src = dataUrl;
  });

  const longest = Math.max(img.width, img.height);
  const scale = longest > maxSize ? maxSize / longest : 1;
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d unavailable");
  ctx.drawImage(img, 0, 0, w, h);
  const compressedDataUrl = canvas.toDataURL("image/jpeg", quality);
  const comma = compressedDataUrl.indexOf(",");
  const base64 = comma >= 0 ? compressedDataUrl.slice(comma + 1) : compressedDataUrl;
  return { base64, mimeType: "image/jpeg" };
}
