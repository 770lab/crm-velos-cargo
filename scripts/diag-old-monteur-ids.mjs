// Cherche où sont référencés les IDs des anciens monteurs "3", "6", "8".
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const SUSPECT_IDS = [
  "0XKiDFvni7VHDeJxxo2i1035Bpk1", // "3"
  "7cqeoeXxlnOYDSuS2wgnSQxbPJ62", // "3"
  "iT4TfcjRAzW1pLPrrzUmdnM3mgz1", // "6"
  "qLOEPNOwKpQozrwPfjXEy7yS4v62", // "8"
  "stBJtQ0MLEStzE3TZAHfFlbv77G3", // "7"
  "vh7MddQzIaS7eoRhhWEPIcAPOQ22", // "2"
  "vhUnClNF3KdrrT8iibCrbrMAdGu1", // "5"
];

const livSnap = await db.collection("livraisons").get();
console.log("\n=== Livraisons référençant les anciens monteurIds ===\n");
let count = 0;
for (const d of livSnap.docs) {
  const l = d.data();
  if (l.statut === "annulee") continue;
  const monteurIds = Array.isArray(l.monteurIds) ? l.monteurIds : [];
  const chefIds = [...(Array.isArray(l.chefEquipeIds) ? l.chefEquipeIds : []), ...(l.chefEquipeId ? [l.chefEquipeId] : [])];
  const overlap = [...monteurIds, ...chefIds].filter((id) => SUSPECT_IDS.includes(id));
  if (overlap.length > 0) {
    let date = "?";
    if (typeof l.datePrevue === "string") date = l.datePrevue.slice(0, 10);
    else if (l.datePrevue?.toDate) date = l.datePrevue.toDate().toISOString().slice(0, 10);
    console.log(`  ${date}  ${l.clientSnapshot?.entreprise || l.clientId}  liv=${d.id} statut=${l.statut}`);
    console.log(`    refs : ${overlap.join(", ")}`);
    count++;
  }
}
console.log(`\n${count} livraisons avec ces anciens IDs.\n`);

// Cherche aussi dans sessionsMontageAtelier
console.log("=== Sessions atelier référençant ces IDs ===\n");
const sSnap = await db.collection("sessionsMontageAtelier").get();
let countS = 0;
for (const d of sSnap.docs) {
  const s = d.data();
  const monteurIds = Array.isArray(s.monteurIds) ? s.monteurIds : [];
  const overlap = monteurIds.filter((id) => SUSPECT_IDS.includes(id));
  if (overlap.length > 0) {
    console.log(`  ${s.date}  entrepot=${s.entrepotNom}  session=${d.id} statut=${s.statut}`);
    console.log(`    refs : ${overlap.join(", ")}`);
    countS++;
  }
}
console.log(`\n${countS} sessions atelier avec ces anciens IDs.\n`);
process.exit(0);
