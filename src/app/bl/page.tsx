"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { gasGet } from "@/lib/gas";

type Velo = { veloId: string; fnuci: string | null };
type Client = {
  clientId: string;
  entreprise: string;
  ville: string;
  adresse: string;
  codePostal: string;
  telephone: string | null;
  contact: string | null;
  velos: Velo[];
};
type Progression =
  | { tourneeId: string; datePrevue: string | null; clients: Client[] }
  | { error: string };

export default function BlPageWrapper() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-gray-500">Chargement…</div>}>
      <BlPage />
    </Suspense>
  );
}

function BlPage() {
  const sp = useSearchParams();
  const tourneeId = sp.get("tourneeId") || "";
  const focusClientId = sp.get("clientId") || "";
  const [data, setData] = useState<Progression | null>(null);

  useEffect(() => {
    if (!tourneeId) return;
    gasGet("getTourneeProgression", { tourneeId }).then(setData);
  }, [tourneeId]);

  if (!tourneeId) return <div className="p-6 text-red-600">Paramètre tourneeId manquant.</div>;
  if (!data) return <div className="p-6 text-sm text-gray-500">Chargement…</div>;
  if ("error" in data) return <div className="p-6 text-red-600">{data.error}</div>;

  const clients = focusClientId ? data.clients.filter((c) => c.clientId === focusClientId) : data.clients;
  const dateStr = data.datePrevue ? new Date(data.datePrevue).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "";

  return (
    <>
      <style>{`
        @page { size: A4; margin: 1.5cm 1.8cm; }
        @media print {
          .no-print { display: none !important; }
          body { background: white !important; }
          .bl-page { page-break-after: always; }
          .bl-page:last-child { page-break-after: auto; }
        }
        .bl-page {
          width: 100%;
          background: white;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          color: #111;
          padding: 1cm 0;
          page-break-after: always;
        }
        .bl-page h1 { font-size: 18px; margin: 0; }
        .bl-page h2 { font-size: 14px; margin: 0.6cm 0 0.2cm; }
        .bl-page table { width: 100%; border-collapse: collapse; font-size: 11px; }
        .bl-page th, .bl-page td { border-bottom: 1px solid #ccc; padding: 6px 8px; text-align: left; }
        .bl-page th { background: #f5f5f5; font-weight: 600; }
      `}</style>

      <div className="no-print fixed top-0 left-0 right-0 bg-white border-b shadow-sm z-50 px-4 py-2 flex items-center justify-between">
        <div className="text-sm">
          <span className="font-bold">📄 Bons de livraison</span>
          <span className="text-gray-500 ml-2">Tournée {tourneeId} · {clients.length} client{clients.length > 1 ? "s" : ""}{focusClientId ? " (focus)" : ""}</span>
        </div>
        <button onClick={() => window.print()} className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">
          🖨️ Imprimer
        </button>
      </div>

      <div className="no-print h-12" />

      <div className="max-w-3xl mx-auto p-6 print:p-0 print:max-w-none">
        {clients.map((c) => (
          <div key={c.clientId} className="bl-page">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", borderBottom: "2px solid #111", paddingBottom: "0.4cm" }}>
              <div>
                <h1>BON DE LIVRAISON</h1>
                <div style={{ fontSize: "11px", color: "#555", marginTop: "0.1cm" }}>
                  Tournée {tourneeId} · {dateStr}
                </div>
              </div>
              <div style={{ fontSize: "11px", textAlign: "right", lineHeight: 1.3 }}>
                <div style={{ fontWeight: 700 }}>Vélos Cargo</div>
                <div style={{ color: "#555" }}>Artisans Verts Energy</div>
                <div style={{ color: "#555" }}>Le Blanc-Mesnil</div>
              </div>
            </div>

            <h2>Livré à</h2>
            <div style={{ fontSize: "12px", lineHeight: 1.4 }}>
              <div style={{ fontWeight: 700 }}>{c.entreprise}</div>
              <div>{c.adresse}</div>
              <div>{c.codePostal} {c.ville}</div>
              {c.contact && <div style={{ marginTop: "0.15cm" }}>Contact : {c.contact}</div>}
              {c.telephone && <div>Tél : {c.telephone}</div>}
            </div>

            <h2>Vélos livrés ({c.velos.length})</h2>
            <table>
              <thead>
                <tr>
                  <th style={{ width: "8%" }}>N°</th>
                  <th>FNUCI</th>
                  <th>ID interne</th>
                </tr>
              </thead>
              <tbody>
                {c.velos.map((v, i) => (
                  <tr key={v.veloId}>
                    <td>{i + 1}</td>
                    <td style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>{v.fnuci || "—"}</td>
                    <td style={{ fontFamily: "ui-monospace, Menlo, monospace", color: "#777", fontSize: "10px" }}>{v.veloId}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ marginTop: "1.2cm", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1cm" }}>
              <div>
                <div style={{ fontSize: "11px", fontWeight: 600, marginBottom: "1.5cm" }}>Signature livreur</div>
                <div style={{ borderTop: "1px solid #999", paddingTop: "0.15cm", fontSize: "10px", color: "#777" }}>Date / Nom</div>
              </div>
              <div>
                <div style={{ fontSize: "11px", fontWeight: 600, marginBottom: "1.5cm" }}>Signature client (bon pour réception)</div>
                <div style={{ borderTop: "1px solid #999", paddingTop: "0.15cm", fontSize: "10px", color: "#777" }}>Date / Nom / Cachet</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
