"use client";
import { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { DecodeHintType, BarcodeFormat } from "@zxing/library";

// Scanner QR utilisé au dépôt. Décodeur : @zxing/browser (port officiel de
// la lib ZXing, référence industrielle pour QR).
//
// Historique des essais (tous échoués sur iPhone Safari) :
// - BarcodeDetector natif iOS 17+ : detect() retourne toujours [] sur les
//   frames vidéo. Bug iOS connu.
// - html5-qrcode : caméra OK, callback de détection jamais appelé. Lecture
//   canvas interne incompatible iOS.
// - jsQR à résolution réduite : trop peu de pixels par module.
// - jsQR à résolution native : décode correctement les QR de test mais rate
//   les BicyCode qui ont des bordures noires épaisses et un contraste limite.
//
// ZXing gère mieux les conditions difficiles (low-light, angle, contraste
// limite) grâce à son binarizer adaptatif. Il est aussi multi-formats — on
// reste sur QR_CODE pour la perf mais on pourrait étendre.
//
// Compteur de frames affiché en bas pour debug : si le compteur ne bouge
// pas, c'est que le code n'est pas le bon (cache navigateur). S'il monte
// mais ne détecte rien, c'est que le QR est vraiment illisible.

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
  const [frameCount, setFrameCount] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!enabled) {
      setRunning(false);
      return;
    }

    let cancelled = false;
    let stream: MediaStream | null = null;

    const hints = new Map<DecodeHintType, unknown>();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
    hints.set(DecodeHintType.TRY_HARDER, true);
    const reader = new BrowserMultiFormatReader(hints);

    let stopFn: (() => void) | null = null;

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

        // decodeFromVideoElement : ZXing gère lui-même la boucle de détection
        // (callback à chaque frame analysée). Plus simple et plus efficace que
        // de gérer notre propre requestAnimationFrame.
        const controls = await reader.decodeFromVideoElement(
          videoRef.current,
          (result, err) => {
            // Compteur de frames pour debug. ZXing appelle ce callback à
            // chaque tentative de décodage, qu'elle réussisse ou non.
            setFrameCount((c) => c + 1);
            if (cancelled) return;
            if (result) {
              const text = result.getText();
              if (text) onScan(text.trim());
            }
            // err non-null à chaque frame sans QR détecté : on ignore.
            void err;
          }
        );
        stopFn = () => controls.stop();
      } catch (e) {
        const msg = String(e);
        setErrMsg(msg);
        onError?.(msg);
      }
    };

    start();

    return () => {
      cancelled = true;
      if (stopFn) stopFn();
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
          <span className="opacity-60 ml-1">[{frameCount}]</span>
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
