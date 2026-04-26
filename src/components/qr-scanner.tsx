"use client";
import { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";

// Scanner QR plein écran utilisé sur mobile au dépôt.
// onScan reçoit le contenu décodé du QR. La caméra est fermée automatiquement
// après chaque scan : c'est au parent de remettre le scanner en route via la
// prop `enabled` quand il est prêt à accepter le scan suivant (évite double-scan).
export default function QrScanner({
  enabled,
  onScan,
  onError,
}: {
  enabled: boolean;
  onScan: (decoded: string) => void;
  onError?: (msg: string) => void;
}) {
  const containerId = "qr-scanner-region";
  const ref = useRef<Html5Qrcode | null>(null);
  const [running, setRunning] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const start = async () => {
      if (!enabled) return;
      try {
        const scanner = new Html5Qrcode(containerId);
        ref.current = scanner;
        await scanner.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 280, height: 280 } },
          (decoded) => {
            if (cancelled) return;
            onScan(decoded.trim());
          },
          () => {},
        );
        if (!cancelled) setRunning(true);
      } catch (e) {
        const msg = String(e);
        setErrMsg(msg);
        onError?.(msg);
      }
    };
    start();

    return () => {
      cancelled = true;
      const s = ref.current;
      if (s) {
        s.stop().then(() => s.clear()).catch(() => {});
        ref.current = null;
      }
      setRunning(false);
    };
  }, [enabled, onScan, onError]);

  return (
    <div className="relative w-full">
      <div id={containerId} className="w-full bg-black rounded-lg overflow-hidden" style={{ minHeight: 280 }} />
      {!running && !errMsg && enabled && (
        <div className="absolute inset-0 flex items-center justify-center text-white text-sm">
          Initialisation caméra…
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
