"use client";
import { useEffect, useRef, useState } from "react";
import { gasUpload } from "@/lib/gas";

// Bloc d'upload du Bon de Livraison signé/tamponné par le client à la fin de
// la livraison. S'affiche dans tournee-scan-flow.tsx quand mode === "livraison"
// et que tous les vélos du client ont été scannés (allDone). Le chauffeur prend
// une ou plusieurs photos du BL papier signé (recto/verso, plusieurs pages),
// elles montent sur Drive et les URLs sont stockées dans le sheet Livraisons
// (colonne urlsBlSigne, tableau ; urlBlSigne legacy = dernière photo).

type UploadResp =
  | { ok: true; livraisonId: string; clientId: string; tourneeId: string; photoUrl: string; urls: string[] }
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
  initialUrls,
  onUploaded,
}: {
  tourneeId: string;
  clientId: string;
  /** Legacy : URL unique de la photo BL signé déjà uploadée (rétrocompat). */
  initialUrl?: string | null;
  /** Multi-photos (29-04 14h29) : tableau d'URLs déjà uploadées. */
  initialUrls?: string[] | null;
  onUploaded?: (urls: string[]) => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [urls, setUrls] = useState<string[]>(() => {
    if (initialUrls && initialUrls.length > 0) return initialUrls;
    if (initialUrl) return [initialUrl];
    return [];
  });
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // Sync state si les props changent (refresh après reload de la progression
  // côté parent).
  useEffect(() => {
    if (initialUrls && initialUrls.length > 0) {
      setUrls(initialUrls);
    } else if (initialUrl) {
      setUrls((prev) => (prev.length === 0 ? [initialUrl] : prev));
    }
  }, [initialUrl, initialUrls]);

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
      const newUrls = r.urls && r.urls.length > 0 ? r.urls : [...urls, r.photoUrl];
      setUrls(newUrls);
      if (onUploaded) onUploaded(newUrls);
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const hasPhotos = urls.length > 0;

  return (
    <div className="bg-white border-2 border-emerald-300 rounded-xl p-4 space-y-3">
      <div>
        <div className="text-sm font-semibold text-emerald-900">
          📄 Bon de livraison signé
        </div>
        <div className="text-xs text-gray-600 mt-1">
          Photographie le BL papier après signature et cachet du client (recto/verso, plusieurs pages si besoin).
          Les photos sont archivées dans l&apos;espace de stockage sécurisé du client.
        </div>
      </div>

      {hasPhotos && (
        <div className="grid grid-cols-3 gap-2">
          {urls.map((u, i) => (
            <a
              key={`${u}-${i}`}
              href={u}
              target="_blank"
              rel="noopener noreferrer"
              className="relative bg-emerald-50 border border-emerald-200 rounded-lg overflow-hidden hover:border-emerald-400"
              title={`Photo ${i + 1}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={u}
                alt={`BL signé ${i + 1}`}
                className="w-full h-24 object-cover"
              />
              <div className="absolute top-1 left-1 bg-black/60 text-white text-[10px] rounded px-1.5 py-0.5">
                {i + 1}
              </div>
            </a>
          ))}
        </div>
      )}

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
          hasPhotos
            ? "bg-emerald-600 text-white hover:bg-emerald-700"
            : "bg-emerald-600 text-white hover:bg-emerald-700"
        }`}
      >
        {busy
          ? "📤 Envoi…"
          : hasPhotos
            ? `📸 Ajouter une photo (${urls.length} déjà prise${urls.length > 1 ? "s" : ""})`
            : "📸 Photographier le BL signé"}
      </button>

      {hasPhotos && (
        <div className="text-[11px] text-emerald-700 text-center italic">
          ✅ {urls.length} photo{urls.length > 1 ? "s" : ""} archivée{urls.length > 1 ? "s" : ""} sur Drive · clique pour rouvrir
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
