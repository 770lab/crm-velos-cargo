"use client";

import { useEffect, useMemo, useState } from "react";
import { gasGet, gasPost } from "@/lib/gas";
import { useData, type Camion, type EquipeMember } from "@/lib/data-context";

type Dispo = {
  id: string;
  date: string;
  ressourceType: "camion" | "chauffeur" | "chef" | "monteur";
  ressourceId: string;
  notes?: string | null;
};

type Proposition = {
  tournees: Array<{
    camionId: string;
    camionNom: string;
    ordreCamion?: number;
    totalVelos: number;
    dureeMinutesEstimee?: number;
    chauffeurId?: string;
    chefEquipeIds?: string[];
    monteurIds?: string[];
    arrets: Array<{ clientId: string; entreprise: string; nbVelos: number; distanceKmDepot?: number; motif?: string }>;
    motifGlobal?: string;
  }>;
  clientsNonAffectes?: Array<{ clientId: string; entreprise: string; nbVelos: number; raison: string }>;
  resume?: string;
  warnings?: string[];
};

type ProposeResponse = {
  ok?: boolean;
  date?: string;
  mode?: string;
  capacite?: { camions: Camion[]; chauffeurs: number; chefs: number; monteurs: number; capaciteTotaleVelos: number; dejaAffecte: number };
  clientsCandidats?: number;
  clientsTropGros?: { clientId: string; entreprise: string; ville?: string; nbVelosRestants: number; raison: string }[];
  proposition?: Proposition;
  message?: string;
  error?: string;
  raw?: string;
  parseError?: string;
  finishReason?: string;
  rawLength?: number;
  rawHead?: string;
  rawTail?: string;
  errContext?: {
    position: number;
    before: string;
    at: string;
    after: string;
  } | null;
  body?: string;
};

function isoToday() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

export default function DayPlannerModal({
  initialDate,
  onClose,
  onApplied,
}: {
  initialDate?: string;
  onClose: () => void;
  onApplied?: () => void;
}) {
  const { equipe, flotte, refresh } = useData();
  const [date, setDate] = useState(initialDate || isoToday());
  const [camionIds, setCamionIds] = useState<Set<string>>(new Set());
  const [chauffeurIds, setChauffeurIds] = useState<Set<string>>(new Set());
  const [chefIds, setChefIds] = useState<Set<string>>(new Set());
  const [monteurIds, setMonteurIds] = useState<Set<string>>(new Set());
  const [loadingDispo, setLoadingDispo] = useState(false);
  const [savingDispo, setSavingDispo] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [proposition, setProposition] = useState<ProposeResponse | null>(null);
  const [applying, setApplying] = useState(false);
  const [mode, setMode] = useState<"fillGaps" | "fromScratch">("fillGaps");

  const camions = useMemo(() => flotte.filter((c) => c.actif), [flotte]);
  const chauffeurs = useMemo(() => equipe.filter((m) => m.role === "chauffeur" && m.actif !== false), [equipe]);
  const chefs = useMemo(() => equipe.filter((m) => m.role === "chef" && m.actif !== false), [equipe]);
  const monteurs = useMemo(() => equipe.filter((m) => m.role === "monteur" && m.actif !== false), [equipe]);

  // Charge les dispos existantes pour la date
  useEffect(() => {
    let cancelled = false;
    setLoadingDispo(true);
    gasGet("listDisponibilites", { date })
      .then((r: { items?: Dispo[] }) => {
        if (cancelled) return;
        const items = r.items || [];
        setCamionIds(new Set(items.filter((d) => d.ressourceType === "camion").map((d) => d.ressourceId)));
        setChauffeurIds(new Set(items.filter((d) => d.ressourceType === "chauffeur").map((d) => d.ressourceId)));
        setChefIds(new Set(items.filter((d) => d.ressourceType === "chef").map((d) => d.ressourceId)));
        setMonteurIds(new Set(items.filter((d) => d.ressourceType === "monteur").map((d) => d.ressourceId)));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingDispo(false);
      });
    return () => {
      cancelled = true;
    };
  }, [date]);

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void) => (id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  };

  const capaciteVelos = useMemo(() => {
    return camions.filter((c) => camionIds.has(c.id)).reduce((s, c) => s + (c.capaciteVelos || 0), 0);
  }, [camions, camionIds]);

  const saveDispos = async () => {
    setSavingDispo(true);
    try {
      await gasPost("setDisponibilites", {
        date,
        camionIds: Array.from(camionIds),
        chauffeurIds: Array.from(chauffeurIds),
        chefIds: Array.from(chefIds),
        monteurIds: Array.from(monteurIds),
      });
    } finally {
      setSavingDispo(false);
    }
  };

  const propose = async () => {
    setProposing(true);
    setProposition(null);
    try {
      // Sauvegarde les dispos d'abord pour que Gemini voie l'état actuel
      await gasPost("setDisponibilites", {
        date,
        camionIds: Array.from(camionIds),
        chauffeurIds: Array.from(chauffeurIds),
        chefIds: Array.from(chefIds),
        monteurIds: Array.from(monteurIds),
      });
      const r = (await gasPost("proposeTournee", { date, mode })) as ProposeResponse;
      setProposition(r);
    } catch (err) {
      setProposition({ error: String(err) });
    } finally {
      setProposing(false);
    }
  };

  const applyProposition = async () => {
    if (!proposition?.proposition?.tournees?.length) return;
    setApplying(true);
    try {
      const tourneesPayload = proposition.proposition.tournees.map((t) => ({
        datePrevue: date,
        mode: "",
        stops: t.arrets.map((a, i) => ({ clientId: a.clientId, nbVelos: a.nbVelos, ordre: i + 1 })),
      }));
      const created = (await gasPost("createTournees", { tournees: tourneesPayload })) as {
        tournees?: { tourneeId?: string }[];
      };
      const createdIds = (created.tournees || []).map((r) => r?.tourneeId).filter(Boolean) as string[];

      // Assignation équipe : on utilise en priorité ce que Gemini a proposé par tournée
      // (chauffeurId, chefEquipeIds, monteurIds). Fallback round-robin sur les ressources
      // cochées si Gemini n'a pas rempli ces champs.
      const chauffeurArr = Array.from(chauffeurIds);
      const chefArr = Array.from(chefIds);
      const monteurArr = Array.from(monteurIds);
      const nT = createdIds.length;
      const fallbackMonteurBuckets: string[][] = Array.from({ length: nT }, () => []);
      monteurArr.forEach((mid, i) => { fallbackMonteurBuckets[i % nT].push(mid); });

      const tourneesGemini = proposition.proposition.tournees;
      await Promise.all(
        createdIds.map((tid, i) => {
          const t = tourneesGemini[i] || {};
          const chauffeurId = t.chauffeurId || (chauffeurArr.length ? chauffeurArr[i % chauffeurArr.length] : "");
          const chefEquipeIds = (t.chefEquipeIds && t.chefEquipeIds.length)
            ? t.chefEquipeIds
            : (chefArr.length ? [chefArr[i % chefArr.length]] : []);
          const monteurIdsT = (t.monteurIds && t.monteurIds.length)
            ? t.monteurIds
            : fallbackMonteurBuckets[i];
          return gasPost("assignTournee", {
            tourneeId: tid,
            chauffeurId,
            chefEquipeIds,
            monteurIds: monteurIdsT,
            nbMonteurs: monteurIdsT.length,
          });
        }),
      );

      await refresh("livraisons");
      onApplied?.();
      onClose();
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl p-6 w-full max-w-4xl max-h-[92vh] overflow-y-auto">
        <div className="flex justify-between items-start mb-4">
          <div>
            <h2 className="text-xl font-semibold">🪄 Planifier le jour</h2>
            <p className="text-sm text-gray-500 mt-1">
              Annonce qui/quoi est dispo, puis Gemini propose la ventilation optimale (Paris d&apos;abord, du plus près au plus loin du dépôt).
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>
        </div>

        <div className="flex items-center gap-3 mb-4">
          <label className="text-sm font-medium text-gray-700">Date :</label>
          <input
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setProposition(null);
            }}
            className="px-3 py-1.5 border rounded-lg text-sm"
          />
          <span className="text-xs text-gray-500 ml-2">
            {loadingDispo ? "chargement…" : `Capacité totale : ${capaciteVelos} vélos`}
          </span>
        </div>

        {/* 4 colonnes ressources */}
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
          <ResourceColumn
            title="🚚 Camions"
            items={camions.map((c) => ({
              id: c.id,
              label: `${c.nom} (${c.capaciteVelos}v${c.peutEntrerParis ? "" : ", pas Paris"})`,
            }))}
            selected={camionIds}
            onToggle={toggle(camionIds, setCamionIds)}
          />
          <ResourceColumn
            title="👤 Chauffeurs"
            items={chauffeurs.map((m: EquipeMember) => ({ id: m.id, label: m.nom }))}
            selected={chauffeurIds}
            onToggle={toggle(chauffeurIds, setChauffeurIds)}
          />
          <ResourceColumn
            title="👷 Chefs d'équipe"
            items={chefs.map((m: EquipeMember) => ({ id: m.id, label: m.nom }))}
            selected={chefIds}
            onToggle={toggle(chefIds, setChefIds)}
          />
          <ResourceColumn
            title="🔧 Monteurs"
            items={monteurs.map((m: EquipeMember) => ({ id: m.id, label: m.nom }))}
            selected={monteurIds}
            onToggle={toggle(monteurIds, setMonteurIds)}
          />
        </div>

        <div className="flex items-center gap-2 mb-4">
          <button
            onClick={saveDispos}
            disabled={savingDispo}
            className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 disabled:opacity-50"
          >
            {savingDispo ? "Sauvegarde…" : "💾 Enregistrer les dispos seules"}
          </button>
          <div className="flex-1" />
          <label className="text-xs text-gray-600 flex items-center gap-1">
            <input
              type="radio"
              name="propose-mode"
              value="fillGaps"
              checked={mode === "fillGaps"}
              onChange={() => setMode("fillGaps")}
            />
            Compléter l&apos;existant
          </label>
          <label className="text-xs text-gray-600 flex items-center gap-1">
            <input
              type="radio"
              name="propose-mode"
              value="fromScratch"
              checked={mode === "fromScratch"}
              onChange={() => setMode("fromScratch")}
            />
            Repartir de zéro
          </label>
          <button
            onClick={propose}
            disabled={proposing || camionIds.size === 0}
            className="px-4 py-2 text-sm bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50"
            title={camionIds.size === 0 ? "Sélectionne au moins 1 camion" : ""}
          >
            {proposing ? "Gemini réfléchit…" : "🪄 Proposer la tournée"}
          </button>
        </div>

        {/* Résultat Gemini */}
        {proposition && (
          <div className="border-t pt-4">
            {proposition.error ? (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
                <div className="font-medium">Erreur Gemini</div>
                <div className="mt-1">{proposition.error}</div>
                {(proposition.finishReason || proposition.rawLength != null || proposition.parseError) && (
                  <div className="mt-1 text-xs text-red-700 space-y-0.5">
                    {proposition.finishReason && <div>finishReason : <code>{proposition.finishReason}</code></div>}
                    {proposition.rawLength != null && <div>longueur réponse : {proposition.rawLength} chars</div>}
                    {proposition.parseError && <div>parseError : <code>{proposition.parseError}</code></div>}
                  </div>
                )}
                {proposition.rawHead && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-red-700">Début de la réponse</summary>
                    <pre className="mt-1 text-xs whitespace-pre-wrap text-red-700 bg-red-100 p-2 rounded max-h-40 overflow-y-auto">{proposition.rawHead}</pre>
                  </details>
                )}
                {proposition.rawTail && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-red-700">Fin de la réponse</summary>
                    <pre className="mt-1 text-xs whitespace-pre-wrap text-red-700 bg-red-100 p-2 rounded max-h-40 overflow-y-auto">{proposition.rawTail}</pre>
                  </details>
                )}
                {proposition.errContext && (
                  <details className="mt-2" open>
                    <summary className="cursor-pointer text-xs text-red-700 font-medium">
                      Contexte autour de l&apos;erreur (position {proposition.errContext.position})
                    </summary>
                    <pre className="mt-1 text-xs whitespace-pre-wrap text-red-700 bg-red-100 p-2 rounded max-h-60 overflow-y-auto">
                      <span className="text-red-600">{proposition.errContext.before}</span>
                      <span className="bg-yellow-300 text-black font-bold px-0.5">{proposition.errContext.at || "·"}</span>
                      <span className="text-red-600">{proposition.errContext.after}</span>
                    </pre>
                  </details>
                )}
                {proposition.raw && (
                  <pre className="mt-2 text-xs whitespace-pre-wrap text-red-700 bg-red-100 p-2 rounded max-h-40 overflow-y-auto">{proposition.raw}</pre>
                )}
                {proposition.body && (
                  <pre className="mt-2 text-xs whitespace-pre-wrap text-red-700 bg-red-100 p-2 rounded max-h-40 overflow-y-auto">{proposition.body}</pre>
                )}
              </div>
            ) : (
              <PropositionView proposition={proposition} equipe={equipe} onApply={applyProposition} applying={applying} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ResourceColumn({
  title,
  items,
  selected,
  onToggle,
}: {
  title: string;
  items: Array<{ id: string; label: string }>;
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="border rounded-lg p-3">
      <div className="font-medium text-sm mb-2 flex items-center justify-between">
        <span>{title}</span>
        <span className="text-xs text-gray-400">
          {selected.size}/{items.length}
        </span>
      </div>
      <div className="space-y-1 max-h-48 overflow-y-auto">
        {items.length === 0 ? (
          <div className="text-xs text-gray-400 italic">Aucun</div>
        ) : (
          items.map((it) => (
            <label
              key={it.id}
              className={`flex items-center gap-2 text-xs px-2 py-1 rounded cursor-pointer hover:bg-gray-50 ${
                selected.has(it.id) ? "bg-blue-50 text-blue-900" : "text-gray-700"
              }`}
            >
              <input
                type="checkbox"
                checked={selected.has(it.id)}
                onChange={() => onToggle(it.id)}
              />
              <span className="truncate">{it.label}</span>
            </label>
          ))
        )}
      </div>
    </div>
  );
}

function PropositionView({
  proposition,
  equipe,
  onApply,
  applying,
}: {
  proposition: ProposeResponse;
  equipe: EquipeMember[];
  onApply: () => void;
  applying: boolean;
}) {
  const tournees = proposition.proposition?.tournees || [];
  const nonAffectes = proposition.proposition?.clientsNonAffectes || [];
  const tropGros = proposition.clientsTropGros || [];
  const totalProposes = tournees.reduce((s, t) => s + (t.totalVelos || 0), 0);

  return (
    <div className="space-y-3">
      <div className="bg-purple-50 border border-purple-200 rounded-lg p-3">
        <div className="text-sm text-purple-900 font-medium mb-1">{proposition.proposition?.resume || proposition.message || "Proposition Gemini"}</div>
        <div className="text-xs text-purple-700">
          {tournees.length} tournée{tournees.length > 1 ? "s" : ""} · {totalProposes} vélos proposés
          {proposition.capacite && (
            <> · capacité totale {proposition.capacite.capaciteTotaleVelos}v · {proposition.clientsCandidats} clients candidats</>
          )}
        </div>
      </div>

      {tropGros.length > 0 && (
        <div className="border border-orange-300 bg-orange-50 rounded-lg p-3">
          <div className="text-sm font-medium text-orange-900 mb-2">
            ⚠️ {tropGros.length} client{tropGros.length > 1 ? "s" : ""} trop gros pour la flotte du jour
          </div>
          <ul className="space-y-1">
            {tropGros.map((c, i) => (
              <li key={i} className="text-xs text-orange-800">
                · <span className="font-medium">{c.entreprise}</span> ({c.nbVelosRestants}v) — {c.raison}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(proposition.proposition?.warnings?.length ?? 0) > 0 && (
        <div className="border border-red-300 bg-red-50 rounded-lg p-3">
          <div className="text-sm font-medium text-red-900 mb-2">
            ⚠️ {proposition.proposition!.warnings!.length} avertissement{proposition.proposition!.warnings!.length > 1 ? "s" : ""} du sanitizer (Gemini a tenté de violer les règles, on a corrigé)
          </div>
          <ul className="space-y-1">
            {proposition.proposition!.warnings!.map((w, i) => (
              <li key={i} className="text-xs text-red-800">· {w}</li>
            ))}
          </ul>
          <div className="text-[11px] text-red-600 mt-2 italic">
            Si une tournée manque, relance la proposition (Gemini est non-déterministe).
          </div>
        </div>
      )}

      {tournees.map((t, i) => {
        const nameById = new Map<string, string>([...equipe.map((m) => [m.id, m.nom] as const)]);
        const chauffeurNom = t.chauffeurId ? nameById.get(t.chauffeurId) || t.chauffeurId : null;
        const chefNoms = (t.chefEquipeIds || []).map((id) => nameById.get(id) || id);
        const monteurNoms = (t.monteurIds || []).map((id) => nameById.get(id) || id);
        const dureeStr = t.dureeMinutesEstimee
          ? `${Math.floor(t.dureeMinutesEstimee / 60)}h${String(t.dureeMinutesEstimee % 60).padStart(2, "0")}`
          : null;
        return (
          <div key={i} className="border rounded-lg p-3">
            <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
              <div className="font-medium text-sm">
                🚚 {t.camionNom}
                {t.ordreCamion ? <span className="ml-1 text-xs px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded">T{t.ordreCamion}</span> : null}
                <span className="text-gray-500"> — {t.totalVelos} vélos · {t.arrets.length} arrêt{t.arrets.length > 1 ? "s" : ""}{dureeStr ? ` · ~${dureeStr}` : ""}</span>
              </div>
            </div>
            {(chauffeurNom || chefNoms.length > 0 || monteurNoms.length > 0) && (
              <div className="text-[11px] text-gray-600 mb-2 flex flex-wrap gap-x-3 gap-y-1">
                {chauffeurNom && <span>🚚 <span className="font-medium">{chauffeurNom}</span></span>}
                {chefNoms.length > 0 && <span>👷 {chefNoms.join(", ")}</span>}
                {monteurNoms.length > 0 && <span>🔧 {monteurNoms.join(", ")} ({monteurNoms.length})</span>}
              </div>
            )}
            {t.motifGlobal && <div className="text-xs text-gray-600 italic mb-2">{t.motifGlobal}</div>}
            <ol className="space-y-1">
              {t.arrets.map((a, j) => (
                <li key={j} className="text-xs flex items-center gap-2 px-2 py-1 bg-gray-50 rounded">
                  <span className="font-mono w-5 text-gray-400">{j + 1}.</span>
                  <span className="flex-1 truncate">{a.entreprise}</span>
                  <span className="text-blue-700 font-medium whitespace-nowrap">{a.nbVelos}v</span>
                  {a.distanceKmDepot != null && (
                    <span className="text-gray-400 whitespace-nowrap">{a.distanceKmDepot}km</span>
                  )}
                </li>
              ))}
            </ol>
          </div>
        );
      })}

      {nonAffectes.length > 0 && (
        <div className="border border-amber-200 bg-amber-50 rounded-lg p-3">
          <div className="text-sm font-medium text-amber-900 mb-2">
            {nonAffectes.length} client{nonAffectes.length > 1 ? "s" : ""} non affecté{nonAffectes.length > 1 ? "s" : ""}
          </div>
          <ul className="space-y-1">
            {nonAffectes.map((c, i) => (
              <li key={i} className="text-xs text-amber-800">
                · <span className="font-medium">{c.entreprise}</span> ({c.nbVelos}v) — {c.raison}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button
          onClick={onApply}
          disabled={applying || tournees.length === 0}
          className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
        >
          {applying ? "Création…" : `✓ Créer ces ${tournees.length} tournée${tournees.length > 1 ? "s" : ""}`}
        </button>
      </div>
    </div>
  );
}
