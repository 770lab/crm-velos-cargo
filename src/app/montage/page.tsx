"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { gasGet, gasPost, gasUpload } from "@/lib/gas";
import { useCurrentUser } from "@/lib/current-user";

// Workflow montage par vélo (3 photos preuves) :
//   1. 📦 Photo de l'étiquette du carton  → identifie quel vélo on monte
//   2. 🏷️ Photo du QR BicyCode sur le vélo → confirme le numéro d'immatriculation
//   3. 🔧 Photo du vélo monté              → preuve de réalisation
// Quand les 3 photos sont uploadées, le serveur GAS marque automatiquement
// dateMontage + monteParId — pas besoin d'un appel "valider" séparé.

type Velo = {
  veloId: string;
  fnuci: string | null;
  datePreparation: string | null;
  dateChargement: string | null;
  dateLivraisonScan: string | null;
  dateMontage: string | null;
  urlPhotoMontageEtiquette?: string | null;
  urlPhotoMontageQrVelo?: string | null;
  photoMontageUrl?: string | null;
};

type ClientPreparation = {
  ok: true;
  clientId: string;
  entreprise: string;
  velos: Velo[];
} | { error: string };

type IdentifyResp =
  | {
      ok: true;
      extracted: string[];
      invalid: string[];
      results: Array<{ fnuci: string; assigned: unknown; result: unknown }>;
      rawGeminiText?: string;
    }
  | { error: string };

type UploadResp =
  | {
      ok: true;
      veloId: string;
      fnuci: string;
      clientId: string;
      clientName: string | null;
      slot: "etiquette" | "qrvelo" | "monte";
      photoUrl: string;
      photos: { etiquette: boolean; qrvelo: boolean; monte: boolean };
      complete: boolean;
      dateMontage: string | null;
    }
  | { error: string };

type Slot = "etiquette" | "qrvelo" | "monte";

const SLOT_LABEL: Record<Slot, string> = {
  etiquette: "Étiquette du carton",
  qrvelo: "QR BicyCode sur le vélo",
  monte: "Vélo monté",
};
const SLOT_EMOJI: Record<Slot, string> = {
  etiquette: "📦",
  qrvelo: "🏷️",
  monte: "🔧",
};
const SLOT_HINT: Record<Slot, string> = {
  etiquette: "Photographie l'étiquette collée sur le carton — Gemini va identifier le vélo.",
  qrvelo: "Photographie le QR BicyCode collé sur le cadre — confirmation du numéro officiel.",
  monte: "Photographie le vélo une fois monté — preuve de réalisation.",
};

export default function MontagePageWrapper() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-gray-500">Chargement…</div>}>
      <MontagePage />
    </Suspense>
  );
}

function MontagePage() {
  const sp = useSearchParams();
  const tourneeId = sp.get("tourneeId") || "";
  const clientId = sp.get("clientId") || "";
  const currentUser = useCurrentUser();
  const monteurId = currentUser?.id || "";

  // Fallback minimaliste si on arrive sur /montage sans clientId.
  // Le workflow réel est forcément focus client (ouvert depuis le bouton
  // "Mont." de la fiche livraison).
  if (!tourneeId || !clientId) {
    return (
      <div className="min-h-screen bg-gray-50 p-6">
        <div className="max-w-md mx-auto bg-white rounded-xl shadow p-6 text-sm text-gray-600">
          <h1 className="text-xl font-bold mb-3">🔧 Montage</h1>
          <p>
            Le montage se lance depuis le bouton <strong>🔧 Mont.</strong> de la
            fiche client dans ton planning Livraisons.
          </p>
          <a
            href="/crm-velos-cargo/livraisons"
            className="mt-4 inline-block text-sm text-blue-600 underline"
          >
            ← Aller au planning
          </a>
        </div>
      </div>
    );
  }

  return (
    <ClientMontageView
      tourneeId={tourneeId}
      clientId={clientId}
      monteurId={monteurId}
    />
  );
}

function ClientMontageView({
  tourneeId,
  clientId,
  monteurId,
}: {
  tourneeId: string;
  clientId: string;
  monteurId: string;
}) {
  const [data, setData] = useState<ClientPreparation | null>(null);
  // currentFnuci = vélo dont on est en train de prendre les photos.
  // null → on est entre 2 vélos (afficher bouton "📸 Démarrer un nouveau vélo")
  const [currentFnuci, setCurrentFnuci] = useState<string | null>(null);
  const [currentSlot, setCurrentSlot] = useState<Slot>("etiquette");
  // Phase courante pour afficher au user où on en est ("Envoi…" générique
  // donnait l'impression que rien ne se passe quand l'appel Gemini durait 3s).
  const [phase, setPhase] = useState<"idle" | "compressing" | "identifying" | "uploading">("idle");
  const busy = phase !== "idle";
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const reload = useCallback(async () => {
    const r = (await gasGet("getClientPreparation", { clientId })) as ClientPreparation;
    setData(r);
  }, [clientId]);

  useEffect(() => {
    reload();
  }, [reload]);

  if (!data) {
    return <div className="p-6 text-sm text-gray-500">Chargement…</div>;
  }
  if ("error" in data) {
    return <div className="p-6 text-red-600">{data.error}</div>;
  }

  const velos = data.velos;
  const veloByFnuci = new Map<string, Velo>();
  for (const v of velos) {
    if (v.fnuci) veloByFnuci.set(v.fnuci, v);
  }

  // Calcule l'état d'avancement de chaque vélo (combien de photos sur 3).
  const veloStatus = (v: Velo): { done: number; complete: boolean } => {
    let done = 0;
    if (v.urlPhotoMontageEtiquette) done++;
    if (v.urlPhotoMontageQrVelo) done++;
    if (v.photoMontageUrl) done++;
    return { done, complete: !!v.dateMontage };
  };

  const totals = velos.reduce(
    (acc, v) => {
      const s = veloStatus(v);
      acc.total += 1;
      if (s.complete) acc.done += 1;
      return acc;
    },
    { total: 0, done: 0 },
  );

  // Compresse l'image avant de l'envoyer. Pour les slots etiquette/qrvelo,
  // on est limité par la lisibilité du FNUCI BicyCode imprimé : 720px/JPEG 0.6
  // suffit pour Gemini Vision (testé) et fait passer le poids de ~70 KB à ~30 KB,
  // soit -55% sur l'upload + l'inférence Gemini. Pour le slot "monte" (preuve
  // de réalisation), 600px/JPEG 0.55 — pas besoin de fine résolution, juste
  // attester qu'il y a un vélo monté à l'image.
  const compressImage = async (file: File, slot: Slot): Promise<{ base64: string; mimeType: string }> => {
    const targetW = slot === "monte" ? 600 : 720;
    const quality = slot === "monte" ? 0.55 : 0.6;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ""));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("image illisible"));
      im.src = dataUrl;
    });
    const ratio = img.width / img.height;
    const w = Math.min(targetW, img.width);
    const h = Math.round(w / ratio);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas indisponible");
    ctx.drawImage(img, 0, 0, w, h);
    const out = canvas.toDataURL("image/jpeg", quality);
    const comma = out.indexOf(",");
    return { base64: out.slice(comma + 1), mimeType: "image/jpeg" };
  };

  const onFileChosen = async (file: File) => {
    setErrMsg(null);
    setPhase("compressing");
    try {
      const compressed = await compressImage(file, currentSlot);

      // Slot etiquette : on identifie d'abord le FNUCI (Gemini), on vérifie
      // qu'il appartient à ce client et qu'il n'est pas déjà monté.
      // Slot qrvelo : on identifie aussi pour vérifier la cohérence avec
      // l'étiquette (sécurité erreur de manutention).
      // Slot monte : pas d'extraction, on utilise le FNUCI courant.
      let resolvedFnuci = currentFnuci;
      if (currentSlot === "etiquette" || currentSlot === "qrvelo") {
        setPhase("identifying");
        const ident = (await gasUpload("extractFnuciFromImage", {
          imageBase64: compressed.base64,
          mimeType: compressed.mimeType,
          etape: "identify",
        })) as IdentifyResp;
        if ("error" in ident) {
          setErrMsg(`Gemini : ${ident.error}`);
          return;
        }
        const candidates = ident.extracted;
        if (candidates.length === 0) {
          setErrMsg("Aucun FNUCI lisible sur la photo. Reprends une photo plus nette.");
          return;
        }
        // On prend le 1er FNUCI extrait qui appartient à ce client.
        const matched = candidates.find((f) => veloByFnuci.has(f));
        if (!matched) {
          setErrMsg(
            `FNUCI extraits (${candidates.join(", ")}) — aucun n'appartient à ce client. ` +
              `Vérifie que tu prends bien la photo d'un carton de ce client.`,
          );
          return;
        }
        if (currentSlot === "etiquette") {
          // Vérifier qu'il n'est pas déjà monté.
          const v = veloByFnuci.get(matched)!;
          if (v.dateMontage) {
            setErrMsg(`${matched} est déjà marqué monté. Choisis un autre vélo.`);
            return;
          }
          resolvedFnuci = matched;
        } else {
          // qrvelo : doit matcher l'étiquette
          if (!currentFnuci) {
            setErrMsg("Pas de vélo en cours. Reprends à l'étape 1 (étiquette).");
            return;
          }
          if (matched !== currentFnuci) {
            setErrMsg(
              `⚠️ Le QR sur le vélo (${matched}) ne correspond pas à l'étiquette du carton (${currentFnuci}). ` +
                `Vérifie que tu monte bien le bon vélo.`,
            );
            return;
          }
          resolvedFnuci = matched;
        }
      }

      if (!resolvedFnuci) {
        setErrMsg("FNUCI non résolu — état incohérent.");
        return;
      }

      // Upload de la photo dans le bon slot.
      setPhase("uploading");
      const up = (await gasUpload("uploadMontagePhoto", {
        fnuci: resolvedFnuci,
        slot: currentSlot,
        photoData: compressed.base64,
        mimeType: compressed.mimeType,
        monteurId: monteurId || undefined,
      })) as UploadResp;

      if ("error" in up) {
        setErrMsg(up.error);
        return;
      }

      // Avancement vers le slot suivant. Si complete=true (3 slots OK),
      // on reset le vélo en cours et on recharge la liste.
      if (up.complete) {
        setCurrentFnuci(null);
        setCurrentSlot("etiquette");
        await reload();
        return;
      }

      // Sinon, on passe au slot suivant.
      setCurrentFnuci(resolvedFnuci);
      if (currentSlot === "etiquette") setCurrentSlot("qrvelo");
      else if (currentSlot === "qrvelo") setCurrentSlot("monte");
      await reload();
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setPhase("idle");
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const cancelCurrentVelo = () => {
    if (!confirm("Annuler le vélo en cours ? Les photos déjà uploadées restent en base.")) return;
    setCurrentFnuci(null);
    setCurrentSlot("etiquette");
    setErrMsg(null);
  };

  return (
    <div className="min-h-screen bg-gray-50 p-3 md:p-6">
      <div className="max-w-md mx-auto">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-xl font-bold">🔧 Montage</h1>
          <a
            href="/crm-velos-cargo/livraisons"
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            ← Planning
          </a>
        </div>

        <div className="bg-white rounded-xl shadow p-3 mb-3">
          <div className="text-xs text-gray-500 mb-1">Client en montage</div>
          <div className="font-bold text-base">{data.entreprise}</div>
          <div className="mt-2 flex items-baseline justify-between">
            <div className="text-2xl font-bold">
              {totals.done}{" "}
              <span className="text-base text-gray-400 font-normal">/ {totals.total}</span>
            </div>
            {totals.done === totals.total && totals.total > 0 && (
              <div className="text-green-600 text-sm font-medium">✅ Terminé</div>
            )}
          </div>
          <div className="h-2 bg-gray-100 rounded overflow-hidden mt-1">
            <div
              className="h-full bg-emerald-500 transition-all"
              style={{ width: totals.total ? `${(totals.done / totals.total) * 100}%` : "0%" }}
            />
          </div>
        </div>

        {/* Liste des vélos du client avec leur état */}
        <div className="bg-white rounded-xl shadow p-3 mb-3">
          <div className="text-xs text-gray-500 mb-2">Vélos du client</div>
          <div className="space-y-1.5">
            {velos.length === 0 && (
              <div className="text-xs text-gray-400 italic">Aucun vélo affecté pour ce client.</div>
            )}
            {velos.map((v) => {
              const s = veloStatus(v);
              const isCurrent = v.fnuci === currentFnuci;
              return (
                <div
                  key={v.veloId}
                  className={`border rounded-lg p-2 flex items-center justify-between ${
                    s.complete
                      ? "bg-green-50 border-green-200"
                      : isCurrent
                        ? "bg-blue-50 border-blue-300"
                        : "bg-white border-gray-200"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-xs truncate">{v.fnuci || "(non scanné)"}</div>
                    <div className="text-[10px] text-gray-600">
                      {s.complete ? (
                        <span className="text-green-700">✅ Monté</span>
                      ) : (
                        <span>📷 {s.done}/3 photos{isCurrent ? " · en cours" : ""}</span>
                      )}
                    </div>
                  </div>
                  {/* Mini-vignettes des 3 slots */}
                  <div className="flex gap-1 shrink-0">
                    <span title="Étiquette" className={v.urlPhotoMontageEtiquette ? "" : "opacity-30"}>📦</span>
                    <span title="QR vélo" className={v.urlPhotoMontageQrVelo ? "" : "opacity-30"}>🏷️</span>
                    <span title="Monté" className={v.photoMontageUrl ? "" : "opacity-30"}>🔧</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Bloc photo : différent selon qu'on est entre 2 vélos ou en cours */}
        <div className="bg-white rounded-xl shadow p-4 space-y-3 mb-3">
          {currentFnuci ? (
            <>
              <div className="bg-blue-50 border border-blue-200 rounded p-2.5">
                <div className="text-[10px] uppercase tracking-wide text-blue-700 font-semibold">
                  🔄 Vélo en cours
                </div>
                <div className="font-mono text-sm font-bold text-blue-900">{currentFnuci}</div>
                <div className="text-[11px] text-blue-800 mt-1">
                  Étape {currentSlot === "etiquette" ? "1" : currentSlot === "qrvelo" ? "2" : "3"}/3
                  {" : "}
                  {SLOT_LABEL[currentSlot]}
                </div>
              </div>
            </>
          ) : (
            <div className="text-sm text-gray-700">
              📸 Démarre un nouveau vélo en photographiant l&apos;étiquette de son carton.
            </div>
          )}

          <div className="text-xs text-gray-500">
            {SLOT_EMOJI[currentSlot]} {SLOT_HINT[currentSlot]}
          </div>

          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFileChosen(f);
            }}
            className="hidden"
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy || (totals.done === totals.total && totals.total > 0)}
            className="w-full bg-blue-600 text-white rounded-lg py-3 font-medium disabled:opacity-50"
          >
            {phase === "compressing" && "📦 Compression…"}
            {phase === "identifying" && "🤖 Lecture du FNUCI par Gemini…"}
            {phase === "uploading" && "💾 Sauvegarde sur Drive…"}
            {phase === "idle" && `${SLOT_EMOJI[currentSlot]} Photo ${SLOT_LABEL[currentSlot].toLowerCase()}`}
          </button>

          {currentFnuci && (
            <button
              onClick={cancelCurrentVelo}
              disabled={busy}
              className="w-full text-xs text-gray-500 hover:text-gray-700 py-1"
            >
              Annuler ce vélo (les photos déjà uploadées restent en base)
            </button>
          )}

          {errMsg && (
            <div className="bg-red-50 border border-red-200 text-red-800 text-xs rounded p-2">
              {errMsg}
            </div>
          )}
        </div>

        {totals.done === totals.total && totals.total > 0 && (
          <div className="bg-emerald-50 border-2 border-emerald-500 rounded-xl p-4 text-center">
            <div className="text-3xl mb-1">🎉</div>
            <div className="text-emerald-900 font-bold">
              Les {totals.total} vélos de {data.entreprise} sont montés.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Helper non utilisé mais conservé pour compat éventuelle si on revient à un
// flow scan QR Strich + 1 photo (markVeloMonte legacy). Désactivé en TS pour
// rester silencieux à l'unused-vars.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function _legacyMarkVeloMonteOnePhoto(fnuci: string, photoData: string, monteurId: string) {
  return gasPost("markVeloMonte", { fnuci, photoData, mimeType: "image/jpeg", monteurId });
}
