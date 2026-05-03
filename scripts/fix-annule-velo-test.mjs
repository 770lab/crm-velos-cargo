import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();
const veloId = "cmoa7mavv01s2b2g2plfcrsy0";
await db.collection("velos").doc(veloId).update({
  annule: true,
  annuleAt: admin.firestore.FieldValue.serverTimestamp(),
  annuleReason: "Test affiliation Jordan (Yoann 2026-05-03)",
  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
});
console.log(`✓ Vélo ${veloId} (BCZ9CANA4D) annulé`);
process.exit(0);
