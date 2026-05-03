import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const cs = await db.collection("clients").get();
const matches = [];
for (const d of cs.docs) {
  const c = d.data();
  if (String(c.entreprise || "").toLowerCase().includes("bottega")) {
    matches.push({ id: d.id, ...c });
  }
}
for (const c of matches) {
  console.log(`\n=== ${c.entreprise} (${c.ville}) [${c.id}] ===`);
  console.log("nbVelosCommandes:", c.nbVelosCommandes);
  console.log("statut:", c.statut, "annulee:", c.annulee);
  console.log("stats:", c.stats);

  const v = await db.collection("velos").where("clientId", "==", c.id).get();
  let actifs = 0, annules = 0, prep = 0, livr = 0;
  for (const vd of v.docs) {
    const vv = vd.data();
    if (vv.annule) annules++; else actifs++;
    if (vv.fnuci) prep++;
    if (vv.dateLivraisonScan) livr++;
  }
  console.log(`vélos: ${v.size} (actifs=${actifs}, annulés=${annules}, FNUCI=${prep}, livrés=${livr})`);

  const lvs = await db.collection("livraisons").where("clientId", "==", c.id).get();
  for (const ld of lvs.docs) {
    const l = ld.data();
    console.log(`  liv ${ld.id} statut=${l.statut} nbVelos=${l.nbVelos} tourneeNumero=${l.tourneeNumero} datePrevue=${l.datePrevue}`);
  }
}
process.exit(0);
