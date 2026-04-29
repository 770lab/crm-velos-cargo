/**
 * Active le flag estChefMonteur=true sur le doc équipe de ricky.
 * Effet : ricky (role=monteur) voit toutes les livraisons des monteurs et
 * a accès à /finances (vue Règlements monteurs).
 *
 * Usage : node scripts/set-ricky-chef-monteur.mjs
 */
import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const snap = await db.collection("equipe").get();
const candidates = snap.docs.filter((d) => {
  const o = d.data();
  return String(o.nom || "").trim().toLowerCase() === "ricky";
});

if (candidates.length === 0) {
  console.log("❌ Aucun membre 'ricky' trouvé dans la collection equipe.");
  process.exit(1);
}
if (candidates.length > 1) {
  console.log(`⚠️  ${candidates.length} membres 'ricky' trouvés :`);
  for (const c of candidates) console.log(`  - ${c.id} (role=${c.data().role}, actif=${c.data().actif})`);
  console.log("Précise lequel via une modif manuelle.");
  process.exit(1);
}

const ricky = candidates[0];
const o = ricky.data();
console.log(`✓ ricky trouvé : ${ricky.id} (role=${o.role}, actif=${o.actif})`);
await ricky.ref.update({
  estChefMonteur: true,
  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
});
console.log(`✅ estChefMonteur=true posé sur ${ricky.id}.`);
console.log(`   Au prochain login, ricky verra toutes les livraisons des monteurs et aura accès à /finances.`);
