// Yoann 2026-05-03 — Reconcile sum(livraisons non annulees non livrees nbVelos)
// avec nbVelosCommandes - velosLivres pour chaque client. Cas typique :
// Yoann a baisse nbVelosCommandes 6 -> 5 sur VISION LAFAYETTE avant que la
// propagation auto soit deployee, donc la livraison du 4 mai est restee a 6v.
//
// Logique : pour chaque client actif non annule
//   expected = max(0, nbVelosCommandes - velosLivres)
//   sumLiv   = somme nbVelos sur livraisons non annulees non livrees
//   delta    = expected - sumLiv  (positif = il faut ajouter, negatif = retirer)
//   Si delta != 0 : ajuster la livraison la plus tardive ajustable, plancher
//   = max(prepares, charges, livres, montes) pour ne pas casser ce qui est
//   deja fait.
//
//   node scripts/fix-resync-livraisons-velos.mjs           # DRY-RUN
//   node scripts/fix-resync-livraisons-velos.mjs --apply   # APPLY
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();
const APPLY = process.argv.includes("--apply");

const tsOf = (x) => {
  if (!x) return 0;
  if (typeof x === "string") return new Date(x).getTime() || 0;
  if (x.toDate) return x.toDate().getTime() || 0;
  return 0;
};

const cSnap = await db.collection("clients").get();
console.log(`\n=== ${APPLY ? "APPLY" : "DRY-RUN"} reconcile livraisons/nbVelosCommandes ===\n`);
console.log(`${cSnap.size} clients a verifier\n`);

let nbCorrected = 0;
let nbStuck = 0;
const stuckDetails = [];

for (const cDoc of cSnap.docs) {
  const c = cDoc.data();
  if (c.statut === "annulee" || c.annulee === true) continue;
  const nbCmd = Number(c.nbVelosCommandes || 0);
  const livres = Number(c.stats?.livres || 0);
  const expected = Math.max(0, nbCmd - livres);

  const livSnap = await db.collection("livraisons").where("clientId", "==", cDoc.id).get();
  const livs = [];
  let sumLiv = 0;
  for (const ld of livSnap.docs) {
    const l = ld.data();
    const st = l.statut || l.statutGlobal;
    if (l.annule === true || st === "annulee" || st === "livree") continue;
    const nb = Number(l.nbVelos || 0);
    sumLiv += nb;
    livs.push({ id: ld.id, data: l });
  }

  if (sumLiv === expected) continue;

  let delta = expected - sumLiv;
  // Trier par datePrevue desc (la plus tardive d'abord)
  livs.sort((a, b) => tsOf(b.data.datePrevue) - tsOf(a.data.datePrevue));

  console.log(`\n${c.entreprise || cDoc.id} (${cDoc.id.slice(0, 8)}…)`);
  console.log(`  nbVelosCommandes=${nbCmd}, livres=${livres}, expected=${expected}`);
  console.log(`  sumLiv=${sumLiv} (${livs.length} livraisons ajustables) → delta=${delta}`);

  for (const liv of livs) {
    if (delta === 0) break;
    const cur = Number(liv.data.nbVelos || 0);
    const counts = liv.data.counts || {};
    const minRequired = Math.max(
      Number(counts.prepares || 0),
      Number(counts.charges || 0),
      Number(counts.livres || 0),
      Number(counts.montes || 0),
    );
    let target = cur + delta;
    target = Math.max(minRequired, target);
    if (target === cur) continue;
    const applied = target - cur;
    console.log(`    livraison ${liv.id.slice(0, 8)}… : ${cur} → ${target} (date ${liv.data.datePrevue ? new Date(tsOf(liv.data.datePrevue)).toISOString().slice(0, 10) : "?"}, plancher ${minRequired})`);
    if (APPLY) {
      await db.collection("livraisons").doc(liv.id).update({
        nbVelos: target,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        resyncReason: "fix-resync-livraisons-velos 2026-05-03",
      });
    }
    delta -= applied;
    nbCorrected++;
  }
  if (delta !== 0) {
    nbStuck++;
    stuckDetails.push({ client: c.entreprise, residual: delta });
    console.log(`  ⚠ residu ${delta} non absorbe (velos deja prepares ou pas assez de marge)`);
  }
}

console.log(`\n${APPLY ? "✓" : "(dry-run)"} ${nbCorrected} livraison(s) ajustee(s)`);
if (nbStuck > 0) {
  console.log(`⚠ ${nbStuck} client(s) avec residu non absorbable :`);
  for (const s of stuckDetails) console.log(`  - ${s.client} : delta residuel ${s.residual}`);
}
process.exit(0);
