"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { gasGet, gasPost } from "@/lib/gas";
import { useCurrentUser } from "@/lib/current-user";

import { BASE_PATH } from "@/lib/base-path";
const PhotoGeminiCapture = dynamic(() => import("@/components/photo-gemini-capture"), { ssr: false });
const BlSignedUploader = dynamic(() => import("@/components/bl-signed-uploader"), { ssr: false });
const QrCartonScanner = dynamic(() => import("@/components/qr-carton-scanner"), { ssr: false });

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
  // Quand la Caméra continue Gemini est ouverte, on doit désactiver Strich
  // pour libérer la caméra (iOS Safari = un seul flux à la fois).
  const [geminiCameraOpen, setGeminiCameraOpen] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  // Scan QR carton (29-04 11h30) : à chargement / livraison, l'opérateur peut
  // scanner le QR commun de l'étiquette imprimée — chaque scan marque le 1er
  // vélo du client non-encore-fait pour l'étape. Pas dispo en préparation
  // (la prép assigne le FNUCI, donc nécessite le BicyCode physique).
  const [qrScannerOpen, setQrScannerOpen] = useState<boolean>(false);
  const [qrScanFeedback, setQrScanFeedback] = useState<Array<{ label: string; ok: boolean; at: number }>>([]);
  // En mode préparation, si on scanne un FNUCI inconnu on propose d'assigner
  // à un client de la tournée (fusionne réception + préparation).
  const [pendingFnuci, setPendingFnuci] = useState<string | null>(null);
  // Code FNUCI extrait du dernier QR scanné, affiché brièvement le temps de
  // l'aller-retour API pour confirmer que l'extraction du code BicyCode a marché.
  const [scanPreview, setScanPreview] = useState<string | null>(null);
  // Mode dépannage admin (Yoann 29-04 02h42) : désactive les verrous d'ordre
  // côté serveur (ETAPE_PRECEDENTE_MANQUANTE + ORDRE_VERROUILLE). Visible
  // UNIQUEMENT pour les rôles admin/superadmin. Utile lors de tests/exceptions
  // où il faut livrer dans le désordre.
  const isAdminRole = currentUser?.role === "admin" || currentUser?.role === "superadmin";
  const [bypassOrderLock, setBypassOrderLock] = useState<boolean>(false);

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
    const trimmed = raw.trim();
    // QR BicyCode : encode une URL du type https://www.bicycode.org/.../BC38FKZZ7H
    // Le code FNUCI suit le pattern "BC" + 8 alphanumériques (ex: BC38FKZZ7H,
    // BCZ9CANA4D, BCA24SN97A). On l'extrait où qu'il soit dans la string scannée
    // pour que le scan d'un QR (URL) ou d'un code-barres (texte brut) fonctionne
    // pareil. Si rien ne matche on garde la string telle quelle (saisie manuelle).
    const match = trimmed.match(/BC[A-Z0-9]{8}/i);
    const fnuci = match ? match[0].toUpperCase() : trimmed;
    if (!fnuci || busy) return;
    setScanPreview(fnuci);
    setBusy(true);
    setScannerEnabled(false);
    try {
      const r = (await gasPost(cfg.endpoint, { fnuci, tourneeId, userId, bypassOrderLock: bypassOrderLock || undefined })) as ScanResp;
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
        const err = r as { error: string; code?: string; veloClientName?: string | null; expectedClientName?: string | null };
        let status: ScanEvent["status"] = "error";
        let msg = err.error;
        if (err.code === "HORS_TOURNEE") {
          status = "hors-tournee";
          msg = `⚠ Pas dans cette tournée — ${err.veloClientName || "autre client"}`;
        } else if (err.code === "ETAPE_PRECEDENTE_MANQUANTE") {
          // Verrouillage d'ordre vertical : l'étape précédente (par vélo)
          // n'a pas été faite. Backend renvoie `missing` (ex: ["préparation"]).
          status = "error";
          const miss = (err as { missing?: string[] }).missing || [];
          msg = `⛔ Manque ${miss.join(" + ") || "étape précédente"}`;
        } else if (err.code === "ORDRE_VERROUILLE") {
          // Verrouillage d'ordre horizontal (inter-clients) : on essaie de
          // scanner un client en aval alors que le précédent n'est pas fini.
          // Le verrou frontend (firstUnfinished) devrait déjà l'empêcher, mais
          // c'est la double-sécurité (URL directe / onglet décalé / état stale).
          status = "hors-tournee";
          msg = `⛔ Termine d'abord ${err.expectedClientName || "le client précédent"}`;
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
      setTimeout(() => {
        setScannerEnabled(true);
        setScanPreview(null);
      }, 800);
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
    if (!confirm(`Désaffilier ce vélo ?\n\nFNUCI : ${fnuci || "—"}\nID : ${veloId}\n\nLe FNUCI sera effacé et toutes les étapes (préparation, chargement, livraison, montage) seront réinitialisées. Le slot reste sur la commande du client (qui pourra ré-affilier un nouveau FNUCI dessus).`)) return;
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
        const r = (await gasPost(cfg.endpoint, { fnuci, tourneeId, userId, bypassOrderLock: bypassOrderLock || undefined })) as ScanResp;
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

  // Handler appelé par QrCartonScanner à chaque QR détecté. Vérifie que le
  // clientId existe dans la tournée puis appelle markNextVeloForEtape, qui
  // marque le 1er vélo du client non-encore-fait pour l'étape en cours
  // (chargement ou livraison). Si focusClientId est défini (page ouverte
  // depuis la vignette d'un client précis), on refuse les QR d'autres clients.
  const handleQrCartonScan = useCallback(async (scannedClientId: string) => {
    if (mode === "preparation") return; // jamais en prép
    const etape = mode === "chargement" ? "chargement" : "livraisonScan";
    if (focusClientId && scannedClientId !== focusClientId) {
      beep(false);
      setQrScanFeedback((prev) => [
        ...prev,
        { label: `QR pour un autre client — refusé`, ok: false, at: Date.now() },
      ]);
      return;
    }
    try {
      const r = (await gasPost("markNextVeloForEtape", {
        clientId: scannedClientId,
        tourneeId,
        etape,
        userId,
        bypassOrderLock: bypassOrderLock || undefined,
      })) as
        | { ok: true; fnuci: string | null; clientName: string | null; remaining: number }
        | { ok?: false; error: string; code?: string; clientName?: string | null; expectedClientName?: string | null };
      if ("ok" in r && r.ok) {
        beep(true);
        const fn = r.fnuci || "(sans FNUCI)";
        setQrScanFeedback((prev) => [
          ...prev,
          {
            label: `${r.clientName || "Client"} · ${fn} · reste ${r.remaining}`,
            ok: true,
            at: Date.now(),
          },
        ]);
        // Recharger en arrière-plan pour mettre à jour les compteurs.
        void loadProgression();
      } else {
        beep(false);
        const err = "error" in r ? r.error : "Erreur";
        const target = "expectedClientName" in r && r.expectedClientName
          ? ` (attendu : ${r.expectedClientName})`
          : "";
        setQrScanFeedback((prev) => [
          ...prev,
          { label: `${r.clientName || "Client"} · ${err}${target}`, ok: false, at: Date.now() },
        ]);
      }
    } catch (e) {
      beep(false);
      setQrScanFeedback((prev) => [
        ...prev,
        { label: e instanceof Error ? e.message : String(e), ok: false, at: Date.now() },
      ]);
    }
  }, [mode, focusClientId, tourneeId, userId, bypassOrderLock, loadProgression]);

  if (!tourneeId) {
    return (
      <div className="min-h-screen p-6 text-center text-sm text-red-600">
        Paramètre <code>tourneeId</code> manquant dans l&apos;URL.
      </div>
    );
  }

  // Logistique LIFO du camion :
  //   - en préparation et chargement : l'ordre des clients est INVERSÉ par
  //     rapport à l'ordre de livraison. Le dernier client à livrer est le
  //     premier à charger (au fond du camion). Le premier à livrer entre en
  //     dernier (à l'avant), pour pouvoir sortir en premier.
  //   - en livraison : ordre normal du planning (1, 2, 3...) puisqu'on
  //     décharge dans l'ordre inverse du chargement = ordre prévu.
  const reverseClients = mode === "preparation" || mode === "chargement";
  const progRaw = progression && !("error" in progression) ? progression : null;
  const prog = progRaw
    ? { ...progRaw, clients: reverseClients ? [...progRaw.clients].reverse() : progRaw.clients }
    : null;
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

  // Verrou ordre LIFO : tant que le client N (dans l'ordre prep/charg/livr de
  // la tournée) n'est pas terminé, le N+1 est inaccessible. Pour la prép/charg
  // l'ordre est déjà inversé en amont (LIFO camion). Pour la livraison c'est
  // l'ordre normal de la tournée.
  // → Le `firstUnfinished` est le SEUL client qu'on accepte de scanner ;
  //   tous les suivants sont grisés tant qu'il n'est pas done.
  const firstUnfinished = prog
    ? prog.clients.find((c) => c.totals[cfg.totalsKey] < c.totals.total) || null
    : null;
  const firstUnfinishedClientId = firstUnfinished?.clientId;
  // Détection accès URL en avance : focusClientId qui n'est ni le firstUnfinished
  // ni un client déjà fini (cas légitime: relire les scans). Si on est en avance
  // → on bloque et on renvoie vers le bon client.
  const focusIsAhead = !!(
    focusClientId &&
    focusClient &&
    focusClient.totals[cfg.totalsKey] < focusClient.totals.total &&
    firstUnfinishedClientId &&
    focusClientId !== firstUnfinishedClientId
  );

  // CTA "Passer au client suivant" : pointe sur le firstUnfinished (donc
  // strictement le client autorisé à être traité ensuite, pas un client
  // arbitraire en aval/amont).
  const nextClient =
    focusClientId && firstUnfinished && firstUnfinishedClientId !== focusClientId
      ? firstUnfinished
      : null;
  const nextClientHref = nextClient
    ? `?tourneeId=${encodeURIComponent(tourneeId)}&clientId=${encodeURIComponent(nextClient.clientId)}`
    : null;

  return (
    <div className="min-h-screen bg-gray-50 p-3 md:p-6">
      <div className="max-w-md mx-auto">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-xl font-bold">{cfg.emoji} {cfg.title}</h1>
          <a href={`${BASE_PATH}/livraisons`} className="text-sm text-gray-500 hover:text-gray-700">← Planning</a>
        </div>

        {/* Toggle admin pour scanner dans le désordre. Visible UNIQUEMENT pour
            admin/superadmin. Quand activé, les 2 verrous serveur (étape
            précédente + LIFO inter-clients) sont contournés. À utiliser en
            test/exception ; en usage normal, laisser désactivé. */}
        {isAdminRole && (
          <label
            className={`flex items-center gap-2 mb-3 px-3 py-2 rounded-lg text-xs cursor-pointer ${
              bypassOrderLock
                ? "bg-amber-100 border-2 border-amber-400 text-amber-900 font-semibold"
                : "bg-gray-50 border border-gray-200 text-gray-600"
            }`}
            title="Permet de scanner dans le désordre (test/exception). Désactivé en usage normal."
          >
            <input
              type="checkbox"
              checked={bypassOrderLock}
              onChange={(e) => setBypassOrderLock(e.target.checked)}
            />
            <span>
              {bypassOrderLock
                ? "🔓 MODE ADMIN ACTIVÉ — verrous d'ordre désactivés"
                : "🔒 Mode admin (scanner dans le désordre)"}
            </span>
          </label>
        )}

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
              <div className="bg-orange-50 border border-orange-200 rounded p-3 mb-2">
                <div className="text-[11px] uppercase tracking-wide text-orange-700 font-medium">🎯 Client en cours</div>
                <div className="font-bold text-xl sm:text-lg text-orange-900 leading-tight mt-0.5 break-words">{focusClient.entreprise}</div>
                <div className="text-sm text-orange-700 mt-0.5">{focusClient.codePostal} {focusClient.ville}</div>
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
                // Verrou LIFO : seul le premier client non-fini peut recevoir le FNUCI.
                // Les clients déjà finis ne sont pas une option (reste=0). Les clients
                // en aval restent visibles pour donner le contexte mais grisés.
                const isLocked = !!(firstUnfinishedClientId && c.clientId !== firstUnfinishedClientId);
                return (
                  <button
                    key={c.clientId}
                    onClick={() => assignAndPrepare(c.clientId)}
                    disabled={busy || isLocked || reste <= 0}
                    title={isLocked ? `Termine d'abord ${firstUnfinished?.entreprise}` : undefined}
                    className="w-full text-left border bg-white rounded-lg p-2.5 hover:bg-orange-100 hover:border-orange-400 disabled:opacity-40 disabled:hover:bg-white disabled:hover:border-gray-200"
                  >
                    <div className="font-medium text-sm">
                      {c.entreprise}
                      {isLocked && <span className="ml-2 text-[10px] font-normal text-gray-500">⛔ verrouillé</span>}
                    </div>
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

        {focusIsAhead && firstUnfinished && (
          <div className="bg-amber-50 border-2 border-amber-400 rounded-xl shadow p-4 mb-3 space-y-3">
            <div className="text-sm">
              <div className="font-semibold text-amber-900">⛔ Ordre {cfg.title.toLowerCase()} verrouillé</div>
              <div className="text-amber-800 mt-1">
                Tu dois d&apos;abord terminer <strong>{firstUnfinished.entreprise}</strong>
                {" "}({firstUnfinished.totals[cfg.totalsKey]}/{firstUnfinished.totals.total})
                avant de passer à <strong>{focusClient?.entreprise}</strong>.
              </div>
              <div className="text-xs text-amber-700 mt-1">
                {mode === "preparation" || mode === "chargement"
                  ? "Le dernier client à livrer rentre en premier dans le camion : on prépare/charge dans l'ordre inverse de la livraison."
                  : "On livre dans l'ordre de la tournée pour respecter l'ordre du camion."}
              </div>
            </div>
            <a
              href={nextClientHref || "#"}
              className="block text-center bg-amber-600 text-white rounded-lg py-3 text-sm font-semibold hover:bg-amber-700"
            >
              → Aller à {firstUnfinished.entreprise}
            </a>
          </div>
        )}

        {userId && prog && !pendingFnuci && !focusIsAhead && (
          <>
            {/* Le scan QR Strich + saisie manuelle FNUCI a été retiré pour les
                3 étapes préparation / chargement / livraison : toutes passent
                désormais exclusivement par la caméra continue Gemini (ou photo
                unique) du composant PhotoGeminiCapture juste en dessous.
                Le bloc Strich n'est plus rendu — `handleScan` reste défini car
                il est encore utilisé par le panneau "FNUCI inconnu — à quel
                client ?" plus haut. */}

            {/* Scan QR carton : remplace le scan BicyCode pour chargement / livraison.
                Pas dispo en préparation (la prép assigne le FNUCI, le QR carton n'existe pas
                encore à ce moment-là). */}
            {(mode === "chargement" || mode === "livraison") && (
              <div className="bg-white rounded-xl shadow p-4 mb-3">
                <button
                  type="button"
                  disabled={allDone}
                  onClick={() => {
                    setQrScanFeedback([]);
                    setQrScannerOpen(true);
                  }}
                  className="w-full px-3 py-3 bg-emerald-600 text-white rounded-lg font-semibold hover:bg-emerald-700 disabled:opacity-60 text-sm"
                >
                  📦 Scanner QR carton ({cfg.title.toLowerCase()})
                </button>
                <p className="text-[11px] text-gray-500 text-center mt-2">
                  Ouvre la caméra et mitraille les étiquettes carton — chaque QR scanné marque automatiquement le prochain vélo du client.
                </p>
              </div>
            )}

            <div className="bg-white rounded-xl shadow p-4 mb-3">
              <PhotoGeminiCapture
                tourneeId={tourneeId}
                userId={userId}
                etape={cfg.unmarkEtape}
                onAfter={loadProgression}
                disabled={allDone}
                clients={"clients" in prog ? prog.clients.map((c) => ({
                  clientId: c.clientId,
                  entreprise: c.entreprise,
                  total: c.totals.total,
                  // `done` = compteur de l'étape courante (prepare en préparation,
                  // charge en chargement, livre en livraison) — sert au "X/Y
                  // déjà fait" dans le bandeau de verrouillage et le sélecteur.
                  done: c.totals[cfg.totalsKey],
                })) : undefined}
                lockedClientId={focusClientId || undefined}
                nextEligibleClientId={firstUnfinishedClientId}
                onCameraToggle={setGeminiCameraOpen}
                bypassOrderLock={bypassOrderLock}
              />
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

            {mode === "preparation" && allDone && (() => {
              const cid = focusClientId ? `&clientId=${encodeURIComponent(focusClientId)}` : "";
              const nbVelos = total;
              const cibleNom = focusClient?.entreprise || "la tournée";
              return (
                <div className="bg-emerald-50 border-2 border-emerald-500 rounded-xl p-4 mb-3 space-y-3">
                  <div className="text-center space-y-1">
                    <div className="text-3xl">🎉</div>
                    <div className="text-emerald-900 font-bold text-base">
                      {nbVelos}/{nbVelos} préparés pour {cibleNom}
                    </div>
                    <div className="text-emerald-700 text-xs">
                      Imprime maintenant les étiquettes à coller sur le carton et le bon de livraison.
                    </div>
                  </div>
                  <a
                    href={`${BASE_PATH}/etiquettes?tourneeId=${encodeURIComponent(tourneeId)}${cid}`}
                    target="_blank" rel="noopener noreferrer"
                    className="block text-center bg-emerald-600 text-white rounded-lg py-3 text-sm font-semibold hover:bg-emerald-700"
                  >
                    🏷️ Imprimer les {nbVelos} étiquette{nbVelos > 1 ? "s" : ""} (10×15)
                  </a>
                  <a
                    href={`${BASE_PATH}/bl?tourneeId=${encodeURIComponent(tourneeId)}${cid}`}
                    target="_blank" rel="noopener noreferrer"
                    className="block text-center bg-white border border-emerald-400 text-emerald-800 rounded-lg py-3 text-sm font-semibold hover:bg-emerald-100"
                  >
                    📄 Imprimer le bon de livraison (A4)
                  </a>
                </div>
              );
            })()}

            {/* Livraison terminée pour ce client → photo du BL signé +
                bouton "Marquer comme livré". Les 2 blocs s'affichent dès que
                tous les vélos du client ont été marqués livrés. */}
            {mode === "livraison" && allDone && focusClientId && (() => {
              // Calcule le prochain client de la tournée à livrer pour
              // proposer un redirect après "Marquer comme livré". On parcourt
              // prog.clients dans l'ordre (= ordre du planning) et on prend
              // le 1er après le client courant qui n'a pas encore tous ses
              // vélos livrés. Si rien après, on cherche avant (cas où le
              // chauffeur fait sa tournée dans un ordre différent).
              let nextClient: typeof prog.clients[number] | null = null;
              if ("clients" in prog && focusClient) {
                const list = prog.clients;
                const idx = list.findIndex((c) => c.clientId === focusClient.clientId);
                for (let i = idx + 1; i < list.length; i++) {
                  if (list[i].totals.livre < list[i].totals.total) {
                    nextClient = list[i];
                    break;
                  }
                }
                if (!nextClient && idx > 0) {
                  for (let i = 0; i < idx; i++) {
                    if (list[i].totals.livre < list[i].totals.total) {
                      nextClient = list[i];
                      break;
                    }
                  }
                }
              }
              const nextUrl = nextClient
                ? `${BASE_PATH}/livraison?tourneeId=${encodeURIComponent(tourneeId)}&clientId=${encodeURIComponent(nextClient.clientId)}`
                : null;
              return (
                <>
                  <div className="mb-3">
                    <BlSignedUploader
                      tourneeId={tourneeId}
                      clientId={focusClientId}
                    />
                  </div>
                  <DeliveredButton
                    tourneeId={tourneeId}
                    clientId={focusClientId}
                    clientName={focusClient?.entreprise}
                    nextUrl={nextUrl}
                    nextClientName={nextClient?.entreprise}
                    onDelivered={loadProgression}
                  />
                </>
              );
            })()}

            {tourneeAllDone && cfg.nextLink && (
              <a
                href={`${BASE_PATH}${cfg.nextLink.href(tourneeId)}`}
                className="block w-full bg-green-600 text-white rounded-lg py-3 font-medium text-center"
              >
                {cfg.nextLink.label}
              </a>
            )}
            {allDone && !tourneeAllDone && nextClient && nextClientHref && (
              <a
                href={nextClientHref}
                className="block w-full bg-blue-600 text-white rounded-xl py-4 px-4 text-center shadow hover:bg-blue-700"
              >
                <div className="text-xs uppercase tracking-wide opacity-80">→ Client suivant</div>
                <div className="font-bold text-lg leading-tight mt-0.5">{nextClient.entreprise}</div>
                <div className="text-xs opacity-80 mt-0.5">
                  {nextClient.totals.total - nextClient.totals[cfg.totalsKey]} vélo
                  {nextClient.totals.total - nextClient.totals[cfg.totalsKey] > 1 ? "s" : ""} à {cfg.title.toLowerCase()}
                </div>
              </a>
            )}
            {allDone && !tourneeAllDone && cfg.nextLink && tourneeTotals && (
              <div className="bg-yellow-50 border border-yellow-200 text-yellow-900 text-sm rounded-lg p-3 text-center">
                ✅ Ce client est terminé. Encore {tourneeTotals.total - tourneeTotals[cfg.totalsKey]} vélo{tourneeTotals.total - tourneeTotals[cfg.totalsKey] > 1 ? "s" : ""} à {cfg.title.toLowerCase()} sur la tournée avant de passer à l&apos;étape suivante.
              </div>
            )}
          </>
        )}
      </div>
      {qrScannerOpen && (
        <QrCartonScanner
          title={`📦 ${cfg.title} — scan QR carton`}
          subtitle={
            focusClient
              ? `Pour ${focusClient.entreprise} uniquement`
              : "Scanne n'importe quelle étiquette carton de la tournée"
          }
          onScan={handleQrCartonScan}
          onClose={() => {
            setQrScannerOpen(false);
            void loadProgression();
          }}
          recentScans={qrScanFeedback}
        />
      )}
    </div>
  );
}

// Bouton "✅ Marquer comme livré" qui apparaît quand tous les vélos du client
// sont scannés livrés sur la page livraison. Côté serveur, ça passe le statut
// de la livraison en "livree" et remplit dateEffective. Une fois validé, on
// redirige vers la prochaine livraison de la tournée pour que le chauffeur
// enchaîne sans repasser par le planning.
function DeliveredButton({
  tourneeId,
  clientId,
  clientName,
  nextUrl,
  nextClientName,
  onDelivered,
}: {
  tourneeId: string;
  clientId: string;
  clientName?: string;
  /** URL de la livraison suivante (null si tournée terminée). Le chauffeur
   *  est redirigé automatiquement ~2.5s après le succès, le temps de voir
   *  l'état "Livraison validée 🎉". */
  nextUrl?: string | null;
  nextClientName?: string;
  onDelivered?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const submit = async () => {
    if (!confirm(`Marquer la livraison de ${clientName || "ce client"} comme livrée ?\n\nCette action passe la livraison en statut « Livrée » avec la date d'aujourd'hui.`)) return;
    setErrMsg(null);
    setBusy(true);
    try {
      const r = (await gasPost("markClientAsDelivered", { tourneeId, clientId })) as
        | { ok: true; statut: string; dateEffective: string }
        | { error: string };
      if ("error" in r) {
        setErrMsg(r.error);
        return;
      }
      setDone(true);
      if (onDelivered) onDelivered();
      // Redirection auto vers le prochain client à livrer. 2.5s pour laisser
      // voir le message "Livraison validée" avant de naviguer.
      if (nextUrl) {
        setTimeout(() => {
          window.location.href = nextUrl;
        }, 2500);
      }
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="bg-emerald-50 border-2 border-emerald-500 rounded-xl p-4 mb-3 text-center">
        <div className="text-3xl">🎉</div>
        <div className="font-bold text-emerald-900 mt-1">
          Livraison validée pour {clientName || "ce client"}
        </div>
        <div className="text-xs text-emerald-700 mt-1">
          Statut passé à « Livrée » · BL archivé sur Drive
        </div>
        {nextUrl && nextClientName ? (
          <div className="mt-3 bg-white border border-emerald-300 rounded-lg p-2 text-sm text-emerald-900">
            <div className="font-medium">→ Prochaine livraison : {nextClientName}</div>
            <div className="text-xs text-emerald-700 mt-0.5">
              Redirection automatique dans quelques secondes…
            </div>
            <a
              href={nextUrl}
              className="inline-block mt-1.5 text-xs underline text-emerald-800"
            >
              Y aller maintenant
            </a>
          </div>
        ) : (
          <div className="mt-3 text-sm text-emerald-900 font-medium">
            🏁 Tournée terminée — plus de livraison à effectuer.
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mb-3 space-y-2">
      <button
        onClick={submit}
        disabled={busy}
        className="w-full bg-green-600 text-white rounded-lg py-3 font-semibold hover:bg-green-700 disabled:opacity-50"
      >
        {busy ? "Validation…" : "✅ Marquer comme livré"}
      </button>
      {nextClientName && (
        <div className="text-[11px] text-gray-500 text-center">
          Après validation : redirection vers la prochaine livraison ({nextClientName}).
        </div>
      )}
      {errMsg && (
        <div className="bg-red-50 border border-red-200 text-red-800 text-xs rounded p-2">
          {errMsg}
        </div>
      )}
    </div>
  );
}
