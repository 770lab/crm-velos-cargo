"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { gasGet } from "@/lib/gas";

import { BASE_PATH } from "@/lib/base-path";
type Velo = { veloId: string; fnuci: string | null };
type Client = {
  clientId: string;
  entreprise: string;
  ville: string;
  adresse: string;
  codePostal: string;
  telephone: string | null;
  contact: string | null;
  numeroBL: string | null;
  velos: Velo[];
};
type Progression =
  | { tourneeId: string; datePrevue: string | null; clients: Client[] }
  | { error: string };

const LOGO_PATH = `${BASE_PATH}/logo-av.png`;

// Mentions légales reprises du footer DEVIS Artisans Verts (cf bat127, ITE, PAC).
const LEGAL_BANNER_2026 = `LES ARTISANS VERTS SAS Société par actions simplifiée au capital de 40 000 € Siège social : 6 passage Eugène Barbier, 92400 Courbevoie · E-mail : contact@artisansverts.energy Téléphone : 01 87 66 27 08 SIRET : 878 062 793 00038 TVA intracommunautaire : FR34 878062793 · Assurance décennale : GROUPE LEADER Insurance N° de police : LINS267132 Période de validité : du 01/01/2026 au 31/12/2026`;

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
    // Appelle getBlForTournee : c'est ICI que les numéros BL séquentiels
    // (BL-2026-00001, BL-2026-00002, ...) sont attribués pour la première fois
    // si la livraison n'en a pas encore — au premier affichage de la page BL.
    gasGet("getBlForTournee", { tourneeId }).then(setData);
  }, [tourneeId]);

  if (!tourneeId) return <div className="p-6 text-red-600">Paramètre tourneeId manquant.</div>;
  if (!data) return <div className="p-6 text-sm text-gray-500">Chargement…</div>;
  if ("error" in data) return <div className="p-6 text-red-600">{data.error}</div>;

  const clients = focusClientId ? data.clients.filter((c) => c.clientId === focusClientId) : data.clients;
  const dateLivraison = data.datePrevue ? new Date(data.datePrevue) : new Date();
  const dateStr = dateLivraison.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });

  // Le numéro BL est attribué côté serveur via getBlForTournee (séquentiel par
  // année, format "BL-2026-00001"). Persistant en colonne numeroBL : une fois
  // attribué, ne change plus. Fallback hash si l'attribution a échoué.
  const blRef = (c: Client) =>
    c.numeroBL ?? `BL-${tourneeId.slice(0, 8).toUpperCase()}-${c.clientId.slice(-4).toUpperCase()}`;

  return (
    <>
      <style>{`
        @page { size: 210mm 297mm; margin: 0; }
        @media print {
          .no-print { display: none !important; }
          html, body { margin: 0; padding: 0; background: #fff; width: 210mm; }
          .dv-page { box-shadow: none !important; margin: 0 !important; page-break-after: always; }
          .dv-page:last-child { page-break-after: auto; }
          .dv-table thead tr { background: #3a7d44 !important; color: #fff !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .dv-table th { background: #3a7d44 !important; color: #fff !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          /* Garder ces blocs ensemble : si trop bas, browser pousse sur la page suivante */
          .dv-sign, .dv-section, .dv-page-footer { page-break-inside: avoid; }
          /* La liste FNUCI peut s'étendre sur plusieurs pages */
          .dv-fnuci-annexe { break-inside: auto; }
        }
        body { background: #dde3dd; }

        .dv-page {
          background: #fff;
          width: 210mm;
          min-height: 297mm;
          margin: 16px auto;
          padding: 0;
          font-size: 9pt;
          line-height: 1.4;
          color: #1a1a1a;
          font-family: Arial, Helvetica, sans-serif;
          box-shadow: 0 2px 20px rgba(0,0,0,.12);
          position: relative;
        }
        .dv-inner {
          padding: 14mm 14mm 10mm 14mm;
          display: flex;
          flex-direction: column;
          min-height: 297mm;
          box-sizing: border-box;
        }
        .dv-content { flex: 1 1 0; min-height: 0; }
        .dv-page-footer { flex-shrink: 0; padding-top: 6px; }

        .dv-logo { height: 26mm; width: auto; display: block; margin-bottom: 4mm; align-self: flex-start; max-width: 100%; }

        .dv-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; }
        .dv-head-left .doc-title { font-size: 13pt; font-weight: 700; color: #1a1a1a; margin-bottom: 4px; }
        .dv-head-left .doc-meta { font-size: 8pt; line-height: 1.7; color: #333; }
        .dv-head-right { text-align: right; }
        .dv-head-right .client-name { font-size: 11pt; font-weight: 700; margin-bottom: 4px; }
        .dv-head-right .client-info { font-size: 8.5pt; line-height: 1.7; color: #333; }

        .dv-travaux { display: flex; justify-content: space-between; align-items: flex-start; margin: 6px 0 10px 0; padding-bottom: 8px; border-bottom: 1px solid #e2e8f0; }
        .dv-travaux-left { font-size: 8pt; line-height: 1.7; color: #333; flex: 1; padding-right: 20px; }
        .dv-totaux { min-width: 200px; }
        .dv-totaux table { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
        .dv-totaux td { padding: 1.5px 4px; }
        .dv-totaux td.r { text-align: right; white-space: nowrap; }
        .dv-totaux .ttc { font-weight: 700; font-size: 10pt; }
        .dv-totaux .rap { font-weight: 700; font-size: 11pt; color: #2d6a4f; }

        .dv-carac {
          border: 1px solid #ccc;
          border-bottom: none;
          padding: 6px 8px;
          font-size: 8pt;
          line-height: 1.5;
          background: #fafafa;
        }
        .dv-carac-title { font-weight: 700; text-decoration: underline; margin-bottom: 2px; }

        .dv-table { width: 100%; border-collapse: collapse; font-size: 8pt; margin-bottom: 10px; }
        .dv-table thead tr { background: #3a7d44; color: #fff; }
        .dv-table th { padding: 5px 6px; text-align: left; font-size: 8pt; font-weight: 700; border: 1px solid #1e5040; }
        .dv-table th.r { text-align: right; }
        .dv-table th.c { text-align: center; }
        .dv-table td { padding: 5px 6px; border: 1px solid #ccc; vertical-align: top; }
        .dv-table td.r { text-align: right; white-space: nowrap; }
        .dv-table td.c { text-align: center; white-space: nowrap; }
        .dv-table ul { list-style: none; padding: 0; margin: 0; }
        .dv-table ul li { padding: 0; font-size: 7.5pt; line-height: 1.35; }
        .dv-table .ul-title { text-decoration: underline; margin: 3px 0 1px; font-size: 8pt; }
        .dv-fnuci-list { margin-top: 4px; padding: 4px 6px; background: #f6f6f6; border: 1px dashed #bbb; border-radius: 2px; font-size: 7.5pt; line-height: 1.5; }
        .dv-fnuci-badge { display: inline-block; background: #fff3b0; border: 1px solid #d4b500; padding: 0 4px; border-radius: 2px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 7.5pt; margin: 1px 2px; }

        .dv-fnuci-annexe { margin: 8px 0 12px 0; border: 1px solid #ccc; padding: 8px 10px; }
        .dv-fnuci-annexe-title { font-size: 9pt; font-weight: 700; margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid #e2e8f0; }
        .dv-fnuci-grid { columns: 4; column-gap: 8mm; font-size: 8pt; line-height: 1.6; }
        .dv-fnuci-grid .row { break-inside: avoid; padding: 1px 0; display: flex; align-items: baseline; gap: 4px; }
        .dv-fnuci-grid .num { color: #666; font-size: 7.5pt; min-width: 16px; text-align: right; }
        @media print { .dv-fnuci-grid { columns: 4; } }

        .dv-sign { border: 1px solid #ccc; display: flex; font-size: 8pt; margin: 8px 0; }
        .dv-sign-cell { flex: 1; padding: 10px 12px; min-height: 28mm; }
        .dv-sign-cell + .dv-sign-cell { border-left: 1px solid #ccc; }
        .dv-sign-title { font-weight: 700; margin-bottom: 6mm; }

        .dv-foot-meta { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
        .dv-foot-meta td { border: 1px solid #ccc; padding: 5px 10px; text-align: center; font-size: 8pt; color: #555; vertical-align: middle; }
        .dv-foot-meta td b { display: block; font-size: 9pt; color: #1a1a1a; margin-top: 2px; }
        .dv-foot-meta td.paraphe { text-align: left; vertical-align: top; height: 18mm; }

        .dv-legal { text-align: center; font-size: 7.2pt; color: #1a1a1a; line-height: 1.6; }

        /* === Page 2 BL : pavé conditions + bloc signature, calquage page 1 ===
           Le user a demandé que la page 2 ressemble à la page 1 : tableaux à
           entête verte (#3a7d44), bordures #ccc, footer Page X/Y · BL · Date.
           On réutilise les classes existantes (.dv-table, .dv-foot-meta) pour
           les sections "Conditions" et "Signature" afin que les 2 pages
           partagent le même look. */

        /* Tableau-section : entête vert + corps blanc encadré, comme dv-table
           mais sans les colonnes Quantité/PU/etc. — sert pour les blocs
           "Conditions" et "Signature" de la page 2. */
        .dv-section { width: 100%; border-collapse: collapse; margin: 8px 0 0 0; font-size: 8.5pt; }
        .dv-section thead th { background: #3a7d44; color: #fff; padding: 5px 8px; text-align: left; font-size: 9pt; font-weight: 700; border: 1px solid #1e5040; }
        .dv-section td { padding: 6px 10px; border: 1px solid #ccc; vertical-align: top; }
        .dv-section .dv-section-body { font-size: 8pt; line-height: 1.5; }
        .dv-section .dv-section-body p { margin: 3px 0; }
        .dv-section .dv-section-body h5 {
          font-size: 8.5pt; font-weight: 700; margin: 6px 0 2px 0;
          text-decoration: underline;
        }
        .dv-section .dv-section-body h5:first-child { margin-top: 0; }

        /* Lignes pointillées pour les "Réserves émises". */
        .dv-reserves-lines { margin-top: 4px; }
        .dv-reserves-lines .line { border-bottom: 1px dotted #888; height: 5mm; }

        /* Variante de dv-content qui pousse le bloc signature tout en bas
           (utilisée seulement sur la page 2). */
        .dv-content-bottom { display: flex; flex-direction: column; }
        .dv-push-bottom { margin-top: auto; }

        /* Bloc signature : tableau 2 cellules (Cachet/Signature à gauche,
           Mention/À/Le à droite) sous l'entête verte. Cohérent avec le reste
           du document. */
        .dv-sign-grid { display: flex; }
        .dv-sign-grid > .left {
          flex: 1;
          padding: 10px 12px;
          border-right: 1px solid #ccc;
          min-height: 36mm;
        }
        .dv-sign-grid > .right {
          width: 38%;
          padding: 10px 12px;
          font-size: 8.5pt;
        }
        .dv-sign-grid .label { font-weight: 600; margin-bottom: 5mm; font-size: 8.5pt; }
        .dv-sign-grid .cachet-label { font-style: italic; color: #555; margin-top: 2mm; }
        .dv-sign-grid .meta-row { padding: 4px 0; border-bottom: 1px dotted #999; min-height: 7mm; }
        .dv-sign-grid .meta-row:last-child { border-bottom: none; }
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
        const ref = blRef(c);
        const adresseLivraison = [c.adresse, c.codePostal, c.ville].filter(Boolean).join(", ");
        const nbVelos = c.velos.length;

        // Footer commun aux 2 pages.
        // Page 1 : tableau "Page 1/2 · BL · Date · Paraphe" + mentions légales.
        // Page 2 : seulement les mentions légales — l'info Page/BL/Date est
        //          déjà reprise dans la 1re colonne du bloc signature eq-127.
        const PageFooter = ({ pageNum, withMetaTable }: { pageNum: 1 | 2; withMetaTable: boolean }) => (
          <div className="dv-page-footer">
            {withMetaTable && (
              <table className="dv-foot-meta">
                <tbody>
                  <tr>
                    <td style={{ width: "14%" }}>Page<b>{pageNum} / 2</b></td>
                    <td style={{ width: "30%" }}>Numéro de BL<b>{ref}</b></td>
                    <td style={{ width: "30%" }}>Date du BL<b>{dateStr}</b></td>
                    <td className="paraphe" style={{ width: "26%" }}>Paraphe :</td>
                  </tr>
                </tbody>
              </table>
            )}
            <div className="dv-legal">{LEGAL_BANNER_2026}</div>
          </div>
        );

        return (
          <div key={c.clientId} style={{ display: "contents" }}>
            {/* ───── PAGE 1 : détail vélo + annexe FNUCI ───────────────────────── */}
            <div className="dv-page">
              <div className="dv-inner">
                <div className="dv-content">
                  {/* LOGO */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={LOGO_PATH} alt="Les Artisans Verts" className="dv-logo" />

                  {/* HEADER : meta gauche / client droite */}
                  <div className="dv-head">
                    <div className="dv-head-left">
                      <div className="doc-title">Bon de livraison {ref} du {dateStr}</div>
                      <div className="doc-meta">
                        Tournée : <strong>{tourneeId}</strong><br />
                        Référence client : <strong>{c.clientId}</strong><br />
                        Date de livraison : <strong>{dateStr}</strong>
                        {c.telephone && <><br />Client téléphone : {c.telephone}</>}
                        {c.contact && <><br />Contact : {c.contact}</>}
                      </div>
                    </div>
                    <div className="dv-head-right">
                      <div className="client-name">{c.entreprise}</div>
                      <div className="client-info">
                        {c.contact && <>à l&apos;attention de {c.contact}<br /></>}
                        {c.adresse}<br />
                        {c.codePostal} - {c.ville}
                      </div>
                    </div>
                  </div>

                  {/* ADRESSE LIVRAISON + Posé par + récap quantité */}
                  <div className="dv-travaux">
                    <div className="dv-travaux-left">
                      <strong>Adresse de la livraison :</strong> {adresseLivraison}<br />
                      <strong>Posé par :</strong> Matériel(s) fourni(s), livré(s) et installé(s) par Vélos Cargo / Artisans Verts Energy<br />
                      <strong>Date de livraison effective :</strong> {dateStr}
                    </div>
                    <div className="dv-totaux">
                      <table>
                        <tbody>
                          <tr><td>Vélos prévus</td><td className="r">{nbVelos}</td></tr>
                          <tr><td>Vélos remis</td><td className="r">{nbVelos}</td></tr>
                          <tr style={{ borderTop: "1.5px solid #333", borderBottom: "1px solid #333" }}>
                            <td className="ttc">Total remis</td>
                            <td className="r ttc">{nbVelos}</td>
                          </tr>
                          <tr style={{ borderTop: "2px solid #333" }}>
                            <td style={{ padding: "3px 0" }}><strong style={{ fontSize: "9pt" }}>Date</strong></td>
                            <td className="r rap" style={{ padding: "3px 0" }}>{dateStr}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Caractéristiques site de livraison */}
                  <div className="dv-carac">
                    <div className="dv-carac-title">Caractéristiques site de livraison</div>
                    <div>• Adresse : <strong>{adresseLivraison} ({c.entreprise})</strong></div>
                    {c.contact && <div>• Contact sur site : <strong>{c.contact}</strong></div>}
                    {c.telephone && <div>• Téléphone : <strong>{c.telephone}</strong></div>}
                  </div>

                  {/* TABLEAU DÉTAIL */}
                  <table className="dv-table">
                    <thead>
                      <tr>
                        <th style={{ width: "60%" }}>Détail</th>
                        <th className="c" style={{ width: "12%" }}>Quantité</th>
                        <th className="c" style={{ width: "10%" }}>Unité</th>
                        <th className="c" style={{ width: "18%" }}>FNUCI</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>
                          <div style={{ fontWeight: 700, marginBottom: "3px" }}>
                            TRA-EQ-131 : Acquisition de vélos-cargos à assistance électrique neufs
                          </div>
                          <ul>
                            <li>• Marque <strong>Thaleos</strong>, référence <strong>AX-ELE004</strong></li>
                            <li>• Capacité de la batterie : <strong>403,20 Wh</strong></li>
                            <li>• Poids total autorisé en charge : <strong>185,00 KG</strong></li>
                            <li>• Dimensions du vélo (L x l x H) : <strong>185 x 65 x 115 cm</strong></li>
                            <li>• Poids du vélo : <strong>28,00 KG</strong></li>
                            <li>• roues (caractéristiques) : Rayon acier (12G) jantes en alliage aluminium</li>
                            <li>• freins (caractéristiques, référence) : Disques mécaniques, alliage ED - 160 mm</li>
                            <li>• NORME(S) : <strong>EN15194:2023</strong> + <strong>EN17860</strong> (cargo bike)</li>
                            <li style={{ marginTop: "2px" }}>
                              • - Indice de protection : <strong>IP 67</strong>, - Transmission mécanique : 7 vitesses (Shimano), - Batterie : Lithium-ion, 403.2 Wh, - Moteur : 36 V - 250 W - 11.2 Ah, - Assistance électrique : Conforme à la norme EN 15194 et EN 17860, - Nombre de vitesse d&apos;assistance électrique : 5 vitesses, - Autonomie : 40 à 50 km (varie selon le poids de l&apos;utilisateur, la nature du terrain et la vitesse moyenne), - Béquille : Alliage ED - dimensions : 32.5 cm, - Panier : Avant (7kg) / dimensions Avant : 320 x 300 x 130 mm, - Porte-bagages : Arrière (50kg), acier noir / dimensions Arrière : 530 x 430 x 150 mm, - Pneus : CST 24 x 3.0 caoutchouc, - Chambre à air : CST 24 x 3.0 butyle noir, - Levier de freins : Alliage noir, coupure moteur intégré, - Rayons : Rayon acier (12G) jantes en alliage aluminium, - Jeu de direction : Fileté, Ø22.23027, 8 pièces, acier ED, dimensions : H = 33 mm, - Guidon : « Swallow bar » en acier noir, dimensions : Ø22.2 x 25.4 x 580 mm, - Potence : Acier noir, dimensions : Ø28.6 mm, - Poignées : Caoutchouc noir, dimensions : 130 mm, - Selle : Confort, noire, - Tige de selle : acier noir, dimensions : Ø28.6 x 350 mm, - Conforme aux directives 2006/42/CE, 2011/65/UE, 2014/30/UE et 2023/1542/UE.
                            </li>
                            <li>• Kwh Cumac : <strong>498 000,00</strong></li>
                          </ul>
                        </td>
                        <td className="c">{nbVelos},00</td>
                        <td className="c">U</td>
                        <td className="c" style={{ fontSize: "7.5pt", color: "#555" }}>
                          voir annexe<br />ci-dessous
                        </td>
                      </tr>
                      <tr>
                        <td>
                          <div style={{ fontWeight: 700 }}>Frais de livraison, déballage et montage</div>
                        </td>
                        <td className="c">1,00</td>
                        <td className="c">U</td>
                        <td className="c">—</td>
                      </tr>
                    </tbody>
                  </table>

                  {/* ANNEXE — Numéros d'immatriculation FNUCI (1 par vélo). */}
                  <div className="dv-fnuci-annexe">
                    <div className="dv-fnuci-annexe-title">
                      Numéros d&apos;immatriculation (FNUCI) — {nbVelos} vélo{nbVelos > 1 ? "s" : ""} livré{nbVelos > 1 ? "s" : ""}
                    </div>
                    {nbVelos === 0 ? (
                      <div style={{ fontSize: "8pt", color: "#666", fontStyle: "italic" }}>
                        Aucun vélo affecté à cette livraison à ce jour.
                      </div>
                    ) : (
                      <div className="dv-fnuci-grid">
                        {c.velos.map((v, i) => (
                          <div key={v.veloId} className="row">
                            <span className="num">{i + 1}.</span>
                            <span className="dv-fnuci-badge">{v.fnuci || "à scanner"}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>{/* /dv-content */}

                <PageFooter pageNum={1} withMetaTable={true} />
              </div>{/* /dv-inner */}
            </div>

            {/* ───── PAGE 2 : conditions de réception + signature
                Mise en page calquée sur le devis BAT-EQ-127 :
                  - logo en haut
                  - rappel allégé du BL (à qui, quoi, combien)
                  - rappel FNUCI réceptionnés (le client signe en connaissance)
                  - pavé "Termes et conditions de réception"
                  - bloc signature 3 colonnes en bas de page
                Le bloc signature est poussé en bas grâce à `dv-content-bottom`
                + `dv-push-bottom` (margin-top: auto). ──────────────────────── */}
            <div className="dv-page">
              <div className="dv-inner">
                <div className="dv-content dv-content-bottom">
                  {/* LOGO rappelé en haut — rattache visuellement cette page
                      de signature au BL de la page précédente. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={LOGO_PATH} alt="Les Artisans Verts" className="dv-logo" />

                  {/* RAPPEL HEADER allégé */}
                  <div className="dv-head">
                    <div className="dv-head-left">
                      <div className="doc-title">Bon de livraison {ref} — Réception</div>
                      <div className="doc-meta">
                        Tournée : <strong>{tourneeId}</strong><br />
                        Date de livraison : <strong>{dateStr}</strong><br />
                        Vélos livrés : <strong>{nbVelos}</strong>
                      </div>
                    </div>
                    <div className="dv-head-right">
                      <div className="client-name">{c.entreprise}</div>
                      <div className="client-info">
                        {c.contact && <>à l&apos;attention de {c.contact}<br /></>}
                        {c.adresse}<br />
                        {c.codePostal} - {c.ville}
                      </div>
                    </div>
                  </div>

                  {/* Rappel des FNUCI réceptionnés */}
                  {nbVelos > 0 && (
                    <div className="dv-fnuci-annexe">
                      <div className="dv-fnuci-annexe-title">
                        Numéros d&apos;immatriculation (FNUCI) réceptionnés — {nbVelos} vélo{nbVelos > 1 ? "s" : ""}
                      </div>
                      <div className="dv-fnuci-grid">
                        {c.velos.map((v, i) => (
                          <div key={v.veloId} className="row">
                            <span className="num">{i + 1}.</span>
                            <span className="dv-fnuci-badge">{v.fnuci || "à scanner"}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* TERMES ET CONDITIONS DE RÉCEPTION
                      Bloc présenté comme un tableau-section (entête vert,
                      bordures #ccc) pour matcher visuellement le tableau Détail
                      de la page 1. */}
                  <table className="dv-section">
                    <thead>
                      <tr>
                        <th>Termes et conditions de réception</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>
                          <div className="dv-section-body">
                            <p>
                              À la livraison, le destinataire est tenu de vérifier l&apos;état apparent
                              des cartons et le nombre d&apos;unités livrées. Toute anomalie (carton
                              ouvert, écrasé, choqué, manquant, FNUCI illisible) doit être mentionnée
                              explicitement sur le présent document avant signature, dans la rubrique
                              « Réserves ».
                            </p>
                            <p>
                              Conformément à l&apos;article L.133-3 du Code de commerce, les réserves
                              portant sur des avaries non apparentes au déchargement doivent être
                              confirmées au transporteur par lettre recommandée dans un délai de
                              trois (3) jours ouvrables suivant la réception.
                            </p>
                            <p>
                              La signature sans réserve du présent bon de livraison vaut acceptation
                              des marchandises livrées en bon état apparent et reconnaissance du
                              nombre d&apos;unités remises (cf. tableau « Total remis » page 1).
                              Les numéros d&apos;immatriculation (FNUCI) listés ci-dessus engagent
                              Les Artisans Verts SAS pour les obligations déclaratives prévues par le
                              décret n° 2020-1439 (BicyCode / FNUCI).
                            </p>

                            <h5>Garantie</h5>
                            <p>
                              Les vélos-cargos livrés bénéficient de la garantie légale de conformité
                              (24 mois — articles L.217-3 et suivants du Code de la consommation) ainsi
                              que de la garantie commerciale du constructeur Thaleos. Les conditions
                              complètes sont disponibles sur artisansverts.energy.
                            </p>

                            <h5>Réserves émises par le client à la réception</h5>
                            <div className="dv-reserves-lines">
                              <div className="line" />
                              <div className="line" />
                              <div className="line" />
                            </div>
                          </div>
                        </td>
                      </tr>
                    </tbody>
                  </table>

                  {/* BLOC SIGNATURE — tableau-section calé en bas de page
                      (margin-top: auto via dv-push-bottom). 2 colonnes :
                      cachet/signature à gauche, mention/à/le à droite. */}
                  <table className="dv-section dv-push-bottom">
                    <thead>
                      <tr>
                        <th>Signature client (bon pour réception)</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td style={{ padding: 0 }}>
                          <div className="dv-sign-grid">
                            <div className="left">
                              <div className="label">
                                Apposer signature précédée de la mention « bon pour réception »
                              </div>
                              <div className="cachet-label">Cachet et signature :</div>
                            </div>
                            <div className="right">
                              <div className="meta-row">Mention :</div>
                              <div className="meta-row">À :</div>
                              <div className="meta-row">Le :</div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>{/* /dv-content */}

                {/* Footer page 2 = tableau Page 2/2 · BL · Date · Paraphe
                    + mentions légales, identique à la page 1 pour cohérence
                    visuelle (le user trouvait la page 2 trop différente). */}
                <PageFooter pageNum={2} withMetaTable={true} />
              </div>{/* /dv-inner */}
            </div>
          </div>
        );
      })}
    </>
  );
}
