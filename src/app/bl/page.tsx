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

const LOGO_PATH = "/crm-velos-cargo/logo-av.png";
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
  const dateLivraison = data.datePrevue ? new Date(data.datePrevue) : new Date();
  const dateStr = dateLivraison.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });

  const blRef = (clientId: string) =>
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
        body { background: #e5e5e5; }
        .bl-sheet {
          box-sizing: border-box;
          width: 210mm;
          min-height: 297mm;
          margin: 0.5cm auto;
          padding: 12mm 14mm 14mm 14mm;
          background: white;
          color: #111;
          font-family: Helvetica, Arial, sans-serif;
          font-size: 9pt;
          line-height: 1.35;
          page-break-after: always;
          position: relative;
          box-shadow: 0 2px 10px rgba(0,0,0,0.1);
          display: flex;
          flex-direction: column;
        }
        .bl-sheet:last-child { page-break-after: auto; }

        .legal {
          font-size: 6.8pt;
          color: #444;
          text-align: center;
          line-height: 1.35;
          padding: 0 2mm;
        }
        .legal-bottom { margin-top: auto; padding-top: 6mm; }

        .logo {
          width: 32mm;
          height: auto;
          display: block;
          margin-top: 4mm;
        }

        .row-2col {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8mm;
          margin-top: 4mm;
        }
        .meta-block { font-size: 8.8pt; line-height: 1.5; }
        .meta-title { font-size: 12.5pt; font-weight: 700; margin: 0 0 1.5mm 0; }
        .meta-block .lbl { color: #444; }
        .meta-block b { font-weight: 700; }

        .client-block {
          text-align: right;
          font-size: 9pt;
          line-height: 1.55;
        }
        .client-name { font-size: 12pt; font-weight: 700; }

        .liv-line {
          margin-top: 4mm;
          font-size: 8.8pt;
        }
        .liv-line .lbl { color: #444; font-weight: 600; }
        .liv-line b { font-weight: 700; }

        .totaux {
          margin-top: 4mm;
          margin-left: auto;
          width: 75mm;
          font-size: 9pt;
        }
        .totaux-row {
          display: flex; justify-content: space-between;
          padding: 1.2mm 0;
        }
        .totaux-row.bold {
          font-weight: 700;
          font-size: 10pt;
        }
        .totaux-row.final {
          border-top: 1px solid #111;
          margin-top: 2mm;
          padding-top: 3mm;
          font-weight: 700;
          font-size: 12pt;
        }

        .detail-table {
          margin-top: 5mm;
          width: 100%;
          border-collapse: collapse;
        }
        .detail-table thead th {
          font-size: 8.5pt;
          font-weight: 700;
          text-align: left;
          padding: 2.5mm 2mm;
          background: #f0f0f0;
          border-bottom: 1px solid #aaa;
        }
        .detail-table thead th.num { text-align: right; }
        .detail-table tbody td {
          font-size: 8.5pt;
          padding: 3mm 2mm;
          vertical-align: top;
          border-bottom: 1px solid #d0d0d0;
        }
        .detail-table tbody td.num { text-align: right; }
        .detail-row .name { font-weight: 700; font-size: 9pt; }
        .detail-row ul {
          margin: 1mm 0 0 4mm;
          padding-left: 3mm;
          color: #222;
        }
        .detail-row li {
          font-size: 8pt;
          margin: 0.3mm 0;
          line-height: 1.35;
        }
        .detail-row .qr-line {
          margin-top: 2mm;
          font-size: 9pt;
        }
        .detail-row .qr-badge {
          display: inline-block;
          background: #fff3b0;
          border: 1px solid #d4b500;
          padding: 1mm 2.5mm;
          border-radius: 1mm;
          font-weight: 700;
          font-family: ui-monospace, Menlo, Consolas, monospace;
        }
        .detail-row .id-interne {
          font-size: 7.5pt; color: #666;
          font-family: ui-monospace, Menlo, Consolas, monospace;
          margin-top: 1mm;
        }

        .page-foot {
          margin-top: 6mm;
          display: grid;
          grid-template-columns: 1fr 1.3fr 1fr 1.5fr;
          border: 1px solid #aaa;
          font-size: 8pt;
        }
        .page-foot > div {
          padding: 3mm 4mm;
          border-right: 1px solid #ccc;
          text-align: center;
          line-height: 1.4;
        }
        .page-foot > div:last-child {
          border-right: 0;
          text-align: left;
          min-height: 16mm;
        }
        .page-foot .lbl { color: #777; font-size: 7.5pt; }
        .page-foot b { font-weight: 700; }

        .signs {
          margin-top: 5mm;
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 5mm;
        }
        .sign-box {
          border: 1px solid #aaa;
          padding: 3mm 4mm;
          font-size: 8pt;
          min-height: 28mm;
        }
        .sign-title { font-weight: 700; margin-bottom: 6mm; }
        .sign-meta { color: #555; line-height: 1.6; }
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
            <div className="legal">{LEGAL_BANNER}</div>

            {/* LOGO */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={LOGO_PATH} alt="Les Artisans Verts" className="logo" />

            {/* TITRE + META à GAUCHE / CLIENT à DROITE */}
            <div className="row-2col">
              <div className="meta-block">
                <h1 className="meta-title">Bon de livraison {ref} du {dateStr}</h1>
                <div><span className="lbl">Tournée :</span> <b>{tourneeId}</b></div>
                <div><span className="lbl">Date de livraison :</span> <b>{dateStr}</b></div>
                <div><span className="lbl">Référence client :</span> <b>{c.clientId}</b></div>
                {c.telephone && <div><span className="lbl">Client téléphone :</span> <b>{c.telephone}</b></div>}
                {c.contact && <div><span className="lbl">Contact :</span> <b>{c.contact}</b></div>}
              </div>

              <div className="client-block">
                <div className="client-name">{c.entreprise}</div>
                {c.contact && <div>à l&apos;attention de {c.contact}</div>}
                <div>{c.adresse}</div>
                <div>{c.codePostal} - {c.ville}</div>
              </div>
            </div>

            {/* ADRESSE LIVRAISON + FOURNIS PAR */}
            <div className="liv-line">
              <span className="lbl">Adresse de la livraison :</span>{" "}
              <b>{[c.adresse, c.codePostal, c.ville].filter(Boolean).join(", ")}</b>
            </div>
            <div className="liv-line">
              <span className="lbl">Fournis par :</span>{" "}
              <b>Vélos cargo livrés et installés par Vélos Cargo / Artisans Verts Energy</b>
            </div>

            {/* TOTAUX À DROITE (style DEVIS) */}
            <div className="totaux">
              <div className="totaux-row">
                <span>Nombre de vélos prévus</span>
                <span>{c.velos.length}</span>
              </div>
              <div className="totaux-row">
                <span>Nombre de vélos remis</span>
                <span>{c.velos.length}</span>
              </div>
              <div className="totaux-row bold">
                <span>Date de livraison</span>
                <span>{dateStr}</span>
              </div>
              <div className="totaux-row final">
                <span>Total vélos remis</span>
                <span>{c.velos.length}</span>
              </div>
            </div>

            {/* TABLEAU DÉTAIL */}
            <table className="detail-table">
              <thead>
                <tr>
                  <th>Détail</th>
                  <th className="num" style={{ width: "20mm" }}>Quantité</th>
                  <th style={{ width: "12mm" }}>Unité</th>
                  <th className="num" style={{ width: "40mm" }}>N° vélo (QR / FNUCI)</th>
                </tr>
              </thead>
              <tbody>
                {c.velos.map((v, i) => (
                  <tr key={v.veloId} className="detail-row">
                    <td>
                      <div className="name">
                        Vélo n°{i + 1} — TRA-EQ-131 : Acquisition de vélo cargo à assistance électrique neuf
                      </div>
                      <ul>
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
                      <div className="qr-line">
                        <b>N° vélo (QR / FNUCI) :</b>{" "}
                        <span className="qr-badge">{v.fnuci || "À scanner par le préparateur"}</span>
                      </div>
                      <div className="id-interne">ID interne : {v.veloId}</div>
                    </td>
                    <td className="num">1,00</td>
                    <td>U</td>
                    <td className="num">
                      <span className="qr-badge">{v.fnuci || "—"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* PIED DE PAGE 4 CELLULES (style DEVIS) */}
            <div className="page-foot">
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
            <div className="signs">
              <div className="sign-box">
                <div className="sign-title">Signature livreur</div>
                <div className="sign-meta">
                  Date : ____________________<br />
                  Nom : ____________________<br />
                  Signature :
                </div>
              </div>
              <div className="sign-box">
                <div className="sign-title">Signature client (bon pour réception)</div>
                <div className="sign-meta">
                  Date : ____________________<br />
                  Nom : ____________________<br />
                  Cachet / signature :
                </div>
              </div>
            </div>

            {/* BANDEAU LÉGAL BAS */}
            <div className="legal legal-bottom">{LEGAL_BANNER}</div>
          </div>
        );
      })}
    </>
  );
}
