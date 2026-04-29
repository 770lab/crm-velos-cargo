// Aligne nbVelosCommandes sur la valeur du CSV initial pour les clients
// non protégés. À lancer en dry-run d'abord, puis avec --apply.
import admin from "firebase-admin";
import XLSX from "xlsx";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const APPLY = process.argv.includes("--apply");
const wb = XLSX.readFile("/Users/yoannluzzato/Downloads/Les artisans vert - liste dossier vélo (3).xlsx");
const rows = XLSX.utils.sheet_to_json(wb.Sheets["LES ARTISANS VERT"], { defval: null, raw: false });

const norm = (s) => (s || "")
  .toString()
  .toUpperCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^A-Z0-9]+/g, " ")
  .trim();

// Liste de protection (modifs manuelles à NE PAS écraser)
const PROTECTED = new Set([
  "L AFRICA PARIS",      // 10 sites distincts
  "LOCATEX",             // 2 sites
  "MILLENIUM",           // 2 sites
  "ALYSSAR",             // 0 volontaire (annulé)
  "ANADOLU DISTRIBUTION",// devis ajusté à la main
  "GLOBAL CONSEIL ENERGIE", // cas curieux confirmé manuel
  "CHARR HALAL",         // cas curieux confirmé manuel
].map(norm));

const csvByName = new Map();
for (const r of rows) {
  const name = r["RAISON SOCIALE \ndu bénéficiaire \nde l'opération"];
  if (!name) continue;
  const devis = parseInt(String(r["Nombre de vélos-cargos achetés ou loués dans le cadre de l'opération"] || "0").replace(/[^\d]/g,""),10) || 0;
  const key = norm(name);
  // Cas doublons CSV (LOCATEX, MILLENIUM, AFRICA) : on ignore — protégés.
  if (csvByName.has(key)) {
    csvByName.set(key, { duplicate: true });
    continue;
  }
  csvByName.set(key, { devis, ville: r["VILLE"], cp: r["CODE POSTAL\n(sans cedex)"] });
}

const cs = await db.collection("clients").get();
const fixes = [];
const skipped = [];
for (const d of cs.docs) {
  const data = d.data();
  const key = norm(data.entreprise);
  if (PROTECTED.has(key)) { skipped.push({ entreprise: data.entreprise, raison: "PROTÉGÉ" }); continue; }
  const csv = csvByName.get(key);
  if (!csv || csv.duplicate) { skipped.push({ entreprise: data.entreprise, raison: csv?.duplicate ? "doublon CSV" : "absent CSV" }); continue; }
  const baseDevis = Number(data.nbVelosCommandes || 0);
  if (baseDevis === csv.devis) continue;
  fixes.push({ id: d.id, entreprise: data.entreprise, ville: data.ville, from: baseDevis, to: csv.devis });
}

fixes.sort((a, b) => Math.abs(b.from - b.to) - Math.abs(a.from - a.to));
console.log(`${fixes.length} clients à aligner (${skipped.length} skip dont protégés/CSV absent/doublon)\n`);
for (const f of fixes) {
  console.log(`  ${f.entreprise.padEnd(45)} ${String(f.from).padStart(4)} → ${String(f.to).padStart(4)} (Δ ${f.to - f.from > 0 ? "+" : ""}${f.to - f.from})`);
}
const totalDelta = fixes.reduce((s, f) => s + (f.to - f.from), 0);
console.log(`\nDelta cumulé sur SUM(nbVelosCommandes) : ${totalDelta > 0 ? "+" : ""}${totalDelta}`);

if (!APPLY) {
  console.log("\nDry-run. Relance avec --apply pour écrire.");
  process.exit(0);
}

const batchSize = 400;
for (let i = 0; i < fixes.length; i += batchSize) {
  const batch = db.batch();
  for (const f of fixes.slice(i, i + batchSize)) {
    batch.set(db.collection("clients").doc(f.id), {
      nbVelosCommandes: f.to,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  await batch.commit();
  console.log(`Commit ${Math.min(i + batchSize, fixes.length)}/${fixes.length}`);
}
console.log("✓ Terminé");
process.exit(0);
