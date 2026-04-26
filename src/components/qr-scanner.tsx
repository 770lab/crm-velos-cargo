"use client";
import { useEffect, useRef, useState } from "react";
import {
  scanImageData,
  setModuleArgs,
  getInstance,
  ZBarScanner,
  ZBarSymbolType,
  ZBarConfigType,
} from "@undecaf/zbar-wasm";

// Scanner QR continu — zbar-wasm + diagnostic visible.
// Cette version expose en UI le statut du WASM et la dernière erreur de scan
// pour qu'on puisse trancher entre :
//   - WASM 404/path foireux (status = error)
//   - WASM OK mais aucune détection (debug = "scan err: ..." ou rien)
//   - Détection OK mais texte non-attendu (debug = "Decoded: ...")
//
// Décodage en 2 passes par tick :
//   1. Frame entière à 1280px max (rapide, marche si QR ≥ 15% frame)
//   2. Crop centre 60% à pleine résolution (zoom digital pour petits QR)

const BASE_PATH = "/crm-velos-cargo";
const SCAN_INTERVAL_MS = 200;
const PAUSE_AFTER_SCAN_MS = 1000;

// locateFile résout l'URL du .wasm depuis l'instance Emscripten.
// public/zbar.wasm + basePath Next config = /crm-velos-cargo/zbar.wasm
setModuleArgs({
  locateFile: (filename) => `${BASE_PATH}/${filename}`,
});

// Scanner zbar custom avec TEST_INVERTED activé.
//
// Le scanner par défaut (getDefaultScanner) ne configure que BINARY=1, mais
// laisse TEST_INVERTED à 0. Or les stickers BicyCode officiels APIC ont des
// QR clair (cream/blanc) sur fond NOIR — polarité inversée par rapport au
// QR standard noir-sur-blanc. zbar refuse alors de les décoder.
//
// Avec ZBAR_CFG_TEST_INVERTED=1, zbar tente d'abord la passe normale, puis
// la passe inversée si rien trouvé. Coût négligeable, marche sur les deux
// polarités, fix les BicyCode.
//
// Le scanner est lourd à créer (alloc côté WASM heap), on le crée une fois
// et on le réutilise pour tous les scans.
let cachedScanner: ZBarScanner | null = null;
async function getInvertedAwareScanner(): Promise<ZBarScanner> {
  if (cachedScanner) return cachedScanner;
  const scanner = await ZBarScanner.create();
  scanner.setConfig(
    ZBarSymbolType.ZBAR_NONE,
    ZBarConfigType.ZBAR_CFG_BINARY,
    1,
  );
  scanner.setConfig(
    ZBarSymbolType.ZBAR_NONE,
    ZBarConfigType.ZBAR_CFG_TEST_INVERTED,
    1,
  );
  cachedScanner = scanner;
  return scanner;
}

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
  const [wasmStatus, setWasmStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [debugLog, setDebugLog] = useState<string>("");

  // Pré-init zbar-wasm + scanner custom au mount. Permet de surfacer toute
  // erreur de chargement (.wasm 404, CORS, scanner alloc) avant que la
  // caméra démarre. Une fois "ready", le scanner avec TEST_INVERTED est
  // prêt à décoder les BicyCode (QR inversés clair/sombre).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await getInstance();
        await getInvertedAwareScanner();
        if (!cancelled) {
          setWasmStatus("ready");
          setDebugLog("WASM ready (TEST_INVERTED on)");
        }
      } catch (e) {
        if (cancelled) return;
        setWasmStatus("error");
        const msg = e instanceof Error ? e.message : String(e);
        setDebugLog(`WASM init error: ${msg}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!enabled || wasmStatus !== "ready") {
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
          if (video.readyState < video.HAVE_ENOUGH_DATA || !video.videoWidth)
            return;

          scanning = true;
          try {
            const vw = video.videoWidth;
            const vh = video.videoHeight;
            const scanner = await getInvertedAwareScanner();

            setScanCount((c) => c + 1);

            // ---- Pass 1 : frame entière downsamplée à 1280px ----
            const maxDim = 1280;
            const scale1 = Math.min(1, maxDim / Math.max(vw, vh));
            const w1 = Math.max(1, Math.floor(vw * scale1));
            const h1 = Math.max(1, Math.floor(vh * scale1));
            canvas.width = w1;
            canvas.height = h1;
            ctx.drawImage(video, 0, 0, vw, vh, 0, 0, w1, h1);
            const imageData1 = ctx.getImageData(0, 0, w1, h1);
            let symbols = await scanImageData(imageData1, scanner);

            if (cancelled) return;

            if (symbols.length === 0) {
              // ---- Pass 2 : crop centre 60% à pleine résolution ----
              const cropSize = Math.floor(Math.min(vw, vh) * 0.6);
              const sx = Math.floor((vw - cropSize) / 2);
              const sy = Math.floor((vh - cropSize) / 2);
              canvas.width = cropSize;
              canvas.height = cropSize;
              ctx.drawImage(
                video,
                sx,
                sy,
                cropSize,
                cropSize,
                0,
                0,
                cropSize,
                cropSize,
              );
              const imageData2 = ctx.getImageData(0, 0, cropSize, cropSize);
              symbols = await scanImageData(imageData2, scanner);
              if (cancelled) return;
            }

            if (symbols.length > 0) {
              const text = symbols[0].decode();
              if (text) {
                const trimmed = text.trim();
                const now = Date.now();
                const last = lastScannedRef.current;
                const isDuplicate =
                  last && last.text === trimmed && now - last.at < 2500;
                if (!isDuplicate) {
                  lastScannedRef.current = { text: trimmed, at: now };
                  setHits((h) => h + 1);
                  beep();
                  pausedUntil = now + PAUSE_AFTER_SCAN_MS;
                  setDebugLog(`Decoded: ${trimmed.slice(0, 80)}`);
                  onScan(trimmed);
                }
              }
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setDebugLog(`scan err: ${msg.slice(0, 120)}`);
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
  }, [enabled, wasmStatus, onScan, onError]);

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
        {running && wasmStatus === "ready" && (
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
        {wasmStatus === "loading" && !errMsg && (
          <div className="absolute inset-0 flex items-center justify-center text-white text-sm bg-black/70">
            Chargement du décodeur (WASM)…
          </div>
        )}
        {wasmStatus === "error" && (
          <div className="absolute inset-0 flex items-center justify-center text-white text-xs p-4 bg-red-900/80 text-center">
            <div>
              ❌ Décodeur indisponible
              <div className="opacity-80 mt-2 text-[10px] break-all">
                {debugLog}
              </div>
            </div>
          </div>
        )}
        {wasmStatus === "ready" && !running && !errMsg && (
          <div className="absolute inset-0 flex items-center justify-center text-white text-sm">
            Initialisation caméra…
          </div>
        )}
        {wasmStatus === "ready" && running && (
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
        Vise le QR dans le cadre vert. Bip à chaque scan réussi (1 s de pause).
      </div>
      {debugLog && (
        <div className="text-[10px] text-gray-400 break-all bg-gray-50 border rounded px-2 py-1">
          debug: {debugLog}
        </div>
      )}
      {errMsg && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
          ⚠ Caméra inaccessible : {errMsg}
        </div>
      )}
    </div>
  );
}
