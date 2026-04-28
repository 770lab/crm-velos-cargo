import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();
const snap = await db.collection("camions").get();
for (const d of snap.docs) {
  const o = d.data();
  console.log(`${d.id} · ${o.nom} · type=${o.type} · capacité=${o.capaciteVelos}v · paris=${o.peutEntrerParis} · actif=${o.actif}`);
}
