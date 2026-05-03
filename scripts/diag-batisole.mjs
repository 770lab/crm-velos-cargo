// Diag rapide BATISOLE CONSTRUCTION
import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const cSnap = await db.collection("clients").where("entreprise", "==", "BATISOLE CONSTRUCTION").get();
if (cSnap.empty) { console.log("client introuvable"); process.exit(1); }
const cDoc = cSnap.docs[0];
const c = cDoc.data();
console.log(`Client ${c.entreprise} (${cDoc.id})`);
console.log(`  nbVelosCommandes=${c.nbVelosCommandes}  stats=${JSON.stringify(c.stats || {})}`);

console.log("\nLivraisons:");
const livSnap = await db.collection("livraisons").where("clientId", "==", cDoc.id).get();
for (const ld of livSnap.docs) {
  const l = ld.data();
  console.log(`  ${ld.id.slice(0, 8)}…  statut=${l.statut}  tourneeId=${(l.tourneeId || "").slice(0, 8)}…  datePrevue=${l.datePrevue}  nbVelos=${l.nbVelos}  annule=${l.annule}  dejaChargee=${l.dejaChargee}`);
}

console.log("\nVelos:");
const vSnap = await db.collection("velos").where("clientId", "==", cDoc.id).get();
for (const vd of vSnap.docs) {
  const v = vd.data();
  const tdate = (x) => x?.toDate ? x.toDate().toISOString().slice(0, 10) : (typeof x === "string" ? x.slice(0, 10) : "—");
  console.log(`  ${vd.id.slice(0, 8)}…  fnuci=${v.fnuci || "—"}  livraisonId=${(v.livraisonId || "").slice(0, 8)}…  annule=${v.annule}  prep=${tdate(v.datePreparation)}  charg=${tdate(v.dateChargement)}  livr=${tdate(v.dateLivraisonScan)}  mont=${tdate(v.dateMontage)}`);
}
process.exit(0);
