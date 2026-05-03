// Yoann 2026-05-03 — Fix one-shot pour VISION LAFAYETTE :
// nbVelosCommandes a ete baisse 6 -> 5 mais la livraison du 4 mai
// est restee a 6 vélos. Aligner la livraison sur la nouvelle valeur.
//
//   node scripts/fix-vision-lafayette-resync.mjs           # DRY-RUN
//   node scripts/fix-vision-lafayette-resync.mjs --apply   # APPLY
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();
const APPLY = process.argv.includes("--apply");

// ID client VISION LAFAYETTE
const CLIENT_ID = "cmoa7mav...";  // a remplacer par l'ID complet

const cSnap = await db.collection("clients")
  .where("entreprise", "==", "VISION LAFAYETTE").get();
if (cSnap.empty) {
  console.log("Client VISION LAFAYETTE introuvable");
  process.exit(1);
}
const cDoc = cSnap.docs[0];
const c = cDoc.data();
console.log(`\nClient ${c.entreprise} (${cDoc.id})`);
console.log(`  nbVelosCommandes=${c.nbVelosCommandes}, livres=${c.stats?.livres || 0}`);

const livSnap = await db.collection("livraisons").where("clientId", "==", cDoc.id).get();
for (const ld of livSnap.docs) {
  const l = ld.data();
  const st = l.statut || l.statutGlobal;
  if (l.annule === true || st === "annulee" || st === "livree") {
    console.log(`  livraison ${ld.id.slice(0, 8)}… : ${st} → skip`);
    continue;
  }
  const cur = Number(l.nbVelos || 0);
  const counts = l.counts || {};
  const minRequired = Math.max(
    Number(counts.prepares || 0),
    Number(counts.charges || 0),
    Number(counts.livres || 0),
    Number(counts.montes || 0),
  );
  const target = Math.max(minRequired, Number(c.nbVelosCommandes || 0) - Number(c.stats?.livres || 0));
  console.log(`  livraison ${ld.id.slice(0, 8)}… : nbVelos ${cur} → ${target} (plancher ${minRequired})`);
  if (APPLY && target !== cur) {
    await db.collection("livraisons").doc(ld.id).update({
      nbVelos: target,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      resyncReason: "fix-vision-lafayette-resync 2026-05-03 — alignement nbVelosCommandes 5",
    });
    console.log(`    ✓ applique`);
  }
}
process.exit(0);
