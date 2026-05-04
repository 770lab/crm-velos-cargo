// Fix immediat OPEN SOURCING : creer 1 velo cible manquant (6 -> 7)
import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const cSnap = await db.collection("clients").where("entreprise", "==", "OPEN SOURCING").get();
const cDoc = cSnap.docs[0];
const c = cDoc.data();
const target = c.nbVelosCommandes || 0;
const apporteurLower = c.apporteurLower || (c.apporteur ? c.apporteur.trim().toLowerCase() : null);
const vSnap = await db.collection("velos").where("clientId", "==", cDoc.id).get();
let actifs = 0;
for (const v of vSnap.docs) if (!v.data().annule) actifs++;
const aCreer = Math.max(0, target - actifs);
console.log(`OPEN SOURCING : target=${target} actifs=${actifs} a creer=${aCreer}`);
for (let i = 0; i < aCreer; i++) {
  await db.collection("velos").add({
    clientId: cDoc.id,
    apporteurLower,
    fnuci: null,
    datePreparation: null,
    dateChargement: null,
    dateLivraisonScan: null,
    dateMontage: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    creationReason: "fix-open-sourcing-velos-7 — sync nbVelosCommandes 6 -> 7",
  });
  console.log(`  cree velo cible ${i + 1}/${aCreer}`);
}
process.exit(0);
