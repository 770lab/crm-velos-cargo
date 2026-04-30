"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { gasPost, gasUpload } from "@/lib/gas";

import { BASE_PATH } from "@/lib/base-path";
// Capture photo iOS → upload GAS → Gemini Vision extrait les FNUCI → marquage
// d'étape pour chaque code reconnu. Solution de remplacement au scan QR direct
// (Strich/zbar/jsQR) qui n'arrive pas à lire les BicyCode plastifiés sur iOS
// Safari. Gemini lit à la fois le QR et le texte imprimé en clair → double
// redondance, et le serveur valide chaque code par regex avant de toucher au
// sheet → zéro hallucination dans la base.
//
// Pattern UX inspiré du Multi-pièces de luze-vintage-manager : on AJOUTE les
// photos à un batch (vignette + status pending), l'utilisateur peut retirer
// les flous, puis clique "🤖 Identifier" pour lancer l'analyse Gemini en
// parallèle. Chaque carte se met à jour live.

export type GeminiEtape = "preparation" | "chargement" | "livraisonScan";

type ExtractResp =
  | {
      ok: true;
      extracted: string[];
      invalid: string[];
      results: Array<{ fnuci: string; result: unknown; assigned?: unknown }>;
      rawGeminiText?: string;
    }
  | { error: string; rawText?: string; body?: string };

// Wrapper autour de gasUpload qui :
//   1. timeout au bout de TIMEOUT_MS — sinon une requête hung bloquerait la
//      carte sur "🤖 Gemini analyse…" indéfiniment ;
//   2. retry automatiquement 1× si la 1re tentative timeout/fail.
//   3. retry aussi sur 503/UNAVAILABLE renvoyé en JSON (Gemini saturé).
// Au-delà de 2 essais, l'erreur remonte → la carte passe en rouge avec son
// bouton "↻ Réessayer" et l'utilisateur peut retenter manuellement.
//
// 50s de timeout (29-04 11h) : la Cloud Function fait elle-même 3 retries en
// backoff (1s/3s/7s) sur 503, donc une 1re tentative légitime peut durer ~30s.
// Avec un timeout de 30s côté front on coupait avant le retry backend → le
// front ré-appelait, doublait la charge sur Gemini, et boom cascade de 503.
const TIMEOUT_MS = 50000;
const RETRY_DELAY_MS = 2000;

// Pour chaque résultat Gemini "ok" : écrit dans Firestore l'équivalent de ce
// que GAS a fait dans son Sheet, pour que le reste de l'app (qui lit Firestore)
// voie les vélos affectés et marqués prep/charg/livr. SÉQUENTIEL pour éviter
// les races sur assignFnuciToClient (qui prend "le 1er slot vide").
async function mirrorGeminiResultsToFirestore(
  responses: ExtractResp[],
  etape: GeminiEtape,
  clientId: string | null,
  tourneeId: string,
  userId: string | null,
  bypassOrderLock: boolean = false,
): Promise<{ failed: Array<{ fnuci: string; error: string }> }> {
  // Important: depuis la migration Firestore, gasPost résout DIRECTEMENT
  // sur Firestore (USE_FIREBASE=1) — il n'y a plus de filet GAS en aval.
  // On collecte les erreurs pour les remonter à l'UI au lieu de les
  // avaler silencieusement (sinon un scan "OK Gemini" apparaît mais le
  // vélo reste invisible côté compteurs préparation → bug fantôme).
  const failed: Array<{ fnuci: string; error: string }> = [];
  for (const resp of responses) {
    if (!("ok" in resp) || !resp.ok || !resp.results) continue;
    for (const r of resp.results) {
      const result = r.result as { ok?: true } | { error: string } | null;
      if (!(result && "ok" in result && result.ok)) continue;
      try {
        // gasPost ne throw PAS sur {error: ...} — il return l'objet tel quel.
        // On vérifie donc explicitement chaque retour pour capturer les codes
        // serveur (HORS_TOURNEE, ETAPE_PRECEDENTE_MANQUANTE, ORDRE_VERROUILLE,
        // FNUCI_INCONNU). Sinon un scan "OK Gemini" affiche succès mais le
        // vélo n'est pas marqué → bug fantôme côté compteurs.
        const checkResp = (resp: unknown): string | null => {
          if (resp && typeof resp === "object" && "error" in resp) {
            const r = resp as {
              error?: string;
              code?: string;
              expectedClientName?: string | null;
              missing?: string[];
            };
            if (r.code === "ORDRE_VERROUILLE") {
              return `⛔ Termine d'abord ${r.expectedClientName || "le client précédent"}`;
            }
            if (r.code === "ETAPE_PRECEDENTE_MANQUANTE") {
              return `⛔ Manque ${(r.missing || []).join(" + ") || "étape précédente"}`;
            }
            return r.error || "Erreur serveur";
          }
          return null;
        };
        let serverErr: string | null = null;
        const bypass = bypassOrderLock || undefined;
        if (etape === "preparation") {
          if (clientId) {
            const a = await gasPost("assignFnuciToClient", { fnuci: r.fnuci, clientId });
            serverErr = checkResp(a);
          }
          if (!serverErr) {
            const m = await gasPost("markVeloPrepare", { fnuci: r.fnuci, tourneeId, userId: userId || "", bypassOrderLock: bypass });
            serverErr = checkResp(m);
          }
        } else if (etape === "chargement") {
          const m = await gasPost("markVeloCharge", { fnuci: r.fnuci, tourneeId, userId: userId || "", bypassOrderLock: bypass });
          serverErr = checkResp(m);
        } else if (etape === "livraisonScan") {
          const m = await gasPost("markVeloLivreScan", { fnuci: r.fnuci, tourneeId, userId: userId || "", bypassOrderLock: bypass });
          serverErr = checkResp(m);
        }
        if (serverErr) {
          failed.push({ fnuci: r.fnuci, error: serverErr });
          console.warn("[scan] mirror serveur a refusé", r.fnuci, etape, serverErr);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failed.push({ fnuci: r.fnuci, error: msg });
        console.error("[scan] mirror Firestore failed", r.fnuci, etape, msg);
      }
    }
  }
  return { failed };
}

async function callExtractWithRetry(
  body: Record<string, unknown>,
): Promise<ExtractResp> {
  let lastErr: unknown = null;
  let lastResp: ExtractResp | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await Promise.race([
        gasUpload("extractFnuciFromImage", body) as Promise<ExtractResp>,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout après ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS),
        ),
      ]);
      // Si la Cloud Function renvoie un { error: "Gemini HTTP 503 …" } malgré
      // ses propres retries internes, on retente une fois côté front (2s plus
      // tard) — Gemini était peut-être en peak, ça libère vite.
      if ("error" in resp && /503|UNAVAILABLE|429/i.test(resp.error || "")) {
        lastResp = resp;
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }
      }
      return resp;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }
  if (lastResp) return lastResp;
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

type BatchItem = {
  id: string;
  fileName: string;
  thumbDataUrl: string;
  base64: string;
  mimeType: string;
  status: "pending" | "processing" | "done" | "error";
  resp?: ExtractResp;
  errorMsg?: string;
  // Erreur de mirroring serveur (30-04 12h55, demande Yoann "bloque-moi
  // visuellement quand je scanne le mauvais numéro"). Si Gemini extrait
  // un FNUCI valide format mais que markVeloPrepare/Charge/LivreScan
  // échoue côté serveur (FNUCI_INCONNU, hors tournée, etc.), on marque
  // la vignette en rouge avec le message au lieu du "1/1 marqué" vert.
  mirrorError?: string;
  // Validation humaine prep (30-04 13h45) : FNUCI éditable proposé par Gemini,
  // attente du clic "Valider" de l'opérateur avant le mirror Firestore.
  pendingFnuci?: string;
  validatedFnuci?: string;
};

export type GeminiClientOption = {
  clientId: string;
  entreprise: string;
  total: number;
  /** Nombre de vélos déjà marqués pour l'étape courante (préparation,
   * chargement, ou livraison) — sert à afficher le compteur "X/Y déjà fait". */
  done: number;
};

export default function PhotoGeminiCapture({
  tourneeId,
  userId,
  etape,
  onAfter,
  disabled,
  clients,
  lockedClientId,
  nextEligibleClientId,
  onCameraToggle,
  bypassOrderLock = false,
}: {
  tourneeId: string;
  userId: string | null;
  etape: GeminiEtape;
  onAfter?: () => void;
  disabled?: boolean;
  /** Clients de la tournée. Si fourni, l'opérateur peut sélectionner un client
   * pour assigner automatiquement les FNUCI extraits à ce client (workflow
   * préparateur en stock). */
  clients?: GeminiClientOption[];
  /** Si défini, fige l'attribution sur ce client (ex: page ouverte depuis la
   * vignette "Prép. 0/7" d'un client précis). Le dropdown disparaît, on affiche
   * juste un bandeau "Préparation pour <nom>". Évite les erreurs de sélection. */
  lockedClientId?: string;
  /** Verrou ordre LIFO : seul ce client (le 1er non-fini de la tournée pour
   * l'étape courante) peut être sélectionné dans le dropdown. Les autres
   * clients restent visibles mais grisés. */
  nextEligibleClientId?: string;
  /** Notifie le parent quand la caméra continue s'ouvre/ferme. Permet de
   * désactiver le scanner Strich (qui tient la caméra) le temps que Gemini
   * Vision en prenne le contrôle — iOS Safari = 1 seule appli active. */
  onCameraToggle?: (open: boolean) => void;
  /** Mode admin : désactive les verrous d'ordre côté serveur. Visible
   * uniquement pour admin/superadmin via le toggle dans tournee-scan-flow.
   * Permet de scanner dans le désordre lors de tests/exception. */
  bypassOrderLock?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [items, setItems] = useState<BatchItem[]>([]);
  const [adding, setAdding] = useState(false);
  const [identifying, setIdentifying] = useState(false);
  const [forceClientId, setForceClientId] = useState<string>("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [shooting, setShooting] = useState(false);
  const [mirrorErrors, setMirrorErrors] = useState<Array<{ fnuci: string; error: string }>>([]);
  // Saisie manuelle FNUCI (30-04 12h28 : Gemini hallucine sur des chars
  // ambigus 0/O, S/5, Z/2 → l'opérateur tape les 10 chars du BicyCode lisibles).
  const [manualFnuci, setManualFnuci] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [manualMsg, setManualMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Si lockedClientId fourni, on force forceClientId à cette valeur. L'effet
  // garantit que ça reste sync même si la URL change pendant la session.
  useEffect(() => {
    if (lockedClientId) setForceClientId(lockedClientId);
  }, [lockedClientId]);

  const lockedClient = lockedClientId
    ? clients?.find((c) => c.clientId === lockedClientId)
    : undefined;

  const removeItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }, []);

  const clearAll = useCallback(() => {
    setItems([]);
  }, []);

  const openCamera = useCallback(async () => {
    setCameraError(null);
    // Notifie le parent EN AMONT pour qu'il libère le scanner Strich avant
    // qu'on appelle getUserMedia. Sinon Strich tient déjà la caméra et notre
    // requête se solde par un flux noir (vu en prod sur iOS Safari).
    if (onCameraToggle) onCameraToggle(true);
    // Petit délai pour laisser le temps à Strich de relâcher la caméra
    // (le useEffect cleanup côté qr-scanner appelle reader.destroy() async).
    await new Promise((r) => setTimeout(r, 250));
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      streamRef.current = stream;
      setCameraOpen(true);
    } catch (e) {
      setCameraError(e instanceof Error ? e.message : String(e));
      setCameraOpen(true); // afficher l'overlay quand même pour montrer l'erreur
    }
  }, [onCameraToggle]);

  const closeCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setCameraOpen(false);
    setShooting(false);
    if (onCameraToggle) onCameraToggle(false);
  }, [onCameraToggle]);

  // Branche le stream sur le <video> dès que l'overlay est monté.
  // Pas de cleanup ici qui dépendrait de cameraOpen : la closure capturerait
  // l'ANCIENNE valeur (false), et au flip false→true la cleanup précédente
  // arrêterait les tracks du flux qu'on vient d'acquérir → écran noir. La
  // libération de la caméra est gérée explicitement par closeCamera() et par
  // l'effet d'unmount juste en-dessous.
  useEffect(() => {
    if (cameraOpen && videoRef.current && streamRef.current) {
      const v = videoRef.current;
      v.srcObject = streamRef.current;
      const tryPlay = () => v.play().catch(() => {});
      tryPlay();
      // iOS Safari peut ignorer le premier play() si l'autoplay-gesture est
      // perdu derrière l'await getUserMedia. On retente sur loadedmetadata.
      v.addEventListener("loadedmetadata", tryPlay, { once: true });
    }
  }, [cameraOpen]);

  // Sécurité : à la destruction du composant, libérer la caméra.
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, []);

  const wasOpenRef = useRef(false);

  const captureFrame = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    setShooting(true);
    try {
      const compressed = compressVideoFrame(video, 1280, 0.75);
      const item: BatchItem = {
        id: makeId(),
        fileName: `shot-${Date.now()}.jpg`,
        thumbDataUrl: `data:${compressed.mimeType};base64,${compressed.base64}`,
        base64: compressed.base64,
        mimeType: compressed.mimeType,
        status: "pending",
      };
      setItems((prev) => [...prev, item]);
      // Petit retour haptique si dispo (iOS Safari ne supporte pas vibrate, mais c'est cheap).
      if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
        navigator.vibrate(20);
      }
    } finally {
      // Court délai pour montrer le flash, puis re-armer.
      setTimeout(() => setShooting(false), 120);
    }
  }, []);

  const identifyAll = useCallback(async () => {
    if (!tourneeId) return;
    const pendingIds = items.filter((i) => i.status === "pending").map((i) => i.id);
    if (pendingIds.length === 0) return;
    setIdentifying(true);
    setItems((prev) =>
      prev.map((i) => (pendingIds.includes(i.id) ? { ...i, status: "processing" } : i)),
    );

    // Pool de concurrence MAX_PARALLEL (29-04 11h : un Promise.all sur 28 photos
    // saturait Gemini → 503 UNAVAILABLE en cascade + 27/28 timeouts). On lance
    // au plus 3 requêtes en parallèle, le reste attend dans la queue. Combiné
    // au retry exponentiel côté Cloud Function (1s/3s/7s + jitter), ça absorbe
    // les pics sans saturer l'API.
    const MAX_PARALLEL = 3;
    const collectedResps: ExtractResp[] = [];
    const queue = [...pendingIds];
    const runOne = async (id: string) => {
      const item = items.find((it) => it.id === id);
      if (!item) return;
      try {
        const resp = await callExtractWithRetry({
          imageBase64: item.base64,
          mimeType: item.mimeType,
          tourneeId,
          userId,
          etape,
          forceClientId: forceClientId || undefined,
        });
        collectedResps.push(resp);
        // Pré-rempli pendingFnuci avec le 1er FNUCI extrait Gemini, pour
        // que l'opérateur puisse l'éditer avant validation (mode prep).
        const firstExtracted =
          "ok" in resp && resp.extracted && resp.extracted.length > 0
            ? resp.extracted[0]
            : "";
        setItems((prev) =>
          prev.map((it) =>
            it.id === id ? { ...it, status: "done", resp, pendingFnuci: firstExtracted } : it,
          ),
        );
      } catch (e) {
        setItems((prev) =>
          prev.map((it) =>
            it.id === id
              ? { ...it, status: "error", errorMsg: e instanceof Error ? e.message : String(e) }
              : it,
          ),
        );
      }
    };
    const workers = Array.from({ length: Math.min(MAX_PARALLEL, queue.length) }, async () => {
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) break;
        await runOne(next);
      }
    });
    await Promise.all(workers);

    // VALIDATION HUMAINE en mode preparation (30-04 13h45 demande Yoann) :
    // une hallucination Gemini à la prep contamine TOUT le système (étiquettes
    // imprimées, scan chargement/livraison/montage qui matchent plus jamais).
    // → on N'écrit RIEN auto en mode prep. L'opérateur visualise chaque
    // vignette photo + le FNUCI proposé par Gemini, peut le corriger dans
    // un input éditable, et valide individuellement (= mirror Firestore).
    //
    // Aux autres étapes (chargement/livraison) le FNUCI prep en base sert
    // de référence : si Gemini hallucine, le serveur dit FNUCI_INCONNU et
    // n'écrit rien -> pas de pollution possible. Donc auto-mirror OK ailleurs.
    if (etape !== "preparation") {
      const { failed } = await mirrorGeminiResultsToFirestore(
        collectedResps, etape, forceClientId, tourneeId, userId, bypassOrderLock,
      );
      if (failed.length) {
        const summary = failed.map((f) => `${f.fnuci}: ${f.error}`).join("\n");
        setMirrorErrors(failed);
        console.error(`[scan] ${failed.length} écriture(s) Firestore échouée(s)\n${summary}`);
      } else {
        setMirrorErrors([]);
      }
    }

    setIdentifying(false);
    if (onAfter) onAfter();
  }, [items, tourneeId, userId, etape, forceClientId, onAfter]);

  // Auto-déclenchement de l'identification quand on ferme la caméra continue.
  // wasOpenRef évite de tirer sur le mount initial (cameraOpen=false dès le départ).
  useEffect(() => {
    if (wasOpenRef.current && !cameraOpen) {
      const hasPending = items.some((i) => i.status === "pending");
      if (hasPending) {
        Promise.resolve().then(() => identifyAll());
      }
    }
    wasOpenRef.current = cameraOpen;
  }, [cameraOpen, items, identifyAll]);

  // Retry d'un item qui a foiré (réseau, FNUCI_INCONNU, 0 codes extraits…).
  // On garde la photo, on relance juste l'extraction + marquage côté serveur.
  // On reçoit l'item complet en argument (pas juste l'id) pour éviter une
  // capture-via-setItems qui peut être bloquée en concurrent mode React.
  // Validation humaine d'un item prep (30-04 13h45). Mirror Firestore avec le
  // FNUCI confirmé par l'opérateur (= pendingFnuci édité). Met à jour
  // validatedFnuci pour que la vignette passe en vert "✓ Validé".
  const validatePrepItem = useCallback(
    async (itemId: string, finalFnuci: string) => {
      const fn = finalFnuci.trim().toUpperCase();
      if (!/^BC[A-Z0-9]{8}$/.test(fn)) {
        setItems((prev) =>
          prev.map((it) =>
            it.id === itemId
              ? { ...it, mirrorError: "Format invalide (BC + 8 chars MAJ)" }
              : it,
          ),
        );
        return;
      }
      try {
        let serverErr: string | null = null;
        if (forceClientId) {
          const a = (await gasPost("assignFnuciToClient", { fnuci: fn, clientId: forceClientId })) as {
            ok?: boolean;
            error?: string;
            alreadySameClient?: boolean;
          };
          if (a.error && !a.alreadySameClient) {
            serverErr = a.error;
          }
        }
        if (!serverErr) {
          const m = (await gasPost("markVeloPrepare", {
            fnuci: fn,
            tourneeId,
            userId: userId || "",
            bypassOrderLock: bypassOrderLock || undefined,
          })) as { ok?: boolean; error?: string };
          if (m.error) serverErr = m.error;
        }
        if (serverErr) {
          setItems((prev) =>
            prev.map((it) => (it.id === itemId ? { ...it, mirrorError: serverErr || "" } : it)),
          );
          return;
        }
        setItems((prev) =>
          prev.map((it) =>
            it.id === itemId
              ? { ...it, validatedFnuci: fn, mirrorError: undefined }
              : it,
          ),
        );
        if (onAfter) onAfter();
      } catch (e) {
        setItems((prev) =>
          prev.map((it) =>
            it.id === itemId ? { ...it, mirrorError: e instanceof Error ? e.message : String(e) } : it,
          ),
        );
      }
    },
    [forceClientId, tourneeId, userId, bypassOrderLock, onAfter],
  );

  const retryItem = useCallback(async (item: BatchItem) => {
    if (!tourneeId || !item.base64) return;
    setItems((prev) =>
      prev.map((it) =>
        it.id === item.id ? { ...it, status: "processing", resp: undefined, errorMsg: undefined } : it,
      ),
    );
    try {
      const resp = await callExtractWithRetry({
        imageBase64: item.base64,
        mimeType: item.mimeType,
        tourneeId,
        userId,
        etape,
        forceClientId: forceClientId || undefined,
      });
      setItems((prev) =>
        prev.map((it) => (it.id === item.id ? { ...it, status: "done", resp } : it)),
      );
      const { failed } = await mirrorGeminiResultsToFirestore(
        [resp], etape, forceClientId, tourneeId, userId, bypassOrderLock,
      );
      if (failed.length) {
        setMirrorErrors((prev) => [...prev, ...failed]);
        console.error(`[scan retry] ${failed.length} écriture(s) Firestore échouée(s)`);
      }
    } catch (e) {
      setItems((prev) =>
        prev.map((it) =>
          it.id === item.id
            ? { ...it, status: "error", errorMsg: e instanceof Error ? e.message : String(e) }
            : it,
        ),
      );
    }
    if (onAfter) onAfter();
  }, [tourneeId, userId, etape, forceClientId, onAfter]);

  // Validation manuelle d'un FNUCI tapé (30-04 12h28). Bypass Gemini quand
  // les caractères ambigus (0/O, S/5, Z/2) le mettent en échec. Appelle
  // directement la même action serveur que la photo réussie aurait appelée :
  // - preparation : assignFnuciToClient (si forceClientId) puis markVeloPrepare
  // - chargement : markVeloCharge
  // - livraisonScan : markVeloLivreScan
  const submitManual = useCallback(async () => {
    setManualMsg(null);
    const fn = manualFnuci.trim().toUpperCase();
    if (!/^BC[A-Z0-9]{8}$/.test(fn)) {
      setManualMsg({ ok: false, text: "Format invalide. Attendu BC + 8 caractères (lettres/chiffres MAJ)." });
      return;
    }
    setManualBusy(true);
    try {
      let resp: { ok?: boolean; error?: string; code?: string; clientName?: string | null } = {};
      if (etape === "preparation") {
        if (forceClientId) {
          const a = await gasPost("assignFnuciToClient", { fnuci: fn, clientId: forceClientId }) as
            { ok?: boolean; error?: string; alreadySameClient?: boolean };
          if (a.error && !a.alreadySameClient) {
            setManualMsg({ ok: false, text: a.error });
            return;
          }
        }
        resp = await gasPost("markVeloPrepare", { fnuci: fn, tourneeId, userId: userId || "", bypassOrderLock: bypassOrderLock || undefined }) as typeof resp;
      } else if (etape === "chargement") {
        resp = await gasPost("markVeloCharge", { fnuci: fn, tourneeId, userId: userId || "", bypassOrderLock: bypassOrderLock || undefined }) as typeof resp;
      } else {
        resp = await gasPost("markVeloLivreScan", { fnuci: fn, tourneeId, userId: userId || "", bypassOrderLock: bypassOrderLock || undefined }) as typeof resp;
      }
      if (resp.error) {
        setManualMsg({ ok: false, text: resp.error });
        return;
      }
      setManualMsg({ ok: true, text: `✓ ${fn}${resp.clientName ? ` · ${resp.clientName}` : ""}` });
      setManualFnuci("");
      if (onAfter) onAfter();
    } catch (e) {
      setManualMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setManualBusy(false);
    }
  }, [manualFnuci, etape, forceClientId, tourneeId, userId, bypassOrderLock, onAfter]);

  const pendingCount = items.filter((i) => i.status === "pending").length;
  const processingCount = items.filter((i) => i.status === "processing").length;
  const doneCount = items.filter((i) => i.status === "done").length;
  const errorCount = items.filter((i) => i.status === "error").length;

  return (
    <div className="space-y-2">
      {mirrorErrors.length > 0 && (
        <div className="bg-red-50 border-2 border-red-400 rounded-lg p-3 space-y-2">
          <div className="text-sm font-semibold text-red-900">
            ⚠️ {mirrorErrors.length} scan{mirrorErrors.length > 1 ? "s" : ""} non sauvegardé{mirrorErrors.length > 1 ? "s" : ""} en base
          </div>
          <div className="text-xs text-red-800">
            La photo a été reconnue mais l&apos;écriture Firestore a échoué (réseau ?).
            Re-scanne ces FNUCI maintenant que tu as du réseau.
          </div>
          <ul className="text-xs font-mono text-red-900 bg-white border border-red-300 rounded p-2 max-h-32 overflow-auto">
            {mirrorErrors.map((e, i) => (
              <li key={i}>· {e.fnuci} — {e.error}</li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setMirrorErrors([])}
            className="text-[11px] text-red-700 underline"
          >
            J&apos;ai re-scanné, masquer
          </button>
        </div>
      )}

      {/* Saisie manuelle FNUCI (30-04 12h28) : fallback quand Gemini hallucine
          des chars ambigus 0/O, S/5, Z/2. L'opérateur tape les 10 caractères
          du BicyCode lisible et valide directement, sans repasser par Gemini. */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-2 space-y-1.5">
        <div className="text-[11px] text-blue-900">
          ✏️ Si Gemini hallucine, tape le FNUCI à la main :
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={manualFnuci}
            onChange={(e) => setManualFnuci(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === "Enter") void submitManual(); }}
            placeholder="BCXXXXXXXX"
            maxLength={10}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            disabled={manualBusy}
            className="flex-1 px-2 py-1.5 border border-blue-300 rounded bg-white text-sm font-mono uppercase tracking-wider focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          />
          <button
            type="button"
            onClick={() => void submitManual()}
            disabled={manualBusy || manualFnuci.length !== 10}
            className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm font-medium disabled:opacity-40"
          >
            {manualBusy ? "⏳" : "Valider"}
          </button>
        </div>
        {manualMsg && (
          <div className={`text-[11px] ${manualMsg.ok ? "text-emerald-700" : "text-red-700"}`}>
            {manualMsg.text}
          </div>
        )}
      </div>
      {lockedClient ? (
        <div className="bg-emerald-50 border border-emerald-300 rounded-lg p-2.5 flex items-center justify-between gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-emerald-700 font-semibold">
              🔒 Photos pour
            </div>
            <div className="text-sm font-bold text-emerald-900">{lockedClient.entreprise}</div>
            <div className="text-[11px] text-emerald-800">
              {lockedClient.done}/{lockedClient.total} déjà fait
              {lockedClient.total - lockedClient.done > 0
                ? ` · reste ${lockedClient.total - lockedClient.done}`
                : " · complet"}
            </div>
          </div>
          <a
            href={`${BASE_PATH}/livraisons`}
            className="text-[11px] text-emerald-700 underline whitespace-nowrap"
          >
            ← changer
          </a>
        </div>
      ) : clients && clients.length > 0 ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-2 space-y-1">
          <label className="text-[11px] font-semibold text-amber-900">
            Pour quel client ? (assignation auto des FNUCI extraits)
          </label>
          <select
            value={forceClientId}
            onChange={(e) => setForceClientId(e.target.value)}
            className="w-full border border-amber-300 rounded px-2 py-1.5 text-sm bg-white"
          >
            <option value="">— Aucun (mode standard, FNUCI doit déjà exister) —</option>
            {clients.map((c) => {
              const free = c.total - c.done;
              // Verrou LIFO : si nextEligibleClientId est défini, seul ce client
              // est sélectionnable. Les autres restent visibles pour le contexte
              // mais désactivés avec un suffixe explicite.
              const lockedByOrder = !!(nextEligibleClientId && c.clientId !== nextEligibleClientId && free > 0);
              const suffix = free <= 0
                ? " — plein"
                : lockedByOrder
                  ? " — ⛔ verrouillé (ordre)"
                  : ` — ${free} libre${free > 1 ? "s" : ""}`;
              return (
                <option key={c.clientId} value={c.clientId} disabled={free <= 0 || lockedByOrder}>
                  {c.entreprise} ({c.done}/{c.total}{suffix})
                </option>
              );
            })}
          </select>
        </div>
      ) : null}

      <button
        type="button"
        disabled={disabled || adding || identifying}
        onClick={openCamera}
        className="w-full px-3 py-3 bg-rose-600 text-white rounded-lg font-semibold hover:bg-rose-700 disabled:opacity-60 text-sm"
      >
        📸 Caméra continue
      </button>

      {adding && (
        <div className="text-center text-xs text-gray-600 italic">
          📥 Préparation des images…
        </div>
      )}

      {items.length > 0 && (
        <>
          <div className="flex items-center justify-between gap-2 bg-gray-50 border border-gray-200 rounded-lg p-2 text-xs">
            <div className="text-gray-700">
              <span className="font-semibold">{items.length}</span> photo{items.length > 1 ? "s" : ""}
              {pendingCount > 0 && <span className="text-blue-700"> · {pendingCount} en attente</span>}
              {processingCount > 0 && <span className="text-amber-700"> · {processingCount} en cours</span>}
              {doneCount > 0 && <span className="text-green-700"> · {doneCount} OK</span>}
              {errorCount > 0 && <span className="text-red-700"> · {errorCount} erreur{errorCount > 1 ? "s" : ""}</span>}
            </div>
            <button
              type="button"
              onClick={clearAll}
              disabled={identifying}
              className="text-gray-500 hover:text-gray-800 underline disabled:opacity-50"
            >
              effacer
            </button>
          </div>

          <button
            type="button"
            disabled={disabled || identifying || pendingCount === 0}
            onClick={identifyAll}
            className="w-full px-4 py-3 bg-emerald-600 text-white rounded-lg font-semibold hover:bg-emerald-700 disabled:opacity-50 text-sm"
          >
            {identifying
              ? `🤖 Identification ${doneCount + errorCount}/${items.length}…`
              : pendingCount > 0
                ? `🤖 Identifier les ${pendingCount} photo${pendingCount > 1 ? "s" : ""}`
                : "✅ Toutes les photos identifiées"}
          </button>

          <div className="grid grid-cols-2 gap-2 mt-1">
            {items.map((it) => (
              <BatchItemCard
                key={it.id}
                item={it}
                onRemove={() => removeItem(it.id)}
                onRetry={() => retryItem(it)}
                canRemove={!identifying && it.status !== "processing"}
                etape={etape}
                onUpdateFnuci={(fnuci) =>
                  setItems((prev) =>
                    prev.map((p) => (p.id === it.id ? { ...p, pendingFnuci: fnuci.toUpperCase() } : p)),
                  )
                }
                onValidate={() => validatePrepItem(it.id, it.pendingFnuci || "")}
              />
            ))}
          </div>
        </>
      )}

      <p className="text-[11px] text-gray-500 text-center">
        📸 La caméra reste ouverte, mitraille les stickers d&apos;affilée puis Terminer →
        identification automatique.
      </p>

      {cameraOpen && (
        <ContinuousCameraOverlay
          videoRef={videoRef}
          error={cameraError}
          shooting={shooting}
          captures={items}
          onShoot={captureFrame}
          onClose={closeCamera}
        />
      )}
    </div>
  );
}

function ContinuousCameraOverlay({
  videoRef,
  error,
  shooting,
  captures,
  onShoot,
  onClose,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  error: string | null;
  shooting: boolean;
  captures: BatchItem[];
  onShoot: () => void;
  onClose: () => void;
}) {
  const recent = captures.slice(-5);
  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 bg-black text-white">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 rounded bg-white/15 text-sm font-medium"
        >
          ✕ Terminer
        </button>
        <div className="text-sm font-medium">
          {captures.length} capturée{captures.length > 1 ? "s" : ""}
        </div>
      </div>

      <div className="relative flex-1 bg-black overflow-hidden">
        {error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-white p-4 text-center gap-3">
            <div className="text-5xl">📷❌</div>
            <div className="text-sm">Caméra inaccessible.</div>
            <div className="text-xs opacity-70 break-words max-w-xs">{error}</div>
            <div className="text-xs opacity-70 max-w-xs">
              Sur iOS : Réglages → Safari → Caméra → Autoriser pour ce site.
            </div>
          </div>
        ) : (
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className="absolute inset-0 w-full h-full object-cover"
          />
        )}
        {shooting && !error && (
          <div className="absolute inset-0 bg-white opacity-60 pointer-events-none animate-pulse" />
        )}
      </div>

      {recent.length > 0 && (
        <div className="bg-black/80 px-2 py-2">
          <div className="flex gap-1.5 overflow-x-auto">
            {recent.map((c) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={c.id}
                src={c.thumbDataUrl}
                alt=""
                className="w-14 h-14 object-cover rounded border border-white/20 flex-shrink-0"
              />
            ))}
          </div>
        </div>
      )}

      <div className="bg-black flex items-center justify-center py-6">
        <button
          type="button"
          onClick={onShoot}
          disabled={!!error || shooting}
          className="w-20 h-20 rounded-full bg-white border-4 border-white/40 active:scale-95 transition-transform disabled:opacity-50"
          aria-label="Capturer"
        >
          <div className="w-full h-full rounded-full bg-white" />
        </button>
      </div>
    </div>
  );
}

function BatchItemCard({
  item,
  onRemove,
  onRetry,
  canRemove,
  etape,
  onUpdateFnuci,
  onValidate,
}: {
  item: BatchItem;
  onRemove: () => void;
  onRetry: () => void;
  canRemove: boolean;
  etape: GeminiEtape;
  onUpdateFnuci: (fnuci: string) => void;
  onValidate: () => void;
}) {
  const failed = needsRetry(item);
  const isPrep = etape === "preparation";
  const isValidated = !!item.validatedFnuci;
  const needsValidation = isPrep && item.status === "done" && !isValidated;
  const borderClass = isValidated
    ? "border-emerald-400 bg-emerald-50"
    : item.mirrorError
      ? "border-red-400 bg-red-50"
      : needsValidation
        ? "border-blue-300 bg-blue-50"
        : item.status === "done" && !failed
          ? "border-green-300 bg-green-50"
          : item.status === "error" || failed
            ? "border-red-300 bg-red-50"
            : item.status === "processing"
              ? "border-amber-300 bg-amber-50"
              : "border-gray-300 bg-white";

  return (
    <div className={`relative border-2 rounded-lg overflow-hidden text-[11px] ${borderClass}`}>
      {item.thumbDataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.thumbDataUrl} alt={item.fileName} className="w-full h-24 object-cover" />
      ) : (
        <div className="w-full h-24 bg-gray-100 flex items-center justify-center text-gray-400">
          (pas de vignette)
        </div>
      )}
      {canRemove && !isValidated && (
        <button
          type="button"
          onClick={onRemove}
          className="absolute top-1 right-1 bg-black/60 text-white rounded-full w-5 h-5 flex items-center justify-center text-[10px] hover:bg-black/80"
          title="Retirer"
        >
          ×
        </button>
      )}
      <div className="px-2 py-1.5 space-y-1">
        {isValidated ? (
          <div className="text-emerald-800 font-medium text-[11px]">
            ✓ Validé : <span className="font-mono">{item.validatedFnuci}</span>
          </div>
        ) : needsValidation ? (
          <>
            <div className="text-[10px] text-blue-700 font-semibold uppercase tracking-wide">
              Vérifie chaque caractère
            </div>
            {/* Affichage caractère par caractère avec surlignage des chars
                ambigus (S/0/Z/8/1/6/G) en jaune. Aide l'œil de l'opérateur
                à se concentrer sur les chars où Gemini se trompe le plus.
                30-04 17h demande Yoann : 100% non-négociable à la prep. */}
            <FnuciCharGuide value={item.pendingFnuci || ""} />
            <input
              type="text"
              value={item.pendingFnuci || ""}
              onChange={(e) => onUpdateFnuci(e.target.value.toUpperCase())}
              maxLength={10}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              className="w-full px-1.5 py-1.5 border-2 border-blue-400 rounded bg-white text-sm font-mono uppercase tracking-widest focus:border-blue-600 focus:ring-2 focus:ring-blue-500"
              placeholder="BCXXXXXXXX"
            />
            <button
              type="button"
              onClick={onValidate}
              disabled={!item.pendingFnuci || item.pendingFnuci.length !== 10}
              className="w-full px-2 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white rounded text-[11px] font-bold"
            >
              ✓ Valider
            </button>
            {item.mirrorError && (
              <div className="text-[10px] text-red-700 break-words">⚠ {item.mirrorError}</div>
            )}
          </>
        ) : (
          <>
            <StatusBadge item={item} />
            <ResultDetail item={item} />
          </>
        )}
        {failed && item.status !== "processing" && !needsValidation && !isValidated && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-1 w-full px-2 py-1 bg-amber-500 hover:bg-amber-600 text-white rounded text-[11px] font-medium"
          >
            ↻ Réessayer
          </button>
        )}
      </div>
    </div>
  );
}

// Affiche les 10 caractères du FNUCI un par un, avec un fond jaune sur les
// caractères ambigus en OCR (S/0/Z/8/1/6/G/B/D/O/I/L/2/5). Le préparateur
// voit immédiatement où regarder pour vérifier que Gemini a bien lu.
function FnuciCharGuide({ value }: { value: string }) {
  if (!value) return null;
  const AMBIGU = new Set(["S", "0", "Z", "8", "1", "6", "G", "B", "D", "O", "I", "L", "2", "5"]);
  return (
    <div className="flex justify-center gap-0.5 my-1 select-none">
      {value.split("").map((c, i) => (
        <span
          key={i}
          className={`inline-flex items-center justify-center w-5 h-6 rounded font-mono text-[13px] font-bold border ${
            AMBIGU.has(c)
              ? "bg-amber-200 text-amber-900 border-amber-400"
              : "bg-gray-100 text-gray-800 border-gray-300"
          }`}
        >
          {c || "·"}
        </span>
      ))}
    </div>
  );
}

// Détecte si une carte est dans un état "à réessayer" : erreur réseau, ou
// résultat serveur partiel/total (FNUCI_INCONNU, capacité dépassée, 0 codes
// extraits…). N'inclut PAS pending/processing.
function needsRetry(item: BatchItem): boolean {
  if (item.status === "error") return true;
  if (item.status !== "done" || !item.resp) return false;
  if ("error" in item.resp) return true;
  if (item.resp.results.length === 0) return true;
  return item.resp.results.some((r) => {
    const x = r.result as { ok?: boolean } | null;
    return !x || x.ok !== true;
  });
}

function StatusBadge({ item }: { item: BatchItem }) {
  if (item.status === "pending") {
    return <div className="text-blue-700">⏳ En attente</div>;
  }
  if (item.status === "processing") {
    return <div className="text-amber-700 animate-pulse">🤖 Gemini analyse…</div>;
  }
  if (item.status === "error") {
    return <div className="text-red-700">❌ {item.errorMsg || "Erreur"}</div>;
  }
  // done
  const resp = item.resp;
  if (!resp || ("error" in resp && resp.error)) {
    return <div className="text-red-700">❌ {(resp && "error" in resp && resp.error) || "Réponse vide"}</div>;
  }
  if ("ok" in resp) {
    const okCount = resp.results.filter((r) => {
      const x = r.result as { ok?: boolean } | null;
      return x && x.ok === true;
    }).length;
    return (
      <div className="text-green-700 font-medium">
        ✓ {okCount}/{resp.results.length} marqué{okCount > 1 ? "s" : ""}
      </div>
    );
  }
  return null;
}

function ResultDetail({ item }: { item: BatchItem }) {
  if (item.status !== "done" || !item.resp || "error" in item.resp) return null;
  const resp = item.resp;
  if (!("ok" in resp)) return null;
  if (resp.results.length === 0) {
    return <div className="text-gray-500 italic">Aucun FNUCI valide.</div>;
  }
  return (
    <div className="space-y-0.5">
      {resp.results.map((r, i) => {
        const result = r.result as
          | { ok?: true; alreadyDone?: boolean; clientName?: string | null }
          | { error: string; code?: string }
          | null;
        const assigned = r.assigned as
          | { ok?: true; alreadyAssigned?: boolean }
          | { error: string; existingClientName?: string }
          | null
          | undefined;
        if (result && "ok" in result && result.ok) {
          return (
            <div key={i} className="font-mono text-[10px] text-green-800 truncate">
              {r.fnuci}
              {result.clientName ? ` · ${result.clientName}` : ""}
            </div>
          );
        }
        // Si l'assignation a planté, c'est l'info la plus utile à afficher
        // (FNUCI déjà chez X, slots saturés, etc.).
        let errMsg: string | null = null;
        if (assigned && "error" in assigned && assigned.error) {
          errMsg = assigned.error;
          if (assigned.existingClientName) {
            errMsg += ` (chez ${assigned.existingClientName})`;
          }
        } else if (result && "error" in result) {
          errMsg = result.code || result.error;
        }
        return (
          <div key={i} className="font-mono text-[10px] text-red-700 break-words">
            {r.fnuci} — {errMsg || "?"}
          </div>
        );
      })}
      {resp.invalid.length > 0 && (
        <div className="text-orange-700 text-[10px] italic">
          ⚠️ {resp.invalid.length} code{resp.invalid.length > 1 ? "s" : ""} ignoré{resp.invalid.length > 1 ? "s" : ""}
        </div>
      )}
    </div>
  );
}

// Capture la frame courante d'un <video> live (getUserMedia) en JPEG compressé.
// Synchrone (pas de FileReader/Image roundtrip) : utilisé par la Caméra continue.
function compressVideoFrame(
  video: HTMLVideoElement,
  maxSize: number,
  quality: number,
): { base64: string; mimeType: string } {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const longest = Math.max(vw, vh);
  const scale = longest > maxSize ? maxSize / longest : 1;
  const w = Math.round(vw * scale);
  const h = Math.round(vh * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d unavailable");
  ctx.drawImage(video, 0, 0, w, h);
  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  const comma = dataUrl.indexOf(",");
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return { base64, mimeType: "image/jpeg" };
}

function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// Resize l'image à maxSize px (côté le plus long) et ré-encode en JPEG quality.
// 800 / 0.7 → ~50-80 KB / image, suffisant pour Gemini Vision (le QR fait
// 200px à l'écran, 800 donne déjà du grain). Plus rapide à uploader que 1280/0.8.
async function compressImage(
  file: File,
  maxSize: number,
  quality: number,
): Promise<{ base64: string; mimeType: string }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("image load failed"));
    im.src = dataUrl;
  });

  const longest = Math.max(img.width, img.height);
  const scale = longest > maxSize ? maxSize / longest : 1;
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d unavailable");
  ctx.drawImage(img, 0, 0, w, h);
  const compressedDataUrl = canvas.toDataURL("image/jpeg", quality);
  const comma = compressedDataUrl.indexOf(",");
  const base64 = comma >= 0 ? compressedDataUrl.slice(comma + 1) : compressedDataUrl;
  return { base64, mimeType: "image/jpeg" };
}
