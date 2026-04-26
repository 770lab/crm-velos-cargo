"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { gasGet } from "@/lib/gas";

type Velo = { veloId: string; fnuci: string | null };
type Client = { clientId: string; entreprise: string; ville: string; adresse: string; codePostal: string; velos: Velo[] };
type Progression =
  | { tourneeId: string; datePrevue: string | null; clients: Client[] }
  | { error: string };

const PER_PAGE = 6; // planche A4 — 2 colonnes × 3 rangées (~99 × 95 mm par étiquette)

export default function EtiquettesPageWrapper() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-gray-500">Chargement…</div>}>
      <EtiquettesPage />
    </Suspense>
  );
}

function EtiquettesPage() {
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
  const items: { client: Client; velo: Velo; index: number; total: number }[] = [];
  let total = 0;
  clients.forEach((c) => { total += c.velos.length; });
  let i = 0;
  clients.forEach((c) => {
    c.velos.forEach((v) => { i++; items.push({ client: c, velo: v, index: i, total }); });
  });

  const pages: typeof items[] = [];
  for (let p = 0; p < items.length; p += PER_PAGE) pages.push(items.slice(p, p + PER_PAGE));
  const dateStr = data.datePrevue ? new Date(data.datePrevue).toLocaleDateString("fr-FR") : "";

  return (
    <>
      <style>{`
        @page { size: A4; margin: 0; }
        @media print {
          .no-print { display: none !important; }
          body { background: white !important; }
          .sheet { page-break-after: always; }
          .sheet:last-child { page-break-after: auto; }
        }
        .sheet {
          width: 21cm; height: 29.7cm;
          padding: 0.7cm;
          box-sizing: border-box;
          background: white;
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          grid-template-rows: repeat(3, 1fr);
          gap: 0.4cm;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .label {
          border: 1px dashed #bbb;
          padding: 0.4cm;
          box-sizing: border-box;
          display: flex; flex-direction: column;
          color: #111;
          overflow: hidden;
        }
        @media print { .label { border-color: transparent; } }
      `}</style>

      <div className="no-print fixed top-0 left-0 right-0 bg-white border-b shadow-sm z-50 px-4 py-2 flex items-center justify-between">
        <div className="text-sm">
          <span className="font-bold">🏷️ Étiquettes</span>
          <span className="text-gray-500 ml-2">Tournée {tourneeId} · {total} étiquettes · {pages.length} planche{pages.length > 1 ? "s" : ""} A4 (6/feuille)</span>
        </div>
        <button onClick={() => window.print()} className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">
          🖨️ Imprimer
        </button>
      </div>

      <div className="no-print h-12" />

      <div className="bg-gray-100 print:bg-white py-4 print:py-0">
        {pages.map((pageItems, pi) => (
          <div key={pi} className="sheet mx-auto print:mx-0 my-3 print:my-0 shadow print:shadow-none">
            {pageItems.map(({ client, velo, index, total }) => {
              const fnuci = velo.fnuci || velo.veloId;
              const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(fnuci)}`;
              return (
                <div key={velo.veloId} className="label">
                  <div style={{ fontSize: "9px", color: "#666", display: "flex", justifyContent: "space-between" }}>
                    <span>Tournée {tourneeId}{dateStr ? " · " + dateStr : ""}</span>
                    <span>{index}/{total}</span>
                  </div>
                  <div style={{ display: "flex", gap: "0.35cm", marginTop: "0.2cm", flex: 1, minHeight: 0 }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={qrUrl} alt={fnuci} style={{ width: "3.2cm", height: "3.2cm", flexShrink: 0 }} />
                    <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", flex: 1, minWidth: 0 }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: "13px", lineHeight: 1.15, wordBreak: "break-word" }}>{client.entreprise}</div>
                        <div style={{ fontSize: "10px", color: "#444", lineHeight: 1.25, marginTop: "0.1cm" }}>
                          {client.adresse}<br />
                          {client.codePostal} {client.ville}
                        </div>
                      </div>
                      <div style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: "13px", fontWeight: 700, letterSpacing: "0.3px", marginTop: "0.15cm", wordBreak: "break-all" }}>
                        {fnuci}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
            {/* Cellules vides pour conserver la grille si la dernière page n'est pas pleine */}
            {pageItems.length < PER_PAGE && Array.from({ length: PER_PAGE - pageItems.length }).map((_, k) => (
              <div key={"empty-" + k} className="label" style={{ borderColor: "transparent" }} />
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
