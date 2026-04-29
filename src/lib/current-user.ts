"use client";
import { useEffect, useState } from "react";
import type { EquipeRole } from "./data-context";

const KEY = "crm-velos-current-user";

export type CurrentUser = {
  id: string;
  nom: string;
  role: EquipeRole;
  /** Flag chef d'équipe monteur : un monteur (role="monteur") avec ce flag
   *  voit TOUTES les livraisons où des monteurs sont affectés (pas seulement
   *  les siennes). Utilisé pour ricky qui pilote les autres monteurs. */
  estChefMonteur?: boolean;
};

export function getCurrentUser(): CurrentUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as CurrentUser) : null;
  } catch {
    return null;
  }
}

export function setCurrentUser(u: CurrentUser) {
  if (typeof window === "undefined") return;
  localStorage.setItem(KEY, JSON.stringify(u));
  window.dispatchEvent(new Event("crm-velos-user-changed"));
}

export function clearCurrentUser() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(KEY);
  // Conserve l'ancienne clé d'auth pour ne pas casser, mais elle n'est plus lue.
  localStorage.removeItem("crm-velos-auth");
  window.dispatchEvent(new Event("crm-velos-user-changed"));
}

export function useCurrentUser(): CurrentUser | null {
  const [user, setUser] = useState<CurrentUser | null>(null);
  useEffect(() => {
    setUser(getCurrentUser());
    const onChange = () => setUser(getCurrentUser());
    window.addEventListener("crm-velos-user-changed", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("crm-velos-user-changed", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);
  return user;
}
