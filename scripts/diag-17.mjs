// Pour chaque client devis > cibles : ventile les vélos par statut, compare
// dates de création client vs vélos, et regarde l'historique de
// nbVelosCommandes (audit trail si présent).
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

const clientsSnap = await db.collection("clients").get();
const found = [];
for (const c of clientsSnap.docs) {
  const d = c.data();
  if (targets.some((t) => (d.entreprise || "").toUpperCase().startsWith(t.toUpperCase()))) {
    found.push({ id: c.id, ...d });
  }
}

const fmtDate = (ts) => {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toISOString().slice(0, 10);
};

for (const c of found) {
  const v = await db.collection("velos").where("clientId", "==", c.id).get();
  const actifs = v.docs.filter((d) => d.data().statut !== "annule" && d.data().annule !== true);
  const annules = v.docs.filter((d) => d.data().statut === "annule" || d.data().annule === true);
  const nb = Number(c.nbVelosCommandes || 0);
  const cibles = actifs.length;
  const ecart = nb - cibles;
  console.log(`\n━━ ${c.entreprise} (${c.ville || "?"})`);
  console.log(`   devis nbVelosCommandes = ${nb}`);
  console.log(`   vélos actifs           = ${cibles}`);
  console.log(`   vélos annulés          = ${annules.length}`);
  console.log(`   écart devis−actifs     = ${ecart}  ${ecart === annules.length ? "← MATCH avec annulés (= bug compteur)" : ""}`);
  console.log(`   client créé le ${fmtDate(c.createdAt)} · MAJ ${fmtDate(c.updatedAt)}`);
  if (c.createdBy) console.log(`   créé par : ${c.createdBy}`);
  if (c.updatedBy) console.log(`   maj par : ${c.updatedBy}`);
  // sample velos
  const dates = v.docs
    .map((d) => d.data().createdAt)
    .filter(Boolean)
    .map((t) => (t.toDate ? t.toDate() : new Date(t)))
    .sort((a, b) => a - b);
  if (dates.length) {
    console.log(`   1er vélo créé : ${dates[0].toISOString().slice(0,10)} · dernier : ${dates[dates.length-1].toISOString().slice(0,10)}`);
  }
}
process.exit(0);
