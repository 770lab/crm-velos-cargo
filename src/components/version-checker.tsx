"use client";

import { useEffect, useRef, useState } from "react";
import { BUILD_VERSION } from "@/lib/build-version";
import { BASE_PATH } from "@/lib/base-path";

const POLL_INTERVAL_MS = 60_000;

export function VersionChecker() {
  const [stale, setStale] = useState(false);
  const stoppedRef = useRef(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const check = async () => {
      try {
        const res = await fetch(`${BASE_PATH}/version.json?t=${Date.now()}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as { version?: string };
        if (data.version && data.version !== BUILD_VERSION) {
          stoppedRef.current = true;
          setStale(true);
        }
      } catch {
        // réseau coupé ou hors-ligne : on ignore et on retentera
      } finally {
        if (!stoppedRef.current) {
          timer = setTimeout(check, POLL_INTERVAL_MS);
        }
      }
    };

    timer = setTimeout(check, POLL_INTERVAL_MS);

    const onFocus = () => {
      if (!stoppedRef.current) check();
    };
    window.addEventListener("focus", onFocus);

    return () => {
      stoppedRef.current = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (!stale) return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[9999] bg-green-600 text-white shadow-lg rounded-full px-4 py-2 flex items-center gap-3 text-sm">
      <span>Nouvelle version disponible</span>
      <button
        onClick={() => window.location.reload()}
        className="bg-white text-green-700 font-semibold px-3 py-1 rounded-full hover:bg-gray-100"
      >
        Recharger
      </button>
    </div>
  );
}
