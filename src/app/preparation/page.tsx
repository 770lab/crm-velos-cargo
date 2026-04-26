"use client";
import { Suspense, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { gasGet } from "@/lib/gas";

const QrScanner = dynamic(() => import("@/components/qr-scanner"), { ssr: false });

type Prep = {
  ok: true;
  clientId: string;
  entreprise: string;
  adresse: string;
  ville: string;
  nbVelosTotal: number;
  nbVelosAvecFnuci: number;
  nbVelosSansFnuci: number;
  fnuciAttendus: string[];
} | { error: string };

type Lookup =
  | { found: true; veloId: string; clientId: string; clientName: string | null; fnuci: string }
  | { found: false; fnuci: string };

type ScanEvent = {
  fnuci: string;
  status: "ok" | "wrong-client" | "duplicate" | "unknown";
  msg: string;
  at: number;
};

function beep(ok: boolean) {
  try {
    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = ok ? 880 : 220;
    o.connect(g);
    g.connect(ctx.destination);
    g.gain.value = 0.1;
    o.start();
    setTimeout(() => { o.stop(); ctx.close(); }, ok ? 120 : 350);
  } catch {}
}

export default function PreparationPageWrapper() {
  return (
    <Suspense fallback={<div className="min-h-screen p-6 text-center text-sm text-gray-500">Chargement…</div>}>
      <PreparationPage />
    </Suspense>
  );
}

function PreparationPage() {
  const sp = useSearchParams();
  const clientId = sp.get("clientId") || "";
  const [prep, setPrep] = useState<Prep | null>(null);
  const [scanned, setScanned] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState<ScanEvent[]>([]);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    gasGet("getClientPreparation", { clientId })
      .then((r: Prep) => setPrep(r))
      .catch((e) => setPrep({ error: String(e) }));
  }, [clientId]);

  const onScan = async (decoded: string) => {
    if (paused) return;
    if (!prep || "error" in prep) return;
    if (scanned.has(decoded)) {
      setHistory((h) => [{ fnuci: decoded, status: "duplicate", msg: "Déjà scanné", at: Date.now() }, ...h]);
      beep(false);
      return;
    }
    setPaused(true);
    try {
      const r = (await gasGet("lookupFnuci", { fnuci: decoded })) as Lookup;
      if (!r.found) {
        setHistory((h) => [{ fnuci: decoded, status: "unknown", msg: "FNUCI inconnu — va d'abord en Réception", at: Date.now() }, ...h]);
        beep(false);
      } else if (r.clientId !== clientId) {
        setHistory((h) => [{
          fnuci: decoded,
          status: "wrong-client",
          msg: `⚠ Ce vélo est pour ${r.clientName || r.clientId}, REMETS-LE en stock`,
          at: Date.now(),
        }, ...h]);
        beep(false);
      } else {
        setScanned((s) => new Set([...Array.from(s), decoded]));
        setHistory((h) => [{ fnuci: decoded, status: "ok", msg: `✅ Validé (${scanned.size + 1}/${prep.nbVelosAvecFnuci})`, at: Date.now() }, ...h]);
        beep(true);
      }
    } finally {
      setTimeout(() => setPaused(false), 800);
    }
  };

  if (!prep) {
    return <div className="min-h-screen bg-gray-50 p-6 text-center text-sm text-gray-500">Chargement…</div>;
  }
  if ("error" in prep) {
    return <div className="min-h-screen bg-gray-50 p-6 text-center text-sm text-red-700">{prep.error}</div>;
  }

  const total = prep.nbVelosAvecFnuci;
  const done = scanned.size;
  const allDone = total > 0 && done >= total;
  const sansFnuci = prep.nbVelosSansFnuci;

  return (
    <div className="min-h-screen bg-gray-50 p-3 md:p-6">
      <div className="max-w-md mx-auto">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-base font-bold truncate">📋 Préparation</h1>
          <a href="/crm-velos-cargo/clients" className="text-sm text-gray-500 hover:text-gray-700">← Clients</a>
        </div>

        <div className="bg-white rounded-xl shadow p-4 mb-3">
          <div className="text-lg font-bold">{prep.entreprise}</div>
          <div className="text-xs text-gray-500">{prep.adresse} · {prep.ville}</div>
          <div className="mt-3 flex items-center gap-3">
            <div className={`flex-1 h-3 bg-gray-200 rounded-full overflow-hidden`}>
              <div
                className={`h-full ${allDone ? "bg-green-500" : "bg-blue-500"} transition-all`}
                style={{ width: total > 0 ? `${(done / total) * 100}%` : "0%" }}
              />
            </div>
            <div className={`text-2xl font-bold tabular-nums ${allDone ? "text-green-600" : "text-blue-700"}`}>
              {done}/{total}
            </div>
          </div>
          {sansFnuci > 0 && (
            <div className="text-xs text-amber-700 mt-2">
              ⚠ {sansFnuci} vélo{sansFnuci > 1 ? "s" : ""} de ce client n&apos;{sansFnuci > 1 ? "ont" : "a"} pas encore de FNUCI affecté.
              Va d&apos;abord en <a className="underline" href="/crm-velos-cargo/reception-cartons">Réception cartons</a>.
            </div>
          )}
        </div>

        {allDone ? (
          <div className="bg-green-50 border-2 border-green-500 rounded-xl p-6 text-center">
            <div className="text-5xl mb-2">✅</div>
            <div className="font-bold text-green-900 text-lg">Préparation terminée</div>
            <div className="text-sm text-green-800 mt-1">
              Les {total} vélos pour {prep.entreprise} sont prêts à charger.
            </div>
            <button
              onClick={() => { setScanned(new Set()); setHistory([]); }}
              className="mt-4 px-4 py-2 bg-white border border-green-300 rounded-lg text-sm text-green-800"
            >
              Recommencer
            </button>
          </div>
        ) : (
          <div className="bg-white rounded-xl shadow p-3">
            <QrScanner enabled={!paused} onScan={onScan} />
            <div className="mt-2 text-xs text-gray-500 text-center">
              {paused ? "Traitement…" : "Vise le QR (FNUCI) du carton"}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const v = (e.currentTarget.elements.namedItem("manualFnuci") as HTMLInputElement)?.value?.trim();
                if (v) {
                  onScan(v);
                  (e.currentTarget.elements.namedItem("manualFnuci") as HTMLInputElement).value = "";
                }
              }}
              className="flex gap-2 mt-3"
            >
              <input
                name="manualFnuci"
                className="flex-1 border rounded-lg px-3 py-2 text-sm"
                placeholder="Saisie manuelle FNUCI"
              />
              <button type="submit" className="px-3 py-2 bg-gray-700 text-white rounded-lg text-sm">OK</button>
            </form>
          </div>
        )}

        {history.length > 0 && (
          <div className="bg-white rounded-xl shadow p-3 mt-3">
            <div className="text-xs font-medium text-gray-500 mb-2">Historique scans</div>
            <div className="space-y-1 max-h-60 overflow-y-auto">
              {history.map((h, i) => (
                <div
                  key={i}
                  className={`text-xs px-2 py-1 rounded ${
                    h.status === "ok" ? "bg-green-50 text-green-800" :
                    h.status === "duplicate" ? "bg-gray-100 text-gray-600" :
                    "bg-red-50 text-red-800"
                  }`}
                >
                  <span className="font-mono">{h.fnuci}</span> — {h.msg}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
