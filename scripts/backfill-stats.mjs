// Recalcule clients/{id}.stats.{totalVelos,prepares,charges,livres} depuis
// l'état actuel des vélos. À lancer une seule fois après déploiement du
// trigger onVeloWriteSyncClientStats — ensuite les compteurs sont auto.
import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const APPLY = process.argv.includes("--apply");

const clients = await db.collection("clients").get();
const velos = await db.collection("velos").get();

// Aggrégats par clientId
const agg = new Map();
for (const d of velos.docs) {
  const v = d.data();
  if (v.statut === "annule" || v.annule === true) continue;
  const cid = v.clientId;
  if (!cid) continue;
  if (!agg.has(cid)) agg.set(cid, { totalVelos: 0, prepares: 0, charges: 0, livres: 0 });
  const a = agg.get(cid);
  a.totalVelos++;
  if (v.datePreparation) a.prepares++;
  if (v.dateChargement) a.charges++;
  if (v.dateLivraisonScan) a.livres++;
}

let needFix = 0;
const fixes = [];
for (const c of clients.docs) {
  const d = c.data();
  const stats = d.stats || {};
  const real = agg.get(c.id) || { totalVelos: 0, prepares: 0, charges: 0, livres: 0 };
  const diff = {};
  for (const k of ["totalVelos", "prepares", "charges", "livres"]) {
    if ((stats[k] || 0) !== real[k]) diff[k] = { from: stats[k] || 0, to: real[k] };
  }
  if (Object.keys(diff).length === 0) continue;
  needFix++;
  fixes.push({ id: c.id, entreprise: d.entreprise, diff, real });
}

console.log(`${clients.size} clients, ${velos.size} vélos, ${needFix} clients à corriger.\n`);
for (const f of fixes.slice(0, 30)) {
  const parts = Object.entries(f.diff).map(([k, v]) => `${k}: ${v.from}→${v.to}`).join(", ");
  console.log(`  ${f.entreprise.padEnd(40)} ${parts}`);
}
if (fixes.length > 30) console.log(`  … et ${fixes.length - 30} autres`);

if (!APPLY) {
  console.log("\nDry-run. Relance avec --apply pour écrire.");
  process.exit(0);
}

const batchSize = 400;
for (let i = 0; i < fixes.length; i += batchSize) {
  const batch = db.batch();
  for (const f of fixes.slice(i, i + batchSize)) {
    batch.set(db.collection("clients").doc(f.id), { stats: f.real }, { merge: true });
  }
  await batch.commit();
  console.log(`Commit ${Math.min(i + batchSize, fixes.length)}/${fixes.length}`);
}
console.log("✓ Terminé");
process.exit(0);
