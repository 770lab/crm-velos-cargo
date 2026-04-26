"use client";

import { useEffect, useMemo, useState } from "react";
import { gasGet } from "@/lib/gas";
import { setCurrentUser, getCurrentUser, type CurrentUser } from "@/lib/current-user";
import type { EquipeMember, EquipeRole } from "@/lib/data-context";

const ROLE_LABEL: Record<EquipeRole, string> = {
  admin: "Admin",
  chauffeur: "Chauffeurs",
  chef: "Chefs d'équipe",
  monteur: "Monteurs",
  preparateur: "Préparateurs",
  apporteur: "Apporteurs d'affaires",
};
const ROLE_ICON: Record<EquipeRole, string> = {
  admin: "🛡️",
  chauffeur: "🚚",
  chef: "👷",
  monteur: "🔧",
  preparateur: "📦",
  apporteur: "🤝",
};
const ORDER: EquipeRole[] = ["admin", "preparateur", "chauffeur", "chef", "monteur", "apporteur"];

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null | undefined>(undefined);
  const [members, setMembers] = useState<EquipeMember[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    setUser(getCurrentUser());
  }, []);

  useEffect(() => {
    if (user !== null) return;
    let alive = true;
    gasGet("listEquipe")
      .then((r) => {
        if (!alive) return;
        const items = (r as { items?: EquipeMember[] }).items || [];
        setMembers(items.filter((m) => m.actif !== false));
      })
      .catch((e) => alive && setLoadError(String(e)));
    return () => { alive = false; };
  }, [user]);

  const grouped = useMemo(() => {
    if (!members) return null;
    const q = search.trim().toLowerCase();
    const map: Record<EquipeRole, EquipeMember[]> = { admin: [], chauffeur: [], chef: [], monteur: [], preparateur: [], apporteur: [] };
    for (const m of members) {
      if (q && !m.nom.toLowerCase().includes(q)) continue;
      if (map[m.role]) map[m.role].push(m);
    }
    return map;
  }, [members, search]);

  if (user === undefined) return null;
  if (user) return <>{children}</>;

  const pickUser = (m: EquipeMember) => {
    setCurrentUser({ id: m.id, nom: m.nom, role: m.role });
    setUser({ id: m.id, nom: m.nom, role: m.role });
  };

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col items-center justify-start p-4 py-10">
      <div className="w-full max-w-3xl">
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-green-600 mb-3">
            <span className="text-3xl">🚲</span>
          </div>
          <h1 className="text-2xl font-bold text-white">Vélos Cargo</h1>
          <p className="text-gray-400 text-sm mt-1">Choisis ton nom pour te connecter</p>
        </div>

        <input
          autoFocus
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Rechercher ton nom…"
          className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-green-500 mb-6"
        />

        {loadError && (
          <div className="bg-red-900/30 border border-red-700 text-red-300 text-sm rounded p-3 mb-4">
            Erreur de chargement de l&apos;équipe : {loadError}
          </div>
        )}

        {!grouped && !loadError && (
          <div className="text-center text-gray-500 text-sm py-10">Chargement…</div>
        )}

        {grouped && ORDER.map((role) => {
          const list = grouped[role];
          if (!list || list.length === 0) return null;
          return (
            <div key={role} className="mb-5">
              <div className="text-xs uppercase tracking-wider text-gray-400 mb-2 flex items-center gap-2">
                <span>{ROLE_ICON[role]}</span>
                <span>{ROLE_LABEL[role]}</span>
                <span className="text-gray-600">({list.length})</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                {list.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => pickUser(m)}
                    className="bg-gray-800 hover:bg-green-700 border border-gray-700 hover:border-green-500 text-white text-sm font-medium py-3 px-3 rounded-xl transition-colors text-left truncate"
                  >
                    {m.nom}
                  </button>
                ))}
              </div>
            </div>
          );
        })}

        {grouped && Object.values(grouped).every((l) => l.length === 0) && search && (
          <div className="text-center text-gray-500 text-sm py-6">Aucun membre ne correspond à « {search} ».</div>
        )}

        <p className="text-center text-gray-600 text-xs mt-8">
          Tu n&apos;es pas dans la liste ? Demande à l&apos;admin de te créer un accès dans /equipe.
        </p>
      </div>
    </div>
  );
}
