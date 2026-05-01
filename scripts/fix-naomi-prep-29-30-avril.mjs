// Backfill preparateurId=Naomi + étale datePreparation sur 3h pour les
// 29 et 30 avril. Yoann 2026-05-01.
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const APPLY = process.argv.includes("--apply");
const NAOMI_ID = "JYS3NCBcrhS9YQFm9vodbgnt0j82"; // active

// Pour chaque jour : on étale datePreparation linéairement sur 3 heures.
// 29/04 : 09:00-12:00 Paris = 07:00-10:00 UTC
// 30/04 : 09:00-12:00 Paris = 07:00-10:00 UTC
const SESSIONS = [
  { date: "2026-04-29", startUTC: "2026-04-29T07:00:00.000Z", endUTC: "2026-04-29T10:00:00.000Z" },
  { date: "2026-04-30", startUTC: "2026-04-30T07:00:00.000Z", endUTC: "2026-04-30T10:00:00.000Z" },
];

console.log(`\n=== ${APPLY ? "APPLY" : "DRY-RUN"} backfill Naomi prep 29-30 avril ===\n`);

// Yoann 2026-05-01 : Naomi a préparé TOUS les vélos livrés. Donc on
// backfill preparateurId=Naomi sur tous les vélos avec datePreparation
// dans la journée concernée (sans passer par les livraisons).
const allVelosSnap = await db.collection("velos").get();
let totalToFix = 0;

for (const session of SESSIONS) {
  console.log(`\n--- ${session.date} (${session.startUTC} → ${session.endUTC}) ---`);
  const dayStart = new Date(session.date + "T00:00:00Z");
  const dayEnd = new Date(session.date + "T23:59:59Z");

  const velosToFix = [];
  for (const vd of allVelosSnap.docs) {
    const v = vd.data();
    if (v.annule === true) continue;
    if (!v.datePreparation) continue;
    let prepDate = null;
    if (typeof v.datePreparation === "string") prepDate = new Date(v.datePreparation);
    else if (v.datePreparation?.toDate) prepDate = v.datePreparation.toDate();
    if (!prepDate) continue;
    if (prepDate < dayStart || prepDate > dayEnd) continue;
    velosToFix.push({ ref: vd.ref, id: vd.id, fnuci: v.fnuci, hadPreparateurId: v.preparateurId });
  }
  console.log(`  ${velosToFix.length} vélos préparés ce jour à backfiller (Naomi)`);

  if (velosToFix.length === 0) continue;

  // 3) Étale linéairement les datePreparation sur la fenêtre 3h
  const startMs = new Date(session.startUTC).getTime();
  const endMs = new Date(session.endUTC).getTime();
  const step = velosToFix.length > 1 ? (endMs - startMs) / (velosToFix.length - 1) : 0;

  for (let i = 0; i < velosToFix.length; i++) {
    const v = velosToFix[i];
    const t = new Date(startMs + i * step);
    v.newDatePrep = t;
  }
  totalToFix += velosToFix.length;

  console.log(`  Premier scan = ${velosToFix[0].newDatePrep.toISOString()}`);
  console.log(`  Dernier scan = ${velosToFix[velosToFix.length - 1].newDatePrep.toISOString()}`);

  if (APPLY) {
    let written = 0;
    while (written < velosToFix.length) {
      const slice = velosToFix.slice(written, written + 400);
      const batch = db.batch();
      for (const v of slice) {
        batch.update(v.ref, {
          preparateurId: NAOMI_ID,
          datePreparation: admin.firestore.Timestamp.fromDate(v.newDatePrep),
          datePrepBackfilledAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      await batch.commit();
      written += slice.length;
      console.log(`  ✓ batch ${written}/${velosToFix.length}`);
    }
  }
}

console.log(`\n${APPLY ? "✓" : "(dry-run)"} ${totalToFix} vélos ${APPLY ? "backfillés" : "à backfiller"}`);
process.exit(0);
