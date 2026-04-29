import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const clients = await db.collection("clients").get();
const allVelos = await db.collection("velos").get();
const veloByClient = new Map();
for (const d of allVelos.docs) {
  const v = d.data();
  if (v.statut === "annule") continue;
  if (!veloByClient.has(v.clientId)) veloByClient.set(v.clientId, 0);
  veloByClient.set(v.clientId, veloByClient.get(v.clientId) + 1);
}

const rows = [];
for (const c of clients.docs) {
  const d = c.data();
  const nb = Number(d.nbVelosCommandes || 0);
  if (!nb) continue;
  const cibles = veloByClient.get(c.id) || 0;
  if (nb > cibles) rows.push({ entreprise: d.entreprise, ville: d.ville, devis: nb, cibles, ecart: nb - cibles });
}
rows.sort((a, b) => b.ecart - a.ecart);
console.log(`${rows.length} clients devis > vélos cibles\n`);
for (const r of rows) {
  console.log(`  ${String(r.devis).padStart(4)}v devis · ${String(r.cibles).padStart(4)}v créés · écart ${String(r.ecart).padStart(4)} · ${r.entreprise}${r.ville ? ` (${r.ville})` : ""}`);
}
console.log(`\nÉcart total : ${rows.reduce((s, r) => s + r.ecart, 0)} vélos`);
process.exit(0);
