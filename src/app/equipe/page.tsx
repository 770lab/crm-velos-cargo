"use client";

import { useMemo, useState } from "react";
import { gasPost, gasGet } from "@/lib/gas";
import { useData, type EquipeMember, type EquipeRole } from "@/lib/data-context";

const ROLE_LABEL: Record<EquipeRole, string> = {
  chauffeur: "Chauffeur",
  chef: "Chef d'équipe",
  monteur: "Monteur",
};

const ROLE_ICON: Record<EquipeRole, string> = {
  chauffeur: "🚚",
  chef: "👷",
  monteur: "🔧",
};

const ROLE_COLOR: Record<EquipeRole, string> = {
  chauffeur: "bg-blue-100 text-blue-800 border-blue-200",
  chef: "bg-purple-100 text-purple-800 border-purple-200",
  monteur: "bg-emerald-100 text-emerald-800 border-emerald-200",
};

export default function EquipePage() {
  const { equipe, refresh } = useData();
  const [editing, setEditing] = useState<EquipeMember | null>(null);
  const [creatingRole, setCreatingRole] = useState<EquipeRole | null>(null);
  const [showInactifs, setShowInactifs] = useState(false);
  const [inactifs, setInactifs] = useState<EquipeMember[]>([]);
  const [loadingInactifs, setLoadingInactifs] = useState(false);

  const byRole = useMemo(() => {
    const groups: Record<EquipeRole, EquipeMember[]> = { chauffeur: [], chef: [], monteur: [] };
    for (const m of equipe) {
      if (m.actif === false) continue;
      if (groups[m.role]) groups[m.role].push(m);
    }
    return groups;
  }, [equipe]);

  const loadInactifs = async () => {
    setLoadingInactifs(true);
    try {
      const r = await gasGet("listEquipe", { includeInactifs: "true" });
      const items = (r as { items?: EquipeMember[] }).items || [];
      setInactifs(items.filter((m) => m.actif === false));
      setShowInactifs(true);
    } finally {
      setLoadingInactifs(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Équipe</h1>
        <p className="text-sm text-gray-500 mt-1">
          Chauffeurs, chefs d&apos;équipe et monteurs affectables aux tournées.
        </p>
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        {(Object.keys(ROLE_LABEL) as EquipeRole[]).map((role) => (
          <div key={role} className="bg-white border rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold flex items-center gap-2">
                <span>{ROLE_ICON[role]}</span>
                <span>{ROLE_LABEL[role]}s</span>
                <span className="text-xs text-gray-400">({byRole[role].length})</span>
              </h2>
              <button
                onClick={() => setCreatingRole(role)}
                className="text-xs px-2 py-1 bg-green-600 text-white rounded-lg hover:bg-green-700"
              >
                + Ajouter
              </button>
            </div>
            <div className="space-y-2">
              {byRole[role].length === 0 ? (
                <div className="text-xs text-gray-400 italic text-center py-4">Aucun membre</div>
              ) : (
                byRole[role].map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setEditing(m)}
                    className="w-full text-left border rounded-lg px-3 py-2 hover:bg-gray-50 transition-colors"
                  >
                    <div className="font-medium text-sm">{m.nom}</div>
                    <div className="text-xs text-gray-500 flex gap-2 mt-0.5">
                      {m.telephone && <span>📞 {m.telephone}</span>}
                      {m.email && <span className="truncate">{m.email}</span>}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6">
        {!showInactifs ? (
          <button
            onClick={loadInactifs}
            disabled={loadingInactifs}
            className="text-xs text-gray-500 hover:text-gray-800 underline"
          >
            {loadingInactifs ? "..." : "Afficher les membres archivés"}
          </button>
        ) : (
          <div className="bg-gray-50 border rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-sm text-gray-700">Archivés ({inactifs.length})</h3>
              <button onClick={() => setShowInactifs(false)} className="text-xs text-gray-500 hover:text-gray-800">
                Masquer
              </button>
            </div>
            {inactifs.length === 0 ? (
              <div className="text-xs text-gray-400 italic text-center py-2">Aucun archivé</div>
            ) : (
              <ul className="space-y-1 text-sm">
                {inactifs.map((m) => (
                  <li key={m.id} className="flex justify-between gap-2">
                    <button
                      onClick={() => setEditing(m)}
                      className="text-left hover:underline truncate flex-1"
                    >
                      {m.nom}
                    </button>
                    <span className={`text-[10px] uppercase font-semibold px-2 py-0.5 rounded ${ROLE_COLOR[m.role]}`}>
                      {ROLE_LABEL[m.role]}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {(editing || creatingRole) && (
        <MembreModal
          member={editing}
          creatingRole={creatingRole}
          onClose={() => {
            setEditing(null);
            setCreatingRole(null);
          }}
          onSaved={async () => {
            setEditing(null);
            setCreatingRole(null);
            await refresh("equipe");
            if (showInactifs) await loadInactifs();
          }}
        />
      )}
    </div>
  );
}

function MembreModal({
  member,
  creatingRole,
  onClose,
  onSaved,
}: {
  member: EquipeMember | null;
  creatingRole: EquipeRole | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [nom, setNom] = useState(member?.nom || "");
  const [role, setRole] = useState<EquipeRole>(member?.role || creatingRole || "monteur");
  const [telephone, setTelephone] = useState(member?.telephone || "");
  const [email, setEmail] = useState(member?.email || "");
  const [notes, setNotes] = useState(member?.notes || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isEdit = !!member;
  const isArchived = member?.actif === false;

  const save = async () => {
    if (!nom.trim()) {
      setError("Nom requis");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        id: member?.id,
        nom: nom.trim(),
        role,
        telephone: telephone.trim() || null,
        email: email.trim() || null,
        notes: notes.trim() || null,
      };
      if (isArchived) payload.actif = true;
      const r = await gasPost("upsertMembre", payload);
      if ((r as { error?: string }).error) throw new Error((r as { error?: string }).error);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const archive = async () => {
    if (!member?.id) return;
    if (!confirm(`Archiver ${member.nom} ? Il ne sera plus affectable aux nouvelles tournées.`)) return;
    setLoading(true);
    setError(null);
    try {
      const r = await gasGet("archiveMembre", { id: member.id });
      if ((r as { error?: string }).error) throw new Error((r as { error?: string }).error);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div className="bg-white rounded-xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-4">
          <h2 className="text-lg font-semibold">
            {isEdit ? (isArchived ? "Réactiver " : "Modifier ") + member!.nom : "Nouveau membre"}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">
            ×
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Nom complet</label>
            <input
              value={nom}
              onChange={(e) => setNom(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Rôle</label>
            <div className="flex gap-2">
              {(Object.keys(ROLE_LABEL) as EquipeRole[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRole(r)}
                  className={`flex-1 px-3 py-2 text-sm rounded-lg border transition-colors ${
                    role === r
                      ? "bg-green-600 text-white border-green-600"
                      : "border-gray-300 text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  {ROLE_ICON[r]} {ROLE_LABEL[r]}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Téléphone</label>
              <input
                value={telephone}
                onChange={(e) => setTelephone(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm"
                placeholder="06..."
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Email</label>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm"
                placeholder="@..."
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Notes (optionnel)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border rounded-lg text-sm resize-none"
              placeholder="Ex : permis C, disponible seulement mardi/jeudi…"
            />
          </div>
        </div>

        {error && <div className="mt-3 text-xs text-red-600 bg-red-50 rounded-lg p-2">{error}</div>}

        <div className="flex justify-between items-center gap-2 mt-5">
          {isEdit && !isArchived && (
            <button
              onClick={archive}
              disabled={loading}
              className="text-xs text-red-600 hover:text-red-800 disabled:opacity-50"
            >
              Archiver
            </button>
          )}
          <div className="ml-auto flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800"
            >
              Annuler
            </button>
            <button
              onClick={save}
              disabled={loading || !nom.trim()}
              className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 disabled:opacity-50"
            >
              {loading ? "..." : isArchived ? "Réactiver" : isEdit ? "Enregistrer" : "Créer"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
