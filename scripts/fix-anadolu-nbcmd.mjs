import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();
const ref = db.collection("clients").doc("cmoa7mb0s02wsb2g26uvc9u5f");
const before = await ref.get();
console.log(`Avant : nbVelosCommandes=${before.data().nbVelosCommandes}, livres=${before.data().stats?.livres}`);
await ref.update({
  nbVelosCommandes: 28,
  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  nbCmdCorrigeAt: admin.firestore.FieldValue.serverTimestamp(),
  nbCmdCorrigeReason: "Yoann 2026-05-03 : 28 réellement livrés, 2 jamais reçus",
});
const after = await ref.get();
console.log(`Après : nbVelosCommandes=${after.data().nbVelosCommandes}`);
process.exit(0);
