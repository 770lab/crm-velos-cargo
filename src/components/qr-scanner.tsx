"use client";
import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

// Scanner QR utilisé au dépôt. Stratégie unique : flux vidéo HD + extraction
// de frames via canvas + décodage avec jsQR (pure JS, pas de dépendance native).
//
// Pourquoi pas BarcodeDetector natif ni html5-qrcode :
// - BarcodeDetector existe sur iOS Safari 17+ mais ne décode jamais les QR
//   en pratique (constructeur OK, detect() retourne toujours [] sur iPhone).
// - html5-qrcode lit le canvas via une boucle interne qui ne marche pas
//   non plus sur iOS Safari (caméra OK, callback de détection jamais appelé).
//
// jsQR + canvas + requestAnimationFrame = approche la plus fiable, marche
// partout, et reste rapide tant qu'on downsample la frame à ~800px max.

export default function QrScanner({
  enabled,
  onScan,
  onError,
}: {
  enabled: boolean;
  onScan: (decoded: string) => void;
  onError?: (msg: string) => void;
}) {
  const [running, setRunning] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!enabled) {
      setRunning(false);
      return;
    }

    let cancelled = false;
    let stream: MediaStream | null = null;
    let rafId: number | null = null;

    if (!canvasRef.current) {
      canvasRef.current = document.createElement("canvas");
    }
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        if (cancelled || !videoRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute("playsinline", "true");
        await videoRef.current.play();
        if (cancelled) return;
        setRunning(true);

        const tick = () => {
          if (cancelled || !videoRef.current || !ctx) return;
          const video = videoRef.current;
          if (video.readyState >= video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
            // Downsample à 800px max sur la plus grande dimension. jsQR est
            // O(n²) sur la résolution donc 1920×1080 met ~200ms par frame —
            // 800×450 met ~30ms et reste largement suffisant pour décoder
            // un QR BicyCode (les modules font 8-15px à cette taille).
            const vw = video.videoWidth;
            const vh = video.videoHeight;
            const maxDim = 800;
            const scale = Math.min(1, maxDim / Math.max(vw, vh));
            canvas.width = Math.floor(vw * scale);
            canvas.height = Math.floor(vh * scale);
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(imageData.data, imageData.width, imageData.height, {
              // attemptBoth = essaie aussi les QR à couleurs inversées (rare
              // mais pas coûteux quand pas de QR détecté en mode normal).
              inversionAttempts: "attemptBoth",
            });
            if (code && code.data) {
              onScan(code.data.trim());
              return; // stop le tick, le parent réactivera via enabled
            }
          }
          rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
      } catch (e) {
        const msg = String(e);
        setErrMsg(msg);
        onError?.(msg);
      }
    };

    start();

    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      setRunning(false);
    };
  }, [enabled, onScan, onError]);

  return (
    <div className="relative w-full">
      <video
        ref={videoRef}
        className="w-full bg-black rounded-lg"
        style={{ minHeight: 280, objectFit: "cover" }}
        playsInline
        muted
      />
      {!running && !errMsg && enabled && (
        <div className="absolute inset-0 flex items-center justify-center text-white text-sm">
          Initialisation caméra…
        </div>
      )}
      {running && enabled && (
        <div className="absolute top-2 right-2 bg-black/60 text-white text-[11px] px-2 py-1 rounded-full flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          recherche QR…
        </div>
      )}
      {errMsg && (
        <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
          ⚠ Caméra inaccessible : {errMsg}
          <div className="mt-1 text-gray-600">
            Vérifie que tu as autorisé l&apos;accès caméra dans le navigateur, et que tu es en HTTPS.
          </div>
        </div>
      )}
    </div>
  );
}
