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

const LEGAL_BANNER =
  "LES ARTISANS VERTS - 6 Passage Eugène Barbier, 92400 Courbevoie - 01 87 66 27 08 - APE 4322B - TVA FR34878062793 - jonathan@artisansverts.energy - SAS au capital de 40 000€ - SIRET 87806279300038 - Assurance décennale MAAF Assurances n° 193068812 V - MCE - 001 valable du 01/01/2025 au 31/12/2025.";

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
  const dateLivraison = data.datePrevue ? new Date(data.datePrevue) : null;
  const dateStr = dateLivraison
    ? dateLivraison.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" })
    : "—";

  const blShortRef = (clientId: string) =>
    `BL-${tourneeId.slice(0, 8).toUpperCase()}-${clientId.slice(-4).toUpperCase()}`;

  return (
    <>
      <style>{`
        @page { size: A4; margin: 0; }
        @media print {
          .no-print { display: none !important; }
          body { background: white !important; margin: 0 !important; }
          .bl-sheet { box-shadow: none !important; margin: 0 !important; }
        }
        .bl-sheet {
          box-sizing: border-box;
          width: 21cm;
          min-height: 29.7cm;
          margin: 0.5cm auto;
          padding: 1.2cm 1.6cm 1.2cm 1.6cm;
          background: white;
          color: #111;
          font-family: Helvetica, Arial, sans-serif;
          font-size: 10pt;
          line-height: 1.35;
          page-break-after: always;
          position: relative;
          box-shadow: 0 2px 8px rgba(0,0,0,0.08);
        }
        .bl-sheet:last-child { page-break-after: auto; }
        .bl-banner {
          font-size: 7.2pt;
          color: #555;
          text-align: center;
          line-height: 1.4;
          padding: 0 0.4cm;
        }
        .bl-banner-bottom {
          position: absolute;
          left: 1.6cm;
          right: 1.6cm;
          bottom: 1cm;
        }
        .bl-logo {
          width: 80px;
          height: 80px;
        }
        .bl-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-top: 0.5cm;
          gap: 1cm;
        }
        .bl-title {
          font-size: 16pt;
          font-weight: 700;
          margin: 0 0 0.25cm 0;
          color: #111;
        }
        .bl-meta {
          font-size: 9pt;
          line-height: 1.5;
        }
        .bl-meta-label {
          color: #555;
        }
        .bl-meta b {
          color: #111;
        }
        .bl-client-name {
          font-size: 14pt;
          font-weight: 700;
          color: #111;
          margin-bottom: 0.1cm;
        }
        .bl-client-block {
          text-align: right;
          font-size: 9pt;
          line-height: 1.5;
          color: #333;
        }
        .bl-livraison {
          margin-top: 0.5cm;
          font-size: 9pt;
        }
        .bl-summary {
          margin-top: 0.4cm;
          margin-left: auto;
          width: 50%;
          font-size: 9pt;
        }
        .bl-summary-row {
          display: flex;
          justify-content: space-between;
          padding: 4px 0;
        }
        .bl-summary-row.total {
          border-top: 1px solid #111;
          margin-top: 4px;
          padding-top: 8px;
          font-weight: 700;
          font-size: 11pt;
        }
        .bl-detail-header {
          display: grid;
          grid-template-columns: 1fr 90px 90px 110px;
          gap: 0;
          background: #f5f5f5;
          padding: 8px 10px;
          font-size: 9pt;
          font-weight: 700;
          color: #111;
          border-top: 1px solid #ccc;
          border-bottom: 2px solid #111;
          margin-top: 0.6cm;
        }
        .bl-detail-row {
          display: grid;
          grid-template-columns: 1fr 90px 90px 110px;
          gap: 0;
          padding: 10px;
          font-size: 9pt;
          border-bottom: 1px solid #e5e5e5;
        }
        .bl-detail-row:last-child {
          border-bottom: 1px solid #ccc;
        }
        .bl-detail-name { font-weight: 600; }
        .bl-detail-spec {
          color: #555;
          font-size: 8.5pt;
          margin-top: 2px;
        }
        .bl-mono {
          font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
          font-size: 9pt;
        }
        .bl-foot {
          position: absolute;
          left: 1.6cm;
          right: 1.6cm;
          bottom: 1.6cm;
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 1cm;
          margin-top: 1cm;
        }
        .bl-sign {
          border: 1px solid #aaa;
          border-radius: 3px;
          padding: 10px 12px;
          font-size: 9pt;
        }
        .bl-sign-title {
          font-weight: 700;
          margin-bottom: 1.2cm;
        }
        .bl-sign-meta {
          color: #777;
          font-size: 8pt;
          line-height: 1.4;
        }
      `}</style>

      <div className="no-print fixed top-0 left-0 right-0 bg-white border-b shadow-sm z-50 px-4 py-2 flex items-center justify-between">
        <div className="text-sm">
          <span className="font-bold">📄 Bons de livraison</span>
          <span className="text-gray-500 ml-2">
            Tournée {tourneeId} · {clients.length} client{clients.length > 1 ? "s" : ""}
            {focusClientId ? " (focus)" : ""}
          </span>
        </div>
        <button
          onClick={() => window.print()}
          className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
        >
          🖨️ Imprimer
        </button>
      </div>

      <div className="no-print h-12" />

      {clients.map((c) => {
        const blRef = blShortRef(c.clientId);
        return (
          <div key={c.clientId} className="bl-sheet">
            {/* BANDEAU LÉGAL HAUT */}
            <div className="bl-banner">{LEGAL_BANNER}</div>

            {/* LOGO */}
            <svg
              className="bl-logo"
              viewBox="0 0 100 100"
              xmlns="http://www.w3.org/2000/svg"
              style={{ marginTop: "0.4cm" }}
            >
              {/* Two stylized green leaves forming a circular logo */}
              <path
                d="M50 18 C 30 18, 18 35, 22 55 C 24 65, 32 70, 42 68 C 50 66, 56 58, 56 48 C 56 35, 48 25, 50 18 Z"
                fill="#7ab84e"
              />
              <path
                d="M50 18 C 70 18, 82 35, 78 55 C 76 65, 68 70, 58 68 C 50 66, 44 58, 44 48 C 44 35, 52 25, 50 18 Z"
                fill="#4a8c2a"
              />
              <path d="M50 18 L 50 60" stroke="white" strokeWidth="1.2" fill="none" opacity="0.6" />
              <text
                x="50"
                y="92"
                textAnchor="middle"
                fontFamily="Helvetica, Arial, sans-serif"
                fontWeight="700"
                fontSize="14"
                fill="#1a3d10"
                letterSpacing="2"
              >
                AV
              </text>
            </svg>

            {/* HEADER : Titre/meta à gauche, client à droite */}
            <div className="bl-header">
              <div style={{ flex: 1 }}>
                <h1 className="bl-title">Bon de livraison {blRef} du {dateStr}</h1>
                <div className="bl-meta">
                  <div><span className="bl-meta-label">Tournée :</span> <b>{tourneeId}</b></div>
                  <div><span className="bl-meta-label">Date de livraison :</span> <b>{dateStr}</b></div>
                  <div><span className="bl-meta-label">Référence interne :</span> <b className="bl-mono">{c.clientId}</b></div>
                  {c.telephone && <div><span className="bl-meta-label">Client téléphone :</span> <b>{c.telephone}</b></div>}
                  {c.contact && <div><span className="bl-meta-label">Contact :</span> <b>{c.contact}</b></div>}
                </div>
              </div>

              <div className="bl-client-block" style={{ minWidth: "7cm" }}>
                <div className="bl-client-name">{c.entreprise}</div>
                {c.contact && <div>à l&apos;attention de {c.contact}</div>}
                <div>{c.adresse}</div>
                <div>{c.codePostal} - {c.ville}</div>
              </div>
            </div>

            {/* ADRESSE DE LIVRAISON */}
            <div className="bl-livraison">
              <span className="bl-meta-label">Adresse de la livraison :</span>{" "}
              <b>
                {[c.adresse, c.codePostal, c.ville].filter(Boolean).join(", ")}
              </b>
              <div style={{ marginTop: "2px" }}>
                <span className="bl-meta-label">Fournis par :</span>{" "}
                Vélos cargo livrés par Vélos Cargo / Artisans Verts Energy
              </div>
            </div>

            {/* RÉCAP À DROITE */}
            <div className="bl-summary">
              <div className="bl-summary-row">
                <span>Nombre de vélos livrés</span>
                <span>{c.velos.length}</span>
              </div>
              <div className="bl-summary-row">
                <span>Date de livraison</span>
                <span>{dateStr}</span>
              </div>
              <div className="bl-summary-row total">
                <span>Total vélos remis</span>
                <span>{c.velos.length}</span>
              </div>
            </div>

            {/* DÉTAIL TABLE */}
            <div className="bl-detail-header">
              <div>Détail</div>
              <div style={{ textAlign: "center" }}>N°</div>
              <div style={{ textAlign: "center" }}>Quantité</div>
              <div>FNUCI</div>
            </div>
            {c.velos.map((v, i) => (
              <div key={v.veloId} className="bl-detail-row">
                <div>
                  <div className="bl-detail-name">Vélo cargo Thaleos AX-ELE004</div>
                  <div className="bl-detail-spec">
                    Assistance électrique 250 W · batterie Li-ion 403,2 Wh · norme EN 15194:2023 + EN 17860
                  </div>
                  <div className="bl-detail-spec bl-mono">ID interne : {v.veloId}</div>
                </div>
                <div style={{ textAlign: "center" }}>{i + 1}</div>
                <div style={{ textAlign: "center" }}>1</div>
                <div className="bl-mono">{v.fnuci || "—"}</div>
              </div>
            ))}

            {/* PIED DE PAGE — SIGNATURES */}
            <div className="bl-foot">
              <div className="bl-sign">
                <div className="bl-sign-title">Signature livreur</div>
                <div className="bl-sign-meta">
                  Date :<br />
                  Nom :<br />
                  Signature :
                </div>
              </div>
              <div className="bl-sign">
                <div className="bl-sign-title">Signature client (bon pour réception)</div>
                <div className="bl-sign-meta">
                  Date :<br />
                  Nom :<br />
                  Cachet / signature :
                </div>
              </div>
            </div>

            {/* BANDEAU LÉGAL BAS */}
            <div className="bl-banner bl-banner-bottom">{LEGAL_BANNER}</div>
          </div>
        );
      })}
    </>
  );
}
