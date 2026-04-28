/**
 * Backfill : reconstitue `clientSnapshot` (entreprise/ville/adresse/...) sur
 * les livraisons qui ne l'ont pas. L'UI livraisons lit ce snapshot
 * dénormalisé pour afficher le nom du client (cf. data-context-firebase.tsx).
 *
 * Bug 2026-04-28 : ancienne version de createLivraison/createTournees
 * n'écrivait pas ce snapshot → livraisons affichées avec un tiret au lieu
 * du nom de l'entreprise. Fix poussé sur les 2 actions, ce script rattrape
 * l'existant.
 *
 * Idempotent : ne touche que les livraisons sans snapshot ou avec entreprise vide.
 *
 * Usage:
 *   node scripts/backfill-client-snapshot.mjs              (dry-run)
 *   node scripts/backfill-client-snapshot.mjs --apply
 */
import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const APPLY = process.argv.includes("--apply");
console.log(`Mode : ${APPLY ? "APPLY ✍️ " : "DRY-RUN 👀"}\n`);

// 1) Charge tous les clients
const cSnap = await db.collection("clients").get();
const clientsParId = new Map();
for (const d of cSnap.docs) {
  const o = d.data();
  clientsParId.set(d.id, {
    entreprise: o.entreprise || "",
    ville: o.ville || "",
    adresse: o.adresse || "",
    codePostal: o.codePostal || "",
    departement: o.departement || "",
    telephone: o.telephone || "",
    lat: o.lat ?? o.latitude ?? null,
    lng: o.lng ?? o.longitude ?? null,
  });
}

// 2) Parcourt toutes les livraisons
const livSnap = await db.collection("livraisons").get();
console.log(`Total livraisons : ${livSnap.size}\n`);

const aFixer = [];
for (const d of livSnap.docs) {
  const o = d.data();
  const snap = o.clientSnapshot || {};
  if (snap.entreprise && String(snap.entreprise).trim()) continue;
  const cid = String(o.clientId || "");
  if (!cid) continue;
  const client = clientsParId.get(cid);
  if (!client) continue;
  aFixer.push({ id: d.id, cid, client });
}

console.log(`Livraisons à corriger : ${aFixer.length}`);
for (const f of aFixer.slice(0, 20)) {
  console.log(`  ${f.id} · clientId=${f.cid} · ${f.client.entreprise}`);
}
if (aFixer.length > 20) console.log(`  ... et ${aFixer.length - 20} autres`);

if (aFixer.length === 0) {
  console.log("\n✅ Rien à corriger.");
  process.exit(0);
}

if (APPLY) {
  const CHUNK = 400;
  let updated = 0;
  for (let i = 0; i < aFixer.length; i += CHUNK) {
    const chunk = aFixer.slice(i, i + CHUNK);
    const batch = db.batch();
    for (const f of chunk) {
      batch.update(db.collection("livraisons").doc(f.id), { clientSnapshot: f.client });
    }
    await batch.commit();
    updated += chunk.length;
  }
  console.log(`\n✍️  ${updated} livraisons mises à jour.`);
} else {
  console.log(`\n(dry-run — relance avec --apply pour appliquer)`);
}
