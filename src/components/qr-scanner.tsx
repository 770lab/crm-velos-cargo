"use client";
import { useEffect, useRef, useState } from "react";
import { scanImageData, setModuleArgs } from "@undecaf/zbar-wasm";

// Scanner QR continu (refonte 2026-04-26 #2) — zbar-wasm + scan vidéo continu.
//
// Historique des libs essayées sur les stickers BicyCode iPhone :
// 1. BarcodeDetector natif iOS 17+ — detect() retourne []
// 2. html5-qrcode — callback jamais appelé
// 3. jsQR (basse + haute résolution sur flux vidéo) — pas de détection
// 4. ZXing/@zxing/browser — 139 frames analysées, 0 détection
// 5. jsQR sur photo native iOS multi-passes (région crop) — échoue aussi
//
// 6e tentative : zbar-wasm. ZBar (la lib C originale) est connue pour gérer
// les QR avec quiet zone tronquée, léger flou, contraste limite, et
// surface courbée — exactement le profil d'un sticker BicyCode sur tube
// vélo. C'est la dernière option crédible avant le décodage server-side.
//
// Stratégie :
// - getUserMedia 1080p (résolution nécessaire pour décoder un petit QR)
// - Crop centre 60% pour zoom digital (le QR remplit naturellement la zone
//   où l'user vise, et zbar a 2.5× plus de pixels par module)
// - Scan toutes les ~200ms (~5 FPS, perf vs latence)
// - Bip + vibration + pause 1s à chaque scan réussi (UX série de 15 vélos)
//
// WASM : le fichier zbar.wasm (~230KB) est dans public/zbar.wasm. setModuleArgs
// pointe vers /crm-velos-cargo/zbar.wasm (basePath du Next config).

const BASE_PATH = "/crm-velos-cargo";
const SCAN_INTERVAL_MS = 200;
const PAUSE_AFTER_SCAN_MS = 1000;

// Configure zbar-wasm une seule fois au chargement du module.
// locateFile est appelé par Emscripten pour résoudre le chemin du .wasm.
setModuleArgs({
  locateFile: (filename) => `${BASE_PATH}/${filename}`,
});

// Bip via WebAudio (pas de fichier audio à charger, créé à la volée).
// Sur iOS Safari l'AudioContext doit être créé/repris suite à un user gesture
// — ici l'user a déjà cliqué sur "scanner" donc le contexte est unlocked.
let audioCtx: AudioContext | null = null;
function beep() {
  try {
    if (!audioCtx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return;
      audioCtx = new Ctor();
    }
    const ac = audioCtx;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.frequency.value = 1200;
    gain.gain.value = 0.25;
    osc.connect(gain).connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + 0.08);
  } catch {
    // ignore
  }
  try {
    if ("vibrate" in navigator) navigator.vibrate(50);
  } catch {
    // ignore
  }
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
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastScannedRef = useRef<{ text: string; at: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [scanCount, setScanCount] = useState(0);
  const [hits, setHits] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setRunning(false);
      return;
    }

    let cancelled = false;
    let stream: MediaStream | null = null;
    let intervalId: number | null = null;
    let pausedUntil = 0;
    let scanning = false;

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

        intervalId = window.setInterval(async () => {
          if (cancelled || scanning) return;
          if (!videoRef.current || !ctx) return;
          if (Date.now() < pausedUntil) return;
          const video = videoRef.current;
          if (video.readyState < video.HAVE_ENOUGH_DATA || !video.videoWidth) return;

          scanning = true;
          try {
            // Crop centre 60% pour zoom digital. Le QR sticker est petit
            // physiquement, l'user le vise au centre — en croppant on lui
            // donne 2.5× plus de pixels par module.
            const vw = video.videoWidth;
            const vh = video.videoHeight;
            const cropSize = Math.floor(Math.min(vw, vh) * 0.6);
            const sx = Math.floor((vw - cropSize) / 2);
            const sy = Math.floor((vh - cropSize) / 2);
            canvas.width = cropSize;
            canvas.height = cropSize;
            ctx.drawImage(video, sx, sy, cropSize, cropSize, 0, 0, cropSize, cropSize);
            const imageData = ctx.getImageData(0, 0, cropSize, cropSize);

            setScanCount((c) => c + 1);
            const symbols = await scanImageData(imageData);
            if (cancelled) return;

            if (symbols.length > 0) {
              const text = symbols[0].decode();
              if (text) {
                const trimmed = text.trim();
                // Évite de re-déclencher 2× sur le même QR si l'user n'a pas
                // bougé. Re-scan possible après 2.5s même même QR (cas où il
                // re-scanne volontairement).
                const now = Date.now();
                const last = lastScannedRef.current;
                const isDuplicate =
                  last && last.text === trimmed && now - last.at < 2500;
                if (!isDuplicate) {
                  lastScannedRef.current = { text: trimmed, at: now };
                  setHits((h) => h + 1);
                  beep();
                  pausedUntil = now + PAUSE_AFTER_SCAN_MS;
                  onScan(trimmed);
                }
              }
            }
          } catch {
            // erreurs ponctuelles (frame pas prête, WASM init en cours) ignorées
          } finally {
            scanning = false;
          }
        }, SCAN_INTERVAL_MS);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setErrMsg(msg);
        onError?.(msg);
      }
    };

    start();

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      setRunning(false);
    };
  }, [enabled, onScan, onError]);

  if (!enabled) return null;

  return (
    <div className="space-y-2">
      <div
        className="relative w-full bg-black rounded-lg overflow-hidden"
        style={{ minHeight: 320 }}
      >
        <video
          ref={videoRef}
          className="w-full"
          style={{ minHeight: 320, maxHeight: 480, objectFit: "cover" }}
          playsInline
          muted
        />
        {/* Cadre vert 60% centre = zone de scan (crop décodé) */}
        {running && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
            <div
              className="border-4 border-green-400 rounded-xl"
              style={{
                width: "60%",
                aspectRatio: "1/1",
                boxShadow: "0 0 0 9999px rgba(0,0,0,0.35)",
              }}
            />
          </div>
        )}
        {!running && !errMsg && (
          <div className="absolute inset-0 flex items-center justify-center text-white text-sm">
            Initialisation caméra…
          </div>
        )}
        {running && (
          <div className="absolute top-2 right-2 bg-black/60 text-white text-[11px] px-2 py-1 rounded-full flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            <span>scan</span>
            <span className="opacity-60 ml-1">[{scanCount}]</span>
            {hits > 0 && (
              <span className="text-green-400 ml-1 font-semibold">✓{hits}</span>
            )}
          </div>
        )}
      </div>
      <div className="text-xs text-gray-500 text-center">
        Vise le QR dans le cadre vert. Bip à chaque scan réussi (1 s de pause
        avant le scan suivant).
      </div>
      {errMsg && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
          ⚠ Caméra inaccessible : {errMsg}
        </div>
      )}
    </div>
  );
}
