// Yoann 2026-05-03 — marque les chefs MONTEURS (gèrent une équipe de
// monteurs, vue restreinte) avec chefDeMonteurs=true. Les autres chefs
// (admin terrain) gardent chefDeMonteurs=false (perms admin complètes).
//
// Règle métier :
// - Chef MONTEUR : a au moins 1 monteur avec chefId === his id
// - Chef ADMIN TERRAIN : aucun monteur ne pointe sur lui
//
//   node scripts/fix-chef-de-monteurs.mjs           # DRY-RUN
//   node scripts/fix-chef-de-monteurs.mjs --apply   # APPLY
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();
const APPLY = process.argv.includes("--apply");

const eqSnap = await db.collection("equipe").get();
const monteursParChef = new Map();
const chefs = [];
for (const d of eqSnap.docs) {
  const e = d.data();
  if (e.actif === false) continue;
  if (e.role === "chef") chefs.push({ id: d.id, nom: e.nom, current: e.chefDeMonteurs === true });
  if (e.role === "monteur" && e.chefId) {
    if (!monteursParChef.has(e.chefId)) monteursParChef.set(e.chefId, 0);
    monteursParChef.set(e.chefId, monteursParChef.get(e.chefId) + 1);
  }
}

console.log(`\n=== ${APPLY ? "APPLY" : "DRY-RUN"} marquage chefDeMonteurs ===\n`);

let nbChanged = 0;
for (const c of chefs) {
  const nbMonteurs = monteursParChef.get(c.id) || 0;
  const target = nbMonteurs > 0;
  if (c.current === target) {
    console.log(`  ${c.nom} (${c.id.slice(0, 8)}…) : déjà à ${target} (${nbMonteurs} monteurs)`);
    continue;
  }
  console.log(`  ${c.nom} (${c.id.slice(0, 8)}…) : ${c.current} → ${target} (${nbMonteurs} monteurs sous lui)`);
  if (APPLY) {
    await db.collection("equipe").doc(c.id).update({
      chefDeMonteurs: target,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  nbChanged++;
}

console.log(`\n${APPLY ? "✓" : "(dry-run)"} ${nbChanged} chefs mis à jour sur ${chefs.length} chefs au total`);
process.exit(0);
