// Diff CSV initial (xlsx) vs base Firestore actuelle.
// Identifie : clients manquants, vélos manquants, devis qui divergent,
// et signale ce qui doit être protégé (modifs manuelles).
import admin from "firebase-admin";
import XLSX from "xlsx";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const wb = XLSX.readFile("/Users/yoannluzzato/Downloads/Les artisans vert - liste dossier vélo (3).xlsx");
const rows = XLSX.utils.sheet_to_json(wb.Sheets["LES ARTISANS VERT"], { defval: null, raw: false });

const norm = (s) => (s || "")
  .toString()
  .toUpperCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^A-Z0-9]+/g, " ")
  .trim();

// CSV → entrées (entreprise, ville, devis, ref, adresse)
const csvEntries = rows.map((r) => ({
  entreprise: r["RAISON SOCIALE \ndu bénéficiaire \nde l'opération"] || "",
  ville: r["VILLE"] || "",
  cp: r["CODE POSTAL\n(sans cedex)"] || "",
  adresse: r["ADRESSE \ndu siège social du bénéficiaire de l'opération"] || "",
  devis: parseInt(String(r["Nombre de vélos-cargos achetés ou loués dans le cadre de l'opération"] || "0").replace(/[^\d]/g,""),10) || 0,
  ref: r["REFERENCE interne de l'opération"] || "",
  apporteur: r["Apporteurs"] || "",
})).filter(e => e.entreprise);

console.log(`CSV : ${csvEntries.length} lignes\n`);

// Base : clients + vélos par client
const cs = await db.collection("clients").get();
const allVelos = await db.collection("velos").get();
const veloByClient = new Map();
for (const d of allVelos.docs) {
  const v = d.data();
  if (v.statut === "annule" || v.annule === true) continue;
  if (!veloByClient.has(v.clientId)) veloByClient.set(v.clientId, 0);
  veloByClient.set(v.clientId, veloByClient.get(v.clientId) + 1);
}

const dbByName = new Map();
for (const d of cs.docs) {
  const data = d.data();
  const key = norm(data.entreprise);
  if (!dbByName.has(key)) dbByName.set(key, []);
  dbByName.get(key).push({ id: d.id, ...data, cibles: veloByClient.get(d.id) || 0 });
}

// Liste de protection : noms qu'on ne touche pas (split manuel ou correction
// volontaire enregistrée dans la mémoire de la session)
const PROTECTED = new Set([
  "L AFRICA PARIS",          // 10 sites distincts
  "LOCATEX",                 // 2 sites
  "MILLENIUM",               // 2 sites
  "ALYSSAR",                 // devis 0 volontaire (annulé)
  // Corrections de stats déjà appliquées hier (compteurs OK, vélos OK)
  "BARBER SHOP 92",
  "FRANCE CONSEILS ECOLOGIE",
  "MANADVISE",
  "ANADOLU DISTRIBUTION",
  "CHEN LEO",
].map(norm));

// Diffs
const missingClients = [];   // dans CSV mais pas en base
const veloShortfall = [];    // client présent, vélos manquants
const devisMismatch = [];    // devis CSV ≠ devis base
const csvNotInBase = [];     // multiples lignes CSV pour un même nom
const seenCsvNames = new Map();

for (const e of csvEntries) {
  const key = norm(e.entreprise);
  seenCsvNames.set(key, (seenCsvNames.get(key) || 0) + 1);
}

for (const e of csvEntries) {
  const key = norm(e.entreprise);
  const protectedClient = PROTECTED.has(key);
  const inBase = dbByName.get(key);
  if (!inBase || inBase.length === 0) {
    missingClients.push({ ...e, key, protectedClient });
    continue;
  }
  // Match : si le nom apparaît plusieurs fois en base (split AFRICA, LOCATEX),
  // on essaie de matcher par adresse/CP. Sinon on prend le 1er.
  let match = inBase[0];
  if (inBase.length > 1) {
    const m = inBase.find((b) => norm(b.adresse) === norm(e.adresse) || (b.codePostal === e.cp && norm(b.ville) === norm(e.ville)));
    if (m) match = m;
  }
  const devisBase = Number(match.nbVelosCommandes || 0);
  const cibles = match.cibles;
  if (cibles < devisBase) {
    veloShortfall.push({ entreprise: match.entreprise, ville: match.ville, devis: devisBase, cibles, manquants: devisBase - cibles, csvDevis: e.devis, protectedClient });
  }
  if (devisBase !== e.devis) {
    devisMismatch.push({ entreprise: match.entreprise, ville: match.ville, base: devisBase, csv: e.devis, protectedClient });
  }
}

// Inverse : clients en base pas dans le CSV
const csvNames = new Set(csvEntries.map((e) => norm(e.entreprise)));
const inBaseNotCsv = [];
for (const [key, list] of dbByName) {
  if (!csvNames.has(key)) {
    for (const c of list) inBaseNotCsv.push({ id: c.id, entreprise: c.entreprise, ville: c.ville, devis: c.nbVelosCommandes || 0, cibles: c.cibles });
  }
}

console.log(`━━━ 1) Clients dans CSV mais ABSENTS de la base : ${missingClients.length}`);
for (const c of missingClients.slice(0, 20)) {
  console.log(`  · ${c.entreprise} (${c.ville}) · devis ${c.devis}${c.protectedClient ? " [PROTÉGÉ]" : ""}`);
}
if (missingClients.length > 20) console.log(`  … et ${missingClients.length - 20} autres`);

console.log(`\n━━━ 2) Clients avec VÉLOS MANQUANTS (cibles < devis base) : ${veloShortfall.length}`);
let totalManquants = 0;
for (const v of veloShortfall.sort((a,b)=>b.manquants-a.manquants)) {
  totalManquants += v.manquants;
  const flag = v.protectedClient ? " [PROTÉGÉ]" : "";
  const csvNote = v.csvDevis !== v.devis ? ` (CSV dit ${v.csvDevis})` : "";
  console.log(`  · ${v.entreprise.padEnd(40)} devis ${String(v.devis).padStart(4)} · cibles ${String(v.cibles).padStart(4)} · manquants ${String(v.manquants).padStart(3)}${csvNote}${flag}`);
}
console.log(`  TOTAL vélos à recréer : ${totalManquants}`);

console.log(`\n━━━ 3) Devis BASE ≠ CSV (potentielles corrections manuelles à respecter) : ${devisMismatch.length}`);
for (const d of devisMismatch.slice(0, 30)) {
  console.log(`  · ${d.entreprise.padEnd(40)} base ${String(d.base).padStart(4)} · CSV ${String(d.csv).padStart(4)} · diff ${String(d.csv - d.base).padStart(4)}${d.protectedClient ? " [PROTÉGÉ]" : ""}`);
}
if (devisMismatch.length > 30) console.log(`  … et ${devisMismatch.length - 30} autres`);

console.log(`\n━━━ 4) Clients en BASE mais ABSENTS du CSV : ${inBaseNotCsv.length}`);
for (const c of inBaseNotCsv.slice(0, 20)) {
  console.log(`  · ${c.entreprise} (${c.ville}) · devis ${c.devis} · cibles ${c.cibles}`);
}
if (inBaseNotCsv.length > 20) console.log(`  … et ${inBaseNotCsv.length - 20} autres`);

// Doublons CSV (ex AFRICA PARIS)
const dupCsv = [];
for (const [k, n] of seenCsvNames) if (n > 1) dupCsv.push({ key: k, count: n });
console.log(`\n━━━ 5) Doublons dans le CSV (même raison sociale, plusieurs lignes) : ${dupCsv.length}`);
for (const d of dupCsv.slice(0, 10)) console.log(`  · ${d.key} : ${d.count}× lignes`);

process.exit(0);
