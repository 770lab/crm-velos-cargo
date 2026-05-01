import admin from "firebase-admin";
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

console.log("\n=== Toutes les tournées du 30/04/2026 ===");
const start = new Date("2026-04-30T00:00:00Z");
const end = new Date("2026-05-01T00:00:00Z");
const livSnap = await db.collection("livraisons").get();
const byTournee = new Map();
for (const d of livSnap.docs) {
  const data = d.data();
  if (data.statut === "annulee") continue;
  const dp = data.datePrevue;
  let dt = null;
  if (typeof dp === "string") dt = new Date(dp);
  else if (dp?.toDate) dt = dp.toDate();
  if (!dt) continue;
  if (dt < start || dt >= end) continue;
  const num = data.tourneeNumero ?? null;
  const key = `${num}`;
  if (!byTournee.has(key)) byTournee.set(key, { num, clients: new Map() });
  const t = byTournee.get(key);
  if (data.clientId) {
    if (!t.clients.has(data.clientId)) {
      t.clients.set(data.clientId, data.clientSnapshot?.entreprise || data.clientId);
    }
  }
}
for (const [, t] of byTournee.entries()) {
  console.log(`\nTournée ${t.num} (${t.clients.size} clients) :`);
  for (const [cid, name] of t.clients.entries()) {
    console.log(`  - ${name} (${cid})`);
  }
}

console.log("\n\n=== Recherche des clients CHARR HALAL / TMV / HAL DISTRIB ===");
const allClients = await db.collection("clients").get();
const matches = [];
for (const c of allClients.docs) {
  const name = (c.data().entreprise || "").toUpperCase();
  if (name.includes("CHARR") || name.includes("TMV") || name.includes("HAL") || name.includes("DISTRIB")) {
    matches.push({ id: c.id, name: c.data().entreprise });
  }
}
for (const m of matches) {
  console.log(`\n${m.name} (${m.id})`);
  const livs = await db.collection("livraisons").where("clientId", "==", m.id).get();
  for (const l of livs.docs) {
    const ld = l.data();
    const dp = ld.datePrevue;
    let dts = "?";
    if (typeof dp === "string") dts = dp.slice(0, 10);
    else if (dp?.toDate) dts = dp.toDate().toISOString().slice(0, 10);
    console.log(`  livraison: tournée=${ld.tourneeNumero} date=${dts} statut=${ld.statut}`);
  }
}

process.exit(0);
