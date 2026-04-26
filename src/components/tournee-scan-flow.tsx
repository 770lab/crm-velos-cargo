"use client";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { gasGet, gasPost } from "@/lib/gas";
import { useData } from "@/lib/data-context";

const QrScanner = dynamic(() => import("@/components/qr-scanner"), { ssr: false });

export type ScanMode = "preparation" | "chargement" | "livraison";

const MODE_CONFIG: Record<ScanMode, {
  title: string;
  emoji: string;
  totalsKey: "prepare" | "charge" | "livre";
  endpoint: "markVeloPrepare" | "markVeloCharge" | "markVeloLivreScan";
  storageKey: string;
  nextLink: { label: string; href: (tid: string) => string } | null;
}> = {
  preparation: {
    title: "Préparation",
    emoji: "📦",
    totalsKey: "prepare",
    endpoint: "markVeloPrepare",
    storageKey: "scan:preparateurId",
    nextLink: { label: "🚚 Passer au chargement →", href: (tid) => `/chargement?tourneeId=${encodeURIComponent(tid)}` },
  },
  chargement: {
    title: "Chargement",
    emoji: "🚚",
    totalsKey: "charge",
    endpoint: "markVeloCharge",
    storageKey: "scan:chauffeurId",
    nextLink: { label: "📍 Passer à la livraison →", href: (tid) => `/livraison?tourneeId=${encodeURIComponent(tid)}` },
  },
  livraison: {
    title: "Livraison",
    emoji: "📍",
    totalsKey: "livre",
    endpoint: "markVeloLivreScan",
    storageKey: "scan:livreurId",
    nextLink: null,
  },
};

type Totals = { total: number; prepare: number; charge: number; livre: number; monte: number };

type Velo = {
  veloId: string;
  fnuci: string | null;
  datePreparation: string | null;
  dateChargement: string | null;
  dateLivraisonScan: string | null;
  dateMontage: string | null;
};

type Client = {
  clientId: string;
  entreprise: string;
  ville: string;
  adresse: string;
  codePostal: string;
  velos: Velo[];
  totals: Totals;
};

type Progression =
  | { tourneeId: string; datePrevue: string | null; totals: Totals; clients: Client[] }
  | { error: string };

type ScanResp =
  | { ok: true; alreadyDone: boolean; etape: string; veloId: string; fnuci: string; clientId: string; clientName: string | null; date: string }
  | { error: string; code?: string; fnuci?: string; veloClientId?: string; veloClientName?: string | null };

type ScanEvent = {
  fnuci: string;
  status: "ok" | "duplicate" | "hors-tournee" | "unknown" | "error";
  msg: string;
  clientName?: string | null;
  at: number;
};

function beep(ok: boolean) {
  try {
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const Ctx = w.AudioContext || w.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
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

export default function TourneeScanFlow({ mode }: { mode: ScanMode }) {
  return (
    <Suspense fallback={<div className="min-h-screen p-6 text-center text-sm text-gray-500">Chargement…</div>}>
      <Inner mode={mode} />
    </Suspense>
  );
}

function Inner({ mode }: { mode: ScanMode }) {
  const cfg = MODE_CONFIG[mode];
  const sp = useSearchParams();
  const tourneeId = sp.get("tourneeId") || "";
  const { equipe, refresh } = useData();

  const [progression, setProgression] = useState<Progression | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [userId, setUserId] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem(cfg.storageKey) || "";
  });
  const [pickingUser, setPickingUser] = useState<boolean>(!userId);

  const [history, setHistory] = useState<ScanEvent[]>([]);
  const [scannerEnabled, setScannerEnabled] = useState<boolean>(true);
  const [busy, setBusy] = useState<boolean>(false);

  useEffect(() => { refresh("equipe"); }, [refresh]);

  const loadProgression = useCallback(async () => {
    if (!tourneeId) return;
    try {
      const r = await gasGet("getTourneeProgression", { tourneeId });
      setProgression(r as Progression);
      setLoadError(null);
    } catch (e) {
      setLoadError(String(e));
    }
  }, [tourneeId]);

  useEffect(() => { loadProgression(); }, [loadProgression]);

  const userName = useMemo(() => equipe.find((m) => m.id === userId)?.nom || "", [equipe, userId]);

  const handleScan = useCallback(async (raw: string) => {
    const fnuci = raw.trim();
    if (!fnuci || busy) return;
    setBusy(true);
    setScannerEnabled(false);
    try {
      const r = (await gasPost(cfg.endpoint, { fnuci, tourneeId, userId })) as ScanResp;
      if ("ok" in r && r.ok) {
        beep(true);
        const evt: ScanEvent = {
          fnuci: r.fnuci,
          status: r.alreadyDone ? "duplicate" : "ok",
          msg: r.alreadyDone ? "Déjà scanné" : "OK",
          clientName: r.clientName,
          at: Date.now(),
        };
        setHistory((h) => [evt, ...h].slice(0, 10));
      } else {
        beep(false);
        const err = r as { error: string; code?: string; veloClientName?: string | null };
        let status: ScanEvent["status"] = "error";
        let msg = err.error;
        if (err.code === "HORS_TOURNEE") {
          status = "hors-tournee";
          msg = `⚠ Pas dans cette tournée — ${err.veloClientName || "autre client"}`;
        } else if (err.code === "FNUCI_INCONNU") {
          status = "unknown";
          msg = "FNUCI inconnu — passe par Réception";
        }
        const evt: ScanEvent = { fnuci, status, msg, at: Date.now() };
        setHistory((h) => [evt, ...h].slice(0, 10));
      }
      await loadProgression();
    } catch (e) {
      beep(false);
      const evt: ScanEvent = { fnuci, status: "error", msg: String(e), at: Date.now() };
      setHistory((h) => [evt, ...h].slice(0, 10));
    } finally {
      setBusy(false);
      setTimeout(() => setScannerEnabled(true), 800);
    }
  }, [busy, cfg.endpoint, tourneeId, userId, loadProgression]);

  const changeUser = () => {
    localStorage.removeItem(cfg.storageKey);
    setUserId("");
    setPickingUser(true);
  };

  const pickUser = (id: string) => {
    localStorage.setItem(cfg.storageKey, id);
    setUserId(id);
    setPickingUser(false);
  };

  if (!tourneeId) {
    return (
      <div className="min-h-screen p-6 text-center text-sm text-red-600">
        Paramètre <code>tourneeId</code> manquant dans l&apos;URL.
      </div>
    );
  }

  const prog = progression && !("error" in progression) ? progression : null;
  const totals = prog?.totals;
  const counter = totals ? totals[cfg.totalsKey] : 0;
  const total = totals?.total || 0;
  const allDone = total > 0 && counter >= total;

  return (
    <div className="min-h-screen bg-gray-50 p-3 md:p-6">
      <div className="max-w-md mx-auto">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-xl font-bold">{cfg.emoji} {cfg.title}</h1>
          <a href="/crm-velos-cargo/livraisons" className="text-sm text-gray-500 hover:text-gray-700">← Planning</a>
        </div>

        {loadError && (
          <div className="bg-red-50 border border-red-200 text-red-800 text-sm rounded p-3 mb-3">
            Erreur de chargement : {loadError}
          </div>
        )}

        {progression && "error" in progression && (
          <div className="bg-red-50 border border-red-200 text-red-800 text-sm rounded p-3 mb-3">
            {progression.error}
          </div>
        )}

        {prog && (
          <div className="bg-white rounded-xl shadow p-3 mb-3">
            <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
              <span>Tournée {prog.tourneeId}{prog.datePrevue ? " · " + new Date(prog.datePrevue).toLocaleDateString() : ""}</span>
              <span>{prog.clients.length} client{prog.clients.length > 1 ? "s" : ""}</span>
            </div>
            <div className="flex items-baseline justify-between mb-2">
              <div className="text-2xl font-bold">{counter} <span className="text-base text-gray-400 font-normal">/ {total}</span></div>
              {allDone && <div className="text-green-600 text-sm font-medium">✅ Terminé</div>}
            </div>
            <div className="h-2 bg-gray-100 rounded overflow-hidden">
              <div
                className={`h-full ${allDone ? "bg-green-500" : "bg-blue-500"} transition-all`}
                style={{ width: total ? `${(counter / total) * 100}%` : "0%" }}
              />
            </div>
            {totals && (
              <div className="flex gap-3 mt-2 text-[11px] text-gray-500">
                <span>📦 {totals.prepare}/{total}</span>
                <span>🚚 {totals.charge}/{total}</span>
                <span>📍 {totals.livre}/{total}</span>
                <span>🔧 {totals.monte}/{total}</span>
              </div>
            )}
          </div>
        )}

        {!pickingUser && userId && (
          <div className="bg-white rounded-xl shadow p-2 mb-3 flex items-center justify-between">
            <div className="text-sm">
              <span className="text-gray-500">Opérateur :</span> <span className="font-medium">{userName || "?"}</span>
            </div>
            <button onClick={changeUser} className="text-xs text-blue-600 hover:underline">Changer</button>
          </div>
        )}

        {pickingUser && (
          <div className="bg-white rounded-xl shadow p-4 space-y-3">
            <div className="text-sm text-gray-700">Qui es-tu ?</div>
            <div className="space-y-2">
              {equipe.filter((m) => m.actif !== false).map((m) => (
                <button
                  key={m.id}
                  onClick={() => pickUser(m.id)}
                  className="w-full border rounded-lg p-3 text-left hover:bg-blue-50 hover:border-blue-300"
                >
                  <div className="font-medium">{m.nom}</div>
                  <div className="text-xs text-gray-500">{m.role || ""}</div>
                </button>
              ))}
              {equipe.length === 0 && (
                <div className="text-xs text-gray-500 text-center py-4">Aucun membre dans l&apos;équipe.</div>
              )}
            </div>
          </div>
        )}

        {!pickingUser && userId && prog && (
          <>
            <div className="bg-white rounded-xl shadow p-4 space-y-3 mb-3">
              <div className="text-sm text-gray-700">Scanne le QR FNUCI du vélo.</div>
              <QrScanner enabled={scannerEnabled && !allDone} onScan={handleScan} />
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = (e.currentTarget.elements.namedItem("manualFnuci") as HTMLInputElement)?.value?.trim();
                  if (v) {
                    handleScan(v);
                    (e.currentTarget.elements.namedItem("manualFnuci") as HTMLInputElement).value = "";
                  }
                }}
                className="flex gap-2"
              >
                <input
                  name="manualFnuci"
                  className="flex-1 border rounded-lg px-3 py-2 text-sm"
                  placeholder="Saisie manuelle FNUCI"
                />
                <button type="submit" className="px-3 py-2 bg-gray-700 text-white rounded-lg text-sm">OK</button>
              </form>
            </div>

            {history.length > 0 && (
              <div className="bg-white rounded-xl shadow p-3 mb-3">
                <div className="text-xs text-gray-500 mb-2">Derniers scans</div>
                <div className="space-y-1">
                  {history.map((h, i) => (
                    <div
                      key={i}
                      className={`text-xs flex items-center justify-between px-2 py-1 rounded ${
                        h.status === "ok" ? "bg-green-50 text-green-900" :
                        h.status === "duplicate" ? "bg-yellow-50 text-yellow-900" :
                        "bg-red-50 text-red-900"
                      }`}
                    >
                      <span className="font-mono truncate">{h.fnuci}</span>
                      <span>{h.clientName ? h.clientName + " · " : ""}{h.msg}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {mode === "preparation" && (
              <div className="bg-white rounded-xl shadow p-3 mb-3 grid grid-cols-2 gap-2">
                <a
                  href={`/crm-velos-cargo/etiquettes?tourneeId=${encodeURIComponent(tourneeId)}`}
                  target="_blank" rel="noopener noreferrer"
                  className="text-center bg-gray-100 rounded-lg py-3 text-sm font-medium hover:bg-gray-200"
                >
                  🏷️ Étiquettes
                </a>
                <a
                  href={`/crm-velos-cargo/bl?tourneeId=${encodeURIComponent(tourneeId)}`}
                  target="_blank" rel="noopener noreferrer"
                  className="text-center bg-gray-100 rounded-lg py-3 text-sm font-medium hover:bg-gray-200"
                >
                  📄 Bon de livraison
                </a>
              </div>
            )}

            {allDone && cfg.nextLink && (
              <a
                href={`/crm-velos-cargo${cfg.nextLink.href(tourneeId)}`}
                className="block w-full bg-green-600 text-white rounded-lg py-3 font-medium text-center"
              >
                {cfg.nextLink.label}
              </a>
            )}
          </>
        )}
      </div>
    </div>
  );
}
