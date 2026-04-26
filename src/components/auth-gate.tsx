"use client";

import { useEffect, useState } from "react";
import { gasPost } from "@/lib/gas";
import { setCurrentUser, getCurrentUser, type CurrentUser } from "@/lib/current-user";
import type { EquipeRole } from "@/lib/data-context";

type LoginResp =
  | { ok: true; member: { id: string; nom: string; role: EquipeRole }; hasCode: boolean }
  | { ok?: false; error: string; needsCode?: boolean };

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null | undefined>(undefined);
  const [identifiant, setIdentifiant] = useState("");
  const [motDePasse, setMotDePasse] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setUser(getCurrentUser());
  }, []);

  if (user === undefined) return null;
  if (user) return <>{children}</>;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifiant.trim()) {
      setError("Entre ton identifiant");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = (await gasPost("loginEquipe", {
        nom: identifiant.trim(),
        pin: motDePasse,
      })) as LoginResp;
      if (r.ok) {
        setCurrentUser({ id: r.member.id, nom: r.member.nom, role: r.member.role });
        setUser({ id: r.member.id, nom: r.member.nom, role: r.member.role });
        return;
      }
      if (r.needsCode) {
        setError(motDePasse ? "Mot de passe incorrect" : "Mot de passe requis pour ce compte");
      } else {
        setError(r.error || "Identifiant inconnu");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-green-600 mb-3">
            <span className="text-3xl">🚲</span>
          </div>
          <h1 className="text-2xl font-bold text-white">Vélos Cargo</h1>
          <p className="text-gray-400 text-sm mt-1">Connecte-toi pour continuer</p>
        </div>

        <form onSubmit={submit} className="bg-gray-800 rounded-2xl p-6 shadow-xl space-y-4">
          <div>
            <label htmlFor="identifiant" className="block text-xs text-gray-400 mb-1">
              Identifiant
            </label>
            <input
              id="identifiant"
              type="text"
              autoComplete="username"
              autoFocus
              value={identifiant}
              onChange={(e) => setIdentifiant(e.target.value)}
              placeholder="ex : yoann"
              className="w-full px-3 py-2.5 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-green-500"
            />
          </div>

          <div>
            <label htmlFor="motdepasse" className="block text-xs text-gray-400 mb-1">
              Mot de passe
            </label>
            <input
              id="motdepasse"
              type="password"
              inputMode="numeric"
              pattern="\d{4}"
              maxLength={4}
              autoComplete="current-password"
              value={motDePasse}
              onChange={(e) => setMotDePasse(e.target.value.replace(/\D/g, "").slice(0, 4))}
              placeholder="••••"
              className="w-full px-3 py-2.5 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-500 tracking-[0.4em] focus:outline-none focus:border-green-500"
            />
            <p className="text-[10px] text-gray-500 mt-1">
              4 chiffres communiqués par l&apos;admin.
            </p>
          </div>

          {error && (
            <div className="bg-red-900/30 border border-red-700 text-red-300 text-sm rounded-lg p-2.5">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy || !identifiant.trim()}
            className="w-full py-2.5 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold rounded-lg"
          >
            {busy ? "Connexion…" : "Se connecter"}
          </button>
        </form>

        <p className="text-center text-gray-600 text-xs mt-6">
          Pas de compte ? Demande à l&apos;admin de te créer un accès.
        </p>
      </div>
    </div>
  );
}
