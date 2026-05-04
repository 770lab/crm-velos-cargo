// Yoann 2026-05-04 — HALLE MARKET : 35 vélos commandés mais seulement 25
// avec FNUCI scanné. Camion parti avec 35 (physiquement). On force les
// 10 vélos cibles sans FNUCI à datePreparation + dateChargement pour
// que les compteurs soient corrects. Les FNUCI manquants seront à
// rescanner manuellement plus tard si besoin.
//
//   node scripts/fix-force-charge-halle-market.mjs           # DRY-RUN
//   node scripts/fix-force-charge-halle-market.mjs --apply   # APPLY
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();
const APPLY = process.argv.includes("--apply");

const cSnap = await db.collection("clients")
  .where("entreprise", "==", "HALLE MARKET").get();
if (cSnap.empty) { console.log("client introuvable"); process.exit(1); }
const cDoc = cSnap.docs[0];
const c = cDoc.data();
console.log(`Client ${c.entreprise} (${cDoc.id})`);
console.log(`  nbVelosCommandes=${c.nbVelosCommandes}`);

const vSnap = await db.collection("velos").where("clientId", "==", cDoc.id).get();
let nbForcePrep = 0;
let nbForceCharge = 0;
let nbAlreadyDone = 0;
const nowIso = new Date().toISOString();
const now = admin.firestore.FieldValue.serverTimestamp();
for (const vd of vSnap.docs) {
  const v = vd.data();
  if (v.annule) continue;
  if (v.dateChargement && v.datePreparation) { nbAlreadyDone++; continue; }
  const updates = { updatedAt: now };
  let action = [];
  if (!v.datePreparation) {
    updates.datePreparation = nowIso;
    updates.preparationForceReason = "fix-force-charge-halle-market — 10 cibles sans FNUCI, camion parti avec 35 physiques";
    nbForcePrep++;
    action.push("prep");
  }
  if (!v.dateChargement) {
    updates.dateChargement = nowIso;
    updates.chargementForceReason = "fix-force-charge-halle-market — 10 cibles sans FNUCI, camion parti avec 35 physiques";
    nbForceCharge++;
    action.push("charge");
  }
  console.log(`  ${vd.id.slice(0, 8)}…  fnuci=${v.fnuci || "—"}  → force ${action.join(" + ")}`);
  if (APPLY && action.length > 0) {
    await db.collection("velos").doc(vd.id).update(updates);
  }
}
console.log(`\n${APPLY ? "✓ APPLIQUÉ" : "(DRY-RUN)"}`);
console.log(`  ${nbForcePrep} préparations forcées`);
console.log(`  ${nbForceCharge} chargements forcés`);
console.log(`  ${nbAlreadyDone} déjà OK`);
process.exit(0);
