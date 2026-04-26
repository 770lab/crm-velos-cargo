"use client";

import { AuthGate } from "./auth-gate";
import { Sidebar } from "./sidebar";
import { DataProvider } from "@/lib/data-context";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <DataProvider>
        <Sidebar />
        {/* min-w-0 + overflow-x-hidden : indispensable sur mobile, sinon un
            descendant trop large (table, grid 7 colonnes, card avec texte
            non-wrappable) force le flex-1 à dépasser la viewport et fait
            déborder tout le contenu (titre coupé à gauche, etc). */}
        <main className="flex-1 min-w-0 overflow-x-hidden p-4 pt-16 lg:pt-8 lg:ml-64 lg:p-8">{children}</main>
      </DataProvider>
    </AuthGate>
  );
}
