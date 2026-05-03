import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();
const all = await db.collection("velos").get();
let n = 0;
for (const vd of all.docs) {
  const v = vd.data();
  const fnuci = String(v.fnuci || "");
  if (!fnuci.startsWith("BCZ9CANA")) continue;
  n++;
  console.log(`  ${fnuci} (${vd.id}) annule=${v.annule} datePrep=${v.datePreparation}`);
}
console.log(`\nTOTAL FNUCI BCZ9CANA* encore actifs : ${n}`);
process.exit(0);
