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
const ALLOWED: Record<EquipeRole, string[]> = {
  superadmin: ["/"],
  admin: ["/"],
  preparateur: ["/livraisons", "/preparation", "/tournee-execute"],
  chef: ["/livraisons", "/clients", "/equipe", "/preparation", "/chargement", "/livraison", "/montage", "/tournee-execute"],
  chauffeur: ["/livraisons", "/chargement", "/livraison", "/tournee-execute"],
  monteur: ["/livraisons", "/montage", "/tournee-execute"],
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

function isAllowed(role: EquipeRole, path: string): boolean {
  const list = ALLOWED[role];
  if (list[0] === "/") return true; // wildcard pour admin/superadmin
  return list.some((p) => path === p || path.startsWith(p + "/") || path.startsWith(p + "?"));
}

export function RoleGuard({ children }: { children: React.ReactNode }) {
  const user = useCurrentUser();
  const pathname = usePathname() || "/";
  const router = useRouter();

  useEffect(() => {
    if (!user) return;
    if (!isAllowed(user.role, pathname)) {
      router.replace(FALLBACK[user.role]);
    }
  }, [user, pathname, router]);

  return <>{children}</>;
}
