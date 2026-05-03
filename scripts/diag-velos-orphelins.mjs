// Liste les vélos avec FNUCI mais sans dateLivraisonScan = affiliés mais
// jamais livrés. Détection des "clients qui ont planté" + tests oubliés.
import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();
const vSnap = await db.collection("velos").where("fnuci", ">", "").get();
const cSnap = await db.collection("clients").get();
const cliMap = new Map();
for (const d of cSnap.docs) cliMap.set(d.id, d.data());

const groupes = new Map(); // clientId → { entreprise, prepares: 0, charges: 0, livres: 0, total: 0 }
let totalAffilies = 0;
let totalLivres = 0;
let totalAnnules = 0;
for (const d of vSnap.docs) {
  const v = d.data();
  if (v.annule) { totalAnnules++; continue; }
  totalAffilies++;
  const cid = String(v.clientId || "");
  if (!cid) continue;
  if (!groupes.has(cid)) {
    const c = cliMap.get(cid) || {};
    groupes.set(cid, { entreprise: c.entreprise || "?", ville: c.ville || "", apporteur: c.apporteur || "", prepares: 0, charges: 0, livres: 0, total: 0, nbCmd: c.nbVelosCommandes || 0 });
  }
  const g = groupes.get(cid);
  g.total++;
  if (v.datePreparation) g.prepares++;
  if (v.dateChargement) g.charges++;
  if (v.dateLivraisonScan) { g.livres++; totalLivres++; }
}

console.log(`\n=== Stats globales ===`);
console.log(`  Vélos avec FNUCI (non annulés) : ${totalAffilies}`);
console.log(`  Vélos livrés (dateLivraisonScan posé) : ${totalLivres}`);
console.log(`  Vélos annulés : ${totalAnnules}`);
console.log(`  ⚠️ Affiliés non livrés : ${totalAffilies - totalLivres}\n`);

console.log("=== Clients avec vélos affiliés non livrés (potentiellement plantés) ===\n");
const candidats = [...groupes.entries()]
  .filter(([, g]) => g.total > g.livres)
  .sort((a, b) => (b[1].total - b[1].livres) - (a[1].total - a[1].livres));
for (const [cid, g] of candidats.slice(0, 30)) {
  const orphelins = g.total - g.livres;
  console.log(`  ${g.entreprise.padEnd(35)} | ${g.ville.padEnd(20)} | ${g.total} affilés · ${g.livres} livrés · ${orphelins} restants | apporteur=${g.apporteur} | nbCmd=${g.nbCmd} | id=${cid}`);
}
console.log(`\nTotal : ${candidats.length} clients avec vélos affiliés non livrés.`);
process.exit(0);
