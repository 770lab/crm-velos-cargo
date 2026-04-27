import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();
const snap = await db.collection("velos").where("fnuci", "==", "BC6AHEK88E").get();
console.log(`BC6AHEK88E trouvé sur ${snap.size} vélo(s):`);
for (const d of snap.docs) {
  const v = d.data();
  console.log(`  - ${d.id}  clientId=${v.clientId}  annule=${v.annule}`);
}
process.exit(0);
