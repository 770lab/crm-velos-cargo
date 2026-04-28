/**
 * Audit : liste les livraisons récemment annulées et vérifie que leurs
 * clients sont visibles (lat/lng, statut != annulee, vélos restants > 0).
 */
import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const livSnap = await db.collection("livraisons").get();
const annulees = livSnap.docs.filter((d) => String(d.data().statut || "").toLowerCase() === "annulee");
console.log(`Total livraisons : ${livSnap.size} · annulées : ${annulees.length}\n`);

// Map nbVelos planifiés (encore actifs) par clientId pour calcul live
const planifies = new Map();
for (const d of livSnap.docs) {
  const o = d.data();
  if (String(o.statut || "").toLowerCase() !== "planifiee") continue;
  const cid = String(o.clientId || "");
  if (!cid) continue;
  planifies.set(cid, (planifies.get(cid) || 0) + (Number(o.nbVelos) || 0));
}

// Pour chaque livraison annulée, regarde l'état du client
const cIds = new Set(annulees.map((d) => String(d.data().clientId || "")).filter(Boolean));
console.log(`Clients distincts avec livraisons annulées : ${cIds.size}\n`);

let invisibles = 0;
let ok = 0;
let dejaPlanifies = 0;
for (const cid of cIds) {
  const cSnap = await db.collection("clients").doc(cid).get();
  if (!cSnap.exists) continue;
  const c = cSnap.data();
  const planif = planifies.get(cid) || 0;
  const reste = (Number(c.nbVelosCommandes) || 0) - (Number(c.stats?.livres) || 0) - planif;
  const hasCoords = typeof c.latitude === "number" && typeof c.longitude === "number";
  const isCancelled = c.statut === "annulee";
  if (!hasCoords) {
    console.log(`  ⚠️  ${c.entreprise} (${cid}) — PAS DE COORDS, invisible carte`);
    invisibles++;
  } else if (isCancelled) {
    console.log(`  ⊘ ${c.entreprise} (${cid}) — client soft-cancelled`);
  } else if (reste <= 0) {
    console.log(`  ✓ ${c.entreprise} — couvert (${planif}v planifiés, reste ${reste})`);
    dejaPlanifies++;
  } else {
    console.log(`  ✅ ${c.entreprise} — visible, reste ${reste}v à replanifier`);
    ok++;
  }
}

console.log(`\nRésumé : ${ok} re-planifiables · ${dejaPlanifies} déjà couverts · ${invisibles} invisibles`);
