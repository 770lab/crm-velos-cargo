import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const livId = "1JSv8xdxnXImFWyGC95f";
await db.collection("livraisons").doc(livId).update({ nbVelos: 6, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
console.log(`✅ ${livId} nbVelos: 16 → 6`);
