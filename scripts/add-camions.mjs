import admin from "firebase-admin";
import crypto from "node:crypto";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const camions = [
  { nom: "Moyen 65v", type: "moyen", capaciteVelos: 65, peutEntrerParis: true },
  { nom: "Moyen 44v", type: "moyen", capaciteVelos: 44, peutEntrerParis: true },
];

for (const c of camions) {
  const id = crypto.randomUUID();
  await db.collection("camions").doc(id).set({
    legacyId: id,
    nom: c.nom,
    type: c.type,
    capaciteVelos: c.capaciteVelos,
    peutEntrerParis: c.peutEntrerParis,
    actif: true,
    notes: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`✅ ${c.nom} (${c.capaciteVelos}v) créé · id=${id}`);
}
