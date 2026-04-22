"use client";

import { useState, useEffect } from "react";

const VALID_USER = "YOANN";
const VALID_PASS = "LUZZATO+770";
const AUTH_KEY = "crm-velos-auth";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    setAuthed(localStorage.getItem(AUTH_KEY) === "1");
  }, []);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (user.toUpperCase() === VALID_USER && pass === VALID_PASS) {
      localStorage.setItem(AUTH_KEY, "1");
      setAuthed(true);
    } else {
      setError(true);
      setTimeout(() => setError(false), 2000);
    }
  };

  if (authed === null) return null;

  if (authed) return <>{children}</>;

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-green-600 mb-4">
            <svg viewBox="0 0 64 40" fill="none" className="w-12 h-12 text-white">
              <circle cx="12" cy="30" r="9" stroke="currentColor" strokeWidth="2.5" />
              <circle cx="12" cy="30" r="2" fill="currentColor" />
              <circle cx="52" cy="30" r="9" stroke="currentColor" strokeWidth="2.5" />
              <circle cx="52" cy="30" r="2" fill="currentColor" />
              <path d="M12 30 L28 14 L42 14 L52 30" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M28 14 L24 30" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              <path d="M42 14 L46 8 L50 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M24 12 L32 12" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              <rect x="30" y="18" width="18" height="10" rx="2" stroke="currentColor" strokeWidth="2" fill="currentColor" fillOpacity="0.15" />
              <rect x="33" y="21" width="5" height="5" rx="1" fill="currentColor" fillOpacity="0.4" />
              <rect x="40" y="22" width="4" height="4" rx="1" fill="currentColor" fillOpacity="0.3" />
              <circle cx="20" cy="28" r="3" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white">Vélos Cargo</h1>
          <p className="text-gray-400 text-sm mt-1">Artisans Verts Energy</p>
        </div>

        <form onSubmit={handleLogin} className="bg-gray-800 rounded-2xl p-6 space-y-4 shadow-xl">
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">Identifiant</label>
            <input
              type="text"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500"
              placeholder="Nom d'utilisateur"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">Mot de passe</label>
            <input
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500"
              placeholder="Mot de passe"
            />
          </div>
          {error && (
            <p className="text-red-400 text-sm text-center">Identifiants incorrects</p>
          )}
          <button
            type="submit"
            className="w-full py-3 bg-green-600 hover:bg-green-700 text-white font-semibold rounded-xl transition-colors"
          >
            Se connecter
          </button>
        </form>

        <p className="text-center text-gray-600 text-xs mt-6">
          velos-cargo@artisansverts.energy
        </p>
      </div>
    </div>
  );
}
