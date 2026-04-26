"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { gasUpload } from "@/lib/gas";

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
      results: Array<{ fnuci: string; result: unknown }>;
      rawGeminiText?: string;
    }
  | { error: string; rawText?: string; body?: string };

type BatchItem = {
  id: string;
  fileName: string;
  thumbDataUrl: string;
  base64: string;
  mimeType: string;
  status: "pending" | "processing" | "done" | "error";
  resp?: ExtractResp;
  errorMsg?: string;
};

export type GeminiClientOption = {
  clientId: string;
  entreprise: string;
  total: number;
  prepare: number;
};

export default function PhotoGeminiCapture({
  tourneeId,
  userId,
  etape,
  onAfter,
  disabled,
  clients,
  lockedClientId,
  onCameraToggle,
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
  /** Notifie le parent quand la caméra continue s'ouvre/ferme. Permet de
   * désactiver le scanner Strich (qui tient la caméra) le temps que Gemini
   * Vision en prenne le contrôle — iOS Safari = 1 seule appli active. */
  onCameraToggle?: (open: boolean) => void;
}) {
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [items, setItems] = useState<BatchItem[]>([]);
  const [adding, setAdding] = useState(false);
  const [identifying, setIdentifying] = useState(false);
  const [forceClientId, setForceClientId] = useState<string>("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [shooting, setShooting] = useState(false);

  // Si lockedClientId fourni, on force forceClientId à cette valeur. L'effet
  // garantit que ça reste sync même si la URL change pendant la session.
  useEffect(() => {
    if (lockedClientId) setForceClientId(lockedClientId);
  }, [lockedClientId]);

  const lockedClient = lockedClientId
    ? clients?.find((c) => c.clientId === lockedClientId)
    : undefined;

  const addFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setAdding(true);
    const fileArr = Array.from(files);

    // Compression en parallèle pendant que l'utilisateur regarde déjà la grille
    // (les vignettes apparaissent dès qu'une compression est terminée). 800px
    // / JPEG 0.7 = ~50-80 KB par image, taille suffisante pour Gemini Vision et
    // ~3× plus rapide à uploader que 1280/0.8.
    await Promise.all(
      fileArr.map(async (file) => {
        try {
          const compressed = await compressImage(file, 800, 0.7);
          const item: BatchItem = {
            id: makeId(),
            fileName: file.name || "photo.jpg",
            thumbDataUrl: `data:${compressed.mimeType};base64,${compressed.base64}`,
            base64: compressed.base64,
            mimeType: compressed.mimeType,
            status: "pending",
          };
          setItems((prev) => [...prev, item]);
        } catch (e) {
          const item: BatchItem = {
            id: makeId(),
            fileName: file.name || "photo.jpg",
            thumbDataUrl: "",
            base64: "",
            mimeType: "image/jpeg",
            status: "error",
            errorMsg: e instanceof Error ? e.message : String(e),
          };
          setItems((prev) => [...prev, item]);
        }
      }),
    );

    setAdding(false);
    if (cameraRef.current) cameraRef.current.value = "";
  }, []);

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
      const compressed = compressVideoFrame(video, 800, 0.7);
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

    await Promise.all(
      pendingIds.map(async (id) => {
        const item = items.find((it) => it.id === id);
        if (!item) return;
        try {
          const resp = (await gasUpload("extractFnuciFromImage", {
            imageBase64: item.base64,
            mimeType: item.mimeType,
            tourneeId,
            userId,
            etape,
            forceClientId: forceClientId || undefined,
          })) as ExtractResp;
          setItems((prev) =>
            prev.map((it) => (it.id === id ? { ...it, status: "done", resp } : it)),
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
      }),
    );

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
  const retryItem = useCallback(async (item: BatchItem) => {
    if (!tourneeId || !item.base64) return;
    setItems((prev) =>
      prev.map((it) =>
        it.id === item.id ? { ...it, status: "processing", resp: undefined, errorMsg: undefined } : it,
      ),
    );
    try {
      const resp = (await gasUpload("extractFnuciFromImage", {
        imageBase64: item.base64,
        mimeType: item.mimeType,
        tourneeId,
        userId,
        etape,
        forceClientId: forceClientId || undefined,
      })) as ExtractResp;
      setItems((prev) =>
        prev.map((it) => (it.id === item.id ? { ...it, status: "done", resp } : it)),
      );
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

  const pendingCount = items.filter((i) => i.status === "pending").length;
  const processingCount = items.filter((i) => i.status === "processing").length;
  const doneCount = items.filter((i) => i.status === "done").length;
  const errorCount = items.filter((i) => i.status === "error").length;

  return (
    <div className="space-y-2">
      {lockedClient ? (
        <div className="bg-emerald-50 border border-emerald-300 rounded-lg p-2.5 flex items-center justify-between gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-emerald-700 font-semibold">
              🔒 Photos pour
            </div>
            <div className="text-sm font-bold text-emerald-900">{lockedClient.entreprise}</div>
            <div className="text-[11px] text-emerald-800">
              {lockedClient.prepare}/{lockedClient.total} déjà fait
              {lockedClient.total - lockedClient.prepare > 0
                ? ` · reste ${lockedClient.total - lockedClient.prepare}`
                : " · complet"}
            </div>
          </div>
          <a
            href="/crm-velos-cargo/livraisons"
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
              const free = c.total - c.prepare;
              return (
                <option key={c.clientId} value={c.clientId} disabled={free <= 0}>
                  {c.entreprise} ({c.prepare}/{c.total}{free <= 0 ? " — plein" : ` — ${free} libre${free > 1 ? "s" : ""}`})
                </option>
              );
            })}
          </select>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={disabled || adding || identifying}
          onClick={openCamera}
          className="px-3 py-3 bg-rose-600 text-white rounded-lg font-semibold hover:bg-rose-700 disabled:opacity-60 text-sm"
        >
          📸 Caméra continue
        </button>
        <button
          type="button"
          disabled={disabled || adding || identifying}
          onClick={() => cameraRef.current?.click()}
          className="px-3 py-3 bg-amber-600 text-white rounded-lg font-medium hover:bg-amber-700 disabled:opacity-60 text-sm"
        >
          📷 Photo unique
        </button>
      </div>

      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => addFiles(e.target.files)}
      />

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
              />
            ))}
          </div>
        </>
      )}

      <p className="text-[11px] text-gray-500 text-center">
        📸 Caméra continue : reste ouverte, mitraille les stickers d&apos;affilée puis Terminer →
        identification automatique. 📷 Photo unique : caméra iOS native (1 shot).
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
}: {
  item: BatchItem;
  onRemove: () => void;
  onRetry: () => void;
  canRemove: boolean;
}) {
  const failed = needsRetry(item);
  const borderClass =
    item.status === "done" && !failed
      ? "border-green-300 bg-green-50"
      : item.status === "error" || failed
        ? "border-red-300 bg-red-50"
        : item.status === "processing"
          ? "border-amber-300 bg-amber-50"
          : "border-gray-300 bg-white";

  return (
    <div className={`relative border rounded-lg overflow-hidden text-[11px] ${borderClass}`}>
      {item.thumbDataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.thumbDataUrl} alt={item.fileName} className="w-full h-24 object-cover" />
      ) : (
        <div className="w-full h-24 bg-gray-100 flex items-center justify-center text-gray-400">
          (pas de vignette)
        </div>
      )}
      {canRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="absolute top-1 right-1 bg-black/60 text-white rounded-full w-5 h-5 flex items-center justify-center text-[10px] hover:bg-black/80"
          title="Retirer"
        >
          ×
        </button>
      )}
      <div className="px-2 py-1.5 space-y-0.5">
        <StatusBadge item={item} />
        <ResultDetail item={item} />
        {failed && item.status !== "processing" && (
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
        if (result && "ok" in result && result.ok) {
          return (
            <div key={i} className="font-mono text-[10px] text-green-800 truncate">
              {r.fnuci}
              {result.clientName ? ` · ${result.clientName}` : ""}
            </div>
          );
        }
        return (
          <div key={i} className="font-mono text-[10px] text-red-700 truncate">
            {r.fnuci} — {(result && "error" in result && (result.code || result.error)) || "?"}
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
