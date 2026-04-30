"use client";

import { useEffect, useRef, useState } from "react";
import { BUILD_VERSION } from "@/lib/build-version";
import { BASE_PATH } from "@/lib/base-path";

const POLL_INTERVAL_MS = 60_000;
// Premier check rapide après mount : 5s suffit pour ne pas spammer si build
// vient de finir, mais détecte rapidement les vieilles versions au retour
// d'arrière-plan (iOS Safari peut servir un onglet vieux de plusieurs jours).
const FIRST_CHECK_DELAY_MS = 5_000;

// Hard reload qui contourne agressivement le cache (29-04 + 30-04 : Yoann
// se plaignait que le bouton "Recharger" obligeait à un hard refresh manuel
// sur iOS). On efface l'API caches (CacheStorage du service worker s'il y en
// a) puis on change la query string pour forcer un re-fetch fresh du HTML.
async function hardReload(): Promise<void> {
  try {
    if (typeof window !== "undefined" && "caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    // si caches API n'est pas dispo (Safari iOS strict) on continue sur le reload
  }
  try {
    const url = new URL(window.location.href);
    // Cache-buster fort : change la URL → tous les caches HTTP intermédiaires
    // (proxy, navigateur) recalculent.
    url.searchParams.set("_v", String(Date.now()));
    window.location.replace(url.toString());
  } catch {
    window.location.reload();
  }
}

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

    // Premier check à T+5s (au lieu de T+60s) : si le user ouvre l'app après
    // un déploiement, il voit le bandeau presque immédiatement.
    timer = setTimeout(check, FIRST_CHECK_DELAY_MS);

    const onFocus = () => {
      if (!stoppedRef.current) check();
    };
    window.addEventListener("focus", onFocus);
    // visibilitychange : iOS Safari déclenche ça au retour d'arrière-plan
    // (focus n'est pas toujours fired sur mobile). Cumul des deux = couverture
    // maximale.
    const onVisibility = () => {
      if (document.visibilityState === "visible" && !stoppedRef.current) {
        check();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stoppedRef.current = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  if (!stale) return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[9999] bg-green-600 text-white shadow-lg rounded-full px-4 py-2 flex items-center gap-3 text-sm">
      <span>Nouvelle version disponible</span>
      <button
        onClick={() => { void hardReload(); }}
        className="bg-white text-green-700 font-semibold px-3 py-1 rounded-full hover:bg-gray-100"
      >
        Recharger
      </button>
    </div>
  );
}
