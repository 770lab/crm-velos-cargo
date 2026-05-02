"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { gasGet, gasPost, gasUpload } from "@/lib/gas";
import { useCurrentUser } from "@/lib/current-user";

import { BASE_PATH } from "@/lib/base-path";
// Workflow montage par vélo (3 étapes — refondu 29-04 11h45) :
//   1. 📦 Scan QR du carton          → vérifie que le carton est bien du client courant
//   2. 🏷️ Photo BicyCode du vélo     → Gemini Vision extrait le FNUCI, on vérifie qu'il
//                                       appartient au client et qu'il n'est pas déjà monté
//   3. 🔧 Photo du vélo monté        → preuve de réalisation, pose dateMontage en base
// CEE : c'est le logiciel pollueur qui gère la traçabilité officielle, ces 3 étapes
// servent au double-contrôle interne (pas de mauvaise paire carton/vélo).
const QrCartonScanner = dynamic(() => import("@/components/qr-carton-scanner"), { ssr: false });

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
  /** Workflow parallèle 29-04 13h50 : monteur qui a "claim" ce vélo pour montage.
   * Expiration 30 min côté serveur. Affiché dans la liste pour visibilité. */
  montageClaimBy?: string | null;
  montageClaimAt?: string | null;
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

type MarkMonteResp =
  | {
      ok: true;
      alreadyDone: boolean;
      fnuci: string;
      veloId: string;
      clientId: string;
      clientName: string | null;
      photoUrl: string;
      dateMontage: string | null;
    }
  | { error: string; code?: string };

type ClaimResp =
  | { ok: true; veloId: string; fnuci: string | null; clientId: string; clientName: string | null; monteurId: string }
  | { ok?: false; error: string; code?: string; claimedBy?: string };

type TransferResp =
  | { ok: true; veloId: string; fnuci: string; clientId: string | null }
  | { ok?: false; error: string; code?: string; claimedBy?: string };

type Step = "scanCarton" | "scanFnuci" | "photoMonte";

// Fuzzy match FNUCI sur chars confusables Gemini OCR (30-04 13h18) :
// quand le sticker imprimé OU Gemini lit "BCCEZHBBE6" mais en base c'est
// "BCCEZHBBES" (S confondu avec 6), on essaie les substitutions usuelles
// et on accepte si UN SEUL match en base (sinon ambigu -> on n'invente pas).
const CONFUSABLE_SUBS: Array<[string, string[]]> = [
  ["6", ["S", "G", "8"]],
  ["5", ["S"]],
  ["S", ["5", "6", "8"]],
  ["0", ["O", "D"]],
  ["O", ["0"]],
  ["Z", ["2"]],
  ["2", ["Z"]],
  ["8", ["B", "6"]],
  ["B", ["8"]],
  ["1", ["I", "L"]],
  ["I", ["1"]],
  ["L", ["1"]],
  ["G", ["6"]],
  ["D", ["0"]],
];

function fuzzyMatchFnuci(extracted: string, knownFnucis: Set<string>): { matched: string | null; ambiguous: boolean } {
  if (knownFnucis.has(extracted)) return { matched: extracted, ambiguous: false };
  const candidates = new Set<string>();
  for (let i = 0; i < extracted.length; i++) {
    const c = extracted[i];
    for (const [from, tos] of CONFUSABLE_SUBS) {
      if (c !== from) continue;
      for (const to of tos) {
        const cand = extracted.slice(0, i) + to + extracted.slice(i + 1);
        if (knownFnucis.has(cand)) candidates.add(cand);
      }
    }
  }
  if (candidates.size === 1) return { matched: [...candidates][0], ambiguous: false };
  if (candidates.size > 1) return { matched: null, ambiguous: true };
  return { matched: null, ambiguous: false };
}

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
            href={`${BASE_PATH}/livraisons`}
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
  // Progression de la tournée entière — sert à calculer "client suivant à
  // monter" quand le client courant est 3/3 terminé.
  const [tourneeProg, setTourneeProg] = useState<{
    clients: Array<{
      clientId: string;
      entreprise: string;
      totals: { total: number; monte: number };
    }>;
  } | null>(null);
  // Workflow 3-steps : scanCarton → scanFnuci → photoMonte → reset.
  // currentFnuci = FNUCI du vélo après le step 2, sert au step 3.
  // currentVeloId = id Firestore du vélo claim, utilisé pour transfer/release.
  const [step, setStep] = useState<Step>("scanCarton");
  const [currentFnuci, setCurrentFnuci] = useState<string | null>(null);
  const [currentVeloId, setCurrentVeloId] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "compressing" | "identifying" | "uploading" | "claiming" | "transferring" | "releasing">("idle");
  const busy = phase !== "idle";
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [qrScannerOpen, setQrScannerOpen] = useState(false);
  const [qrFeedback, setQrFeedback] = useState<Array<{ label: string; ok: boolean; at: number }>>([]);
  // Saisie manuelle FNUCI quand Gemini hallucine (30-04 11h, demande Yoann).
  const [manualFnuci, setManualFnuci] = useState("");

  const reload = useCallback(async () => {
    const r = (await gasGet("getClientPreparation", { clientId })) as ClientPreparation;
    setData(r);
    // Recharge aussi la progression tournée pour MAJ "client suivant" en
    // temps réel (au cas où un autre monteur a avancé pendant qu'on bossait).
    const tp = (await gasGet("getTourneeProgression", { tourneeId })) as {
      clients?: Array<{ clientId: string; entreprise: string; totals: { total: number; monte: number } }>;
    };
    if (tp && Array.isArray(tp.clients)) {
      setTourneeProg({ clients: tp.clients });
    }
  }, [clientId, tourneeId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Restauration de l'état au retour sur la page (29-04 14h02) : si le
  // monteur sort de la page (autre app, écran verrouillé, iOS purge l'onglet
  // après 6-10 min de montage), il revient pile où il en était. Sources :
  //   - claim serveur (montageClaimBy/At) : authoritative pour fnuci+veloId
  //   - localStorage : step exact (scanFnuci vs photoMonte, le serveur ne
  //     sait pas si la photo BicyCode a déjà été prise)
  // Reset du flag quand clientId/tourneeId/monteurId change → rebascule
  // sur le bon contexte si on navigue entre clients.
  const restoredRef = useRef(false);
  useEffect(() => {
    restoredRef.current = false;
  }, [clientId, tourneeId, monteurId]);

  const stepStorageKey = `montage-step:${tourneeId}:${clientId}:${monteurId || "anon"}`;

  useEffect(() => {
    if (restoredRef.current) return;
    if (!data || "error" in data) return;
    if (!monteurId) return;
    restoredRef.current = true;

    // Cherche un vélo claim par moi, non monté, claim < 30 min
    const CLAIM_FRESH_MS = 30 * 60 * 1000;
    const nowMs = Date.now();
    const myClaim = data.velos.find((v) => {
      if (v.dateMontage) return false;
      if (v.montageClaimBy !== monteurId) return false;
      if (!v.montageClaimAt) return true; // pas de timestamp = claim juste posé
      const claimMs = new Date(v.montageClaimAt).getTime();
      return claimMs > 0 && nowMs - claimMs < CLAIM_FRESH_MS;
    });

    if (myClaim) {
      setCurrentFnuci(myClaim.fnuci);
      setCurrentVeloId(myClaim.veloId);
      // Restaure le step exact (scanFnuci ou photoMonte) depuis localStorage.
      // Par défaut scanFnuci (le claim a été posé au step 1, on est à minima au step 2).
      let restoredStep: Step = "scanFnuci";
      try {
        const persisted = typeof window !== "undefined"
          ? localStorage.getItem(stepStorageKey)
          : null;
        if (persisted === "photoMonte" || persisted === "scanFnuci") {
          restoredStep = persisted;
        }
      } catch {}
      setStep(restoredStep);
    } else {
      // Pas de claim → état initial. Cleanup localStorage si présent.
      try {
        if (typeof window !== "undefined") localStorage.removeItem(stepStorageKey);
      } catch {}
    }
  }, [data, monteurId, stepStorageKey]);

  // Persiste le step courant en localStorage (sauf step initial scanCarton qui
  // signifie "pas de vélo en cours" → on supprime). Permet la restauration au
  // retour sur la page après une coupure (verrouillage écran iOS, autre app…).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!monteurId) return;
    try {
      if (step === "scanCarton") {
        localStorage.removeItem(stepStorageKey);
      } else {
        localStorage.setItem(stepStorageKey, step);
      }
    } catch {}
  }, [step, monteurId, stepStorageKey]);

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

  // Workflow refondu : un vélo est monté ssi dateMontage est posée.
  // Les anciens flags urlPhotoMontageEtiquette / urlPhotoMontageQrVelo sont
  // ignorés (legacy compat — on n'écrit plus dedans avec markVeloMontePhoto).
  const veloStatus = (v: Velo): { complete: boolean } => ({ complete: !!v.dateMontage });

  const totals = velos.reduce(
    (acc, v) => {
      acc.total += 1;
      if (v.dateMontage) acc.done += 1;
      return acc;
    },
    { total: 0, done: 0 },
  );

  // Compresse l'image avant envoi. Pour le scan FNUCI Gemini, 720px/JPEG 0.6
  // suffit (testé). Pour la photo de preuve montage, 600/0.55 — pas besoin
  // de fine résolution, juste attester qu'il y a un vélo monté.
  const compressImage = async (file: File, kind: "fnuci" | "monte"): Promise<{ base64: string; mimeType: string }> => {
    // 1024px pour FNUCI (au lieu de 720) : Gemini a besoin de plus de pixels
    // sur les chars pour distinguer S/6, 0/D, etc. (30-04 13h35 demande Yoann
    // d'améliorer la détection caméra). +2x cout réseau mais qualité bien meilleure.
    const targetW = kind === "monte" ? 600 : 1024;
    const quality = kind === "monte" ? 0.55 : 0.6;
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

  // Step 1 : QR carton scanné → claim un vélo en base (workflow parallèle
  // 29-04 13h50). Si QR encode un cartonToken (CT-XXX) on cible le slot précis,
  // sinon (legacy QR=clientId) on prend le 1er vélo dispo non-claim.
  const handleQrCartonScanned = async (scanned: string) => {
    const isCartonToken = /^CT-[A-Z0-9]{6,}$/.test(scanned);
    if (!isCartonToken && scanned !== clientId) {
      setQrFeedback((prev) => [
        ...prev,
        { label: "QR pour un autre client — refusé", ok: false, at: Date.now() },
      ]);
      return;
    }
    if (!monteurId) {
      setQrFeedback((prev) => [
        ...prev,
        { label: "Connecte-toi pour identifier le monteur", ok: false, at: Date.now() },
      ]);
      return;
    }
    setPhase("claiming");
    try {
      const r = (await gasPost("claimVeloForMontage", {
        clientId,
        monteurId,
        cartonToken: isCartonToken ? scanned : undefined,
      })) as ClaimResp;
      if (!("ok" in r) || !r.ok) {
        const msg = ("error" in r ? r.error : "Erreur claim") || "Erreur claim";
        setQrFeedback((prev) => [
          ...prev,
          { label: `⛔ ${msg}`, ok: false, at: Date.now() },
        ]);
        return;
      }
      setCurrentFnuci(r.fnuci);
      setCurrentVeloId(r.veloId);
      setQrFeedback((prev) => [
        ...prev,
        { label: `✓ Carton OK · ${r.fnuci || "(sans FNUCI)"} affilié`, ok: true, at: Date.now() },
      ]);
      setQrScannerOpen(false);
      setStep("scanFnuci");
      setErrMsg(null);
      await reload();
    } catch (e) {
      setQrFeedback((prev) => [
        ...prev,
        { label: e instanceof Error ? e.message : String(e), ok: false, at: Date.now() },
      ]);
    } finally {
      setPhase("idle");
    }
  };

  // Saisie manuelle du FNUCI (30-04 11h, urgence Yoann en montage). Quand
  // Gemini hallucine un caractere (ex BC3FFPVDZH lu au lieu de BCSFFPVDZH)
  // l'opérateur tape directement le code visible sur le sticker BicyCode.
  // Mêmes garde-fous qu'en path Gemini : format strict, doit ∈ client, pas
  // déjà monté. Comportement selon le step :
  // - step "scanCarton" : claim le vélo (photo BicyCode du sticker carton),
  //   passe à step "scanFnuci"
  // - step "scanFnuci" : transfert claim si différent + passe à "photoMonte"
  const validateManualFnuci = async () => {
    setErrMsg(null);
    const fn = manualFnuci.trim().toUpperCase();
    if (!/^BC[A-Z0-9]{8}$/.test(fn)) {
      setErrMsg("Format invalide. Attendu BC + 8 caractères (lettres MAJ + chiffres).");
      return;
    }
    if (!veloByFnuci.has(fn)) {
      setErrMsg(`${fn} ne correspond à aucun vélo de ${data.entreprise}.`);
      return;
    }
    const v = veloByFnuci.get(fn)!;
    if (v.dateMontage) {
      setErrMsg(`${fn} est déjà marqué monté.`);
      return;
    }
    if (!monteurId) {
      setErrMsg("Pas de monteurId, reconnecte-toi.");
      return;
    }

    // Step 1 : claim initial via FNUCI direct
    if (step === "scanCarton") {
      setPhase("claiming");
      try {
        const r = (await gasPost("claimVeloForMontage", {
          clientId,
          monteurId,
          fnuci: fn,
        })) as ClaimResp;
        if (!("ok" in r) || !r.ok) {
          setErrMsg(("error" in r ? r.error : "Claim refusé") || "Claim refusé");
          return;
        }
        setCurrentFnuci(r.fnuci || fn);
        setCurrentVeloId(r.veloId);
        setManualFnuci("");
        setStep("scanFnuci");
        await reload();
      } catch (e) {
        setErrMsg(e instanceof Error ? e.message : String(e));
      } finally {
        setPhase("idle");
      }
      return;
    }

    // Step 2 : transfert claim si nécessaire + passage à photoMonte
    if (currentFnuci && fn !== currentFnuci) {
      setPhase("transferring");
      try {
        const t = (await gasPost("transferMontageClaim", {
          fromVeloId: currentVeloId,
          toFnuci: fn,
          monteurId,
        })) as TransferResp;
        if (!("ok" in t) || !t.ok) {
          setErrMsg(("error" in t ? t.error : "Transfert claim refusé") || "Transfert claim refusé");
          return;
        }
        setCurrentVeloId(t.veloId);
        await reload();
      } catch (e) {
        setErrMsg(e instanceof Error ? e.message : String(e));
        return;
      } finally {
        setPhase("idle");
      }
    }
    setCurrentFnuci(fn);
    setManualFnuci("");
    setStep("photoMonte");
  };

  // Step 1 photo : photo du sticker FNUCI collé sur le carton (avant ouverture)
  // → Gemini extrait → claim ce vélo → step 2.
  const onCartonFnuciPhotoChosen = async (file: File) => {
    setErrMsg(null);
    setPhase("compressing");
    try {
      const compressed = await compressImage(file, "fnuci");
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
        setErrMsg("Aucun FNUCI lisible. Reprends une photo plus nette du sticker FNUCI sur le carton.");
        return;
      }
      // 1. Match exact en priorité
      const knownSet = new Set(veloByFnuci.keys());
      let matched = candidates.find((f) => knownSet.has(f)) || null;
      let fuzzyHint: string | null = null;
      // 2. Fallback fuzzy : si Gemini a halluciné UN char (S↔6, 0↔O...) et
      // qu'un seul vélo en base correspond après substitution, on l'accepte.
      if (!matched) {
        for (const c of candidates) {
          const fz = fuzzyMatchFnuci(c, knownSet);
          if (fz.matched) {
            matched = fz.matched;
            fuzzyHint = `Auto-corrigé : Gemini a lu ${c} → en base ${fz.matched}`;
            break;
          }
        }
      }
      if (!matched) {
        setErrMsg(
          `FNUCI extraits (${candidates.join(", ")}) — aucun n'appartient à ${data.entreprise}. ` +
            `Vérifie ou tape manuellement.`,
        );
        return;
      }
      const v = veloByFnuci.get(matched)!;
      if (v.dateMontage) {
        setErrMsg(`${matched} est déjà monté. Choisis un autre carton.`);
        return;
      }
      if (!monteurId) {
        setErrMsg("Pas de monteurId, reconnecte-toi.");
        return;
      }
      if (fuzzyHint) {
        // Affiche le hint en transitoire (sera remplacé par succès au reload).
        setErrMsg(`ℹ ${fuzzyHint}`);
      }
      setPhase("claiming");
      const r = (await gasPost("claimVeloForMontage", {
        clientId,
        monteurId,
        fnuci: matched,
      })) as ClaimResp;
      if (!("ok" in r) || !r.ok) {
        setErrMsg(("error" in r ? r.error : "Claim refusé") || "Claim refusé");
        return;
      }
      setCurrentFnuci(r.fnuci || matched);
      setCurrentVeloId(r.veloId);
      setStep("scanFnuci");
      await reload();
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setPhase("idle");
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  // Step 2 : photo BicyCode → Gemini extrait FNUCI → vérifie ∈ vélos client + pas monté.
  // Si le FNUCI extrait ≠ celui claim au step 1 (cas legacy QR=clientId), on
  // transfère le claim sur le bon vélo (workflow parallèle 29-04 13h50).
  const onFnuciPhotoChosen = async (file: File) => {
    setErrMsg(null);
    setPhase("compressing");
    try {
      const compressed = await compressImage(file, "fnuci");
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
        setErrMsg("Aucun FNUCI lisible. Reprends une photo plus nette du sticker BicyCode.");
        return;
      }
      // Match exact + fallback fuzzy chars confusables (S↔6, 0↔O...)
      const knownSet = new Set(veloByFnuci.keys());
      let matched = candidates.find((f) => knownSet.has(f)) || null;
      if (!matched) {
        for (const c of candidates) {
          const fz = fuzzyMatchFnuci(c, knownSet);
          if (fz.matched) {
            matched = fz.matched;
            setErrMsg(`ℹ Auto-corrigé : Gemini a lu ${c} → en base ${fz.matched}`);
            break;
          }
        }
      }
      if (!matched) {
        setErrMsg(
          `FNUCI extraits (${candidates.join(", ")}) — aucun n'appartient à ce client. ` +
            `Vérifie que tu scannes bien un vélo de ${data.entreprise}.`,
        );
        return;
      }
      const v = veloByFnuci.get(matched)!;
      if (v.dateMontage) {
        setErrMsg(`${matched} est déjà marqué monté. Choisis un autre vélo.`);
        return;
      }

      // Si match différent du vélo claim au step 1 → transfère le claim
      if (currentFnuci && matched !== currentFnuci && monteurId) {
        setPhase("transferring");
        const t = (await gasPost("transferMontageClaim", {
          fromVeloId: currentVeloId,
          toFnuci: matched,
          monteurId,
        })) as TransferResp;
        if (!("ok" in t) || !t.ok) {
          const msg = ("error" in t ? t.error : "Transfert claim refusé") || "Transfert claim refusé";
          setErrMsg(`⛔ ${msg}`);
          return;
        }
        setCurrentVeloId(t.veloId);
        await reload();
      }

      setCurrentFnuci(matched);
      setStep("photoMonte");
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setPhase("idle");
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  // Step 3 : photo vélo monté → markVeloMontePhoto pose dateMontage en 1 coup.
  const onMontePhotoChosen = async (file: File) => {
    if (!currentFnuci) {
      setErrMsg("Pas de FNUCI en cours — reprends à l'étape 1.");
      return;
    }
    setErrMsg(null);
    setPhase("compressing");
    try {
      const compressed = await compressImage(file, "monte");
      setPhase("uploading");
      const up = (await gasUpload("markVeloMontePhoto", {
        fnuci: currentFnuci,
        clientId,
        photoData: compressed.base64,
        mimeType: compressed.mimeType,
        monteurId: monteurId || undefined,
      })) as MarkMonteResp;
      if ("error" in up) {
        setErrMsg(up.error);
        return;
      }
      // Reset au step 1 pour enchaîner sur le vélo suivant.
      // (markVeloMontePhoto a déjà libéré le claim côté serveur en posant dateMontage)
      setCurrentFnuci(null);
      setCurrentVeloId(null);
      setStep("scanCarton");
      await reload();
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setPhase("idle");
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const cancelCurrentVelo = async () => {
    if (!confirm("Annuler le vélo en cours ?")) return;
    // Libère le claim en base pour qu'un autre monteur puisse prendre ce vélo
    if (currentVeloId && monteurId) {
      try {
        setPhase("releasing");
        await gasPost("releaseVeloMontageClaim", {
          veloId: currentVeloId,
          monteurId,
        });
      } catch {
        // Si release échoue, le claim expirera tout seul après 30 min.
      } finally {
        setPhase("idle");
      }
    }
    setCurrentFnuci(null);
    setCurrentVeloId(null);
    setStep("scanCarton");
    setErrMsg(null);
    await reload();
  };

  return (
    <div className="min-h-screen bg-gray-50 p-3 md:p-6">
      <div className="max-w-md mx-auto">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-xl font-bold">🔧 Montage</h1>
          <a
            href={`${BASE_PATH}/livraisons`}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            ← Planning
          </a>
        </div>

        <div className="bg-white rounded-xl shadow p-3 mb-3">
          <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Client en montage</div>
          <div className="font-bold text-xl sm:text-lg leading-tight break-words">{data.entreprise}</div>
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
              // Workflow parallèle : claim actif si un monteur ≠ moi a posé un
              // claim < 30 min. Affiché en orange "En cours par autre monteur".
              const claimByOther = !!(v.montageClaimBy && v.montageClaimBy !== monteurId);
              const claimAtMs = v.montageClaimAt ? new Date(v.montageClaimAt).getTime() : 0;
              const claimActive = claimByOther && claimAtMs > 0 && (Date.now() - claimAtMs < 30 * 60 * 1000);
              return (
                <div
                  key={v.veloId}
                  className={`border rounded-lg p-2 flex items-center justify-between ${
                    s.complete
                      ? "bg-green-50 border-green-200"
                      : isCurrent
                        ? "bg-blue-50 border-blue-300"
                        : claimActive
                          ? "bg-orange-50 border-orange-300"
                          : "bg-white border-gray-200"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-xs truncate">{v.fnuci || "(non scanné)"}</div>
                    <div className="text-[10px] text-gray-600">
                      {s.complete ? (
                        <span className="text-green-700">✅ Monté</span>
                      ) : isCurrent ? (
                        <span className="text-blue-700">🔄 En cours (toi)</span>
                      ) : claimActive ? (
                        <span className="text-orange-700">🔒 En cours par autre monteur</span>
                      ) : (
                        <span>⏳ À monter</span>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 text-base">
                    {s.complete ? "🔧" : isCurrent ? "🔄" : claimActive ? "🔒" : "⏳"}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Bloc workflow : 3 steps successifs (carton → FNUCI → photo monté).
            Caché quand le client est terminé. */}
        {!(totals.done === totals.total && totals.total > 0) && (
        <div className="bg-white rounded-xl shadow p-4 space-y-3 mb-3">
          {/* Indicateur de progression dans le workflow */}
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide font-semibold">
            <div className={`flex-1 text-center py-1.5 rounded ${step === "scanCarton" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-500"}`}>
              1 · 📦 Carton
            </div>
            <div className={`flex-1 text-center py-1.5 rounded ${step === "scanFnuci" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-500"}`}>
              2 · 🏷️ Vélo
            </div>
            <div className={`flex-1 text-center py-1.5 rounded ${step === "photoMonte" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-500"}`}>
              3 · 🔧 Monté
            </div>
          </div>

          {currentFnuci && (
            <div className="bg-blue-50 border border-blue-200 rounded p-2.5">
              <div className="text-[10px] uppercase tracking-wide text-blue-700 font-semibold">
                🔄 Vélo en cours
              </div>
              <div className="font-mono text-sm font-bold text-blue-900">{currentFnuci}</div>
            </div>
          )}

          {step === "scanCarton" && (
            <>
              <div className="text-xs text-gray-500">
                📦 Photographie le sticker FNUCI collé sur le carton — Gemini lit le code et claim ce vélo pour toi.
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                capture="environment"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onCartonFnuciPhotoChosen(f);
                }}
                className="hidden"
              />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={busy}
                className="w-full bg-emerald-600 text-white rounded-lg py-3 font-medium disabled:opacity-50"
              >
                {phase === "compressing" && "📦 Compression…"}
                {phase === "identifying" && "🤖 Lecture FNUCI…"}
                {phase === "claiming" && "🔒 Claim en cours…"}
                {phase === "idle" && "📦 Photo FNUCI sur le carton"}
              </button>
              {/* Saisie manuelle FNUCI carton (fallback Gemini hallucine) */}
              <div className="border-t border-gray-200 pt-3 mt-2">
                <div className="text-[11px] text-gray-500 mb-1.5">
                  Ou tape le FNUCI du carton à la main :
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={manualFnuci}
                    onChange={(e) => setManualFnuci(e.target.value.toUpperCase())}
                    placeholder="BCXXXXXXXX"
                    maxLength={10}
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    disabled={busy}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono tracking-wider uppercase"
                  />
                  <button
                    type="button"
                    onClick={validateManualFnuci}
                    disabled={busy || manualFnuci.length !== 10}
                    className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-40"
                  >
                    Valider
                  </button>
                </div>
              </div>
            </>
          )}

          {step === "scanFnuci" && (
            <>
              <div className="text-xs text-gray-500">
                🏷️ Photographie le sticker BicyCode collé sur le vélo — Gemini lit le FNUCI et vérifie qu&apos;il appartient à ce client.
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                capture="environment"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onFnuciPhotoChosen(f);
                }}
                className="hidden"
              />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={busy}
                className="w-full bg-blue-600 text-white rounded-lg py-3 font-medium disabled:opacity-50"
              >
                {phase === "compressing" && "📦 Compression…"}
                {phase === "identifying" && "🤖 Lecture FNUCI par Gemini…"}
                {phase === "uploading" && "💾 Envoi…"}
                {phase === "transferring" && "🔄 Transfert vélo…"}
                {phase === "idle" && "🏷️ Photo BicyCode du vélo"}
              </button>

              {/* Saisie manuelle FNUCI (30-04 11h) : fallback quand Gemini
                  hallucine un caractère (S→3, O→0, etc) ou que la photo n'est
                  pas exploitable. L'opérateur tape les 10 caractères du BicyCode
                  visible et valide. Mêmes garde-fous que la voie photo. */}
              <div className="border-t border-gray-200 pt-3 mt-2">
                <div className="text-[11px] text-gray-500 mb-1.5">
                  Ou tape le FNUCI manuellement (si Gemini hallucine) :
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={manualFnuci}
                    onChange={(e) => setManualFnuci(e.target.value.toUpperCase())}
                    placeholder="BCXXXXXXXX"
                    maxLength={10}
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    disabled={busy}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono tracking-wider uppercase focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  />
                  <button
                    type="button"
                    onClick={validateManualFnuci}
                    disabled={busy || manualFnuci.length !== 10}
                    className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-40"
                  >
                    Valider
                  </button>
                </div>
              </div>
              <button
                onClick={async () => {
                  // Libère le claim avant de revenir au step 1 (sinon le vélo
                  // reste réservé 30 min à ce monteur, bloque les autres).
                  if (currentVeloId && monteurId) {
                    try {
                      await gasPost("releaseVeloMontageClaim", {
                        veloId: currentVeloId,
                        monteurId,
                      });
                    } catch {}
                  }
                  setCurrentFnuci(null);
                  setCurrentVeloId(null);
                  setStep("scanCarton");
                  setErrMsg(null);
                  await reload();
                }}
                disabled={busy}
                className="w-full text-xs text-gray-500 hover:text-gray-700 py-1"
              >
                ← Re-scanner le QR carton
              </button>
            </>
          )}

          {step === "photoMonte" && (
            <>
              <div className="text-xs text-gray-500">
                🔧 Photographie le vélo une fois monté — preuve de réalisation, pose la date de montage en base.
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                capture="environment"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onMontePhotoChosen(f);
                }}
                className="hidden"
              />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={busy}
                className="w-full bg-blue-600 text-white rounded-lg py-3 font-medium disabled:opacity-50"
              >
                {phase === "compressing" && "📦 Compression…"}
                {phase === "uploading" && "💾 Sauvegarde + pose dateMontage…"}
                {phase === "idle" && "🔧 Photo du vélo monté"}
              </button>
              <button
                onClick={cancelCurrentVelo}
                disabled={busy}
                className="w-full text-xs text-gray-500 hover:text-gray-700 py-1"
              >
                Annuler ce vélo
              </button>
            </>
          )}

          {errMsg && (
            <div className="bg-red-50 border border-red-200 text-red-800 text-xs rounded p-2">
              {errMsg}
            </div>
          )}
        </div>
        )}

        {qrScannerOpen && (
          <QrCartonScanner
            title="📦 Montage — scan QR carton"
            subtitle={`Pour ${data.entreprise} uniquement`}
            onScan={handleQrCartonScanned}
            onClose={() => setQrScannerOpen(false)}
            recentScans={qrFeedback}
          />
        )}

        {totals.done === totals.total && totals.total > 0 && (() => {
          // Calcule le prochain client de la tournée à monter (idem flow
          // chauffeur après "Marquer comme livré"). On parcourt les clients
          // dans l'ordre du planning et on prend le 1er après le client
          // courant qui n'est pas encore tout monté.
          let nextClient: { clientId: string; entreprise: string } | null = null;
          if (tourneeProg) {
            const list = tourneeProg.clients;
            const idx = list.findIndex((c) => c.clientId === clientId);
            for (let i = idx + 1; i < list.length; i++) {
              if (list[i].totals.monte < list[i].totals.total) {
                nextClient = list[i];
                break;
              }
            }
            if (!nextClient && idx > 0) {
              for (let i = 0; i < idx; i++) {
                if (list[i].totals.monte < list[i].totals.total) {
                  nextClient = list[i];
                  break;
                }
              }
            }
          }
          const nextUrl = nextClient
            ? `${BASE_PATH}/montage?tourneeId=${encodeURIComponent(tourneeId)}&clientId=${encodeURIComponent(nextClient.clientId)}`
            : null;
          return (
            <div className="bg-emerald-50 border-2 border-emerald-500 rounded-xl p-4 text-center">
              <div className="text-3xl mb-1">🎉</div>
              <div className="text-emerald-900 font-bold">
                Les {totals.total} vélos de {data.entreprise} sont montés.
              </div>
              {nextUrl && nextClient ? (
                <a
                  href={nextUrl}
                  className="block mt-3 bg-blue-600 text-white rounded-lg py-3 text-sm font-semibold hover:bg-blue-700"
                >
                  → Client suivant : {nextClient.entreprise}
                </a>
              ) : (
                <div className="mt-3 text-emerald-900 text-sm font-medium">
                  🏁 Tournée terminée — tous les vélos sont montés.
                </div>
              )}
              <a
                href={`${BASE_PATH}/livraisons`}
                className="block mt-2 text-xs text-emerald-700 underline"
              >
                ← Retour au planning
              </a>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

// Yoann 2026-05-03 : helper legacy supprimé (markVeloMonte sur GAS, jamais
// rappelé). Si besoin d un flow scan QR Strich + 1 photo unique, utiliser
// markVeloMontePhoto migré côté Firestore.
