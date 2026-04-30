"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

// Scan QR de l'étiquette carton (29-04 11h30, fix 12h17 : jsQR au lieu de
// BarcodeDetector). BarcodeDetector n'est PAS supporté par Safari iOS (même
// iOS 18) → tous les iPhones tombaient sur "Scan QR non supporté". jsQR est
// une lib JS pure (~10KB), marche sur tous les navigateurs récents.
//
// Le QR encode le `clientId`. Lecture purement locale → instantané, pas de
// coût API, pas de timeout. Caméra ouverte en mode rafale, chaque QR détecté
// déclenche onScan(clientId) avec un cooldown 1.5s anti-double-scan.

type ScanResult = {
  clientId: string;
  at: number;
};

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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastScanRef = useRef<ScanResult | null>(null);
  const rafRef = useRef<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualValue, setManualValue] = useState("");
  const [flash, setFlash] = useState(false);

  // Cooldown anti-double-scan : un même QR détecté à <1.5s d'intervalle est
  // ignoré. L'opérateur doit déplacer la caméra pour scanner le suivant.
  const SCAN_COOLDOWN_MS = 1500;

  const start = useCallback(async () => {
    setError(null);
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

  // Boucle de détection jsQR. Tourne via requestAnimationFrame, downsample
  // l'image à ~640px max sur le côté long pour rester rapide sur mobile.
  useEffect(() => {
    if (error) return;
    let cancelled = false;
    // Réutilise un seul canvas pour éviter alloc/release à chaque frame.
    if (!canvasRef.current && typeof document !== "undefined") {
      canvasRef.current = document.createElement("canvas");
    }
    const tick = () => {
      if (cancelled) return;
      const v = videoRef.current;
      const canvas = canvasRef.current;
      if (v && canvas && v.readyState >= 2 && v.videoWidth > 0) {
        // Downsample 1280px (au lieu de 640px) : sur Yoann 30-04 11h les QR
        // n'étaient pas détectés malgré une bonne qualité. jsQR a besoin de
        // ~3 pixels par "module" (chaque carré du QR) pour fiabiliser. Un QR
        // dense de 33×33 modules visible sur 30% de la frame = ~120px/33 = 3.6px
        // par module à 640px → limite. À 1280px on a 7.2px/module, marge
        // confortable. Coût CPU iPhone ~négligeable (60fps tient toujours).
        const longest = Math.max(v.videoWidth, v.videoHeight);
        const targetMax = 1280;
        const scale = longest > targetMax ? targetMax / longest : 1;
        const w = Math.round(v.videoWidth * scale);
        const h = Math.round(v.videoHeight * scale);
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(v, 0, 0, w, h);
          try {
            const imgData = ctx.getImageData(0, 0, w, h);
            const code = jsQR(imgData.data, imgData.width, imgData.height, {
              // attemptBoth (au lieu de dontInvert) : tente la lecture avec
              // les couleurs normales ET inversées. Catche les QR imprimés
              // sur fond légèrement teinté ou avec contraste imparfait.
              // Coût : ~2× le temps par frame mais 60fps tient toujours.
              inversionAttempts: "attemptBoth",
            });
            if (code && code.data) {
              const value = code.data.trim();
              if (value) {
                const now = Date.now();
                const last = lastScanRef.current;
                if (!(last && last.clientId === value && now - last.at < SCAN_COOLDOWN_MS)) {
                  lastScanRef.current = { clientId: value, at: now };
                  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
                    navigator.vibrate(30);
                  }
                  setFlash(true);
                  setTimeout(() => setFlash(false), 150);
                  onScan(value);
                }
              }
            }
          } catch {
            // jsQR / getImageData peut throw sur tainted canvas ou frame invalide
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [onScan, error]);

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
        {error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-white p-4 text-center gap-3">
            <div className="text-5xl">📷❌</div>
            <div className="text-sm">Caméra inaccessible.</div>
            <div className="text-xs opacity-70 break-words max-w-xs">{error}</div>
            <div className="text-xs opacity-70 max-w-xs">
              Sur iOS : Réglages → Safari → Caméra → Autoriser pour ce site.
            </div>
            <div className="text-xs opacity-70 max-w-xs mt-2">
              Ou colle le clientId manuellement :
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
