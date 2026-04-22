"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const nav = [
  { href: "/", label: "Tableau de bord", icon: "📊" },
  { href: "/clients", label: "Clients", icon: "🏢" },
  { href: "/livraisons", label: "Livraisons", icon: "🚚" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed left-0 top-0 h-full w-64 bg-gray-900 text-white flex flex-col">
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
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm transition-colors ${
                active
                  ? "bg-green-600 text-white"
                  : "text-gray-300 hover:bg-gray-800"
              }`}
            >
              <span>{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="p-4 border-t border-gray-700 text-xs text-gray-500">
        velos-cargo@artisansverts.energy
      </div>
    </aside>
  );
}
