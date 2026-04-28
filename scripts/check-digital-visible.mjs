import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const cSnap = await db.collection("clients").get();
const digital = cSnap.docs.find(d => String(d.data().entreprise || "").toUpperCase().includes("DIGITAL"));
if (!digital) { console.log("DIGITAL introuvable"); process.exit(1); }
const c = digital.data();
console.log(`DIGITAL 111 (${digital.id})`);
console.log(`  statut=${c.statut||"actif"}`);
console.log(`  raisonAnnulation=${c.raisonAnnulation||"-"}`);
console.log(`  lat/lng=${c.latitude},${c.longitude}`);
console.log(`  nbVelosCommandes=${c.nbVelosCommandes} stats.totalVelos=${c.stats?.totalVelos} stats.livres=${c.stats?.livres||0} stats.planifies=${c.stats?.planifies||0}`);

const livSnap = await db.collection("livraisons").where("clientId","==",digital.id).get();
console.log(`  Livraisons (${livSnap.size}):`);
let planifSum = 0;
for (const l of livSnap.docs) {
  const o = l.data();
  console.log(`    ${l.id} statut=${o.statut} nbVelos=${o.nbVelos}`);
  if (String(o.statut||"").toLowerCase()==="planifiee") planifSum += Number(o.nbVelos)||0;
}
const reste = (Number(c.nbVelosCommandes)||0) - (Number(c.stats?.livres)||0) - planifSum;
console.log(`  → Reste à planifier (live) : ${reste}`);
console.log(`  → Visible sur carte ? statut OK=${c.statut!=="annulee"}, coords OK=${typeof c.latitude==="number"}, reste>0=${reste>0}`);
