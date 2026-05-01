// Réparation ponctuelle : ANADOLU DISTRIBUTION a perdu 5 slots vélos après
// désaffiliation (bug unsetVeloClient corrigé en commit 531ad1f). On crée
// 5 vélos vierges supplémentaires SANS toucher aux 23 déjà préparés.
//
// Usage : node scripts/fix-anadolu-slots.mjs
import admin from "firebase-admin";
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

console.log("🔍 Recherche du client ANADOLU DISTRIBUTION…");
const cSnap = await db
  .collection("clients")
  .where("entreprise", "==", "ANADOLU DISTRIBUTION")
  .get();

if (cSnap.empty) {
  console.error("❌ Client ANADOLU DISTRIBUTION introuvable.");
  process.exit(1);
}
if (cSnap.docs.length > 1) {
  console.error(`⚠ ${cSnap.docs.length} clients matchent — homonymes ?`);
  for (const d of cSnap.docs) {
    console.error(`  ${d.id} — ${d.data().ville}, ${d.data().codePostal}`);
  }
  process.exit(1);
}
const clientDoc = cSnap.docs[0];
const clientId = clientDoc.id;
const clientData = clientDoc.data();
const target = Number(clientData.nbVelosCommandes) || 0;
const apporteurLower = clientData.apporteurLower || null;
console.log(`✅ Trouvé : ${clientId}`);
console.log(`   nbVelosCommandes : ${target}`);
console.log(`   apporteurLower   : ${apporteurLower}`);

const vSnap = await db.collection("velos").where("clientId", "==", clientId).get();
const actifs = vSnap.docs.filter((d) => d.data().annule !== true);
const cur = actifs.length;
console.log(`\n📊 Vélos actuels (non annulés) : ${cur}`);
console.log(`   Cible (commande)              : ${target}`);

if (cur >= target) {
  console.log(`\n✅ Rien à faire — déjà ${cur}/${target}.`);
  process.exit(0);
}

const aCreer = target - cur;
console.log(`\n🔧 Création de ${aCreer} slot(s) vierge(s) pour ANADOLU…`);

const batch = db.batch();
for (let i = 0; i < aCreer; i++) {
  const veloRef = db.collection("velos").doc();
  batch.set(veloRef, {
    clientId,
    apporteurLower,
    fnuci: null,
    datePreparation: null,
    dateChargement: null,
    dateLivraisonScan: null,
    dateMontage: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}
await batch.commit();

console.log(`\n✅ ${aCreer} slot(s) créé(s). ANADOLU est maintenant à ${target}/${target}.`);
console.log(`   Les ${cur} vélos déjà préparés ne sont PAS touchés.`);
console.log(`\n→ Recharge la page de préparation, tu verras "Prép. ${cur}/${target} (${aCreer}p)"`);
process.exit(0);
