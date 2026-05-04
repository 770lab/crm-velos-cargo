// Diag HALLE MARKET — 25 préparés mais 24/25 au chargement
import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const cSnap = await db.collection("clients").where("entreprise", "==", "HALLE MARKET").get();
if (cSnap.empty) { console.log("client introuvable"); process.exit(1); }
const cDoc = cSnap.docs[0];
const c = cDoc.data();
console.log(`Client ${c.entreprise} (${cDoc.id})`);
console.log(`  nbVelosCommandes=${c.nbVelosCommandes}  stats=${JSON.stringify(c.stats || {})}`);

console.log("\nLivraisons:");
const livSnap = await db.collection("livraisons").where("clientId", "==", cDoc.id).get();
for (const ld of livSnap.docs) {
  const l = ld.data();
  const counts = l.counts || {};
  console.log(`  ${ld.id.slice(0, 8)}…  statut=${l.statut}  tourneeId=${(l.tourneeId || "").slice(0, 8)}…  date=${l.datePrevue}  nbVelos=${l.nbVelos}  counts=${JSON.stringify(counts)}`);
}

console.log("\nVelos:");
const vSnap = await db.collection("velos").where("clientId", "==", cDoc.id).get();
const tdate = (x) => x?.toDate ? x.toDate().toISOString().slice(0, 16) : (typeof x === "string" ? x.slice(0, 16) : "—");
let nbPrep = 0;
let nbCharg = 0;
let nbAnnule = 0;
for (const vd of vSnap.docs) {
  const v = vd.data();
  if (v.annule) { nbAnnule++; continue; }
  if (v.datePreparation) nbPrep++;
  if (v.dateChargement) nbCharg++;
  console.log(`  ${vd.id.slice(0, 8)}…  fnuci=${v.fnuci || "—"}  prep=${tdate(v.datePreparation)}  charg=${tdate(v.dateChargement)}  livraisonId=${(v.livraisonId || "—").slice(0, 8)}`);
}
console.log(`\nTotal velos actifs: ${vSnap.size - nbAnnule} (annulés: ${nbAnnule})`);
console.log(`  preparés: ${nbPrep}  chargés: ${nbCharg}`);
process.exit(0);
