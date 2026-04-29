import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const targets = [
  "CAFE-BRASSERIE DE L'ARAGON", "ODYSSEE RH", "ATLAS NEGOCE SARL",
  "SOCIETE D'INVESTISSEMENT MULTIMARQUES SIM", "LES ARTISANS VERTS",
  "BOULANGERIE L'IMMACULEE", "ASSOCIATION MEDICO-DENTAIRE VILLENEUVE LE ROI",
  "CJ PROJECT", "FRATERNITE DU PARTAGE", "HOTEL LES LOGES BLANCHES",
  "PARC AUTO DU VAL DE MARNE", "PARIS GEORGE V", "ETS JACQUES TAVEAU",
  "REDEEM MEDICAL", "DUCELLIER MATHIEU", "AGATHE AUDITION",
  "SEBASTIEN CAGNET",
];

const cs = await db.collection("clients").get();
const found = [];
for (const c of cs.docs) {
  const d = c.data();
  if (targets.some((t) => (d.entreprise || "").toUpperCase().startsWith(t.toUpperCase()))) {
    found.push({ id: c.id, ...d });
  }
}

const fmt = (ts) => ts ? (ts.toDate ? ts.toDate() : new Date(ts)).toISOString().slice(0,16) : "—";

for (const c of found) {
  const livs = await db.collection("livraisons").where("clientId", "==", c.id).get();
  const velos = await db.collection("velos").where("clientId", "==", c.id).get();
  const veloStatuts = {};
  for (const v of velos.docs) {
    const s = v.data().statut || "(vide)";
    veloStatuts[s] = (veloStatuts[s] || 0) + 1;
  }
  console.log(`\n━━ ${c.entreprise} (devis ${c.nbVelosCommandes})`);
  console.log(`   Livraisons rattachées : ${livs.size}`);
  for (const l of livs.docs) {
    const ld = l.data();
    console.log(`     · livraison ${l.id.slice(0,8)} statut=${ld.statut} nbVelos=${ld.nbVelos} datePrevue=${fmt(ld.datePrevue)} créée=${fmt(ld.createdAt)} annuléeLe=${fmt(ld.dateAnnulation)} tournee=${ld.tourneeId?.slice(0,8) || "—"}`);
  }
  console.log(`   Vélos : ${velos.size} (par statut: ${JSON.stringify(veloStatuts)})`);
}
process.exit(0);
