"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useCurrentUser } from "@/lib/current-user";
import type { EquipeRole } from "@/lib/data-context";

// Routes accessibles par rôle (préfixes — un préfixe match toute sous-route).
// Doit rester en cohérence avec NAV_BY_ROLE de Sidebar. Les rôles terrain ne
// doivent pas pouvoir taper /clients ou /finances dans la barre d'URL et
// arriver sur la page (même si Firestore refuserait les reads, ça affiche
// l'erreur banner — UX dégradée).
// /etiquettes et /bl : tous les rôles terrain en ont besoin (préparateur
// imprime les étiquettes carton à la fin de la prep, chauffeur réimprime
// un BL en route si carton perdu, etc.). Bug 30-04 09h05 : preparateur
// (Naomi) bloqué sur /etiquettes → redirige vers /livraisons par RoleGuard.
const ALLOWED: Record<EquipeRole, string[]> = {
  superadmin: ["/"],
  admin: ["/"],
  preparateur: ["/livraisons", "/preparation", "/tournee-execute", "/etiquettes", "/bl"],
  // Yoann 2026-05-03 : chef d équipe = lecture seule planning + son équipe
  // + sa pointeuse (paiements de ses monteurs). Plus de /clients (pas son
  // métier), ajout de /finances pour la pointeuse.
  chef: ["/livraisons", "/equipe", "/finances", "/preparation", "/chargement", "/livraison", "/montage", "/tournee-execute", "/etiquettes", "/bl"],
  chauffeur: ["/livraisons", "/chargement", "/livraison", "/tournee-execute", "/etiquettes", "/bl"],
  // /finances est autorisé pour les monteurs : page elle-même filtre par
  // estChefMonteur (les monteurs simples voient le 403 amber).
  monteur: ["/livraisons", "/montage", "/tournee-execute", "/finances", "/etiquettes", "/bl"],
  apporteur: ["/", "/clients", "/livraisons"],
};

const FALLBACK: Record<EquipeRole, string> = {
  superadmin: "/",
  admin: "/",
  preparateur: "/livraisons",
  chef: "/livraisons",
  chauffeur: "/livraisons",
  monteur: "/montage",
  apporteur: "/",
};

function isAllowed(role: EquipeRole, path: string, chefDeMonteurs?: boolean): boolean {
  // Yoann 2026-05-03 : chef admin terrain (chefDeMonteurs !== true) =
  // wildcard comme admin. Seul le chef monteur (Ricky/Nordine) garde
  // les routes restreintes.
  if (role === "chef" && chefDeMonteurs !== true) return true;
  const list = ALLOWED[role];
  if (list[0] === "/") return true;
  return list.some((p) => path === p || path.startsWith(p + "/") || path.startsWith(p + "?"));
}

export function RoleGuard({ children }: { children: React.ReactNode }) {
  const user = useCurrentUser();
  const pathname = usePathname() || "/";
  const router = useRouter();

  useEffect(() => {
    if (!user) return;
    if (!isAllowed(user.role, pathname, user.chefDeMonteurs)) {
      router.replace(FALLBACK[user.role]);
    }
  }, [user, pathname, router]);

  return <>{children}</>;
}
