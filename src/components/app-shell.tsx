"use client";

import { AuthGate } from "./auth-gate";
import { Sidebar } from "./sidebar";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <Sidebar />
      <main className="flex-1 ml-64 p-8">{children}</main>
    </AuthGate>
  );
}
