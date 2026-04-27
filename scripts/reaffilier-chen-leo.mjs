/**
 * Re-affilie 3 vélos orphelins (clientId=null) à CHEN LEO pour pouvoir
 * relancer le scan de prép. Garde fnuci=null pour que assignFnuciToClient
 * puisse poser les FNUCI au scan (sinon "tous les vélos ont déjà un FNUCI").
 */
import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const CLIENT_ID = "cmoa7maty01hqb2g2laqluwu4";
const APPLY = process.argv.includes("--apply");
// IDs des 3 vélos qui étaient à CHEN LEO (vus dans le dry-run précédent).
const VELO_IDS = [
  "254414da-8c20-4610-85e6-39f6533e5d97",
  "877e246b-74bb-41bd-bf6f-21cc7fa88d63",
  "df80c6e7-9a6b-453e-b423-f5db0568ba39",
];

console.log(`Mode: ${APPLY ? "APPLY ✍️" : "DRY-RUN 👀"}`);

if (APPLY) {
  const batch = db.batch();
  for (const id of VELO_IDS) {
    batch.update(db.collection("velos").doc(id), {
      clientId: CLIENT_ID,
      // fnuci reste null → assignFnuciToClient pourra le poser
      annule: false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
  console.log(`✅ ${VELO_IDS.length} vélos réaffiliés à CHEN LEO (slots vides).`);
} else {
  console.log("Vélos à réaffilier :");
  for (const id of VELO_IDS) console.log(`  - ${id}`);
  console.log("\n👉 Relance avec --apply.");
}
process.exit(0);
