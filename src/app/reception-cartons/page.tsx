"use client";
import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { gasGet, gasPost } from "@/lib/gas";
import { useData, type ClientPoint } from "@/lib/data-context";

const QrScanner = dynamic(() => import("@/components/qr-scanner"), { ssr: false });

type LookupResp =
  | { found: true; veloId: string; clientId: string; clientName: string | null; fnuci: string }
  | { found: false; fnuci: string };

type AssignResp =
  | { ok: true; veloId: string; fnuci: string; restantPourClient: number; alreadyAssigned?: boolean; message?: string }
  | { error: string; existingClientId?: string; existingClientName?: string | null };

type Step = "scan" | "choose-client" | "confirming" | "result";

export default function ReceptionCartonsPage() {
  const { carte, refresh } = useData();
  const [step, setStep] = useState<Step>("scan");
  const [scannedFnuci, setScannedFnuci] = useState<string | null>(null);
  const [lookup, setLookup] = useState<LookupResp | null>(null);
  const [search, setSearch] = useState("");
  const [chosenClient, setChosenClient] = useState<ClientPoint | null>(null);
  const [result, setResult] = useState<AssignResp | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    refresh("carte");
  }, [refresh]);

  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = carte.filter((c) => (c.nbVelos || 0) > (c.velosLivres || 0));
    if (!q) return base.slice(0, 12);
    return base
      .filter((c) =>
        (c.entreprise || "").toLowerCase().includes(q) ||
        (c.ville || "").toLowerCase().includes(q) ||
        (c.codePostal || "").toLowerCase().includes(q),
      )
      .slice(0, 30);
  }, [carte, search]);

  const onScan = async (decoded: string) => {
    if (busy || step !== "scan") return;
    // Extrait BC + 8 alphanum d'une URL BicyCode (ou garde tel quel si saisie manuelle).
    const match = decoded.trim().match(/BC[A-Z0-9]{8}/i);
    const fnuci = match ? match[0].toUpperCase() : decoded.trim();
    setBusy(true);
    setScannedFnuci(fnuci);
    try {
      const r = (await gasGet("lookupFnuci", { fnuci })) as LookupResp;
      setLookup(r);
      setStep("choose-client");
    } finally {
      setBusy(false);
    }
  };

  const confirmAssign = async (clientId: string) => {
    if (!scannedFnuci) return;
    setStep("confirming");
    setBusy(true);
    try {
      const r = (await gasPost("assignFnuciToClient", {
        fnuci: scannedFnuci,
        clientId,
      })) as AssignResp;
      setResult(r);
      setStep("result");
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setStep("scan");
    setScannedFnuci(null);
    setLookup(null);
    setSearch("");
    setChosenClient(null);
    setResult(null);
  };

  return (
    <div className="min-h-screen bg-gray-50 p-3 md:p-6">
      <div className="max-w-md mx-auto">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold">📦 Réception cartons</h1>
          <a href="/crm-velos-cargo/" className="text-sm text-gray-500 hover:text-gray-700">← Accueil</a>
        </div>

        {step === "scan" && (
          <div className="bg-white rounded-xl shadow p-4 space-y-3">
            <div className="text-sm text-gray-700">
              Scanne le QR (FNUCI) du carton pour l&apos;affecter à un client.
            </div>
            <QrScanner enabled={!busy} onScan={onScan} />
            <div className="border-t pt-3">
              <label className="text-xs text-gray-500">Saisie manuelle si scan KO :</label>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = (e.currentTarget.elements.namedItem("manualFnuci") as HTMLInputElement)?.value?.trim();
                  if (v) onScan(v);
                }}
                className="flex gap-2 mt-1"
              >
                <input
                  name="manualFnuci"
                  className="flex-1 border rounded-lg px-3 py-2 text-sm"
                  placeholder="FNUCI manuel"
                />
                <button type="submit" className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm">OK</button>
              </form>
            </div>
          </div>
        )}

        {step === "choose-client" && lookup && (
          <div className="bg-white rounded-xl shadow p-4 space-y-3">
            <div className="text-xs text-gray-500">FNUCI scanné</div>
            <div className="font-mono text-sm bg-gray-100 px-2 py-1 rounded">{scannedFnuci}</div>

            {lookup.found ? (
              <div className="bg-amber-50 border border-amber-300 rounded p-3 text-sm">
                <div className="font-medium text-amber-900">⚠ Ce FNUCI est déjà affecté</div>
                <div className="text-amber-800 mt-1">→ Client : <span className="font-medium">{lookup.clientName || lookup.clientId}</span></div>
                <div className="text-xs text-amber-700 mt-2">
                  Si tu confirmes ci-dessous, tu vas écraser cette affectation.
                </div>
              </div>
            ) : (
              <div className="text-sm text-gray-700">FNUCI inconnu. Choisis le client de destination :</div>
            )}

            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Recherche entreprise / ville / CP…"
              className="w-full border rounded-lg px-3 py-2 text-sm"
              autoFocus
            />

            <div className="space-y-1 max-h-80 overflow-y-auto">
              {candidates.map((c) => {
                const restant = (c.nbVelos || 0) - (c.velosLivres || 0);
                return (
                  <button
                    key={c.id}
                    onClick={() => {
                      setChosenClient(c);
                      confirmAssign(c.id);
                    }}
                    className="w-full text-left border rounded-lg p-2 hover:bg-blue-50 hover:border-blue-300"
                  >
                    <div className="font-medium text-sm">{c.entreprise}</div>
                    <div className="text-xs text-gray-500">
                      {c.codePostal} {c.ville} · {restant} vélo{restant > 1 ? "s" : ""} restant{restant > 1 ? "s" : ""} à recevoir
                    </div>
                  </button>
                );
              })}
              {candidates.length === 0 && (
                <div className="text-xs text-gray-500 text-center py-4">Aucun client trouvé</div>
              )}
            </div>

            <button
              onClick={reset}
              className="w-full text-sm text-gray-500 hover:text-gray-700 py-2"
            >
              Annuler ce scan
            </button>
          </div>
        )}

        {step === "confirming" && (
          <div className="bg-white rounded-xl shadow p-6 text-center">
            <div className="text-sm text-gray-600">Affectation en cours…</div>
          </div>
        )}

        {step === "result" && result && (
          <div className="bg-white rounded-xl shadow p-4 space-y-3">
            {"ok" in result && result.ok ? (
              <>
                <div className="bg-green-50 border border-green-300 rounded p-3 text-center">
                  <div className="text-3xl mb-1">✅</div>
                  <div className="font-bold text-green-900">{result.alreadyAssigned ? "Déjà affecté" : "Carton enregistré"}</div>
                  <div className="text-sm text-green-800 mt-2">
                    FNUCI <span className="font-mono">{result.fnuci}</span>
                  </div>
                  <div className="text-sm text-green-800">
                    → {chosenClient?.entreprise || "client"}
                  </div>
                  {!result.alreadyAssigned && (
                    <div className="text-xs text-green-700 mt-2">
                      Reste {result.restantPourClient} vélo{result.restantPourClient > 1 ? "s" : ""} à recevoir pour ce client
                    </div>
                  )}
                </div>
                <button
                  onClick={reset}
                  className="w-full bg-blue-600 text-white rounded-lg py-3 font-medium"
                >
                  📦 Scanner le prochain carton
                </button>
              </>
            ) : (
              <>
                <div className="bg-red-50 border border-red-300 rounded p-3">
                  <div className="text-2xl text-center mb-1">⚠</div>
                  <div className="font-bold text-red-900 text-center">Erreur</div>
                  <div className="text-sm text-red-800 mt-2">{"error" in result ? result.error : ""}</div>
                  {"existingClientName" in result && result.existingClientName && (
                    <div className="text-xs text-red-700 mt-1">FNUCI déjà chez : {result.existingClientName}</div>
                  )}
                </div>
                <button
                  onClick={reset}
                  className="w-full bg-gray-100 text-gray-700 rounded-lg py-3 font-medium"
                >
                  Recommencer
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
