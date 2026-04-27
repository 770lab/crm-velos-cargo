"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { gasGet, gasPost } from "@/lib/gas";
import { useCurrentUser } from "@/lib/current-user";

interface Incoherence {
  clientId: string;
  entreprise: string;
  nbVelosCommandes: number;
  effectifMax: number;
  effectifSource: string;
  ecart: number;
  nbDocs: number;
  verifIds: string[];
  suggestedTarget: number;
  sens: "trop_velos" | "pas_assez_velos";
}

interface AuditResp {
  ok?: boolean;
  error?: string;
  total?: number;
  incoherences?: Incoherence[];
  nbClientsAvecEffectifDetecte?: number;
}

export default function AuditEffectifsPage() {
  const user = useCurrentUser();
  const [data, setData] = useState<AuditResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [adjusted, setAdjusted] = useState<Record<string, { before: number; after: number }>>({});

  // Lance l'audit au mount + bouton manuel pour rafraîchir.
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = (await gasGet("auditEffectifs", {})) as AuditResp;
      if (r.error) setError(r.error);
      else setData(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // Ajuste le nb de vélos d'un client après confirmation utilisateur.
  // Utilise setClientVelosTarget côté GAS qui fait du soft cancel des vélos en
  // trop (jamais de hard delete) et crée les manquants si target > actuel.
  const adjust = async (item: Incoherence) => {
    const msg =
      `Client : ${item.entreprise}\n` +
      `Actuellement : ${item.nbVelosCommandes} vélos commandés\n` +
      `Effectif détecté (${item.effectifSource}) : ${item.effectifMax} salariés\n\n` +
      `Ajuster à ${item.suggestedTarget} vélos ?\n\n` +
      (item.sens === "trop_velos"
        ? "Cela va annuler (soft) les vélos en trop. Aucune donnée n'est supprimée."
        : "Cela va créer les vélos manquants pour atteindre l'effectif détecté.");
    if (!confirm(msg)) return;

    setAdjusting(item.clientId);
    try {
      const r = (await gasPost("setClientVelosTarget", {
        clientId: item.clientId,
        target: item.suggestedTarget,
      })) as { ok?: boolean; error?: string; before?: number; after?: number; cancelled?: number; created?: number; reactivated?: number };
      if (r.error) {
        alert("Erreur : " + r.error);
        return;
      }
      setAdjusted((prev) => ({
        ...prev,
        [item.clientId]: { before: item.nbVelosCommandes, after: item.suggestedTarget },
      }));
    } catch (e) {
      alert("Erreur : " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setAdjusting(null);
    }
  };

  // Garde-fou : la page est utile a l'admin et au superadmin.
  if (user && user.role !== "admin" && user.role !== "superadmin") {
    return (
      <div className="max-w-2xl mx-auto bg-amber-50 border border-amber-200 rounded-xl p-6 text-amber-800">
        Cette page est réservée à l&apos;administration.
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Audit effectifs vs vélos</h1>
          <p className="text-sm text-gray-500 mt-1">
            Croise l&apos;effectif détecté par Gemini sur les DSN / attestations Urssaf déjà reçues avec
            le nombre de vélos commandés sur la fiche client. Règle CEE : 1 vélo max par salarié.
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="px-3 py-1.5 text-sm border rounded-lg hover:bg-gray-50 disabled:opacity-50"
        >
          {loading ? "Audit en cours…" : "↻ Relancer l'audit"}
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-3 mb-4 text-sm">
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="text-center py-12 text-gray-400 text-sm">Audit en cours…</div>
      )}

      {data?.ok && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
            <KpiCard label="Clients avec effectif détecté" value={String(data.nbClientsAvecEffectifDetecte ?? 0)} />
            <KpiCard label="Incohérences" value={String(data.total ?? 0)} accent={(data.total ?? 0) > 0 ? "text-orange-700" : "text-emerald-700"} />
            <KpiCard label="Ajustements faits dans cette session" value={String(Object.keys(adjusted).length)} accent="text-blue-700" />
          </div>

          {(data.incoherences?.length ?? 0) === 0 ? (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-6 text-center text-emerald-900">
              ✅ Aucune incohérence détectée. Tous les clients dont l&apos;effectif est connu ont un nombre de vélos commandés cohérent.
            </div>
          ) : (
            <div className="bg-white rounded-xl border overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b text-xs text-gray-600">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium">Client</th>
                      <th className="text-right px-3 py-2 font-medium">Vélos commandés</th>
                      <th className="text-right px-3 py-2 font-medium">Effectif détecté</th>
                      <th className="text-right px-3 py-2 font-medium">Écart</th>
                      <th className="text-left px-3 py-2 font-medium">Source</th>
                      <th className="text-right px-4 py-2 font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {data.incoherences!.map((it) => {
                      const wasAdjusted = adjusted[it.clientId];
                      const sensColor =
                        it.sens === "trop_velos" ? "text-orange-700" : "text-blue-700";
                      const sensLabel =
                        it.sens === "trop_velos"
                          ? `${it.ecart} vélo${it.ecart > 1 ? "s" : ""} en trop`
                          : `${Math.abs(it.ecart)} vélo${Math.abs(it.ecart) > 1 ? "s" : ""} manquant${Math.abs(it.ecart) > 1 ? "s" : ""}`;
                      return (
                        <tr key={it.clientId} className={wasAdjusted ? "bg-emerald-50/50" : "hover:bg-gray-50"}>
                          <td className="px-4 py-2">
                            <Link
                              href={`/clients/detail?id=${encodeURIComponent(it.clientId)}`}
                              className="text-blue-700 hover:underline font-medium"
                            >
                              {it.entreprise}
                            </Link>
                            {it.nbDocs > 1 && (
                              <span className="ml-2 text-[10px] text-gray-400">
                                ({it.nbDocs} docs)
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right font-mono">{it.nbVelosCommandes}</td>
                          <td className="px-3 py-2 text-right font-mono">{it.effectifMax}</td>
                          <td className={`px-3 py-2 text-right text-xs ${sensColor}`}>{sensLabel}</td>
                          <td className="px-3 py-2 text-xs text-gray-500">{it.effectifSource}</td>
                          <td className="px-4 py-2 text-right">
                            {wasAdjusted ? (
                              <span className="text-xs text-emerald-700">
                                ✓ ajusté ({wasAdjusted.before} → {wasAdjusted.after})
                              </span>
                            ) : (
                              <button
                                onClick={() => adjust(it)}
                                disabled={adjusting === it.clientId}
                                className="px-3 py-1 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                              >
                                {adjusting === it.clientId ? "…" : `Ajuster à ${it.suggestedTarget}`}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="text-[11px] text-gray-400 mt-4 leading-snug">
            « Vélos en trop » = saisie commerciale optimiste, l&apos;effectif réel ne justifie pas autant de vélos
            pour le dossier CEE. « Vélos manquants » = la DSN mentionne plus de salariés que ce qui a été commandé,
            tu peux étendre la commande. L&apos;ajustement passe par <code>setClientVelosTarget</code> qui fait du soft cancel
            (jamais de hard delete) et crée les vélos manquants si target {">"} actuel.
          </p>
        </>
      )}
    </div>
  );
}

function KpiCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="bg-white rounded-xl border p-4">
      <div className="text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${accent || "text-gray-900"}`}>{value}</div>
    </div>
  );
}
