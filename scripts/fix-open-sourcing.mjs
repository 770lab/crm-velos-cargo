import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const cSnap = await db.collection("clients").get();
const open = cSnap.docs.find(d => String(d.data().entreprise || "").toUpperCase().includes("OPEN SOURCING"));
if (!open) { console.log("OPEN SOURCING introuvable"); process.exit(1); }
const c = open.data();
console.log(`Client: ${c.entreprise} (${open.id}) — nbVelosCommandes=${c.nbVelosCommandes}, livres=${c.stats?.livres||0}`);

const livSnap = await db.collection("livraisons").where("clientId","==",open.id).get();
console.log(`Livraisons (${livSnap.size}):`);
for (const l of livSnap.docs) {
  const o = l.data();
  console.log(`  ${l.id} statut=${o.statut} nbVelos=${o.nbVelos} tourneeId=${o.tourneeId||"-"}`);
}
