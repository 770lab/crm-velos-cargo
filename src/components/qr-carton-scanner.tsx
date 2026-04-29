"use client";
import { useCallback, useEffect, useRef, useState } from "react";

// Scan QR de l'étiquette carton (29-04 11h30) : remplace le scan BicyCode pour
// le chargement et la livraison. Le QR encode le `clientId`. Utilise l'API
// BarcodeDetector native (Safari iOS 17+, Chrome Android, Edge). Si pas dispo
// (Safari macOS, anciens navigateurs), affiche un message + saisie manuelle.
//
// Différent de PhotoGeminiCapture : pas d'upload Gemini, lecture purement
// locale → instantané, pas de coût API, pas de timeout 503. La caméra reste
// ouverte en mode "rafale", chaque QR détecté déclenche onScan(clientId)
// avec un cooldown anti-double-scan (un QR scanné tourne en boucle dans le
// frame buffer si on ne déduplique pas).

type ScanResult = {
  clientId: string;
  at: number;
};

declare global {
  interface Window {
    // Polyfill type minimal pour BarcodeDetector (pas dans lib.dom.d.ts encore).
    BarcodeDetector?: {
      new (options?: { formats?: string[] }): {
        detect(source: HTMLVideoElement | HTMLCanvasElement | ImageBitmap): Promise<
          Array<{ rawValue: string; format: string }>
        >;
      };
      getSupportedFormats?: () => Promise<string[]>;
    };
  }
}

export default function QrCartonScanner({
  onScan,
  onClose,
  recentScans = [],
  title = "Scan QR carton",
  subtitle,
}: {
  /** Callback à chaque QR détecté (déjà dédupliqué via cooldown). */
  onScan: (clientId: string) => void;
  onClose: () => void;
  /** Liste des derniers scans, affichée en bas pour feedback visuel. */
  recentScans?: Array<{ label: string; ok: boolean; at: number }>;
  title?: string;
  subtitle?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<InstanceType<NonNullable<typeof window.BarcodeDetector>> | null>(null);
  const lastScanRef = useRef<ScanResult | null>(null);
  const rafRef = useRef<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [manualValue, setManualValue] = useState("");
  const [flash, setFlash] = useState(false);

  // Cooldown anti-double-scan : un même QR détecté à <1.5s d'intervalle est
  // ignoré. L'opérateur doit déplacer la caméra pour scanner le suivant.
  const SCAN_COOLDOWN_MS = 1500;

  const start = useCallback(async () => {
    setError(null);
    if (typeof window === "undefined" || !window.BarcodeDetector) {
      setUnsupported(true);
      return;
    }
    try {
      detectorRef.current = new window.BarcodeDetector({ formats: ["qr_code"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setUnsupported(true);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const stop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  useEffect(() => {
    start();
    return () => stop();
  }, [start, stop]);

  // Boucle de détection. Tourne via requestAnimationFrame pour ne pas saturer
  // le CPU (~60fps max, BarcodeDetector skip si la frame n'est pas prête).
  useEffect(() => {
    if (unsupported || error) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      const v = videoRef.current;
      const det = detectorRef.current;
      if (v && det && v.readyState >= 2 && v.videoWidth > 0) {
        try {
          const codes = await det.detect(v);
          for (const c of codes) {
            const value = (c.rawValue || "").trim();
            if (!value) continue;
            const now = Date.now();
            const last = lastScanRef.current;
            if (last && last.clientId === value && now - last.at < SCAN_COOLDOWN_MS) {
              continue; // dédoublonnage
            }
            lastScanRef.current = { clientId: value, at: now };
            // Vibration + flash pour feedback immédiat.
            if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
              navigator.vibrate(30);
            }
            setFlash(true);
            setTimeout(() => setFlash(false), 150);
            onScan(value);
          }
        } catch {
          // BarcodeDetector peut throw sur des frames invalides ; on continue.
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [onScan, unsupported, error]);

  const handleManualSubmit = () => {
    const v = manualValue.trim();
    if (!v) return;
    onScan(v);
    setManualValue("");
  };

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 bg-black text-white">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 rounded bg-white/15 text-sm font-medium"
        >
          ✕ Fermer
        </button>
        <div className="text-sm font-semibold">{title}</div>
        <div className="w-16" />
      </div>

      {subtitle && (
        <div className="bg-emerald-700 text-white px-4 py-2 text-xs text-center">
          {subtitle}
        </div>
      )}

      <div className="relative flex-1 bg-black overflow-hidden">
        {unsupported ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-white p-4 text-center gap-3">
            <div className="text-5xl">📷</div>
            <div className="text-sm">Scan QR non supporté par ce navigateur.</div>
            <div className="text-xs opacity-70 max-w-xs">
              Utilise Safari sur iOS 17+ ou Chrome récent. En attendant, colle le clientId à la main :
            </div>
            <div className="flex gap-2 w-full max-w-xs">
              <input
                type="text"
                value={manualValue}
                onChange={(e) => setManualValue(e.target.value)}
                placeholder="clientId"
                className="flex-1 px-3 py-2 rounded bg-white/10 border border-white/30 text-white text-sm"
              />
              <button
                type="button"
                onClick={handleManualSubmit}
                className="px-3 py-2 bg-emerald-600 rounded text-sm font-medium"
              >
                Valider
              </button>
            </div>
          </div>
        ) : error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-white p-4 text-center gap-3">
            <div className="text-5xl">📷❌</div>
            <div className="text-sm">Caméra inaccessible.</div>
            <div className="text-xs opacity-70 break-words max-w-xs">{error}</div>
            <div className="text-xs opacity-70 max-w-xs">
              Sur iOS : Réglages → Safari → Caméra → Autoriser pour ce site.
            </div>
          </div>
        ) : (
          <>
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className="absolute inset-0 w-full h-full object-cover"
            />
            {/* Cadre de visée */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-64 h-64 border-2 border-white/70 rounded-2xl shadow-[0_0_0_9999px_rgba(0,0,0,0.4)]" />
            </div>
            {flash && (
              <div className="absolute inset-0 bg-white/40 pointer-events-none" />
            )}
          </>
        )}
      </div>

      {recentScans.length > 0 && (
        <div className="bg-black/90 px-3 py-2 max-h-40 overflow-y-auto">
          <div className="text-[11px] uppercase tracking-wider text-white/60 mb-1">
            Derniers scans ({recentScans.length})
          </div>
          <ul className="space-y-1 text-[12px]">
            {recentScans.slice(-6).reverse().map((s, i) => (
              <li
                key={`${s.at}-${i}`}
                className={`px-2 py-1 rounded ${s.ok ? "bg-emerald-700/80 text-white" : "bg-red-700/80 text-white"}`}
              >
                {s.ok ? "✓" : "✗"} {s.label}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
