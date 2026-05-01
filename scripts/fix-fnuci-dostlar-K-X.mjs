// Fix hallucination Gemini K↔X sur DOSTLAR FRANCE.
// BC6AHEX88E (en base) -> BC6AHEK88E (vrai FNUCI sticker).
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const VELO_ID = "cmoa7mb1d032rb2g2f5pqyn6e";
const OLD = "BC6AHEX88E";
const NEW = "BC6AHEK88E";

console.log(`\n=== Fix FNUCI ${OLD} -> ${NEW} ===\n`);

// Vérif que le nouveau n'existe pas déjà
const existSnap = await db.collection("velos").where("fnuci", "==", NEW).get();
if (!existSnap.empty) {
  console.error(`❌ DOUBLON : ${NEW} existe déjà sur ${existSnap.size} vélo(s). Abort.`);
  for (const d of existSnap.docs) console.error(`   - veloId=${d.id} clientId=${d.data().clientId}`);
  process.exit(1);
}

// Vérif qu'on a bien le vélo source
const veloRef = db.collection("velos").doc(VELO_ID);
const veloSnap = await veloRef.get();
if (!veloSnap.exists) { console.error(`❌ veloId ${VELO_ID} introuvable. Abort.`); process.exit(1); }
const v = veloSnap.data();
if (v.fnuci !== OLD) {
  console.error(`❌ FNUCI actuel = ${v.fnuci}, attendu ${OLD}. Abort.`);
  process.exit(1);
}

console.log(`✓ Vélo trouvé chez clientId=${v.clientId}`);
console.log(`✓ Aucun doublon de ${NEW} en base`);
console.log(`\nApplication...\n`);

await veloRef.update({
  fnuci: NEW,
  fnuciPrevious: OLD,
  fnuciFixedAt: admin.firestore.FieldValue.serverTimestamp(),
  fnuciFixedReason: "Hallucination Gemini K vs X — Yoann manual fix 2026-05-01",
  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
});

console.log(`✓ Corrigé : veloId=${VELO_ID}  ${OLD} -> ${NEW}`);
console.log(`\n→ Pense à régénérer le CSV CEE pour la tournée concernée si déjà envoyé.\n`);
process.exit(0);
