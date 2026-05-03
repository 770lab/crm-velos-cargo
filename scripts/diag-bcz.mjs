import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();
const v = await db.collection("velos").where("fnuci", "==", "BCZ9CANA4W").get();
console.log(`BCZ9CANA4W : ${v.size} vélos`);
for (const vd of v.docs) {
  const vv = vd.data();
  const c = await db.collection("clients").doc(vv.clientId).get();
  console.log(`  ${vd.id} clientId=${vv.clientId} (${c.exists ? c.data().entreprise : "?"}) annule=${vv.annule}`);
}
process.exit(0);
