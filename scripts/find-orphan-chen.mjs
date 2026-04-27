import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const CHEN_LEO_FNUCIS = ["BCZ9CANA4D", "BC38FKZZ7H", "BCA24SN97A"];

console.log("=== Vélos avec FNUCI CHEN LEO ===");
const snap = await db.collection("velos").where("fnuci", "in", CHEN_LEO_FNUCIS).get();
console.log(`Trouvés : ${snap.size}`);
for (const d of snap.docs) {
  const v = d.data();
  console.log(`  - ${d.id}  fnuci=${v.fnuci}  clientId=${v.clientId || "—"}  prep=${!!v.datePreparation}`);
}

console.log("\n=== Vélos sans clientId (orphelins) ===");
const orphSnap = await db.collection("velos").where("clientId", "==", null).get();
console.log(`Trouvés : ${orphSnap.size}`);
let count = 0;
for (const d of orphSnap.docs) {
  const v = d.data();
  if (CHEN_LEO_FNUCIS.includes(v.fnuci) || (count < 5 && !v.fnuci)) {
    console.log(`  - ${d.id}  fnuci=${v.fnuci || "—"}  annule=${v.annule}`);
    count++;
  }
}
process.exit(0);
