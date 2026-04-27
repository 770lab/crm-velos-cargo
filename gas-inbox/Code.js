/**
 * ============================================================================
 * CRM Vélos Cargo — Inbox Watcher (Gmail + Gemini + Drive)
 * ============================================================================
 *
 * Rôle :
 *   Tourne sur velos-cargo@artisansverts.energy.
 *   Scanne les mails entrants, identifie le client via expéditeur/domaine/Gemini,
 *   classe les PJ dans le dossier Drive du client, extrait l'effectif URSSAF
 *   via Gemini et crée une ligne "à vérifier" dans la sheet CRM.
 *
 * Déclenchement :
 *   - Trigger temporel 15 min sur inboxSync()
 *   - Manuel : URL /exec?action=sync
 *
 * Setup (1 fois) :
 *   1. Coller ce fichier dans le projet GAS
 *   2. Lancer setupProps() dans l'éditeur et suivre le prompt pour entrer la clé Gemini
 *   3. Autoriser les scopes
 *   4. Créer trigger 15min → installTriggers()
 *   5. Déployer en web app (Anyone with link)
 * ============================================================================
 */

// ─── Config ──────────────────────────────────────────────────────────────────

var CRM_SPREADSHEET_ID = "1R5IgP1DpgngkIDqFgArDARI79JCKD1Vn1CPrJOGy590";
var DRIVE_PARENT_ID    = "1cAycg2vUSZbcj6FqJnpmB_hHYCgCBmSR";

var LABEL_TO_PROCESS = "crm-a-traiter";
var LABEL_PROCESSED  = "crm-traite";
var LABEL_FAILED     = "crm-echec";

// Sheet dédiée aux éléments à vérifier par l'humain
var VERIF_SHEET = "VerificationsPending";
var VERIF_COLS  = [
  "id", "receivedAt", "clientId", "entreprise", "docType",
  "driveUrl", "fileName", "fromEmail", "subject",
  "effectifDetected", "nbVelosDevis", "nbVelosBefore", "nbVelosAfter",
  "status", "notes", "messageId"
];

var GEMINI_MODEL = "gemini-2.5-flash";

// ─── HTTP entrypoints (façon luze) ───────────────────────────────────────────

function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || "ping";
    switch (action) {
      case "ping":
        return _respond({ status: "ok", now: new Date().toISOString(), user: Session.getActiveUser().getEmail() });
      case "sync":
        return _respond(inboxSync(e.parameter || {}));
      case "debug":
        return _respond(debugInbox());
      case "progress":
        return _respond(syncProgress(e.parameter || {}));
      case "relabel":
        return _respond(relabelUnprocessed());
      case "retryFailed":
        return _respond(retryFailedThreads(e.parameter || {}));
      case "extractContacts":
        return _respond(extractContactsFromSignatures(e.parameter || {}));
      case "reanalyzeByDocType":
        return _respond(reanalyzeByDocType(e.parameter || {}));
      default:
        return _respondError("Action GET inconnue : " + action);
    }
  } catch (err) {
    return _respondError(err.message);
  }
}

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    var action = payload.action;
    switch (action) {
      case "sync":
        return _respond(inboxSync(payload));
      default:
        return _respondError("Action POST inconnue : " + action);
    }
  } catch (err) {
    return _respondError(err.message);
  }
}

function _respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
function _respondError(msg) {
  return _respond({ status: "error", error: String(msg) });
}

// ─── Setup helpers ───────────────────────────────────────────────────────────

function setupProps() {
  var ui = SpreadsheetApp.getUi ? null : null; // pas d'UI en standalone ; utilise PropertiesService direct
  var existing = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY") || "";
  Logger.log(
    "Ouvre ce script dans l'éditeur puis va dans Projet > Properties > Script properties\n" +
    "Ajoute/vérifie : GEMINI_API_KEY = <ta clé AIzaSy...>\n" +
    "Actuelle : " + (existing ? existing.substring(0, 8) + "…" : "(vide)")
  );
}

// Compte les threads restants à traiter + donne la date du plus ancien
// restant (= la date jusqu'où le watcher devra remonter)
function syncProgress(payload) {
  var days = (payload && payload.days) ? Math.max(1, Math.min(3650, Number(payload.days))) : 365;
  var queryRemaining = "has:attachment newer_than:" + days + "d -label:" + LABEL_PROCESSED + " -label:" + LABEL_FAILED;
  var queryProcessed = "has:attachment newer_than:" + days + "d label:" + LABEL_PROCESSED;
  // Cap à 500 résultats par appel pour éviter les timeouts. Si remaining === 500, c'est probablement plus.
  var remaining = GmailApp.search(queryRemaining, 0, 500);
  var processed = GmailApp.search(queryProcessed, 0, 500);
  var oldestRemainingDate = null;
  var newestRemainingDate = null;
  for (var i = 0; i < remaining.length; i++) {
    var d = remaining[i].getLastMessageDate();
    if (!oldestRemainingDate || d < oldestRemainingDate) oldestRemainingDate = d;
    if (!newestRemainingDate || d > newestRemainingDate) newestRemainingDate = d;
  }
  return {
    days: days,
    remaining: remaining.length,
    remainingCapped: remaining.length === 500,
    processed: processed.length,
    processedCapped: processed.length === 500,
    oldestRemaining: oldestRemainingDate ? oldestRemainingDate.toISOString() : null,
    newestRemaining: newestRemainingDate ? newestRemainingDate.toISOString() : null
  };
}

// Cible les verifs récentes en `unassigned` (typiquement après une erreur Gemini 429),
// retire le label crm-traite des threads correspondants et remet crm-a-traiter,
// puis marque la row en "rejected" avec une note explicite — la prochaine sync
// recréera une verif propre avec clientId résolu, sans doublon dans /verifications.
// Param: ?hours=N (défaut 6, max 168).
function retryFailedThreads(payload) {
  var hours = (payload && payload.hours) ? Math.max(1, Math.min(168, Number(payload.hours))) : 6;
  var cutoffMs = Date.now() - hours * 60 * 60 * 1000;

  var sh = _ensureVerifSheet();
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return { found: 0, relabeled: 0, marked: 0, errors: [] };

  var headers = data[0];
  var col = {
    status: headers.indexOf("status"),
    clientId: headers.indexOf("clientId"),
    receivedAt: headers.indexOf("receivedAt"),
    messageId: headers.indexOf("messageId"),
    notes: headers.indexOf("notes")
  };
  if (col.messageId < 0 || col.status < 0) {
    return { error: "VerificationsPending: colonnes messageId/status manquantes" };
  }

  var labelTo = _getOrCreateLabel(LABEL_TO_PROCESS);
  var labelOk = _getOrCreateLabel(LABEL_PROCESSED);

  var stats = { hours: hours, found: 0, relabeled: 0, marked: 0, errors: [] };
  var seenThreads = {};

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var status = String(row[col.status] || "").toLowerCase();
    if (status !== "unassigned" && status !== "") continue;
    if (row[col.clientId] && String(row[col.clientId]).trim() !== "") continue;

    var receivedAt = row[col.receivedAt];
    var ts = (receivedAt instanceof Date) ? receivedAt.getTime() : (receivedAt ? Date.parse(receivedAt) : 0);
    if (!ts || ts < cutoffMs) continue;

    var messageId = row[col.messageId];
    if (!messageId) continue;

    stats.found++;

    try {
      var msg = GmailApp.getMessageById(String(messageId));
      var thread = msg.getThread();
      var threadId = thread.getId();

      if (!seenThreads[threadId]) {
        thread.removeLabel(labelOk);
        thread.addLabel(labelTo);
        seenThreads[threadId] = true;
        stats.relabeled++;
      }

      sh.getRange(i + 1, col.status + 1).setValue("rejected");
      if (col.notes >= 0) {
        var oldNotes = String(row[col.notes] || "");
        var tag = "Auto-rejected for retry after Gemini error";
        sh.getRange(i + 1, col.notes + 1).setValue(oldNotes ? oldNotes + " | " + tag : tag);
      }
      stats.marked++;
    } catch (err) {
      stats.errors.push({ messageId: String(messageId), error: String(err) });
    }
  }

  return stats;
}

function relabelUnprocessed() {
  var labelTo = _getOrCreateLabel(LABEL_TO_PROCESS);
  var query = "has:attachment -label:" + LABEL_PROCESSED + " -label:" + LABEL_FAILED + " -label:" + LABEL_TO_PROCESS;
  var threads = GmailApp.search(query, 0, 500);
  var count = 0;
  for (var i = 0; i < threads.length; i++) {
    threads[i].addLabel(labelTo);
    count++;
  }
  return { relabeled: count };
}

// Re-soumet à Gemini les verifs des docTypes spécifiés (ex: après amélioration
// du prompt). Pour chaque verif :
//  1. Retrouve le thread Gmail via messageId
//  2. Retire les labels crm-traite et crm-echec
//  3. Pose le label crm-a-traiter
//  4. Marque la verif comme "rejected" avec note "to-reanalyze"
// Le sync auto recréera ensuite des verifs propres avec le nouveau prompt.
//
// Param: ?docTypes=DEVIS,DSN,URSSAF,LIASSE,ATTESTATION (default: tous ces 5)
//        ?max=500 (default 500, max 2000) pour limiter le batch
function reanalyzeByDocType(payload) {
  var docTypesParam = payload && payload.docTypes
    ? String(payload.docTypes)
    : "DEVIS,DSN,URSSAF,LIASSE,ATTESTATION";
  var docTypes = {};
  docTypesParam.split(",").forEach(function (t) {
    var s = String(t).trim().toUpperCase();
    if (s) docTypes[s] = true;
  });
  var max = (payload && payload.max) ? Math.max(1, Math.min(2000, Number(payload.max))) : 500;

  var sh = _ensureVerifSheet();
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return { found: 0, relabeled: 0, errors: [] };

  var headers = data[0];
  var col = {
    docType: headers.indexOf("docType"),
    status: headers.indexOf("status"),
    messageId: headers.indexOf("messageId"),
    notes: headers.indexOf("notes")
  };
  if (col.messageId < 0 || col.docType < 0 || col.status < 0) {
    return { error: "VerificationsPending: colonnes manquantes (docType/status/messageId)" };
  }

  var labelTo = _getOrCreateLabel(LABEL_TO_PROCESS);
  var labelOk = _getOrCreateLabel(LABEL_PROCESSED);
  var labelKo = _getOrCreateLabel(LABEL_FAILED);

  var stats = { docTypes: Object.keys(docTypes), found: 0, relabeled: 0, marked: 0, errors: [], threadsTouched: 0 };
  var seenThreads = {};

  for (var i = 1; i < data.length && stats.marked < max; i++) {
    var row = data[i];
    var dt = String(row[col.docType] || "").toUpperCase();
    if (!docTypes[dt]) continue;
    var status = String(row[col.status] || "").toLowerCase();
    // Skip les déjà rejetés "to-reanalyze" pour éviter boucle si on relance
    var existingNote = col.notes >= 0 ? String(row[col.notes] || "") : "";
    if (status === "rejected" && existingNote.indexOf("to-reanalyze") >= 0) continue;

    var messageId = row[col.messageId];
    if (!messageId) continue;
    stats.found++;

    try {
      var msg = GmailApp.getMessageById(String(messageId));
      var thread = msg.getThread();
      var threadId = thread.getId();
      if (!seenThreads[threadId]) {
        try { thread.removeLabel(labelOk); } catch (e) {}
        try { thread.removeLabel(labelKo); } catch (e) {}
        thread.addLabel(labelTo);
        seenThreads[threadId] = true;
        stats.threadsTouched++;
      }
      stats.relabeled++;
      // Marque la verif comme rejected pour qu'une nouvelle soit créée à la
      // prochaine sync (sinon doublon dans /verifications).
      sh.getRange(i + 1, col.status + 1).setValue("rejected");
      if (col.notes >= 0) {
        var tag = "to-reanalyze " + new Date().toISOString().slice(0, 10);
        sh.getRange(i + 1, col.notes + 1).setValue(existingNote ? existingNote + " | " + tag : tag);
      }
      stats.marked++;
    } catch (err) {
      stats.errors.push({ messageId: String(messageId), error: String(err) });
    }
  }

  return stats;
}

function installTriggers() {
  // Supprime les anciens triggers
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "inboxSync") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  var interval = 1;
  ScriptApp.newTrigger("inboxSync").timeBased().everyMinutes(interval).create();
  Logger.log("Trigger inboxSync installé (" + interval + " min).");
}

function _getGeminiKey() {
  var k = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!k) throw new Error("GEMINI_API_KEY manquante dans Script Properties");
  return k;
}

// ─── Inbox sync ──────────────────────────────────────────────────────────────

function inboxSync(payload) {
  var started = new Date();
  var stats = { threads: 0, messages: 0, processed: 0, matched: 0, unassigned: 0, errors: 0, batches: 0, details: [] };

  var labelTo  = _getOrCreateLabel(LABEL_TO_PROCESS);
  var labelOk  = _getOrCreateLabel(LABEL_PROCESSED);
  var labelKo  = _getOrCreateLabel(LABEL_FAILED);

  // Recherche : on traite TOUT ce qui matche soit le label crm-a-traiter (file
  // de catch-up posée à la main), soit n'importe quel mail avec PJ dans la
  // fenêtre `days` — du moment qu'il n'a pas déjà été traité (crm-traite) ou
  // rejeté (crm-echec). Par défaut 365j pour couvrir l'historique en attente,
  // override possible via payload.days.
  var days = (payload && payload.days) ? Math.max(1, Math.min(3650, Number(payload.days))) : 365;
  var query = "(label:" + LABEL_TO_PROCESS + " OR has:attachment newer_than:" + days + "d) " +
              "-label:" + LABEL_PROCESSED + " -label:" + LABEL_FAILED;

  var batchSize = (payload && payload.batchSize) ? Math.min(Number(payload.batchSize), 200) : 50;
  // Mode loop : on enchaîne les batches dans la même requête HTTP, jusqu'à
  // ce que la file soit vide ou qu'on approche du timeout GAS (6 min).
  // Budget par défaut 4 min, override via payload.maxMs.
  var loop = !!(payload && (payload.loop === "true" || payload.loop === true));
  var maxMs = (payload && payload.maxMs) ? Number(payload.maxMs) : 4 * 60 * 1000;

  var crmCtx = _loadCrmContext();

  do {
    var threads = GmailApp.search(query, 0, batchSize);
    if (threads.length === 0) break;
    stats.batches++;
    stats.threads += threads.length;

    for (var t = 0; t < threads.length; t++) {
      var thread = threads[t];
      var messages = thread.getMessages();
      for (var m = 0; m < messages.length; m++) {
        var msg = messages[m];
        stats.messages++;
        try {
          var r = _processMessage(msg, crmCtx);
          if (r.matched) stats.matched++; else stats.unassigned++;
          stats.processed++;
          // On garde au plus 50 entrées de details pour ne pas exploser la réponse JSON.
          if (stats.details.length < 50) stats.details.push(r);
        } catch (err) {
          stats.errors++;
          if (stats.details.length < 50) stats.details.push({ messageId: msg.getId(), error: String(err) });
        }
      }
      try { thread.addLabel(labelOk); } catch (e) {}
    }

    if (!loop) break;
    if (new Date() - started > maxMs) break;
  } while (true);

  return {
    status: "ok",
    elapsedMs: new Date() - started,
    drained: stats.threads === 0 || (loop && stats.threads < batchSize * stats.batches),
    stats: stats
  };
}

function _processMessage(msg, crmCtx) {
  var result = {
    messageId: msg.getId(),
    subject: msg.getSubject(),
    from: msg.getFrom(),
    matched: false,
    attachments: []
  };

  var attachments = msg.getAttachments({ includeInlineImages: false, includeAttachments: true });
  var pdfs = attachments.filter(function (a) {
    var ct = a.getContentType() || "";
    return ct.indexOf("pdf") >= 0 || /\.pdf$/i.test(a.getName());
  });
  if (pdfs.length === 0 && attachments.length === 0) {
    // Pas de PJ : on ignore ce message
    result.skipped = "no-attachments";
    return result;
  }

  var fromEmail = _extractEmail(msg.getFrom());

  // 1) Gemini analyse le document EN PREMIER pour identifier le vrai client
  var gemini = null;
  try {
    var clientNames = crmCtx.clients.map(function (c) { return c.entreprise; }).filter(Boolean);
    gemini = _geminiAnalyze({
      subject: msg.getSubject(),
      body: (msg.getPlainBody() || "").substring(0, 4000),
      fromEmail: fromEmail,
      pdfBlobs: pdfs,
      knownClients: clientNames
    });
  } catch (e) {
    result.geminiError = String(e);
  }

  // 2) Matching : Gemini d'abord (contenu du document), email en fallback
  var matched = null;
  if (gemini && gemini.clientName) {
    matched = _matchClientByText(crmCtx, gemini.clientName);
  }
  if (!matched) {
    matched = _matchClientByEmail(crmCtx, fromEmail)
           || _matchClientByDomain(crmCtx, fromEmail)
           || _matchClientByText(crmCtx, msg.getSubject() + "\n" + msg.getPlainBody());
  }

  result.gemini = gemini;
  result.matched = !!matched;

  // Upload des PJ au dossier client (si matché) sinon dossier "À classer"
  var folder = matched
    ? _getClientFolder(matched.entreprise, matched.id)
    : _getOrCreateFolder(DriveApp.getFolderById(DRIVE_PARENT_ID), "À classer manuellement");

  for (var i = 0; i < attachments.length; i++) {
    var att = attachments[i];
    try {
      var blob = att.copyBlob();
      var file = folder.createFile(blob);
      try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e2) {}
      result.attachments.push({ name: att.getName(), url: file.getUrl(), folderId: folder.getId() });
    } catch (e) {
      result.attachments.push({ name: att.getName(), error: String(e) });
    }
  }

  // Maj nbVelos auto si effectif détecté ET client matché
  var nbBefore = null, nbAfter = null;
  if (matched && gemini && gemini.effectif != null && gemini.effectif >= 0 && gemini.effectif < 10000) {
    nbBefore = Number(matched.nbVelosCommandes || 0);
    nbAfter  = Math.max(nbBefore, Number(gemini.effectif));
    if (nbAfter !== nbBefore) {
      _updateClientField(matched.rowIndex, crmCtx.clientsHeaders.indexOf("nbVelosCommandes") + 1, nbAfter);
      var effCol = crmCtx.clientsHeaders.indexOf("effectifMentionne");
      if (effCol >= 0) _updateClientField(matched.rowIndex, effCol + 1, true);
    }
  }

  // Auto-remplir kbisDate si Gemini l'a extrait
  if (matched && gemini && gemini.kbisDate) {
    var kbisDateCol = crmCtx.clientsHeaders.indexOf("kbisDate");
    if (kbisDateCol >= 0) _updateClientField(matched.rowIndex, kbisDateCol + 1, gemini.kbisDate);
  }

  // Auto-remplir dateEngagement si Gemini a trouvé une date de devis
  if (matched && gemini && gemini.devisDate) {
    var engCol = crmCtx.clientsHeaders.indexOf("dateEngagement");
    if (engCol >= 0) {
      var existing = crmCtx.sheet.getRange(matched.rowIndex, engCol + 1).getValue();
      if (!existing) _updateClientField(matched.rowIndex, engCol + 1, gemini.devisDate);
    }
  }

  // Auto-flag effectifPresent si Gemini a détecté un effectif dans le document
  if (matched && gemini && gemini.effectifPresent === true) {
    var effPCol = crmCtx.clientsHeaders.indexOf("effectifMentionne");
    if (effPCol >= 0) _updateClientField(matched.rowIndex, effPCol + 1, true);
  }

  // Routage spécial Bons d'enlèvement : écrit directement dans la sheet
  // BonsEnlevement, pas dans VerificationsPending (le BE n'est pas un doc client
  // à valider, c'est une confirmation de commande fournisseur liée à une tournée).
  if (gemini && gemini.docType === "BON_ENLEVEMENT" && gemini.bonEnlevement) {
    var be = gemini.bonEnlevement;
    var driveUrls = result.attachments.map(function (a) { return a.url || ""; }).filter(Boolean).join(" ||| ");
    var fileNames = result.attachments.map(function (a) { return a.name; }).join(", ");
    try {
      _addBonEnlevementRow({
        fournisseur: be.fournisseur || "",
        numeroDoc: be.numeroDoc || "",
        dateDoc: be.dateDoc || "",
        tourneeRef: be.tourneeRef || "",
        tourneeDate: be.dateDoc || "",
        tourneeNumero: be.tourneeNumero != null ? be.tourneeNumero : "",
        quantite: be.quantite != null ? be.quantite : "",
        driveUrl: driveUrls,
        fileName: fileNames,
        fromEmail: fromEmail,
        subject: msg.getSubject(),
        messageId: msg.getId()
      });
      result.bonEnlevement = be;
    } catch (e) {
      result.bonEnlevementError = String(e);
    }
    return result;
  }

  // Écrit la ligne dans VerificationsPending (cas standard)
  _addVerification({
    clientId: matched ? matched.id : "",
    entreprise: matched ? matched.entreprise : (gemini && gemini.clientName) || "",
    docType: gemini && gemini.docType || "",
    driveUrl: result.attachments.map(function (a) { return a.url || ""; }).filter(Boolean).join(" ||| "),
    fileName: result.attachments.map(function (a) { return a.name; }).join(", "),
    fromEmail: fromEmail,
    subject: msg.getSubject(),
    effectifDetected: gemini && gemini.effectif != null ? gemini.effectif : "",
    nbVelosDevis: gemini && gemini.nbVelosDevis != null ? gemini.nbVelosDevis : "",
    nbVelosBefore: nbBefore == null ? "" : nbBefore,
    nbVelosAfter:  nbAfter == null ? "" : nbAfter,
    status: matched ? "pending" : "unassigned",
    notes: gemini && gemini.notes || "",
    messageId: msg.getId()
  });

  return result;
}

// ─── Gemini ──────────────────────────────────────────────────────────────────

function _geminiAnalyze(ctx) {
  var key = _getGeminiKey();
  var url = "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent?key=" + key;

  var clientList = (ctx.knownClients || []).join(", ");

  var parts = [{
    text:
      "Tu analyses un email reçu pour un CRM de livraison de vélos cargo aux commerces.\n" +
      "Contexte : Artisans Verts Energy livre des vélos électriques aux salariés de magasins (1 vélo / salarié max).\n\n" +
      "REGLE GLOBALE : tu DOIS lire CHAQUE PAGE de CHAQUE PDF joint en entier avant de repondre. Ne te limite PAS a la 1re page. Verifie le footer \"Page X / Y\" et assure-toi d\'avoir scanne tout le document. Un document tronque = mauvaise extraction = donnees CEE faussees.\n\n" +
      "IMPORTANT : L'expéditeur de l'email N'EST PAS forcément le client final. " +
      "Il peut être un apporteur d'affaires, un courtier, un cabinet RH ou un intermédiaire " +
      "qui transmet des documents pour le compte d'un de ses propres clients. " +
      "Le NOM DU CLIENT doit être extrait du CONTENU DES DOCUMENTS (PDF) et non de l'adresse email de l'expéditeur. " +
      "Cherche dans le PDF : la raison sociale, le nom sur le KBIS, le nom sur la DSN/URSSAF, " +
      "le destinataire du devis, etc.\n\n" +
      "Liste des clients connus dans le CRM :\n" + clientList + "\n\n" +
      "Si le nom trouvé dans le document correspond (même partiellement) à un client connu ci-dessus, " +
      "utilise EXACTEMENT le nom tel qu'il apparaît dans la liste.\n\n" +
      "Renvoie UNIQUEMENT un JSON strict :\n" +
      "{\n" +
      '  "clientName": string|null (nom de la societe CIBLE du document, PAS l\'expediteur),\n' +
      '  "docType": "DEVIS"|"KBIS"|"LIASSE"|"URSSAF"|"ATTESTATION"|"SIGNATURE"|"BICYCLE"|"PARCELLE"|"BON_ENLEVEMENT"|"AUTRE"|null,\n' +
      '  "effectif": number|null (effectif total de salaries de l\'entreprise au moment du document. Voir REGLES EFFECTIF ci-dessous pour le comptage selon le type de doc),\n' +
      '  "effectifPresent": true|false|null (true si un nombre d\'effectifs/salaries est visible dans le document),\n' +
      '  "nbVelosDevis": number|null (UNIQUEMENT si docType=\"DEVIS\" : nombre TOTAL de velos cargo electriques commandes sur le devis, somme des quantites des lignes \"velo cargo\". Ne compte PAS les accessoires/bornes/services),\n' +
      '  "kbisDate": "YYYY-MM-DD"|null (date de l\'extrait Kbis/RNE "a jour au..." visible sur le document),\n' +
      '  "devisDate": "YYYY-MM-DD"|null (date du devis si document est un devis signe),\n' +
      '  "bonEnlevement": null|{ "fournisseur": string, "numeroDoc": string, "dateDoc": "YYYY-MM-DD", "tourneeRef": string (ex: "TOURNEE 1"), "tourneeNumero": number|null (juste le numero extrait de tourneeRef), "quantite": number (quantite totale de velos cargo, somme des lignes "VELO CARGO ELECTRIQUE" sans compter les eco-contributions ni les frais d\'enlevement) },\n' +
      '  "notes": string (1 phrase de contexte)\n' +
      "}\n\n" +
      "REGLE BON D\'ENLEVEMENT : si le document est une \"Confirmation de commande\" ou un \"Bon d\'enlevement\" d\'un fournisseur (ex: AXDIS PRO) avec une reference type \"VELO CARGO- TOURNEE N\", alors docType=\"BON_ENLEVEMENT\" et remplis le champ bonEnlevement. La quantite est le nombre de velos cargo electriques sur le bon (NE compte PAS les lignes ENL/eco-contribution).\n\n" +
      "REGLES EFFECTIF (TRES IMPORTANT — lecture DSN, URSSAF, registre du personnel, liasse) :\n" +
      " * Le document peut faire PLUSIEURS PAGES — tu DOIS scanner TOUTES les pages avant de retourner ton chiffre. Ne te limite JAMAIS a la page 1.\n" +
      " * Cherche en priorite un chiffre EXPLICITE intitule : \"effectif\", \"effectif salarie\", \"nombre de salaries\", \"effectif moyen mensuel\", \"effectif au [date]\", \"total des salaries\", \"effectif declare\". Si tu en trouves un, utilise-le.\n" +
      " * Si le document est un REGISTRE UNIQUE DU PERSONNEL (RUP) sans chiffre total : compte le NOMBRE DE LIGNES de salaries listes sur l\'ensemble des pages, en EXCLUANT les salaries dont la date de sortie est passee (anteriore a la date du document). Ne compte chaque salarie qu\'une seule fois meme s\'il apparait sur plusieurs pages. Le RUP fait souvent 5-10 pages — verifie le footer \"Page X / Y\" pour t\'assurer d\'avoir tout lu.\n" +
      " * Si le document est une DSN ou attestation URSSAF : prends l\'effectif declare au mois le plus recent.\n" +
      " * Si le document est une LIASSE FISCALE : prends la ligne \"effectif moyen du personnel\" (case YP du formulaire 2058-C ou equivalent).\n" +
      " * Si tu n\'es PAS SUR du chiffre (registre tronque, page manquante, ambigu), retourne effectif=null plutot qu\'un chiffre faux. Mieux vaut null qu\'un mauvais chiffre.\n" +
      " * Indique TOUJOURS dans le champ \"notes\" comment tu as obtenu le chiffre (ex: \"Compte 31 lignes salaries sur 6 pages du RUP\", \"Effectif moyen mensuel mai 2025 = 12 sur DSN\").\n\n" +
      "Email :\n" +
      "From: " + ctx.fromEmail + "\n" +
      "Subject: " + ctx.subject + "\n" +
      "Body:\n" + ctx.body
  }];

  var pdfBlobs = ctx.pdfBlobs || (ctx.pdfBlob ? [ctx.pdfBlob] : []);
  var totalB64Size = 0;
  var MAX_PAYLOAD = 15 * 1024 * 1024; // 15 MB max pour Gemini
  for (var i = 0; i < pdfBlobs.length; i++) {
    try {
      var bytes = pdfBlobs[i].getBytes();
      var b64Size = Math.ceil(bytes.length * 4 / 3);
      if (totalB64Size + b64Size > MAX_PAYLOAD) break;
      parts.push({
        inline_data: { mime_type: "application/pdf", data: Utilities.base64Encode(bytes) }
      });
      totalB64Size += b64Size;
    } catch (e) {}
  }

  var body = {
    contents: [{ role: "user", parts: parts }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
  };

  var resp = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  var txt = resp.getContentText();
  if (resp.getResponseCode() >= 300) {
    throw new Error("Gemini HTTP " + resp.getResponseCode() + ": " + txt.substring(0, 300));
  }
  var json = JSON.parse(txt);
  var rawText = json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts && json.candidates[0].content.parts[0] && json.candidates[0].content.parts[0].text;
  if (!rawText) return null;
  try {
    return JSON.parse(rawText);
  } catch (e) {
    return { clientName: null, docType: null, effectif: null, notes: "parse error: " + rawText.substring(0, 200) };
  }
}

// ─── CRM context ─────────────────────────────────────────────────────────────

function _openCrm() {
  return SpreadsheetApp.openById(CRM_SPREADSHEET_ID);
}

function _loadCrmContext() {
  var ss = _openCrm();
  var sheet = ss.getSheetByName("Clients");
  if (!sheet) throw new Error("Feuille Clients introuvable dans la Sheet CRM");
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var clients = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var c = {};
    headers.forEach(function (h, j) { c[h] = row[j]; });
    c.rowIndex = i + 1; // 1-based
    c._nameNorm = _norm(c.entreprise);
    c._emailNorm = String(c.email || "").toLowerCase().trim();
    c._domain = c._emailNorm.indexOf("@") > 0 ? c._emailNorm.split("@")[1] : "";
    clients.push(c);
  }
  return { sheet: sheet, clientsHeaders: headers, clients: clients };
}

function _updateClientField(rowIndex, colIndex1Based, value) {
  var ss = _openCrm();
  var sheet = ss.getSheetByName("Clients");
  sheet.getRange(rowIndex, colIndex1Based).setValue(value);
}

function _matchClientByEmail(ctx, email) {
  if (!email) return null;
  var e = email.toLowerCase();
  for (var i = 0; i < ctx.clients.length; i++) {
    if (ctx.clients[i]._emailNorm === e) return ctx.clients[i];
  }
  return null;
}
function _matchClientByDomain(ctx, email) {
  if (!email) return null;
  var dom = email.toLowerCase().split("@")[1];
  if (!dom || dom === "gmail.com" || dom === "yahoo.fr" || dom === "hotmail.fr" || dom === "outlook.fr") return null;
  for (var i = 0; i < ctx.clients.length; i++) {
    if (ctx.clients[i]._domain === dom) return ctx.clients[i];
  }
  return null;
}
function _matchClientByText(ctx, text) {
  if (!text) return null;
  var n = _norm(text);
  var best = null; var bestLen = 0;
  for (var i = 0; i < ctx.clients.length; i++) {
    var nm = ctx.clients[i]._nameNorm;
    if (!nm || nm.length < 4) continue;
    if (n.indexOf(nm) >= 0 && nm.length > bestLen) {
      best = ctx.clients[i]; bestLen = nm.length;
    }
  }
  return best;
}

// ─── VerificationsPending sheet ──────────────────────────────────────────────

function _ensureVerifSheet() {
  var ss = _openCrm();
  var sh = ss.getSheetByName(VERIF_SHEET);
  if (!sh) {
    sh = ss.insertSheet(VERIF_SHEET);
    sh.getRange(1, 1, 1, VERIF_COLS.length).setValues([VERIF_COLS]);
    sh.setFrozenRows(1);
  } else {
    // Assure colonnes
    var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var missing = VERIF_COLS.filter(function (c) { return headers.indexOf(c) < 0; });
    if (missing.length) {
      sh.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
    }
  }
  return sh;
}

function _addVerification(row) {
  var sh = _ensureVerifSheet();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var id = Utilities.getUuid();
  var out = headers.map(function (h) {
    if (h === "id") return id;
    if (h === "receivedAt") return new Date();
    return row[h] == null ? "" : row[h];
  });
  sh.appendRow(out);
}

// ─── BonsEnlevement sheet (écriture depuis Inbox Watcher) ────────────────────

var BE_SHEET = "BonsEnlevement";
var BE_COLS = [
  "id", "receivedAt", "fournisseur", "numeroDoc", "dateDoc",
  "tourneeRef", "tourneeDate", "tourneeNumero", "tourneeId",
  "quantite", "driveUrl", "fileName", "fromEmail", "subject", "messageId"
];

function _ensureBonsEnlevementSheet() {
  var ss = _openCrm();
  var sh = ss.getSheetByName(BE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(BE_SHEET);
    sh.getRange(1, 1, 1, BE_COLS.length).setValues([BE_COLS]);
    sh.setFrozenRows(1);
    return sh;
  }
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var missing = BE_COLS.filter(function (c) { return headers.indexOf(c) < 0; });
  if (missing.length) {
    sh.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
  }
  return sh;
}

function _addBonEnlevementRow(payload) {
  var sh = _ensureBonsEnlevementSheet();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  // Idempotence : update si messageId déjà présent
  var existingRow = -1;
  if (payload.messageId) {
    var data = sh.getDataRange().getValues();
    var iMsg = headers.indexOf("messageId");
    for (var r = 1; r < data.length; r++) {
      if (String(data[r][iMsg]) === String(payload.messageId)) { existingRow = r + 1; break; }
    }
  }
  // Match tourneeId par date+numéro (numérotation séquentielle par jour)
  var matchedTourneeId = "";
  if (payload.tourneeDate && payload.tourneeNumero) {
    matchedTourneeId = _findTourneeIdByDateAndNumeroInbox(payload.tourneeDate, Number(payload.tourneeNumero));
  }
  var out = headers.map(function (h) {
    if (h === "id") return existingRow > 0 ? sh.getRange(existingRow, headers.indexOf("id") + 1).getValue() : Utilities.getUuid();
    if (h === "receivedAt") return new Date();
    if (h === "tourneeId") return matchedTourneeId;
    return payload[h] == null ? "" : payload[h];
  });
  if (existingRow > 0) {
    sh.getRange(existingRow, 1, 1, headers.length).setValues([out]);
  } else {
    sh.appendRow(out);
  }
}

function _findTourneeIdByDateAndNumeroInbox(dateStr, numero) {
  var ss = _openCrm();
  var sh = ss.getSheetByName("Livraisons");
  if (!sh) return "";
  var data = sh.getDataRange().getValues();
  if (!data.length) return "";
  var headers = data[0];
  var iDate = headers.indexOf("datePrevue");
  var iTid = headers.indexOf("tourneeId");
  var iStatut = headers.indexOf("statut");
  if (iDate < 0 || iTid < 0) return "";
  var target = String(dateStr).slice(0, 10);
  var seen = {};
  var ids = [];
  var tz = Session.getScriptTimeZone();
  for (var r = 1; r < data.length; r++) {
    var d = data[r][iDate];
    if (!d) continue;
    var iso = (d instanceof Date) ? Utilities.formatDate(d, tz, "yyyy-MM-dd") : String(d).slice(0, 10);
    if (iso !== target) continue;
    if (iStatut >= 0 && data[r][iStatut] === "annulee") continue;
    var tid = String(data[r][iTid] || "").trim();
    if (!tid || seen[tid]) continue;
    seen[tid] = true;
    ids.push(tid);
  }
  ids.sort(function (a, b) { return a.localeCompare(b); });
  return ids[numero - 1] || "";
}

// ─── Drive helpers ───────────────────────────────────────────────────────────

function _getClientFolder(entreprise, clientId) {
  var parent = DriveApp.getFolderById(DRIVE_PARENT_ID);
  var crm = _getOrCreateFolder(parent, "DOCS CRM VELOS");
  var safeName = String(entreprise || "sans-nom").replace(/[^a-zA-Z0-9À-ÿ\s\-]/g, "").substring(0, 50);
  var folderName = safeName + " [" + String(clientId).substring(0, 8) + "]";
  return _getOrCreateFolder(crm, folderName);
}

function _getOrCreateFolder(parent, name) {
  var folders = parent.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return parent.createFolder(name);
}

function _getOrCreateLabel(name) {
  var lbl = GmailApp.getUserLabelByName(name);
  if (lbl) return lbl;
  return GmailApp.createLabel(name);
}

// ─── Utils ───────────────────────────────────────────────────────────────────

function _extractEmail(from) {
  var m = String(from || "").match(/<([^>]+)>/);
  if (m) return m[1].toLowerCase();
  return String(from || "").toLowerCase().trim();
}

function _norm(s) {
  return String(s || "")
    .toUpperCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Debug ───────────────────────────────────────────────────────────────────

function debugInbox() {
  var out = { crmSheetOk: false, driveFolderOk: false, geminiOk: false, threadsToProcess: 0 };
  try { out.user = Session.getActiveUser().getEmail(); } catch (e) { out.userError = String(e); }
  try { out.effective = Session.getEffectiveUser().getEmail(); } catch (e) { out.effectiveError = String(e); }
  try {
    var ss = _openCrm();
    Logger.log("openCrm OK: " + ss.getName());
    var sh = ss.getSheetByName("Clients");
    if (!sh) throw new Error("Feuille Clients introuvable");
    Logger.log("Clients sheet OK: " + sh.getLastRow() + " lignes");
    out.crmSheetOk = true;
  } catch (e) { out.crmSheetError = String(e); Logger.log("crmSheetError: " + e); }
  try {
    var f = DriveApp.getFolderById(DRIVE_PARENT_ID);
    Logger.log("Drive folder OK: " + f.getName());
    out.driveFolderOk = true;
  } catch (e) { out.driveFolderError = String(e); Logger.log("driveFolderError: " + e); }
  try {
    var k = _getGeminiKey();
    Logger.log("Gemini key loaded (len=" + k.length + ")");
    out.geminiOk = true;
  } catch (e) { out.geminiError = String(e); Logger.log("geminiError: " + e); }
  try {
    var q = "has:attachment newer_than:7d -label:" + LABEL_PROCESSED;
    out.threadsToProcess = GmailApp.search(q, 0, 50).length;
    Logger.log("Gmail search OK: " + out.threadsToProcess + " threads");
  } catch (e) { out.gmailError = String(e); Logger.log("gmailError: " + e); }
  Logger.log("=== DEBUG RESULT === " + JSON.stringify(out));
  return out;
}

// ─── Extraction contact via signature de mail ────────────────────────────────
//
// Parcourt les clients sans contact mais avec email, cherche dans Gmail les
// derniers messages reçus DEPUIS cette adresse (donc rédigés par l'humain en
// face), envoie le corps à Gemini avec consigne stricte "extrait nom prénom
// depuis la signature, RIEN si tu hésites", et écrit le résultat dans la
// sheet Clients.
//
// Usage : .../exec?action=extractContacts&batch=20[&dryRun=1]
//   batch  : nombre max de clients traités par run (défaut 20, max 50 pour
//            ne pas dépasser le timeout 6min de GAS)
//   dryRun : si "1", n'écrit pas en sheet, retourne juste les propositions
function extractContactsFromSignatures(payload) {
  payload = payload || {};
  var batch = Math.min(50, Math.max(1, Number(payload.batch) || 20));
  var dryRun = String(payload.dryRun || "") === "1";

  var ctx = _loadCrmContext();
  var iEmail = ctx.clientsHeaders.indexOf("email");
  var iContact = ctx.clientsHeaders.indexOf("contact");
  if (iEmail < 0 || iContact < 0) return { error: "Colonnes email/contact introuvables" };

  // Filtre : email présent + contact vide + pas déjà tenté lors de cette run
  var candidats = ctx.clients.filter(function (c) {
    return c.email && String(c.email).indexOf("@") > 0 && !String(c.contact || "").trim();
  }).slice(0, batch);

  if (candidats.length === 0) return { ok: true, message: "Plus aucun client sans contact à traiter.", processed: 0 };

  var results = [];
  for (var i = 0; i < candidats.length; i++) {
    var c = candidats[i];
    try {
      var bodies = _gmailLastBodiesFrom(c.email, 3);
      if (bodies.length === 0) {
        results.push({ entreprise: c.entreprise, email: c.email, contact: null, raison: "aucun mail trouvé" });
        continue;
      }
      var contactName = _geminiExtractContactFromSignature(bodies, c.email);
      if (contactName) {
        if (!dryRun) _updateClientField(c.rowIndex, iContact + 1, contactName);
        results.push({ entreprise: c.entreprise, email: c.email, contact: contactName, raison: "ok" });
      } else {
        results.push({ entreprise: c.entreprise, email: c.email, contact: null, raison: "doute → rien" });
      }
    } catch (err) {
      results.push({ entreprise: c.entreprise, email: c.email, contact: null, raison: "erreur : " + (err && err.message || err) });
    }
    Utilities.sleep(300); // anti-rate-limit Gemini free tier (15 RPM = 4s/req max, mais ça passe)
  }

  var trouves = results.filter(function (r) { return r.contact; }).length;
  return {
    ok: true,
    processed: candidats.length,
    trouves: trouves,
    sansResultat: candidats.length - trouves,
    dryRun: dryRun,
    results: results,
  };
}

// Récupère les corps texte des N derniers messages dont l'expéditeur est `email`.
// On cherche FROM:email pour avoir les messages écrits par l'humain (pas nos
// envois sortants), avec leurs signatures.
function _gmailLastBodiesFrom(email, maxMessages) {
  var query = "from:" + email;
  var threads = GmailApp.search(query, 0, 5);
  var bodies = [];
  for (var t = 0; t < threads.length && bodies.length < maxMessages; t++) {
    var msgs = threads[t].getMessages();
    for (var m = msgs.length - 1; m >= 0 && bodies.length < maxMessages; m--) {
      var fromHeader = String(msgs[m].getFrom() || "").toLowerCase();
      if (fromHeader.indexOf(email.toLowerCase()) < 0) continue;
      var body = msgs[m].getPlainBody() || "";
      // On ne garde que la queue du message (où est typiquement la signature)
      // pour économiser des tokens et concentrer Gemini sur la signature.
      var tail = body.length > 1500 ? body.substring(body.length - 1500) : body;
      bodies.push(tail);
    }
  }
  return bodies;
}

function _geminiExtractContactFromSignature(bodies, email) {
  var key = _getGeminiKey();
  var url = "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent?key=" + key;

  var prompt =
    "Tu extrais le NOM et PRÉNOM d'un humain depuis la signature de ses mails.\n" +
    "Adresse email de la personne : " + email + "\n\n" +
    "Voici les " + bodies.length + " dernier(s) mail(s) écrit(s) par cette personne. " +
    "Cherche dans la SIGNATURE (généralement en bas, après 'Cordialement', 'Bien à vous', '--', etc.) " +
    "le nom complet de l'humain qui signe.\n\n" +
    "RÈGLES STRICTES :\n" +
    "1. Renvoie EXACTEMENT le nom tel qu'il apparaît dans la signature, format \"Prénom NOM\".\n" +
    "2. Si plusieurs mails donnent des noms différents → renvoie null (incohérence).\n" +
    "3. Si la signature est juste un prénom (ex: 'Cordialement, Jean') → renvoie quand même \"Jean\" (le prénom seul).\n" +
    "4. Si tu n'es PAS SÛR à 95%+, renvoie null. Préfère le NULL au faux positif.\n" +
    "5. Ne renvoie PAS un nom de société, de produit, de cabinet, d'agence (ex: \"AXDIS\", \"Cabinet Dupont\" → null).\n" +
    "6. Ne renvoie PAS un nom générique automatique (ex: \"Equipe Support\", \"Service client\" → null).\n" +
    "7. Si la signature contient nom + fonction, garde juste le nom (ex: \"Jean Dupont, Directeur\" → \"Jean Dupont\").\n\n" +
    "FORMAT JSON STRICT :\n" +
    '{ "contact": "Prénom NOM" | null, "confiance": 0..100, "raison": "courte" }\n\n' +
    "Mails (du plus récent au plus ancien) :\n\n";

  bodies.forEach(function (b, i) {
    prompt += "===== Mail " + (i + 1) + " =====\n" + b + "\n\n";
  });

  var body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      maxOutputTokens: 256,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  var resp = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() >= 300) {
    throw new Error("Gemini HTTP " + resp.getResponseCode() + ": " + resp.getContentText().substring(0, 200));
  }
  var data = JSON.parse(resp.getContentText());
  var raw = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
  if (!raw) return null;
  var cleaned = raw.replace(/^\s*```(?:json)?\s*\n?/i, "").replace(/\n?\s*```\s*$/i, "").trim();
  var parsed;
  try { parsed = JSON.parse(cleaned); } catch (e) { return null; }
  if (!parsed || !parsed.contact) return null;
  // Garde-fou : si confiance < 80, on jette
  if (typeof parsed.confiance === "number" && parsed.confiance < 80) return null;
  var name = String(parsed.contact).trim();
  // Filtres anti-faux-positifs basiques
  if (name.length < 2 || name.length > 60) return null;
  if (/^[\d\W]+$/.test(name)) return null;
  return name;
}
