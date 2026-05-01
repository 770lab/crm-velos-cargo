import admin from "firebase-admin";
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

console.log("\n=== Client DOSTLAR FRANCE ===");
const cSnap = await db.collection("clients").where("entreprise", "==", "DOSTLAR FRANCE").get();
const clientId = cSnap.docs[0]?.id;
console.log("clientId:", clientId);

const vSnap = await db.collection("velos").where("clientId", "==", clientId).get();
console.log(`\n=== ${vSnap.size} velos DOSTLAR (etat actuel serveur) ===`);
let nbCharges = 0;
let nbPrep = 0;
for (const d of vSnap.docs) {
  const v = d.data();
  if (v.annule) continue;
  const charge = !!v.dateChargement;
  if (charge) nbCharges++;
  if (v.datePreparation) nbPrep++;
  console.log(`  ${d.id.slice(0, 6)} fnuci=${(v.fnuci || "?").padEnd(11)} prep=${v.datePreparation ? "✓" : " "} charge=${charge ? "✓" : " "} livre=${v.dateLivraisonScan ? "✓" : " "} cartonToken=${v.cartonToken || "-"}`);
}
console.log(`\nTotal : ${nbPrep} prepares, ${nbCharges} charges`);

console.log("\n=== Doublons cartonToken DOSTLAR ? ===");
const tokenCount = new Map();
for (const d of vSnap.docs) {
  const v = d.data();
  if (v.annule || !v.cartonToken) continue;
  tokenCount.set(v.cartonToken, (tokenCount.get(v.cartonToken) || 0) + 1);
}
let doublonsToken = 0;
for (const [t, n] of tokenCount.entries()) {
  if (n > 1) {
    console.log(`  ⚠ ${t} sur ${n} vélos`);
    doublonsToken++;
  }
}
if (doublonsToken === 0) console.log("  (aucun doublon)");
process.exit(0);
