"use client";
import { useRef, useState } from "react";
import jsQR from "jsqr";

// Scanner QR — refonte 2026-04-26 : photo native iOS au lieu de flux vidéo.
//
// Historique des essais en flux vidéo (tous échoués sur les stickers BicyCode
// en condition réelle iPhone Safari) : BarcodeDetector natif, html5-qrcode,
// jsQR (résolution réduite + native), ZXing/@zxing/browser. Cause racine :
// stickers BicyCode petits (~10% de la frame), sous plastique transparent
// réfléchissant, avec bordure noire épaisse. Aucune lib web ne franchit ces
// conditions sur du flux vidéo, là où l'app caméra native iOS y arrive grâce
// à son autofocus macro hardware.
//
// Solution : <input type="file" accept="image/*" capture="environment">.
// L'utilisateur tape sur le bouton, iOS ouvre l'app caméra (vraie macro,
// vrai autofocus), il prend une photo nette, on récupère le fichier en JS,
// on décode avec jsQR sur image fixe — beaucoup plus fiable car on a tout
// le temps de calculer et on travaille sur une image sans flou de mouvement.
//
// Pas de redirection vers bicycode.org : on extrait juste le contenu décodé
// et on le passe à onScan(), exactement comme l'ancien scanner.

export default function QrScanner({
  enabled,
  onScan,
  onError,
}: {
  enabled: boolean;
  onScan: (decoded: string) => void;
  onError?: (msg: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [decoding, setDecoding] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [lastShot, setLastShot] = useState<string | null>(null);

  // Décode le QR sur un canvas redimensionné à maxDim au plus.
  // jsQR est O(n²) sur la résolution — un iPhone shoot 4032×3024 (12MP) ce
  // qui prendrait ~3s. On essaie d'abord à 1600px (~600ms), et seulement si
  // ça rate on tente la pleine résolution. Ça couvre 95% des cas en <1s.
  const decodeAtSize = (img: HTMLImageElement, maxDim: number) => {
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.floor(img.naturalWidth * scale));
    const h = Math.max(1, Math.floor(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    return jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: "attemptBoth",
    });
  };

  const handleFile = async (file: File) => {
    setErrMsg(null);
    setDecoding(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(fr.error || new Error("FileReader error"));
        fr.readAsDataURL(file);
      });
      setLastShot(dataUrl);

      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error("Image illisible"));
        i.src = dataUrl;
      });

      const code =
        decodeAtSize(img, 1600) ??
        decodeAtSize(img, Math.max(img.naturalWidth, img.naturalHeight));

      if (code && code.data) {
        setErrMsg(null);
        setLastShot(null);
        onScan(code.data.trim());
      } else {
        const msg =
          "QR non détecté sur cette photo. Cadre le QR au centre, bien net, sans reflet, et réessaie.";
        setErrMsg(msg);
        onError?.(msg);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrMsg(msg);
      onError?.(msg);
    } finally {
      setDecoding(false);
      // Reset la valeur pour permettre de re-sélectionner la même photo si besoin
      // (sinon onChange ne re-déclenche pas pour le même fichier).
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  if (!enabled) return null;

  return (
    <div className="space-y-2">
      <label
        className={`flex items-center justify-center gap-2 w-full py-4 rounded-lg font-medium text-white shadow ${
          decoding
            ? "bg-gray-500 cursor-wait"
            : "bg-blue-600 active:bg-blue-700 cursor-pointer"
        }`}
      >
        <span className="text-2xl">📷</span>
        <span>{decoding ? "Décodage en cours…" : "Scanner le QR (appareil photo)"}</span>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          disabled={decoding}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
        />
      </label>
      <div className="text-xs text-gray-500 text-center">
        L&apos;app photo iPhone va s&apos;ouvrir. Cadre le QR bien net puis valide.
      </div>
      {errMsg && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
          ⚠ {errMsg}
        </div>
      )}
      {lastShot && errMsg && (
        <div className="text-xs">
          <div className="text-gray-500 mb-1">Dernière photo :</div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lastShot} alt="dernière capture" className="w-full rounded border" />
        </div>
      )}
    </div>
  );
}
