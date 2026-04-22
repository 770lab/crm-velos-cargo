"use client";

import { AuthGate } from "./auth-gate";
import { Sidebar } from "./sidebar";
import { DataProvider } from "@/lib/data-context";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <DataProvider>
        <Sidebar />
        <main className="flex-1 ml-64 p-8">{children}</main>
      </DataProvider>
    </AuthGate>
  );
}
