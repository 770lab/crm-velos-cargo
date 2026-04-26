"use client";
import { useEffect, useRef, useState } from "react";
import { gasUpload } from "@/lib/gas";

// Bloc d'upload du Bon de Livraison signé/tamponné par le client à la fin de
// la livraison. S'affiche dans tournee-scan-flow.tsx quand mode === "livraison"
// et que tous les vélos du client ont été scannés (allDone). Le chauffeur prend
// une photo du BL papier signé, ça monte sur Drive et l'URL est stockée dans
// le sheet Livraisons (colonne urlBlSigne).

type UploadResp =
  | { ok: true; livraisonId: string; clientId: string; tourneeId: string; photoUrl: string }
  | { error: string };

async function compressImage(file: File): Promise<{ base64: string; mimeType: string }> {
  // 1200px de large pour un BL : on veut pouvoir relire la signature/cachet
  // a posteriori, donc un peu plus de définition que les photos preuve montage.
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("image illisible"));
    im.src = dataUrl;
  });
  const ratio = img.width / img.height;
  const w = Math.min(1200, img.width);
  const h = Math.round(w / ratio);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas indisponible");
  ctx.drawImage(img, 0, 0, w, h);
  const out = canvas.toDataURL("image/jpeg", 0.8);
  const comma = out.indexOf(",");
  return { base64: out.slice(comma + 1), mimeType: "image/jpeg" };
}

export default function BlSignedUploader({
  tourneeId,
  clientId,
  initialUrl,
  onUploaded,
}: {
  tourneeId: string;
  clientId: string;
  /** URL de la photo BL signé déjà uploadée (si on revient sur la page après
   *  avoir déjà pris la photo une 1re fois). Affichée comme vignette + lien. */
  initialUrl?: string | null;
  onUploaded?: (url: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(initialUrl || null);
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // Sync state avec initialUrl si la prop change (refresh après reload de la
  // progression côté parent).
  useEffect(() => {
    if (initialUrl) setUploadedUrl(initialUrl);
  }, [initialUrl]);

  const onFileChosen = async (file: File) => {
    setErrMsg(null);
    setBusy(true);
    try {
      const compressed = await compressImage(file);
      const r = (await gasUpload("uploadBlSignedPhoto", {
        tourneeId,
        clientId,
        photoData: compressed.base64,
        mimeType: compressed.mimeType,
      })) as UploadResp;
      if ("error" in r) {
        setErrMsg(r.error);
        return;
      }
      setUploadedUrl(r.photoUrl);
      if (onUploaded) onUploaded(r.photoUrl);
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="bg-white border-2 border-emerald-300 rounded-xl p-4 space-y-3">
      <div>
        <div className="text-sm font-semibold text-emerald-900">
          📄 Bon de livraison signé
        </div>
        <div className="text-xs text-gray-600 mt-1">
          Photographie le BL papier après signature et cachet du client. Il sera
          archivé dans le dossier Drive du client.
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFileChosen(f);
        }}
        className="hidden"
      />
      <button
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        className={`w-full rounded-lg py-3 font-medium disabled:opacity-50 ${
          uploadedUrl ? "bg-white border border-emerald-400 text-emerald-800 hover:bg-emerald-50" : "bg-emerald-600 text-white hover:bg-emerald-700"
        }`}
      >
        {busy
          ? "Envoi…"
          : uploadedUrl
            ? "🔄 Reprendre la photo du BL"
            : "📸 Photographier le BL signé"}
      </button>

      {uploadedUrl && (
        <div className="bg-emerald-50 border border-emerald-200 rounded p-2 text-xs flex items-center justify-between gap-2">
          <span className="text-emerald-800">✅ BL archivé sur Drive</span>
          <a
            href={uploadedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-emerald-700 underline whitespace-nowrap"
          >
            📎 Voir
          </a>
        </div>
      )}

      {errMsg && (
        <div className="bg-red-50 border border-red-200 text-red-800 text-xs rounded p-2">
          {errMsg}
        </div>
      )}
    </div>
  );
}
