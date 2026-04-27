import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const TOURNEE_ID = process.argv[2] || "818b8963";
console.log(`Tournée : ${TOURNEE_ID}\n`);

const livs = await db.collection("livraisons").where("tourneeId", "==", TOURNEE_ID).get();
let totalVelos = 0;
for (const d of livs.docs) {
  const l = d.data();
  const vSnap = await db.collection("velos").where("clientId", "==", l.clientId).get();
  const velos = vSnap.docs.filter((v) => !v.data().annule);
  const fini = velos.filter((v) => !!v.data().dateMontage).length;
  totalVelos += velos.length;
  console.log(
    `${(l.clientSnapshot?.entreprise || "?").padEnd(30)} ${velos.length} vélos · ${l.statut.padEnd(10)} · ${fini}/${velos.length} montés`,
  );
}
console.log(`\nTotal : ${livs.size} livraisons · ${totalVelos} vélos`);
process.exit(0);
