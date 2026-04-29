"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { gasGet } from "@/lib/gas";

type Velo = { veloId: string; fnuci: string | null };
type Client = { clientId: string; entreprise: string; ville: string; adresse: string; codePostal: string; velos: Velo[] };
type Progression =
  | { tourneeId: string; datePrevue: string | null; clients: Client[] }
  | { error: string };

// Format imprimante thermique 100×150 mm (rouleau standard) — 1 étiquette
// par "planche" (pas de découpe à faire). Anciennement A4 6/feuille.
const PER_PAGE = 1;
const LABEL_WIDTH_MM = 100;
const LABEL_HEIGHT_MM = 150;

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

  // Bug observé en prod : si gasGet est lent ou silently fail, la page restait
  // bloquée sur "Chargement…" sans header → pas de bouton Imprimer visible.
  // On affiche maintenant le header en permanence et on calcule les pages avec
  // un tableau vide tant que data n'est pas dispo. Le bouton se désactive.
  const isLoading = !data;
  const hasError = data && "error" in data;
  const safeData = data && !("error" in data) ? data : null;
  // Numérotation par ordre de chargement camion (LIFO) : on inverse la liste
  // des clients car le dernier livré est le premier chargé (au fond du
  // camion). En vue focus client unique, l'ordre n'a pas d'importance.
  const clients = safeData
    ? (focusClientId
        ? safeData.clients.filter((c) => c.clientId === focusClientId)
        : [...safeData.clients].reverse())
    : [];
  const items: { client: Client; velo: Velo; index: number; total: number; clientLoadOrder: number; totalClients: number }[] = [];
  let total = 0;
  clients.forEach((c) => { total += c.velos.length; });
  // clients est déjà dans l'ordre de chargement (reverse de l'ordre de livraison) :
  // 1er du tableau = chargé en premier (au fond du camion). On expose ce rang
  // pour l'afficher en gros sur l'étiquette (demande chauffeur/manutention).
  const totalClients = clients.length;
  let i = 0;
  clients.forEach((c, ci) => {
    c.velos.forEach((v) => {
      i++;
      items.push({ client: c, velo: v, index: i, total, clientLoadOrder: ci + 1, totalClients });
    });
  });

  const pages: typeof items[] = [];
  for (let p = 0; p < items.length; p += PER_PAGE) pages.push(items.slice(p, p + PER_PAGE));
  const dateStr = safeData?.datePrevue ? new Date(safeData.datePrevue).toLocaleDateString("fr-FR") : "";

  return (
    <>
      <style>{`
        @page { size: ${LABEL_WIDTH_MM}mm ${LABEL_HEIGHT_MM}mm; margin: 0; }
        @media print {
          .no-print { display: none !important; }
          body { background: white !important; }
          .sheet { page-break-after: always; }
          .sheet:last-child { page-break-after: auto; }
        }
        .sheet {
          width: ${LABEL_WIDTH_MM}mm; height: ${LABEL_HEIGHT_MM}mm;
          padding: 0;
          box-sizing: border-box;
          background: white;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .label {
          width: 100%; height: 100%;
          padding: 5mm;
          box-sizing: border-box;
          display: flex; flex-direction: column;
          color: #111;
          overflow: hidden;
        }
      `}</style>

      <div className="no-print fixed top-0 left-0 right-0 bg-white border-b shadow-sm z-50 px-4 py-2 flex items-center justify-between">
        <div className="text-sm">
          <span className="font-bold">🏷️ Étiquettes</span>
          <span className="text-gray-500 ml-2">Tournée {tourneeId} · {total} étiquettes · format {LABEL_WIDTH_MM}×{LABEL_HEIGHT_MM} mm (1/feuille)</span>
        </div>
        <button
          disabled={isLoading || hasError || pages.length === 0}
          onClick={async () => {
            // iPad moderne : UA = "Macintosh" mais ontouchend existe.
            // iPhone : UA contient "iPhone". On combine les deux pour détecter.
            const ua = navigator.userAgent;
            const isMobile =
              /Mobi|Android|iPhone|iPad|iPod/i.test(ua) ||
              (ua.includes("Macintosh") && "ontouchend" in document);

            // 1) Précharge tous les QR codes en data URL via fetch+Blob.
            //    Sans ça, l'image <img src="api.qrserver.com..."> est encore
            //    en train de charger quand window.print() ou html2canvas
            //    capture la page → QR vide sur l'impression. Bug observé sur
            //    iOS Safari surtout (CORS strict + load async).
            const imgs = Array.from(document.querySelectorAll<HTMLImageElement>(".sheet img"));
            await Promise.all(
              imgs.map(async (img) => {
                if (img.src.startsWith("data:")) return;
                try {
                  const r = await fetch(img.src);
                  const b = await r.blob();
                  const dataUrl = await new Promise<string>((res, rej) => {
                    const fr = new FileReader();
                    fr.onload = () => res(fr.result as string);
                    fr.onerror = rej;
                    fr.readAsDataURL(b);
                  });
                  img.src = dataUrl;
                  await new Promise<void>((res) => {
                    if (img.complete) return res();
                    img.onload = () => res();
                    img.onerror = () => res();
                  });
                } catch {
                  // Si la précharge échoue, on continue : au pire le QR
                  // sera blanc sur cette étiquette plutôt que de bloquer
                  // toute l'impression.
                }
              }),
            );

            if (!isMobile) {
              window.print();
              return;
            }
            // iOS / mobile : window.print() est cassé sur les pages complexes,
            // et window.open(blob:) après await est bloqué par le popup
            // blocker (Safari sort de la stack d'event click pendant l'await).
            // window.open(blob:) qui passe peut aussi rendre le PDF comme du
            // texte/HTML selon la version iOS — comportement non fiable.
            //
            // Stratégie : déclencher un VRAI download de fichier .pdf. iOS
            // Safari affiche alors la bannière "Télécharger" → tap → ouvre
            // dans le viewer PDF natif → bouton Partager → app de
            // l'imprimante thermique (Phomemo / Bytecintia / etc. en
            // Bluetooth) ou AirPrint. C'est le flux que les utilisateurs
            // d'imprimantes thermiques connaissent déjà.
            try {
              // html2pdf.js bundle un html2canvas qui ne sait pas parser les
              // couleurs CSS modernes (oklch / lab / lch) que Tailwind v4
              // utilise par défaut → erreur "unsupported color function lab".
              // On utilise html2canvas-pro (fork compatible oklch) + jsPDF
              // direct au lieu de html2pdf.
              const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
                import("html2canvas-pro"),
                import("jspdf"),
              ]);
              const sheets = Array.from(document.querySelectorAll<HTMLElement>(".sheet"));
              if (!sheets.length) return;
              const pdf = new jsPDF({
                unit: "mm",
                // Format custom 100×150mm (rouleau thermique). Doit matcher
                // exactement le @page CSS pour que la mise en page soit
                // pixel-perfect entre l'aperçu écran et le PDF.
                format: [LABEL_WIDTH_MM, LABEL_HEIGHT_MM],
                orientation: "portrait",
              });
              for (let i = 0; i < sheets.length; i++) {
                const canvas = await html2canvas(sheets[i], {
                  scale: 2,
                  useCORS: true,
                  backgroundColor: "#ffffff",
                });
                const imgData = canvas.toDataURL("image/jpeg", 0.95);
                if (i > 0) pdf.addPage([LABEL_WIDTH_MM, LABEL_HEIGHT_MM], "portrait");
                pdf.addImage(imgData, "JPEG", 0, 0, LABEL_WIDTH_MM, LABEL_HEIGHT_MM);
              }
              // .save() jsPDF déclenche un download natif avec MIME
              // application/pdf et extension .pdf — iOS Safari l'identifie
              // correctement et l'ouvre dans son viewer PDF natif.
              pdf.save(`etiquettes-${tourneeId}.pdf`);
            } catch (e) {
              alert("Erreur génération PDF : " + (e instanceof Error ? e.message : String(e)));
            }
          }}
          className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
        >
          🖨️ Imprimer
        </button>
      </div>

      <div className="no-print h-12" />

      {isLoading && (
        <div className="p-8 text-center text-gray-500">Chargement…</div>
      )}
      {hasError && data && "error" in data && (
        <div className="p-8 text-center text-red-600">{data.error}</div>
      )}

      <div className="bg-gray-100 print:bg-white py-4 print:py-0">
        {pages.map((pageItems, pi) => (
          <div key={pi} className="sheet mx-auto print:mx-0 my-3 print:my-0 shadow print:shadow-none">
            {pageItems.map(({ client, velo, index, total, clientLoadOrder, totalClients }) => {
              // QR identique pour TOUTES les étiquettes d'un même client : on
              // encode le clientId (= identifiant interne CRM, sert au suivi
              // chargement/livraison/montage). Le BicyCode FNUCI est hors CRM
              // après la préparation, on le garde juste comme info en petit.
              const qrPayload = client.clientId;
              const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(qrPayload)}`;
              // En mode focus 1 client, l'ordre de chargement n'a pas de sens
              // (le seul client est forcément "1/1"). On le masque.
              const showLoadOrder = !focusClientId && totalClients > 1;
              const loadLabel = clientLoadOrder === 1
                ? "CHARGER EN PREMIER"
                : `CHARGER EN ${clientLoadOrder}ème`;
              return (
                <div key={velo.veloId} className="label">
                  <div style={{ fontSize: "10px", color: "#666", display: "flex", justifyContent: "space-between" }}>
                    <span>Tournée {tourneeId}{dateStr ? " · " + dateStr : ""}</span>
                    <span>{index}/{total}</span>
                  </div>
                  {showLoadOrder && (
                    // Bandeau "ordre de chargement" — gros chiffre + texte court.
                    // Demande chauffeur : voir d'un coup d'œil dans quel ordre
                    // empiler les vélos au chargement du camion (LIFO = 1er chargé,
                    // dernier livré, au fond du camion).
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "3mm",
                        marginTop: "2mm",
                        padding: "2mm 3mm",
                        background: clientLoadOrder === 1 ? "#000" : "#f3f4f6",
                        color: clientLoadOrder === 1 ? "#fff" : "#111",
                        border: clientLoadOrder === 1 ? "none" : "1.5px solid #111",
                        borderRadius: "2mm",
                      }}
                    >
                      <div style={{ fontSize: "44px", fontWeight: 900, lineHeight: 1, letterSpacing: "-2px" }}>
                        {clientLoadOrder}
                      </div>
                      <div style={{ fontSize: "11px", fontWeight: 800, lineHeight: 1.1, letterSpacing: "0.3px" }}>
                        {loadLabel}<br />
                        <span style={{ fontWeight: 500, opacity: 0.8 }}>sur {totalClients} clients</span>
                      </div>
                    </div>
                  )}
                  {/* Nom client énorme : c'est l'info la plus utile pour le
                      chauffeur / monteur qui lit l'étiquette à distance. */}
                  <div
                    style={{
                      fontWeight: 900,
                      fontSize: "30px",
                      lineHeight: 1.05,
                      wordBreak: "break-word",
                      marginTop: "3mm",
                      letterSpacing: "-0.3px",
                    }}
                  >
                    {client.entreprise}
                  </div>
                  {/* QR pleine largeur centré + adresse + ref dessous —
                      layout vertical pour exploiter les 150mm de hauteur
                      du rouleau thermique. */}
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flex: 1, minHeight: 0, marginTop: "4mm" }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={qrUrl} alt={qrPayload} style={{ width: "60mm", height: "60mm" }} />
                  </div>
                  <div style={{ fontSize: "13px", color: "#222", lineHeight: 1.3, textAlign: "center", marginTop: "3mm" }}>
                    {client.adresse}<br />
                    {client.codePostal} {client.ville}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}
