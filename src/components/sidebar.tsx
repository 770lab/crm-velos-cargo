"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { gasGet } from "@/lib/gas";
import { clearCurrentUser, useCurrentUser } from "@/lib/current-user";
import type { EquipeRole } from "@/lib/data-context";

type NavItem = { href: string; label: string; icon: string; badge?: true };

// Pages accessibles par rôle. Admin voit tout. Les autres voient le strict utile.
const NAV_BY_ROLE: Record<EquipeRole, NavItem[]> = {
  admin: [
    { href: "/", label: "Tableau de bord", icon: "📊" },
    { href: "/clients", label: "Clients", icon: "🏢" },
    { href: "/carte", label: "Carte & Tournées", icon: "🗺️" },
    { href: "/livraisons", label: "Livraisons", icon: "🚚" },
    { href: "/equipe", label: "Équipe", icon: "👷" },
    { href: "/verifications", label: "À vérifier", icon: "🔎", badge: true },
  ],
  preparateur: [
    { href: "/livraisons", label: "Livraisons", icon: "🚚" },
    { href: "/clients", label: "Clients", icon: "🏢" },
  ],
  chef: [
    { href: "/livraisons", label: "Livraisons", icon: "🚚" },
    { href: "/clients", label: "Clients", icon: "🏢" },
    { href: "/equipe", label: "Équipe", icon: "👷" },
  ],
  chauffeur: [
    { href: "/livraisons", label: "Livraisons", icon: "🚚" },
  ],
  monteur: [
    { href: "/montage", label: "Montage", icon: "🔧" },
  ],
  apporteur: [
    { href: "/", label: "Accueil", icon: "🏠" },
  ],
};

const ROLE_LABEL: Record<EquipeRole, string> = {
  admin: "Admin",
  chauffeur: "Chauffeur",
  chef: "Chef d'équipe",
  monteur: "Monteur",
  preparateur: "Préparateur",
  apporteur: "Apporteur",
};

export function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState<number>(0);
  const user = useCurrentUser();

  useEffect(() => {
    if (user?.role !== "admin") return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await gasGet("countPendingVerifications");
        if (!cancelled && res && typeof (res as { count?: number }).count === "number") {
          setPendingCount((res as { count: number }).count);
        }
      } catch {
        // action pas encore déployée — on ignore silencieusement
      }
    };
    load();
    const interval = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pathname, user?.role]);

  const nav = useMemo(() => (user ? NAV_BY_ROLE[user.role] : []), [user]);

  const logout = () => {
    clearCurrentUser();
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed top-4 left-4 z-50 lg:hidden bg-gray-900 text-white p-2 rounded-lg"
      >
        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {open && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setOpen(false)}
        />
      )}

      <aside
        className={`fixed left-0 top-0 h-full w-64 bg-gray-900 text-white flex flex-col z-50 transition-transform lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="p-6 border-b border-gray-700">
          <h1 className="text-lg font-bold">Vélos Cargo</h1>
          <p className="text-xs text-gray-400 mt-1">Artisans Verts Energy</p>
        </div>
        <nav className="flex-1 p-4 space-y-1">
          {nav.map((item) => {
            const active =
              item.href === "/"
                ? pathname === "/"
                : pathname.startsWith(item.href);
            const showBadge = item.badge && pendingCount > 0;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm transition-colors ${
                  active
                    ? "bg-green-600 text-white"
                    : "text-gray-300 hover:bg-gray-800"
                }`}
              >
                <span>{item.icon}</span>
                <span className="flex-1">{item.label}</span>
                {showBadge && (
                  <span className="bg-red-600 text-white text-xs font-semibold min-w-[1.25rem] h-5 px-1.5 rounded-full inline-flex items-center justify-center">
                    {pendingCount > 99 ? "99+" : pendingCount}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        {user && (
          <div className="p-4 border-t border-gray-700">
            <div className="text-xs text-gray-500 mb-1">{ROLE_LABEL[user.role]}</div>
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium truncate">{user.nom}</div>
              <button
                onClick={logout}
                className="text-xs text-gray-400 hover:text-white px-2 py-1 rounded hover:bg-gray-800"
                title="Se déconnecter"
              >
                ⏻
              </button>
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
