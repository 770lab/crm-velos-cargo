"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { gasGet, gasPost } from "@/lib/gas";
import { useCurrentUser } from "@/lib/current-user";

const QrScanner = dynamic(() => import("@/components/qr-scanner"), { ssr: false });

export type ScanMode = "preparation" | "chargement" | "livraison";

const MODE_CONFIG: Record<ScanMode, {
  title: string;
  emoji: string;
  totalsKey: "prepare" | "charge" | "livre";
  doneKey: "datePreparation" | "dateChargement" | "dateLivraisonScan";
  endpoint: "markVeloPrepare" | "markVeloCharge" | "markVeloLivreScan";
  unmarkEtape: "preparation" | "chargement" | "livraisonScan";
  storageKey: string;
  nextLink: { label: string; href: (tid: string) => string } | null;
}> = {
  preparation: {
    title: "Préparation",
    emoji: "📦",
    totalsKey: "prepare",
    doneKey: "datePreparation",
    endpoint: "markVeloPrepare",
    unmarkEtape: "preparation",
    storageKey: "scan:preparateurId",
    nextLink: { label: "🚚 Passer au chargement →", href: (tid) => `/chargement?tourneeId=${encodeURIComponent(tid)}` },
  },
  chargement: {
    title: "Chargement",
    emoji: "🚚",
    totalsKey: "charge",
    doneKey: "dateChargement",
    endpoint: "markVeloCharge",
    unmarkEtape: "chargement",
    storageKey: "scan:chauffeurId",
    nextLink: { label: "📍 Passer à la livraison →", href: (tid) => `/livraison?tourneeId=${encodeURIComponent(tid)}` },
  },
  livraison: {
    title: "Livraison",
    emoji: "📍",
    totalsKey: "livre",
    doneKey: "dateLivraisonScan",
    endpoint: "markVeloLivreScan",
    unmarkEtape: "livraisonScan",
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
  const focusClientId = sp.get("clientId") || "";
  const currentUser = useCurrentUser();
  const userId = currentUser?.id || "";
  const userName = currentUser?.nom || "";

  const [progression, setProgression] = useState<Progression | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [history, setHistory] = useState<ScanEvent[]>([]);
  const [scannerEnabled, setScannerEnabled] = useState<boolean>(true);
  const [busy, setBusy] = useState<boolean>(false);
  // En mode préparation, si on scanne un FNUCI inconnu on propose d'assigner
  // à un client de la tournée (fusionne réception + préparation).
  const [pendingFnuci, setPendingFnuci] = useState<string | null>(null);

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
          if (mode === "preparation") {
            // Fusion réception+préparation : on demande à quel client assigner.
            setPendingFnuci(fnuci);
            setBusy(false);
            return;
          }
          status = "unknown";
          msg = "FNUCI inconnu — scanne-le d'abord en préparation";
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
  }, [busy, cfg.endpoint, tourneeId, userId, loadProgression, mode]);

  // Annule un scan (vide la date + user de l'étape pour ce vélo).
  const undoScan = useCallback(async (veloId: string, fnuci: string | null) => {
    if (busy) return;
    if (!confirm(`Annuler le scan de ${cfg.title.toLowerCase()} pour ce vélo ?\n\n${fnuci || veloId}`)) return;
    setBusy(true);
    try {
      const r = await gasPost("unmarkVeloEtape", { veloId, etape: cfg.unmarkEtape }) as { ok?: boolean; error?: string };
      if (r.error) {
        beep(false);
        const evt: ScanEvent = { fnuci: fnuci || veloId, status: "error", msg: "Annulation : " + r.error, at: Date.now() };
        setHistory((h) => [evt, ...h].slice(0, 10));
      } else {
        beep(true);
        const evt: ScanEvent = { fnuci: fnuci || veloId, status: "ok", msg: "↺ Scan annulé", at: Date.now() };
        setHistory((h) => [evt, ...h].slice(0, 10));
      }
      await loadProgression();
    } catch (e) {
      beep(false);
      const evt: ScanEvent = { fnuci: fnuci || veloId, status: "error", msg: String(e), at: Date.now() };
      setHistory((h) => [evt, ...h].slice(0, 10));
    } finally {
      setBusy(false);
    }
  }, [busy, cfg.title, cfg.unmarkEtape, loadProgression]);

  // Désaffilie complètement un vélo (vide clientId + toutes les dates d'étape).
  // Utile quand un vélo retourne au dépôt et doit être réassigné ailleurs.
  const desaffilier = useCallback(async (veloId: string, fnuci: string | null) => {
    if (busy) return;
    if (!confirm(`Désaffilier ce vélo de son client ?\n\nFNUCI : ${fnuci || "—"}\nID : ${veloId}\n\nLe vélo retourne au dépôt, toutes ses étapes (préparation, chargement, livraison, montage) seront effacées et il pourra être réassigné à un autre client.`)) return;
    setBusy(true);
    try {
      const r = await gasPost("unsetVeloClient", { veloId }) as { ok?: boolean; error?: string };
      if (r.error) {
        beep(false);
        const evt: ScanEvent = { fnuci: fnuci || veloId, status: "error", msg: "Désaffiliation : " + r.error, at: Date.now() };
        setHistory((h) => [evt, ...h].slice(0, 10));
      } else {
        beep(true);
        const evt: ScanEvent = { fnuci: fnuci || veloId, status: "ok", msg: "↺ Vélo désaffilié", at: Date.now() };
        setHistory((h) => [evt, ...h].slice(0, 10));
      }
      await loadProgression();
    } catch (e) {
      beep(false);
      const evt: ScanEvent = { fnuci: fnuci || veloId, status: "error", msg: String(e), at: Date.now() };
      setHistory((h) => [evt, ...h].slice(0, 10));
    } finally {
      setBusy(false);
    }
  }, [busy, loadProgression]);

  // Assigne le FNUCI en attente à un client de la tournée puis valide la préparation.
  const assignAndPrepare = useCallback(async (clientId: string) => {
    if (!pendingFnuci) return;
    const fnuci = pendingFnuci;
    setPendingFnuci(null);
    setBusy(true);
    try {
      const a = await gasPost("assignFnuciToClient", { fnuci, clientId }) as
        { ok?: true; alreadyAssigned?: boolean; veloId?: string; existingClientName?: string | null; error?: string };
      if (a.error) {
        beep(false);
        const evt: ScanEvent = {
          fnuci,
          status: "error",
          msg: a.existingClientName ? `⚠ Déjà chez ${a.existingClientName}` : a.error,
          at: Date.now(),
        };
        setHistory((h) => [evt, ...h].slice(0, 10));
      } else {
        const r = (await gasPost(cfg.endpoint, { fnuci, tourneeId, userId })) as ScanResp;
        if ("ok" in r && r.ok) {
          beep(true);
          const evt: ScanEvent = {
            fnuci: r.fnuci,
            status: "ok",
            msg: "Assigné + " + cfg.title.toLowerCase(),
            clientName: r.clientName,
            at: Date.now(),
          };
          setHistory((h) => [evt, ...h].slice(0, 10));
        } else {
          beep(false);
          const evt: ScanEvent = { fnuci, status: "error", msg: ("error" in r ? r.error : "Erreur"), at: Date.now() };
          setHistory((h) => [evt, ...h].slice(0, 10));
        }
      }
      await loadProgression();
    } catch (e) {
      beep(false);
      const evt: ScanEvent = { fnuci, status: "error", msg: String(e), at: Date.now() };
      setHistory((h) => [evt, ...h].slice(0, 10));
    } finally {
      setBusy(false);
      setTimeout(() => setScannerEnabled(true), 400);
    }
  }, [pendingFnuci, cfg.endpoint, cfg.title, tourneeId, userId, loadProgression]);

  if (!tourneeId) {
    return (
      <div className="min-h-screen p-6 text-center text-sm text-red-600">
        Paramètre <code>tourneeId</code> manquant dans l&apos;URL.
      </div>
    );
  }

  const prog = progression && !("error" in progression) ? progression : null;
  const focusClient = focusClientId && prog ? prog.clients.find((c) => c.clientId === focusClientId) : null;
  // Si focusClientId est passé en URL : on compte uniquement les vélos de ce client
  // pour la barre de progression, mais "Passer à l'étape suivante" reste basé
  // sur la tournée entière (sinon on saute à la livraison alors qu'il reste
  // d'autres clients à charger).
  const totals = focusClient ? focusClient.totals : prog?.totals;
  const counter = totals ? totals[cfg.totalsKey] : 0;
  const total = totals?.total || 0;
  const allDone = total > 0 && counter >= total;
  const tourneeTotals = prog?.totals;
  const tourneeAllDone = !!tourneeTotals && tourneeTotals.total > 0 && tourneeTotals[cfg.totalsKey] >= tourneeTotals.total;

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
            {focusClient && (
              <div className="bg-orange-50 border border-orange-200 rounded p-2 mb-2 text-xs">
                <div className="font-semibold text-orange-900">🎯 Focus client : {focusClient.entreprise}</div>
                <div className="text-orange-700">{focusClient.codePostal} {focusClient.ville}</div>
                <a
                  href={`/crm-velos-cargo/${mode === "preparation" ? "preparation" : mode === "chargement" ? "chargement" : "livraison"}?tourneeId=${encodeURIComponent(tourneeId)}`}
                  className="text-[10px] text-blue-600 underline mt-1 inline-block"
                >
                  Voir la tournée entière →
                </a>
              </div>
            )}
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

        {userId && (
          <div className="bg-white rounded-xl shadow p-2 mb-3 text-sm">
            <span className="text-gray-500">Opérateur :</span> <span className="font-medium">{userName || "?"}</span>
          </div>
        )}

        {pendingFnuci && prog && (
          <div className="bg-orange-50 border-2 border-orange-300 rounded-xl shadow p-4 space-y-3 mb-3">
            <div className="text-sm">
              <div className="font-semibold text-orange-900">📦 FNUCI inconnu — à quel client ?</div>
              <div className="font-mono text-xs bg-white rounded px-2 py-1 mt-1 inline-block">{pendingFnuci}</div>
            </div>
            <div className="space-y-1.5">
              {prog.clients.map((c) => {
                const reste = c.totals.total - c.totals.prepare;
                return (
                  <button
                    key={c.clientId}
                    onClick={() => assignAndPrepare(c.clientId)}
                    disabled={busy}
                    className="w-full text-left border bg-white rounded-lg p-2.5 hover:bg-orange-100 hover:border-orange-400 disabled:opacity-50"
                  >
                    <div className="font-medium text-sm">{c.entreprise}</div>
                    <div className="text-xs text-gray-500">{c.codePostal} {c.ville} · {reste > 0 ? `${reste} vélos restants à préparer` : "complet"}</div>
                  </button>
                );
              })}
            </div>
            <button onClick={() => { setPendingFnuci(null); setScannerEnabled(true); }} className="w-full text-xs text-gray-500 hover:text-gray-700 py-1">
              Annuler
            </button>
          </div>
        )}

        {userId && prog && !pendingFnuci && (
          <>
            <div className="bg-white rounded-xl shadow p-4 space-y-3 mb-3">
              <div className="text-sm text-gray-700">Scanne le QR FNUCI du vélo.</div>
              <QrScanner enabled={scannerEnabled && !allDone && !pendingFnuci} onScan={handleScan} />
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

            {(() => {
              const clientsToShow = focusClient ? [focusClient] : prog.clients;
              // En mode préparation : on inclut TOUS les vélos avec FNUCI affecté
              // (même si datePreparation pas encore set), pour permettre la
              // désaffiliation d'un FNUCI scanné par erreur ou en test.
              // En mode chargement/livraison/montage : on garde le filtre étape
              // actuelle puisque le vélo doit déjà être passé par la prep.
              const includeFnuciWaiting = mode === "preparation";
              type Item = { v: Velo; clientName: string; etapeDone: boolean };
              const items: Item[] = [];
              clientsToShow.forEach((c) => {
                c.velos.forEach((v) => {
                  const etapeDone = !!v[cfg.doneKey];
                  if (etapeDone) {
                    items.push({ v, clientName: c.entreprise, etapeDone: true });
                  } else if (includeFnuciWaiting && v.fnuci) {
                    items.push({ v, clientName: c.entreprise, etapeDone: false });
                  }
                });
              });
              if (items.length === 0) return null;
              const nbDone = items.filter((it) => it.etapeDone).length;
              const nbWaiting = items.length - nbDone;
              return (
                <div className="bg-white rounded-xl shadow p-3 mb-3">
                  <div className="text-xs text-gray-500 mb-2">
                    {nbDone} {cfg.title.toLowerCase()}é{nbDone > 1 ? "s" : ""}
                    {nbWaiting > 0 && (
                      <> · {nbWaiting} FNUCI affecté{nbWaiting > 1 ? "s" : ""} en attente</>
                    )}
                    {" "}— bouton Annuler pour défaire l&apos;étape, Désaffilier pour libérer le vélo (vide aussi le FNUCI).
                  </div>
                  <div className="space-y-1.5 max-h-72 overflow-y-auto">
                    {items.map(({ v, clientName, etapeDone }) => (
                      <div key={v.veloId} className={`border rounded-lg p-2 flex items-center justify-between gap-2 ${etapeDone ? "" : "bg-yellow-50 border-yellow-200"}`}>
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-mono truncate">{v.fnuci || v.veloId}</div>
                          <div className="flex gap-2 items-baseline">
                            {!focusClient && (
                              <div className="text-[10px] text-gray-500 truncate">{clientName}</div>
                            )}
                            {!etapeDone && (
                              <div className="text-[10px] text-yellow-800 font-medium">en attente de {cfg.title.toLowerCase()}</div>
                            )}
                          </div>
                        </div>
                        <div className="flex gap-1 shrink-0">
                          {etapeDone && (
                            <button
                              onClick={() => undoScan(v.veloId, v.fnuci)}
                              disabled={busy}
                              className="text-[11px] px-2 py-1 rounded bg-orange-100 text-orange-800 hover:bg-orange-200 disabled:opacity-50"
                              title={`Annuler ${cfg.title}`}
                            >
                              ↺ Annuler
                            </button>
                          )}
                          {mode === "preparation" && (
                            <button
                              onClick={() => desaffilier(v.veloId, v.fnuci)}
                              disabled={busy}
                              className="text-[11px] px-2 py-1 rounded bg-red-100 text-red-800 hover:bg-red-200 disabled:opacity-50"
                              title="Retirer du client + vider le FNUCI (le vélo retourne au stock dépôt)"
                            >
                              ✕ Désaffilier
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {mode === "preparation" && (() => {
              const cid = focusClientId ? `&clientId=${encodeURIComponent(focusClientId)}` : "";
              return (
                <div className="bg-white rounded-xl shadow p-3 mb-3 grid grid-cols-2 gap-2">
                  <a
                    href={`/crm-velos-cargo/etiquettes?tourneeId=${encodeURIComponent(tourneeId)}${cid}`}
                    target="_blank" rel="noopener noreferrer"
                    className="text-center bg-gray-100 rounded-lg py-3 text-sm font-medium hover:bg-gray-200"
                  >
                    🏷️ Étiquettes
                  </a>
                  <a
                    href={`/crm-velos-cargo/bl?tourneeId=${encodeURIComponent(tourneeId)}${cid}`}
                    target="_blank" rel="noopener noreferrer"
                    className="text-center bg-gray-100 rounded-lg py-3 text-sm font-medium hover:bg-gray-200"
                  >
                    📄 Bon de livraison
                  </a>
                </div>
              );
            })()}

            {tourneeAllDone && cfg.nextLink && (
              <a
                href={`/crm-velos-cargo${cfg.nextLink.href(tourneeId)}`}
                className="block w-full bg-green-600 text-white rounded-lg py-3 font-medium text-center"
              >
                {cfg.nextLink.label}
              </a>
            )}
            {allDone && !tourneeAllDone && cfg.nextLink && tourneeTotals && (
              <div className="bg-yellow-50 border border-yellow-200 text-yellow-900 text-sm rounded-lg p-3 text-center">
                ✅ Ce client est terminé. Encore {tourneeTotals.total - tourneeTotals[cfg.totalsKey]} vélo{tourneeTotals.total - tourneeTotals[cfg.totalsKey] > 1 ? "s" : ""} à {cfg.title.toLowerCase()} sur la tournée avant de passer à l&apos;étape suivante.
                <div className="mt-2">
                  <a
                    href={`/crm-velos-cargo/${mode}?tourneeId=${encodeURIComponent(tourneeId)}`}
                    className="text-xs text-blue-600 underline"
                  >
                    Voir la tournée entière →
                  </a>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
