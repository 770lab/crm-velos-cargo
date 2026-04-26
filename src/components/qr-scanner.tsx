"use client";
import { useEffect, useRef, useState } from "react";

// Scanner QR via STRICH SDK (https://strich.io).
//
// Pourquoi STRICH plutôt que zbar/zxing/jsQR/BarcodeDetector :
// après diagnostic complet sur les BicyCode APIC, aucune lib JS pure (zbar-wasm
// avec ou sans TEST_INVERTED, BarcodeDetector natif iOS Safari, jsQR, zxing)
// n'arrive à les décoder sur iOS Safari, alors que le canvas est plein, net et
// le QR parfaitement visible. STRICH est un SDK commercial spécifiquement
// optimisé pour le scan mobile-web sur iOS et tient là où les libs OSS rendent
// les armes.
//
// Le SDK gère la totalité du pipeline : caméra, overlay, viewfinder, bip,
// vibration, dedup. Le composant n'a plus qu'à fournir un host element et
// brancher le callback de détection.

const LICENSE_KEY = process.env.NEXT_PUBLIC_STRICH_LICENSE_KEY;

export default function QrScanner({
  enabled,
  onScan,
  onError,
}: {
  enabled: boolean;
  onScan: (decoded: string) => void;
  onError?: (msg: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">(
    "idle",
  );
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [detectionCount, setDetectionCount] = useState(0);
  const [lastDetected, setLastDetected] = useState<string | null>(null);

  // Refs pour les callbacks afin que les changements de props ne re-créent pas
  // le BarcodeReader (recréation = caméra qui se ré-init = flicker + lag).
  const onScanRef = useRef(onScan);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    if (!enabled) return;
    if (!LICENSE_KEY) {
      setStatus("error");
      const msg = "Clé Strich manquante (NEXT_PUBLIC_STRICH_LICENSE_KEY)";
      setErrMsg(msg);
      onErrorRef.current?.(msg);
      return;
    }

    let cancelled = false;
    type ReaderHandle = {
      stop: () => Promise<void>;
      destroy: () => Promise<void>;
    };
    let reader: ReaderHandle | null = null;

    setStatus("loading");

    // Import dynamique : le SDK touche à la caméra/WebGL au load, ce qui
    // casserait le build statique Next.js si on l'importait en haut du fichier.
    (async () => {
      try {
        const { StrichSDK, BarcodeReader } = await import(
          "@pixelverse/strichjs-sdk"
        );
        if (cancelled) return;

        if (!StrichSDK.isInitialized()) {
          await StrichSDK.initialize(LICENSE_KEY);
        }
        if (cancelled) return;

        if (!hostRef.current) return;

        const instance = new BarcodeReader({
          selector: hostRef.current,
          engine: {
            // Inspection des stickers BicyCode actuels (apic-asso.com / bicycode.eu)
            // : ce sont des QR standards (modules noirs sur fond clair), pas inverted
            // comme le suggérait l'ancien commentaire. iOS Photo les détecte
            // instantanément. On garde aussi datamatrix + microqr par sécurité.
            symbologies: ["qr", "datamatrix", "microqr"],
            // Évite les multiples détections du même code à la suite.
            duplicateInterval: 2500,
          },
          frameSource: {
            resolution: "full-hd",
            // ROI quasi full-frame : les BicyCode ne tiennent pas toujours dans le
            // viewfinder par défaut (sticker souvent grand, mal cadré par l'opérateur).
            regionOfInterest: { left: 0.02, top: 0.05, right: 0.02, bottom: 0.05 },
          },
          overlay: {
            showCameraSelector: false,
            showDetections: true,
            showTargetingLine: false,
          },
          feedback: { audio: true, vibration: true },
        });

        instance.detected = (codes) => {
          setDetectionCount((n) => n + codes.length);
          if (codes.length === 0) return;
          const data = codes[0].data?.trim();
          if (data) {
            setLastDetected(data.length > 40 ? data.slice(0, 40) + "…" : data);
            onScanRef.current(data);
          }
        };
        instance.onError = (e) => {
          const msg = e instanceof Error ? e.message : String(e);
          setErrMsg(msg);
          onErrorRef.current?.(msg);
        };

        await instance.initialize();
        if (cancelled) {
          await instance.destroy();
          return;
        }
        await instance.start();
        if (cancelled) {
          await instance.stop();
          await instance.destroy();
          return;
        }

        reader = instance;
        setStatus("ready");
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setStatus("error");
        setErrMsg(msg);
        onErrorRef.current?.(msg);
      }
    })();

    return () => {
      cancelled = true;
      if (reader) {
        const r = reader;
        reader = null;
        (async () => {
          try {
            await r.stop();
          } catch {
            // ignore
          }
          try {
            await r.destroy();
          } catch {
            // ignore
          }
        })();
      }
    };
  }, [enabled]);

  if (!enabled) return null;

  return (
    <div className="space-y-2">
      <div
        ref={hostRef}
        className="relative w-full bg-black rounded-lg overflow-hidden"
        style={{ minHeight: 320, maxHeight: 480 }}
      >
        {status === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center text-white text-sm bg-black/70">
            Initialisation du scanner…
          </div>
        )}
        {status === "error" && (
          <div className="absolute inset-0 flex items-center justify-center text-white text-xs p-4 bg-red-900/80 text-center">
            <div>
              ❌ Scanner indisponible
              {errMsg && (
                <div className="opacity-80 mt-2 text-[10px] break-all">
                  {errMsg}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="text-xs text-gray-500 text-center">
        Vise le QR dans le cadre. Bip + vibration à chaque scan réussi.
      </div>
      <div className="text-[10px] text-gray-700 bg-gray-100 rounded px-2 py-1 font-mono">
        <div>strich: {status} · détections: {detectionCount}</div>
        {lastDetected && <div className="break-all">last: {lastDetected}</div>}
        {errMsg && <div className="text-red-700 break-all">err: {errMsg}</div>}
      </div>
    </div>
  );
}
