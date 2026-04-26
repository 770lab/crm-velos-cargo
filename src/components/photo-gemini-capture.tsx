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

export default function PhotoGeminiCapture({
  tourneeId,
  userId,
  etape,
  onAfter,
  disabled,
}: {
  tourneeId: string;
  userId: string | null;
  etape: GeminiEtape;
  onAfter?: () => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [history, setHistory] = useState<PhotoStatus[]>([]);
  const [busy, setBusy] = useState(false);

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      if (!tourneeId) return;
      setBusy(true);
      const total = files.length;
      const fresh: PhotoStatus[] = [];
      for (let i = 0; i < total; i++) {
        const file = files[i];
        const fileName = file.name || `photo-${i + 1}`;
        fresh.push({ kind: "uploading", index: i + 1, total, fileName });
        setHistory((h) => [...fresh, ...h.slice(fresh.length - 1)]);
        try {
          const base64 = await fileToBase64(file);
          const resp = (await gasUpload("extractFnuciFromImage", {
            imageBase64: base64,
            mimeType: file.type || "image/jpeg",
            tourneeId,
            userId,
            etape,
          })) as ExtractResp;
          fresh[i] = { kind: "done", resp, fileName };
        } catch (e) {
          fresh[i] = {
            kind: "done",
            resp: { error: e instanceof Error ? e.message : String(e) },
            fileName,
          };
        }
        setHistory((h) => [...fresh, ...h.slice(fresh.length)]);
      }
      setBusy(false);
      if (onAfter) onAfter();
      if (inputRef.current) inputRef.current.value = "";
    },
    [tourneeId, userId, etape, onAfter],
  );

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => inputRef.current?.click()}
        className="w-full px-4 py-3 bg-amber-600 text-white rounded-lg font-medium hover:bg-amber-700 disabled:opacity-60"
      >
        {busy ? "📤 Envoi en cours…" : "📷 Photo Gemini (1 ou N stickers)"}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
      <p className="text-[11px] text-gray-500 text-center">
        Photographie un ou plusieurs stickers BicyCode. Gemini lit le code (QR ou texte) et marque chaque vélo.
      </p>

      {history.length > 0 && (
        <div className="mt-2 space-y-2">
          {history.map((h, i) => (
            <PhotoResultCard key={i} status={h} />
          ))}
        </div>
      )}
    </div>
  );
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

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      // dataURL = "data:image/jpeg;base64,XXXX" → on garde juste XXXX
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsDataURL(file);
  });
}
