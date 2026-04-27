"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { gasGet, gasPost } from "@/lib/gas";
import { useCurrentUser } from "@/lib/current-user";

interface Incoherence {
  clientId: string;
  entreprise: string;
  nbVelosCommandes: number;
  nbVelosDevis: number | null;
  nbDevis: number;
  effectifMax: number;
  effectifSource: string;
  ecart: number;
  nbDocs: number;
  verifIds: string[];
  suggestedTarget: number;
  sens: "trop_velos" | "pas_assez_velos";
}

interface Etablissement {
  clientId: string;
  entreprise: string;
  nbVelos: number;
}

interface IncoherenceSiren {
  siren: string;
  entreprise: string;
  totalVelos: number;
  effectifMax: number;
  effectifSource: string;
  ecart: number;
  sens: "trop_velos" | "pas_assez_velos";
  nbEtablissements: number;
  etablissements: Etablissement[];
  nbDocs: number;
}

interface ClientSansPiece {
  siren: string;
  entreprise: string;
  totalVelos: number;
  etablissements: Etablissement[];
}

interface AuditResp {
  ok?: boolean;
  error?: string;
  total?: number;
  incoherences?: Incoherence[];
  incoherencesParSiren?: IncoherenceSiren[];
  totalSiren?: number;
  clientsSansPieceEffectif?: ClientSansPiece[];
  totalSansPiece?: number;
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

  // Ajuste le nb de vélos d'un client à une cible custom (peut être différente
  // de la suggestion si Gemini a mal lu le doc — ex: RUP multi-pages compté
  // partiellement).
  const adjust = async (item: Incoherence, target: number) => {
    const safeTarget = Math.max(0, Math.floor(target));
    const msg =
      `Client : ${item.entreprise}\n` +
      `Actuellement : ${item.nbVelosCommandes} vélos commandés\n` +
      `Effectif détecté (${item.effectifSource}) : ${item.effectifMax} salariés\n\n` +
      `Ajuster à ${safeTarget} vélos ?\n\n` +
      (safeTarget < item.nbVelosCommandes
        ? "Cela va annuler (soft) les vélos en trop. Aucune donnée n'est supprimée."
        : safeTarget > item.nbVelosCommandes
        ? "Cela va créer les vélos manquants pour atteindre la cible."
        : "");
    if (!confirm(msg)) return;

    setAdjusting(item.clientId);
    try {
      const r = (await gasPost("setClientVelosTarget", {
        clientId: item.clientId,
        target: safeTarget,
      })) as { ok?: boolean; error?: string; before?: number; after?: number; cancelled?: number; created?: number; reactivated?: number };
      if (r.error) {
        alert("Erreur : " + r.error);
        return;
      }
      setAdjusted((prev) => ({
        ...prev,
        [item.clientId]: { before: item.nbVelosCommandes, after: safeTarget },
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
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <KpiCard label="Clients avec effectif détecté" value={String(data.nbClientsAvecEffectifDetecte ?? 0)} />
            <KpiCard label="Incohérences (par établissement)" value={String(data.total ?? 0)} accent={(data.total ?? 0) > 0 ? "text-orange-700" : "text-emerald-700"} />
            <KpiCard label="Incohérences (par SIREN)" value={String(data.totalSiren ?? 0)} accent={(data.totalSiren ?? 0) > 0 ? "text-orange-700" : "text-emerald-700"} />
            <KpiCard label="Sans pièce d'effectif" value={String(data.totalSansPiece ?? 0)} accent={(data.totalSansPiece ?? 0) > 0 ? "text-amber-700" : "text-emerald-700"} />
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
                      <th className="text-right px-3 py-2 font-medium" title="Vélos commandés sur la fiche CRM">CRM</th>
                      <th className="text-right px-3 py-2 font-medium" title="Vélos lus par Gemini sur le devis signé">Devis</th>
                      <th className="text-right px-3 py-2 font-medium" title="Effectif lu par Gemini sur l'attestation">Effectif</th>
                      <th className="text-right px-3 py-2 font-medium">Écart</th>
                      <th className="text-left px-3 py-2 font-medium">Source</th>
                      <th className="text-right px-4 py-2 font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {data.incoherences!.map((it) => (
                      <IncoherenceRow
                        key={it.clientId}
                        item={it}
                        wasAdjusted={adjusted[it.clientId]}
                        adjusting={adjusting === it.clientId}
                        onAdjust={(target) => adjust(it, target)}
                      />
                    ))}
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

          {/* ---- INCOHERENCES PAR SIREN (multi-etablissements) ---- */}
          {(data.incoherencesParSiren?.length ?? 0) > 0 && (
            <div className="mt-10">
              <h2 className="text-lg font-semibold mb-1">Incohérences par SIREN <span className="text-sm font-normal text-gray-500">(multi-établissements)</span></h2>
              <p className="text-xs text-gray-500 mb-3">
                Cas type : un même SIREN ouvert sur plusieurs adresses (ex L&apos;AFRICA PARIS, 10 boutiques). On somme les vélos commandés sur tous les établissements et on compare à l&apos;effectif global du SIREN détecté sur n&apos;importe quel doc.
              </p>
              <div className="bg-white rounded-xl border overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b text-xs text-gray-600">
                      <tr>
                        <th className="text-left px-4 py-2 font-medium">SIREN / Enseigne</th>
                        <th className="text-right px-3 py-2 font-medium">Étab.</th>
                        <th className="text-right px-3 py-2 font-medium">Σ vélos</th>
                        <th className="text-right px-3 py-2 font-medium">Effectif détecté</th>
                        <th className="text-right px-3 py-2 font-medium">Écart</th>
                        <th className="text-left px-3 py-2 font-medium">Source</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {data.incoherencesParSiren!.map((s) => {
                        const sensColor = s.sens === "trop_velos" ? "text-orange-700" : "text-blue-700";
                        const sensLabel =
                          s.sens === "trop_velos"
                            ? `${s.ecart} en trop`
                            : `${Math.abs(s.ecart)} manquants`;
                        return (
                          <tr key={s.siren} className="hover:bg-gray-50 align-top">
                            <td className="px-4 py-2">
                              <div className="font-medium">{s.entreprise}</div>
                              <div className="text-[11px] text-gray-400">SIREN {s.siren}</div>
                              <details className="mt-1">
                                <summary className="text-[11px] text-blue-600 cursor-pointer">voir les {s.nbEtablissements} établissements</summary>
                                <ul className="mt-1 space-y-0.5">
                                  {s.etablissements.map((e) => (
                                    <li key={e.clientId} className="text-[11px] text-gray-600">
                                      <Link href={`/clients/detail?id=${encodeURIComponent(e.clientId)}`} className="text-blue-700 hover:underline">
                                        {e.entreprise}
                                      </Link>
                                      <span className="ml-2 text-gray-400">{e.nbVelos} vélos</span>
                                    </li>
                                  ))}
                                </ul>
                              </details>
                            </td>
                            <td className="px-3 py-2 text-right font-mono text-xs">{s.nbEtablissements}</td>
                            <td className="px-3 py-2 text-right font-mono">{s.totalVelos}</td>
                            <td className="px-3 py-2 text-right font-mono">{s.effectifMax}</td>
                            <td className={`px-3 py-2 text-right text-xs ${sensColor}`}>{sensLabel}</td>
                            <td className="px-3 py-2 text-xs text-gray-500">{s.effectifSource}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
              <p className="text-[11px] text-gray-400 mt-2 leading-snug">
                Pas de bouton « Ajuster » à ce niveau : la répartition entre établissements est ta décision commerciale. Ouvre les fiches concernées pour ajuster établissement par établissement.
              </p>
            </div>
          )}

          {/* ---- CLIENTS SANS PIECE D'EFFECTIF ---- */}
          {(data.clientsSansPieceEffectif?.length ?? 0) > 0 && (
            <div className="mt-10">
              <h2 className="text-lg font-semibold mb-1">Sans pièce d&apos;effectif</h2>
              <p className="text-xs text-gray-500 mb-3">
                Clients avec des vélos commandés mais aucune attestation URSSAF / DSN / liasse fiscale scannée. Impossible à vérifier tant qu&apos;on n&apos;a pas de doc — risque CEE en l&apos;état. Groupé par SIREN.
              </p>
              <div className="bg-white rounded-xl border overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b text-xs text-gray-600">
                      <tr>
                        <th className="text-left px-4 py-2 font-medium">SIREN / Enseigne</th>
                        <th className="text-right px-3 py-2 font-medium">Étab.</th>
                        <th className="text-right px-3 py-2 font-medium">Σ vélos commandés</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {data.clientsSansPieceEffectif!.map((s, idx) => (
                        <tr key={s.siren || `nosi-${idx}`} className="hover:bg-amber-50/40 align-top">
                          <td className="px-4 py-2">
                            <div className="font-medium">{s.entreprise}</div>
                            {s.siren && <div className="text-[11px] text-gray-400">SIREN {s.siren}</div>}
                            {s.etablissements.length > 1 ? (
                              <details className="mt-1">
                                <summary className="text-[11px] text-blue-600 cursor-pointer">voir les {s.etablissements.length} établissements</summary>
                                <ul className="mt-1 space-y-0.5">
                                  {s.etablissements.map((e) => (
                                    <li key={e.clientId} className="text-[11px] text-gray-600">
                                      <Link href={`/clients/detail?id=${encodeURIComponent(e.clientId)}`} className="text-blue-700 hover:underline">
                                        {e.entreprise}
                                      </Link>
                                      <span className="ml-2 text-gray-400">{e.nbVelos} vélos</span>
                                    </li>
                                  ))}
                                </ul>
                              </details>
                            ) : (
                              s.etablissements[0] && (
                                <Link href={`/clients/detail?id=${encodeURIComponent(s.etablissements[0].clientId)}`} className="text-[11px] text-blue-700 hover:underline">
                                  ouvrir la fiche →
                                </Link>
                              )
                            )}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-xs">{s.etablissements.length}</td>
                          <td className="px-3 py-2 text-right font-mono">{s.totalVelos}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
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

function IncoherenceRow({
  item,
  wasAdjusted,
  adjusting,
  onAdjust,
}: {
  item: Incoherence;
  wasAdjusted?: { before: number; after: number };
  adjusting: boolean;
  onAdjust: (target: number) => void;
}) {
  const [target, setTarget] = useState<string>(String(item.suggestedTarget));
  const sensColor = item.sens === "trop_velos" ? "text-orange-700" : "text-blue-700";
  const sensLabel =
    item.sens === "trop_velos"
      ? `${item.ecart} vélo${item.ecart > 1 ? "s" : ""} en trop`
      : `${Math.abs(item.ecart)} vélo${Math.abs(item.ecart) > 1 ? "s" : ""} manquant${Math.abs(item.ecart) > 1 ? "s" : ""}`;
  const targetNum = Number(target);
  const validTarget = Number.isFinite(targetNum) && targetNum >= 0;
  return (
    <tr className={wasAdjusted ? "bg-emerald-50/50" : "hover:bg-gray-50"}>
      <td className="px-4 py-2">
        <Link
          href={`/clients/detail?id=${encodeURIComponent(item.clientId)}`}
          className="text-blue-700 hover:underline font-medium"
        >
          {item.entreprise}
        </Link>
        {item.nbDocs > 1 && (
          <span className="ml-2 text-[10px] text-gray-400">({item.nbDocs} docs)</span>
        )}
      </td>
      <td className="px-3 py-2 text-right font-mono">{item.nbVelosCommandes}</td>
      <td className="px-3 py-2 text-right font-mono">
        {item.nbVelosDevis != null ? (
          <span className={item.nbVelosDevis !== item.nbVelosCommandes ? "text-amber-700" : ""} title={`${item.nbDevis} devis analysé${item.nbDevis > 1 ? "s" : ""} par Gemini`}>
            {item.nbVelosDevis}
          </span>
        ) : (
          <span className="text-gray-300">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-right font-mono">{item.effectifMax}</td>
      <td className={`px-3 py-2 text-right text-xs ${sensColor}`}>{sensLabel}</td>
      <td className="px-3 py-2 text-xs text-gray-500">{item.effectifSource}</td>
      <td className="px-4 py-2 text-right">
        {wasAdjusted ? (
          <span className="text-xs text-emerald-700">
            ✓ ajusté ({wasAdjusted.before} → {wasAdjusted.after})
          </span>
        ) : (
          <div className="inline-flex items-center gap-1">
            <input
              type="number"
              min={0}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={adjusting}
              className="w-16 px-2 py-1 text-xs border rounded text-right"
              title="Si Gemini a mal lu le doc, corrige le chiffre ici avant d'ajuster"
            />
            <button
              onClick={() => onAdjust(targetNum)}
              disabled={adjusting || !validTarget}
              className="px-3 py-1 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {adjusting ? "…" : "Ajuster"}
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}
