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
  "effectifDetected", "nbVelosBefore", "nbVelosAfter",
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
        return _respond(inboxSync());
      case "debug":
        return _respond(debugInbox());
      case "progress":
        return _respond(syncProgress());
      case "relabel":
        return _respond(relabelUnprocessed());
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
function syncProgress() {
  var queryRemaining = "has:attachment newer_than:7d -label:" + LABEL_PROCESSED + " -label:" + LABEL_FAILED;
  var queryProcessed = "has:attachment newer_than:7d label:" + LABEL_PROCESSED;
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
    remaining: remaining.length,
    processed: processed.length,
    oldestRemaining: oldestRemainingDate ? oldestRemainingDate.toISOString() : null,
    newestRemaining: newestRemainingDate ? newestRemainingDate.toISOString() : null
  };
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
  var stats = { threads: 0, messages: 0, processed: 0, matched: 0, unassigned: 0, errors: 0, details: [] };

  var labelTo  = _getOrCreateLabel(LABEL_TO_PROCESS);
  var labelOk  = _getOrCreateLabel(LABEL_PROCESSED);
  var labelKo  = _getOrCreateLabel(LABEL_FAILED);

  // Recherche : soit par label, soit fallback global "has:attachment newer_than:7d" non traités
  var useLabelFilter = labelTo.getThreads(0, 1).length > 0;
  var query = useLabelFilter
    ? "label:" + LABEL_TO_PROCESS + " -label:" + LABEL_PROCESSED + " -label:" + LABEL_FAILED
    : "has:attachment newer_than:7d -label:" + LABEL_PROCESSED + " -label:" + LABEL_FAILED;

  var batchSize = (payload && payload.batchSize) ? Math.min(Number(payload.batchSize), 200) : 50;
  var threads = GmailApp.search(query, 0, batchSize);
  stats.threads = threads.length;

  var crmCtx = _loadCrmContext();

  for (var t = 0; t < threads.length; t++) {
    var thread = threads[t];
    var messages = thread.getMessages();
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      stats.messages++;
      // Skip si déjà traité (label au niveau message impossible en GAS : on skippe à la thread)
      try {
        var r = _processMessage(msg, crmCtx);
        if (r.matched) stats.matched++; else stats.unassigned++;
        stats.processed++;
        stats.details.push(r);
      } catch (err) {
        stats.errors++;
        stats.details.push({ messageId: msg.getId(), error: String(err) });
      }
    }
    // Label thread comme traitée (on ne retraite pas)
    try { thread.addLabel(labelOk); } catch (e) {}
  }

  return {
    status: "ok",
    elapsedMs: new Date() - started,
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

  // Écrit la ligne dans VerificationsPending
  _addVerification({
    clientId: matched ? matched.id : "",
    entreprise: matched ? matched.entreprise : (gemini && gemini.clientName) || "",
    docType: gemini && gemini.docType || "",
    driveUrl: result.attachments.map(function (a) { return a.url || ""; }).filter(Boolean).join(" ||| "),
    fileName: result.attachments.map(function (a) { return a.name; }).join(", "),
    fromEmail: fromEmail,
    subject: msg.getSubject(),
    effectifDetected: gemini && gemini.effectif != null ? gemini.effectif : "",
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
      '  "docType": "DEVIS"|"KBIS"|"LIASSE"|"URSSAF"|"ATTESTATION"|"SIGNATURE"|"BICYCLE"|"PARCELLE"|"AUTRE"|null,\n' +
      '  "effectif": number|null (effectif moyen mensuel si DSN/URSSAF/liasse/registre du personnel),\n' +
      '  "effectifPresent": true|false|null (true si un nombre d\'effectifs/salaries est visible dans le document),\n' +
      '  "kbisDate": "YYYY-MM-DD"|null (date de l\'extrait Kbis/RNE "a jour au..." visible sur le document),\n' +
      '  "devisDate": "YYYY-MM-DD"|null (date du devis si document est un devis signe),\n' +
      '  "notes": string (1 phrase de contexte)\n' +
      "}\n\n" +
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
