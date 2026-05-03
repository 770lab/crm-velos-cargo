// Yoann 2026-05-03 — flag les clients du groupe Firat avec groupe="firat food"
// pour qu ils soient auto-exclus des planifs (livrés directement par le
// groupe depuis l entrepôt éphémère Firat Food, pas par notre flotte).
//
// Critères de détection :
//   - entreprise contient "MARCHE IST" (les magasins du groupe)
//   - entreprise contient "MILLENIUM" (autre marque du groupe)
//   - entreprise contient "FIRAT" (compagnie mère)
//
// Idempotent : skip si déjà flaggé.
//   node scripts/fix-clients-groupe-firat.mjs           # DRY-RUN
//   node scripts/fix-clients-groupe-firat.mjs --apply   # APPLY
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const APPLY = process.argv.includes("--apply");
const GROUPE_VALEUR = "firat food"; // doit matcher groupeClient de l'entrepôt éphémère

const motsCles = [/marche\s*ist/i, /millenium/i, /firat/i];

console.log(`\n=== ${APPLY ? "APPLY" : "DRY-RUN"} flag groupe Firat ===\n`);

const snap = await db.collection("clients").get();
let toUpdate = [];
let alreadyFlag = 0;
for (const d of snap.docs) {
  const o = d.data();
  const nom = String(o.entreprise || "");
  if (!motsCles.some((re) => re.test(nom))) continue;
  const grpc = (o.groupe || o.groupeClient || "").toLowerCase();
  if (grpc === GROUPE_VALEUR) {
    alreadyFlag++;
    continue;
  }
  toUpdate.push({ id: d.id, ref: d.ref, entreprise: nom, ville: o.ville || "" });
}

console.log(`${toUpdate.length} clients à flagger · ${alreadyFlag} déjà OK\n`);

for (const c of toUpdate) {
  console.log(`  ${APPLY ? "✓" : "·"} ${c.entreprise.padEnd(40)} | ${c.ville}`);
  if (APPLY) {
    await c.ref.update({
      groupe: GROUPE_VALEUR,
      groupeFlagAt: admin.firestore.FieldValue.serverTimestamp(),
      groupeFlagSource: "auto-detect-script-marche-ist-millenium-firat",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

console.log(`\n${APPLY ? "✓" : "(dry-run)"} ${toUpdate.length} clients ${APPLY ? "flaggés" : "à flagger"}`);
console.log(`Ces clients seront automatiquement exclus des planifs Voronoi (livrés via éphémère Firat Food).\n`);
process.exit(0);
