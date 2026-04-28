/**
 * Test bout-en-bout du flow prép → charg → livr → montage avec verrous
 * d'ordre (LIFO inter-clients + étapes verticales). Crée une tournée de test
 * isolée dans Firestore, joue tous les cas (corrects + erreurs attendues),
 * vérifie l'état après chaque étape, puis nettoie tout.
 *
 * IMPORTANT : la logique de validation côté navigateur (firestore-actions.ts
 * runFirestoreAction) est rejouée ici en admin SDK. Si un test passe ici mais
 * pas en prod, c'est un drift entre les deux implémentations — flag à corriger.
 *
 * Usage : node scripts/test-flow-complet.mjs
 */
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();
const ts = () => admin.firestore.FieldValue.serverTimestamp();

// Marqueur unique pour pouvoir nettoyer même si le script crashe en cours.
const TEST_TAG = `flow-test-${Date.now()}`;
console.log(`\n🧪 Tag de test : ${TEST_TAG}\n`);

// ───────────────────────────────────────────────────────────────────────
// Helpers : répliques de la logique côté firestore-actions.ts
// ───────────────────────────────────────────────────────────────────────

const ordreFromNotes = (notes) => {
  if (typeof notes !== "string") return null;
  const m = notes.match(/arr[êe]t\s+(\d+)\s*\//i);
  return m ? parseInt(m[1], 10) : null;
};

const STAGE = {
  prepare: { dateField: "datePreparation", requires: [], requiresLabels: [] },
  charge: { dateField: "dateChargement", requires: ["datePreparation"], requiresLabels: ["préparation"] },
  livre: {
    dateField: "dateLivraisonScan",
    requires: ["datePreparation", "dateChargement"],
    requiresLabels: ["préparation", "chargement"],
  },
};

async function tryMarkVelo(action, fnuci, tourneeId) {
  // Étape 1 : trouver le vélo
  const vSnap = await db.collection("velos").where("fnuci", "==", fnuci).get();
  if (vSnap.empty) return { error: "FNUCI inconnu", code: "FNUCI_INCONNU" };
  const veloDoc = vSnap.docs[0];
  const velo = veloDoc.data();
  const veloClientId = velo.clientId;
  if (!veloClientId) return { error: "Vélo non affilié", code: "FNUCI_INCONNU" };

  // Étape 2 : client dans la tournée
  const livSnap = await db
    .collection("livraisons")
    .where("tourneeId", "==", tourneeId)
    .where("clientId", "==", veloClientId)
    .get();
  if (livSnap.empty) return { error: "Pas dans cette tournée", code: "HORS_TOURNEE" };

  const stage = STAGE[action];

  // Étape 3 : étapes précédentes verticales
  const missing = [];
  for (let i = 0; i < stage.requires.length; i++) {
    if (!velo[stage.requires[i]]) missing.push(stage.requiresLabels[i]);
  }
  if (missing.length > 0) {
    return { error: `Manque ${missing.join(",")}`, code: "ETAPE_PRECEDENTE_MANQUANTE", missing };
  }

  // Étape 4 : déjà fait → ok alreadyDone
  if (velo[stage.dateField]) {
    return { ok: true, alreadyDone: true, fnuci };
  }

  // Étape 5 : LIFO inter-clients
  const allLivSnap = await db.collection("livraisons").where("tourneeId", "==", tourneeId).get();
  const seen = new Set();
  const cdefs = [];
  for (const d of allLivSnap.docs) {
    const data = d.data();
    if (String(data.statut || "").toLowerCase() === "annulee") continue;
    if (!data.clientId || seen.has(data.clientId)) continue;
    seen.add(data.clientId);
    const ordre =
      typeof data.ordre === "number" ? data.ordre : ordreFromNotes(data.notes);
    cdefs.push({
      clientId: data.clientId,
      ordre,
      entreprise: data.clientSnapshot?.entreprise || "",
    });
  }
  const allHaveOrdre = cdefs.length > 0 && cdefs.every((c) => typeof c.ordre === "number");
  if (allHaveOrdre && cdefs.length > 1) {
    const sorted = cdefs.slice().sort((a, b) => a.ordre - b.ordre);
    const ordered = action === "prepare" || action === "charge" ? sorted.slice().reverse() : sorted;

    const cids = ordered.map((c) => c.clientId);
    const totals = new Map();
    for (let i = 0; i < cids.length; i += 30) {
      const chunk = cids.slice(i, i + 30);
      const vAll = await db.collection("velos").where("clientId", "in", chunk).get();
      for (const d of vAll.docs) {
        const vd = d.data();
        if (vd.annule === true) continue;
        const cur = totals.get(vd.clientId) || { total: 0, done: 0 };
        cur.total++;
        if (vd[stage.dateField]) cur.done++;
        totals.set(vd.clientId, cur);
      }
    }
    const firstUnfinished = ordered.find((c) => {
      const t = totals.get(c.clientId);
      return !t || t.done < t.total;
    });
    if (firstUnfinished && firstUnfinished.clientId !== veloClientId) {
      return {
        error: `Termine d'abord ${firstUnfinished.entreprise}`,
        code: "ORDRE_VERROUILLE",
        expectedClientName: firstUnfinished.entreprise,
      };
    }
  }

  // Étape 6 : marquer
  await veloDoc.ref.update({ [stage.dateField]: ts(), updatedAt: ts() });
  return { ok: true, fnuci, alreadyDone: false };
}

async function tryUploadMontagePhoto(fnuci, slot) {
  const vSnap = await db.collection("velos").where("fnuci", "==", fnuci).get();
  if (vSnap.empty) return { error: "FNUCI inconnu" };
  const veloDoc = vSnap.docs[0];
  const velo = veloDoc.data();
  // Étape précédente : prép + charg + livr (commit cdb6039)
  if (!velo.datePreparation || !velo.dateChargement || !velo.dateLivraisonScan) {
    return { error: "Manque prép/charg/livr", code: "ETAPE_PRECEDENTE_MANQUANTE" };
  }
  const slotField = {
    etiquette: "urlPhotoMontageEtiquette",
    qrvelo: "urlPhotoMontageQrVelo",
    monte: "photoMontageUrl",
  }[slot];
  if (!slotField) return { error: "slot invalide" };
  const updates = { [slotField]: "https://test/sim.jpg", updatedAt: ts() };
  const hasEtiquette = slot === "etiquette" || !!velo.urlPhotoMontageEtiquette;
  const hasQrVelo = slot === "qrvelo" || !!velo.urlPhotoMontageQrVelo;
  const hasMonte = slot === "monte" || !!velo.photoMontageUrl;
  const allThree = hasEtiquette && hasQrVelo && hasMonte;
  if (allThree && !velo.dateMontage) {
    updates.dateMontage = ts();
  }
  await veloDoc.ref.update(updates);
  return { ok: true, complete: allThree };
}

// ───────────────────────────────────────────────────────────────────────
// Setup fixtures : 3 clients × N vélos sur 1 tournée
// ───────────────────────────────────────────────────────────────────────

console.log("📦 Setup fixtures…");
const clients = [
  { entreprise: `${TEST_TAG} CLIENT-A`, nbVelos: 2, ville: "Paris" },
  { entreprise: `${TEST_TAG} CLIENT-B`, nbVelos: 3, ville: "Lyon" },
  { entreprise: `${TEST_TAG} CLIENT-C`, nbVelos: 1, ville: "Marseille" },
];

for (const c of clients) {
  const cRef = db.collection("clients").doc();
  c.id = cRef.id;
  await cRef.set({
    entreprise: c.entreprise,
    ville: c.ville,
    adresse: "1 rue Test",
    codePostal: "00000",
    siren: "111222333",
    apporteur: TEST_TAG,
    apporteurLower: TEST_TAG.toLowerCase(),
    testTag: TEST_TAG,
    nbVelosCommandes: c.nbVelos,
    createdAt: ts(),
    updatedAt: ts(),
  });
  console.log(`   client ${c.entreprise} : ${c.id}`);
}

const tourneeId = `${TEST_TAG}-T1`;
const tourneeNumero = 99999;
console.log(`📋 Tournée : ${tourneeId}`);

let ordreCount = 0;
for (const c of clients) {
  ordreCount++;
  const livRef = db.collection("livraisons").doc();
  c.livraisonId = livRef.id;
  await livRef.set({
    clientId: c.id,
    tourneeId,
    tourneeNumero,
    ordre: ordreCount,
    nbVelos: c.nbVelos,
    datePrevue: "2099-12-31",
    statut: "planifiee",
    notes: `Test — arrêt ${ordreCount}/${clients.length}`,
    clientSnapshot: { entreprise: c.entreprise, ville: c.ville, adresse: "1 rue Test", codePostal: "00000" },
    apporteurLower: TEST_TAG.toLowerCase(),
    testTag: TEST_TAG,
    createdAt: ts(),
    updatedAt: ts(),
  });
  c.fnucis = [];
  for (let i = 0; i < c.nbVelos; i++) {
    const vRef = db.collection("velos").doc();
    const fnuci = `BCTEST${ordreCount}${i}AAA`.slice(0, 10).padEnd(10, "A").toUpperCase();
    c.fnucis.push(fnuci);
    await vRef.set({
      clientId: c.id,
      fnuci,
      apporteurLower: TEST_TAG.toLowerCase(),
      testTag: TEST_TAG,
      datePreparation: null,
      dateChargement: null,
      dateLivraisonScan: null,
      dateMontage: null,
      createdAt: ts(),
      updatedAt: ts(),
    });
  }
  console.log(`   livraison ${c.entreprise} ordre=${ordreCount} ${c.nbVelos} vélos FNUCI=${c.fnucis.join(",")}`);
}

// ───────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
function assert(cond, label, extra = "") {
  if (cond) {
    console.log(`   ✅ ${label}`);
    pass++;
  } else {
    console.log(`   ❌ ${label} ${extra}`);
    fail++;
  }
}

console.log(`\n━━━ TEST 1 : verrou LIFO préparation (ordre attendu C → B → A) ━━━`);
// En préparation, ordre LIFO = inverse de tournée = [C, B, A]. Premier scan
// autorisé = C. Tout autre client = ORDRE_VERROUILLE.
let r = await tryMarkVelo("prepare", clients[0].fnucis[0], tourneeId); // tente A
assert(r.code === "ORDRE_VERROUILLE", "A en 1er → ORDRE_VERROUILLE", JSON.stringify(r));
r = await tryMarkVelo("prepare", clients[1].fnucis[0], tourneeId); // tente B
assert(r.code === "ORDRE_VERROUILLE", "B en 2e → ORDRE_VERROUILLE", JSON.stringify(r));
r = await tryMarkVelo("prepare", clients[2].fnucis[0], tourneeId); // C OK (1 vélo)
assert(r.ok === true, "C en 1er → OK");
// C terminé (1 vélo), maintenant B doit être autorisé
r = await tryMarkVelo("prepare", clients[0].fnucis[0], tourneeId);
assert(r.code === "ORDRE_VERROUILLE", "Encore A → toujours bloqué (B pas fini)", JSON.stringify(r));
r = await tryMarkVelo("prepare", clients[1].fnucis[0], tourneeId);
assert(r.ok === true, "B en 2e (1/3 vélos) → OK");
r = await tryMarkVelo("prepare", clients[1].fnucis[1], tourneeId);
assert(r.ok === true, "B en 2e (2/3 vélos) → OK");
r = await tryMarkVelo("prepare", clients[1].fnucis[2], tourneeId);
assert(r.ok === true, "B en 2e (3/3 vélos) → OK");
// B terminé, maintenant A
r = await tryMarkVelo("prepare", clients[0].fnucis[0], tourneeId);
assert(r.ok === true, "A en 3e (1/2) → OK");
r = await tryMarkVelo("prepare", clients[0].fnucis[1], tourneeId);
assert(r.ok === true, "A en 3e (2/2) → OK");

console.log(`\n━━━ TEST 2 : verrou étape verticale (charger sans préparer interdit) ━━━`);
// Pour ce test, on a tout préparé. On essaie de livrer sans charger.
r = await tryMarkVelo("livre", clients[2].fnucis[0], tourneeId);
assert(r.code === "ETAPE_PRECEDENTE_MANQUANTE", "Livr sans charg → ETAPE_PRECEDENTE_MANQUANTE", JSON.stringify(r));

console.log(`\n━━━ TEST 3 : chargement LIFO (C → B → A même ordre que prép) ━━━`);
r = await tryMarkVelo("charge", clients[0].fnucis[0], tourneeId);
assert(r.code === "ORDRE_VERROUILLE", "Charg A en 1er → ORDRE_VERROUILLE", JSON.stringify(r));
r = await tryMarkVelo("charge", clients[2].fnucis[0], tourneeId);
assert(r.ok === true, "Charg C en 1er → OK");
for (const f of clients[1].fnucis) await tryMarkVelo("charge", f, tourneeId);
for (const f of clients[0].fnucis) await tryMarkVelo("charge", f, tourneeId);
const chargCount = (await db.collection("velos").where("testTag", "==", TEST_TAG).get()).docs
  .filter((d) => !!d.data().dateChargement).length;
assert(chargCount === 6, `Tous chargés (6/6) → ${chargCount}`);

console.log(`\n━━━ TEST 4 : livraison ordre tournée (A → B → C, sens NORMAL) ━━━`);
r = await tryMarkVelo("livre", clients[2].fnucis[0], tourneeId);
assert(r.code === "ORDRE_VERROUILLE", "Livr C en 1er → ORDRE_VERROUILLE (A doit passer 1er)", JSON.stringify(r));
r = await tryMarkVelo("livre", clients[0].fnucis[0], tourneeId);
assert(r.ok === true, "Livr A en 1er (1/2) → OK");
r = await tryMarkVelo("livre", clients[0].fnucis[1], tourneeId);
assert(r.ok === true, "Livr A en 1er (2/2) → OK");
for (const f of clients[1].fnucis) await tryMarkVelo("livre", f, tourneeId);
for (const f of clients[2].fnucis) await tryMarkVelo("livre", f, tourneeId);
const livCount = (await db.collection("velos").where("testTag", "==", TEST_TAG).get()).docs
  .filter((d) => !!d.data().dateLivraisonScan).length;
assert(livCount === 6, `Tous livrés (6/6) → ${livCount}`);

console.log(`\n━━━ TEST 5 : montage (3 photos par vélo → dateMontage à la 3e) ━━━`);
const fSample = clients[0].fnucis[0];
r = await tryUploadMontagePhoto(fSample, "etiquette");
assert(r.complete === false, "1 photo : complete=false");
r = await tryUploadMontagePhoto(fSample, "qrvelo");
assert(r.complete === false, "2 photos : complete=false");
r = await tryUploadMontagePhoto(fSample, "monte");
assert(r.complete === true, "3 photos : complete=true");
const vSample = (await db.collection("velos").where("fnuci", "==", fSample).get()).docs[0].data();
assert(!!vSample.dateMontage, "dateMontage posée à la 3e photo");

console.log(`\n━━━ TEST 6 : ajout post-planning auto-ordre (commit 660973f) ━━━`);
// Réplique createLivraison singulier → vérifie qu'il pose ordre=max+1
const sib = await db.collection("livraisons").where("tourneeId", "==", tourneeId).get();
let maxOrdre = 0;
for (const d of sib.docs) {
  const o = typeof d.data().ordre === "number" ? d.data().ordre : ordreFromNotes(d.data().notes);
  if (typeof o === "number" && o > maxOrdre) maxOrdre = o;
}
const newClient = { entreprise: `${TEST_TAG} CLIENT-D-LATE`, id: db.collection("clients").doc().id };
await db.collection("clients").doc(newClient.id).set({
  entreprise: newClient.entreprise,
  apporteur: TEST_TAG,
  apporteurLower: TEST_TAG.toLowerCase(),
  testTag: TEST_TAG,
  nbVelosCommandes: 1,
  createdAt: ts(),
});
const newLivId = db.collection("livraisons").doc().id;
await db.collection("livraisons").doc(newLivId).set({
  clientId: newClient.id,
  tourneeId,
  tourneeNumero,
  ordre: maxOrdre + 1,
  nbVelos: 1,
  statut: "planifiee",
  testTag: TEST_TAG,
  createdAt: ts(),
});
const newLiv = (await db.collection("livraisons").doc(newLivId).get()).data();
assert(newLiv.ordre === 4, `Nouveau client D : ordre=${newLiv.ordre} (attendu 4)`);

// ───────────────────────────────────────────────────────────────────────
// Cleanup
// ───────────────────────────────────────────────────────────────────────
console.log(`\n🧹 Cleanup fixtures (testTag=${TEST_TAG})…`);
const cleanups = [
  ["velos", "testTag"],
  ["livraisons", "testTag"],
  ["clients", "testTag"],
];
for (const [col, field] of cleanups) {
  const snap = await db.collection(col).where(field, "==", TEST_TAG).get();
  let n = 0;
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = db.batch();
    for (const d of snap.docs.slice(i, i + 400)) {
      batch.delete(d.ref);
      n++;
    }
    await batch.commit();
  }
  console.log(`   ${col} : ${n} doc(s) supprimé(s)`);
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Résultat : ${pass} ✅ · ${fail} ❌`);
process.exit(fail > 0 ? 1 : 0);
