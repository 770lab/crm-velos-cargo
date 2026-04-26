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

function ArtisansVertsLogo({ size = 110 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 220 170"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Les Artisans Verts"
    >
      {/* House outline */}
      <path
        d="M14 70 L110 12 L206 70 L206 158 L14 158 Z"
        fill="none"
        stroke="#2f8f4a"
        strokeWidth="7"
        strokeLinejoin="round"
      />
      {/* LES */}
      <text
        x="110"
        y="64"
        textAnchor="middle"
        fontFamily="Helvetica, Arial, sans-serif"
        fontSize="15"
        fontWeight="700"
        fill="#1f4f87"
        letterSpacing="2"
      >
        LES
      </text>
      {/* ARTISANS */}
      <text
        x="110"
        y="98"
        textAnchor="middle"
        fontFamily="Helvetica, Arial, sans-serif"
        fontSize="28"
        fontWeight="800"
        fill="#1f4f87"
        letterSpacing="1"
      >
        ARTISANS
      </text>
      {/* VERTS */}
      <text
        x="110"
        y="132"
        textAnchor="middle"
        fontFamily="Helvetica, Arial, sans-serif"
        fontSize="28"
        fontWeight="800"
        fill="#3a953f"
        letterSpacing="2"
      >
        VERTS
      </text>
      {/* Leaf bottom right */}
      <path
        d="M168 134 Q190 120 205 130 Q200 158 175 158 Q160 152 168 134 Z"
        fill="#3a953f"
      />
      <path
        d="M172 152 Q185 142 200 138"
        fill="none"
        stroke="#1e4f24"
        strokeWidth="1.5"
      />
    </svg>
  );
}

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
    : new Date().toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });

  const blRef = (clientId: string) =>
    `BL-${tourneeId.slice(0, 8).toUpperCase()}-${clientId.slice(-4).toUpperCase()}`;

  return (
    <>
      <style>{`
        @page { size: A4; margin: 0; }
        @media print {
          .no-print { display: none !important; }
          body { background: white !important; margin: 0 !important; }
          .bl-sheet { box-shadow: none !important; margin: 0 !important; page-break-after: always; }
          .bl-sheet:last-child { page-break-after: auto; }
        }
        body { background: #f0f0f0; }
        .bl-sheet {
          box-sizing: border-box;
          width: 21cm;
          min-height: 29.7cm;
          margin: 0.5cm auto;
          padding: 0.7cm 1.4cm;
          background: white;
          color: #111;
          font-family: Helvetica, Arial, sans-serif;
          font-size: 9.5pt;
          line-height: 1.4;
          page-break-after: always;
          position: relative;
          box-shadow: 0 2px 8px rgba(0,0,0,0.08);
          display: flex;
          flex-direction: column;
        }
        .bl-banner {
          font-size: 7pt;
          color: #555;
          text-align: center;
          line-height: 1.45;
        }
        .bl-banner-bottom { margin-top: auto; padding-top: 0.4cm; }
        .bl-header-row {
          display: grid;
          grid-template-columns: auto 1fr;
          gap: 1.1cm;
          margin-top: 0.4cm;
          align-items: flex-start;
        }
        .bl-title {
          font-size: 14pt;
          font-weight: 700;
          margin: 0 0 0.2cm 0;
          color: #111;
        }
        .bl-meta-line {
          font-size: 9pt;
          color: #111;
        }
        .bl-meta-line .lbl { color: #444; }
        .bl-meta-line b { font-weight: 700; }
        .bl-client-block {
          text-align: right;
          font-size: 9.5pt;
          line-height: 1.5;
          color: #111;
        }
        .bl-client-name {
          font-size: 13pt;
          font-weight: 700;
          letter-spacing: 0.2px;
        }
        .bl-livraison-line {
          margin-top: 0.45cm;
          font-size: 9pt;
          color: #111;
        }
        .bl-livraison-line .lbl { color: #444; }
        .bl-livraison-line b { font-weight: 700; }

        .bl-totals {
          margin-top: 0.5cm;
          margin-left: auto;
          width: 8.5cm;
          font-size: 9pt;
        }
        .bl-totals-row {
          display: flex;
          justify-content: space-between;
          padding: 3px 0;
        }
        .bl-totals-row.strong {
          font-weight: 700;
          font-size: 10pt;
        }
        .bl-totals-row.final {
          border-top: 1px solid #111;
          margin-top: 4px;
          padding-top: 8px;
          font-weight: 700;
          font-size: 12pt;
        }

        .bl-table {
          margin-top: 0.5cm;
          width: 100%;
          border-collapse: collapse;
        }
        .bl-table thead th {
          background: transparent;
          color: #111;
          font-size: 9pt;
          font-weight: 700;
          text-align: left;
          padding: 6px 8px;
          border-top: 1px solid #999;
          border-bottom: 1px solid #999;
        }
        .bl-table thead th.num { text-align: right; }
        .bl-table tbody td {
          padding: 8px;
          font-size: 9pt;
          vertical-align: top;
          border-bottom: 1px solid #e5e5e5;
        }
        .bl-table tbody td.num { text-align: right; }
        .bl-detail-name { font-weight: 700; }
        .bl-detail-list {
          margin: 4px 0 0 14px;
          padding: 0;
          color: #222;
        }
        .bl-detail-list li {
          margin: 1px 0;
          font-size: 8.7pt;
          line-height: 1.4;
        }
        .bl-mono {
          font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
          font-size: 9pt;
        }
        .bl-qr-line {
          background: #fff8d6;
          padding: 3px 6px;
          border-radius: 2px;
          font-weight: 700;
          display: inline-block;
          margin: 4px 0 2px;
        }

        .bl-page-foot {
          margin-top: 0.6cm;
          display: grid;
          grid-template-columns: 1fr 1fr 1fr 1fr;
          border: 1px solid #aaa;
          border-radius: 2px;
          font-size: 8.5pt;
          color: #222;
        }
        .bl-page-foot > div {
          padding: 8px 10px;
          border-right: 1px solid #ccc;
          text-align: center;
        }
        .bl-page-foot > div:last-child {
          border-right: 0;
          text-align: left;
          min-height: 1.4cm;
        }
        .bl-page-foot .lbl {
          color: #777;
          font-size: 8pt;
        }
        .bl-page-foot b { font-weight: 700; }

        .bl-sign-row {
          margin-top: 0.45cm;
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 0.6cm;
        }
        .bl-sign {
          border: 1px solid #aaa;
          border-radius: 2px;
          padding: 8px 10px;
          font-size: 8.5pt;
          min-height: 2.5cm;
        }
        .bl-sign-title { font-weight: 700; margin-bottom: 0.6cm; }
        .bl-sign-meta { color: #555; line-height: 1.5; }
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
        const ref = blRef(c.clientId);
        return (
          <div key={c.clientId} className="bl-sheet">
            {/* BANDEAU LÉGAL HAUT */}
            <div className="bl-banner">{LEGAL_BANNER}</div>

            {/* LOGO + HEADER */}
            <div className="bl-header-row">
              <ArtisansVertsLogo size={110} />
              <div>
                {/* placeholder pour aligner — le titre est sous le logo */}
              </div>
            </div>

            {/* TITRE + METADONNÉES À GAUCHE / CLIENT À DROITE */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1cm", marginTop: "0.3cm", alignItems: "flex-start" }}>
              <div>
                <h1 className="bl-title">Bon de livraison {ref} du {dateStr}</h1>
                <div className="bl-meta-line"><span className="lbl">Tournée :</span> <b>{tourneeId}</b></div>
                <div className="bl-meta-line"><span className="lbl">Date de livraison :</span> <b>{dateStr}</b></div>
                <div className="bl-meta-line"><span className="lbl">Référence client :</span> <b className="bl-mono">{c.clientId}</b></div>
                {c.telephone && <div className="bl-meta-line"><span className="lbl">Client téléphone :</span> <b>{c.telephone}</b></div>}
                {c.contact && <div className="bl-meta-line"><span className="lbl">Contact :</span> <b>{c.contact}</b></div>}
              </div>

              <div className="bl-client-block">
                <div className="bl-client-name">{c.entreprise}</div>
                {c.contact && <div>à l&apos;attention de {c.contact}</div>}
                <div>{c.adresse}</div>
                <div>{c.codePostal} - {c.ville}</div>
              </div>
            </div>

            {/* ADRESSE DE LIVRAISON + FOURNIS PAR */}
            <div className="bl-livraison-line">
              <span className="lbl">Adresse de la livraison :</span>{" "}
              <b>{[c.adresse, c.codePostal, c.ville].filter(Boolean).join(", ")}</b>
            </div>
            <div className="bl-livraison-line">
              <span className="lbl">Fournis par :</span>{" "}
              <b>Vélos cargo livrés et installés par Vélos Cargo / Artisans Verts Energy</b>
            </div>

            {/* RÉCAP À DROITE (style Total HT/TTC du DEVIS) */}
            <div className="bl-totals">
              <div className="bl-totals-row">
                <span>Nombre de vélos prévus</span>
                <span>{c.velos.length}</span>
              </div>
              <div className="bl-totals-row">
                <span>Nombre de vélos remis</span>
                <span>{c.velos.length}</span>
              </div>
              <div className="bl-totals-row strong">
                <span>Date de livraison</span>
                <span>{dateStr}</span>
              </div>
              <div className="bl-totals-row final">
                <span>Total vélos remis</span>
                <span>{c.velos.length}</span>
              </div>
            </div>

            {/* TABLE DÉTAIL */}
            <table className="bl-table">
              <thead>
                <tr>
                  <th>Détail</th>
                  <th className="num" style={{ width: "1.6cm" }}>Quantité</th>
                  <th style={{ width: "1.2cm" }}>Unité</th>
                  <th className="num" style={{ width: "3.2cm" }}>N° QR / FNUCI</th>
                </tr>
              </thead>
              <tbody>
                {c.velos.map((v, i) => (
                  <tr key={v.veloId}>
                    <td>
                      <div className="bl-detail-name">
                        TRA-EQ-131 : Acquisition de vélo cargo à assistance électrique neuf — Vélo n°{i + 1}
                      </div>
                      <ul className="bl-detail-list">
                        <li>Marque <b>Thaleos</b>, référence <b>AX-ELE004</b></li>
                        <li>Capacité de la batterie : <b>403,20 Wh</b></li>
                        <li>Poids total autorisé en charge : <b>185,00 KG</b></li>
                        <li>Dimensions du vélo (L × l × H) : <b>185 × 65 × 115 cm</b></li>
                        <li>Poids du vélo : <b>28,00 KG</b></li>
                        <li>Roues : Rayon acier (12G) jantes en alliage aluminium</li>
                        <li>Freins : Disques mécaniques, alliage ED - 160 mm</li>
                        <li>Norme(s) : <b>EN 15194:2023 + EN 17860</b> (cargo bike)</li>
                        <li>Indice de protection IP67 · Transmission Shimano 7 vitesses · Moteur 36 V - 250 W · Autonomie 40 à 50 km</li>
                        <li>Conforme aux directives 2006/42/CE, 2011/65/UE, 2014/30/UE et 2023/1542/UE</li>
                        <li>Kwh Cumac : <b>83 000,00</b></li>
                      </ul>
                      <div className="bl-qr-line">
                        N° QR / FNUCI : <span className="bl-mono">{v.fnuci || "—"}</span>
                      </div>
                      <div style={{ fontSize: "8pt", color: "#777", marginTop: "2px" }}>
                        ID interne : <span className="bl-mono">{v.veloId}</span>
                      </div>
                    </td>
                    <td className="num">1,00</td>
                    <td>U</td>
                    <td className="num bl-mono">{v.fnuci || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* BLOC PIED PAGE STYLE DEVIS (Page / N° BL / Date / Paraphe) */}
            <div className="bl-page-foot">
              <div>
                <div className="lbl">Page</div>
                <b>1 / 1</b>
              </div>
              <div>
                <div className="lbl">Numéro de BL</div>
                <b>{ref}</b>
              </div>
              <div>
                <div className="lbl">Date du BL</div>
                <b>{dateStr}</b>
              </div>
              <div>
                <div className="lbl">Paraphe :</div>
              </div>
            </div>

            {/* SIGNATURES */}
            <div className="bl-sign-row">
              <div className="bl-sign">
                <div className="bl-sign-title">Signature livreur</div>
                <div className="bl-sign-meta">
                  Date : ____________________<br />
                  Nom : ____________________<br />
                  Signature :
                </div>
              </div>
              <div className="bl-sign">
                <div className="bl-sign-title">Signature client (bon pour réception)</div>
                <div className="bl-sign-meta">
                  Date : ____________________<br />
                  Nom : ____________________<br />
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
