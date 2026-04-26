"use client";
import { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";

// Scanner QR utilisé au dépôt. Stratégie en 2 étages :
// 1. BarcodeDetector natif (Safari iOS 17+, Chrome/Edge récent) — rapide,
//    fiable, traite directement les frames vidéo HD.
// 2. Fallback html5-qrcode (Safari iOS 16, anciens Android) — la lib
//    n'arrive pas toujours à décoder un QR de petite taille sur iOS.
//
// onScan reçoit le contenu décodé. Une fois un scan détecté, le scanner se
// met en pause et attend que le parent réactive via `enabled`.

type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => {
  detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]>;
};

function getBarcodeDetector(): BarcodeDetectorCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { BarcodeDetector?: BarcodeDetectorCtor };
  return w.BarcodeDetector || null;
}

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
  const [mode, setMode] = useState<"native" | "fallback" | "none">("none");

  const videoRef = useRef<HTMLVideoElement>(null);
  const fallbackContainerId = "qr-scanner-fallback";
  const fallbackRef = useRef<Html5Qrcode | null>(null);

  useEffect(() => {
    if (!enabled) {
      setRunning(false);
      return;
    }

    let cancelled = false;
    let stream: MediaStream | null = null;
    let rafId: number | null = null;

    const startNative = async (Ctor: BarcodeDetectorCtor) => {
      try {
        const detector = new Ctor({ formats: ["qr_code"] });
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
        setMode("native");
        setRunning(true);

        const tick = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes.length > 0) {
              const value = codes[0].rawValue;
              if (value) {
                onScan(value.trim());
                return; // stop le tick, le parent décidera de réactiver
              }
            }
          } catch {
            // erreurs ponctuelles (frame pas prête) ignorées, on continue
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

    const startFallback = async () => {
      try {
        const scanner = new Html5Qrcode(fallbackContainerId);
        fallbackRef.current = scanner;
        await scanner.start(
          { facingMode: "environment" },
          {
            fps: 10,
            qrbox: (vw, vh) => {
              const size = Math.floor(Math.min(vw, vh) * 0.85);
              return { width: size, height: size };
            },
            videoConstraints: {
              facingMode: { ideal: "environment" },
              width: { ideal: 1920 },
              height: { ideal: 1080 },
            },
          },
          (decoded) => {
            if (cancelled) return;
            onScan(decoded.trim());
          },
          () => {},
        );
        if (!cancelled) {
          setMode("fallback");
          setRunning(true);
        }
      } catch (e) {
        const msg = String(e);
        setErrMsg(msg);
        onError?.(msg);
      }
    };

    const Ctor = getBarcodeDetector();
    if (Ctor) {
      startNative(Ctor);
    } else {
      startFallback();
    }

    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      const fb = fallbackRef.current;
      if (fb) {
        fb.stop().then(() => fb.clear()).catch(() => {});
        fallbackRef.current = null;
      }
      setRunning(false);
    };
  }, [enabled, onScan, onError]);

  return (
    <div className="relative w-full">
      {/* Conteneur pour BarcodeDetector natif : un simple <video> */}
      <video
        ref={videoRef}
        className={`w-full bg-black rounded-lg ${mode === "native" ? "" : "hidden"}`}
        style={{ minHeight: 280, objectFit: "cover" }}
        playsInline
        muted
      />
      {/* Conteneur pour html5-qrcode (fallback) */}
      <div
        id={fallbackContainerId}
        className={`w-full bg-black rounded-lg overflow-hidden ${mode === "fallback" ? "" : "hidden"}`}
        style={{ minHeight: 280 }}
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
          {mode === "fallback" && <span className="opacity-60 ml-1">(legacy)</span>}
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
