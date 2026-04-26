"use client";
import { useRef, useState } from "react";
import dynamic from "next/dynamic";
import { gasPost } from "@/lib/gas";
import { useCurrentUser } from "@/lib/current-user";

const QrScanner = dynamic(() => import("@/components/qr-scanner"), { ssr: false });

type Step = "scan" | "photo" | "saving" | "done" | "error";

type MarkResp =
  | { ok: true; veloId: string; fnuci: string; clientId: string; clientName: string | null; alreadyMonte: boolean; dateMontage: string; photoUrl: string }
  | { error: string };

export default function MontagePage() {
  const currentUser = useCurrentUser();
  const monteurId = currentUser?.id || "";
  const monteurNom = currentUser?.nom || "";
  const [step, setStep] = useState<Step>("scan");
  const [scannedFnuci, setScannedFnuci] = useState<string | null>(null);
  const [photoData, setPhotoData] = useState<string | null>(null); // base64 sans prefix
  const [photoPreview, setPhotoPreview] = useState<string | null>(null); // data URL
  const [result, setResult] = useState<MarkResp | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const onScan = (decoded: string) => {
    if (step !== "scan") return;
    setScannedFnuci(decoded);
    setStep("photo");
  };

  const onPhotoChosen = async (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      setPhotoPreview(dataUrl);
      // Strip the "data:image/jpeg;base64," prefix to get raw base64
      const comma = dataUrl.indexOf(",");
      setPhotoData(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
    };
    reader.readAsDataURL(file);
  };

  const submit = async () => {
    if (!scannedFnuci || !photoData) return;
    setStep("saving");
    try {
      const r = (await gasPost("markVeloMonte", {
        fnuci: scannedFnuci,
        monteurId: monteurId,
        photoData,
        mimeType: "image/jpeg",
      })) as MarkResp;
      setResult(r);
      setStep("ok" in r && r.ok ? "done" : "error");
    } catch (e) {
      setResult({ error: String(e) });
      setStep("error");
    }
  };

  const reset = () => {
    setScannedFnuci(null);
    setPhotoData(null);
    setPhotoPreview(null);
    setResult(null);
    setStep("scan");
  };

  const undoLastMontage = async () => {
    if (!result || !("ok" in result) || !result.ok) return;
    if (!confirm(`Annuler le montage du vélo ${result.fnuci} ?`)) return;
    try {
      const r = (await gasPost("unmarkVeloEtape", { veloId: result.veloId, etape: "montage" })) as { ok?: boolean; error?: string };
      if (r.error) {
        alert("Erreur : " + r.error);
        return;
      }
      reset();
    } catch (e) {
      alert("Erreur : " + String(e));
    }
  };

  const undoMontageByFnuci = async (fnuci: string) => {
    if (!fnuci.trim()) return;
    if (!confirm(`Annuler le montage du vélo ${fnuci} ?`)) return;
    try {
      const r = (await gasPost("unmarkVeloEtape", { fnuci: fnuci.trim(), etape: "montage" })) as { ok?: boolean; error?: string; veloId?: string };
      if (r.error) {
        alert("Erreur : " + r.error);
        return;
      }
      alert(`Montage annulé pour ${fnuci}`);
    } catch (e) {
      alert("Erreur : " + String(e));
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 p-3 md:p-6">
      <div className="max-w-md mx-auto">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-xl font-bold">🔧 Montage</h1>
          <a href="/crm-velos-cargo/" className="text-sm text-gray-500 hover:text-gray-700">← Accueil</a>
        </div>

        {monteurId && (
          <div className="bg-white rounded-xl shadow p-2 mb-3 text-sm">
            <span className="text-gray-500">Monteur :</span> <span className="font-medium">{monteurNom || "?"}</span>
          </div>
        )}

        {step === "scan" && (
          <div className="bg-white rounded-xl shadow p-4 space-y-3">
            <div className="text-sm text-gray-700">Scanne le QR du vélo que tu viens de monter.</div>
            <QrScanner enabled={true} onScan={onScan} />
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const v = (e.currentTarget.elements.namedItem("manualFnuci") as HTMLInputElement)?.value?.trim();
                if (v) onScan(v);
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

            <details className="mt-2">
              <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">↺ Annuler le montage d&apos;un vélo</summary>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = (e.currentTarget.elements.namedItem("undoFnuci") as HTMLInputElement)?.value?.trim();
                  if (v) {
                    undoMontageByFnuci(v);
                    (e.currentTarget.elements.namedItem("undoFnuci") as HTMLInputElement).value = "";
                  }
                }}
                className="flex gap-2 mt-2"
              >
                <input
                  name="undoFnuci"
                  className="flex-1 border rounded-lg px-3 py-2 text-sm"
                  placeholder="FNUCI à dé-monter"
                />
                <button type="submit" className="px-3 py-2 bg-orange-100 text-orange-800 rounded-lg text-sm hover:bg-orange-200">
                  ↺ Annuler
                </button>
              </form>
              <p className="text-[10px] text-gray-500 mt-1">
                Le vélo redeviendra &quot;non monté&quot; (utile en cas de test ou de retour).
              </p>
            </details>
          </div>
        )}

        {step === "photo" && scannedFnuci && (
          <div className="bg-white rounded-xl shadow p-4 space-y-3">
            <div className="text-xs text-gray-500">Vélo scanné</div>
            <div className="font-mono text-sm bg-gray-100 px-2 py-1 rounded">{scannedFnuci}</div>
            <div className="text-sm text-gray-700">📸 Prends une photo du vélo monté (preuve de réalisation).</div>

            <input
              ref={photoInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onPhotoChosen(f);
              }}
              className="hidden"
            />
            <button
              onClick={() => photoInputRef.current?.click()}
              className="w-full bg-blue-600 text-white rounded-lg py-3 font-medium"
            >
              {photoPreview ? "🔄 Reprendre la photo" : "📸 Prendre la photo"}
            </button>

            {photoPreview && (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photoPreview} alt="Preuve montage" className="w-full rounded-lg border" />
                <button
                  onClick={submit}
                  className="w-full bg-green-600 text-white rounded-lg py-3 font-medium"
                >
                  ✅ Valider — vélo monté
                </button>
              </>
            )}

            <button
              onClick={reset}
              className="w-full text-sm text-gray-500 hover:text-gray-700 py-2"
            >
              Annuler ce scan
            </button>
          </div>
        )}

        {step === "saving" && (
          <div className="bg-white rounded-xl shadow p-6 text-center text-sm text-gray-600">
            Enregistrement en cours…
          </div>
        )}

        {step === "done" && result && "ok" in result && result.ok && (
          <div className="bg-white rounded-xl shadow p-4 space-y-3">
            <div className="bg-green-50 border border-green-300 rounded p-4 text-center">
              <div className="text-5xl mb-2">✅</div>
              <div className="font-bold text-green-900">{result.alreadyMonte ? "Déjà monté (photo mise à jour)" : "Montage validé"}</div>
              <div className="text-sm text-green-800 mt-2">→ {result.clientName || "Client"}</div>
              <div className="text-xs text-green-700 mt-1 font-mono">{result.fnuci}</div>
              <a href={result.photoUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 underline mt-2 inline-block">
                📎 Voir la photo
              </a>
            </div>
            <button
              onClick={reset}
              className="w-full bg-blue-600 text-white rounded-lg py-3 font-medium"
            >
              🔧 Vélo suivant
            </button>
            <button
              onClick={undoLastMontage}
              className="w-full bg-orange-100 text-orange-800 rounded-lg py-2 font-medium text-sm hover:bg-orange-200"
            >
              ↺ Annuler ce montage (test ou erreur)
            </button>
          </div>
        )}

        {step === "error" && result && "error" in result && (
          <div className="bg-white rounded-xl shadow p-4 space-y-3">
            <div className="bg-red-50 border border-red-300 rounded p-3">
              <div className="font-bold text-red-900 text-center">⚠ Erreur</div>
              <div className="text-sm text-red-800 mt-2">{result.error}</div>
            </div>
            <button
              onClick={reset}
              className="w-full bg-gray-100 text-gray-700 rounded-lg py-3 font-medium"
            >
              Recommencer
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
