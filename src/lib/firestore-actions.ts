/**
 * Implémentations Firestore des actions historiquement servies par GAS.
 *
 * Ces fonctions sont appelées par `gas.ts` quand `NEXT_PUBLIC_USE_FIREBASE=1`,
 * pour que les pages existantes continuent d'appeler `gasPost(...)` /
 * `gasUpload(...)` sans modification.
 *
 * Format de retour : on imite la forme `{ ok: true, ... }` de GAS pour ne pas
 * casser les call-sites qui testent `r.ok`.
 *
 * Actions non migrées (Gemini / Drive / API externes) → renvoient
 * `{ ok: false, fallback: "gas" }` et `gas.ts` retombe sur un appel GAS réel.
 */

import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  collection,
  serverTimestamp,
  writeBatch,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  runTransaction,
  Timestamp,
  type FieldValue,
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { getFunctions, httpsCallable } from "firebase/functions";
import { db, firebaseApp, storage } from "./firebase";

const functions = getFunctions(firebaseApp, "europe-west1");

const ts = serverTimestamp;

// -------- helpers --------

type Body = Record<string, unknown>;

function getString(b: Body, key: string): string | undefined {
  const v = b[key];
  return typeof v === "string" ? v : undefined;
}

function getRequired(b: Body, key: string): string {
  const v = getString(b, key);
  if (!v) throw new Error(`Champ manquant: ${key}`);
  return v;
}

/**
 * Convertit une valeur "à la GAS" (string ISO ou ts ms) en Timestamp Firestore,
 * ou laisse passer une string non-date.
 */
function maybeDate(v: unknown): unknown {
  if (typeof v !== "string") return v;
  if (!v) return null;
  // ISO date string ?
  const d = new Date(v);
  if (!Number.isNaN(d.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    return Timestamp.fromDate(d);
  }
  return v;
}

function applyMaybeDates(data: Body): Body & { updatedAt: FieldValue } {
  const out: Body = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === "datePrevue" || k === "dateEffective") {
      out[k] = maybeDate(v);
    } else {
      out[k] = v;
    }
  }
  return { ...out, updatedAt: ts() };
}

function dataUrlToBlob(dataUrl: string): { blob: Blob; mime: string } {
  // Soit "data:image/jpeg;base64,XXX" soit raw base64
  let base64: string;
  let mime = "application/octet-stream";
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (m) {
    mime = m[1];
    base64 = m[2];
  } else {
    base64 = dataUrl;
  }
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { blob: new Blob([bytes], { type: mime }), mime };
}

async function uploadDataUrl(path: string, dataUrl: string, mimeOverride?: string) {
  const { blob, mime } = dataUrlToBlob(dataUrl);
  const r = ref(storage, path);
  await uploadBytes(r, blob, { contentType: mimeOverride || mime });
  return getDownloadURL(r);
}

// -------- catalog --------

export const FIRESTORE_ACTIONS = new Set<string>([
  // login
  "loginEquipe",
  // clients
  "createClient",
  "updateClient",
  "bulkUpdateClients",
  "setClientVelosTarget",
  "cancelClient",
  "restoreClient",
  // livraisons
  "createLivraison",
  "updateLivraison",
  // tournees → livraisons (ils sont stockés ensemble dans GAS)
  "createTournee",
  "createTournees",
  "assignTournee",
  // velos
  "setVeloFnuci",
  "assignFnuciToClient",
  "updateVelos",
  "markVeloLivre",
  "markVeloPrepare",
  "markVeloCharge",
  "markVeloLivreScan",
  "markClientAsDelivered",
  "unmarkVeloEtape",
  "unsetVeloClient",
  // équipe
  "upsertMembre",
  "setMembreCode",
  "clearMembreCode",
  // verifications
  "validateVerification",
  "rejectVerification",
  // uploads
  "uploadDoc",
  "uploadBlSignedPhoto",
  "uploadMontagePhoto",
  "uploadVeloPhoto",
  // sync admin
  "syncBonsNow",
  // batch admin
  "bulkAutoValidate",
  "importClients",
  "setDisponibilites",
  // gemini vision (vague 3 — proxifié via Cloud Function)
  "extractFnuciFromImage",
  // routing & planning (vague 3 — Cloud Function lit Firestore + appelle Gemini)
  "proposeTournee",
  // suggestTournee (vague 3) — algo pur côté frontend, pas de Cloud Function
  // (lit clients + livraisons direct Firestore, bin-packing local).
  "suggestTournee",
  // parcelle cadastrale (vague 3) — APIs publiques, pas de Cloud Function
  "fetchParcelle",
  "autoFetchParcelles",
  // diagnostic + routing (vague 3 — Cloud Functions)
  "testGemini",
  "getRouting",
]);

export function isMigrated(action: string): boolean {
  return FIRESTORE_ACTIONS.has(action);
}

// -------- dispatch --------

export async function runFirestoreAction(
  action: string,
  body: Body,
): Promise<unknown> {
  switch (action) {
    // ---------- login ----------
    case "loginEquipe": {
      // Par sécurité on n'autorise PAS le login PIN via cette voie : la nouvelle
      // auth Firebase passe par auth-gate-firebase (signInWithEmailAndPassword).
      // Si l'ancien auth-gate.tsx est encore actif, on renvoie une erreur claire.
      return { ok: false, error: "Auth GAS désactivée — utilise auth-gate-firebase" };
    }

    // ---------- clients ----------
    case "createClient": {
      // apporteurLower : champ dénormalisé case-insensitive pour le RBAC
      // apporteur (cf. firestore.rules + scripts/backfill-apporteur-lower.mjs).
      const apporteurLower = body.apporteur
        ? String(body.apporteur).trim().toLowerCase() || null
        : null;

      // Géocodage à la création (api-adresse.data.gouv.fr — public, sans clé).
      // Sans coords, le client n'apparaît pas sur /carte (pointFromClient
      // retourne null si latitude/longitude manquants) — bug 2026-04-28
      // (DIGITAL 111 invisible).
      const geo = await geocodeClientAddress({
        adresse: body.adresse,
        codePostal: body.codePostal,
        ville: body.ville,
      });

      const ref = await addDoc(collection(db, "clients"), {
        ...body,
        nbVelosCommandes: Number(body.nbVelosCommandes) || 0,
        apporteurLower,
        ...(geo ? { latitude: geo.lat, longitude: geo.lng } : {}),
        createdAt: ts(),
        updatedAt: ts(),
      });
      return { ok: true, id: ref.id, geocoded: !!geo };
    }

    case "updateClient": {
      const id = getRequired(body, "id");
      const data = (body.data as Body) || {};
      // Le système GAS accepte des updates "à plat" ({ kbisRecu: true, kbisLien: "..." }).
      // Les docs Firestore sont structurés (docs.kbisRecu, docLinks.kbis).
      // On reroute proprement.
      const updates: Body = { updatedAt: ts() };
      const docFlags = [
        "devisSignee",
        "kbisRecu",
        "attestationRecue",
        "signatureOk",
        "inscriptionBicycle",
        "parcelleCadastrale",
      ];
      const docLinkMap: Record<string, string> = {
        devisLien: "docLinks.devis",
        kbisLien: "docLinks.kbis",
        attestationLien: "docLinks.attestation",
        signatureLien: "docLinks.signature",
        bicycleLien: "docLinks.bicycle",
        parcelleCadastraleLien: "docLinks.parcelleCadastrale",
      };
      const docDateMap: Record<string, string> = {
        kbisDate: "docDates.kbis",
        dateEngagement: "docDates.engagement",
        liasseFiscaleDate: "docDates.liasseFiscale",
      };
      for (const [k, v] of Object.entries(data)) {
        if (docFlags.includes(k)) updates[`docs.${k}`] = !!v;
        else if (docLinkMap[k]) updates[docLinkMap[k]] = v;
        else if (docDateMap[k]) updates[docDateMap[k]] = v;
        else updates[k] = v;
      }
      // Si apporteur change, on met à jour aussi apporteurLower (RBAC).
      if ("apporteur" in data) {
        updates.apporteurLower = data.apporteur
          ? String(data.apporteur).trim().toLowerCase() || null
          : null;
      }
      // Si adresse / CP / ville change, on re-géocode (le client doit
      // bouger sur la carte). On lit le doc actuel pour combler les
      // champs non fournis dans data (update partiel).
      if ("adresse" in data || "codePostal" in data || "ville" in data) {
        try {
          const cur = await getDoc(doc(db, "clients", id));
          const curData = cur.exists() ? (cur.data() as { adresse?: string; codePostal?: string; ville?: string }) : {};
          const geo = await geocodeClientAddress({
            adresse: ("adresse" in data ? data.adresse : curData.adresse) as string | undefined,
            codePostal: ("codePostal" in data ? data.codePostal : curData.codePostal) as string | undefined,
            ville: ("ville" in data ? data.ville : curData.ville) as string | undefined,
          });
          if (geo) {
            updates.latitude = geo.lat;
            updates.longitude = geo.lng;
          }
        } catch (e) {
          console.error("[updateClient] geocode KO", e);
        }
      }
      await updateDoc(doc(db, "clients", id), updates);
      return { ok: true };
    }

    case "bulkUpdateClients": {
      const ids = (body.clientIds as string[]) || [];
      const data = (body.data as Body) || {};
      const batch = writeBatch(db);
      for (const id of ids) {
        batch.update(doc(db, "clients", id), { ...data, updatedAt: ts() });
      }
      await batch.commit();
      return { ok: true, updated: ids.length };
    }

    case "cancelClient": {
      // Soft-cancel un client (commande annulée — ex: docs jamais reçus).
      // Cascade :
      //   - livraisons planifiees → annulee (avec raison « Client annulé : X »)
      //   - vélos cibles → annule=true (soft, restaurable)
      //   - stats.planifies du client → 0 (toutes les livraisons sont annulées)
      // Le doc client conserve toutes ses données pour permettre une
      // restauration ultérieure si le client renvoie ses docs.
      const id = getRequired(body, "id");
      const raisonAnnulation = String(body.raisonAnnulation || "").trim();
      if (!raisonAnnulation) return { ok: false, error: "raisonAnnulation requise" };

      const cRefCC = doc(db, "clients", id);
      const cSnapCC = await getDoc(cRefCC);
      if (!cSnapCC.exists()) return { ok: false, error: "Client introuvable" };

      // 1) Marque le client annulé
      await updateDoc(cRefCC, {
        statut: "annulee",
        raisonAnnulation,
        annuleeAt: ts(),
        "stats.planifies": 0,
        updatedAt: ts(),
      });

      // 2) Cascade livraisons planifiees → annulee
      const livRaison = `Client annulé : ${raisonAnnulation}`;
      const livSnapCC = await getDocs(
        query(collection(db, "livraisons"), where("clientId", "==", id)),
      );
      let nbLivAnnulees = 0;
      for (let i = 0; i < livSnapCC.docs.length; i += 400) {
        const batch = writeBatch(db);
        for (const d of livSnapCC.docs.slice(i, i + 400)) {
          const data = d.data() as { statut?: string };
          if (data.statut !== "planifiee") continue;
          batch.update(d.ref, {
            statut: "annulee",
            dateEffective: null,
            raisonAnnulation: livRaison,
            annuleeAt: ts(),
          });
          nbLivAnnulees++;
        }
        await batch.commit();
      }

      // 3) Cascade vélos → annule=true (soft cancel, sans toucher aux scans
      // déjà faits — on conserve dateLivraisonScan/Montage/Preparation pour
      // que la restauration puisse remettre le client dans son état exact).
      const velSnapCC = await getDocs(
        query(collection(db, "velos"), where("clientId", "==", id)),
      );
      let nbVelosAnnules = 0;
      for (let i = 0; i < velSnapCC.docs.length; i += 400) {
        const batch = writeBatch(db);
        for (const d of velSnapCC.docs.slice(i, i + 400)) {
          batch.update(d.ref, { annule: true, updatedAt: ts() });
          nbVelosAnnules++;
        }
        await batch.commit();
      }

      return { ok: true, nbLivAnnulees, nbVelosAnnules };
    }

    case "restoreClient": {
      // Restaure un client annulé. Symétrique de cancelClient :
      //   - statut → null/"actif"
      //   - vélos : annule=false
      // Les livraisons restent annulees (à re-planifier manuellement,
      // l'utilisateur ne veut sûrement pas réactiver les anciennes dates).
      const id = getRequired(body, "id");
      const cRefRC = doc(db, "clients", id);
      const cSnapRC = await getDoc(cRefRC);
      if (!cSnapRC.exists()) return { ok: false, error: "Client introuvable" };

      await updateDoc(cRefRC, {
        statut: null,
        raisonAnnulation: null,
        annuleeAt: null,
        updatedAt: ts(),
      });

      const velSnapRC = await getDocs(
        query(collection(db, "velos"), where("clientId", "==", id)),
      );
      let nbVelosRestaures = 0;
      for (let i = 0; i < velSnapRC.docs.length; i += 400) {
        const batch = writeBatch(db);
        for (const d of velSnapRC.docs.slice(i, i + 400)) {
          batch.update(d.ref, { annule: false, updatedAt: ts() });
          nbVelosRestaures++;
        }
        await batch.commit();
      }

      return { ok: true, nbVelosRestaures };
    }

    case "setClientVelosTarget": {
      // Met à jour le nombre de vélos commandés (devis) ET aligne :
      //   - stats.totalVelos = target (lu par l'UI /clients pour "X/Y")
      //   - docs `velos` cibles : crée la diff si on monte, supprime des
      //     vierges si on descend (jamais ceux déjà préparés/livrés/montés
      //     ni ceux avec un fnuci scanné — sécurité historique).
      // Avant ce fix : l'UI affichait toujours l'ancienne valeur après
      // modification (bug 2026-04-28).
      const clientId = getRequired(body, "clientId");
      const target = Number(body.target) || 0;

      // 1) Compte les vélos existants et leur état pour ce client
      const velSnap = await getDocs(
        query(collection(db, "velos"), where("clientId", "==", clientId)),
      );
      type V = { ref: typeof velSnap.docs[0]["ref"]; locked: boolean };
      const existing: V[] = velSnap.docs.map((d) => {
        const o = d.data() as {
          fnuci?: string | null;
          datePreparation?: unknown;
          dateChargement?: unknown;
          dateLivraisonScan?: unknown;
          dateMontage?: unknown;
        };
        const locked = !!(o.fnuci || o.datePreparation || o.dateChargement || o.dateLivraisonScan || o.dateMontage);
        return { ref: d.ref, locked };
      });
      const lockedCount = existing.filter((v) => v.locked).length;
      if (target < lockedCount) {
        return { ok: false, error: `Impossible de descendre sous ${lockedCount} (vélos déjà engagés/livrés)` };
      }

      // 2) Update doc client (devis + stats)
      await updateDoc(doc(db, "clients", clientId), {
        nbVelosCommandes: target,
        "stats.totalVelos": target,
        updatedAt: ts(),
      });

      // 3) Aligne les docs vélos cibles
      const cur = existing.length;
      let createdN = 0;
      let deletedN = 0;
      if (target > cur) {
        // Récupère apporteurLower client pour les nouveaux vélos
        let apporteurLowerNew: string | null = null;
        try {
          const cSnap = await getDoc(doc(db, "clients", clientId));
          if (cSnap.exists()) {
            const cd = cSnap.data() as { apporteur?: string; apporteurLower?: string };
            apporteurLowerNew = cd.apporteurLower
              || (cd.apporteur ? String(cd.apporteur).trim().toLowerCase() : null)
              || null;
          }
        } catch {}
        const toCreate = target - cur;
        const batch = writeBatch(db);
        for (let i = 0; i < toCreate; i++) {
          const veloRef = doc(collection(db, "velos"));
          batch.set(veloRef, {
            clientId,
            apporteurLower: apporteurLowerNew,
            fnuci: null,
            datePreparation: null,
            dateChargement: null,
            dateLivraisonScan: null,
            dateMontage: null,
            createdAt: ts(),
            updatedAt: ts(),
          });
        }
        await batch.commit();
        createdN = toCreate;
      } else if (target < cur) {
        // Soft-cancel des vélos cibles vierges en surplus (au lieu de hard-delete).
        // Règle Yoann 29-04 : "Ne jamais supprimer un client en définitif" — par
        // extension les vélos cibles aussi, pour que les stats objectif vs réalisé
        // restent cohérentes dans le temps. annule=true les exclut des compteurs
        // mais conserve la trace.
        const toCancel = cur - target;
        const blanks = existing.filter((v) => !v.locked).slice(0, toCancel);
        const batch = writeBatch(db);
        for (const v of blanks) batch.update(v.ref, { annule: true, updatedAt: ts() });
        await batch.commit();
        deletedN = blanks.length;
      }

      return { ok: true, target, createdN, deletedN };
    }

    // ---------- livraisons ----------
    case "createLivraison": {
      // tourneeNumero stable : si le tourneeId est déjà connu, on hérite du
      // numéro existant (mêmes tournées = même numéro). Sinon on alloue
      // max(tourneeNumero) + 1 (numérotation globale qui ne décrémente jamais
      // même quand on annule une tournée intermédiaire — cf. ce que demande
      // Yoann le 2026-04-28).
      const tourneeId = getString(body, "tourneeId");
      let tourneeNumero: number | undefined;
      // Auto-attribution du champ `ordre` quand on ajoute un client à une
      // tournée déjà existante (ex : bouton "+" UI livraisons). Sans ça, le
      // verrou LIFO inter-clients se désactive pour TOUTE la tournée puisqu'au
      // moins un client n'a pas d'ordre détectable. Cf. incident MANADVISE
      // 2026-04-28 (tournée 818b8963 chargée le matin du 28-04). On lit le
      // max ordre des siblings de la même tournée (champ direct OU regex
      // "arrêt X/N" sur notes legacy) puis on attribue max+1.
      let maxOrdreInTournee = 0;
      const ordreFromNotesLiv = (notes: unknown): number | null => {
        if (typeof notes !== "string") return null;
        const m = notes.match(/arr[êe]t\s+(\d+)\s*\//i);
        return m ? parseInt(m[1], 10) : null;
      };
      if (tourneeId) {
        const sib = await getDocs(
          query(collection(db, "livraisons"), where("tourneeId", "==", tourneeId)),
        );
        for (const d of sib.docs) {
          const data = d.data() as { tourneeNumero?: number; ordre?: number; notes?: string };
          if (typeof data.tourneeNumero === "number" && tourneeNumero == null) {
            tourneeNumero = data.tourneeNumero;
          }
          const o =
            typeof data.ordre === "number"
              ? data.ordre
              : ordreFromNotesLiv(data.notes);
          if (typeof o === "number" && o > maxOrdreInTournee) maxOrdreInTournee = o;
        }
      }
      if (tourneeNumero == null) {
        // Nouvelle tournée → max + 1. On utilise orderBy desc + limit 1 pour
        // ne lire QU'UN seul doc Firestore (avant : full scan de la collection
        // livraisons à chaque création de tournée — coût croissant à mesure que
        // la base grandit).
        const top = await getDocs(
          query(collection(db, "livraisons"), orderBy("tourneeNumero", "desc"), limit(1)),
        );
        let maxN = 0;
        if (!top.empty) {
          const n = (top.docs[0].data() as { tourneeNumero?: number }).tourneeNumero;
          if (typeof n === "number") maxN = n;
        }
        tourneeNumero = maxN + 1;
      }
      // apporteurLower : dénormalisé depuis le client pour le RBAC apporteur
      // (cf. firestore.rules + scripts/backfill-apporteur-lower.mjs).
      let apporteurLowerLiv: string | null = null;
      let clientSnapshotLiv: Body | null = null;
      const cidLiv = getString(body, "clientId");
      if (cidLiv) {
        try {
          const cSnap = await getDoc(doc(db, "clients", cidLiv));
          if (cSnap.exists()) {
            const cData = cSnap.data() as {
              apporteur?: string;
              apporteurLower?: string;
              entreprise?: string;
              ville?: string;
              adresse?: string;
              codePostal?: string;
              departement?: string;
              telephone?: string;
              lat?: number;
              lng?: number;
              latitude?: number;
              longitude?: number;
            };
            apporteurLowerLiv = cData.apporteurLower
              || (cData.apporteur ? String(cData.apporteur).trim().toLowerCase() : null)
              || null;
            // Snapshot dénormalisé pour l'UI livraisons (cf. data-context-firebase.tsx
            // qui lit d.clientSnapshot.entreprise — sans ça, l'UI affiche un tiret).
            clientSnapshotLiv = {
              entreprise: cData.entreprise || "",
              ville: cData.ville || "",
              adresse: cData.adresse || "",
              codePostal: cData.codePostal || "",
              departement: cData.departement || "",
              telephone: cData.telephone || "",
              lat: cData.lat ?? cData.latitude ?? null,
              lng: cData.lng ?? cData.longitude ?? null,
            };
          }
        } catch {}
      }
      // Cap nbVelos au reste à planifier (= nbVelosCommandes du devis − livrés
      // − déjà planifiés ailleurs). Sans ça, Gemini peut sur-allouer (ex :
      // OPEN SOURCING 6v commandés mais livraison à 16 — bug 2026-04-28).
      // Règle métier user : « C'EST LE NOMBRE DE VÉLO SUR DEVIS QUI COMPTE
      // SAUF QUAND JE MODIFIE MANUELLEMENT » → on ne cap PAS si l'appelant
      // a explicitement passé `forceNbVelos: true` (édition manuelle UI).
      const bodyApplied = applyMaybeDates(body) as Body;
      if (cidLiv && !body.forceNbVelos && Number(bodyApplied.nbVelos) > 0) {
        const cap = await computeRemainingVelos(cidLiv);
        const requested = Number(bodyApplied.nbVelos);
        if (cap !== null && requested > cap) {
          bodyApplied.nbVelos = Math.max(0, cap);
        }
      }
      // ordre final : explicite si fourni par l'appelant (rare), sinon max+1
      // dans la tournée. Null si pas de tournée (livraison standalone).
      const ordreFinal: number | null =
        typeof body.ordre === "number"
          ? body.ordre
          : tourneeId
            ? maxOrdreInTournee + 1
            : null;
      const ref = await addDoc(collection(db, "livraisons"), {
        ...bodyApplied,
        tourneeNumero,
        ordre: ordreFinal,
        apporteurLower: apporteurLowerLiv,
        clientSnapshot: clientSnapshotLiv,
        statut: body.statut || "planifiee",
        createdAt: ts(),
      });

      // Incrémente stats.planifies si la livraison est planifiee (symétrique
      // avec deleteLivraison). Sinon le compteur reste à 0 et le pop-up
      // /carte affiche "Aucun vélo à planifier" alors qu'il y en a.
      if (cidLiv && (body.statut || "planifiee") === "planifiee") {
        try {
          const cRef = doc(db, "clients", cidLiv);
          const cSnap = await getDoc(cRef);
          if (cSnap.exists()) {
            const stats = (cSnap.data() as { stats?: { planifies?: number } }).stats || {};
            const cur = Number(stats.planifies) || 0;
            await updateDoc(cRef, { "stats.planifies": cur + 1 });
          }
        } catch (e) {
          console.error("[createLivraison] increment planifies KO", e);
        }
      }

      // Création automatique des docs `velos` cibles si manquants. Modèle A
      // (vélo lié au clientId, pas à la livraisonId) : on s'aligne sur le
      // schéma historique GAS pour préserver assignFnuciToClient,
      // getTourneeProgression, etc.
      //
      // Idempotent : on compte les vélos existants pour ce client et on
      // crée uniquement la différence avec nbVelos demandé. Sans ça, créer
      // une livraison pour un client neuf donne `total=0` côté préparation
      // → impossible d'imprimer étiquettes ou scanner FNUCI (cf. bug
      // ALYSSAR du 2026-04-28).
      const nbVelosLiv = Number(bodyApplied.nbVelos) || 0;
      if (cidLiv && nbVelosLiv > 0) {
        try {
          const existingSnap = await getDocs(
            query(collection(db, "velos"), where("clientId", "==", cidLiv)),
          );
          const aCreer = Math.max(0, nbVelosLiv - existingSnap.size);
          if (aCreer > 0) {
            // apporteurLower dénormalisé identique à la livraison (RBAC
            // apporteur — cf. firestore.rules).
            const batch = writeBatch(db);
            for (let i = 0; i < aCreer; i++) {
              const veloRef = doc(collection(db, "velos"));
              batch.set(veloRef, {
                clientId: cidLiv,
                apporteurLower: apporteurLowerLiv,
                fnuci: null,
                datePreparation: null,
                dateChargement: null,
                dateLivraisonScan: null,
                dateMontage: null,
                createdAt: ts(),
                updatedAt: ts(),
              });
            }
            await batch.commit();
          }
        } catch (e) {
          // Si la création échoue, la livraison existe déjà — on log et on
          // laisse passer pour ne pas bloquer le user. Backfill possible
          // via setClientVelosTarget ou recompute-client-stats.mjs.
          console.error("[createLivraison] velos backfill KO", e);
        }
      }

      return { ok: true, id: ref.id, tourneeNumero };
    }

    case "updateLivraison": {
      const id = getRequired(body, "id");
      const data = (body.data as Body) || {};
      await updateDoc(doc(db, "livraisons", id), applyMaybeDates(data));
      return { ok: true };
    }

    // ---------- tournees ----------
    case "createTournee": {
      // Réplique la logique GAS createTournee : crée la tournée + les livraisons
      // depuis `stops` + les vélos cibles + incrémente stats.planifies.
      // Utilisé par le panneau Retrait dans /carte (mode="retrait") et autres.
      // Sans la création des livraisons, le user voit "rien ne se passe" — la
      // tournée existe en base mais n'a aucun client → invisible UI.
      const stops = (body.stops as Body[]) || [];

      // Numéro tournée global : max(tourneeNumero) + 1
      let tourneeNumero = 1;
      try {
        const top = await getDocs(
          query(collection(db, "livraisons"), orderBy("tourneeNumero", "desc"), limit(1)),
        );
        if (!top.empty) {
          const n = (top.docs[0].data() as { tourneeNumero?: number }).tourneeNumero;
          if (typeof n === "number") tourneeNumero = n + 1;
        }
      } catch {}

      const tRef = await addDoc(collection(db, "tournees"), {
        datePrevue: body.datePrevue || "",
        mode: body.mode || "",
        notes: body.notes || "",
        statut: body.statut || "planifiee",
        createdAt: ts(),
      });

      const incParClient = new Map<string, number>();
      // Cap par client (cf. computeRemainingVelos) — décrémenté à chaque stop
      // accepté pour ne pas dépasser le devis sur un même appel.
      const remainingByClient = new Map<string, number>();
      let livCount = 0;
      for (const stop of stops) {
        const cid = String(stop.clientId || "");
        let nbVelos = Number(stop.nbVelos) || 0;
        if (!cid || nbVelos <= 0) continue;
        if (!stop.forceNbVelos) {
          if (!remainingByClient.has(cid)) {
            const r = await computeRemainingVelos(cid);
            remainingByClient.set(cid, r ?? Number.POSITIVE_INFINITY);
          }
          const remaining = remainingByClient.get(cid) ?? Number.POSITIVE_INFINITY;
          if (nbVelos > remaining) nbVelos = Math.max(0, remaining);
          if (nbVelos <= 0) continue;
          remainingByClient.set(cid, remaining - nbVelos);
        }

        let apporteurLowerLiv: string | null = null;
        let clientSnapshotLiv: Body | null = null;
        try {
          const cSnap = await getDoc(doc(db, "clients", cid));
          if (cSnap.exists()) {
            const cData = cSnap.data() as {
              apporteur?: string;
              apporteurLower?: string;
              entreprise?: string;
              ville?: string;
              adresse?: string;
              codePostal?: string;
              departement?: string;
              telephone?: string;
              lat?: number;
              lng?: number;
              latitude?: number;
              longitude?: number;
            };
            apporteurLowerLiv = cData.apporteurLower
              || (cData.apporteur ? String(cData.apporteur).trim().toLowerCase() : null)
              || null;
            clientSnapshotLiv = {
              entreprise: cData.entreprise || "",
              ville: cData.ville || "",
              adresse: cData.adresse || "",
              codePostal: cData.codePostal || "",
              departement: cData.departement || "",
              telephone: cData.telephone || "",
              lat: cData.lat ?? cData.latitude ?? null,
              lng: cData.lng ?? cData.longitude ?? null,
            };
          }
        } catch {}

        await addDoc(collection(db, "livraisons"), {
          clientId: cid,
          nbVelos,
          ordre: Number(stop.ordre) || livCount + 1,
          datePrevue: body.datePrevue || "",
          mode: body.mode || "",
          tourneeId: tRef.id,
          tourneeNumero,
          apporteurLower: apporteurLowerLiv,
          clientSnapshot: clientSnapshotLiv,
          statut: "planifiee",
          createdAt: ts(),
        });

        // Vélos cibles (Modèle A, idempotent)
        try {
          const existingSnap = await getDocs(
            query(collection(db, "velos"), where("clientId", "==", cid)),
          );
          const aCreer = Math.max(0, nbVelos - existingSnap.size);
          if (aCreer > 0) {
            const batch = writeBatch(db);
            for (let i = 0; i < aCreer; i++) {
              const veloRef = doc(collection(db, "velos"));
              batch.set(veloRef, {
                clientId: cid,
                apporteurLower: apporteurLowerLiv,
                fnuci: null,
                datePreparation: null,
                dateChargement: null,
                dateLivraisonScan: null,
                dateMontage: null,
                createdAt: ts(),
                updatedAt: ts(),
              });
            }
            await batch.commit();
          }
        } catch (e) {
          console.error("[createTournee] velos backfill KO", e);
        }

        incParClient.set(cid, (incParClient.get(cid) || 0) + 1);
        livCount++;
      }

      // Incrémente stats.planifies par client
      for (const [cid, n] of incParClient.entries()) {
        try {
          const cRef = doc(db, "clients", cid);
          const cSnap = await getDoc(cRef);
          if (!cSnap.exists()) continue;
          const stats = (cSnap.data() as { stats?: { planifies?: number } }).stats || {};
          const cur = Number(stats.planifies) || 0;
          await updateDoc(cRef, { "stats.planifies": cur + n });
        } catch (e) {
          console.error("[createTournee] increment planifies KO", cid, e);
        }
      }

      return { ok: true, id: tRef.id, tourneeId: tRef.id, livraisonsCount: livCount };
    }

    case "createTournees": {
      // Format de retour aligné GAS : `{ tournees: [{tourneeId, livraisonsCount}], count }`
      // — le frontend (day-planner-modal.applyProposition) attend `created.tournees`.
      // Crée aussi les livraisons depuis `stops` (clientId/nbVelos/ordre) ; sans ça
      // les tournées sont orphelines (pas de clients dedans) — bug 2026-04-28.
      const tourneesIn = (body.tournees as Body[]) || [];
      if (tourneesIn.length === 0) return { tournees: [], count: 0 };

      // Numéro tournée global : max(tourneeNumero) + 1 puis incrément local pour le batch.
      let nextNumero = 1;
      try {
        const top = await getDocs(
          query(collection(db, "livraisons"), orderBy("tourneeNumero", "desc"), limit(1)),
        );
        if (!top.empty) {
          const n = (top.docs[0].data() as { tourneeNumero?: number }).tourneeNumero;
          if (typeof n === "number") nextNumero = n + 1;
        }
      } catch {}

      const results: { tourneeId: string; livraisonsCount: number }[] = [];
      // Compte les incréments stats.planifies par client (appliqués en fin de boucle).
      const incParClient = new Map<string, number>();
      for (const t of tourneesIn) {
        // 1) Doc tournée
        const tRef = await addDoc(collection(db, "tournees"), {
          datePrevue: t.datePrevue || "",
          mode: t.mode || body.mode || "",
          notes: t.notes || body.notes || "",
          statut: t.statut || "planifiee",
          createdAt: ts(),
        });

        // 2) Livraisons depuis stops
        const stops = (t.stops as Body[]) || [];
        const tourneeNumero = nextNumero++;
        // Cap par client (cf. computeRemainingVelos) — décrémenté à chaque
        // stop accepté pour ne pas dépasser le devis (bug OPEN SOURCING
        // 2026-04-28 : Gemini avait alloué 16v à un client de 6v).
        const remainingByClient = new Map<string, number>();
        let livCount = 0;
        for (const stop of stops) {
          const cid = String(stop.clientId || "");
          let nbVelos = Number(stop.nbVelos) || 0;
          if (!cid || nbVelos <= 0) continue;
          if (!stop.forceNbVelos) {
            if (!remainingByClient.has(cid)) {
              const r = await computeRemainingVelos(cid);
              remainingByClient.set(cid, r ?? Number.POSITIVE_INFINITY);
            }
            const remaining = remainingByClient.get(cid) ?? Number.POSITIVE_INFINITY;
            if (nbVelos > remaining) nbVelos = Math.max(0, remaining);
            if (nbVelos <= 0) continue;
            remainingByClient.set(cid, remaining - nbVelos);
          }

          // apporteurLower (RBAC) + clientSnapshot dénormalisé (affichage UI)
          let apporteurLowerLiv: string | null = null;
          let clientSnapshotLiv: Body | null = null;
          try {
            const cSnap = await getDoc(doc(db, "clients", cid));
            if (cSnap.exists()) {
              const cData = cSnap.data() as {
                apporteur?: string;
                apporteurLower?: string;
                entreprise?: string;
                ville?: string;
                adresse?: string;
                codePostal?: string;
                departement?: string;
                telephone?: string;
                lat?: number;
                lng?: number;
                latitude?: number;
                longitude?: number;
              };
              apporteurLowerLiv = cData.apporteurLower
                || (cData.apporteur ? String(cData.apporteur).trim().toLowerCase() : null)
                || null;
              clientSnapshotLiv = {
                entreprise: cData.entreprise || "",
                ville: cData.ville || "",
                adresse: cData.adresse || "",
                codePostal: cData.codePostal || "",
                departement: cData.departement || "",
                telephone: cData.telephone || "",
                lat: cData.lat ?? cData.latitude ?? null,
                lng: cData.lng ?? cData.longitude ?? null,
              };
            }
          } catch {}

          await addDoc(collection(db, "livraisons"), {
            clientId: cid,
            nbVelos,
            ordre: Number(stop.ordre) || livCount + 1,
            datePrevue: t.datePrevue || "",
            mode: t.mode || body.mode || "",
            tourneeId: tRef.id,
            tourneeNumero,
            apporteurLower: apporteurLowerLiv,
            clientSnapshot: clientSnapshotLiv,
            statut: "planifiee",
            createdAt: ts(),
          });

          // Vélos cibles (Modèle A, idempotent — cf. createLivraison)
          try {
            const existingSnap = await getDocs(
              query(collection(db, "velos"), where("clientId", "==", cid)),
            );
            const aCreer = Math.max(0, nbVelos - existingSnap.size);
            if (aCreer > 0) {
              const batch = writeBatch(db);
              for (let i = 0; i < aCreer; i++) {
                const veloRef = doc(collection(db, "velos"));
                batch.set(veloRef, {
                  clientId: cid,
                  apporteurLower: apporteurLowerLiv,
                  fnuci: null,
                  datePreparation: null,
                  dateChargement: null,
                  dateLivraisonScan: null,
                  dateMontage: null,
                  createdAt: ts(),
                  updatedAt: ts(),
                });
              }
              await batch.commit();
            }
          } catch (e) {
            console.error("[createTournees] velos backfill KO", e);
          }
          incParClient.set(cid, (incParClient.get(cid) || 0) + 1);
          livCount++;
        }
        results.push({ tourneeId: tRef.id, livraisonsCount: livCount });
      }

      // Incrémente stats.planifies par client (cf. createLivraison).
      for (const [cid, n] of incParClient.entries()) {
        try {
          const cRef = doc(db, "clients", cid);
          const cSnap = await getDoc(cRef);
          if (!cSnap.exists()) continue;
          const stats = (cSnap.data() as { stats?: { planifies?: number } }).stats || {};
          const cur = Number(stats.planifies) || 0;
          await updateDoc(cRef, { "stats.planifies": cur + n });
        } catch (e) {
          console.error("[createTournees] increment planifies KO", cid, e);
        }
      }
      return { tournees: results, count: results.length };
    }

    case "assignTournee": {
      // 2 modes d'appel :
      //  - livraisonId/id : MAJ d'UNE livraison ciblée (rare, non utilisé par
      //    l'UI Affectation équipe actuelle).
      //  - tourneeId      : MAJ de TOUTES les livraisons d'une tournée d'un
      //    coup. C'est ce que fait le panel "Affectation équipe" du planning
      //    semaine — on n'a qu'une équipe par tournée, pas par client.
      // L'ancienne version ne gérait que livraisonId → l'UI plantait avec
      // "livraisonId requis" car elle envoie tourneeId.
      const livraisonId = getString(body, "livraisonId") || getString(body, "id");
      const tourneeId = getString(body, "tourneeId");
      const writableKeys = [
        "chauffeurId",
        "chefEquipeId",
        "chefEquipeIds",
        "monteurIds",
        "preparateurIds",
        "mode",
      ];
      const fields: Body = { updatedAt: ts() };
      for (const k of writableKeys) {
        if (k in body) fields[k] = body[k];
      }
      if (livraisonId) {
        // Ciblage 1 livraison : on autorise aussi à changer son tourneeId
        // (cas marginal, rebascule).
        if ("tourneeId" in body) fields.tourneeId = body.tourneeId;
        await updateDoc(doc(db, "livraisons", livraisonId), fields);
        return { ok: true, updated: 1 };
      }
      if (tourneeId) {
        const snap = await getDocs(
          query(collection(db, "livraisons"), where("tourneeId", "==", tourneeId)),
        );
        if (snap.empty) return { ok: true, updated: 0 };
        const batch = writeBatch(db);
        for (const d of snap.docs) batch.update(d.ref, fields);
        await batch.commit();
        return { ok: true, updated: snap.size };
      }
      throw new Error("livraisonId ou tourneeId requis");
    }

    // ---------- velos ----------
    case "setVeloFnuci": {
      const veloId = getRequired(body, "veloId");
      const fnuci = getString(body, "fnuci") || null;
      await updateDoc(doc(db, "velos", veloId), { fnuci, updatedAt: ts() });
      return { ok: true };
    }

    case "assignFnuciToClient": {
      // Trouve un vélo du client sans FNUCI et lui assigne.
      const clientId = getRequired(body, "clientId");
      const fnuci = getRequired(body, "fnuci");
      const q = query(
        collection(db, "velos"),
        where("clientId", "==", clientId),
        where("fnuci", "==", null),
      );
      const snap = await getDocs(q);
      if (snap.empty) {
        return { ok: false, error: "Tous les vélos de ce client ont déjà un FNUCI" };
      }
      const veloDoc = snap.docs[0];
      await updateDoc(veloDoc.ref, {
        fnuci,
        datePreparation: ts(),
        updatedAt: ts(),
      });
      return { ok: true, veloId: veloDoc.id };
    }

    case "updateVelos": {
      const veloIds = (body.veloIds as string[]) || [];
      const action = getString(body, "bulkAction");
      if (!action) throw new Error("bulkAction requis");
      const updates: Body = { updatedAt: ts() };
      switch (action) {
        case "markFacturable":
          updates.facturable = true;
          break;
        case "unmarkFacturable":
          updates.facturable = false;
          break;
        case "markFacture":
          updates.facture = true;
          break;
        case "unmarkFacture":
          updates.facture = false;
          break;
        case "markCertificat":
          updates.certificatRecu = true;
          break;
        default:
          updates[action] = true; // best-effort
      }
      const batch = writeBatch(db);
      for (const id of veloIds) batch.update(doc(db, "velos", id), updates);
      await batch.commit();
      return { ok: true, updated: veloIds.length };
    }

    case "markVeloLivre": {
      const veloId = getRequired(body, "veloId");
      await updateDoc(doc(db, "velos", veloId), {
        dateLivraisonScan: ts(),
        updatedAt: ts(),
      });
      return { ok: true };
    }

    case "markVeloPrepare":
    case "markVeloCharge":
    case "markVeloLivreScan": {
      // Scan QR BicyCode (ou saisie manuelle) → on marque l'étape pour le vélo
      // qui porte ce FNUCI. Validation : le vélo doit appartenir à un client de
      // la tournée, sinon HORS_TOURNEE. Si aucun vélo n'a ce FNUCI → FNUCI_INCONNU
      // (ce qui déclenche le mode fusion réception+prép côté UI en mode prep).
      const fnuci = getRequired(body, "fnuci").toUpperCase();
      const tourneeId = getRequired(body, "tourneeId");
      const userId = getString(body, "userId");

      const stageMap = {
        markVeloPrepare: {
          dateField: "datePreparation",
          userField: "preparateurId",
          // Préparation = étape 1 (assignation FNUCI). Aucun prérequis.
          requires: [] as string[],
          requiresLabels: [] as string[],
        },
        markVeloCharge: {
          dateField: "dateChargement",
          userField: "chargeurId",
          requires: ["datePreparation"],
          requiresLabels: ["préparation"],
        },
        markVeloLivreScan: {
          dateField: "dateLivraisonScan",
          userField: "livreurId",
          // Verrouillage d'ordre : un vélo ne peut être livré que s'il est
          // préparé ET chargé. Sans ça, on a vu des vélos passer en "livré"
          // alors qu'ils n'avaient jamais été chargés (bug 2026-04-28).
          requires: ["datePreparation", "dateChargement"],
          requiresLabels: ["préparation", "chargement"],
        },
      } as const;
      const stage = stageMap[action as keyof typeof stageMap];

      // 1. Trouve le vélo via FNUCI
      const vSnap = await getDocs(
        query(collection(db, "velos"), where("fnuci", "==", fnuci)),
      );
      if (vSnap.empty) {
        return { error: "FNUCI inconnu", code: "FNUCI_INCONNU", fnuci };
      }
      const veloDoc = vSnap.docs[0];
      const velo = veloDoc.data() as {
        clientId?: string;
        datePreparation?: unknown;
        dateChargement?: unknown;
        dateLivraisonScan?: unknown;
      };
      const veloClientId = velo.clientId;
      if (!veloClientId) {
        return { error: "Vélo non affilié à un client", code: "FNUCI_INCONNU", fnuci };
      }

      // 2. Le client doit être dans la tournée
      const livSnap = await getDocs(
        query(
          collection(db, "livraisons"),
          where("tourneeId", "==", tourneeId),
          where("clientId", "==", veloClientId),
        ),
      );
      if (livSnap.empty) {
        // Récupère le nom du client pour le message d'erreur
        let veloClientName: string | null = null;
        try {
          const c = await getDoc(doc(db, "clients", veloClientId));
          if (c.exists()) {
            veloClientName = (c.data() as { entreprise?: string }).entreprise || null;
          }
        } catch {}
        return {
          error: "Pas dans cette tournée",
          code: "HORS_TOURNEE",
          fnuci,
          veloClientId,
          veloClientName,
        };
      }
      const livraisonClientName = (livSnap.docs[0].data() as {
        clientSnapshot?: { entreprise?: string };
      }).clientSnapshot?.entreprise || null;

      // Mode dépannage admin (Yoann 29-04 02h42) : permet de scanner dans le
      // désordre lors de tests/exception. Le frontend n'expose le toggle qu'aux
      // admin/superadmin. Côté serveur on accepte le flag tel quel — sécurité
      // basée sur le fait que seuls les admins voient le toggle.
      const bypassOrderLock = body.bypassOrderLock === true;

      // 3. Verrouillage d'ordre : étapes précédentes obligatoires
      const missing: string[] = [];
      for (let i = 0; i < stage.requires.length; i++) {
        const req = stage.requires[i];
        if (!velo[req as keyof typeof velo]) missing.push(stage.requiresLabels[i]);
      }
      if (!bypassOrderLock && missing.length > 0) {
        return {
          error: `Impossible : étape${missing.length > 1 ? "s" : ""} précédente${missing.length > 1 ? "s" : ""} manquante${missing.length > 1 ? "s" : ""} (${missing.join(", ")})`,
          code: "ETAPE_PRECEDENTE_MANQUANTE",
          fnuci,
          missing,
          clientId: veloClientId,
          clientName: livraisonClientName,
        };
      }

      // 4. Étape déjà faite → renvoie ok + alreadyDone
      const dateExisting = velo[stage.dateField as keyof typeof velo];
      if (dateExisting) {
        return {
          ok: true,
          alreadyDone: true,
          etape: stage.dateField,
          veloId: veloDoc.id,
          fnuci,
          clientId: veloClientId,
          clientName: livraisonClientName,
          date: (dateExisting as { toDate?: () => Date })?.toDate?.()?.toISOString() || null,
        };
      }

      // 4bis. Verrouillage LIFO inter-clients (ordre des clients de la tournée).
      // Complète ETAPE_PRECEDENTE_MANQUANTE (ordre vertical par vélo) avec un
      // ordre horizontal : on n'ouvre pas le client N+1 tant que le N n'est
      // pas terminé. Mode prép/charg = ordre INVERSE (LIFO camion : dernier
      // livré entre en premier). Mode livraison = ordre tournée.
      //
      // Comportement DÉFENSIF : on ne bloque QUE si l'ordre est fiable pour
      // TOUS les clients de la tournée (champ `ordre` direct OU "arrêt X/N"
      // dans notes legacy). Sinon on laisse passer (zéro régression sur les
      // anciennes tournées sans champ ordre détectable).
      //
      // Mode bypass admin (cf. ci-dessus) : skip aussi cette vérif.
      try {
        if (bypassOrderLock) throw new Error("__bypass_admin__");
        const allLivSnap = await getDocs(
          query(collection(db, "livraisons"), where("tourneeId", "==", tourneeId)),
        );
        const ordreFromNotesScan = (notes: unknown): number | null => {
          if (typeof notes !== "string") return null;
          const m = notes.match(/arr[êe]t\s+(\d+)\s*\//i);
          return m ? parseInt(m[1], 10) : null;
        };
        type CDef = { clientId: string; ordre: number | null; entreprise: string };
        const seen = new Set<string>();
        const cdefs: CDef[] = [];
        for (const d of allLivSnap.docs) {
          const data = d.data() as {
            clientId?: string;
            statut?: string;
            ordre?: number;
            notes?: string;
            clientSnapshot?: { entreprise?: string };
          };
          if (String(data.statut || "").toLowerCase() === "annulee") continue;
          const cid = data.clientId;
          if (!cid || seen.has(cid)) continue;
          seen.add(cid);
          const ordre =
            typeof data.ordre === "number"
              ? data.ordre
              : ordreFromNotesScan(data.notes);
          cdefs.push({
            clientId: cid,
            ordre,
            entreprise: data.clientSnapshot?.entreprise || "",
          });
        }
        const allHaveOrdre = cdefs.length > 0 && cdefs.every((c) => typeof c.ordre === "number");

        if (allHaveOrdre && cdefs.length > 1) {
          const sorted = cdefs
            .slice()
            .sort((a, b) => (a.ordre as number) - (b.ordre as number));
          const ordered =
            action === "markVeloPrepare" || action === "markVeloCharge"
              ? sorted.slice().reverse()
              : sorted;

          // Compte les vélos déjà-faits / total par client (excluant les annulés).
          const cids = ordered.map((c) => c.clientId);
          const totalsByClient = new Map<string, { total: number; done: number }>();
          for (let i = 0; i < cids.length; i += 30) {
            const chunk = cids.slice(i, i + 30);
            if (!chunk.length) continue;
            const vSnap2 = await getDocs(
              query(collection(db, "velos"), where("clientId", "in", chunk)),
            );
            for (const d of vSnap2.docs) {
              const vd = d.data() as Record<string, unknown>;
              if (vd.annule === true) continue;
              const cid = vd.clientId as string;
              if (!cid) continue;
              const cur = totalsByClient.get(cid) || { total: 0, done: 0 };
              cur.total++;
              if (vd[stage.dateField]) cur.done++;
              totalsByClient.set(cid, cur);
            }
          }
          const firstUnfinished = ordered.find((c) => {
            const t = totalsByClient.get(c.clientId);
            return !t || t.done < t.total;
          });
          if (firstUnfinished && firstUnfinished.clientId !== veloClientId) {
            return {
              error: `Ordre verrouillé : termine d'abord ${firstUnfinished.entreprise || "le client précédent"}`,
              code: "ORDRE_VERROUILLE",
              fnuci,
              veloClientId,
              veloClientName: livraisonClientName,
              expectedClientId: firstUnfinished.clientId,
              expectedClientName: firstUnfinished.entreprise || null,
            };
          }
        }
      } catch {
        // Faille silencieuse : si le check d'ordre plante (Firestore down,
        // schema bizarre…), on retombe sur le comportement actuel (verrou
        // frontend seul). On n'a JAMAIS le droit de bloquer un scan légitime
        // sur place — chargement demain matin = zéro tolérance bug.
      }

      // 4. Marque l'étape
      const updates: Body = {
        [stage.dateField]: ts(),
        updatedAt: ts(),
      };
      if (userId) updates[stage.userField] = userId;
      await updateDoc(veloDoc.ref, updates);
      return {
        ok: true,
        alreadyDone: false,
        etape: stage.dateField,
        veloId: veloDoc.id,
        fnuci,
        clientId: veloClientId,
        clientName: livraisonClientName,
        date: new Date().toISOString(),
      };
    }

    case "markClientAsDelivered": {
      // Marque toutes les livraisons "en_cours" du client comme livrées.
      const clientId = getRequired(body, "clientId");
      const tourneeId = getString(body, "tourneeId");
      const q = tourneeId
        ? query(
            collection(db, "livraisons"),
            where("clientId", "==", clientId),
            where("tourneeId", "==", tourneeId),
          )
        : query(collection(db, "livraisons"), where("clientId", "==", clientId));
      const snap = await getDocs(q);
      const batch = writeBatch(db);
      let n = 0;
      for (const d of snap.docs) {
        batch.update(d.ref, {
          statut: "livree",
          dateEffective: ts(),
          updatedAt: ts(),
        });
        n++;
      }
      await batch.commit();
      return { ok: true, updated: n };
    }

    case "unmarkVeloEtape": {
      const veloId = getRequired(body, "veloId");
      const etape = getRequired(body, "etape");
      const fieldMap: Record<string, string> = {
        preparation: "datePreparation",
        chargement: "dateChargement",
        livraison: "dateLivraisonScan",
        montage: "dateMontage",
      };
      const field = fieldMap[etape];
      if (!field) return { ok: false, error: `étape inconnue: ${etape}` };
      await updateDoc(doc(db, "velos", veloId), {
        [field]: null,
        updatedAt: ts(),
      });
      return { ok: true };
    }

    case "unsetVeloClient": {
      // ⚠ Bug 29-04 11h09 : avant on mettait clientId=null aussi → le vélo était
      // déclient et le client perdait un slot (28 → 23 chez ANADOLU). Or le
      // texte UI dit "Le slot reste sur la commande du client". On garde donc
      // clientId, on vide juste fnuci + toutes les dates d'étapes (prép, charg,
      // livr, montage). Le vélo redevient un slot vierge pour ce client,
      // disponible pour assignFnuciToClient avec un nouveau FNUCI.
      const veloId = getRequired(body, "veloId");
      await updateDoc(doc(db, "velos", veloId), {
        fnuci: null,
        datePreparation: null,
        dateChargement: null,
        dateLivraisonScan: null,
        dateMontage: null,
        urlPhotoMontageEtiquette: null,
        urlPhotoMontageQrVelo: null,
        photoMontageUrl: null,
        updatedAt: ts(),
      });
      return { ok: true };
    }

    // ---------- équipe ----------
    case "upsertMembre": {
      const id = getString(body, "id");
      const data: Body = {
        nom: body.nom,
        role: body.role,
        telephone: body.telephone || null,
        email: body.email || null,
        actif: body.actif !== false,
        notes: body.notes || null,
        salaireJournalier: body.salaireJournalier ?? null,
        primeVelo: body.primeVelo ?? null,
        updatedAt: ts(),
      };
      if (id) {
        await setDoc(doc(db, "equipe", id), data, { merge: true });
        return { ok: true, id };
      } else {
        // Nouveau membre sans Auth (on n'a pas de mot de passe ici).
        // Le doc est créé avec un id Firestore aléatoire, le compte Auth peut
        // être ajouté plus tard via un script seed-admin.
        const ref = await addDoc(collection(db, "equipe"), {
          ...data,
          createdAt: ts(),
        });
        return { ok: true, id: ref.id };
      }
    }

    case "setMembreCode": {
      // Délègue à la Cloud Function callable (admin SDK requise pour modifier
      // le mot de passe Firebase Auth d'un autre user).
      const callable = httpsCallable<
        { id: string; pin?: string | null },
        { ok: boolean; error?: string }
      >(functions, "setMembreCode");
      try {
        const r = await callable({
          id: getRequired(body, "id"),
          pin: getString(body, "pin") ?? null,
        });
        return r.data;
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }

    case "clearMembreCode": {
      const callable = httpsCallable<
        { id: string },
        { ok: boolean; error?: string }
      >(functions, "clearMembreCode");
      try {
        const r = await callable({ id: getRequired(body, "id") });
        return r.data;
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }

    // ---------- verifications ----------
    case "validateVerification": {
      const id = getRequired(body, "id");
      await updateDoc(doc(db, "verifications", id), {
        status: "validated",
        reviewedAt: ts(),
      });
      return { ok: true };
    }

    case "rejectVerification": {
      const id = getRequired(body, "id");
      await updateDoc(doc(db, "verifications", id), {
        status: "rejected",
        reviewedAt: ts(),
        notes: body.notes || null,
      });
      return { ok: true };
    }

    // ---------- uploads (Storage) ----------
    case "uploadDoc": {
      const clientId = getRequired(body, "clientId");
      const docType = getRequired(body, "docType");
      const fileData = getRequired(body, "fileData");
      const mimeType = getString(body, "mimeType");
      const fileName = getString(body, "fileName") || `${docType}-${Date.now()}`;
      const url = await uploadDataUrl(
        `clients/${clientId}/documents/${fileName}`,
        fileData,
        mimeType,
      );
      // Le composant UI envoie docType au format "flat" (attestationRecue,
      // kbisRecu, devisSignee, signatureOk, inscriptionBicycle…). On accepte
      // aussi les anciens noms courts (attestation, kbis, devis…) au cas où.
      const linkField: Record<string, string> = {
        // noms flat UI
        devisSignee: "docLinks.devis",
        kbisRecu: "docLinks.kbis",
        attestationRecue: "docLinks.attestation",
        signatureOk: "docLinks.signature",
        inscriptionBicycle: "docLinks.bicycle",
        parcelleCadastrale: "docLinks.parcelleCadastrale",
        // alias courts (rétro-compat)
        devis: "docLinks.devis",
        kbis: "docLinks.kbis",
        attestation: "docLinks.attestation",
        signature: "docLinks.signature",
        bicycle: "docLinks.bicycle",
      };
      const flagField: Record<string, string> = {
        devisSignee: "docs.devisSignee",
        kbisRecu: "docs.kbisRecu",
        attestationRecue: "docs.attestationRecue",
        signatureOk: "docs.signatureOk",
        inscriptionBicycle: "docs.inscriptionBicycle",
        parcelleCadastrale: "docs.parcelleCadastrale",
        // alias courts
        devis: "docs.devisSignee",
        kbis: "docs.kbisRecu",
        attestation: "docs.attestationRecue",
        signature: "docs.signatureOk",
        bicycle: "docs.inscriptionBicycle",
      };
      const updates: Body = { updatedAt: ts() };
      if (linkField[docType]) updates[linkField[docType]] = url;
      if (flagField[docType]) updates[flagField[docType]] = true;
      await updateDoc(doc(db, "clients", clientId), updates);
      // Extraction asynchrone des métadonnées via Gemini Vision pour les
      // documents qui contiennent une date + des infos métier (KBIS,
      // liasse/registre du personnel). On ne bloque pas le retour pour
      // garder la latence d'upload basse — l'UI rafraîchira les pastilles
      // quand la date apparaîtra dans Firestore (~3-5s plus tard).
      if (docType === "kbisRecu" || docType === "attestationRecue") {
        const storagePath = `clients/${clientId}/documents/${fileName}`;
        const extractCallable = httpsCallable<
          { clientId: string; docType: string; storagePath: string },
          { ok: boolean }
        >(functions, "extractDocMetadata");
        extractCallable({ clientId, docType, storagePath }).catch((err) => {
          console.warn("extractDocMetadata KO (non bloquant)", err);
        });
      }
      return { ok: true, url };
    }

    case "uploadBlSignedPhoto": {
      // Le composant BlSignedUploader n'a pas livraisonId sous la main, juste
      // tourneeId + clientId. On résout côté serveur (parité avec GAS).
      const tourneeId = getRequired(body, "tourneeId");
      const clientId = getRequired(body, "clientId");
      const photoData = getRequired(body, "photoData");
      const snap = await getDocs(
        query(
          collection(db, "livraisons"),
          where("tourneeId", "==", tourneeId),
          where("clientId", "==", clientId),
        ),
      );
      if (snap.empty) {
        return { error: "Aucune livraison trouvée pour ce client/tournée" };
      }
      const livraisonId = snap.docs[0].id;
      const fileName = `bl-signed-${Date.now()}.jpg`;
      const url = await uploadDataUrl(
        `bl/${livraisonId}/${fileName}`,
        photoData,
        "image/jpeg",
      );
      await updateDoc(doc(db, "livraisons", livraisonId), {
        urlBlSigne: url,
        updatedAt: ts(),
      });
      return { ok: true, livraisonId, clientId, tourneeId, photoUrl: url };
    }

    case "uploadMontagePhoto": {
      // Miroir fidèle de la fonction GAS uploadMontagePhoto : résout le vélo
      // par FNUCI, écrit la photo dans le bon slot (urlPhotoMontageEtiquette /
      // urlPhotoMontageQrVelo / photoMontageUrl), et ne pose dateMontage
      // QUE quand les 3 slots sont remplis (preuve complète du montage).
      const fnuci = getRequired(body, "fnuci").toUpperCase();
      const slot = getRequired(body, "slot");
      const photoData = getRequired(body, "photoData");
      const monteurId = getString(body, "monteurId");

      if (slot !== "etiquette" && slot !== "qrvelo" && slot !== "monte") {
        return { error: "slot invalide (attendu : etiquette, qrvelo, monte)" };
      }

      // 1. Résolution FNUCI → vélo
      const vSnap = await getDocs(
        query(collection(db, "velos"), where("fnuci", "==", fnuci)),
      );
      const matches = vSnap.docs.filter((d) => !(d.data() as { annule?: boolean }).annule);
      if (matches.length === 0) {
        return { error: "FNUCI inconnu — passe d'abord par la préparation", fnuci };
      }
      if (matches.length > 1) {
        return {
          error: `DOUBLON FNUCI : ce code est présent sur ${matches.length} vélos en base. Corrige la saisie avant d'uploader la photo.`,
          fnuci,
          doublons: matches.map((d) => ({
            veloId: d.id,
            clientId: (d.data() as { clientId?: string }).clientId || "",
          })),
        };
      }
      const veloDoc = matches[0];
      const velo = veloDoc.data() as {
        clientId?: string;
        urlPhotoMontageEtiquette?: string;
        urlPhotoMontageQrVelo?: string;
        photoMontageUrl?: string;
        dateMontage?: { toDate?: () => Date } | string;
        datePreparation?: unknown;
        dateChargement?: unknown;
        dateLivraisonScan?: unknown;
      };
      const veloId = veloDoc.id;
      const clientId = velo.clientId || "no-client";

      // 1.5 Verrouillage d'ordre : un vélo ne peut être monté que s'il est
      // déjà préparé, chargé ET livré (sinon photos de montage prises avant
      // la livraison effective — incohérent avec le terrain).
      // Mode bypass admin (Yoann 29-04 02h42) : skip la vérif si flag posé.
      const bypassMontage = body.bypassOrderLock === true;
      const missingMontage: string[] = [];
      if (!velo.datePreparation) missingMontage.push("préparation");
      if (!velo.dateChargement) missingMontage.push("chargement");
      if (!velo.dateLivraisonScan) missingMontage.push("livraison");
      if (!bypassMontage && missingMontage.length > 0) {
        return {
          error: `Impossible de monter : étape${missingMontage.length > 1 ? "s" : ""} manquante${missingMontage.length > 1 ? "s" : ""} (${missingMontage.join(", ")})`,
          code: "ETAPE_PRECEDENTE_MANQUANTE",
          fnuci,
          missing: missingMontage,
        };
      }

      // 2. Upload Storage
      const fileName = `${fnuci}_${slot}_${Date.now()}.jpg`;
      const url = await uploadDataUrl(
        `montage/${clientId}/${fileName}`,
        photoData,
        "image/jpeg",
      );

      // 3. Champ destination en miroir GAS (champs plats lus par le composant)
      const slotField =
        slot === "etiquette"
          ? "urlPhotoMontageEtiquette"
          : slot === "qrvelo"
            ? "urlPhotoMontageQrVelo"
            : "photoMontageUrl";

      const updates: Body = {
        [slotField]: url,
        updatedAt: ts(),
      };

      // 4. Les 3 slots remplis après cet upload ?
      const hasEtiquette = slot === "etiquette" || !!velo.urlPhotoMontageEtiquette;
      const hasQrVelo = slot === "qrvelo" || !!velo.urlPhotoMontageQrVelo;
      const hasMonte = slot === "monte" || !!velo.photoMontageUrl;
      const allThree = hasEtiquette && hasQrVelo && hasMonte;
      const alreadyMonte = !!velo.dateMontage;
      let dateMontageRet: string | null = null;
      if (allThree && !alreadyMonte) {
        updates.dateMontage = ts();
        if (monteurId) updates.monteParId = monteurId;
        dateMontageRet = new Date().toISOString();
      } else if (alreadyMonte) {
        const t = velo.dateMontage as { toDate?: () => Date } | string;
        dateMontageRet =
          typeof t === "string"
            ? t
            : t?.toDate?.()?.toISOString() || null;
      }

      await updateDoc(veloDoc.ref, updates);

      // 5. Nom du client pour message UX
      let clientName: string | null = null;
      try {
        const c = await getDoc(doc(db, "clients", clientId));
        if (c.exists()) {
          clientName = (c.data() as { entreprise?: string }).entreprise || null;
        }
      } catch {}

      return {
        ok: true,
        veloId,
        fnuci,
        clientId,
        clientName,
        slot,
        photoUrl: url,
        photos: { etiquette: hasEtiquette, qrvelo: hasQrVelo, monte: hasMonte },
        complete: allThree,
        dateMontage: dateMontageRet,
      };
    }

    case "uploadVeloPhoto": {
      // 2 schémas d'appel coexistent :
      //   - Préparation/Montage : { stage: "qr" | "etiquette", photoData }
      //   - Livraison (tournee-execute) : { kind: "velo" | "fnuci", fileData }
      // Avant : tout fallback sur `photos.montageQrVelo` parce que `stage`
      // était undefined → écrasement de la photo de montage avec la photo de
      // livraison. Bug 2026-04-28.
      const veloId = getRequired(body, "veloId");
      const kind = getString(body, "kind"); // livraison
      const stage = getString(body, "stage"); // préparation/montage
      const photoData = getString(body, "photoData") || getString(body, "fileData");
      if (!photoData) throw new Error("photoData ou fileData requis");

      // Détermine le "rôle" canonique de la photo
      type Role = "qr" | "etiquette" | "veloLivraison" | "fnuciLivraison";
      let role: Role;
      if (kind === "velo") role = "veloLivraison";
      else if (kind === "fnuci") role = "fnuciLivraison";
      else if (stage === "etiquette") role = "etiquette";
      else role = "qr";

      const folder: Record<Role, string> = {
        qr: "preparation",
        etiquette: "preparation",
        veloLivraison: "livraison",
        fnuciLivraison: "livraison",
      };
      const url = await uploadDataUrl(
        `${folder[role]}/${veloId}/${role}-${Date.now()}.jpg`,
        photoData,
        "image/jpeg",
      );

      // Champ Firestore + side-effect par rôle
      const updates: Body = { updatedAt: ts() };
      if (role === "qr") {
        updates["photos.montageQrVelo"] = url;
        updates.photoQrPrise = true;
      } else if (role === "etiquette") {
        updates["photos.montageEtiquette"] = url;
      } else if (role === "veloLivraison") {
        updates["photos.veloLivraison"] = url;
        updates.photoVeloUrl = url; // top-level lu par getTourneeExecution
      } else if (role === "fnuciLivraison") {
        updates["photos.fnuciLivraison"] = url;
        updates.photoFnuciUrl = url;
      }

      await updateDoc(doc(db, "velos", veloId), updates);
      return { ok: true, url };
    }

    case "setDisponibilites": {
      // Miroir gas/Code.js setDisponibilites (5196). Pour la date donnée,
      // on bascule actif=true pour les ressources demandées, actif=false
      // pour les autres dispos existantes de cette date.
      const date = getString(body, "date");
      if (!date) return { error: "date requise (YYYY-MM-DD)" };
      const desired = {
        camion: (body.camionIds as string[]) || [],
        chauffeur: (body.chauffeurIds as string[]) || [],
        chef: (body.chefIds as string[]) || [],
        monteur: (body.monteurIds as string[]) || [],
      };

      const snap = await getDocs(
        query(collection(db, "disponibilites"), where("date", "==", date)),
      );
      const existing: Record<string, { ref: ReturnType<typeof doc>; actif: boolean }> = {};
      for (const d of snap.docs) {
        const o = d.data() as { ressourceType?: string; ressourceId?: string; actif?: boolean };
        const key = `${o.ressourceType}|${o.ressourceId}`;
        existing[key] = { ref: d.ref, actif: o.actif !== false };
      }

      let added = 0;
      let reactivated = 0;
      let archived = 0;
      // Phase 1 : ajouter ou réactiver
      const batch = writeBatch(db);
      const desiredKeys = new Set<string>();
      for (const [type, ids] of Object.entries(desired)) {
        for (const rid of ids) {
          if (!rid) continue;
          const key = `${type}|${rid}`;
          desiredKeys.add(key);
          const ex = existing[key];
          if (ex) {
            if (!ex.actif) {
              batch.update(ex.ref, { actif: true, updatedAt: ts() });
              reactivated++;
            }
          } else {
            // Doc id stable : YYYY-MM-DD_type_rid → idempotent en cas de retry.
            const newId = `${date}_${type}_${rid}`;
            batch.set(doc(db, "disponibilites", newId), {
              date,
              ressourceType: type,
              ressourceId: rid,
              actif: true,
              createdAt: ts(),
              updatedAt: ts(),
            });
            added++;
          }
        }
      }
      // Phase 2 : archiver ce qui n'est plus voulu
      for (const [key, ex] of Object.entries(existing)) {
        if (!desiredKeys.has(key) && ex.actif) {
          batch.update(ex.ref, { actif: false, updatedAt: ts() });
          archived++;
        }
      }
      await batch.commit();
      return { ok: true, added, reactivated, archived };
    }

    case "importClients": {
      // Import CSV : crée des clients depuis des rows {entreprise, contact,
      // email, telephone, adresse, ville, codePostal, nbVelos}. GAS n'a
      // jamais implémenté cette action — bouton no-op aujourd'hui.
      // On crée 1 client par row, sans dédoublonnage agressif (l'utilisateur
      // est responsable de ne pas réimporter le même CSV).
      const rows = (body.rows as Array<Record<string, unknown>>) || [];
      if (!Array.isArray(rows) || rows.length === 0) {
        return { ok: false, error: "rows vide", created: 0 };
      }
      let created = 0;
      const errors: Array<{ entreprise: string; error: string }> = [];
      for (let i = 0; i < rows.length; i += 400) {
        const batch = writeBatch(db);
        for (const row of rows.slice(i, i + 400)) {
          try {
            const entreprise = String(row.entreprise || "").trim();
            if (!entreprise) continue;
            const apporteur = String(row.apporteur || "").trim() || null;
            const apporteurLower = apporteur ? apporteur.toLowerCase() : null;
            const nbVelosRaw = row.nbVelos;
            const nbVelos = Math.max(
              0,
              Math.round(
                typeof nbVelosRaw === "number" ? nbVelosRaw : Number(nbVelosRaw) || 0,
              ),
            );
            const ref = doc(collection(db, "clients"));
            batch.set(ref, {
              entreprise,
              contact: String(row.contact || "").trim() || null,
              email: String(row.email || "").trim() || null,
              telephone: String(row.telephone || "").trim() || null,
              adresse: String(row.adresse || "").trim() || null,
              ville: String(row.ville || "").trim() || null,
              codePostal: String(row.codePostal || "").trim() || null,
              departement:
                String(row.codePostal || "").slice(0, 2) || null,
              apporteur,
              apporteurLower,
              nbVelosCommandes: nbVelos,
              docs: {},
              docLinks: {},
              docDates: {},
              stats: {
                totalVelos: 0,
                montes: 0,
                livres: 0,
                totalLivraisonsLivrees: 0,
                blSignes: 0,
                facturables: 0,
                planifies: 0,
                certificats: 0,
                factures: 0,
              },
              createdAt: ts(),
              updatedAt: ts(),
            });
            created++;
          } catch (e) {
            errors.push({
              entreprise: String(row.entreprise || ""),
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        await batch.commit();
      }
      return { ok: true, created, errors, total: rows.length };
    }

    case "bulkAutoValidate": {
      // Miroir fidèle de gas/Code.js bulkAutoValidate (ligne 3003).
      // Auto-valide en lot toutes les vérifications "pending" avec clientId
      // et docType reconnu. Pose flag+lien sur la fiche client (mode C :
      // flag toujours posé, lien posé seulement si vide aujourd'hui — on ne
      // casse jamais un lien classé manuellement).
      const dryRun = body.dryRun === true || body.dryRun === "true";
      const excludeRaw = body.excludeClientIds;
      const excludeSet = new Set<string>();
      if (Array.isArray(excludeRaw)) {
        for (const id of excludeRaw) excludeSet.add(String(id));
      } else if (typeof excludeRaw === "string") {
        try {
          const parsed = JSON.parse(excludeRaw);
          if (Array.isArray(parsed)) for (const id of parsed) excludeSet.add(String(id));
        } catch {}
      }

      // Mapping docType → { flag, link } (miroir GAS DOC_TYPE_TO_CLIENT_FIELDS)
      const DOC_TYPE_MAP: Record<string, { flag: string; link: string }> = {
        DEVIS: { flag: "devisSignee", link: "devisLien" },
        KBIS: { flag: "kbisRecu", link: "kbisLien" },
        LIASSE: { flag: "attestationRecue", link: "attestationLien" },
        URSSAF: { flag: "attestationRecue", link: "attestationLien" },
        ATTESTATION: { flag: "attestationRecue", link: "attestationLien" },
        SIGNATURE: { flag: "signatureOk", link: "signatureLien" },
        BICYCLE: { flag: "inscriptionBicycle", link: "bicycleLien" },
        PARCELLE: { flag: "parcelleCadastrale", link: "parcelleCadastraleLien" },
      };
      // Flat field name → Firestore nested path
      const FLAG_TO_PATH: Record<string, string> = {
        devisSignee: "docs.devisSignee",
        kbisRecu: "docs.kbisRecu",
        attestationRecue: "docs.attestationRecue",
        signatureOk: "docs.signatureOk",
        inscriptionBicycle: "docs.inscriptionBicycle",
        parcelleCadastrale: "docs.parcelleCadastrale",
      };
      const LINK_TO_PATH: Record<string, string> = {
        devisLien: "docLinks.devis",
        kbisLien: "docLinks.kbis",
        attestationLien: "docLinks.attestation",
        signatureLien: "docLinks.signature",
        bicycleLien: "docLinks.bicycle",
        parcelleCadastraleLien: "docLinks.parcelleCadastrale",
      };

      // Parcourt les vérifications. Status pending OR vide OR unassigned.
      const verifSnap = await getDocs(collection(db, "verifications"));
      const skipReasons = {
        notPending: 0,
        noClient: 0,
        clientNotFound: 0,
        unknownDocType: 0,
        excluded: 0,
      };
      const byDocType: Record<string, number> = {};
      const sample: Array<{ id: string; clientId: string; docType: string; fileName: string; action: string }> = [];
      // clientId → flagFlat → { linkField, link?, when, setFlag }
      const pendingClientUpdates: Record<string, Record<string, { linkField: string; link: string | null; when: number; setFlag: boolean }>> = {};
      const rowsToValidate: Array<{ verifId: string; action: string }> = [];
      const counts = { fresh: 0, linkOnly: 0, skipExisting: 0 };
      type ClientBreakdown = {
        clientId: string;
        entreprise: string;
        fresh: number;
        linkOnly: number;
        skipExisting: number;
        byDocType: Record<string, number>;
        total?: number;
      };
      const clientsBreakdown: Record<string, ClientBreakdown> = {};

      // Pré-charge les clients en une seule passe (collection size raisonnable).
      const cSnap = await getDocs(collection(db, "clients"));
      type ClientDoc = {
        entreprise?: string;
        docs?: Record<string, boolean>;
        docLinks?: Record<string, string>;
      };
      const clientsById: Record<string, ClientDoc> = {};
      for (const cd of cSnap.docs) clientsById[cd.id] = cd.data() as ClientDoc;

      const tsToMs = (x: unknown): number => {
        if (!x) return 0;
        if (typeof x === "string") {
          const t = Date.parse(x);
          return Number.isFinite(t) ? t : 0;
        }
        const t = x as { toDate?: () => Date };
        return t?.toDate ? t.toDate().getTime() : 0;
      };

      for (const vd of verifSnap.docs) {
        const v = vd.data() as {
          clientId?: string;
          docType?: string;
          driveUrl?: string;
          storageUrl?: string;
          status?: string;
          fileName?: string;
          receivedAt?: unknown;
        };
        const status = (v.status || "").toLowerCase();
        if (status !== "" && status !== "pending" && status !== "unassigned") {
          skipReasons.notPending++;
          continue;
        }
        const clientId = v.clientId || "";
        if (!clientId) {
          skipReasons.noClient++;
          continue;
        }
        if (excludeSet.has(String(clientId))) {
          skipReasons.excluded++;
          continue;
        }
        const client = clientsById[clientId];
        if (!client) {
          skipReasons.clientNotFound++;
          continue;
        }
        const docType = (v.docType || "").toUpperCase();
        const mapping = DOC_TYPE_MAP[docType];
        if (!mapping) {
          skipReasons.unknownDocType++;
          continue;
        }

        const currentFlag = !!(client.docs?.[mapping.flag] === true);
        // Le lien est nommé sans "Lien" dans docLinks (devisLien → docLinks.devis).
        const linkKey = mapping.link.replace(/Lien$/, "");
        const currentLink = (client.docLinks?.[linkKey] || "") as string;
        const linkIsEmpty = !currentLink || currentLink.trim() === "";
        byDocType[docType] = (byDocType[docType] || 0) + 1;

        // driveUrl GAS pouvait contenir plusieurs URLs séparées par " ||| ", on garde la 1ère
        const driveUrl = String(v.driveUrl || v.storageUrl || "").split(" ||| ")[0];
        const receivedTs = tsToMs(v.receivedAt);

        let action: "fresh" | "linkOnly" | "skipExisting";
        if (currentFlag && !linkIsEmpty) action = "skipExisting";
        else if (currentFlag && linkIsEmpty) action = "linkOnly";
        else action = "fresh"; // !flag (link vide ou non) → on coche

        if (action !== "skipExisting") {
          const slot = (pendingClientUpdates[clientId] ||= {});
          const prev = slot[mapping.flag];
          if (!prev || receivedTs >= (prev.when || 0)) {
            slot[mapping.flag] = {
              linkField: mapping.link,
              link: linkIsEmpty ? driveUrl : null,
              when: receivedTs,
              setFlag: !currentFlag,
            };
          }
        }

        counts[action]++;
        rowsToValidate.push({ verifId: vd.id, action });

        let bk = clientsBreakdown[clientId];
        if (!bk) {
          bk = clientsBreakdown[clientId] = {
            clientId,
            entreprise: client.entreprise || "",
            fresh: 0,
            linkOnly: 0,
            skipExisting: 0,
            byDocType: {},
          };
        }
        bk[action]++;
        bk.byDocType[docType] = (bk.byDocType[docType] || 0) + 1;
        if (sample.length < 10) {
          sample.push({
            id: vd.id,
            clientId,
            docType,
            fileName: v.fileName || "",
            action,
          });
        }
      }

      const clientsList = Object.values(clientsBreakdown)
        .map((b) => ({ ...b, total: b.fresh + b.linkOnly + b.skipExisting }))
        .sort((a, b) => (b.total || 0) - (a.total || 0));

      const preview = {
        wouldValidate: rowsToValidate.length,
        fresh: counts.fresh,
        linkOnly: counts.linkOnly,
        skipExisting: counts.skipExisting,
        skipped:
          skipReasons.notPending +
          skipReasons.noClient +
          skipReasons.clientNotFound +
          skipReasons.unknownDocType +
          skipReasons.excluded,
        skipReasons,
        byDocType,
        clientsTouched: Object.keys(pendingClientUpdates).length,
        clientsBreakdown: clientsList,
        sample,
        dryRun,
      } as Body;

      if (dryRun || rowsToValidate.length === 0) {
        return preview;
      }

      // Application : updates clients par batches (writeBatch limité à 500 ops),
      // puis verifs status=validated + note. Idempotent en cas de retry partiel.
      let clientsUpdated = 0;
      const stamp = new Date().toISOString().slice(0, 10);
      const cIds = Object.keys(pendingClientUpdates);
      for (let i = 0; i < cIds.length; i += 400) {
        const batch = writeBatch(db);
        for (const cid of cIds.slice(i, i + 400)) {
          const slot = pendingClientUpdates[cid];
          const updates: Body = { updatedAt: ts() };
          let changed = false;
          for (const flagFlat of Object.keys(slot)) {
            const info = slot[flagFlat];
            if (info.setFlag) {
              const path = FLAG_TO_PATH[flagFlat];
              if (path) {
                updates[path] = true;
                changed = true;
              }
            }
            if (info.link) {
              const lpath = LINK_TO_PATH[info.linkField];
              if (lpath) {
                updates[lpath] = info.link;
                changed = true;
              }
            }
          }
          if (changed) {
            batch.update(doc(db, "clients", cid), updates);
            clientsUpdated++;
          }
        }
        await batch.commit();
      }

      for (let i = 0; i < rowsToValidate.length; i += 400) {
        const batch = writeBatch(db);
        for (const item of rowsToValidate.slice(i, i + 400)) {
          // Note : on append "auto-bulk YYYY-MM-DD (action)" en pose simple
          // (pas de read-modify-write — assez bon pour traçabilité).
          batch.update(doc(db, "verifications", item.verifId), {
            status: "validated",
            reviewedAt: ts(),
            notes: `auto-bulk ${stamp} (${item.action})`,
          });
        }
        await batch.commit();
      }

      preview.validated = rowsToValidate.length;
      preview.clientsUpdated = clientsUpdated;
      return preview;
    }

    case "syncBonsNow": {
      // Force la sync GAS → Firestore des bonsEnlevement + verifications
      // immédiatement (sans attendre le cron 15 min). Délègue à la Cloud
      // Function syncFromGasNow (réservée admins).
      const callable = httpsCallable<
        Record<string, never>,
        { ok: boolean; bons?: number; verifs?: number; error?: string }
      >(functions, "syncFromGasNow");
      try {
        const r = await callable({});
        return r.data;
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }

    case "proposeTournee": {
      // Cloud Function europe-west1. Lit Firestore (dispos, équipe, flotte,
      // clients, livraisons), construit le prompt, appelle Gemini, parse +
      // sanitize, renvoie la même ProposeResponse que l'ancienne route GAS.
      // Le frontend day-planner-modal.tsx envoyait { getPromptOnly, geminiText }
      // pour le bypass Vercel — devenu inutile (la CF est notre serveur).
      const date = getString(body, "date");
      const mode = getString(body, "mode") || "fillGaps";
      const models = Array.isArray(body.models) ? (body.models as string[]) : undefined;
      if (!date) return { error: "date YYYY-MM-DD requise" };
      // Timeout 300s côté client (SDK default 70s coupe trop tôt). La CF
      // elle-même est capée à 540s mais avec retry court côté CF (2 essais
      // × 4s backoff par modèle) on devrait rester sous 3 min en p99.
      const callable = httpsCallable<
        { date: string; mode: string; models?: string[] },
        Record<string, unknown>
      >(functions, "proposeTournee", { timeout: 300000 });
      try {
        const r = await callable({ date, mode, models });
        return r.data;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    }

    case "testGemini": {
      // Diagnostic admin (cf. functions/src/index.ts testGemini Cloud Function).
      const callable = httpsCallable<Record<string, never>, Record<string, unknown>>(
        functions,
        "testGemini",
      );
      try {
        const r = await callable({});
        return r.data;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    }

    case "getRouting": {
      // Distance Matrix Google Maps (cf. functions/src/index.ts getRouting CF).
      // Body : { points: [{ lat, lng }, ...] } → { ok, segments, apiCalls, cached }
      const points = (body.points as Array<{ lat?: number; lng?: number }>) || [];
      const callable = httpsCallable<
        { points: Array<{ lat?: number; lng?: number }> },
        Record<string, unknown>
      >(functions, "getRouting");
      try {
        const r = await callable({ points });
        return r.data;
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e), segments: [] };
      }
    }

    case "extractFnuciFromImage": {
      // Proxifie vers la Cloud Function (nécessaire pour l'API key Gemini).
      // Le frontend (photo-gemini-capture) gère ensuite le mirror Firestore
      // via les actions migrées (assignFnuciToClient + markVeloPrepare/...)
      // — la Cloud Function ne fait QUE l'extraction OCR.
      const imageBase64 = getString(body, "imageBase64");
      const mimeType = getString(body, "mimeType") || "image/jpeg";
      if (!imageBase64) return { ok: false, error: "imageBase64 requis" };
      const callable = httpsCallable<
        { imageBase64: string; mimeType: string },
        Record<string, unknown>
      >(functions, "extractFnuciFromImage");
      try {
        const r = await callable({ imageBase64, mimeType });
        return r.data;
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }

    case "fetchParcelle": {
      // Migré depuis gas/Code.js:2145. Workflow :
      //   1) Si déjà flaggé + lien stocké → renvoie cache (évite throttle apicarto).
      //   2) Géocode l'adresse client via api-adresse.data.gouv.fr (public).
      //   3) Récupère la parcelle via apicarto.ign.fr (Polygon GeoJSON).
      //   4) Calcul centroid (plus précis que coords adresse pour zoom 20).
      //   5) Construit l'URL cadastre.data.gouv.fr/parcelles/<id> (lien direct
      //      qui encadre la parcelle EXACTE — important pour CEE).
      //   6) Met à jour le doc client (parcelleCadastrale=true + lien).
      const cidPrc = String(body.clientId || "");
      if (!cidPrc) return { error: "ID client manquant" };

      const cRefP = doc(db, "clients", cidPrc);
      const cSnapP = await getDoc(cRefP);
      if (!cSnapP.exists()) return { error: "Client non trouvé" };
      const cDataP = cSnapP.data() as {
        adresse?: string;
        codePostal?: string;
        ville?: string;
        docLinks?: { parcelleCadastrale?: string };
        docs?: { parcelleCadastrale?: boolean };
      };

      // Cache : si déjà flaggé + lien, on sort tout de suite.
      const lienCacheP = String(cDataP.docLinks?.parcelleCadastrale || "").trim();
      const flagCacheP = !!cDataP.docs?.parcelleCadastrale;
      if (flagCacheP && lienCacheP) {
        const refMatch = lienCacheP.match(/\/parcelles\/(\d{5})(\d{0,5}?)([A-Z]{1,3})(\d{1,4})$/);
        return {
          ok: true,
          cached: true,
          parcelle: refMatch ? `${refMatch[1]} ${refMatch[3]} ${refMatch[4]}` : "(stockée)",
          commune: refMatch ? refMatch[1] : "",
          section: refMatch ? refMatch[3] : "",
          numero: refMatch ? refMatch[4] : "",
          contenance: null,
          lat: null,
          lng: null,
          parcelleLien: lienCacheP,
          geoportailUrl: lienCacheP,
        };
      }

      const adresseP = String(cDataP.adresse || "").trim();
      const cpP = String(cDataP.codePostal || "").trim();
      const villeP = String(cDataP.ville || "").trim();
      const qP = [adresseP, cpP, villeP].filter(Boolean).join(" ");
      if (!qP) return { error: "Adresse client vide — renseignez l'adresse, le code postal et la ville." };

      // 1) Géocodage
      let lat: number, lng: number;
      try {
        const geoRes = await fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(qP)}&limit=1`);
        if (!geoRes.ok) return { error: `Erreur géocodage : HTTP ${geoRes.status}` };
        const geoData = await geoRes.json() as { features?: Array<{ geometry?: { coordinates?: number[] } }> };
        if (!geoData.features || geoData.features.length === 0) {
          return { error: "Adresse introuvable sur api-adresse.data.gouv.fr" };
        }
        const coords = geoData.features[0].geometry?.coordinates;
        if (!coords || coords.length < 2) return { error: "Coords manquantes dans réponse géocodage" };
        lng = coords[0];
        lat = coords[1];
      } catch (e) {
        return { error: `Erreur géocodage : ${e instanceof Error ? e.message : String(e)}` };
      }

      // 2) Parcelle via apicarto + récup géométrie pour centroid précis
      type CadastreProps = { code_com?: string; commune?: string; section?: string; numero?: string; contenance?: string | number };
      type CadastreFeature = { properties?: CadastreProps; geometry?: { coordinates?: number[][][] | number[][][][] } };
      let props: CadastreProps | null = null;
      let geom: CadastreFeature["geometry"] | null = null;
      try {
        const cadUrl = `https://apicarto.ign.fr/api/cadastre/parcelle?geom=${encodeURIComponent(`{"type":"Point","coordinates":[${lng},${lat}]}`)}&_limit=1`;
        const cadRes = await fetch(cadUrl);
        if (cadRes.ok) {
          const cadData = await cadRes.json() as { features?: CadastreFeature[] };
          if (cadData.features && cadData.features.length > 0) {
            props = cadData.features[0].properties || null;
            geom = cadData.features[0].geometry || null;
          }
        }
      } catch {}

      // Fallback : geo.api.gouv.fr pour au moins choper le code commune.
      if (!props) {
        try {
          const fbRes = await fetch(`https://geo.api.gouv.fr/communes?lat=${lat}&lon=${lng}&fields=codeDepartement,codeCommune&limit=1`);
          if (fbRes.ok) {
            const communes = await fbRes.json() as Array<{ code?: string }>;
            if (communes.length > 0) {
              props = { code_com: communes[0].code, section: "", numero: "", contenance: "" };
            }
          }
        } catch {}
      }

      if (!props) return { error: "API cadastre indisponible — réessayez plus tard." };

      const codeCommune = String(props.code_com || props.commune || "");
      const section = String(props.section || "");
      const numero = String(props.numero || "");
      const contenance = props.contenance != null ? Number(props.contenance) : null;
      const refParcelle = `${codeCommune} ${section} ${numero}`.trim();

      // Centroid de la géométrie si dispo (plus précis que coords adresse)
      let centerLat = lat;
      let centerLng = lng;
      try {
        if (geom?.coordinates) {
          const raw = geom.coordinates as unknown as number[][][] | number[][][][];
          let ring: number[][] | null = null;
          // Polygon : coords[0] = anneau extérieur. MultiPolygon : coords[0][0].
          const r0 = raw[0];
          if (Array.isArray(r0) && Array.isArray(r0[0]) && Array.isArray((r0[0] as unknown[])[0])) {
            ring = r0[0] as unknown as number[][];
          } else {
            ring = r0 as unknown as number[][];
          }
          if (ring && ring.length > 2) {
            let sumX = 0;
            let sumY = 0;
            for (const p of ring) {
              sumX += p[0];
              sumY += p[1];
            }
            centerLng = sumX / ring.length;
            centerLat = sumY / ring.length;
          }
        }
      } catch {}

      // Lien direct cadastre.data.gouv.fr (format ID fiscal : INSEE+SECTION_PAD5+NUMERO_PAD4)
      const pad = (s: string, n: number) => {
        let v = String(s || "");
        while (v.length < n) v = `0${v}`;
        return v;
      };
      let parcelleLien = "";
      if (codeCommune && section && numero) {
        parcelleLien = `https://cadastre.data.gouv.fr/parcelles/${codeCommune}${pad(section, 5)}${pad(numero, 4)}`;
      } else {
        // Fallback Géoportail centré sur centroid.
        parcelleLien = `https://www.geoportail.gouv.fr/carte?c=${centerLng},${centerLat}&z=20&l0=GEOGRAPHICALGRIDSYSTEMS.MAPS.SCAN-EXPRESS-STANDARD::GEOPORTAIL:OGC:WMTS(1)&l1=CADASTRALPARCELS.PARCELLAIRE_EXPRESS::GEOPORTAIL:OGC:WMTS(0.7)&permalink=yes`;
      }

      // Persist sur le doc client
      try {
        await updateDoc(cRefP, {
          "docs.parcelleCadastrale": true,
          "docLinks.parcelleCadastrale": parcelleLien,
          updatedAt: ts(),
        });
      } catch (e) {
        return { error: `Échec persistance client : ${e instanceof Error ? e.message : String(e)}` };
      }

      return {
        ok: true,
        parcelle: refParcelle,
        section,
        numero,
        commune: codeCommune,
        contenance,
        lat: centerLat,
        lng: centerLng,
        parcelleLien,
        geoportailUrl: parcelleLien,
      };
    }

    case "autoFetchParcelles": {
      // Migré depuis gas/Code.js:2338. Boucle séquentielle (250ms entre appels)
      // sur les clients sans flag parcelleCadastrale, avec adresse renseignée.
      const limit = Math.max(1, Number(body.limit) || 50);
      const cSnapAFP = await getDocs(collection(db, "clients"));
      const report = {
        processed: 0,
        ok: 0,
        skipped: 0,
        failed: 0,
        errors: [] as Array<{ clientId: string; error: string }>,
      };
      for (const d of cSnapAFP.docs) {
        if (report.processed >= limit) break;
        const o = d.data() as { docs?: { parcelleCadastrale?: boolean }; adresse?: string };
        if (o.docs?.parcelleCadastrale) { report.skipped++; continue; }
        if (!String(o.adresse || "").trim()) { report.skipped++; continue; }
        report.processed++;
        try {
          const res = await runFirestoreAction("fetchParcelle", { clientId: d.id }) as {
            ok?: boolean;
            error?: string;
          };
          if (res?.ok) {
            report.ok++;
          } else {
            report.failed++;
            if (res?.error && report.errors.length < 10) {
              report.errors.push({ clientId: d.id, error: res.error });
            }
          }
        } catch (err) {
          report.failed++;
          if (report.errors.length < 10) {
            report.errors.push({ clientId: d.id, error: err instanceof Error ? err.message : String(err) });
          }
        }
        // Pause légère pour lisser apicarto (limite ~1000 req/jour)
        await new Promise((r) => setTimeout(r, 250));
      }
      return report;
    }

    case "suggestTournee": {
      // Migré depuis gas/Code.js:957. Algo pur (pas Gemini) :
      //   1) Charger client cible + tous clients + livraisons planifiees
      //   2) Calculer "vélos restants à planifier" par client = nbVelosCommandes
      //      − vélos déjà livrés − vélos planifiés en livraison(s) en cours
      //      (calcul live à partir des livraisons réelles, pas des stats
      //      persistées qui peuvent dériver — cf. fix /carte 2026-04-28).
      //   3) Filtrer nearby = clients ≠ cible, distance ≤ maxDistance, reste > 0
      //   4) Bin packing en N camions de capacité fixe (compact : remplir
      //      camion par camion, le client cible d'abord, puis nearby triés
      //      par distance croissante)
      //   5) Format de retour identique GAS (mode/capacite/nbCamions/splits/
      //      tournee/totalVelos/clientsProches) pour ne pas casser /carte.
      const clientId = String(body.clientId || "");
      const mode = String(body.mode || "moyen");
      const maxDistance = Number(body.maxDistance || 50);
      if (!clientId) return { error: "clientId requis" };

      // Capacité : si le frontend a passé une capacité explicite (ex: clic sur
      // "Moyen 65v" précis), on la prend. Sinon, fallback sur la table par
      // type (cf. gas/Code.js:965).
      const capaciteOverride = Number(body.capacite);
      const capacites: Record<string, number> = {
        gros: 132,
        moyen: 54,
        camionnette: 20,
        petit: 20,
        retrait: 9999,
      };
      const capacite = capaciteOverride > 0 ? capaciteOverride : (capacites[mode] ?? 54);

      // 1) Tous les clients livrables (avec lat/lng)
      const cSnap = await getDocs(collection(db, "clients"));
      type Pt = {
        id: string;
        entreprise: string;
        ville: string;
        lat: number;
        lng: number;
        nbVelos: number;
        velosLivres: number;
      };
      const points: Pt[] = [];
      let target: Pt | null = null;
      for (const d of cSnap.docs) {
        const o = d.data() as {
          entreprise?: string;
          ville?: string;
          latitude?: number;
          longitude?: number;
          nbVelosCommandes?: number;
          stats?: { livres?: number };
        };
        const lat = typeof o.latitude === "number" ? o.latitude : NaN;
        const lng = typeof o.longitude === "number" ? o.longitude : NaN;
        if (!isFinite(lat) || !isFinite(lng)) {
          if (d.id === clientId) target = null;
          continue;
        }
        const pt: Pt = {
          id: d.id,
          entreprise: String(o.entreprise || ""),
          ville: String(o.ville || ""),
          lat,
          lng,
          nbVelos: Number(o.nbVelosCommandes || 0),
          velosLivres: Number(o.stats?.livres || 0),
        };
        points.push(pt);
        if (d.id === clientId) target = pt;
      }
      if (!target) return { error: "Client non trouvé" };

      // 2) Livraisons planifiees → vélos planifiés par clientId (live)
      const lSnap = await getDocs(collection(db, "livraisons"));
      const planifiesParClient = new Map<string, number>();
      for (const d of lSnap.docs) {
        const o = d.data() as { statut?: string; clientId?: string; nbVelos?: number };
        if (String(o.statut || "").toLowerCase() !== "planifiee") continue;
        const cid = String(o.clientId || "");
        if (!cid) continue;
        planifiesParClient.set(cid, (planifiesParClient.get(cid) || 0) + (Number(o.nbVelos) || 0));
      }
      const resteOf = (p: Pt): number =>
        Math.max(0, p.nbVelos - p.velosLivres - (planifiesParClient.get(p.id) || 0));

      const velosTarget = resteOf(target);
      if (velosTarget <= 0) {
        return { error: "Aucun vélo à planifier pour ce client (tout livré ou déjà planifié)." };
      }

      // 3) Cas retrait : tournée mono-stop client cible
      if (mode === "retrait") {
        const retStops = [{
          id: target.id,
          entreprise: target.entreprise,
          ville: target.ville,
          lat: target.lat,
          lng: target.lng,
          nbVelos: velosTarget,
          distance: 0,
        }];
        return {
          mode: "retrait",
          capacite: velosTarget,
          nbCamions: 1,
          velosClient: velosTarget,
          splits: [{ stops: retStops, totalVelos: velosTarget, capacite: velosTarget, indexCamion: 1, nbCamionsTotal: 1 }],
          tournee: retStops,
          totalVelos: velosTarget,
          clientsProches: [],
        };
      }

      // 4) Nearby : clients ≠ cible avec lat/lng, dans le rayon, avec reste > 0
      type Near = Pt & { distance: number; velosRestants: number };
      const nearby: Near[] = points
        .filter((c) => c.id !== clientId)
        .map((c) => ({
          ...c,
          distance: haversineKmFs(target.lat, target.lng, c.lat, c.lng),
          velosRestants: resteOf(c),
        }))
        .filter((c) => c.distance <= maxDistance && c.velosRestants > 0)
        .sort((a, b) => a.distance - b.distance);

      // 5) Bin packing — chaque camion plein avant le suivant
      const nbCamions = Math.ceil(velosTarget / capacite);
      const splits: Array<{
        stops: Array<{ id: string; entreprise: string; ville: string; lat: number; lng: number; nbVelos: number; distance: number }>;
        totalVelos: number;
        capacite: number;
        indexCamion: number;
        nbCamionsTotal: number;
      }> = [];
      let velosACassign = velosTarget;

      for (let k = 0; k < nbCamions; k++) {
        const velosCeCamion = Math.min(velosACassign, capacite);
        const stops = [{
          id: target.id,
          entreprise: target.entreprise,
          ville: target.ville,
          lat: target.lat,
          lng: target.lng,
          nbVelos: velosCeCamion,
          distance: 0,
        }];

        let resteCamion = capacite - velosCeCamion;
        for (let j = 0; j < nearby.length && resteCamion > 0; j++) {
          const c = nearby[j];
          if (c.velosRestants <= 0) continue;
          const nb = Math.min(c.velosRestants, resteCamion);
          stops.push({
            id: c.id,
            entreprise: c.entreprise,
            ville: c.ville,
            lat: c.lat,
            lng: c.lng,
            nbVelos: nb,
            distance: Math.round(c.distance * 10) / 10,
          });
          c.velosRestants -= nb;
          resteCamion -= nb;
        }

        splits.push({
          stops,
          totalVelos: stops.reduce((s, t) => s + t.nbVelos, 0),
          capacite,
          indexCamion: k + 1,
          nbCamionsTotal: nbCamions,
        });
        velosACassign -= velosCeCamion;
      }

      return {
        mode,
        capacite,
        nbCamions,
        velosClient: velosTarget,
        splits,
        // Compat ascendante : 1ère tournée à plat (cf. gas/Code.js:1045)
        tournee: splits[0].stops,
        totalVelos: splits[0].totalVelos,
        clientsProches: nearby.slice(0, 20).map((c) => ({
          id: c.id,
          entreprise: c.entreprise,
          ville: c.ville,
          lat: c.lat,
          lng: c.lng,
          distance: Math.round(c.distance * 10) / 10,
          velosRestants: c.velosRestants,
        })),
      };
    }

    default:
      return { ok: false, error: `Action Firestore non implémentée: ${action}` };
  }
}

// -------- read helpers (aussi utilisable depuis gas.ts) --------

/**
 * Quelques lectures qui pourraient appeler GAS aujourd'hui.
 * Pas exhaustif — on étend si besoin.
 */
// Calcule le nombre de vélos qu'on peut encore planifier pour un client :
//   nbVelosCommandes (devis) − stats.livres − sum(nbVelos) des livraisons
//   actives (planifiee). Retourne null si client introuvable (le caller
//   laisse passer la valeur demandée). Cf. bug OPEN SOURCING 2026-04-28.
async function computeRemainingVelos(clientId: string): Promise<number | null> {
  try {
    const cSnap = await getDoc(doc(db, "clients", clientId));
    if (!cSnap.exists()) return null;
    const c = cSnap.data() as { nbVelosCommandes?: number; stats?: { livres?: number } };
    const totalCommande = Number(c.nbVelosCommandes) || 0;
    const livres = Number(c.stats?.livres) || 0;
    const livSnap = await getDocs(
      query(collection(db, "livraisons"), where("clientId", "==", clientId)),
    );
    let planifies = 0;
    for (const d of livSnap.docs) {
      const o = d.data() as { statut?: string; nbVelos?: number };
      if (String(o.statut || "").toLowerCase() === "planifiee") {
        planifies += Number(o.nbVelos) || 0;
      }
    }
    return Math.max(0, totalCommande - livres - planifies);
  } catch {
    return null;
  }
}

// Géocode une adresse client via api-adresse.data.gouv.fr (public, sans clé).
// "PARIS 01..20" doit être normalisé en "PARIS" (l'API ne reconnaît pas les
// arrondissements en suffixe ville). Retourne null en cas d'échec — le caller
// continue sans coords plutôt que de bloquer la création.
async function geocodeClientAddress(input: {
  adresse?: unknown;
  codePostal?: unknown;
  ville?: unknown;
}): Promise<{ lat: number; lng: number } | null> {
  const adresse = String(input.adresse || "").trim();
  if (!adresse) return null;
  const codePostal = String(input.codePostal || "").trim();
  const villeRaw = String(input.ville || "").trim();
  const villeNorm = villeRaw.replace(/^PARIS\s+\d+$/i, "PARIS");
  const q = [adresse, codePostal, villeNorm].filter(Boolean).join(" ");
  if (!q) return null;
  try {
    const res = await fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=1`);
    if (!res.ok) return null;
    const data = await res.json() as { features?: Array<{ geometry?: { coordinates?: number[] } }> };
    const coords = data.features?.[0]?.geometry?.coordinates;
    if (!coords || coords.length < 2) return null;
    return { lng: coords[0], lat: coords[1] };
  } catch {
    return null;
  }
}

// Distance grand cercle entre 2 points (km). Cf. gas/Code.js:1058.
function haversineKmFs(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
      * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function runFirestoreGet(
  action: string,
  params: Record<string, string> = {},
): Promise<unknown> {
  switch (action) {
    case "getClient": {
      // Reproduit la shape GAS getClient (gas/Code.js:424) attendue par
      // /clients/detail : on aplatit docs.X / docLinks.X / docDates.X stockés
      // en sous-objets côté Firestore vers les champs flat (devisSignee,
      // devisLien, dateEngagement…) consommés par l'UI, et on hydrate
      // velos[] (avec photos montage + livraison rattachée + urlBlSigne).
      // Sans ce mapping la fiche client était vide post-migration.
      const id = params.id;
      if (!id) throw new Error("id requis");
      const snap = await getDoc(doc(db, "clients", id));
      if (!snap.exists()) return { error: "Client introuvable" };
      const c = snap.data() as Record<string, unknown>;

      const isoOrNull = (x: unknown): string | null => {
        if (!x) return null;
        if (x instanceof Date) return x.toISOString();
        const t = x as { toDate?: () => Date };
        if (t?.toDate) return t.toDate().toISOString();
        const s = String(x).trim();
        return s || null;
      };
      const asUrl = (x: unknown): string | null => {
        const s = String(x || "").trim();
        return s || null;
      };

      const docs = (c.docs as Record<string, unknown>) || {};
      const docLinks = (c.docLinks as Record<string, unknown>) || {};
      const docDates = (c.docDates as Record<string, unknown>) || {};
      // ?? privilégie l'éventuel champ flat hérité (ancienne shape GAS) sinon
      // tombe sur le sous-objet Firestore actuel.
      const flat = {
        devisSignee: (c.devisSignee as boolean) ?? !!docs.devisSignee,
        kbisRecu: (c.kbisRecu as boolean) ?? !!docs.kbisRecu,
        attestationRecue: (c.attestationRecue as boolean) ?? !!docs.attestationRecue,
        signatureOk: (c.signatureOk as boolean) ?? !!docs.signatureOk,
        inscriptionBicycle: (c.inscriptionBicycle as boolean) ?? !!docs.inscriptionBicycle,
        parcelleCadastrale: (c.parcelleCadastrale as boolean) ?? !!docs.parcelleCadastrale,
        effectifMentionne: (c.effectifMentionne as boolean) ?? !!docs.effectifMentionne,
        devisLien: (c.devisLien as string | null) ?? (docLinks.devis as string | null) ?? null,
        kbisLien: (c.kbisLien as string | null) ?? (docLinks.kbis as string | null) ?? null,
        attestationLien:
          (c.attestationLien as string | null) ?? (docLinks.attestation as string | null) ?? null,
        signatureLien:
          (c.signatureLien as string | null) ?? (docLinks.signature as string | null) ?? null,
        bicycleLien:
          (c.bicycleLien as string | null) ?? (docLinks.bicycle as string | null) ?? null,
        parcelleCadastraleLien:
          (c.parcelleCadastraleLien as string | null) ??
          (docLinks.parcelleCadastrale as string | null) ??
          null,
        kbisDate: (c.kbisDate as string | null) ?? (docDates.kbis as string | null) ?? null,
        dateEngagement:
          (c.dateEngagement as string | null) ?? (docDates.engagement as string | null) ?? null,
        liasseFiscaleDate:
          (c.liasseFiscaleDate as string | null) ??
          (docDates.liasseFiscale as string | null) ??
          null,
      };

      // Livraisons indexées par tourneeId pour rattacher chaque vélo à SA
      // livraison (et son urlBlSigne). Multi-tournées : on rattache via
      // tourneeIdScan ; mono-tournée : fallback sur la seule livraison.
      const livSnap = await getDocs(
        query(collection(db, "livraisons"), where("clientId", "==", id)),
      );
      type Liv = {
        id: string;
        tourneeId: string;
        statut: string;
        datePrevue: string | null;
        dateEffective: string | null;
        urlBlSigne: string | null;
      };
      const livraisonsByTournee: Record<string, Liv> = {};
      for (const ld of livSnap.docs) {
        const l = ld.data() as Record<string, unknown>;
        const tId = String(l.tourneeId || "");
        livraisonsByTournee[tId] = {
          id: ld.id,
          tourneeId: tId,
          statut: String(l.statut || "planifiee"),
          datePrevue: isoOrNull(l.datePrevue),
          dateEffective: isoOrNull(l.dateEffective),
          urlBlSigne: asUrl(l.urlBlSigne),
        };
      }
      const livKeys = Object.keys(livraisonsByTournee);

      const vSnap = await getDocs(
        query(collection(db, "velos"), where("clientId", "==", id)),
      );
      const velos = vSnap.docs
        .filter((d) => !(d.data() as { annule?: boolean }).annule)
        .map((d) => {
          const v = d.data() as Record<string, unknown>;
          const fnuci = String(v.fnuci || "").trim() || null;
          const urlEtiquette = asUrl(v.urlPhotoMontageEtiquette);
          const urlQrVelo = asUrl(v.urlPhotoMontageQrVelo);
          const urlMonte = asUrl(v.photoMontageUrl);
          const hasDateMontage = !!v.dateMontage;
          const hasDateLivScan = !!v.dateLivraisonScan;

          // tourneeIdScan d'abord (champ historique GAS), puis tourneeId si
          // posé par le scan livraison côté Firestore. Sinon fallback "1 seule
          // livraison" pour les clients mono-tournée (cas le plus courant).
          const tournId = String(v.tourneeIdScan || v.tourneeId || "").trim();
          let liv: Liv | null = null;
          if (tournId && livraisonsByTournee[tournId]) liv = livraisonsByTournee[tournId];
          else if (livKeys.length === 1) liv = livraisonsByTournee[livKeys[0]];

          return {
            id: d.id,
            reference: fnuci,
            qrCode: fnuci,
            certificatRecu: !!v.certificatRecu || !!fnuci,
            certificatNumero: (v.certificatNumero as string | null) || null,
            photoQrPrise: !!v.photoQrPrise || !!urlQrVelo || hasDateMontage,
            facturable: !!v.facturable,
            facture: !!v.facture,
            monte: hasDateMontage,
            livre: hasDateLivScan,
            urlPhotoMontageEtiquette: urlEtiquette,
            urlPhotoMontageQrVelo: urlQrVelo,
            photoMontageUrl: urlMonte,
            livraison: liv,
            urlBlSigne: liv ? liv.urlBlSigne : null,
            livraisonOrpheline: !liv && livKeys.length > 0,
          };
        });

      return { id: snap.id, ...c, ...flat, velos };
    }
    case "getTourneeProgression": {
      const tourneeId = params.tourneeId;
      if (!tourneeId) throw new Error("tourneeId requis");
      const livSnap = await getDocs(
        query(collection(db, "livraisons"), where("tourneeId", "==", tourneeId)),
      );
      // datePrevue de la tournée = celle de n'importe quelle livraison (toutes égales)
      let datePrevue: string | null = null;
      // Tri par ordre tournée :
      //  - source primaire : champ `ordre` (posé par createTournees / createLivraison)
      //  - fallback legacy : "arrêt X/N" extrait des notes (livraisons importées du sheet GAS)
      //  - dernier recours : ordre Firestore (insertion)
      // Le verrou LIFO côté UI (TourneeScanFlow.reverseClients) inverse cet ordre
      // pour prép/charg ; sans tri fiable ici, l'inversion frontend est inutile.
      const ordreFromNotes = (notes: unknown): number | null => {
        if (typeof notes !== "string") return null;
        const m = notes.match(/arr[êe]t\s+(\d+)\s*\//i);
        return m ? parseInt(m[1], 10) : null;
      };
      const sortedLivDocs = livSnap.docs
        .map((d, idx) => {
          const data = d.data() as { ordre?: number; notes?: string };
          const ordre =
            typeof data.ordre === "number"
              ? data.ordre
              : ordreFromNotes(data.notes);
          return { d, ordre, idx };
        })
        .sort((a, b) => {
          if (a.ordre != null && b.ordre != null) return a.ordre - b.ordre;
          if (a.ordre != null) return -1;
          if (b.ordre != null) return 1;
          return a.idx - b.idx;
        })
        .map((x) => x.d);
      const clientOrder: string[] = [];
      const clientInfo: Record<
        string,
        { clientId: string; entreprise: string; ville: string; adresse: string; codePostal: string }
      > = {};
      // nbVelos demandés par client = somme des livraisons NON annulées
      // de cette tournée. Sert de plafond aux compteurs vélos pour éviter
      // que des vélos cibles orphelins (ex: livraison annulée + remplacée)
      // gonflent les totaux — bug 2026-04-28.
      const expectedByClient: Record<string, number> = {};
      for (const d of sortedLivDocs) {
        const l = d.data() as {
          clientId?: string;
          statut?: string;
          nbVelos?: number;
          datePrevue?: { toDate?: () => Date };
          clientSnapshot?: {
            entreprise?: string;
            ville?: string;
            adresse?: string;
            codePostal?: string;
          };
        };
        const cid = l.clientId;
        if (!cid) continue;
        // Ignorer les livraisons annulées : leur client ne fait plus partie
        // de la tournée et leurs vélos cibles ne doivent pas être comptés.
        if (String(l.statut || "").toLowerCase() === "annulee") continue;
        if (!datePrevue && l.datePrevue?.toDate) {
          datePrevue = l.datePrevue.toDate().toISOString();
        }
        if (!clientInfo[cid]) {
          clientOrder.push(cid);
          clientInfo[cid] = {
            clientId: cid,
            entreprise: l.clientSnapshot?.entreprise || "",
            ville: l.clientSnapshot?.ville || "",
            adresse: l.clientSnapshot?.adresse || "",
            codePostal: l.clientSnapshot?.codePostal || "",
          };
        }
        expectedByClient[cid] = (expectedByClient[cid] || 0) + (Number(l.nbVelos) || 0);
      }

      type Velo = {
        veloId: string;
        fnuci: string | null;
        datePreparation: string | null;
        dateChargement: string | null;
        dateLivraisonScan: string | null;
        dateMontage: string | null;
      };
      const velosByClient: Record<string, Velo[]> = {};
      const totals = { total: 0, prepare: 0, charge: 0, livre: 0, monte: 0 };
      const perClientTotals: Record<
        string,
        { total: number; prepare: number; charge: number; livre: number; monte: number }
      > = {};
      const isoOrNull = (x: unknown): string | null => {
        if (!x) return null;
        const t = x as { toDate?: () => Date };
        return t?.toDate ? t.toDate().toISOString() : null;
      };
      const chunks: string[][] = [];
      for (let i = 0; i < clientOrder.length; i += 30) {
        chunks.push(clientOrder.slice(i, i + 30));
      }
      for (const chunk of chunks) {
        if (!chunk.length) continue;
        const vSnap = await getDocs(
          query(collection(db, "velos"), where("clientId", "in", chunk)),
        );
        for (const d of vSnap.docs) {
          const data = d.data() as {
            clientId?: string;
            fnuci?: string | null;
            annule?: boolean;
            datePreparation?: unknown;
            dateChargement?: unknown;
            dateLivraisonScan?: unknown;
            dateMontage?: unknown;
          };
          const cid = data.clientId || "";
          if (!cid) continue;
          // Skip vélos soft-cancelled (annule=true).
          if (data.annule === true) continue;
          if (!velosByClient[cid]) velosByClient[cid] = [];
          if (!perClientTotals[cid]) {
            perClientTotals[cid] = { total: 0, prepare: 0, charge: 0, livre: 0, monte: 0 };
          }
          // Plafond : on n'accepte que `expectedByClient[cid]` vélos par client
          // (= somme des nbVelos des livraisons actives). Si le client a plus
          // de vélos cibles que demandé pour cette tournée (ex : 2 commandes
          // séparées), seuls les premiers comptent ici.
          const cap = expectedByClient[cid] ?? 0;
          if (perClientTotals[cid].total >= cap) continue;
          const v: Velo = {
            veloId: d.id,
            fnuci: data.fnuci || null,
            datePreparation: isoOrNull(data.datePreparation),
            dateChargement: isoOrNull(data.dateChargement),
            dateLivraisonScan: isoOrNull(data.dateLivraisonScan),
            dateMontage: isoOrNull(data.dateMontage),
          };
          velosByClient[cid].push(v);
          perClientTotals[cid].total++;
          totals.total++;
          if (v.datePreparation) {
            perClientTotals[cid].prepare++;
            totals.prepare++;
          }
          if (v.dateChargement) {
            perClientTotals[cid].charge++;
            totals.charge++;
          }
          if (v.dateLivraisonScan) {
            perClientTotals[cid].livre++;
            totals.livre++;
          }
          if (v.dateMontage) {
            perClientTotals[cid].monte++;
            totals.monte++;
          }
        }
      }

      const clients = clientOrder.map((cid) => ({
        ...clientInfo[cid],
        velos: velosByClient[cid] || [],
        totals: perClientTotals[cid] || {
          total: 0,
          prepare: 0,
          charge: 0,
          livre: 0,
          monte: 0,
        },
      }));
      return { tourneeId, datePrevue, totals, clients };
    }
    case "getClientPreparation": {
      // Miroir GAS getClientPreparation : utilisé par /montage pour afficher
      // les vélos d'un client avec leur état (3 slots photo + dateMontage).
      // Source de vérité = collection `velos` Firestore (où markVeloPrepare/
      // Charge/LivreScan + uploadMontagePhoto écrivent).
      const clientId = params.clientId;
      if (!clientId) return { error: "clientId requis" };
      const cSnap = await getDoc(doc(db, "clients", clientId));
      if (!cSnap.exists()) return { error: "Client introuvable" };
      const c = cSnap.data() as { entreprise?: string; adresse?: string; ville?: string };
      const vSnap = await getDocs(
        query(collection(db, "velos"), where("clientId", "==", clientId)),
      );
      const isoOrNull = (x: unknown): string | null => {
        if (!x) return null;
        if (x instanceof Date) return x.toISOString();
        const t = x as { toDate?: () => Date };
        if (t?.toDate) return t.toDate().toISOString();
        const s = String(x).trim();
        return s || null;
      };
      const asUrl = (x: unknown): string | null => {
        const s = String(x || "").trim();
        return s || null;
      };
      type VeloDoc = {
        fnuci?: string;
        annule?: boolean;
        datePreparation?: unknown;
        dateChargement?: unknown;
        dateLivraisonScan?: unknown;
        dateMontage?: unknown;
        urlPhotoMontageEtiquette?: string;
        urlPhotoMontageQrVelo?: string;
        photoMontageUrl?: string;
      };
      const velos = vSnap.docs
        .filter((d) => !(d.data() as VeloDoc).annule)
        .map((d) => {
          const v = d.data() as VeloDoc;
          return {
            veloId: d.id,
            fnuci: (v.fnuci || "").trim() || null,
            datePreparation: isoOrNull(v.datePreparation),
            dateChargement: isoOrNull(v.dateChargement),
            dateLivraisonScan: isoOrNull(v.dateLivraisonScan),
            dateMontage: isoOrNull(v.dateMontage),
            urlPhotoMontageEtiquette: asUrl(v.urlPhotoMontageEtiquette),
            urlPhotoMontageQrVelo: asUrl(v.urlPhotoMontageQrVelo),
            photoMontageUrl: asUrl(v.photoMontageUrl),
          };
        });
      const avecFnuci = velos.filter((v) => !!v.fnuci);
      return {
        ok: true,
        clientId,
        entreprise: c.entreprise || "",
        adresse: c.adresse || "",
        ville: c.ville || "",
        nbVelosTotal: velos.length,
        nbVelosAvecFnuci: avecFnuci.length,
        nbVelosSansFnuci: velos.length - avecFnuci.length,
        fnuciAttendus: avecFnuci.map((v) => v.fnuci),
        velos,
      };
    }
    case "auditEffectifs": {
      // Migration de gas/Code.js:auditEffectifs vers Firestore. Croise les
      // verifications (collection mirrorée depuis GAS via syncFromGas) avec les
      // clients Firestore pour détecter les écarts entre nb vélos commandés et
      // effectif déclaré (règle CEE : 1 vélo max / salarié).
      // Source de vérité : `verifications` Firestore + `clients` Firestore.
      // Fallback GAS retiré : si Firestore est vide, on retourne 0 incohérence
      // (mieux que de planter sur un GAS down).
      const DOCS_AVEC_EFFECTIF: Record<string, true> = {
        DSN: true,
        LIASSE: true,
        ATTESTATION_URSSAF: true,
        URSSAF: true,
        ATTESTATION: true,
      };

      const verifSnap = await getDocs(collection(db, "verifications"));
      const clientSnap = await getDocs(collection(db, "clients"));

      type VerifAgg = {
        clientId: string;
        entreprise: string;
        effectifMax: number;
        effectifSource: string;
        verifIds: string[];
        nbDocs: number;
      };
      type DevisAgg = { nbVelosMax: number; sourceVerifId: string; nbDevis: number };

      const byClient: Record<string, VerifAgg> = {};
      const devisByClient: Record<string, DevisAgg> = {};

      for (const d of verifSnap.docs) {
        const v = d.data() as Record<string, unknown>;
        const cid = String(v.clientId || "");
        if (!cid) continue;
        const docType = String(v.docType || "").toUpperCase();

        if (docType === "DEVIS") {
          const vRaw = v.nbVelosDevis;
          if (vRaw != null && vRaw !== "") {
            const nbV = Number(vRaw);
            if (Number.isFinite(nbV) && nbV >= 0 && nbV < 10000) {
              const cur = devisByClient[cid];
              if (!cur) {
                devisByClient[cid] = { nbVelosMax: nbV, sourceVerifId: d.id, nbDevis: 1 };
              } else {
                cur.nbDevis++;
                if (nbV > cur.nbVelosMax) {
                  cur.nbVelosMax = nbV;
                  cur.sourceVerifId = d.id;
                }
              }
            }
          }
        }

        if (!DOCS_AVEC_EFFECTIF[docType]) continue;
        const effRaw = v.effectifDetected;
        if (effRaw == null || effRaw === "") continue;
        const eff = Number(effRaw);
        if (!Number.isFinite(eff) || eff < 0 || eff > 10000) continue;

        const ent = String(v.entreprise || "");
        if (!byClient[cid]) {
          byClient[cid] = {
            clientId: cid,
            entreprise: ent,
            effectifMax: eff,
            effectifSource: docType,
            verifIds: [d.id],
            nbDocs: 1,
          };
        } else {
          const b = byClient[cid];
          b.nbDocs++;
          b.verifIds.push(d.id);
          if (eff > b.effectifMax) {
            b.effectifMax = eff;
            b.effectifSource = docType;
          }
        }
      }

      type ClientAgg = { clientId: string; nbVelosCommandes: number; entreprise: string; siren: string };
      const clientById: Record<string, ClientAgg> = {};
      const allClients: ClientAgg[] = [];
      for (const d of clientSnap.docs) {
        const c = d.data() as Record<string, unknown>;
        const nbV = Number(c.nbVelosCommandes || 0);
        const ent = String(c.entreprise || "");
        const siren = String(c.siren || "").replace(/\s/g, "");
        const entry = { clientId: d.id, nbVelosCommandes: nbV, entreprise: ent, siren };
        clientById[d.id] = entry;
        allClients.push(entry);
      }

      // Incohérences par établissement
      const incoherences: Array<{
        clientId: string;
        entreprise: string;
        nbVelosCommandes: number;
        nbVelosDevis: number | null;
        nbDevis: number;
        effectifMax: number;
        effectifSource: string;
        ecart: number;
        nbDocs: number;
        verifIds: string[];
        suggestedTarget: number;
        sens: "trop_velos" | "pas_assez_velos";
      }> = [];

      for (const cid of Object.keys(byClient)) {
        const b = byClient[cid];
        const c = clientById[cid];
        if (!c) continue;
        const ecart = c.nbVelosCommandes - b.effectifMax;
        if (ecart === 0) continue;
        const dInfo = devisByClient[cid] || null;
        incoherences.push({
          clientId: cid,
          entreprise: c.entreprise || b.entreprise,
          nbVelosCommandes: c.nbVelosCommandes,
          nbVelosDevis: dInfo ? dInfo.nbVelosMax : null,
          nbDevis: dInfo ? dInfo.nbDevis : 0,
          effectifMax: b.effectifMax,
          effectifSource: b.effectifSource,
          ecart,
          nbDocs: b.nbDocs,
          verifIds: b.verifIds,
          suggestedTarget: b.effectifMax,
          sens: ecart > 0 ? "trop_velos" : "pas_assez_velos",
        });
      }
      incoherences.sort((a, b) => Math.abs(b.ecart) - Math.abs(a.ecart));

      // Agrégation par SIREN (multi-établissements)
      type SirenAgg = {
        siren: string;
        entreprise: string;
        totalVelos: number;
        etablissements: Array<{ clientId: string; entreprise: string; nbVelos: number }>;
        effectifMax: number;
        effectifSource: string;
        nbDocs: number;
        verifIds: string[];
      };
      const sirenAgg: Record<string, SirenAgg> = {};
      for (const c of allClients) {
        if (!c.siren || c.siren === "0") continue;
        if (!sirenAgg[c.siren]) {
          sirenAgg[c.siren] = {
            siren: c.siren,
            entreprise: c.entreprise,
            totalVelos: 0,
            etablissements: [],
            effectifMax: 0,
            effectifSource: "",
            nbDocs: 0,
            verifIds: [],
          };
        }
        const s = sirenAgg[c.siren];
        s.totalVelos += c.nbVelosCommandes;
        s.etablissements.push({ clientId: c.clientId, entreprise: c.entreprise, nbVelos: c.nbVelosCommandes });
        const b = byClient[c.clientId];
        if (b) {
          s.nbDocs += b.nbDocs;
          s.verifIds = s.verifIds.concat(b.verifIds);
          if (b.effectifMax > s.effectifMax) {
            s.effectifMax = b.effectifMax;
            s.effectifSource = b.effectifSource;
          }
        }
      }

      const incoherencesParSiren: Array<{
        siren: string;
        entreprise: string;
        totalVelos: number;
        effectifMax: number;
        effectifSource: string;
        ecart: number;
        sens: "trop_velos" | "pas_assez_velos";
        nbEtablissements: number;
        etablissements: Array<{ clientId: string; entreprise: string; nbVelos: number }>;
        nbDocs: number;
        verifIds: string[];
      }> = [];
      for (const siren of Object.keys(sirenAgg)) {
        const s = sirenAgg[siren];
        if (s.etablissements.length < 2) continue;
        if (s.effectifMax === 0) continue;
        const ecart = s.totalVelos - s.effectifMax;
        if (ecart === 0) continue;
        incoherencesParSiren.push({
          siren,
          entreprise: s.entreprise,
          totalVelos: s.totalVelos,
          effectifMax: s.effectifMax,
          effectifSource: s.effectifSource,
          ecart,
          sens: ecart > 0 ? "trop_velos" : "pas_assez_velos",
          nbEtablissements: s.etablissements.length,
          etablissements: s.etablissements,
          nbDocs: s.nbDocs,
          verifIds: s.verifIds,
        });
      }
      incoherencesParSiren.sort((a, b) => Math.abs(b.ecart) - Math.abs(a.ecart));

      // Clients sans pièce d'effectif (groupés par SIREN)
      const sansPieceParSiren: Record<string, {
        siren: string;
        entreprise: string;
        totalVelos: number;
        etablissements: Array<{ clientId: string; entreprise: string; nbVelos: number }>;
      }> = {};
      const sansPieceSansSiren: Array<{ clientId: string; entreprise: string; nbVelos: number }> = [];
      for (const c of allClients) {
        if (c.nbVelosCommandes <= 0) continue;
        if (byClient[c.clientId]) continue;
        if (c.siren && c.siren !== "0") {
          if (!sansPieceParSiren[c.siren]) {
            sansPieceParSiren[c.siren] = {
              siren: c.siren,
              entreprise: c.entreprise,
              totalVelos: 0,
              etablissements: [],
            };
          }
          const sp = sansPieceParSiren[c.siren];
          sp.totalVelos += c.nbVelosCommandes;
          sp.etablissements.push({ clientId: c.clientId, entreprise: c.entreprise, nbVelos: c.nbVelosCommandes });
        } else {
          sansPieceSansSiren.push({ clientId: c.clientId, entreprise: c.entreprise, nbVelos: c.nbVelosCommandes });
        }
      }
      // Si un SIREN a déjà au moins 1 établissement scanné, retirer le groupe
      for (const siren of Object.keys(sansPieceParSiren)) {
        if (sirenAgg[siren] && sirenAgg[siren].effectifMax > 0) {
          delete sansPieceParSiren[siren];
        }
      }
      const clientsSansPieceEffectif = Object.values(sansPieceParSiren);
      for (const c of sansPieceSansSiren) {
        clientsSansPieceEffectif.push({
          siren: "",
          entreprise: c.entreprise,
          totalVelos: c.nbVelos,
          etablissements: [c],
        });
      }
      clientsSansPieceEffectif.sort((a, b) => b.totalVelos - a.totalVelos);

      return {
        ok: true,
        total: incoherences.length,
        incoherences,
        incoherencesParSiren,
        totalSiren: incoherencesParSiren.length,
        clientsSansPieceEffectif,
        totalSansPiece: clientsSansPieceEffectif.length,
        nbClientsAvecEffectifDetecte: Object.keys(byClient).length,
      };
    }

    case "getTourneeExecution": {
      // Page mobile /tournee-execute (chauffeur). Shape attendue :
      // { tourneeId, datePrevue, mode, livraisons[id, clientId, statut, nbVelos,
      //   client{entreprise, ville, adresse, codePostal, telephone, contact, lat, lng},
      //   velos[id, clientId, fnuci, photoVeloUrl, photoFnuciUrl, photoQrPrise, livre]],
      //   equipe{chauffeur, chefEquipe, monteurs} }
      const tourneeId = params.tourneeId;
      if (!tourneeId) throw new Error("tourneeId requis");

      const livSnap = await getDocs(
        query(collection(db, "livraisons"), where("tourneeId", "==", tourneeId)),
      );
      if (livSnap.empty) {
        return { error: "Tournée introuvable", tourneeId };
      }

      // Premiers métadonnées (datePrevue, mode, equipe IDs) prises sur la 1ère
      // livraison : toutes les livraisons d'une tournée partagent ces champs.
      const firstData = livSnap.docs[0].data() as {
        datePrevue?: { toDate?: () => Date } | string;
        mode?: string;
        chauffeurId?: string;
        chefEquipeId?: string;
        chefEquipeIds?: string[];
        monteurIds?: string[];
      };
      const datePrevue = (() => {
        const dp = firstData.datePrevue;
        if (!dp) return null;
        if (typeof dp === "string") return dp;
        return dp.toDate ? dp.toDate().toISOString() : null;
      })();
      const mode = firstData.mode || null;

      // Construit la liste des livraisons et collecte les clientIds (pour bulk
      // load des vélos en chunks de 30).
      type ClientObj = {
        id?: string;
        entreprise: string;
        ville: string | null;
        adresse: string | null;
        codePostal: string | null;
        telephone: string | null;
        contact: string | null;
        lat: number | null;
        lng: number | null;
      };
      type LivExec = {
        id: string;
        clientId: string;
        statut: string;
        nbVelos: number;
        client: ClientObj | null;
        velos: Array<{
          id: string;
          clientId: string;
          fnuci: string | null;
          photoVeloUrl: string | null;
          photoFnuciUrl: string | null;
          photoQrPrise: boolean;
          livre: boolean;
        }>;
      };

      const livraisons: LivExec[] = [];
      const clientIds: string[] = [];
      const seenClients = new Set<string>();
      for (const d of livSnap.docs) {
        const l = d.data() as {
          clientId?: string;
          statut?: string;
          nbVelos?: number;
          clientSnapshot?: Partial<ClientObj>;
        };
        const cid = l.clientId || "";
        if (!cid) continue;
        const snap = l.clientSnapshot || {};
        livraisons.push({
          id: d.id,
          clientId: cid,
          statut: l.statut || "planifiee",
          nbVelos: typeof l.nbVelos === "number" ? l.nbVelos : 0,
          client: {
            id: cid,
            entreprise: snap.entreprise || "",
            ville: snap.ville ?? null,
            adresse: snap.adresse ?? null,
            codePostal: snap.codePostal ?? null,
            telephone: snap.telephone ?? null,
            contact: snap.contact ?? null,
            lat: typeof snap.lat === "number" ? snap.lat : null,
            lng: typeof snap.lng === "number" ? snap.lng : null,
          },
          velos: [],
        });
        if (!seenClients.has(cid)) {
          seenClients.add(cid);
          clientIds.push(cid);
        }
      }

      // Hydratation contact/telephone manquants depuis le client doc
      // (clientSnapshot peut être incomplet sur livraisons anciennes).
      const livByClient: Record<string, LivExec[]> = {};
      for (const l of livraisons) {
        (livByClient[l.clientId] ||= []).push(l);
      }
      const clientChunks: string[][] = [];
      for (let i = 0; i < clientIds.length; i += 30) {
        clientChunks.push(clientIds.slice(i, i + 30));
      }
      for (const chunk of clientChunks) {
        if (!chunk.length) continue;
        const cSnap = await getDocs(
          query(collection(db, "clients"), where("__name__", "in", chunk)),
        );
        for (const cd of cSnap.docs) {
          const c = cd.data() as {
            telephone?: string | null;
            contact?: string | null;
            adresse?: string | null;
            latitude?: number;
            longitude?: number;
          };
          for (const liv of livByClient[cd.id] || []) {
            if (!liv.client) continue;
            if (liv.client.telephone == null && c.telephone) liv.client.telephone = c.telephone;
            if (liv.client.contact == null && c.contact) liv.client.contact = c.contact;
            if (liv.client.adresse == null && c.adresse) liv.client.adresse = c.adresse;
            if (liv.client.lat == null && typeof c.latitude === "number") liv.client.lat = c.latitude;
            if (liv.client.lng == null && typeof c.longitude === "number") liv.client.lng = c.longitude;
          }
        }
      }

      // Vélos par clientId (bulk en chunks de 30, limite Firestore 'in')
      for (const chunk of clientChunks) {
        if (!chunk.length) continue;
        const vSnap = await getDocs(
          query(collection(db, "velos"), where("clientId", "in", chunk)),
        );
        for (const vd of vSnap.docs) {
          const v = vd.data() as {
            clientId?: string;
            fnuci?: string | null;
            photoQrPrise?: boolean | string;
            dateLivraisonScan?: unknown;
            dateLivraison?: unknown;
            // photos livraison (best-effort multi-noms ; voir note bug uploadVeloPhoto)
            photoVeloUrl?: string;
            photoFnuciUrl?: string;
            photos?: { veloLivraison?: string; fnuciLivraison?: string; montageQrVelo?: string; montageEtiquette?: string };
            urlPhotoLivraisonVelo?: string;
            urlPhotoLivraisonFnuci?: string;
          };
          const cid = v.clientId || "";
          if (!cid) continue;
          const photoVeloUrl =
            v.photoVeloUrl ||
            v.urlPhotoLivraisonVelo ||
            v.photos?.veloLivraison ||
            null;
          const photoFnuciUrl =
            v.photoFnuciUrl ||
            v.urlPhotoLivraisonFnuci ||
            v.photos?.fnuciLivraison ||
            null;
          const livre = !!v.dateLivraisonScan || !!v.dateLivraison;
          const veloRow = {
            id: vd.id,
            clientId: cid,
            fnuci: v.fnuci || null,
            photoVeloUrl,
            photoFnuciUrl,
            photoQrPrise: !!v.photoQrPrise,
            livre,
          };
          // Tous les vélos du client vont sur ses livraisons de cette tournée.
          // Le modèle actuel ne distingue pas T1/T2 d'un même client (cf
          // getTourneeProgression qui fait pareil).
          for (const liv of livByClient[cid] || []) {
            liv.velos.push(veloRow);
          }
        }
      }

      // Resolution équipe : chauffeur + chef + monteurs
      const memberCache = new Map<string, { id: string; nom: string; role: string; telephone: string | null } | null>();
      const loadMember = async (id: string | undefined | null) => {
        if (!id) return null;
        if (memberCache.has(id)) return memberCache.get(id) || null;
        try {
          const m = await getDoc(doc(db, "equipe", id));
          if (!m.exists()) {
            memberCache.set(id, null);
            return null;
          }
          const md = m.data() as { nom?: string; role?: string; telephone?: string | null };
          const obj = {
            id: m.id,
            nom: md.nom || "",
            role: md.role || "",
            telephone: md.telephone ?? null,
          };
          memberCache.set(id, obj);
          return obj;
        } catch {
          memberCache.set(id, null);
          return null;
        }
      };
      const chauffeur = await loadMember(firstData.chauffeurId);
      // chefEquipeId (singulier legacy) ou chefEquipeIds[0] (nouveau).
      const chefId = firstData.chefEquipeId || firstData.chefEquipeIds?.[0];
      const chefEquipe = await loadMember(chefId);
      const monteurIds = firstData.monteurIds || [];
      const monteurs = (
        await Promise.all(monteurIds.map((id) => loadMember(id)))
      ).filter((m): m is NonNullable<typeof m> => m !== null);

      return {
        tourneeId,
        datePrevue,
        mode,
        livraisons,
        equipe: { chauffeur, chefEquipe, monteurs },
      };
    }

    case "getBlForTournee": {
      // Page /bl : génère + retourne les bons de livraison d'une tournée.
      // Numéro BL séquentiel par année : BL-YYYY-NNNNN, persisté sur la
      // livraison (champ numeroBL) à la 1ère consultation. Counter Firestore
      // dans counters/bl-YYYY (transaction pour éviter doublons concurrents).
      const tourneeId = params.tourneeId;
      if (!tourneeId) return { error: "tourneeId requis" };

      const livSnap = await getDocs(
        query(collection(db, "livraisons"), where("tourneeId", "==", tourneeId)),
      );
      if (livSnap.empty) return { error: "Tournée introuvable", tourneeId };

      // datePrevue (toutes égales sur une tournée)
      const firstData = livSnap.docs[0].data() as { datePrevue?: unknown };
      const isoOf = (x: unknown): string | null => {
        if (!x) return null;
        if (typeof x === "string") return x;
        const t = x as { toDate?: () => Date };
        return t?.toDate ? t.toDate().toISOString() : null;
      };
      const datePrevue = isoOf(firstData.datePrevue);
      const year = datePrevue
        ? datePrevue.slice(0, 4)
        : String(new Date().getFullYear());
      const counterRef = doc(db, "counters", `bl-${year}`);

      // Génération de numéro BL : transaction garantie atomique sur le counter.
      const allocateBlNumber = async (): Promise<string> => {
        return runTransaction(db, async (tx) => {
          const snap = await tx.get(counterRef);
          const current = snap.exists() ? Number((snap.data() as { next?: number }).next) || 0 : 0;
          const next = current + 1;
          tx.set(counterRef, { next, year }, { merge: true });
          return `BL-${year}-${String(next).padStart(5, "0")}`;
        });
      };

      // Construit clients[]. clientSnapshot peut manquer contact/tel : on
      // hydrate depuis le doc client. Persiste numeroBL sur livraison si absent.
      type VeloOut = { veloId: string; fnuci: string | null };
      type ClientOut = {
        clientId: string;
        entreprise: string;
        ville: string;
        adresse: string;
        codePostal: string;
        telephone: string | null;
        contact: string | null;
        siren: string | null;
        numeroBL: string | null;
        velos: VeloOut[];
      };
      // 1 livraison = 1 client (fonctionnellement). On garde l'ordre Firestore.
      const clientsByLiv: Array<{ livraisonId: string; clientId: string; client: ClientOut; numeroBL: string | null }> = [];
      const clientIds: string[] = [];
      const seenClients = new Set<string>();
      for (const d of livSnap.docs) {
        const l = d.data() as {
          clientId?: string;
          numeroBL?: string;
          clientSnapshot?: {
            entreprise?: string;
            ville?: string;
            adresse?: string;
            codePostal?: string;
            telephone?: string | null;
            contact?: string | null;
          };
        };
        const cid = l.clientId || "";
        if (!cid) continue;
        const snap = l.clientSnapshot || {};
        const out: ClientOut = {
          clientId: cid,
          entreprise: snap.entreprise || "",
          ville: snap.ville || "",
          adresse: snap.adresse || "",
          codePostal: snap.codePostal || "",
          telephone: snap.telephone ?? null,
          contact: snap.contact ?? null,
          siren: null, // hydraté plus bas depuis le doc client (pas dans clientSnapshot)
          numeroBL: l.numeroBL || null,
          velos: [],
        };
        clientsByLiv.push({ livraisonId: d.id, clientId: cid, client: out, numeroBL: out.numeroBL });
        if (!seenClients.has(cid)) {
          seenClients.add(cid);
          clientIds.push(cid);
        }
      }

      // Hydratation client (contact/tel manquants) + vélos par chunks de 30
      const clientChunks: string[][] = [];
      for (let i = 0; i < clientIds.length; i += 30) clientChunks.push(clientIds.slice(i, i + 30));

      const clientHydrated: Record<string, { telephone?: string | null; contact?: string | null; adresse?: string | null; siren?: string | null }> = {};
      for (const chunk of clientChunks) {
        if (!chunk.length) continue;
        const cSnap = await getDocs(
          query(collection(db, "clients"), where("__name__", "in", chunk)),
        );
        for (const cd of cSnap.docs) {
          const c = cd.data() as { telephone?: string | null; contact?: string | null; adresse?: string | null; siren?: string | null };
          clientHydrated[cd.id] = c;
        }
      }
      for (const item of clientsByLiv) {
        const h = clientHydrated[item.clientId];
        if (h) {
          if (item.client.telephone == null && h.telephone) item.client.telephone = h.telephone;
          if (item.client.contact == null && h.contact) item.client.contact = h.contact;
          if (!item.client.adresse && h.adresse) item.client.adresse = h.adresse;
          if (h.siren) item.client.siren = String(h.siren).replace(/\s/g, "");
        }
      }

      // Vélos
      const velosByClient: Record<string, VeloOut[]> = {};
      for (const chunk of clientChunks) {
        if (!chunk.length) continue;
        const vSnap = await getDocs(
          query(collection(db, "velos"), where("clientId", "in", chunk)),
        );
        for (const vd of vSnap.docs) {
          const v = vd.data() as { clientId?: string; fnuci?: string | null };
          const cid = v.clientId || "";
          if (!cid) continue;
          (velosByClient[cid] ||= []).push({ veloId: vd.id, fnuci: v.fnuci || null });
        }
      }
      for (const item of clientsByLiv) {
        item.client.velos = velosByClient[item.clientId] || [];
      }

      // Génération + persistence des numéros BL manquants. Séquentiel volontaire :
      // évite les collisions sur le counter (transactions concurrentes possibles
      // mais inutile vu qu'on est sur une seule requête utilisateur).
      for (const item of clientsByLiv) {
        if (!item.client.numeroBL) {
          try {
            const blNum = await allocateBlNumber();
            item.client.numeroBL = blNum;
            await updateDoc(doc(db, "livraisons", item.livraisonId), {
              numeroBL: blNum,
              updatedAt: ts(),
            });
          } catch (e) {
            // Si l'attribution échoue (contention extrême ou rules), on
            // laisse null et l'UI utilise son fallback hash.
            console.error("[getBlForTournee] allocateBlNumber failed", e);
          }
        }
      }

      return {
        tourneeId,
        datePrevue,
        clients: clientsByLiv.map((x) => x.client),
      };
    }

    case "getFinancesSummary": {
      // Page /finances (super-admin). Calcul du coût main d'œuvre sur [from, to].
      //
      // Hypothèses (à confirmer vs GAS si écart) :
      // - tournée comptée si datePrevue ∈ [from, to] ET au moins 1 livraison
      //   livrée (statut=livree). Pas de comptage des tournées vides.
      // - jours par membre = nb de dates DISTINCTES de tournées où il apparaît
      //   dans chauffeurId, chefEquipeIds (ou chefEquipeId), monteurIds,
      //   preparateurIds.
      // - velosPrimes par membre = somme des vélos livrés (statut=livree,
      //   nbVelos sommé) sur les tournées où il apparaît.
      // - coutSalaire = jours × salaireJournalier (depuis fiche equipe)
      // - coutPrime = velosPrimes × primeVelo
      // - apporteurs : NON inclus ici (commissions calculées ailleurs).
      const from = params.from || "";
      const to = params.to || "";
      if (!from || !to) {
        return { ok: false, error: "from et to requis (format YYYY-MM-DD)" };
      }
      // Bornes inclusives. Compare sur date locale en string ISO yyyy-mm-dd.
      const inRange = (iso: string | null) => {
        if (!iso) return false;
        const day = iso.slice(0, 10);
        return day >= from && day <= to;
      };

      // Parcourt toutes les livraisons (collection size raisonnable, < 10k).
      const livSnap = await getDocs(collection(db, "livraisons"));
      // Group par tourneeId : { tourneeId, datePrevue (YYYY-MM-DD), nbVelosLivres,
      // chauffeurId, chefIds[], monteurIds[], preparateurIds[] }
      type TourneeAgg = {
        tourneeId: string;
        date: string;
        nbVelosLivres: number;
        chauffeurId: string | null;
        chefIds: string[];
        monteurIds: string[];
        preparateurIds: string[];
      };
      const tourneesById: Record<string, TourneeAgg> = {};
      const isoOf = (x: unknown): string | null => {
        if (!x) return null;
        if (typeof x === "string") return x;
        const t = x as { toDate?: () => Date };
        return t?.toDate ? t.toDate().toISOString() : null;
      };
      for (const d of livSnap.docs) {
        const l = d.data() as {
          tourneeId?: string;
          datePrevue?: unknown;
          statut?: string;
          nbVelos?: number;
          chauffeurId?: string;
          chefEquipeId?: string;
          chefEquipeIds?: string[];
          monteurIds?: string[];
          preparateurIds?: string[];
        };
        const tid = l.tourneeId || "";
        if (!tid) continue;
        const dpIso = isoOf(l.datePrevue);
        if (!dpIso || !inRange(dpIso)) continue;

        let agg = tourneesById[tid];
        if (!agg) {
          agg = tourneesById[tid] = {
            tourneeId: tid,
            date: dpIso.slice(0, 10),
            nbVelosLivres: 0,
            chauffeurId: l.chauffeurId || null,
            chefIds: [
              ...(l.chefEquipeId ? [l.chefEquipeId] : []),
              ...(l.chefEquipeIds || []),
            ].filter((v, i, a) => v && a.indexOf(v) === i),
            monteurIds: [...new Set(l.monteurIds || [])],
            preparateurIds: [...new Set(l.preparateurIds || [])],
          };
        }
        if ((l.statut || "") === "livree") {
          agg.nbVelosLivres += typeof l.nbVelos === "number" ? l.nbVelos : 0;
        }
      }

      // Filtre tournées effectives (≥1 vélo livré)
      const tourneesActives = Object.values(tourneesById).filter(
        (t) => t.nbVelosLivres > 0,
      );

      // Aggrégation par membre
      type MemAgg = { joursSet: Set<string>; velosPrimes: number };
      const byMemberId: Record<string, MemAgg> = {};
      const touchMember = (id: string | null | undefined, t: TourneeAgg) => {
        if (!id) return;
        const m = (byMemberId[id] ||= { joursSet: new Set(), velosPrimes: 0 });
        m.joursSet.add(t.date);
        m.velosPrimes += t.nbVelosLivres;
      };
      for (const t of tourneesActives) {
        touchMember(t.chauffeurId, t);
        for (const id of t.chefIds) touchMember(id, t);
        for (const id of t.monteurIds) touchMember(id, t);
        for (const id of t.preparateurIds) touchMember(id, t);
      }

      // Hydratation fiches équipe pour récup salaire/prime/nom/role
      const memberIds = Object.keys(byMemberId);
      const byMember: Array<{
        id: string;
        nom: string;
        role: string;
        salaireJournalier: number;
        primeVelo: number;
        jours: number;
        velosPrimes: number;
        coutSalaire: number;
        coutPrime: number;
        coutTotal: number;
      }> = [];
      const totals = { coutSalaires: 0, coutPrimes: 0, coutTotal: 0, jours: 0 };
      // Chunks de 30 (limite Firestore "in")
      for (let i = 0; i < memberIds.length; i += 30) {
        const chunk = memberIds.slice(i, i + 30);
        if (!chunk.length) continue;
        const eSnap = await getDocs(
          query(collection(db, "equipe"), where("__name__", "in", chunk)),
        );
        for (const ed of eSnap.docs) {
          const e = ed.data() as {
            nom?: string;
            role?: string;
            salaireJournalier?: number;
            primeVelo?: number;
          };
          const agg = byMemberId[ed.id];
          if (!agg) continue;
          const salaireJournalier = typeof e.salaireJournalier === "number" ? e.salaireJournalier : 0;
          const primeVelo = typeof e.primeVelo === "number" ? e.primeVelo : 0;
          const jours = agg.joursSet.size;
          const velosPrimes = agg.velosPrimes;
          const coutSalaire = Math.round(jours * salaireJournalier * 100) / 100;
          const coutPrime = Math.round(velosPrimes * primeVelo * 100) / 100;
          const coutTotal = Math.round((coutSalaire + coutPrime) * 100) / 100;
          byMember.push({
            id: ed.id,
            nom: e.nom || "",
            role: e.role || "",
            salaireJournalier,
            primeVelo,
            jours,
            velosPrimes,
            coutSalaire,
            coutPrime,
            coutTotal,
          });
          totals.coutSalaires += coutSalaire;
          totals.coutPrimes += coutPrime;
          totals.coutTotal += coutTotal;
          totals.jours += jours;
        }
      }
      // Arrondi des totaux
      totals.coutSalaires = Math.round(totals.coutSalaires * 100) / 100;
      totals.coutPrimes = Math.round(totals.coutPrimes * 100) / 100;
      totals.coutTotal = Math.round(totals.coutTotal * 100) / 100;
      // Tri : par coutTotal desc pour mettre en avant les contributeurs.
      byMember.sort((a, b) => b.coutTotal - a.coutTotal);

      return {
        ok: true,
        from,
        to,
        nbTournees: tourneesActives.length,
        byMember,
        totals,
      };
    }

    case "deleteClient": {
      // ⚠ JAMAIS de hard-delete client (règle Yoann 29-04 : "garde-le en base
      // pour pouvoir comparer objectif initial vs réalisé dans les stats").
      // → Soft-cancel équivalent à cancelClient :
      //   - clients : statut=annulee + raisonAnnulation par défaut + annuleeAt
      //   - livraisons planifiees → annulee
      //   - vélos cibles → annule=true (préserve dates scan déjà faites)
      // Restaurable via "restoreClient".
      const id = params.id;
      if (!id) return { error: "id requis" };
      const cRefDC = doc(db, "clients", id);
      const cSnapDC = await getDoc(cRefDC);
      if (!cSnapDC.exists()) return { error: "Client introuvable" };

      const raisonAnnulation = "Suppression depuis la fiche client";
      await updateDoc(cRefDC, {
        statut: "annulee",
        raisonAnnulation,
        annuleeAt: ts(),
        "stats.planifies": 0,
        updatedAt: ts(),
      });

      const livRaison = `Client annulé : ${raisonAnnulation}`;
      const livSnapDC = await getDocs(
        query(collection(db, "livraisons"), where("clientId", "==", id)),
      );
      let nbLivAnnulees = 0;
      for (let i = 0; i < livSnapDC.docs.length; i += 400) {
        const batch = writeBatch(db);
        for (const d of livSnapDC.docs.slice(i, i + 400)) {
          const data = d.data() as { statut?: string };
          if (data.statut !== "planifiee") continue;
          batch.update(d.ref, {
            statut: "annulee",
            dateEffective: null,
            raisonAnnulation: livRaison,
            annuleeAt: ts(),
          });
          nbLivAnnulees++;
        }
        await batch.commit();
      }

      const velSnapDC = await getDocs(
        query(collection(db, "velos"), where("clientId", "==", id)),
      );
      let nbVelosAnnules = 0;
      for (let i = 0; i < velSnapDC.docs.length; i += 400) {
        const batch = writeBatch(db);
        for (const d of velSnapDC.docs.slice(i, i + 400)) {
          batch.update(d.ref, { annule: true, updatedAt: ts() });
          nbVelosAnnules++;
        }
        await batch.commit();
      }

      return { ok: true, softCancel: true, nbLivAnnulees, nbVelosAnnules };
    }

    case "listDisponibilites": {
      // /day-planner-modal : lecture des dispos existantes pour une date.
      // Stockage : collection disponibilites, doc { date, ressourceType,
      // ressourceId, actif, createdAt, notes }.
      const date = params.date;
      const ressourceType = params.ressourceType;
      if (!date) return { items: [] };
      const baseQ = query(collection(db, "disponibilites"), where("date", "==", date));
      const snap = await getDocs(baseQ);
      const items: Array<Record<string, unknown>> = [];
      for (const d of snap.docs) {
        const o = d.data() as { actif?: boolean; ressourceType?: string };
        if (o.actif === false) continue;
        if (ressourceType && o.ressourceType !== ressourceType) continue;
        items.push({ id: d.id, ...o });
      }
      return { items };
    }

    case "listEquipe": {
      // includeInactifs="true" → tout le monde, sinon seuls les actifs.
      // Parité avec gas listEquipe (gas/Code.js) consommé par /equipe.
      const includeInactifs = params.includeInactifs === "true";
      const baseQuery = includeInactifs
        ? collection(db, "equipe")
        : query(collection(db, "equipe"), where("actif", "==", true));
      const snap = await getDocs(baseQuery);
      const items = snap.docs.map((d) => {
        const data = d.data() as Record<string, unknown>;
        const createdAt = data.createdAt as { toDate?: () => Date } | undefined;
        return {
          id: d.id,
          nom: (data.nom as string) ?? "",
          role: data.role,
          telephone: (data.telephone as string | null) ?? null,
          email: (data.email as string | null) ?? null,
          actif: !!data.actif,
          notes: (data.notes as string | null) ?? null,
          createdAt: createdAt?.toDate ? createdAt.toDate().toISOString() : null,
          hasCode: true,
          salaireJournalier: data.salaireJournalier ?? null,
          primeVelo: data.primeVelo ?? null,
        };
      });
      return { ok: true, items };
    }

    case "listVerifications": {
      // status ∈ {pending, validated, rejected, unassigned, "", "all"}.
      // Pour "all" / "" / "unassigned" → pas de filtre status. "unassigned"
      // est un filtre client-side (clientId vide), on remonte tout côté
      // serveur et la page filtre. Limite par défaut 1000 comme GAS.
      const status = params.status || "";
      const lim = Math.max(1, Math.min(5000, Number(params.limit || "1000") || 1000));
      const useStatusFilter = status === "pending" || status === "validated" || status === "rejected";
      // Pas d'orderBy serveur : combiné à un where, Firestore exige un index
      // composite (firestore.indexes.json est vide). On trie côté client après
      // récup, ce qui est OK pour ≤ lim docs.
      const q = useStatusFilter
        ? query(
            collection(db, "verifications"),
            where("status", "==", status),
            limit(lim),
          )
        : query(collection(db, "verifications"), limit(lim));
      const snap = await getDocs(q);
      const tsToIso = (x: unknown): string | undefined => {
        if (!x) return undefined;
        if (typeof x === "string") return x;
        const t = x as { toDate?: () => Date };
        return t?.toDate ? t.toDate().toISOString() : undefined;
      };
      const items = snap.docs.map((d) => {
        const data = d.data() as Record<string, unknown>;
        return {
          id: d.id,
          receivedAt: tsToIso(data.receivedAt),
          clientId: data.clientId ?? "",
          entreprise: data.entreprise ?? "",
          docType: data.docType ?? "",
          driveUrl: data.driveUrl ?? data.storageUrl ?? "",
          fileName: data.fileName ?? "",
          fromEmail: data.fromEmail ?? "",
          subject: data.subject ?? "",
          effectifDetected: data.effectifDetected ?? "",
          nbVelosBefore: data.nbVelosBefore ?? "",
          nbVelosAfter: data.nbVelosAfter ?? "",
          status: data.status ?? "",
          notes: data.notes ?? "",
          messageId: data.messageId ?? "",
        };
      });
      // Tri client : receivedAt desc, fallback sur id pour stabilité.
      items.sort((a, b) => {
        const ra = (a.receivedAt as string) || "";
        const rb = (b.receivedAt as string) || "";
        if (ra !== rb) return rb.localeCompare(ra);
        return b.id.localeCompare(a.id);
      });
      return { ok: true, items };
    }

    case "archiveMembre": {
      // Soft-delete d'un membre d'équipe : actif=false. Préserve l'historique
      // (livraisons passées qui référencent l'id) tout en sortant le membre
      // des listes "actifs". gasGet historique → reproduit via updateDoc.
      const id = params.id;
      if (!id) throw new Error("id requis");
      await updateDoc(doc(db, "equipe", id), { actif: false });
      return { ok: true };
    }

    case "deleteLivraison": {
      // Soft-delete : statut="annulee". restoreLivraison remet à "planifiee".
      // Pas de delete physique car les vélos rattachés gardent une référence
      // (tourneeId/livraisonId) qu'on ne veut pas casser.
      // Décrémente stats.planifies sur le client si la livraison était planifiée
      // (sinon le pop-up /carte affiche un compteur stale et bloque la
      // re-planification — bug 2026-04-28).
      const id = params.id;
      if (!id) throw new Error("id requis");
      const raisonAnnulation = String(params.raisonAnnulation || "").trim() || null;
      const livRef = doc(db, "livraisons", id);
      const livSnap = await getDoc(livRef);
      const livData = livSnap.exists() ? (livSnap.data() as { statut?: string; clientId?: string }) : null;
      const wasPlanifiee = livData?.statut === "planifiee";
      const cidDel = livData?.clientId || null;
      await updateDoc(livRef, {
        statut: "annulee",
        dateEffective: null,
        raisonAnnulation,
        annuleeAt: ts(),
      });
      if (wasPlanifiee && cidDel) {
        try {
          const cRef = doc(db, "clients", cidDel);
          const cSnap = await getDoc(cRef);
          if (cSnap.exists()) {
            const stats = (cSnap.data() as { stats?: { planifies?: number } }).stats || {};
            const cur = Number(stats.planifies) || 0;
            await updateDoc(cRef, { "stats.planifies": Math.max(0, cur - 1) });
          }
        } catch (e) {
          console.error("[deleteLivraison] decrement planifies KO", e);
        }
      }
      return { ok: true };
    }

    case "restoreLivraison": {
      const id = params.id;
      if (!id) throw new Error("id requis");
      const livRef = doc(db, "livraisons", id);
      const livSnap = await getDoc(livRef);
      const livData = livSnap.exists() ? (livSnap.data() as { statut?: string; clientId?: string }) : null;
      const wasAnnulee = livData?.statut === "annulee";
      const cidRest = livData?.clientId || null;
      await updateDoc(livRef, { statut: "planifiee", dateEffective: null });
      // Symétrique : si on remet en planifiee depuis annulee, ré-incrémente.
      if (wasAnnulee && cidRest) {
        try {
          const cRef = doc(db, "clients", cidRest);
          const cSnap = await getDoc(cRef);
          if (cSnap.exists()) {
            const stats = (cSnap.data() as { stats?: { planifies?: number } }).stats || {};
            const cur = Number(stats.planifies) || 0;
            await updateDoc(cRef, { "stats.planifies": cur + 1 });
          }
        } catch (e) {
          console.error("[restoreLivraison] increment planifies KO", e);
        }
      }
      return { ok: true };
    }

    case "cancelTournee": {
      // Annule toutes les livraisons d'une tournée (statut="annulee").
      // Utilisé par le bouton "Annuler la tournée" dans /livraisons.
      // Décrémente stats.planifies sur chaque client touché (cf. deleteLivraison).
      const tourneeId = params.tourneeId;
      if (!tourneeId) throw new Error("tourneeId requis");
      const raisonAnnulationT = String(params.raisonAnnulation || "").trim() || null;
      const snap = await getDocs(
        query(collection(db, "livraisons"), where("tourneeId", "==", tourneeId)),
      );
      const docs = snap.docs.filter((d) => (d.data() as { statut?: string }).statut !== "annulee");

      // Compte les décréments par clientId AVANT de muter (les livraisons
      // étaient toutes planifiees ou en cours — on décrémente uniquement
      // celles qui étaient en statut=planifiee côté stats client).
      const decrParClient = new Map<string, number>();
      for (const d of docs) {
        const data = d.data() as { statut?: string; clientId?: string };
        if (data.statut !== "planifiee") continue;
        const cid = data.clientId || "";
        if (!cid) continue;
        decrParClient.set(cid, (decrParClient.get(cid) || 0) + 1);
      }

      // writeBatch limité à 500 ops — au-delà on découpe.
      for (let i = 0; i < docs.length; i += 400) {
        const batch = writeBatch(db);
        for (const d of docs.slice(i, i + 400)) {
          batch.update(d.ref, {
            statut: "annulee",
            dateEffective: null,
            raisonAnnulation: raisonAnnulationT,
            annuleeAt: ts(),
          });
        }
        await batch.commit();
      }

      // Décrément stats.planifies par client (pas batché — quelques clients
      // par tournée typiquement, lectures séquentielles acceptables).
      for (const [cid, n] of decrParClient.entries()) {
        try {
          const cRef = doc(db, "clients", cid);
          const cSnap = await getDoc(cRef);
          if (!cSnap.exists()) continue;
          const stats = (cSnap.data() as { stats?: { planifies?: number } }).stats || {};
          const cur = Number(stats.planifies) || 0;
          await updateDoc(cRef, { "stats.planifies": Math.max(0, cur - n) });
        } catch (e) {
          console.error("[cancelTournee] decrement planifies KO", cid, e);
        }
      }
      return { ok: true, count: docs.length };
    }

    case "countPendingVerifications": {
      // Badge sidebar admin (poll 60s). On compte uniquement les verifs
      // status=pending. getDocs renvoie le size sans frais supplémentaires
      // significatifs vs un getCountFromServer (collection limitée).
      const snap = await getDocs(
        query(collection(db, "verifications"), where("status", "==", "pending")),
      );
      return { ok: true, count: snap.size };
    }

    default:
      return null; // signal "fallback GAS"
  }
}

export async function deleteVerification(id: string) {
  await deleteDoc(doc(db, "verifications", id));
}
