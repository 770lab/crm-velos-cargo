"use client";

import { useMemo, useState } from "react";
import { gasPost, gasGet } from "@/lib/gas";
import { useData, type EquipeMember, type EquipeRole } from "@/lib/data-context";
import { useCurrentUser } from "@/lib/current-user";

const ROLE_LABEL: Record<EquipeRole, string> = {
  superadmin: "Super admin",
  admin: "Admin",
  chauffeur: "Chauffeur",
  chef: "Chef d'équipe",
  monteur: "Monteur",
  preparateur: "Préparateur",
  apporteur: "Apporteur d'affaires",
};

const ROLE_ICON: Record<EquipeRole, string> = {
  superadmin: "👑",
  admin: "🛡️",
  chauffeur: "🚚",
  chef: "👷",
  monteur: "🔧",
  preparateur: "📦",
  apporteur: "🤝",
};

const ROLE_COLOR: Record<EquipeRole, string> = {
  superadmin: "bg-yellow-100 text-yellow-800 border-yellow-200",
  admin: "bg-red-100 text-red-800 border-red-200",
  chauffeur: "bg-blue-100 text-blue-800 border-blue-200",
  chef: "bg-purple-100 text-purple-800 border-purple-200",
  monteur: "bg-emerald-100 text-emerald-800 border-emerald-200",
  preparateur: "bg-orange-100 text-orange-800 border-orange-200",
  apporteur: "bg-amber-100 text-amber-800 border-amber-200",
};

export default function EquipePage() {
  const { equipe, refresh } = useData();
  const currentUser = useCurrentUser();
  const isAdmin = currentUser?.role === "admin" || currentUser?.role === "superadmin";
  const [editing, setEditing] = useState<EquipeMember | null>(null);
  const [creatingRole, setCreatingRole] = useState<EquipeRole | null>(null);
  const [showInactifs, setShowInactifs] = useState(false);
  const [inactifs, setInactifs] = useState<EquipeMember[]>([]);
  const [loadingInactifs, setLoadingInactifs] = useState(false);

  const byRole = useMemo(() => {
    const groups: Record<EquipeRole, EquipeMember[]> = { superadmin: [], admin: [], chauffeur: [], chef: [], monteur: [], preparateur: [], apporteur: [] };
    for (const m of equipe) {
      if (m.actif === false) continue;
      // Vue restreinte non-admin : on ne voit QUE sa propre fiche (cf.
      // demande Yoann 2026-04-29 « ethan dois voir que ethan »).
      if (!isAdmin && m.id !== currentUser?.id) continue;
      if (groups[m.role]) groups[m.role].push(m);
    }
    // Tri alphabétique (insensible à la casse / aux accents) dans chaque
    // groupe — sinon l'ordre Firestore est arbitraire et difficile à suivre.
    const cmp = new Intl.Collator("fr", { sensitivity: "base", numeric: true }).compare;
    for (const role of Object.keys(groups) as EquipeRole[]) {
      groups[role].sort((a, b) => cmp(a.nom || "", b.nom || ""));
    }
    return groups;
  }, [equipe, isAdmin, currentUser?.id]);

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
          Chauffeurs, chefs d&apos;équipe, préparateurs et monteurs affectables aux tournées. Les apporteurs d&apos;affaires sont mis en CC des mails clients quand leur nom est renseigné sur la fiche.
        </p>
      </div>

      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
        {(Object.keys(ROLE_LABEL) as EquipeRole[])
          .filter((role) => isAdmin || byRole[role].length > 0)
          .map((role) => (
          <div key={role} className="bg-white border rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold flex items-center gap-2">
                <span>{ROLE_ICON[role]}</span>
                <span>{ROLE_LABEL[role]}s</span>
                <span className="text-xs text-gray-400">({byRole[role].length})</span>
              </h2>
              {isAdmin && (
                <button
                  onClick={() => setCreatingRole(role)}
                  className="text-xs px-2 py-1 bg-green-600 text-white rounded-lg hover:bg-green-700"
                >
                  + Ajouter
                </button>
              )}
            </div>
            <div className="space-y-2">
              {byRole[role].length === 0 ? (
                <div className="text-xs text-gray-400 italic text-center py-4">Aucun membre</div>
              ) : (
                byRole[role].map((m) => {
                  // Apporteurs : pas vocation à se connecter au CRM (juste mis en
                  // CC d'emails) → on ne signale pas l'absence de code pour eux.
                  // Pour les autres rôles, surligner en orange permet de voir d'un
                  // coup d'œil qui n'a pas encore de code et reste en "login libre".
                  const needsCode = role !== "apporteur";
                  const missingCode = needsCode && m.hasCode !== true;
                  return (
                    <button
                      key={m.id}
                      onClick={() => setEditing(m)}
                      className={`w-full text-left border rounded-lg px-3 py-2 transition-colors ${
                        missingCode
                          ? "bg-orange-50 border-orange-300 hover:bg-orange-100"
                          : "hover:bg-gray-50"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-medium text-sm">{m.nom}</div>
                        {missingCode ? (
                          <span
                            className="shrink-0 text-[10px] font-semibold text-orange-700 bg-orange-100 border border-orange-200 rounded px-1.5 py-0.5"
                            title="Aucun code d'accès défini — login libre"
                          >
                            🔓 Sans code
                          </span>
                        ) : m.hasCode === true ? (
                          <span className="shrink-0 text-[10px] text-green-700" title="Code d'accès défini">
                            🔒
                          </span>
                        ) : null}
                      </div>
                      <div className="text-xs text-gray-500 flex gap-2 mt-0.5">
                        {m.telephone && <span>📞 {m.telephone}</span>}
                        {m.email && <span className="truncate">{m.email}</span>}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6">
        {!isAdmin ? null : !showInactifs ? (
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
  const [nom, setNom] = useState(String(member?.nom || ""));
  const [role, setRole] = useState<EquipeRole>(member?.role || creatingRole || "monteur");
  const [telephone, setTelephone] = useState(String(member?.telephone ?? ""));
  const [email, setEmail] = useState(String(member?.email ?? ""));
  const [notes, setNotes] = useState(String(member?.notes ?? ""));
  // Champs financiers : EUR. Vide = non defini (traite comme 0 cote calcul).
  const [salaireJournalier, setSalaireJournalier] = useState(
    member?.salaireJournalier != null ? String(member.salaireJournalier) : "",
  );
  const [primeVelo, setPrimeVelo] = useState(
    member?.primeVelo != null ? String(member.primeVelo) : "",
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPinForm, setShowPinForm] = useState(false);
  const [pin, setPin] = useState("");
  const [pinBusy, setPinBusy] = useState(false);
  const [pinMsg, setPinMsg] = useState<string | null>(null);
  const [hasCode, setHasCode] = useState<boolean>(member?.hasCode === true);
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
      // Validation primeVelo : 0-5 EUR pour terrain, 10-50 EUR pour apporteur
      // (plus eleve car commission commerciale, pas de salaire journalier).
      // On bloque cote front pour afficher un message clair plutot que
      // l'erreur GAS generique.
      const sj = salaireJournalier.trim();
      const pv = primeVelo.trim();
      const maxPrime = role === "apporteur" ? 50 : 5;
      if (pv && (Number(pv) < 0 || Number(pv) > maxPrime || !isFinite(Number(pv)))) {
        setError(`Prime vélo : 0 à ${maxPrime} € maximum pour ${ROLE_LABEL[role].toLowerCase()}.`);
        setLoading(false);
        return;
      }
      if (sj && (Number(sj) < 0 || !isFinite(Number(sj)))) {
        setError("Salaire journalier : nombre positif (€/jour).");
        setLoading(false);
        return;
      }
      const payload: Record<string, unknown> = {
        id: member?.id,
        nom: nom.trim(),
        role,
        telephone: telephone.trim() || null,
        email: email.trim() || null,
        notes: notes.trim() || null,
        salaireJournalier: sj ? Number(sj) : null,
        primeVelo: pv ? Number(pv) : null,
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

  const savePin = async () => {
    if (!member?.id) return;
    if (!/^\d{4}$/.test(pin)) {
      setPinMsg("Code = 4 chiffres exactement");
      return;
    }
    setPinBusy(true);
    setPinMsg(null);
    try {
      const r = await gasPost("setMembreCode", { id: member.id, pin });
      if ((r as { error?: string }).error) throw new Error((r as { error?: string }).error);
      setPinMsg(`Code ${pin} enregistré. Communique-le à ${member.nom}.`);
      setHasCode(true);
      setPin("");
    } catch (e) {
      setPinMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setPinBusy(false);
    }
  };

  const clearPin = async () => {
    if (!member?.id) return;
    if (!confirm(`Supprimer le code de ${member.nom} ? Il pourra à nouveau se connecter sans code.`)) return;
    setPinBusy(true);
    setPinMsg(null);
    try {
      const r = await gasPost("clearMembreCode", { id: member.id });
      if ((r as { error?: string }).error) throw new Error((r as { error?: string }).error);
      setPinMsg("Code supprimé.");
      setHasCode(false);
      setPin("");
    } catch (e) {
      setPinMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setPinBusy(false);
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
            <div className="grid grid-cols-3 gap-2">
              {(Object.keys(ROLE_LABEL) as EquipeRole[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRole(r)}
                  className={`px-2 py-2 text-xs rounded-lg border transition-colors text-center leading-tight ${
                    role === r
                      ? "bg-green-600 text-white border-green-600"
                      : "border-gray-300 text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  <div className="text-base">{ROLE_ICON[r]}</div>
                  <div>{ROLE_LABEL[r]}</div>
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

          {/* Champs financiers : sert au calcul de la masse salariale dans la
              page Finances. Apporteur = commercial pur, paye uniquement a la
              prime/commission (pas de salaire journalier). Roles terrain :
              salaire/jour + prime modeste 0-5 EUR par velo. */}
          <div className="border-t pt-3 mt-1 space-y-3">
            <div className="text-xs font-semibold text-gray-700">💶 Rémunération</div>
            <div className={`grid ${role === "apporteur" ? "grid-cols-1" : "grid-cols-2"} gap-3`}>
              {role !== "apporteur" && (
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Salaire journalier (€/jour)</label>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step={1}
                    value={salaireJournalier}
                    onChange={(e) => setSalaireJournalier(e.target.value)}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                    placeholder="ex : 120"
                  />
                </div>
              )}
              <div>
                <label className="block text-xs text-gray-500 mb-1">
                  Prime vélo (€, {role === "apporteur" ? "10-50" : "0-5"})
                </label>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={role === "apporteur" ? 50 : 5}
                  step={role === "apporteur" ? 5 : 0.5}
                  value={primeVelo}
                  onChange={(e) => setPrimeVelo(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                  placeholder={role === "apporteur" ? "ex : 30" : "ex : 2"}
                />
              </div>
            </div>
            <p className="text-[11px] text-gray-400 leading-snug">
              {role === "apporteur"
                ? "Apporteur : prime de 10 à 50 €/vélo, calculée sur les vélos livrés des clients qu'il a apportés."
                : role === "monteur"
                ? "Prime monteur : split entre les monteurs de la tournée (si 2 monteurs sur 10 vélos, chacun touche prime × 5)."
                : "Tous les vélos de la tournée comptent pour la prime."}
            </p>
          </div>

          {isEdit && !isArchived && (
            <div className="border-t pt-3 mt-1">
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-gray-500">
                  Code d&apos;accès {hasCode ? <span className="text-green-700 font-semibold">🔒 défini</span> : <span className="text-orange-600">aucun (login libre)</span>}
                </label>
                {!showPinForm ? (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => { setShowPinForm(true); setPinMsg(null); setPin(""); }}
                      className="text-xs text-blue-600 hover:underline"
                    >
                      {hasCode ? "Changer" : "Définir"}
                    </button>
                    {hasCode && (
                      <button
                        type="button"
                        onClick={clearPin}
                        disabled={pinBusy}
                        className="text-xs text-red-600 hover:underline disabled:opacity-50"
                      >
                        Supprimer
                      </button>
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => { setShowPinForm(false); setPin(""); setPinMsg(null); }}
                    className="text-xs text-gray-500 hover:underline"
                  >
                    Annuler
                  </button>
                )}
              </div>
              {showPinForm && (
                <div className="flex gap-2">
                  <input
                    inputMode="numeric"
                    pattern="\d{4}"
                    maxLength={4}
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                    placeholder="••••"
                    className="flex-1 text-center text-xl tracking-[0.4em] font-mono px-3 py-2 border rounded-lg"
                  />
                  <button
                    type="button"
                    onClick={savePin}
                    disabled={pinBusy || pin.length !== 4}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
                  >
                    {pinBusy ? "..." : "Valider"}
                  </button>
                </div>
              )}
              {pinMsg && (
                <div className="mt-2 text-xs bg-blue-50 text-blue-800 rounded-lg p-2">{pinMsg}</div>
              )}
            </div>
          )}
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
