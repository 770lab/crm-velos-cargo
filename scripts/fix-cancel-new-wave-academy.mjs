// Yoann 2026-05-03 — NEW WAVE ACADEMY = client de test à supprimer.
// Soft-cancel client + son/ses vélo(s) + livraison(s).
//
//   node scripts/fix-cancel-new-wave-academy.mjs           # DRY-RUN
//   node scripts/fix-cancel-new-wave-academy.mjs --apply   # APPLY
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();
const APPLY = process.argv.includes("--apply");
const FieldValue = admin.firestore.FieldValue;

const CID = "cmoa7mar90170b2g2pb82ij8r"; // NEW WAVE ACADEMY (cf. fix-annule-clients-plantes.mjs)
const REASON = "Client de test — Yoann 2026-05-03";

console.log(`\n=== ${APPLY ? "APPLY" : "DRY-RUN"} cancel NEW WAVE ACADEMY ===\n`);

const cDoc = await db.collection("clients").doc(CID).get();
if (!cDoc.exists) {
  console.log("⚠ Client introuvable");
  process.exit(1);
}
const c = cDoc.data();
console.log(`Client : ${c.entreprise} (${c.ville})`);

// Vélos
const vSnap = await db.collection("velos").where("clientId", "==", CID).get();
let nbV = 0;
for (const vd of vSnap.docs) {
  const v = vd.data();
  if (v.annule) continue;
  console.log(`  vélo ${v.fnuci || "(sans fnuci)"} (${vd.id}) → annulé`);
  if (APPLY) {
    await vd.ref.update({
      annule: true,
      annuleAt: FieldValue.serverTimestamp(),
      annuleReason: REASON,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  nbV++;
}

// Livraisons
const lvSnap = await db.collection("livraisons").where("clientId", "==", CID).get();
let nbL = 0;
for (const ld of lvSnap.docs) {
  const l = ld.data();
  if (String(l.statut || "").toLowerCase() === "annulee") continue;
  console.log(`  livraison ${ld.id} → annulee`);
  if (APPLY) {
    await ld.ref.update({
      statut: "annulee",
      annuleAt: FieldValue.serverTimestamp(),
      annuleReason: REASON,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  nbL++;
}

// Client
console.log(`  client → annulee`);
if (APPLY) {
  await cDoc.ref.update({
    statut: "annulee",
    annulee: true,
    annuleeAt: FieldValue.serverTimestamp(),
    raisonAnnulation: REASON,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

console.log(`\n${APPLY ? "✓" : "(dry-run)"} client + ${nbV} vélos + ${nbL} livraisons annulés`);
process.exit(0);
