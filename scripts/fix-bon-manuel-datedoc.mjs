// Backfill dateDoc sur les bons manuels qui en sont dépourvus (sinon
// invisibles côté Finances qui filtre par dateDoc).
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const APPLY = process.argv.includes("--apply");
console.log(`\n=== ${APPLY ? "APPLY" : "DRY-RUN"} backfill dateDoc bons manuels ===\n`);

const snap = await db.collection("bonsEnlevement").get();
let scanned = 0;
let toFix = 0;
const updates = [];

for (const d of snap.docs) {
  scanned++;
  const data = d.data();
  const hasDateDoc = typeof data.dateDoc === "string" && data.dateDoc.length >= 10;
  if (hasDateDoc) continue;
  toFix++;
  // Source la dateDoc à partir de receivedAt en priorité, sinon createdAt
  let dateDoc = null;
  if (typeof data.receivedAt === "string") {
    dateDoc = data.receivedAt.slice(0, 10);
  } else if (data.createdAt?.toDate) {
    dateDoc = data.createdAt.toDate().toISOString().slice(0, 10);
  } else {
    // Fallback : aujourd'hui
    dateDoc = new Date().toISOString().slice(0, 10);
  }
  updates.push({ id: d.id, ref: d.ref, numeroDoc: data.numeroDoc, manual: data.manual === true, dateDoc });
}

console.log(`Scannés : ${scanned} · sans dateDoc : ${toFix}\n`);
for (const u of updates) {
  console.log(`  ${u.manual ? "[manuel]" : "[auto]  "} ${u.id.padEnd(40)} numeroDoc=${u.numeroDoc} → dateDoc=${u.dateDoc}`);
}

if (!APPLY) {
  console.log(`\n(dry-run, relance avec --apply pour persister)\n`);
  process.exit(0);
}
if (toFix === 0) {
  console.log("Rien à corriger.\n");
  process.exit(0);
}

const batch = db.batch();
for (const u of updates) {
  batch.set(u.ref, { dateDoc: u.dateDoc, dateDocBackfilledAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
}
await batch.commit();
console.log(`\n✓ ${toFix} bons mis à jour.\n`);
process.exit(0);
