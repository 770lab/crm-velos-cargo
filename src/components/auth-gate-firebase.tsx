"use client";

import { useState } from "react";
import { FirebaseError } from "firebase/app";
import { signInWithPin, signInWithGoogle, signOut } from "@/lib/auth-firebase";
import { useFirebaseUser } from "@/lib/use-firebase-user";

function explainAuthError(err: unknown): string {
  if (err instanceof FirebaseError) {
    switch (err.code) {
      case "auth/invalid-credential":
      case "auth/wrong-password":
      case "auth/invalid-login-credentials":
        return "Identifiant ou mot de passe incorrect";
      case "auth/user-not-found":
        return "Compte inconnu";
      case "auth/too-many-requests":
        return "Trop de tentatives. Réessaie dans quelques minutes.";
      case "auth/network-request-failed":
        return "Pas de connexion réseau";
      case "auth/popup-closed-by-user":
      case "auth/cancelled-popup-request":
        return "Connexion annulée";
      default:
        return `Erreur : ${err.code}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

export function AuthGateFirebase({ children }: { children: React.ReactNode }) {
  const { loading, user, member, denyReason } = useFirebaseUser();
  const [identifiant, setIdentifiant] = useState("");
  const [motDePasse, setMotDePasse] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center text-gray-400 text-sm">
        Chargement…
      </div>
    );
  }

  if (user && member) {
    return <>{children}</>;
  }

  const submitPin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifiant.trim()) {
      setError("Entre ton identifiant");
      return;
    }
    if (motDePasse.length !== 4) {
      setError("Le PIN doit contenir 4 chiffres");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signInWithPin(identifiant, motDePasse);
    } catch (err) {
      setError(explainAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  const submitGoogle = async () => {
    setBusy(true);
    setError(null);
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(explainAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  // Authentifié mais refusé (pas dans equipe ou inactif)
  if (user && !member) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-gray-800 rounded-2xl p-6 shadow-xl space-y-4 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-red-600 mx-auto">
            <span className="text-3xl">🚫</span>
          </div>
          <h2 className="text-lg font-semibold text-white">Accès refusé</h2>
          <p className="text-gray-400 text-sm">
            {denyReason || "Ton compte n'est pas autorisé à accéder à ce CRM."}
          </p>
          <p className="text-gray-500 text-xs">
            Connecté en tant que <code>{user.email}</code>
          </p>
          <p className="text-amber-300 text-xs bg-amber-900/30 border border-amber-700/50 rounded-lg p-2 text-left">
            Si tu viens de purger ton cache, attends 5 sec et clique
            <strong> 🔄 Réessayer</strong>. Si ça insiste, c&apos;est que ton
            identifiant ne match pas un compte équipe : clique
            <strong> Se déconnecter</strong> et retape ton vrai email + PIN.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-lg"
          >
            🔄 Réessayer
          </button>
          <button
            onClick={async () => {
              await signOut();
              // Force un reload après signOut pour repartir d'un état propre :
              // sans ça, l'écran "Accès refusé" reste affiché parce que
              // useFirebaseUser ne re-render pas toujours assez vite (30-04 09h50).
              window.location.reload();
            }}
            className="w-full py-2.5 bg-gray-700 hover:bg-gray-600 text-white font-semibold rounded-lg"
          >
            Se déconnecter et retaper le PIN
          </button>
        </div>
      </div>
    );
  }

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

        <div className="bg-gray-800 rounded-2xl p-6 shadow-xl space-y-4">
          <button
            type="button"
            onClick={submitGoogle}
            disabled={busy}
            className="w-full py-2.5 bg-white hover:bg-gray-100 disabled:opacity-50 text-gray-900 font-semibold rounded-lg flex items-center justify-center gap-2"
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              />
            </svg>
            Continuer avec Google
          </button>

          <div className="flex items-center gap-3 text-xs text-gray-500">
            <span className="flex-1 h-px bg-gray-700" />
            ou avec un PIN
            <span className="flex-1 h-px bg-gray-700" />
          </div>

          <form onSubmit={submitPin} className="space-y-4">
            <div>
              <label htmlFor="identifiant" className="block text-xs text-gray-400 mb-1">
                Identifiant
              </label>
              <input
                id="identifiant"
                type="text"
                autoComplete="username"
                value={identifiant}
                onChange={(e) => setIdentifiant(e.target.value)}
                placeholder="ex : yoann"
                className="w-full px-3 py-2.5 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-green-500"
              />
            </div>

            <div>
              <label htmlFor="motdepasse" className="block text-xs text-gray-400 mb-1">
                Code PIN
              </label>
              <input
                id="motdepasse"
                type="password"
                inputMode="numeric"
                pattern="\d{4}"
                maxLength={4}
                autoComplete="current-password"
                value={motDePasse}
                onChange={(e) =>
                  setMotDePasse(e.target.value.replace(/\D/g, "").slice(0, 4))
                }
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
              disabled={busy || !identifiant.trim() || motDePasse.length !== 4}
              className="w-full py-2.5 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold rounded-lg"
            >
              {busy ? "Connexion…" : "Se connecter"}
            </button>
          </form>
        </div>

        <p className="text-center text-gray-600 text-xs mt-6">
          Pas de compte ? Demande à l&apos;admin de te créer un accès.
        </p>
      </div>
    </div>
  );
}
