var SS = SpreadsheetApp.getActiveSpreadsheet();

function doGet(e) {
  return handleRequest(e);
}

function doPost(e) {
  return handleRequest(e);
}

function handleRequest(e) {
  var action = (e.parameter && e.parameter.action) || "";
  var result;

  function getBody() {
    if (e.postData && e.postData.contents) return JSON.parse(e.postData.contents);
    if (e.parameter && e.parameter.body) return JSON.parse(decodeURIComponent(e.parameter.body));
    return {};
  }

  try {
    switch (action) {
      case "getClients":
        result = getClients(e.parameter);
        break;
      case "getClient":
        result = getClient(e.parameter.id);
        break;
      case "updateClient":
        var bodyUC = getBody();
        result = updateClient(bodyUC.id || e.parameter.id, bodyUC.data || bodyUC);
        break;
      case "bulkUpdateClients":
        var bodyBU = getBody();
        result = bulkUpdateClients(bodyBU.clientIds || [], bodyBU.data || {});
        break;
      case "getStats":
        result = getStats();
        break;
      case "getCarte":
        result = getCarte();
        break;
      case "suggestTournee":
        var bodyST = getBody();
        result = suggestTournee(bodyST.clientId, bodyST.mode, bodyST.maxDistance);
        break;
      case "getLivraisons":
        result = getLivraisons();
        break;
      case "createLivraison":
        var bodyCL = getBody();
        result = createLivraison(bodyCL);
        break;
      case "createTournee":
        result = createTournee(getBody());
        break;
      case "createTournees":
        result = createTournees(getBody());
        break;
      case "updateLivraison":
        var bodyUL = getBody();
        result = updateLivraison(bodyUL.id || e.parameter.id, bodyUL.data || bodyUL);
        break;
      case "deleteLivraison":
        result = deleteLivraison(e.parameter.id);
        break;
      case "restoreLivraison":
        result = restoreLivraison(e.parameter.id);
        break;
      case "updateVelos":
        var bodyUV = getBody();
        result = updateVelos(bodyUV);
        break;
      case "uploadDoc":
        var bodyUD = getBody();
        result = uploadDoc(bodyUD);
        break;
      case "syncDrive":
        result = syncDriveDocs();
        break;
      case "classifyBatch":
        result = classifyBatch(parseInt(e.parameter.limit || "20", 10));
        break;
      case "classifyStatus":
        result = classifyStatus();
        break;
      case "testGemini":
        result = testGemini();
        break;
      case "fetchParcelle":
        result = fetchParcelle(e.parameter.id);
        break;
      case "autoFetchParcelles":
        result = autoFetchParcelles(parseInt(e.parameter.limit || "50", 10));
        break;
      case "cancelTournee":
        result = cancelTournee(e.parameter.tourneeId);
        break;
      case "setClientVelosTarget":
        var bodyST2 = getBody();
        result = setClientVelosTarget(bodyST2.clientId || e.parameter.clientId, Number(bodyST2.target != null ? bodyST2.target : e.parameter.target));
        break;
      case "listVerifications":
        result = listVerifications(e.parameter);
        break;
      case "validateVerification":
        result = validateVerification(e.parameter.id);
        break;
      case "rejectVerification":
        var bodyRV = getBody();
        result = rejectVerification(bodyRV.id || e.parameter.id, bodyRV.revertNbVelos === true || e.parameter.revertNbVelos === "true", bodyRV.notes || "");
        break;
      case "countPendingVerifications":
        result = countPendingVerifications();
        break;
      case "bulkAutoValidate":
        var bodyBAV = getBody();
        result = bulkAutoValidate({ dryRun: bodyBAV.dryRun != null ? bodyBAV.dryRun : e.parameter.dryRun });
        break;
      case "listEquipe":
        result = listEquipe(e.parameter);
        break;
      case "upsertMembre":
        result = upsertMembre(getBody());
        break;
      case "archiveMembre":
        result = archiveMembre(e.parameter.id);
        break;
      case "assignTournee":
        var bodyAT = getBody();
        result = assignTournee(bodyAT.tourneeId || e.parameter.tourneeId, {
          chauffeurId: bodyAT.chauffeurId,
          chefEquipeId: bodyAT.chefEquipeId,
          chefEquipeIds: bodyAT.chefEquipeIds,
          monteurIds: bodyAT.monteurIds,
          nbMonteurs: bodyAT.nbMonteurs
        });
        break;
      case "getTourneeExecution":
        result = getTourneeExecution(e.parameter.tourneeId);
        break;
      case "setVeloFnuci":
        var bodyVF = getBody();
        result = setVeloFnuci(bodyVF.veloId || e.parameter.veloId, bodyVF.fnuci || e.parameter.fnuci);
        break;
      case "assignFnuciToClient":
        var bodyAFC = getBody();
        result = assignFnuciToClient(bodyAFC.fnuci || e.parameter.fnuci, bodyAFC.clientId || e.parameter.clientId);
        break;
      case "lookupFnuci":
        result = lookupFnuci(e.parameter.fnuci);
        break;
      case "getClientPreparation":
        result = getClientPreparation(e.parameter.clientId);
        break;
      case "uploadVeloPhoto":
        var bodyUVP = getBody();
        result = uploadVeloPhoto(bodyUVP);
        break;
      case "markVeloLivre":
        var bodyMVL = getBody();
        result = markVeloLivre(bodyMVL);
        break;
      case "listFlotte":
        result = listFlotte(e.parameter);
        break;
      case "upsertCamion":
        result = upsertCamion(getBody());
        break;
      case "archiveCamion":
        result = archiveCamion(e.parameter.id);
        break;
      case "listDisponibilites":
        result = listDisponibilites(e.parameter);
        break;
      case "setDisponibilites":
        result = setDisponibilites(getBody());
        break;
      case "proposeTournee":
        var bodyPT = getBody();
        result = proposeTournee({
          date: bodyPT.date || e.parameter.date,
          mode: bodyPT.mode || e.parameter.mode || "fillGaps"
        });
        break;
      default:
        result = { error: "Action inconnue: " + action };
    }
  } catch (err) {
    result = { error: err.message };
  }

  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---- CLIENTS ----

function ensureClientsColumns() {
  var sheet = SS.getSheetByName("Clients");
  if (!sheet) return;
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var needed = ["parcelleCadastrale", "parcelleCadastraleLien", "kbisDate", "dateEngagement", "liasseFiscaleDate", "effectifMentionne"];
  for (var k = 0; k < needed.length; k++) {
    if (headers.indexOf(needed[k]) === -1) {
      lastCol++;
      sheet.getRange(1, lastCol).setValue(needed[k]);
    }
  }
}

function getClients(params) {
  ensureClientsColumns();
  var sheet = SS.getSheetByName("Clients");
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var rows = data.slice(1);

  var velosSheet = SS.getSheetByName("Velos");
  var velosData = velosSheet.getDataRange().getValues();
  var velosHeaders = velosData[0];
  var velosRows = velosData.slice(1);

  var search = (params && params.search) ? params.search.toLowerCase() : "";
  var filter = (params && params.filter) ? params.filter : "all";
  var planifiesByClient = computePlanifiesByClient();

  var clients = rows.map(function(row) {
    var c = {};
    headers.forEach(function(h, i) { c[h] = row[i]; });
    ["devisSignee","kbisRecu","attestationRecue","signatureOk","inscriptionBicycle","parcelleCadastrale","effectifMentionne"
    ].forEach(function(f) {
      c[f] = c[f] === true || c[f] === "TRUE";
    });
    ["kbisDate","dateEngagement","liasseFiscaleDate"].forEach(function(f) {
      if (c[f] instanceof Date) {
        c[f] = Utilities.formatDate(c[f], Session.getScriptTimeZone(), "yyyy-MM-dd");
      } else if (c[f]) {
        c[f] = String(c[f]);
      } else {
        c[f] = null;
      }
    });

    var iAnnule = velosHeaders.indexOf("annule");
    var clientVelos = velosRows.filter(function(v) {
      if (v[velosHeaders.indexOf("clientId")] !== c.id) return false;
      if (iAnnule >= 0 && (v[iAnnule] === true || v[iAnnule] === "TRUE")) return false;
      return true;
    });

    c.stats = {
      totalVelos: clientVelos.length,
      livres: clientVelos.filter(function(v) { return v[velosHeaders.indexOf("photoQrPrise")] === true || v[velosHeaders.indexOf("photoQrPrise")] === "TRUE"; }).length,
      certificats: clientVelos.filter(function(v) { return v[velosHeaders.indexOf("certificatRecu")] === true || v[velosHeaders.indexOf("certificatRecu")] === "TRUE"; }).length,
      facturables: clientVelos.filter(function(v) { return v[velosHeaders.indexOf("facturable")] === true || v[velosHeaders.indexOf("facturable")] === "TRUE"; }).length,
      factures: clientVelos.filter(function(v) { return v[velosHeaders.indexOf("facture")] === true || v[velosHeaders.indexOf("facture")] === "TRUE"; }).length,
      planifies: planifiesByClient[c.id] || 0,
    };

    return c;
  });

  if (search) {
    clients = clients.filter(function(c) {
      return (c.entreprise || "").toLowerCase().indexOf(search) > -1 ||
             (c.contact || "").toLowerCase().indexOf(search) > -1 ||
             (c.ville || "").toLowerCase().indexOf(search) > -1;
    });
  }

  if (filter === "docs_manquants") {
    clients = clients.filter(function(c) { return !c.kbisRecu || !c.attestationRecue || !c.signatureOk; });
  } else if (filter === "prets") {
    clients = clients.filter(function(c) { return c.kbisRecu && c.attestationRecue && c.signatureOk; });
  }

  clients.sort(function(a, b) { return (a.entreprise || "").localeCompare(b.entreprise || ""); });

  return clients;
}

function getClient(id) {
  var sheet = SS.getSheetByName("Clients");
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var rows = data.slice(1);

  var rowIdx = -1;
  var client = null;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i][0] === id) {
      rowIdx = i;
      client = {};
      headers.forEach(function(h, j) { client[h] = rows[i][j]; });
      break;
    }
  }

  if (!client) return { error: "Client non trouvé" };

  ["devisSignee","kbisRecu","attestationRecue","signatureOk","inscriptionBicycle","parcelleCadastrale","effectifMentionne"
  ].forEach(function(f) {
    client[f] = client[f] === true || client[f] === "TRUE";
  });
  ["kbisDate","dateEngagement","liasseFiscaleDate"].forEach(function(f) {
    if (client[f] instanceof Date) {
      client[f] = Utilities.formatDate(client[f], Session.getScriptTimeZone(), "yyyy-MM-dd");
    } else if (client[f]) {
      client[f] = String(client[f]);
    } else {
      client[f] = null;
    }
  });

  var velosSheet = SS.getSheetByName("Velos");
  var velosData = velosSheet.getDataRange().getValues();
  var velosHeaders = velosData[0];
  var velosRows = velosData.slice(1);

  var iAnnuleGV = velosHeaders.indexOf("annule");
  client.velos = velosRows
    .filter(function(v) {
      if (v[velosHeaders.indexOf("clientId")] !== id) return false;
      if (iAnnuleGV >= 0 && (v[iAnnuleGV] === true || v[iAnnuleGV] === "TRUE")) return false;
      return true;
    })
    .map(function(v) {
      var velo = {};
      velosHeaders.forEach(function(h, j) { velo[h] = v[j]; });
      ["certificatRecu","photoQrPrise","facturable","facture"].forEach(function(f) {
        velo[f] = velo[f] === true || velo[f] === "TRUE";
      });
      velo.livraison = null;
      return velo;
    });

  return client;
}

function updateClient(id, data) {
  var sheet = SS.getSheetByName("Clients");
  var all = sheet.getDataRange().getValues();
  var headers = all[0];

  for (var i = 1; i < all.length; i++) {
    if (all[i][0] === id) {
      for (var key in data) {
        var col = headers.indexOf(key);
        if (col > -1) {
          var val = data[key];
          if (typeof val === "boolean") val = val ? "TRUE" : "FALSE";
          sheet.getRange(i + 1, col + 1).setValue(val);
        }
      }
      return { ok: true };
    }
  }
  return { error: "Client non trouvé" };
}

// Met à jour le même set de champs sur plusieurs clients d'un coup.
// data : { devisSignee: true, kbisRecu: false, ... } — booléens écrits comme "TRUE"/"FALSE".
// Optimisé : setValues batch par colonne (1 call par colonne) au lieu de N×M setValue,
// pour éviter les timeouts sur de gros lots (>100 clients).
function bulkUpdateClients(clientIds, data) {
  if (!clientIds || clientIds.length === 0) return { error: "Aucun client sélectionné" };
  if (!data || Object.keys(data).length === 0) return { error: "Aucun champ à mettre à jour" };

  var sheet = SS.getSheetByName("Clients");
  var all = sheet.getDataRange().getValues();
  var headers = all[0];
  var nbRows = all.length - 1;
  if (nbRows <= 0) return { ok: true, updated: 0 };

  var keysWithCol = [];
  var keys = Object.keys(data);
  for (var k = 0; k < keys.length; k++) {
    var col = headers.indexOf(keys[k]);
    if (col === -1) continue;
    var v = data[keys[k]];
    if (typeof v === "boolean") v = v ? "TRUE" : "FALSE";
    keysWithCol.push({ key: keys[k], col: col, val: v });
  }
  if (keysWithCol.length === 0) return { error: "Aucune colonne valide" };

  var ids = {};
  for (var x = 0; x < clientIds.length; x++) ids[clientIds[x]] = true;

  // Pour chaque colonne ciblée, on lit toute la colonne, on patch les lignes, on réécrit en bloc.
  var updated = 0;
  for (var p = 0; p < keysWithCol.length; p++) {
    var c2 = keysWithCol[p].col;
    var val = keysWithCol[p].val;
    var rng = sheet.getRange(2, c2 + 1, nbRows, 1);
    var values = rng.getValues();
    var changedThisCol = 0;
    for (var i = 0; i < nbRows; i++) {
      if (ids[all[i + 1][0]]) {
        values[i][0] = val;
        changedThisCol++;
      }
    }
    if (changedThisCol > 0) rng.setValues(values);
    if (p === 0) updated = changedThisCol;
  }
  SpreadsheetApp.flush();
  return { ok: true, updated: updated };
}

// ---- VELOS ----

function updateVelos(body) {
  var velosSheet = SS.getSheetByName("Velos");
  var all = velosSheet.getDataRange().getValues();
  var headers = all[0];

  if (body.bulkAction && body.veloIds) {
    var field = "";
    if (body.bulkAction === "marquer_certificat") field = "certificatRecu";
    else if (body.bulkAction === "marquer_photo_qr") field = "photoQrPrise";
    else if (body.bulkAction === "marquer_facturable") field = "facturable";
    else if (body.bulkAction === "marquer_facture") field = "facture";

    if (field) {
      var col = headers.indexOf(field);
      for (var i = 1; i < all.length; i++) {
        if (body.veloIds.indexOf(all[i][0]) > -1) {
          velosSheet.getRange(i + 1, col + 1).setValue("TRUE");
        }
      }
    }
    return { ok: true };
  }

  return { error: "Action invalide" };
}

// ---- STATS ----

function getStats() {
  var clientsSheet = SS.getSheetByName("Clients");
  var cData = clientsSheet.getDataRange().getValues();
  var cHeaders = cData[0];
  var cRows = cData.slice(1);

  var velosSheet = SS.getSheetByName("Velos");
  var vData = velosSheet.getDataRange().getValues();
  var vHeaders = vData[0];
  var vRows = vData.slice(1);

  var totalClients = cRows.length;
  var isBoolTmp = function(val) { return val === true || val === "TRUE"; };
  var iAnnuleStats = vHeaders.indexOf("annule");
  var vRowsActive = iAnnuleStats >= 0 ? vRows.filter(function(v) { return !isBoolTmp(v[iAnnuleStats]); }) : vRows;
  var totalVelos = vRowsActive.length;

  var isBool = isBoolTmp;

  var velosLivres = vRowsActive.filter(function(v) { return isBool(v[vHeaders.indexOf("photoQrPrise")]); }).length;
  var certificatsRecus = vRowsActive.filter(function(v) { return isBool(v[vHeaders.indexOf("certificatRecu")]); }).length;
  var velosFacturables = vRowsActive.filter(function(v) { return isBool(v[vHeaders.indexOf("facturable")]); }).length;
  var velosFactures = vRowsActive.filter(function(v) { return isBool(v[vHeaders.indexOf("facture")]); }).length;

  var docFields = ["devisSignee","kbisRecu","attestationRecue","signatureOk","inscriptionBicycle","parcelleCadastrale"];
  var clientsDocsComplets = cRows.filter(function(c) {
    return docFields.every(function(f) { return isBool(c[cHeaders.indexOf(f)]); });
  }).length;

  var progression = totalVelos > 0 ? Math.round((velosLivres / totalVelos) * 100) : 0;

  // Vélos planifiés = somme des nbVelos des livraisons non livrées et non annulées
  // (déjà dans une tournée du planning, en attente de livraison effective).
  var planifiesByClient = computePlanifiesByClient();
  var velosPlanifies = 0;
  Object.keys(planifiesByClient).forEach(function(cid) {
    velosPlanifies += Number(planifiesByClient[cid]) || 0;
  });

  return {
    totalClients: totalClients,
    totalVelos: totalVelos,
    velosLivres: velosLivres,
    velosPlanifies: velosPlanifies,
    certificatsRecus: certificatsRecus,
    velosFacturables: velosFacturables,
    velosFactures: velosFactures,
    clientsDocsComplets: clientsDocsComplets,
    progression: progression,
    livraisonsParStatut: {}
  };
}

// ---- CARTE ----

function getCarte() {
  var sheet = SS.getSheetByName("Clients");
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var rows = data.slice(1);

  var velosSheet = SS.getSheetByName("Velos");
  var vData = velosSheet.getDataRange().getValues();
  var vHeaders = vData[0];
  var vRows = vData.slice(1);

  var planifiesByClient = computePlanifiesByClient();

  var isBool = function(val) { return val === true || val === "TRUE"; };

  return rows
    .filter(function(r) { return r[headers.indexOf("latitude")] && r[headers.indexOf("longitude")]; })
    .map(function(r) {
      var id = r[headers.indexOf("id")];
      var clientVelos = vRows.filter(function(v) { return v[vHeaders.indexOf("clientId")] === id; });
      return {
        id: id,
        entreprise: r[headers.indexOf("entreprise")],
        contact: r[headers.indexOf("contact")] || null,
        apporteur: r[headers.indexOf("apporteur")] || null,
        ville: r[headers.indexOf("ville")],
        departement: r[headers.indexOf("departement")],
        adresse: r[headers.indexOf("adresse")],
        codePostal: r[headers.indexOf("codePostal")],
        lat: Number(r[headers.indexOf("latitude")]),
        lng: Number(r[headers.indexOf("longitude")]),
        nbVelos: Number(r[headers.indexOf("nbVelosCommandes")]),
        modeLivraison: r[headers.indexOf("modeLivraison")] || "atelier",
        telephone: r[headers.indexOf("telephone")],
        email: r[headers.indexOf("email")],
        docsComplets: isBool(r[headers.indexOf("kbisRecu")]) && isBool(r[headers.indexOf("attestationRecue")]) && isBool(r[headers.indexOf("signatureOk")]) && isBool(r[headers.indexOf("devisSignee")]),
        velosLivres: clientVelos.filter(function(v) { return isBool(v[vHeaders.indexOf("photoQrPrise")]); }).length,
        velosPlanifies: planifiesByClient[id] || 0,
      };
    });
}

// Lit les livraisons non-livrées/non-annulées et somme les vélos planifiés par client.
// Tolérant : si la colonne nbVelos n'existe pas encore, parse les notes ("X vélos").
function computePlanifiesByClient() {
  var livSheet = SS.getSheetByName("Livraisons");
  if (!livSheet) return {};
  var data = livSheet.getDataRange().getValues();
  if (data.length <= 1) return {};
  var headers = data[0];
  var iClientId = headers.indexOf("clientId");
  var iStatut = headers.indexOf("statut");
  var iNbVelos = headers.indexOf("nbVelos");
  var iNotes = headers.indexOf("notes");
  if (iClientId === -1 || iStatut === -1) return {};

  var byClient = {};
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var statut = String(row[iStatut] || "");
    if (statut === "livree" || statut === "annulee") continue;
    var cid = row[iClientId];
    if (!cid) continue;
    var nb = 0;
    if (iNbVelos !== -1) {
      nb = Number(row[iNbVelos]) || 0;
    }
    if (!nb && iNotes !== -1) {
      var notes = String(row[iNotes] || "");
      var m = notes.match(/(\d+)\s+vélos?/);
      if (m) nb = parseInt(m[1], 10);
    }
    byClient[cid] = (byClient[cid] || 0) + nb;
  }
  return byClient;
}

// Garantit que la feuille Livraisons a les colonnes nbVelos, tourneeId, mode, ordre.
// Backfill en parsant les notes existantes pour récupérer "X vélos" et "[xxxxxxxx]".
// Renvoie l'objet { sheet, headers } à jour.
function ensureLivraisonsSchema() {
  var sheet = SS.getSheetByName("Livraisons");
  if (!sheet) {
    sheet = SS.insertSheet("Livraisons");
    var initialCols = [
      "id","clientId","datePrevue","dateEffective","statut","notes",
      "nbVelos","tourneeId","mode","chauffeurId","chefEquipeId","monteurIds","nbMonteurs","chefEquipeIds"
    ];
    sheet.getRange(1, 1, 1, initialCols.length).setValues([initialCols]);
    return { sheet: sheet, headers: initialCols };
  }

  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var needed = ["nbVelos","tourneeId","mode","chauffeurId","chefEquipeId","monteurIds","nbMonteurs","chefEquipeIds"];
  var added = false;
  for (var k = 0; k < needed.length; k++) {
    if (headers.indexOf(needed[k]) === -1) {
      lastCol++;
      sheet.getRange(1, lastCol).setValue(needed[k]);
      headers.push(needed[k]);
      added = true;
    }
  }

  if (added) {
    var iNotes = headers.indexOf("notes");
    var iNbVelos = headers.indexOf("nbVelos");
    var iTourneeId = headers.indexOf("tourneeId");
    var iMode = headers.indexOf("mode");
    var lastRow = sheet.getLastRow();
    if (lastRow >= 2 && iNotes !== -1) {
      var range = sheet.getRange(2, 1, lastRow - 1, headers.length);
      var values = range.getValues();
      for (var i = 0; i < values.length; i++) {
        var notes = String(values[i][iNotes] || "");
        if (iNbVelos !== -1 && !values[i][iNbVelos]) {
          var mNb = notes.match(/(\d+)\s+vélos?/);
          if (mNb) values[i][iNbVelos] = parseInt(mNb[1], 10);
        }
        if (iTourneeId !== -1 && !values[i][iTourneeId]) {
          var mTid = notes.match(/\[([a-f0-9]{8})\]/);
          if (mTid) values[i][iTourneeId] = mTid[1];
        }
        if (iMode !== -1 && !values[i][iMode]) {
          if (/—\s*atelier\b/.test(notes)) values[i][iMode] = "atelier";
          else if (/—\s*sur site\b/.test(notes)) values[i][iMode] = "sursite";
        }
      }
      range.setValues(values);
    }
  }

  return { sheet: sheet, headers: headers };
}

function suggestTournee(clientId, mode, maxDistance) {
  var points = getCarte();
  var target = null;
  for (var i = 0; i < points.length; i++) {
    if (points[i].id === clientId) { target = points[i]; break; }
  }
  if (!target) return { error: "Client non trouvé" };

  var capacites = { gros: 132, moyen: 54, camionnette: 20, retrait: 9999 };
  var capacite = capacites[mode] || 54;
  maxDistance = maxDistance || 50;

  var velosTarget = target.nbVelos - target.velosLivres - (target.velosPlanifies || 0);
  if (velosTarget <= 0) {
    return { error: "Aucun vélo à planifier pour ce client (tout livré ou déjà planifié)." };
  }

  if (mode === "retrait") {
    var retStops = [{ id: target.id, entreprise: target.entreprise, ville: target.ville, lat: target.lat, lng: target.lng, nbVelos: velosTarget, distance: 0 }];
    return {
      mode: "retrait", capacite: velosTarget, nbCamions: 1, velosClient: velosTarget,
      splits: [{ stops: retStops, totalVelos: velosTarget, capacite: velosTarget, indexCamion: 1, nbCamionsTotal: 1 }],
      tournee: retStops, totalVelos: velosTarget, clientsProches: []
    };
  }

  var nearby = points
    .filter(function(c) { return c.id !== clientId; })
    .map(function(c) {
      c.distance = haversineKm(target.lat, target.lng, c.lat, c.lng);
      c.velosRestants = c.nbVelos - c.velosLivres - (c.velosPlanifies || 0);
      return c;
    })
    .filter(function(c) { return c.distance <= maxDistance && c.velosRestants > 0; })
    .sort(function(a, b) { return a.distance - b.distance; });

  // On découpe les vélos du client cible en N camions (compact : chaque camion plein avant le suivant).
  var nbCamions = Math.ceil(velosTarget / capacite);
  var splits = [];
  var velosACassign = velosTarget;

  for (var k = 0; k < nbCamions; k++) {
    var velosCeCamion = Math.min(velosACassign, capacite);
    var stops = [{
      id: target.id,
      entreprise: target.entreprise,
      ville: target.ville,
      lat: target.lat,
      lng: target.lng,
      nbVelos: velosCeCamion,
      distance: 0
    }];

    var resteCamion = capacite - velosCeCamion;
    for (var j = 0; j < nearby.length && resteCamion > 0; j++) {
      var c = nearby[j];
      if (c.velosRestants <= 0) continue;
      var nb = Math.min(c.velosRestants, resteCamion);
      stops.push({
        id: c.id,
        entreprise: c.entreprise,
        ville: c.ville,
        lat: c.lat,
        lng: c.lng,
        nbVelos: nb,
        distance: Math.round(c.distance * 10) / 10
      });
      c.velosRestants -= nb; // évite de surbooker entre camions du même split
      resteCamion -= nb;
    }

    splits.push({
      stops: stops,
      totalVelos: stops.reduce(function(s, t) { return s + t.nbVelos; }, 0),
      capacite: capacite,
      indexCamion: k + 1,
      nbCamionsTotal: nbCamions
    });
    velosACassign -= velosCeCamion;
  }

  return {
    mode: mode,
    capacite: capacite,
    nbCamions: nbCamions,
    velosClient: velosTarget,
    splits: splits,
    // compat ascendante : 1ère tournée à plat
    tournee: splits[0].stops,
    totalVelos: splits[0].totalVelos,
    clientsProches: nearby.slice(0, 20).map(function(c) {
      return {
        id: c.id, entreprise: c.entreprise, ville: c.ville,
        lat: c.lat, lng: c.lng,
        distance: Math.round(c.distance * 10) / 10,
        velosRestants: c.velosRestants
      };
    })
  };
}

function haversineKm(lat1, lng1, lat2, lng2) {
  var R = 6371;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLng = (lng2 - lng1) * Math.PI / 180;
  var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
          Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
          Math.sin(dLng/2) * Math.sin(dLng/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---- LIVRAISONS ----

function getLivraisons() {
  var ctx = ensureLivraisonsSchema();
  var sheet = ctx.sheet;
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  var headers = data[0];
  var rows = data.slice(1);

  var clientsSheet = SS.getSheetByName("Clients");
  var cData = clientsSheet.getDataRange().getValues();
  var cHeaders = cData[0];

  return rows.map(function(r) {
    var liv = {};
    headers.forEach(function(h, i) { liv[h] = r[i]; });
    var clientRow = cData.find(function(c) { return c[0] === liv.clientId; });
    liv.client = clientRow ? {
      entreprise: clientRow[cHeaders.indexOf("entreprise")],
      ville: clientRow[cHeaders.indexOf("ville")],
      adresse: clientRow[cHeaders.indexOf("adresse")],
      codePostal: clientRow[cHeaders.indexOf("codePostal")],
      departement: clientRow[cHeaders.indexOf("departement")],
      telephone: clientRow[cHeaders.indexOf("telephone")] || null,
      lat: Number(clientRow[cHeaders.indexOf("latitude")]) || null,
      lng: Number(clientRow[cHeaders.indexOf("longitude")]) || null
    } : { entreprise: "?", ville: "", adresse: "", telephone: null, lat: null, lng: null };
    var nbVelos = Number(liv.nbVelos) || 0;
    if (!nbVelos && liv.notes) {
      var m = String(liv.notes).match(/(\d+)\s+vélos?/);
      if (m) nbVelos = parseInt(m[1], 10);
    }
    liv._count = { velos: nbVelos };
    // Parse monteurIds (stocké comme JSON string)
    if (typeof liv.monteurIds === "string" && liv.monteurIds) {
      try { liv.monteurIds = JSON.parse(liv.monteurIds); }
      catch (e) { liv.monteurIds = []; }
    } else if (!liv.monteurIds) {
      liv.monteurIds = [];
    }
    liv.chauffeurId = liv.chauffeurId || null;
    liv.chefEquipeId = liv.chefEquipeId || null;
    if (typeof liv.chefEquipeIds === "string" && liv.chefEquipeIds) {
      try { liv.chefEquipeIds = JSON.parse(liv.chefEquipeIds); }
      catch (e) { liv.chefEquipeIds = []; }
    } else if (!liv.chefEquipeIds) {
      liv.chefEquipeIds = [];
    }
    liv.nbMonteurs = Number(liv.nbMonteurs) || 0;
    return liv;
  });
}

function createLivraison(body) {
  var ctx = ensureLivraisonsSchema();
  var sheet = ctx.sheet;
  var headers = ctx.headers;

  var id = Utilities.getUuid();
  var row = new Array(headers.length).fill("");
  row[headers.indexOf("id")] = id;
  row[headers.indexOf("clientId")] = body.clientId;
  row[headers.indexOf("datePrevue")] = body.datePrevue || "";
  row[headers.indexOf("dateEffective")] = "";
  row[headers.indexOf("statut")] = "planifiee";
  row[headers.indexOf("notes")] = body.notes || "";
  if (headers.indexOf("nbVelos") !== -1) row[headers.indexOf("nbVelos")] = body.nbVelos || 0;
  if (headers.indexOf("tourneeId") !== -1) row[headers.indexOf("tourneeId")] = body.tourneeId || "";
  if (headers.indexOf("mode") !== -1) row[headers.indexOf("mode")] = body.mode || "";
  sheet.appendRow(row);
  return { id: id };
}

// Crée 1 tournée (= N livraisons, une par arrêt, partageant le même tourneeId/datePrevue).
function createTournee(body) {
  var ctx = ensureLivraisonsSchema();
  var sheet = ctx.sheet;
  var headers = ctx.headers;

  var stops = body.stops || [];
  if (stops.length === 0) return { error: "Aucun arrêt" };

  var tourneeId = body.tourneeId || Utilities.getUuid().slice(0, 8);
  var total = stops.length;
  var date = body.datePrevue || "";
  var mode = body.mode || "";
  var userNotes = (body.notes || "").trim();

  var iId = headers.indexOf("id");
  var iClientId = headers.indexOf("clientId");
  var iDatePrevue = headers.indexOf("datePrevue");
  var iDateEff = headers.indexOf("dateEffective");
  var iStatut = headers.indexOf("statut");
  var iNotes = headers.indexOf("notes");
  var iNbVelos = headers.indexOf("nbVelos");
  var iTourneeId = headers.indexOf("tourneeId");
  var iMode = headers.indexOf("mode");

  var rows = stops.map(function(s, i) {
    var ordre = s.ordre || (i + 1);
    var nbVelos = s.nbVelos || 0;
    var pieces = [
      "Tournée " + date,
      "arrêt " + ordre + "/" + total,
      nbVelos + " vélo" + (nbVelos > 1 ? "s" : "")
    ];
    if (mode) pieces.push(mode === "atelier" ? "atelier" : "sur site");
    if (userNotes) pieces.push(userNotes);
    pieces.push("[" + tourneeId + "]");
    var row = new Array(headers.length).fill("");
    row[iId] = Utilities.getUuid();
    row[iClientId] = s.clientId;
    row[iDatePrevue] = date;
    row[iDateEff] = "";
    row[iStatut] = "planifiee";
    row[iNotes] = pieces.join(" — ");
    if (iNbVelos !== -1) row[iNbVelos] = nbVelos;
    if (iTourneeId !== -1) row[iTourneeId] = tourneeId;
    if (iMode !== -1) row[iMode] = mode;
    return row;
  });

  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  SpreadsheetApp.flush();

  return { tourneeId: tourneeId, created: rows.length, datePrevue: date };
}

// Planifie en bloc N tournées (cas multi-camions). Chaque entrée de body.tournees doit avoir
// { datePrevue, mode?, notes?, stops: [...] }. Renvoie la liste des résultats individuels.
function createTournees(body) {
  var tournees = body.tournees || [];
  if (tournees.length === 0) return { error: "Aucune tournée" };

  var globalNotes = (body.notes || "").trim();
  var mode = body.mode || "";
  var results = [];
  for (var i = 0; i < tournees.length; i++) {
    var t = tournees[i];
    var r = createTournee({
      stops: t.stops,
      datePrevue: t.datePrevue || "",
      mode: t.mode || mode,
      notes: t.notes || globalNotes
    });
    results.push(r);
  }
  return { tournees: results, count: results.length };
}

function updateLivraison(id, data) {
  var sheet = SS.getSheetByName("Livraisons");
  if (!sheet) return { error: "Pas de feuille Livraisons" };
  var all = sheet.getDataRange().getValues();
  var headers = all[0];
  var iClientId = headers.indexOf("clientId");
  var iNbVelos = headers.indexOf("nbVelos");
  var iStatut = headers.indexOf("statut");

  for (var i = 1; i < all.length; i++) {
    if (all[i][0] === id) {
      var oldStatut = iStatut !== -1 ? all[i][iStatut] : null;
      for (var key in data) {
        var col = headers.indexOf(key);
        if (col > -1) sheet.getRange(i + 1, col + 1).setValue(data[key]);
      }

      // Bonus : si on passe à "livree", marquer N vélos non encore livrés du client.
      // Si on revient depuis "livree" vers autre chose, on démarque (best effort).
      var newStatut = data.statut;
      if (iClientId !== -1 && iNbVelos !== -1 && newStatut && newStatut !== oldStatut) {
        var clientId = all[i][iClientId];
        var nbVelos = Number(all[i][iNbVelos]) || 0;
        if (clientId && nbVelos > 0) {
          if (newStatut === "livree" && oldStatut !== "livree") {
            markVelosLivres(clientId, nbVelos);
          } else if (oldStatut === "livree" && newStatut !== "livree") {
            unmarkVelosLivres(clientId, nbVelos);
          }
        }
      }

      return { ok: true };
    }
  }
  return { error: "Livraison non trouvée" };
}

// Marque N vélos non livrés d'un client comme livrés (photoQrPrise = TRUE).
function markVelosLivres(clientId, n) {
  var velosSheet = SS.getSheetByName("Velos");
  if (!velosSheet) return 0;
  var data = velosSheet.getDataRange().getValues();
  var headers = data[0];
  var iClientId = headers.indexOf("clientId");
  var iPhoto = headers.indexOf("photoQrPrise");
  if (iClientId === -1 || iPhoto === -1) return 0;

  var marked = 0;
  for (var i = 1; i < data.length && marked < n; i++) {
    if (data[i][iClientId] !== clientId) continue;
    var v = data[i][iPhoto];
    if (v === true || v === "TRUE") continue;
    velosSheet.getRange(i + 1, iPhoto + 1).setValue("TRUE");
    marked++;
  }
  return marked;
}

// Démarque les N derniers vélos livrés d'un client (best effort sur rollback).
function unmarkVelosLivres(clientId, n) {
  var velosSheet = SS.getSheetByName("Velos");
  if (!velosSheet) return 0;
  var data = velosSheet.getDataRange().getValues();
  var headers = data[0];
  var iClientId = headers.indexOf("clientId");
  var iPhoto = headers.indexOf("photoQrPrise");
  if (iClientId === -1 || iPhoto === -1) return 0;

  var unmarked = 0;
  for (var i = data.length - 1; i >= 1 && unmarked < n; i--) {
    if (data[i][iClientId] !== clientId) continue;
    var v = data[i][iPhoto];
    if (!(v === true || v === "TRUE")) continue;
    velosSheet.getRange(i + 1, iPhoto + 1).setValue("FALSE");
    unmarked++;
  }
  return unmarked;
}

// Soft cancel : on ne supprime JAMAIS la ligne, on passe le statut à "annulee".
// Les vélos repartent automatiquement dans "à planifier" via computePlanifiesByClient.
// Si la livraison était "livree", on démarque les vélos (best effort).
function deleteLivraison(id) {
  var sheet = SS.getSheetByName("Livraisons");
  if (!sheet) return { error: "Pas de feuille Livraisons" };
  var all = sheet.getDataRange().getValues();
  var headers = all[0];
  var iStatut = headers.indexOf("statut");
  var iDateEff = headers.indexOf("dateEffective");
  var iClientId = headers.indexOf("clientId");
  var iNbVelos = headers.indexOf("nbVelos");
  if (iStatut === -1) return { error: "Colonne statut introuvable" };

  for (var i = 1; i < all.length; i++) {
    if (all[i][0] === id) {
      var oldStatut = all[i][iStatut];
      sheet.getRange(i + 1, iStatut + 1).setValue("annulee");
      if (iDateEff !== -1) sheet.getRange(i + 1, iDateEff + 1).setValue("");

      if (oldStatut === "livree" && iClientId !== -1 && iNbVelos !== -1) {
        var nbVelos = Number(all[i][iNbVelos]) || 0;
        if (nbVelos > 0) unmarkVelosLivres(all[i][iClientId], nbVelos);
      }
      return { ok: true, softCancelled: true };
    }
  }
  return { error: "Livraison non trouvée" };
}

// Restaure une livraison annulée en repassant son statut à "planifiee".
function restoreLivraison(id) {
  var sheet = SS.getSheetByName("Livraisons");
  if (!sheet) return { error: "Pas de feuille Livraisons" };
  var all = sheet.getDataRange().getValues();
  var headers = all[0];
  var iStatut = headers.indexOf("statut");
  if (iStatut === -1) return { error: "Colonne statut introuvable" };
  for (var i = 1; i < all.length; i++) {
    if (all[i][0] === id) {
      sheet.getRange(i + 1, iStatut + 1).setValue("planifiee");
      return { ok: true };
    }
  }
  return { error: "Livraison non trouvée" };
}

function cancelTournee(tourneeId) {
  if (!tourneeId) return { error: "tourneeId manquant" };
  var sheet = SS.getSheetByName("Livraisons");
  if (!sheet) return { error: "Pas de feuille Livraisons" };
  var all = sheet.getDataRange().getValues();
  var headers = all[0];
  var iTournee = headers.indexOf("tourneeId");
  var iStatut = headers.indexOf("statut");
  var iDateEff = headers.indexOf("dateEffective");
  var iClientId = headers.indexOf("clientId");
  var iNbVelos = headers.indexOf("nbVelos");
  if (iTournee === -1 || iStatut === -1) return { error: "Colonnes manquantes" };

  var cancelled = 0;
  var target = String(tourneeId);
  for (var i = 1; i < all.length; i++) {
    if (String(all[i][iTournee]) === target && all[i][iStatut] !== "annulee") {
      var oldStatut = all[i][iStatut];
      sheet.getRange(i + 1, iStatut + 1).setValue("annulee");
      if (iDateEff !== -1) sheet.getRange(i + 1, iDateEff + 1).setValue("");
      if (oldStatut === "livree" && iClientId !== -1 && iNbVelos !== -1) {
        var nb = Number(all[i][iNbVelos]) || 0;
        if (nb > 0) unmarkVelosLivres(all[i][iClientId], nb);
      }
      cancelled++;
    }
  }
  SpreadsheetApp.flush();
  return { ok: true, cancelled: cancelled, tourneeId: target };
}

// ---- UPLOAD DOCUMENTS ----

var DRIVE_PARENT_ID = "1cAycg2vUSZbcj6FqJnpmB_hHYCgCBmSR";

function getOrCreateFolder(parent, name) {
  var folders = parent.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return parent.createFolder(name);
}

function uploadDoc(body) {
  var clientId = body.clientId;
  var docType = body.docType;
  var fileName = body.fileName;
  var base64Data = body.fileData;
  var mimeType = body.mimeType || "application/pdf";

  if (!clientId || !docType || !base64Data) {
    return { error: "Paramètres manquants" };
  }

  var sheet = SS.getSheetByName("Clients");
  var all = sheet.getDataRange().getValues();
  var headers = all[0];
  var clientRow = null;
  var clientRowIdx = -1;
  for (var i = 1; i < all.length; i++) {
    if (all[i][0] === clientId) {
      clientRow = all[i];
      clientRowIdx = i;
      break;
    }
  }
  if (!clientRow) return { error: "Client non trouvé" };

  var entreprise = clientRow[headers.indexOf("entreprise")] || "sans-nom";
  var safeName = entreprise.replace(/[^a-zA-Z0-9À-ÿ\s\-]/g, "").substring(0, 50);

  var parentFolder = DriveApp.getFolderById(DRIVE_PARENT_ID);
  var crmFolder = getOrCreateFolder(parentFolder, "DOCS CRM VELOS");
  var clientFolder = getOrCreateFolder(crmFolder, safeName + " [" + clientId.substring(0, 8) + "]");

  var docLabels = {
    devisSignee: "Devis",
    kbisRecu: "Kbis",
    attestationRecue: "Liasse fiscale",
    signatureOk: "Signature",
    inscriptionBicycle: "Bicycle",
    parcelleCadastrale: "Parcelle cadastrale"
  };
  var docLabel = docLabels[docType] || docType;
  var ext = fileName.split(".").pop() || "pdf";
  var fullName = docLabel + " - " + safeName + "." + ext;

  var decoded = Utilities.base64Decode(base64Data);
  var blob = Utilities.newBlob(decoded, mimeType, fullName);
  var file = clientFolder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  var fileUrl = file.getUrl();

  var lienFields = {
    devisSignee: "devisLien",
    kbisRecu: "kbisLien",
    attestationRecue: "attestationLien",
    signatureOk: "signatureLien",
    inscriptionBicycle: "bicycleLien",
    parcelleCadastrale: "parcelleCadastraleLien"
  };

  var lienField = lienFields[docType];
  if (lienField) {
    var col = headers.indexOf(lienField);
    if (col > -1) {
      sheet.getRange(clientRowIdx + 1, col + 1).setValue(fileUrl);
    }
  }

  return { ok: true, url: fileUrl, fileName: fullName };
}

// ---- SYNC DRIVE DOCS ----

var DRIVE_DOSSIER_VELO_ID = "1cAycg2vUSZbcj6FqJnpmB_hHYCgCBmSR";

var DOC_TYPE_TO_FIELDS = {
  DEVIS:              { flag: "devisSignee",        link: "devisLien" },
  KBIS:               { flag: "kbisRecu",           link: "kbisLien" },
  ATTESTATION_URSSAF: { flag: "attestationRecue",   link: "attestationLien" },
  DSN:                { flag: "attestationRecue",   link: "attestationLien" },
  BICYCLE:            { flag: "inscriptionBicycle", link: "bicycleLien" },
  SIGNATURE:          { flag: "signatureOk",        link: "signatureLien" },
  PARCELLE:           { flag: "parcelleCadastrale",  link: "parcelleCadastraleLien" }
};

function normalizeName(s) {
  if (!s) return "";
  return String(s)
    .toUpperCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectDocTypeByName(fileName) {
  var n = normalizeName(fileName);
  if (/\bDEVIS\b/.test(n)) return "DEVIS";
  if (/\b\d*KBIS\b/.test(n) || /\bEXTRAIT\s+KBIS\b/.test(n)) return "KBIS";
  if (/\bDSN\b/.test(n) || /\bDNS\b/.test(n) || /^SALARIES\b/.test(n)) return "DSN";
  if (/\bATT(ESTATION)?\b.*\bURSSAF\b/.test(n) || /^URSSAF\b/.test(n)) return "ATTESTATION_URSSAF";
  if (/\bBICYCLE\b/.test(n)) return "BICYCLE";
  if (/\bPARCELLE\b/.test(n) || /\bCADASTR/.test(n) || /\bGEOPORTAIL\b/.test(n)) return "PARCELLE";
  if (/\bSIGN(ATURE|E)\b/.test(n)) return "SIGNATURE";
  return null;
}

function buildClassifyPrompt() {
  return "Tu classes un document administratif français d'une entreprise dans le cadre d'un dossier CEE vélos cargo. " +
    "Réponds UNIQUEMENT par un seul label parmi : DEVIS, KBIS, ATTESTATION_URSSAF, DSN, BICYCLE, SIGNATURE, PARCELLE, AUTRE. " +
    "Règles : " +
    "- DEVIS = un devis commercial (émis ou signé). " +
    "- KBIS = tout justificatif officiel d'immatriculation : extrait Kbis, RCS, K (EI), avis SIRENE, fiche INSEE, extrait D1, certificat d'immatriculation. " +
    "- ATTESTATION_URSSAF = attestation de vigilance URSSAF ou paiement cotisations. " +
    "- DSN = Déclaration Sociale Nominative (effectif salariés), liasse fiscale, registre du personnel. " +
    "- BICYCLE = document d'inscription à la plateforme Bicycle ou certificat d'identification vélo. " +
    "- SIGNATURE = contrat signé électroniquement. " +
    "- PARCELLE = parcelle cadastrale ou document Géoportail du lieu de livraison. " +
    "- AUTRE = tout le reste. " +
    "Aucun autre texte dans ta réponse.";
}

function classifyWithGemini(file) {
  var apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!apiKey) return { label: null, reason: "noKey" };

  var mimeType;
  try {
    mimeType = file.getMimeType();
  } catch (err) {
    return { label: null, reason: "exception" };
  }
  if (mimeType !== "application/pdf" && mimeType.indexOf("image/") !== 0) {
    return { label: null, reason: "unsupportedMime", mimeType: mimeType };
  }

  var blob;
  try {
    blob = file.getBlob();
  } catch (err) {
    return { label: null, reason: "exception" };
  }
  if (blob.getBytes().length > 18 * 1024 * 1024) {
    return { label: null, reason: "tooBig" };
  }

  var base64 = Utilities.base64Encode(blob.getBytes());
  var prompt = buildClassifyPrompt();

  var payload = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: base64 } }
      ]
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 20, thinkingConfig: { thinkingBudget: 0 } }
  };

  var url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + apiKey;
  // Retry avec backoff exponentiel sur 503 (model overloaded côté Google) et 429
  // (rate limit bursty malgré Tier 1). 3 tentatives max : t+0, t+2s, t+5s.
  var retryDelays = [0, 2000, 5000];
  var lastCode = null;
  var lastBody = "";
  for (var attempt = 0; attempt < retryDelays.length; attempt++) {
    if (retryDelays[attempt] > 0) Utilities.sleep(retryDelays[attempt]);
    try {
      var res = UrlFetchApp.fetch(url, {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      lastCode = res.getResponseCode();
      if (lastCode === 200) {
        var data = JSON.parse(res.getContentText());
        var text = (((data.candidates || [])[0] || {}).content || {}).parts;
        if (!text || !text[0]) return { label: null, reason: "labelOther", rawLabel: "" };
        var label = String(text[0].text || "").trim().toUpperCase().replace(/[^A-Z_]/g, "");
        if (DOC_TYPE_TO_FIELDS[label]) return { label: label, reason: "ok" };
        return { label: null, reason: "labelOther", rawLabel: label };
      }
      lastBody = res.getContentText();
      // Retry uniquement sur codes transitoires Google
      if (lastCode !== 503 && lastCode !== 429 && lastCode !== 500) break;
    } catch (err) {
      Logger.log("classifyWithGemini : exception sur " + file.getName() + " : " + err.message);
      return { label: null, reason: "exception" };
    }
  }
  Logger.log("classifyWithGemini : HTTP " + lastCode + " (après retry) sur " + file.getName() + " : " + lastBody.slice(0, 200));
  return { label: null, reason: "httpError", httpCode: lastCode };
}

// A lancer depuis l'editeur Apps Script pour diagnostiquer pourquoi un fichier
// bascule en AUTRE. Donne fileId (recuperable via l'URL Drive) et lit les logs.
function debugClassifyFile(fileId) {
  var apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!apiKey) { Logger.log("Pas de cle GEMINI_API_KEY"); return; }
  var file = DriveApp.getFileById(fileId);
  var mimeType = file.getMimeType();
  var blob = file.getBlob();
  var bytes = blob.getBytes();
  Logger.log("Fichier : " + file.getName() + " | mime=" + mimeType + " | size=" + bytes.length);
  var base64 = Utilities.base64Encode(bytes);
  var prompt = buildClassifyPrompt();
  Logger.log("Prompt actif : " + prompt.slice(0, 300) + "...");
  var payload = {
    contents: [{ parts: [ { text: prompt }, { inline_data: { mime_type: mimeType, data: base64 } } ] }],
    generationConfig: { temperature: 0, maxOutputTokens: 20, thinkingConfig: { thinkingBudget: 0 } }
  };
  var url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + apiKey;
  var delays = [0, 3000, 7000, 15000, 30000];
  for (var i = 0; i < delays.length; i++) {
    if (delays[i] > 0) { Logger.log("Attente " + (delays[i] / 1000) + "s avant retry..."); Utilities.sleep(delays[i]); }
    var res = UrlFetchApp.fetch(url, {
      method: "post", contentType: "application/json",
      payload: JSON.stringify(payload), muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    Logger.log("Tentative " + (i + 1) + " : HTTP " + code);
    if (code === 200) { Logger.log("Reponse brute : " + res.getContentText()); return; }
    Logger.log("Body : " + res.getContentText().slice(0, 300));
    if (code !== 503 && code !== 429 && code !== 500) return;
  }
  Logger.log("Echec apres 5 tentatives : Gemini sature");
}

function debugClassifyKbis() {
  var it = DriveApp.searchFiles("title contains 'Kbis0001' and trashed = false");
  if (!it.hasNext()) { Logger.log("Aucun fichier 'Kbis0001' trouve dans Drive"); return; }
  var f = it.next();
  Logger.log("Match Drive : " + f.getName() + " (" + f.getId() + ")");
  debugClassifyFile(f.getId());
}

// Cherche le client correspondant à un dossier Drive.
// Tente : (1) match exact, (2) suffixe numérique (ex. "L AFRICA PARIS128" → "L AFRICA PARIS"),
// (3) préfixe le plus long parmi les clients connus (ex. "JG NERGIE CONSULTING 75" matche "JG NERGIE CONSULTING").
// Retourne { match, by: "exact"|"stripDigits"|"prefix" } ou null.
function findClientForFolder(folderKey, clientsByKey, clientsKeysSorted) {
  if (!folderKey) return null;
  if (clientsByKey[folderKey]) return { match: clientsByKey[folderKey], by: "exact" };

  var stripped = folderKey.replace(/\s*\d+$/, "").trim();
  if (stripped !== folderKey && clientsByKey[stripped]) {
    return { match: clientsByKey[stripped], by: "stripDigits" };
  }

  // Préfixe le plus long parmi les clients connus.
  // On exige >= 8 caractères pour éviter des collisions parasites genre "AB" qui matche tout.
  for (var k = 0; k < clientsKeysSorted.length; k++) {
    var ck = clientsKeysSorted[k];
    if (ck.length < 8) continue;
    if (folderKey === ck) return { match: clientsByKey[ck], by: "exact" };
    if (folderKey.indexOf(ck + " ") === 0) return { match: clientsByKey[ck], by: "prefix" };
    if (stripped === ck) return { match: clientsByKey[ck], by: "stripDigits" };
  }
  return null;
}

function syncDriveDocs() {
  var startTime = Date.now();
  var TIMEOUT_MS = 5 * 60 * 1000; // arrêt préventif sur les 6 min max GAS

  var sheet = SS.getSheetByName("Clients");
  var all = sheet.getDataRange().getValues();
  var headers = all[0];
  var iEntreprise = headers.indexOf("entreprise");

  var clientsByKey = {};
  for (var i = 1; i < all.length; i++) {
    var key = normalizeName(all[i][iEntreprise]);
    if (key) clientsByKey[key] = { row: all[i], rowIdx: i };
  }
  // Liste des clés clients triée par longueur décroissante (pour matcher le préfixe le plus long).
  var clientsKeysSorted = Object.keys(clientsByKey).sort(function(a, b) { return b.length - a.length; });

  var root;
  try {
    root = DriveApp.getFolderById(DRIVE_DOSSIER_VELO_ID);
  } catch (err) {
    return { error: "Impossible d'accéder au dossier DOSSIER VELO : " + err.message };
  }

  var report = {
    updates: [],
    orphans: [],
    fuzzyMatched: [],
    ambiguousFolders: [],
    unknowns: [],
    aiClassified: 0,
    filesSeen: 0,
    skippedFiles: [],
    skippedFolders: [],
    timeoutHit: false,
    fatalError: null
  };

  // Pré-passe : on liste tous les sous-dossiers et on compte combien tomberaient sur
  // le même client par fuzzy match. Si plusieurs (ex. 10 « L'AFRICA PARIS128/102/94… »
  // visant le même unique client « L'AFRICA PARIS »), on ne fuzzy-match AUCUN d'eux
  // pour éviter de mélanger les pinceaux entre agences.
  var folderEntries = []; // { folder, folderName, folderKey, matchInfo }
  var fuzzyVotes = {}; // clientRowIdx -> count
  try {
    var subFoldersIter1 = root.getFolders();
    while (subFoldersIter1.hasNext()) {
      if (Date.now() - startTime > TIMEOUT_MS) {
        report.timeoutHit = true;
        break;
      }
      var f, fname, fkey;
      try {
        f = subFoldersIter1.next();
        fname = f.getName();
        fkey = normalizeName(fname);
      } catch (err) {
        Logger.log("syncDriveDocs (pré-passe) : " + err.message);
        report.skippedFolders.push({ folder: "?", error: String(err.message || err) });
        continue;
      }
      var mi = findClientForFolder(fkey, clientsByKey, clientsKeysSorted);
      folderEntries.push({ folder: f, folderName: fname, folderKey: fkey, matchInfo: mi });
      if (mi && mi.by !== "exact") {
        fuzzyVotes[mi.match.rowIdx] = (fuzzyVotes[mi.match.rowIdx] || 0) + 1;
      }
    }
  } catch (err) {
    Logger.log("syncDriveDocs : pré-passe a planté : " + err.message);
    report.fatalError = "Pré-passe Drive : " + err.message;
    return report; // on retourne ce qu'on a, partial > rien
  }

  // Passe 2 : on parcourt les entries, on traite chaque sous-dossier.
  // On wrap toute la boucle pour qu'une exception "Service Drive" globale ne tue pas le report.
  try {
    for (var fi = 0; fi < folderEntries.length; fi++) {
      if (Date.now() - startTime > TIMEOUT_MS) {
        report.timeoutHit = true;
        Logger.log("syncDriveDocs : timeout préventif après " + report.filesSeen + " fichiers");
        break;
      }

      var entry = folderEntries[fi];
      var folder = entry.folder;
      var folderName = entry.folderName;
      var folderKey = entry.folderKey;
      var matchInfo = entry.matchInfo;
      var match = matchInfo ? matchInfo.match : null;

      // Détection ambiguïté fuzzy
      var isAmbiguous = false;
      if (match && matchInfo.by !== "exact" && fuzzyVotes[match.rowIdx] > 1) {
        isAmbiguous = true;
        report.ambiguousFolders.push({
          folder: folderName,
          wouldMatch: match.row[iEntreprise],
          strategy: matchInfo.by,
          nbCandidates: fuzzyVotes[match.rowIdx]
        });
        match = null; // on ne touchera pas la sheet pour ce folder
      } else if (match && matchInfo.by !== "exact") {
        report.fuzzyMatched.push({ folder: folderName, matched: match.row[iEntreprise], by: matchInfo.by });
      }

      if (!match && !isAmbiguous) {
        report.orphans.push(folderName);
        continue;
      }

      var files;
      try {
        files = folder.getFiles();
      } catch (err) {
        Logger.log("syncDriveDocs : getFiles a planté pour " + folderName + " : " + err.message);
        report.skippedFolders.push({ folder: folderName, error: String(err.message || err) });
        continue;
      }

      while (files.hasNext()) {
        if (Date.now() - startTime > TIMEOUT_MS) {
          report.timeoutHit = true;
          Logger.log("syncDriveDocs : timeout préventif au milieu de " + folderName);
          break;
        }

        var file, fileName;
        try {
          file = files.next();
          fileName = file.getName();
        } catch (err) {
          Logger.log("syncDriveDocs : fichier (next/getName) dans " + folderName + " : " + err.message);
          report.skippedFiles.push({ folder: folderName, file: fileName || "?", error: String(err.message || err) });
          continue;
        }

        report.filesSeen++;

        try {
          var docType = detectDocTypeByName(fileName);
          var classifiedBy = "name";

          if (!docType || docType === "AUTRE" || !DOC_TYPE_TO_FIELDS[docType]) {
            // Pour les ambigus, on stocke le fichier en unknowns avec un flag
            // pour que classifyBatch ne tente pas non plus le match auto.
            report.unknowns.push({
              folder: folderName,
              folderKey: folderKey,
              fileId: file.getId(),
              file: fileName,
              ambiguous: isAmbiguous
            });
            continue;
          }

          if (isAmbiguous) {
            // Type détecté par nom mais on ne peut pas écrire vu l'ambiguïté
            // → on log dans skippedFiles avec une raison explicite.
            report.skippedFiles.push({
              folder: folderName,
              file: fileName,
              error: "Ambigu : plusieurs dossiers Drive visent le même client en fuzzy"
            });
            continue;
          }

          var fieldSet = DOC_TYPE_TO_FIELDS[docType];
          var flagCol = headers.indexOf(fieldSet.flag);
          var linkCol = headers.indexOf(fieldSet.link);
          if (flagCol === -1) continue;

          var url = file.getUrl();
          sheet.getRange(match.rowIdx + 1, flagCol + 1).setValue("TRUE");
          if (linkCol !== -1) {
            sheet.getRange(match.rowIdx + 1, linkCol + 1).setValue(url);
          }

          report.updates.push({
            client: match.row[iEntreprise],
            docType: docType,
            file: fileName,
            by: classifiedBy
          });
        } catch (err) {
          Logger.log("syncDriveDocs : traitement " + fileName + " dans " + folderName + " : " + err.message);
          report.skippedFiles.push({ folder: folderName, file: fileName, error: String(err.message || err) });
        }
      }

      if (report.timeoutHit) break;
    }
  } catch (err) {
    Logger.log("syncDriveDocs : exception globale dans la passe 2 : " + err.message);
    report.fatalError = "Passe 2 Drive : " + String(err.message || err);
    // On retombe sur ses pieds : on persiste ce qu'on a déjà collecté.
  }

  try {
    PropertiesService.getScriptProperties().setProperty(
      "AI_QUEUE",
      JSON.stringify(report.unknowns)
    );
  } catch (err) {
    Logger.log("syncDriveDocs : impossible d'écrire AI_QUEUE : " + err.message);
  }
  report.aiQueueSize = report.unknowns.length;
  report.elapsedMs = Date.now() - startTime;

  return report;
}

function classifyStatus() {
  var raw = PropertiesService.getScriptProperties().getProperty("AI_QUEUE");
  var queue = raw ? JSON.parse(raw) : [];
  return { remaining: queue.length };
}

function classifyBatch(limit) {
  limit = limit || 20;

  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty("AI_QUEUE");
  var queue = raw ? JSON.parse(raw) : [];

  if (queue.length === 0) {
    return { processed: 0, classified: 0, remaining: 0, updates: [] };
  }

  var sheet = SS.getSheetByName("Clients");
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var iEntreprise = headers.indexOf("entreprise");

  var clientsByKey = {};
  var all = sheet.getDataRange().getValues();
  for (var i = 1; i < all.length; i++) {
    var key = normalizeName(all[i][iEntreprise]);
    if (key) clientsByKey[key] = { row: all[i], rowIdx: i };
  }
  var clientsKeysSorted = Object.keys(clientsByKey).sort(function(a, b) { return b.length - a.length; });

  var batch = queue.slice(0, limit);
  var rest = queue.slice(limit);

  var updates = [];
  var errors = [];
  var classified = 0;
  var reasons = { ok: 0, noKey: 0, unsupportedMime: 0, tooBig: 0, httpError: 0, labelOther: 0, noClientMatch: 0, ambiguous: 0, exception: 0 };

  // Pour détecter les ambiguïtés "à la volée" sur la queue : on compte combien
  // d'items pointent vers le même client par fuzzy. Si > 1 → on skip tout ce groupe.
  var fuzzyVotes = {};
  for (var jj = 0; jj < queue.length; jj++) {
    var qi = queue[jj];
    var mi0 = findClientForFolder(qi.folderKey, clientsByKey, clientsKeysSorted);
    if (mi0 && mi0.by !== "exact") {
      fuzzyVotes[mi0.match.rowIdx] = (fuzzyVotes[mi0.match.rowIdx] || 0) + 1;
    }
  }

  for (var j = 0; j < batch.length; j++) {
    var item = batch[j];

    // Skip explicite si syncDriveDocs a déjà détecté l'ambiguïté
    if (item.ambiguous) {
      reasons.ambiguous++;
      continue;
    }

    try {
      var file = DriveApp.getFileById(item.fileId);
      var clf = classifyWithGemini(file);
      var label = clf && clf.label;
      var reason = (clf && clf.reason) || "exception";
      if (!label || !DOC_TYPE_TO_FIELDS[label]) {
        reasons[reason] = (reasons[reason] || 0) + 1;
        continue;
      }

      var matchInfo = findClientForFolder(item.folderKey, clientsByKey, clientsKeysSorted);
      var match = matchInfo ? matchInfo.match : null;
      if (!match) {
        reasons.noClientMatch++;
        continue;
      }
      // Anti-mélange : si fuzzy match et plusieurs items visent ce client → skip
      if (matchInfo.by !== "exact" && (fuzzyVotes[match.rowIdx] || 0) > 1) {
        reasons.ambiguous++;
        continue;
      }

      var fieldSet = DOC_TYPE_TO_FIELDS[label];
      var flagCol = headers.indexOf(fieldSet.flag);
      var linkCol = headers.indexOf(fieldSet.link);
      if (flagCol === -1) continue;

      sheet.getRange(match.rowIdx + 1, flagCol + 1).setValue("TRUE");
      if (linkCol !== -1) {
        sheet.getRange(match.rowIdx + 1, linkCol + 1).setValue(file.getUrl());
      }

      classified++;
      reasons.ok++;
      updates.push({
        client: match.row[iEntreprise],
        docType: label,
        file: item.file,
        matchedBy: matchInfo.by
      });
    } catch (err) {
      reasons.exception++;
      errors.push({ file: item.file, error: err.message });
    }
  }

  props.setProperty("AI_QUEUE", JSON.stringify(rest));
  SpreadsheetApp.flush();

  return {
    processed: batch.length,
    classified: classified,
    remaining: rest.length,
    updates: updates,
    errors: errors,
    reasons: reasons
  };
}

// ---- IMPORT INITIAL ----

function importInitialData() {
  var json = UrlFetchApp.fetch("https://raw.githubusercontent.com/770lab/crm-velos-cargo/main/gas/data-export.json").getContentText();
  var data = JSON.parse(json);

  var clientsSheet = SS.getSheetByName("Clients") || SS.insertSheet("Clients");
  clientsSheet.clear();
  clientsSheet.getRange(1, 1, 1, data.clients.headers.length).setValues([data.clients.headers]);
  if (data.clients.rows.length > 0) {
    clientsSheet.getRange(2, 1, data.clients.rows.length, data.clients.headers.length).setValues(data.clients.rows);
  }

  var velosSheet = SS.getSheetByName("Velos") || SS.insertSheet("Velos");
  velosSheet.clear();
  velosSheet.getRange(1, 1, 1, data.velos.headers.length).setValues([data.velos.headers]);
  var batchSize = 1000;
  for (var i = 0; i < data.velos.rows.length; i += batchSize) {
    var batch = data.velos.rows.slice(i, i + batchSize);
    velosSheet.getRange(i + 2, 1, batch.length, data.velos.headers.length).setValues(batch);
  }

  var livSheet = SS.getSheetByName("Livraisons") || SS.insertSheet("Livraisons");
  livSheet.clear();
  livSheet.getRange(1, 1, 1, 6).setValues([["id","clientId","datePrevue","dateEffective","statut","notes"]]);

  SpreadsheetApp.flush();
  return "Import terminé: " + data.clients.rows.length + " clients, " + data.velos.rows.length + " vélos";
}

function debugDriveFolder() {
  var folder;
  try {
    folder = DriveApp.getFolderById(DRIVE_DOSSIER_VELO_ID);
  } catch (err) {
    Logger.log("ERREUR getFolderById: " + err.message);
    return;
  }
  Logger.log("Nom dossier : " + folder.getName());
  Logger.log("URL : " + folder.getUrl());
  Logger.log("Propriétaire (si accessible) : " + (folder.getOwner() ? folder.getOwner().getEmail() : "non accessible"));

  var subCount = 0;
  var subs = folder.getFolders();
  var firstNames = [];
  while (subs.hasNext()) {
    var sub = subs.next();
    subCount++;
    if (firstNames.length < 10) firstNames.push(sub.getName());
  }
  Logger.log("Sous-dossiers : " + subCount);
  if (firstNames.length) Logger.log("Premiers noms : " + firstNames.join(" | "));

  var fileCount = 0;
  var files = folder.getFiles();
  while (files.hasNext()) { fileCount++; files.next(); }
  Logger.log("Fichiers à la racine : " + fileCount);

  Logger.log("Utilisateur exécuteur : " + Session.getActiveUser().getEmail());
}

// Appelé depuis le bouton "Tester Gemini" du modal de sync côté front.
// Fait UN appel Gemini texte-seul (pas de fichier) pour diagnostiquer la clé / le modèle /
// le quota, indépendamment de Drive. Si ce test passe mais classifyBatch échoue en masse,
// le problème est spécifique aux payloads PDF (taille, rate-limit sur inline_data, etc.).
function testGemini() {
  var apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  var diag = {
    apiKeyPresent: !!apiKey,
    apiKeyLength: apiKey ? apiKey.length : 0,
    model: "gemini-2.5-flash",
    urlObfuscated: null,
    testMode: "text-only",
    httpCode: null,
    body: null,
    label: null,
    error: null
  };

  if (!apiKey) {
    diag.error = "GEMINI_API_KEY absente dans Script Properties";
    return diag;
  }

  var payload = {
    contents: [{ parts: [{ text: "Réponds uniquement par OK." }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 5 }
  };

  var url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + apiKey;
  diag.urlObfuscated = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=***" + apiKey.slice(-4);

  try {
    var res = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    diag.httpCode = res.getResponseCode();
    var body = res.getContentText();
    diag.body = body.length > 1500 ? body.slice(0, 1500) + "..." : body;
    if (diag.httpCode === 200) {
      try {
        var data = JSON.parse(body);
        var text = (((data.candidates || [])[0] || {}).content || {}).parts;
        if (text && text[0]) diag.label = String(text[0].text || "").trim();
      } catch (errP) { /* parse OK non critique pour le diag */ }
    }
  } catch (errF) {
    diag.error = "UrlFetchApp a planté : " + errF.message;
  }

  return diag;
}

// ---- PARCELLE CADASTRALE AUTO ----

function fetchParcelle(clientId) {
  if (!clientId) return { error: "ID client manquant" };

  var sheet = SS.getSheetByName("Clients");
  var all = sheet.getDataRange().getValues();
  var headers = all[0];
  var clientRow = null;
  var clientRowIdx = -1;
  for (var i = 1; i < all.length; i++) {
    if (all[i][0] === clientId) {
      clientRow = all[i];
      clientRowIdx = i;
      break;
    }
  }
  if (!clientRow) return { error: "Client non trouvé" };

  var adresse = clientRow[headers.indexOf("adresse")] || "";
  var codePostal = clientRow[headers.indexOf("codePostal")] || "";
  var ville = clientRow[headers.indexOf("ville")] || "";

  var q = [adresse, codePostal, ville].filter(Boolean).join(" ");
  if (!q.trim()) return { error: "Adresse client vide — renseignez l'adresse, le code postal et la ville." };

  // 1) Géocodage via api-adresse.data.gouv.fr
  var geoUrl = "https://api-adresse.data.gouv.fr/search/?q=" + encodeURIComponent(q) + "&limit=1";
  var geoRes = UrlFetchApp.fetch(geoUrl, { muteHttpExceptions: true });
  if (geoRes.getResponseCode() !== 200) return { error: "Erreur géocodage : HTTP " + geoRes.getResponseCode() };

  var geoData = JSON.parse(geoRes.getContentText());
  if (!geoData.features || geoData.features.length === 0) return { error: "Adresse introuvable sur api-adresse.data.gouv.fr" };

  var coords = geoData.features[0].geometry.coordinates;
  var lng = coords[0];
  var lat = coords[1];

  // 2) Requête cadastre — essai apicarto.ign.fr puis fallback geo.api.gouv.fr
  var props = null;
  try {
    var cadastreUrl = "https://apicarto.ign.fr/api/cadastre/parcelle?geom=" +
      encodeURIComponent('{"type":"Point","coordinates":[' + lng + ',' + lat + ']}') +
      "&_limit=1";
    var cadRes = UrlFetchApp.fetch(cadastreUrl, { muteHttpExceptions: true });
    if (cadRes.getResponseCode() === 200) {
      var cadData = JSON.parse(cadRes.getContentText());
      if (cadData.features && cadData.features.length > 0) props = cadData.features[0].properties;
    }
  } catch (e) {}

  if (!props) {
    try {
      var fallbackUrl = "https://geo.api.gouv.fr/communes?lat=" + lat + "&lon=" + lng + "&fields=codeDepartement,codeCommune&limit=1";
      var fbRes = UrlFetchApp.fetch(fallbackUrl, { muteHttpExceptions: true });
      if (fbRes.getResponseCode() === 200) {
        var communes = JSON.parse(fbRes.getContentText());
        if (communes.length > 0) {
          props = { code_com: communes[0].code, section: "", numero: "", contenance: "" };
        }
      }
    } catch (e2) {}
  }

  if (!props) return { error: "API cadastre indisponible — réessayez plus tard." };

  var codeCommune = props.code_com || props.commune || "";
  var section = props.section || "";
  var numero = props.numero || "";
  var contenance = props.contenance || "";
  var codeArr = props.code_arr || codeCommune;

  var refParcelle = codeCommune + " " + section + " " + numero;

  // 3) Lien Géoportail centré sur la parcelle
  var geoPortailUrl = "https://www.geoportail.gouv.fr/carte?c=" + lng + "," + lat + "&z=18&l0=CADASTRALPARCELS.PARCELLAIRE_EXPRESS::GEOPORTAIL:OGC:WMTS(1)";

  // 4) Mise à jour du client dans la feuille
  var colFlag = headers.indexOf("parcelleCadastrale");
  var colLien = headers.indexOf("parcelleCadastraleLien");
  if (colFlag > -1) sheet.getRange(clientRowIdx + 1, colFlag + 1).setValue("TRUE");
  if (colLien > -1) sheet.getRange(clientRowIdx + 1, colLien + 1).setValue(geoPortailUrl);
  SpreadsheetApp.flush();

  return {
    ok: true,
    parcelle: refParcelle,
    section: section,
    numero: numero,
    commune: codeCommune,
    contenance: contenance ? Number(contenance) : null,
    lat: lat,
    lng: lng,
    geoportailUrl: geoPortailUrl
  };
}

// Parcours tous les clients sans parcelleCadastrale=TRUE et appelle fetchParcelle
// pour chacun. Auto-référence la parcelle via api-adresse + apicarto.ign.fr.
// Limité à `limit` clients par appel pour rester sous le quota Apps Script 6min.
function autoFetchParcelles(limit) {
  limit = limit > 0 ? limit : 50;
  var sheet = SS.getSheetByName("Clients");
  if (!sheet) return { error: "Feuille Clients introuvable" };
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var iId = headers.indexOf("id");
  var iFlag = headers.indexOf("parcelleCadastrale");
  var iAdresse = headers.indexOf("adresse");

  var report = { processed: 0, ok: 0, skipped: 0, failed: 0, errors: [] };
  for (var i = 1; i < data.length && report.processed < limit; i++) {
    var already = data[i][iFlag] === true || data[i][iFlag] === "TRUE";
    if (already) { report.skipped++; continue; }
    var clientId = data[i][iId];
    var adresse = data[i][iAdresse];
    if (!clientId || !adresse) { report.skipped++; continue; }
    report.processed++;
    try {
      var res = fetchParcelle(clientId);
      if (res && res.ok) {
        report.ok++;
      } else {
        report.failed++;
        if (res && res.error && report.errors.length < 10) {
          report.errors.push({ clientId: clientId, error: res.error });
        }
      }
    } catch (err) {
      report.failed++;
      if (report.errors.length < 10) report.errors.push({ clientId: clientId, error: String(err) });
    }
    // Pause légère pour lisser les appels API
    Utilities.sleep(250);
  }
  return report;
}

// ---- SET CLIENT VELOS TARGET (correction effectif) ----

function ensureVelosAnnuleColumn() {
  return ensureVelosSchema();
}

// Garantit toutes les colonnes attendues sur la feuille Velos.
// Ajoute `annule` (soft cancel) + FNUCI + photos si absentes. Backward-compatible.
function ensureVelosSchema() {
  var sheet = SS.getSheetByName("Velos");
  if (!sheet) return { sheet: null, headers: [], annuleCol: -1 };
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var needed = ["annule", "fnuci", "photoVeloUrl", "photoFnuciUrl", "photoDate", "korpValide"];
  for (var k = 0; k < needed.length; k++) {
    if (headers.indexOf(needed[k]) === -1) {
      lastCol++;
      sheet.getRange(1, lastCol).setValue(needed[k]);
      headers.push(needed[k]);
    }
  }
  return { sheet: sheet, headers: headers, annuleCol: headers.indexOf("annule") };
}

// Ajuste le nombre de vélos actifs du client à `target` :
//  - target > actifs : réactive annulés, puis crée lignes manquantes
//  - target < actifs : soft-cancel les non-livrés d'abord (jamais de hard delete)
function setClientVelosTarget(clientId, target) {
  if (!clientId) return { error: "clientId manquant" };
  if (!isFinite(target) || target < 0) return { error: "target invalide" };
  target = Math.floor(target);

  var meta = ensureVelosAnnuleColumn();
  var sheet = meta.sheet;
  if (!sheet) return { error: "Feuille Velos introuvable" };
  var headers = meta.headers;
  var annuleCol = meta.annuleCol;
  var idCol = headers.indexOf("id");
  var clientIdCol = headers.indexOf("clientId");
  var livreCol = headers.indexOf("photoQrPrise");

  var data = sheet.getDataRange().getValues();
  var actifs = [];
  var annules = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][clientIdCol] !== clientId) continue;
    var isAnn = data[i][annuleCol] === true || data[i][annuleCol] === "TRUE";
    var isLivre = livreCol >= 0 && (data[i][livreCol] === true || data[i][livreCol] === "TRUE");
    var entry = { rowIndex: i + 1, isLivre: isLivre };
    if (isAnn) annules.push(entry); else actifs.push(entry);
  }

  var current = actifs.length;
  var reactivated = 0, cancelled = 0, created = 0;

  if (target > current) {
    var toAdd = target - current;
    // 1) Réactive d'abord les annulés
    while (toAdd > 0 && annules.length > 0) {
      var r = annules.shift();
      sheet.getRange(r.rowIndex, annuleCol + 1).setValue("FALSE");
      reactivated++; toAdd--;
    }
    // 2) Crée les lignes manquantes
    if (toAdd > 0) {
      // Prépare les nouvelles lignes avec id + clientId + annule=FALSE
      var newRows = [];
      for (var k = 0; k < toAdd; k++) {
        var row = new Array(headers.length).fill("");
        row[idCol] = Utilities.getUuid();
        row[clientIdCol] = clientId;
        row[annuleCol] = "FALSE";
        newRows.push(row);
      }
      sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, headers.length).setValues(newRows);
      created = toAdd;
    }
  } else if (target < current) {
    var toCancel = current - target;
    // Priorité : cancel les non-livrés
    var nonLivres = actifs.filter(function(a) { return !a.isLivre; });
    var livres = actifs.filter(function(a) { return a.isLivre; });
    var ordered = nonLivres.concat(livres);
    for (var j = 0; j < toCancel && j < ordered.length; j++) {
      sheet.getRange(ordered[j].rowIndex, annuleCol + 1).setValue("TRUE");
      cancelled++;
    }
  }

  SpreadsheetApp.flush();
  return {
    ok: true,
    clientId: clientId,
    before: current,
    after: target,
    reactivated: reactivated,
    cancelled: cancelled,
    created: created
  };
}

// ---- VERIFICATIONS PENDING ----

var VERIF_SHEET_NAME = "VerificationsPending";
var VERIF_COLS_CRM = [
  "id", "receivedAt", "clientId", "entreprise", "docType",
  "driveUrl", "fileName", "fromEmail", "subject",
  "effectifDetected", "nbVelosBefore", "nbVelosAfter",
  "status", "notes", "messageId"
];

function ensureVerificationsSheet() {
  var sh = SS.getSheetByName(VERIF_SHEET_NAME);
  if (!sh) {
    sh = SS.insertSheet(VERIF_SHEET_NAME);
    sh.getRange(1, 1, 1, VERIF_COLS_CRM.length).setValues([VERIF_COLS_CRM]);
    sh.setFrozenRows(1);
    return sh;
  }
  var headers = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0];
  var missing = VERIF_COLS_CRM.filter(function(c) { return headers.indexOf(c) < 0; });
  if (missing.length) {
    sh.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
  }
  return sh;
}

function listVerifications(params) {
  var sh = ensureVerificationsSheet();
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return { items: [], count: 0 };
  var headers = data[0];
  var status = (params && params.status) || "pending";
  var limit = Math.max(1, Math.min(500, Number((params && params.limit) || 100)));

  var items = [];
  for (var i = data.length - 1; i >= 1 && items.length < limit; i--) {
    var row = data[i];
    var obj = {};
    headers.forEach(function(h, j) {
      var v = row[j];
      if (v instanceof Date) obj[h] = Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ssXXX");
      else obj[h] = v;
    });
    obj._rowIndex = i + 1;
    if (status === "all" || obj.status === status || (!obj.status && status === "pending")) {
      items.push(obj);
    }
  }
  return { items: items, count: items.length };
}

function _findVerifRow(id) {
  var sh = ensureVerificationsSheet();
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var headers = data[0];
  var idCol = headers.indexOf("id");
  var statusCol = headers.indexOf("status");
  var notesCol = headers.indexOf("notes");
  var clientIdCol = headers.indexOf("clientId");
  var nbBeforeCol = headers.indexOf("nbVelosBefore");
  var nbAfterCol = headers.indexOf("nbVelosAfter");
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(id)) {
      return {
        sheet: sh, rowIndex: i + 1, row: data[i],
        idCol: idCol, statusCol: statusCol, notesCol: notesCol,
        clientIdCol: clientIdCol, nbBeforeCol: nbBeforeCol, nbAfterCol: nbAfterCol
      };
    }
  }
  return null;
}

function validateVerification(id) {
  var r = _findVerifRow(id);
  if (!r) return { error: "Vérification introuvable" };
  if (r.statusCol >= 0) r.sheet.getRange(r.rowIndex, r.statusCol + 1).setValue("validated");

  var headers = r.sheet.getRange(1, 1, 1, r.sheet.getLastColumn()).getValues()[0];
  var docTypeCol = headers.indexOf("docType");
  var driveUrlCol = headers.indexOf("driveUrl");
  var docType = docTypeCol >= 0 ? String(r.row[docTypeCol] || "") : "";
  var driveUrl = driveUrlCol >= 0 ? String(r.row[driveUrlCol] || "").split(" ||| ")[0] : "";
  var clientId = r.clientIdCol >= 0 ? r.row[r.clientIdCol] : "";

  if (clientId && docType) {
    var mapping = {
      DEVIS: { flag: "devisSignee", link: "devisLien" },
      KBIS: { flag: "kbisRecu", link: "kbisLien" },
      LIASSE: { flag: "attestationRecue", link: "attestationLien" },
      URSSAF: { flag: "attestationRecue", link: "attestationLien" },
      ATTESTATION: { flag: "attestationRecue", link: "attestationLien" },
      SIGNATURE: { flag: "signatureOk", link: "signatureLien" },
      BICYCLE: { flag: "inscriptionBicycle", link: "bicycleLien" },
      PARCELLE: { flag: "parcelleCadastrale", link: "parcelleCadastraleLien" }
    };
    var m = mapping[docType];
    if (m) {
      var cSheet = SS.getSheetByName("Clients");
      var cData = cSheet.getDataRange().getValues();
      var cHeaders = cData[0];
      for (var ci = 1; ci < cData.length; ci++) {
        if (String(cData[ci][0]) === String(clientId)) {
          var flagCol = cHeaders.indexOf(m.flag);
          var linkCol = cHeaders.indexOf(m.link);
          if (flagCol >= 0) cSheet.getRange(ci + 1, flagCol + 1).setValue(true);
          if (linkCol >= 0 && driveUrl) cSheet.getRange(ci + 1, linkCol + 1).setValue(driveUrl);
          break;
        }
      }
    }
  }

  SpreadsheetApp.flush();
  return { ok: true, id: id, status: "validated", docType: docType, clientId: clientId };
}

function rejectVerification(id, revertNbVelos, notes) {
  var r = _findVerifRow(id);
  if (!r) return { error: "Vérification introuvable" };
  if (r.statusCol >= 0) r.sheet.getRange(r.rowIndex, r.statusCol + 1).setValue("rejected");
  if (notes && r.notesCol >= 0) {
    var existing = String(r.row[r.notesCol] || "");
    var newNotes = existing ? existing + " | REJECT: " + notes : "REJECT: " + notes;
    r.sheet.getRange(r.rowIndex, r.notesCol + 1).setValue(newNotes);
  }
  var revertResult = null;
  if (revertNbVelos && r.clientIdCol >= 0 && r.nbBeforeCol >= 0) {
    var cid = r.row[r.clientIdCol];
    var before = Number(r.row[r.nbBeforeCol]);
    if (cid && isFinite(before)) {
      revertResult = setClientVelosTarget(cid, before);
    }
  }
  SpreadsheetApp.flush();
  return { ok: true, id: id, status: "rejected", revert: revertResult };
}

function countPendingVerifications() {
  var sh = SS.getSheetByName(VERIF_SHEET_NAME);
  if (!sh) return { count: 0 };
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return { count: 0 };
  var headers = data[0];
  var statusCol = headers.indexOf("status");
  if (statusCol < 0) return { count: data.length - 1 };
  var n = 0;
  for (var i = 1; i < data.length; i++) {
    var s = String(data[i][statusCol] || "").toLowerCase();
    if (s === "" || s === "pending" || s === "unassigned") n++;
  }
  return { count: n };
}

// Mapping docType -> (flag, link) sur la fiche client. Partagé avec validateVerification.
var DOC_TYPE_TO_CLIENT_FIELDS = {
  DEVIS: { flag: "devisSignee", link: "devisLien" },
  KBIS: { flag: "kbisRecu", link: "kbisLien" },
  LIASSE: { flag: "attestationRecue", link: "attestationLien" },
  URSSAF: { flag: "attestationRecue", link: "attestationLien" },
  ATTESTATION: { flag: "attestationRecue", link: "attestationLien" },
  SIGNATURE: { flag: "signatureOk", link: "signatureLien" },
  BICYCLE: { flag: "inscriptionBicycle", link: "bicycleLien" },
  PARCELLE: { flag: "parcelleCadastrale", link: "parcelleCadastraleLien" }
};

// Auto-valide en lot toutes les vérifications "pending" qui ont un clientId
// et un docType reconnu. Pas d'effacement : on bascule status -> validated, on
// pose flag+lien sur la fiche client. dryRun=true renvoie un aperçu sans écrire.
function bulkAutoValidate(params) {
  var dryRun = !!(params && (params.dryRun === true || params.dryRun === "true"));
  var sh = ensureVerificationsSheet();
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return { wouldValidate: 0, validated: 0, skipped: 0, dryRun: dryRun };

  var headers = data[0];
  var col = {
    id: headers.indexOf("id"),
    clientId: headers.indexOf("clientId"),
    docType: headers.indexOf("docType"),
    driveUrl: headers.indexOf("driveUrl"),
    status: headers.indexOf("status"),
    notes: headers.indexOf("notes"),
    receivedAt: headers.indexOf("receivedAt")
  };

  var cSheet = SS.getSheetByName("Clients");
  var cData = cSheet.getDataRange().getValues();
  var cHeaders = cData[0];
  var idCol = cHeaders.indexOf("id");
  var clientRowById = {};
  for (var ci = 1; ci < cData.length; ci++) {
    var cid = cData[ci][idCol];
    if (cid != null && cid !== "") clientRowById[String(cid)] = ci; // 0-based index dans cData
  }

  var skipReasons = { notPending: 0, noClient: 0, clientNotFound: 0, unknownDocType: 0 };
  var byDocType = {};
  var sample = [];
  // Map: clientId -> { flag -> {linkField, link (null si on ne touche pas au lien), when, setFlag} }
  var pendingClientUpdates = {};
  // Liste: { rowIndex (1-based), id, action: "fresh"|"linkOnly"|"skipExisting" }
  var rowsToValidate = [];
  var counts = { fresh: 0, linkOnly: 0, skipExisting: 0 };
  // Mode C : flag toujours posé à true (idempotent), mais le lien n'est rempli que si la
  // colonne lien côté Clients est vide aujourd'hui. On ne casse jamais un lien que tu as
  // classé manuellement.

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var status = String(row[col.status] || "").toLowerCase();
    if (status !== "" && status !== "pending" && status !== "unassigned") {
      skipReasons.notPending++;
      continue;
    }
    var clientId = col.clientId >= 0 ? row[col.clientId] : "";
    if (!clientId) { skipReasons.noClient++; continue; }
    var clientRowIdx = clientRowById[String(clientId)];
    if (clientRowIdx == null) { skipReasons.clientNotFound++; continue; }
    var docType = col.docType >= 0 ? String(row[col.docType] || "").toUpperCase() : "";
    var mapping = DOC_TYPE_TO_CLIENT_FIELDS[docType];
    if (!mapping) { skipReasons.unknownDocType++; continue; }

    var flagCol = cHeaders.indexOf(mapping.flag);
    var linkCol = cHeaders.indexOf(mapping.link);
    var currentFlag = flagCol >= 0 ? cData[clientRowIdx][flagCol] : false;
    var alreadyFlagged = (currentFlag === true || currentFlag === "TRUE");
    var currentLink = linkCol >= 0 ? cData[clientRowIdx][linkCol] : "";
    var linkIsEmpty = !currentLink || String(currentLink).trim() === "";

    byDocType[docType] = (byDocType[docType] || 0) + 1;

    var driveUrl = col.driveUrl >= 0 ? String(row[col.driveUrl] || "").split(" ||| ")[0] : "";
    var receivedAt = col.receivedAt >= 0 ? row[col.receivedAt] : null;
    var receivedTs = (receivedAt instanceof Date) ? receivedAt.getTime() : (receivedAt ? Date.parse(receivedAt) : 0);
    var fileName = row[headers.indexOf("fileName")] || "";

    var action;
    if (alreadyFlagged && !linkIsEmpty) {
      // Tout est déjà en place côté Clients, on ne touche à rien (ni flag, ni lien).
      action = "skipExisting";
    } else if (alreadyFlagged && linkIsEmpty) {
      // Flag déjà coché mais lien vide → on remplit le lien.
      action = "linkOnly";
    } else if (!alreadyFlagged && linkIsEmpty) {
      // Fiche vide → on coche le flag et on remplit le lien.
      action = "fresh";
    } else {
      // !alreadyFlagged && !linkIsEmpty (cas rare) → on coche le flag, on garde le lien existant.
      action = "fresh";
    }

    if (action !== "skipExisting") {
      if (!pendingClientUpdates[clientId]) pendingClientUpdates[clientId] = {};
      var slot = pendingClientUpdates[clientId];
      var prev = slot[mapping.flag];
      // Si plusieurs verifs pour le même client+docType, le plus récent gagne pour le lien.
      if (!prev || (receivedTs && receivedTs >= (prev.when || 0))) {
        slot[mapping.flag] = {
          linkField: mapping.link,
          link: linkIsEmpty ? driveUrl : null, // null = ne pas écrire le lien
          when: receivedTs,
          setFlag: !alreadyFlagged
        };
      }
    }

    counts[action]++;
    rowsToValidate.push({ rowIndex: i + 1, id: row[col.id], action: action });
    if (sample.length < 10) {
      sample.push({ id: row[col.id], clientId: clientId, docType: docType, fileName: fileName, action: action });
    }
  }

  var preview = {
    wouldValidate: rowsToValidate.length,
    fresh: counts.fresh,         // flag posé + lien rempli
    linkOnly: counts.linkOnly,   // flag déjà coché, on rajoute juste le lien
    skipExisting: counts.skipExisting, // déjà OK, juste sortie de la file
    skipped: skipReasons.notPending + skipReasons.noClient + skipReasons.clientNotFound + skipReasons.unknownDocType,
    skipReasons: skipReasons,
    byDocType: byDocType,
    clientsTouched: Object.keys(pendingClientUpdates).length,
    sample: sample,
    dryRun: dryRun
  };

  if (dryRun || rowsToValidate.length === 0) {
    return preview;
  }

  // Écritures côté Clients : 1 setValues par client (mode C — flag posé seulement
  // si setFlag=true, lien posé seulement si info.link est non null).
  var clientsUpdated = 0;
  Object.keys(pendingClientUpdates).forEach(function(cid) {
    var rowIdx = clientRowById[cid]; // 0-based dans cData
    var changed = false;
    var slot = pendingClientUpdates[cid];
    Object.keys(slot).forEach(function(flagName) {
      var info = slot[flagName];
      var fCol = cHeaders.indexOf(flagName);
      if (fCol >= 0 && info.setFlag) { cData[rowIdx][fCol] = true; changed = true; }
      var lCol = cHeaders.indexOf(info.linkField);
      if (lCol >= 0 && info.link) { cData[rowIdx][lCol] = info.link; changed = true; }
    });
    if (changed) {
      cSheet.getRange(rowIdx + 1, 1, 1, cData[rowIdx].length).setValues([cData[rowIdx]]);
      clientsUpdated++;
    }
  });

  // Écritures côté Verifications : status + notes par lot, avec note différente selon l'action.
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  for (var k = 0; k < rowsToValidate.length; k++) {
    var item = rowsToValidate[k];
    var rIdx = item.rowIndex;
    if (col.status >= 0) sh.getRange(rIdx, col.status + 1).setValue("validated");
    if (col.notes >= 0) {
      var existing = String(data[rIdx - 1][col.notes] || "");
      var noteAppend = "auto-bulk " + stamp + " (" + item.action + ")";
      var newNote = existing ? existing + " | " + noteAppend : noteAppend;
      sh.getRange(rIdx, col.notes + 1).setValue(newNote);
    }
  }

  SpreadsheetApp.flush();
  preview.validated = rowsToValidate.length;
  preview.clientsUpdated = clientsUpdated;
  return preview;
}

// ===========================================================================
// ÉQUIPE (chauffeurs, chefs d'équipe, monteurs)
// ===========================================================================

var EQUIPE_SHEET_NAME = "Equipe";
var EQUIPE_COLS = ["id", "nom", "role", "telephone", "email", "actif", "notes", "createdAt"];
var EQUIPE_ROLES = ["chauffeur", "chef", "monteur", "apporteur"];

function ensureEquipeSheet() {
  var sh = SS.getSheetByName(EQUIPE_SHEET_NAME);
  if (!sh) {
    sh = SS.insertSheet(EQUIPE_SHEET_NAME);
    sh.getRange(1, 1, 1, EQUIPE_COLS.length).setValues([EQUIPE_COLS]);
    sh.setFrozenRows(1);
    return sh;
  }
  var lastCol = Math.max(1, sh.getLastColumn());
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var missing = EQUIPE_COLS.filter(function(c) { return headers.indexOf(c) < 0; });
  if (missing.length) {
    sh.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
  }
  return sh;
}

function _equipeRowToObject(row, headers) {
  var obj = {};
  headers.forEach(function(h, j) {
    var v = row[j];
    if (v instanceof Date) obj[h] = Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ssXXX");
    else obj[h] = v;
  });
  if (obj.actif === "TRUE") obj.actif = true;
  else if (obj.actif === "FALSE") obj.actif = false;
  return obj;
}

function listEquipe(params) {
  var sh = ensureEquipeSheet();
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return { items: [] };
  var headers = data[0];
  var includeInactifs = params && (params.includeInactifs === "true" || params.includeInactifs === true);
  var roleFilter = params && params.role;
  var items = [];
  for (var i = 1; i < data.length; i++) {
    var obj = _equipeRowToObject(data[i], headers);
    if (!includeInactifs && obj.actif === false) continue;
    if (roleFilter && obj.role !== roleFilter) continue;
    items.push(obj);
  }
  items.sort(function(a, b) { return String(a.nom || "").localeCompare(String(b.nom || "")); });
  return { items: items };
}

function upsertMembre(body) {
  if (!body || !body.nom) return { error: "Nom requis" };
  var role = body.role;
  if (!role || EQUIPE_ROLES.indexOf(role) < 0) return { error: "Rôle invalide (" + EQUIPE_ROLES.join("/") + ")" };
  var sh = ensureEquipeSheet();
  var data = sh.getDataRange().getValues();
  var headers = data[0];
  var idCol = headers.indexOf("id");

  if (body.id) {
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][idCol]) === String(body.id)) {
        EQUIPE_COLS.forEach(function(col) {
          if (col === "id" || col === "createdAt") return;
          if (body[col] !== undefined) {
            var c = headers.indexOf(col);
            if (c >= 0) {
              var val = body[col];
              if (col === "actif") val = (val === true || val === "true" || val === "TRUE") ? "TRUE" : "FALSE";
              sh.getRange(i + 1, c + 1).setValue(val);
            }
          }
        });
        SpreadsheetApp.flush();
        return { ok: true, id: body.id, updated: true };
      }
    }
    return { error: "Membre introuvable: " + body.id };
  }

  var id = Utilities.getUuid();
  var row = headers.map(function(h) {
    if (h === "id") return id;
    if (h === "createdAt") return new Date().toISOString();
    if (h === "actif") {
      if (body.actif === false || body.actif === "false") return "FALSE";
      return "TRUE";
    }
    return body[h] != null ? body[h] : "";
  });
  sh.appendRow(row);
  SpreadsheetApp.flush();
  return { ok: true, id: id, created: true };
}

function archiveMembre(id) {
  if (!id) return { error: "id requis" };
  var sh = ensureEquipeSheet();
  var data = sh.getDataRange().getValues();
  var headers = data[0];
  var idCol = headers.indexOf("id");
  var actifCol = headers.indexOf("actif");
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(id)) {
      if (actifCol >= 0) sh.getRange(i + 1, actifCol + 1).setValue("FALSE");
      SpreadsheetApp.flush();
      return { ok: true, id: id };
    }
  }
  return { error: "Membre introuvable: " + id };
}

// Affecte chauffeur / chef / monteurs à toutes les livraisons d'une tournée
function assignTournee(tourneeId, assignment) {
  if (!tourneeId) return { error: "tourneeId requis" };
  var ctx = ensureLivraisonsSchema();
  var sheet = ctx.sheet;
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var iTourneeId = headers.indexOf("tourneeId");
  var iChauffeur = headers.indexOf("chauffeurId");
  var iChef = headers.indexOf("chefEquipeId");
  var iMonteurs = headers.indexOf("monteurIds");
  var iNbMonteurs = headers.indexOf("nbMonteurs");
  var iChefIds = headers.indexOf("chefEquipeIds");
  if (iTourneeId < 0 || iChauffeur < 0 || iChef < 0 || iMonteurs < 0) {
    return { error: "Colonnes équipe manquantes, relance ensureLivraisonsSchema" };
  }
  var monteurIdsJson = Array.isArray(assignment.monteurIds)
    ? JSON.stringify(assignment.monteurIds)
    : (assignment.monteurIds || "");
  var chefEquipeIdsJson = Array.isArray(assignment.chefEquipeIds)
    ? JSON.stringify(assignment.chefEquipeIds)
    : (assignment.chefEquipeIds || "");
  var updated = 0;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iTourneeId]) === String(tourneeId)) {
      if (assignment.chauffeurId !== undefined) sheet.getRange(i + 1, iChauffeur + 1).setValue(assignment.chauffeurId || "");
      if (assignment.chefEquipeId !== undefined) sheet.getRange(i + 1, iChef + 1).setValue(assignment.chefEquipeId || "");
      if (assignment.chefEquipeIds !== undefined && iChefIds >= 0) sheet.getRange(i + 1, iChefIds + 1).setValue(chefEquipeIdsJson);
      if (assignment.monteurIds !== undefined) sheet.getRange(i + 1, iMonteurs + 1).setValue(monteurIdsJson);
      if (assignment.nbMonteurs !== undefined && iNbMonteurs >= 0) sheet.getRange(i + 1, iNbMonteurs + 1).setValue(Number(assignment.nbMonteurs) || 0);
      updated++;
    }
  }
  SpreadsheetApp.flush();
  if (updated === 0) return { error: "Aucune livraison trouvée pour cette tournée" };
  return { ok: true, tourneeId: tourneeId, updated: updated };
}

// ===========================================================================
// FNUCI + PHOTOS PAR VÉLO (process CEE)
// ===========================================================================

function _findVeloRow(veloId) {
  var meta = ensureVelosSchema();
  if (!meta.sheet) return null;
  var sheet = meta.sheet;
  var headers = meta.headers;
  var idCol = headers.indexOf("id");
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(veloId)) {
      return { sheet: sheet, headers: headers, row: data[i], rowIndex: i + 1 };
    }
  }
  return null;
}

function setVeloFnuci(veloId, fnuci) {
  if (!veloId) return { error: "veloId requis" };
  var clean = String(fnuci || "").trim();
  if (!clean) return { error: "FNUCI requis" };
  var found = _findVeloRow(veloId);
  if (!found) return { error: "Vélo introuvable: " + veloId };
  var fnuciCol = found.headers.indexOf("fnuci");
  if (fnuciCol < 0) return { error: "Colonne fnuci absente (relance ensureVelosSchema)" };
  found.sheet.getRange(found.rowIndex, fnuciCol + 1).setValue(clean);
  SpreadsheetApp.flush();
  return { ok: true, veloId: veloId, fnuci: clean };
}

// Affecte un FNUCI scanné à un client en l'inscrivant sur le 1er vélo non-affecté
// non-annulé du client. Vérifie d'abord que ce FNUCI n'est pas déjà utilisé ailleurs.
//
// Retours :
//   { ok: true, veloId, fnuci, restantPourClient }                — affecté
//   { error: "FNUCI déjà affecté", existingClient, ... }          — collision
//   { error: "Tous les vélos de ce client ont déjà un FNUCI" }    — saturé
function assignFnuciToClient(fnuci, clientId) {
  if (!fnuci) return { error: "fnuci requis" };
  if (!clientId) return { error: "clientId requis" };
  var clean = String(fnuci).trim();
  var meta = ensureVelosSchema();
  if (!meta.sheet) return { error: "Feuille Velos introuvable" };
  var sheet = meta.sheet;
  var headers = meta.headers;
  var iId = headers.indexOf("id");
  var iClientId = headers.indexOf("clientId");
  var iFnuci = headers.indexOf("fnuci");
  var iAnnule = headers.indexOf("annule");
  if (iId < 0 || iClientId < 0 || iFnuci < 0) return { error: "Colonnes Velos manquantes" };

  var data = sheet.getDataRange().getValues();

  // 1. Vérifier que ce FNUCI n'est pas déjà ailleurs
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var existingFnuci = String(row[iFnuci] || "").trim();
    var isAnnule = iAnnule >= 0 && (row[iAnnule] === true || row[iAnnule] === "TRUE");
    if (existingFnuci === clean && !isAnnule) {
      var ownerCid = String(row[iClientId] || "");
      if (ownerCid === String(clientId)) {
        return { ok: true, alreadyAssigned: true, veloId: row[iId], fnuci: clean, message: "Ce FNUCI est déjà sur ce client (rien à faire)." };
      }
      // Récupère le nom du client propriétaire pour le message d'erreur
      var ownerName = _getClientName(ownerCid);
      return { error: "FNUCI déjà affecté", existingClientId: ownerCid, existingClientName: ownerName, veloId: row[iId] };
    }
  }

  // 2. Trouver le 1er vélo de ce client sans FNUCI et non-annulé
  for (var j = 1; j < data.length; j++) {
    var r = data[j];
    if (String(r[iClientId]) !== String(clientId)) continue;
    if (iAnnule >= 0 && (r[iAnnule] === true || r[iAnnule] === "TRUE")) continue;
    if (String(r[iFnuci] || "").trim()) continue; // déjà un FNUCI
    sheet.getRange(j + 1, iFnuci + 1).setValue(clean);
    SpreadsheetApp.flush();
    // Recompte les restants
    var restant = 0;
    var dataAfter = sheet.getDataRange().getValues();
    for (var k = 1; k < dataAfter.length; k++) {
      var rr = dataAfter[k];
      if (String(rr[iClientId]) !== String(clientId)) continue;
      if (iAnnule >= 0 && (rr[iAnnule] === true || rr[iAnnule] === "TRUE")) continue;
      if (String(rr[iFnuci] || "").trim()) continue;
      restant++;
    }
    return { ok: true, veloId: r[iId], fnuci: clean, restantPourClient: restant };
  }

  return { error: "Tous les vélos de ce client ont déjà un FNUCI (ou sont annulés). Vérifie le nb commandé sur la fiche client." };
}

// Recherche un FNUCI dans la sheet Velos et renvoie le client associé.
// Utilisé en préparation commande pour valider un scan.
function lookupFnuci(fnuci) {
  if (!fnuci) return { found: false, error: "fnuci requis" };
  var clean = String(fnuci).trim();
  var meta = ensureVelosSchema();
  if (!meta.sheet) return { found: false, error: "Feuille Velos introuvable" };
  var headers = meta.headers;
  var iId = headers.indexOf("id");
  var iClientId = headers.indexOf("clientId");
  var iFnuci = headers.indexOf("fnuci");
  var iAnnule = headers.indexOf("annule");
  var data = meta.sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var f = String(row[iFnuci] || "").trim();
    if (f !== clean) continue;
    var isAnnule = iAnnule >= 0 && (row[iAnnule] === true || row[iAnnule] === "TRUE");
    if (isAnnule) continue;
    var cid = String(row[iClientId] || "");
    return {
      found: true,
      veloId: row[iId],
      clientId: cid,
      clientName: _getClientName(cid),
      fnuci: clean,
    };
  }
  return { found: false, fnuci: clean };
}

// Pour la page de préparation commande : renvoie l'état d'un client
// (nom, nb vélos commandés, FNUCI déjà affectés).
function getClientPreparation(clientId) {
  if (!clientId) return { error: "clientId requis" };
  var clientSheet = SS.getSheetByName("Clients");
  if (!clientSheet) return { error: "Feuille Clients introuvable" };
  var cData = clientSheet.getDataRange().getValues();
  var cHeaders = cData[0];
  var iCId = cHeaders.indexOf("id");
  var iCEntreprise = cHeaders.indexOf("entreprise");
  var iCAdresse = cHeaders.indexOf("adresse");
  var iCVille = cHeaders.indexOf("ville");
  var clientRow = null;
  for (var i = 1; i < cData.length; i++) {
    if (String(cData[i][iCId]) === String(clientId)) { clientRow = cData[i]; break; }
  }
  if (!clientRow) return { error: "Client introuvable" };

  var meta = ensureVelosSchema();
  if (!meta.sheet) return { error: "Feuille Velos introuvable" };
  var headers = meta.headers;
  var iId = headers.indexOf("id");
  var iClientId = headers.indexOf("clientId");
  var iFnuci = headers.indexOf("fnuci");
  var iAnnule = headers.indexOf("annule");
  var data = meta.sheet.getDataRange().getValues();

  var velos = [];
  for (var j = 1; j < data.length; j++) {
    var r = data[j];
    if (String(r[iClientId]) !== String(clientId)) continue;
    if (iAnnule >= 0 && (r[iAnnule] === true || r[iAnnule] === "TRUE")) continue;
    velos.push({
      veloId: r[iId],
      fnuci: String(r[iFnuci] || "").trim() || null,
    });
  }

  var avecFnuci = velos.filter(function(v) { return !!v.fnuci; });
  return {
    ok: true,
    clientId: clientId,
    entreprise: clientRow[iCEntreprise] || "",
    adresse: clientRow[iCAdresse] || "",
    ville: clientRow[iCVille] || "",
    nbVelosTotal: velos.length,
    nbVelosAvecFnuci: avecFnuci.length,
    nbVelosSansFnuci: velos.length - avecFnuci.length,
    fnuciAttendus: avecFnuci.map(function(v) { return v.fnuci; }),
  };
}

function _getClientName(clientId) {
  if (!clientId) return null;
  var sheet = SS.getSheetByName("Clients");
  if (!sheet) return null;
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var iId = headers.indexOf("id");
  var iEntreprise = headers.indexOf("entreprise");
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iId]) === String(clientId)) return data[i][iEntreprise] || null;
  }
  return null;
}

function _getClientFolder(clientId) {
  var sheet = SS.getSheetByName("Clients");
  if (!sheet) throw new Error("Feuille Clients introuvable");
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var entreprise = "sans-nom";
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === clientId) {
      entreprise = data[i][headers.indexOf("entreprise")] || "sans-nom";
      break;
    }
  }
  var safeName = String(entreprise).replace(/[^a-zA-Z0-9À-ÿ\s\-]/g, "").substring(0, 50);
  var parentFolder = DriveApp.getFolderById(DRIVE_PARENT_ID);
  var crmFolder = getOrCreateFolder(parentFolder, "DOCS CRM VELOS");
  return getOrCreateFolder(crmFolder, safeName + " [" + String(clientId).substring(0, 8) + "]");
}

// Upload une photo (base64) dans le dossier Photos livraison/YYYY-MM-DD du client.
// Body attendu : { veloId, kind: "velo"|"fnuci", fileName, fileData (base64), mimeType }
function uploadVeloPhoto(body) {
  if (!body || !body.veloId) return { error: "veloId requis" };
  if (!body.kind || (body.kind !== "velo" && body.kind !== "fnuci")) {
    return { error: "kind doit être 'velo' ou 'fnuci'" };
  }
  if (!body.fileData) return { error: "fileData requis (base64)" };
  var mimeType = body.mimeType || "image/jpeg";

  var found = _findVeloRow(body.veloId);
  if (!found) return { error: "Vélo introuvable: " + body.veloId };
  var headers = found.headers;
  var clientId = found.row[headers.indexOf("clientId")];

  var clientFolder = _getClientFolder(clientId);
  var photosRoot = getOrCreateFolder(clientFolder, "Photos livraison");
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  var dayFolder = getOrCreateFolder(photosRoot, today);

  var fnuci = found.row[headers.indexOf("fnuci")] || body.veloId.substring(0, 8);
  var suffix = body.kind === "fnuci" ? "_etiquette" : "_velo";
  var ext = "jpg";
  if (body.fileName && body.fileName.indexOf(".") >= 0) {
    var parts = body.fileName.split(".");
    ext = parts[parts.length - 1].toLowerCase();
  } else if (mimeType === "image/png") {
    ext = "png";
  }
  var fullName = String(fnuci) + suffix + "." + ext;

  var decoded = Utilities.base64Decode(body.fileData);
  var blob = Utilities.newBlob(decoded, mimeType, fullName);
  var file = dayFolder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  var fileUrl = file.getUrl();

  var colName = body.kind === "fnuci" ? "photoFnuciUrl" : "photoVeloUrl";
  var col = headers.indexOf(colName);
  if (col >= 0) found.sheet.getRange(found.rowIndex, col + 1).setValue(fileUrl);
  var dateCol = headers.indexOf("photoDate");
  if (dateCol >= 0) found.sheet.getRange(found.rowIndex, dateCol + 1).setValue(new Date().toISOString());
  SpreadsheetApp.flush();
  return { ok: true, veloId: body.veloId, kind: body.kind, url: fileUrl };
}

// Marque un vélo livré : requiert FNUCI + 2 photos. Sinon renvoie les champs manquants.
// Body : { veloId, fnuci?, photoVeloUrl?, photoFnuciUrl? }
function markVeloLivre(body) {
  if (!body || !body.veloId) return { error: "veloId requis" };
  var found = _findVeloRow(body.veloId);
  if (!found) return { error: "Vélo introuvable: " + body.veloId };
  var headers = found.headers;

  // Applique d'abord les valeurs fournies (FNUCI + photos)
  if (body.fnuci) {
    var fc = headers.indexOf("fnuci");
    if (fc >= 0) found.sheet.getRange(found.rowIndex, fc + 1).setValue(String(body.fnuci).trim());
  }
  if (body.photoVeloUrl) {
    var pv = headers.indexOf("photoVeloUrl");
    if (pv >= 0) found.sheet.getRange(found.rowIndex, pv + 1).setValue(body.photoVeloUrl);
  }
  if (body.photoFnuciUrl) {
    var pf = headers.indexOf("photoFnuciUrl");
    if (pf >= 0) found.sheet.getRange(found.rowIndex, pf + 1).setValue(body.photoFnuciUrl);
  }
  SpreadsheetApp.flush();

  // Relit la ligne
  found = _findVeloRow(body.veloId);
  headers = found.headers;
  var row = found.row;
  var missing = [];
  var fnuci = row[headers.indexOf("fnuci")];
  var photoVelo = row[headers.indexOf("photoVeloUrl")];
  var photoFnuci = row[headers.indexOf("photoFnuciUrl")];
  if (!fnuci || String(fnuci).trim() === "") missing.push("fnuci");
  if (!photoVelo) missing.push("photoVelo");
  if (!photoFnuci) missing.push("photoFnuci");
  if (missing.length > 0) {
    return { error: "Éléments manquants avant marquage livré", missing: missing };
  }

  // Marque photoQrPrise = TRUE (compat avec l'existant)
  var photoCol = headers.indexOf("photoQrPrise");
  if (photoCol >= 0) {
    found.sheet.getRange(found.rowIndex, photoCol + 1).setValue("TRUE");
  }
  SpreadsheetApp.flush();
  return { ok: true, veloId: body.veloId, livre: true, fnuci: fnuci };
}

// Données pour l'écran mobile "Tournée en cours" du chef d'équipe :
// - livraisons de la tournée (avec client + liste vélos)
// - équipe affectée (hydratée)
function getTourneeExecution(tourneeId) {
  if (!tourneeId) return { error: "tourneeId requis" };
  var ctx = ensureLivraisonsSchema();
  var sheet = ctx.sheet;
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var iTourneeId = headers.indexOf("tourneeId");
  var clientsSheet = SS.getSheetByName("Clients");
  var cData = clientsSheet.getDataRange().getValues();
  var cHeaders = cData[0];

  var velosMeta = ensureVelosSchema();
  var vSheet = velosMeta.sheet;
  var vHeaders = velosMeta.headers;
  var vData = vSheet ? vSheet.getDataRange().getValues() : [vHeaders];

  var livraisons = [];
  var chauffeurId = null, chefEquipeId = null, chefEquipeIds = [], monteurIds = [];
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iTourneeId]) !== String(tourneeId)) continue;
    var liv = {};
    headers.forEach(function(h, j) { liv[h] = data[i][j]; });
    if (typeof liv.monteurIds === "string" && liv.monteurIds) {
      try { liv.monteurIds = JSON.parse(liv.monteurIds); } catch (e) { liv.monteurIds = []; }
    }
    if (typeof liv.chefEquipeIds === "string" && liv.chefEquipeIds) {
      try { liv.chefEquipeIds = JSON.parse(liv.chefEquipeIds); } catch (e) { liv.chefEquipeIds = []; }
    }
    chauffeurId = liv.chauffeurId || chauffeurId;
    chefEquipeId = liv.chefEquipeId || chefEquipeId;
    if (Array.isArray(liv.chefEquipeIds) && liv.chefEquipeIds.length) chefEquipeIds = liv.chefEquipeIds;
    if (Array.isArray(liv.monteurIds) && liv.monteurIds.length) monteurIds = liv.monteurIds;

    var clientRow = cData.find(function(c) { return c[0] === liv.clientId; });
    liv.client = clientRow ? {
      id: liv.clientId,
      entreprise: clientRow[cHeaders.indexOf("entreprise")],
      ville: clientRow[cHeaders.indexOf("ville")],
      adresse: clientRow[cHeaders.indexOf("adresse")],
      codePostal: clientRow[cHeaders.indexOf("codePostal")],
      telephone: clientRow[cHeaders.indexOf("telephone")] || null,
      contact: clientRow[cHeaders.indexOf("contact")] || null,
      lat: Number(clientRow[cHeaders.indexOf("latitude")]) || null,
      lng: Number(clientRow[cHeaders.indexOf("longitude")]) || null
    } : null;

    // Vélos de ce client non encore livrés + non annulés
    var iVClient = vHeaders.indexOf("clientId");
    var iVAnnule = vHeaders.indexOf("annule");
    var iVPhoto = vHeaders.indexOf("photoQrPrise");
    var velos = [];
    for (var vi = 1; vi < vData.length; vi++) {
      if (vData[vi][iVClient] !== liv.clientId) continue;
      if (iVAnnule >= 0 && (vData[vi][iVAnnule] === true || vData[vi][iVAnnule] === "TRUE")) continue;
      var velo = {};
      vHeaders.forEach(function(h, j) { velo[h] = vData[vi][j]; });
      velo.livre = velo[vHeaders[iVPhoto]] === true || velo[vHeaders[iVPhoto]] === "TRUE" || velo.photoQrPrise === true || velo.photoQrPrise === "TRUE";
      velos.push(velo);
    }
    liv.velos = velos;
    livraisons.push(liv);
  }

  if (livraisons.length === 0) return { error: "Tournée introuvable: " + tourneeId };

  // Hydrate l'équipe
  var equipeById = {};
  var eMeta = ensureEquipeSheet();
  var eData = eMeta.getDataRange().getValues();
  var eHeaders = eData[0];
  var eIdCol = eHeaders.indexOf("id");
  for (var ei = 1; ei < eData.length; ei++) {
    equipeById[eData[ei][eIdCol]] = _equipeRowToObject(eData[ei], eHeaders);
  }
  var chauffeur = chauffeurId ? equipeById[chauffeurId] || null : null;
  var chefEquipe = chefEquipeId ? equipeById[chefEquipeId] || null : null;
  var chefsEquipe = (chefEquipeIds || []).map(function(cid) { return equipeById[cid] || null; }).filter(function(x) { return x; });
  var monteurs = (monteurIds || []).map(function(mid) { return equipeById[mid] || null; }).filter(function(x) { return x; });

  return {
    tourneeId: tourneeId,
    datePrevue: livraisons[0].datePrevue || null,
    mode: livraisons[0].mode || null,
    livraisons: livraisons,
    equipe: {
      chauffeur: chauffeur,
      chefEquipe: chefEquipe,
      chefsEquipe: chefsEquipe,
      monteurs: monteurs
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FLOTTE (camions) + DISPONIBILITES (qui/quoi est dispo quel jour)
// + proposeTournee (Gemini ventile les clients dans les camions du jour)
// ─────────────────────────────────────────────────────────────────────────────

var FLOTTE_SHEET_NAME = "Flotte";
var FLOTTE_COLS = ["id", "nom", "type", "capaciteVelos", "peutEntrerParis", "actif", "notes", "createdAt"];
var FLOTTE_TYPES = ["gros", "moyen", "petit", "retrait"];
var FLOTTE_SEED = [
  { nom: "Gros",          type: "gros",    capaciteVelos: 132, peutEntrerParis: false },
  { nom: "Moyen",         type: "moyen",   capaciteVelos: 54,  peutEntrerParis: true  },
  { nom: "Petit",         type: "petit",   capaciteVelos: 20,  peutEntrerParis: true  },
  { nom: "Retrait client", type: "retrait", capaciteVelos: 0,  peutEntrerParis: true  }
];

var DISPO_SHEET_NAME = "Disponibilites";
var DISPO_COLS = ["id", "date", "ressourceType", "ressourceId", "actif", "notes", "createdAt"];
var DISPO_TYPES = ["camion", "chauffeur", "chef", "monteur"];

function ensureFlotteSheet() {
  var sh = SS.getSheetByName(FLOTTE_SHEET_NAME);
  if (!sh) {
    sh = SS.insertSheet(FLOTTE_SHEET_NAME);
    sh.getRange(1, 1, 1, FLOTTE_COLS.length).setValues([FLOTTE_COLS]);
    sh.setFrozenRows(1);
    // Seed avec les 4 camions de référence
    for (var i = 0; i < FLOTTE_SEED.length; i++) {
      var s = FLOTTE_SEED[i];
      sh.appendRow([Utilities.getUuid(), s.nom, s.type, s.capaciteVelos, s.peutEntrerParis ? "TRUE" : "FALSE", "TRUE", "", new Date().toISOString()]);
    }
    return sh;
  }
  var lastCol = Math.max(1, sh.getLastColumn());
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var missing = FLOTTE_COLS.filter(function(c) { return headers.indexOf(c) < 0; });
  if (missing.length) {
    sh.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
  }
  return sh;
}

function ensureDisponibilitesSheet() {
  var sh = SS.getSheetByName(DISPO_SHEET_NAME);
  var fresh = false;
  if (!sh) {
    sh = SS.insertSheet(DISPO_SHEET_NAME);
    sh.getRange(1, 1, 1, DISPO_COLS.length).setValues([DISPO_COLS]);
    sh.setFrozenRows(1);
    fresh = true;
  } else {
    var lastCol = Math.max(1, sh.getLastColumn());
    var headersExisting = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    var missing = DISPO_COLS.filter(function(c) { return headersExisting.indexOf(c) < 0; });
    if (missing.length) {
      sh.getRange(1, headersExisting.length + 1, 1, missing.length).setValues([missing]);
    }
  }
  // Force la colonne "date" en TEXTE pour éviter les décalages timezone que Sheets
  // applique quand il auto-détecte une chaîne ISO comme un Date object.
  var headersNow = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var iDate = headersNow.indexOf("date");
  if (iDate >= 0) {
    sh.getRange(1, iDate + 1, sh.getMaxRows(), 1).setNumberFormat("@");
    // Migration : si des rows existent avec Date object dans la col date (avant le fix),
    // les réécrire en texte yyyy-MM-dd basé sur le timezone du SHEET (la même que celle
    // utilisée par Sheets pour interpréter le timestamp interne).
    if (!fresh) {
      var lastRow = sh.getLastRow();
      if (lastRow > 1) {
        var range = sh.getRange(2, iDate + 1, lastRow - 1, 1);
        var values = range.getValues();
        var tz = SS.getSpreadsheetTimeZone();
        var changed = false;
        for (var r = 0; r < values.length; r++) {
          var v = values[r][0];
          if (v instanceof Date) {
            values[r][0] = Utilities.formatDate(v, tz, "yyyy-MM-dd");
            changed = true;
          }
        }
        if (changed) range.setValues(values);
      }
    }
  }
  return sh;
}

function _flotteRowToObject(row, headers) {
  var o = {};
  headers.forEach(function(h, j) { o[h] = row[j]; });
  o.actif = (o.actif === true || o.actif === "TRUE");
  o.peutEntrerParis = (o.peutEntrerParis === true || o.peutEntrerParis === "TRUE");
  o.capaciteVelos = Number(o.capaciteVelos) || 0;
  return o;
}

function listFlotte(params) {
  var sh = ensureFlotteSheet();
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return { items: [] };
  var headers = data[0];
  var includeInactifs = params && (params.includeInactifs === "true" || params.includeInactifs === true);
  var items = [];
  for (var i = 1; i < data.length; i++) {
    var o = _flotteRowToObject(data[i], headers);
    if (!includeInactifs && !o.actif) continue;
    items.push(o);
  }
  items.sort(function(a, b) { return (b.capaciteVelos || 0) - (a.capaciteVelos || 0); });
  return { items: items };
}

function upsertCamion(body) {
  if (!body || !body.nom) return { error: "Nom requis" };
  if (body.type && FLOTTE_TYPES.indexOf(body.type) < 0) return { error: "Type invalide (" + FLOTTE_TYPES.join("/") + ")" };
  var sh = ensureFlotteSheet();
  var data = sh.getDataRange().getValues();
  var headers = data[0];
  var idCol = headers.indexOf("id");

  if (body.id) {
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][idCol]) === String(body.id)) {
        FLOTTE_COLS.forEach(function(col) {
          if (col === "id" || col === "createdAt") return;
          if (body[col] === undefined) return;
          var c = headers.indexOf(col);
          if (c < 0) return;
          var val = body[col];
          if (col === "actif" || col === "peutEntrerParis") val = (val === true || val === "true" || val === "TRUE") ? "TRUE" : "FALSE";
          if (col === "capaciteVelos") val = Number(val) || 0;
          sh.getRange(i + 1, c + 1).setValue(val);
        });
        SpreadsheetApp.flush();
        return { ok: true, id: body.id, updated: true };
      }
    }
    return { error: "Camion introuvable: " + body.id };
  }

  var id = Utilities.getUuid();
  var row = headers.map(function(h) {
    if (h === "id") return id;
    if (h === "createdAt") return new Date().toISOString();
    if (h === "actif") return body.actif === false ? "FALSE" : "TRUE";
    if (h === "peutEntrerParis") return (body.peutEntrerParis === true || body.peutEntrerParis === "true" || body.peutEntrerParis === "TRUE") ? "TRUE" : "FALSE";
    if (h === "capaciteVelos") return Number(body.capaciteVelos) || 0;
    return body[h] != null ? body[h] : "";
  });
  sh.appendRow(row);
  SpreadsheetApp.flush();
  return { ok: true, id: id, created: true };
}

function archiveCamion(id) {
  if (!id) return { error: "id requis" };
  var sh = ensureFlotteSheet();
  var data = sh.getDataRange().getValues();
  var headers = data[0];
  var idCol = headers.indexOf("id");
  var actifCol = headers.indexOf("actif");
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(id)) {
      if (actifCol >= 0) sh.getRange(i + 1, actifCol + 1).setValue("FALSE");
      SpreadsheetApp.flush();
      return { ok: true, id: id };
    }
  }
  return { error: "Camion introuvable: " + id };
}

function _dispoRowToObject(row, headers) {
  var o = {};
  headers.forEach(function(h, j) {
    var v = row[j];
    if (v instanceof Date && h === "date") o[h] = Utilities.formatDate(v, SS.getSpreadsheetTimeZone(), "yyyy-MM-dd");
    else o[h] = v;
  });
  o.actif = (o.actif === true || o.actif === "TRUE");
  return o;
}

function listDisponibilites(params) {
  var sh = ensureDisponibilitesSheet();
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return { items: [] };
  var headers = data[0];
  var dateFilter = params && params.date ? String(params.date) : null;
  var typeFilter = params && params.ressourceType ? String(params.ressourceType) : null;
  var items = [];
  for (var i = 1; i < data.length; i++) {
    var o = _dispoRowToObject(data[i], headers);
    if (!o.actif) continue;
    if (dateFilter && String(o.date) !== dateFilter) continue;
    if (typeFilter && o.ressourceType !== typeFilter) continue;
    items.push(o);
  }
  return { items: items };
}

// Body : { date: "YYYY-MM-DD", camionIds: [...], chauffeurIds: [...], chefIds: [...], monteurIds: [...] }
// Remplace l'état du jour : tout ce qui n'est pas dans la liste est archivé,
// tout ce qui est dans la liste mais pas en sheet est créé.
function setDisponibilites(body) {
  if (!body || !body.date) return { error: "date requise (YYYY-MM-DD)" };
  var date = String(body.date);
  var desired = {
    camion:    Array.isArray(body.camionIds)    ? body.camionIds    : [],
    chauffeur: Array.isArray(body.chauffeurIds) ? body.chauffeurIds : [],
    chef:      Array.isArray(body.chefIds)      ? body.chefIds      : [],
    monteur:   Array.isArray(body.monteurIds)   ? body.monteurIds   : []
  };

  var sh = ensureDisponibilitesSheet();
  var data = sh.getDataRange().getValues();
  var headers = data[0];
  var iId = headers.indexOf("id");
  var iDate = headers.indexOf("date");
  var iType = headers.indexOf("ressourceType");
  var iRessId = headers.indexOf("ressourceId");
  var iActif = headers.indexOf("actif");
  var iNotes = headers.indexOf("notes");
  var iCreated = headers.indexOf("createdAt");

  // Construit l'index existant pour cette date
  var existing = {}; // key = type + "|" + ressourceId → row index (1-based) + actif
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (String(r[iDate]) === date || (r[iDate] instanceof Date && Utilities.formatDate(r[iDate], SS.getSpreadsheetTimeZone(), "yyyy-MM-dd") === date)) {
      var key = r[iType] + "|" + r[iRessId];
      existing[key] = { row: i + 1, actif: (r[iActif] === true || r[iActif] === "TRUE") };
    }
  }

  var added = 0, reactivated = 0, archived = 0;
  // Phase 1 : ajouter ou réactiver les ressources voulues
  Object.keys(desired).forEach(function(type) {
    desired[type].forEach(function(rid) {
      if (!rid) return;
      var key = type + "|" + rid;
      if (existing[key]) {
        if (!existing[key].actif) {
          sh.getRange(existing[key].row, iActif + 1).setValue("TRUE");
          reactivated++;
        }
      } else {
        var newRow = headers.map(function(h) {
          if (h === "id") return Utilities.getUuid();
          if (h === "date") return "'" + date; // apostrophe force texte (anti timezone shift)
          if (h === "ressourceType") return type;
          if (h === "ressourceId") return rid;
          if (h === "actif") return "TRUE";
          if (h === "createdAt") return new Date().toISOString();
          return "";
        });
        sh.appendRow(newRow);
        added++;
      }
    });
  });

  // Phase 2 : archiver tout ce qui existe en sheet pour cette date mais pas demandé
  Object.keys(existing).forEach(function(key) {
    var parts = key.split("|");
    var type = parts[0];
    var rid = parts[1];
    if (!existing[key].actif) return; // déjà archivé
    var stillWanted = (desired[type] || []).indexOf(rid) >= 0;
    if (!stillWanted) {
      sh.getRange(existing[key].row, iActif + 1).setValue("FALSE");
      archived++;
    }
  });

  SpreadsheetApp.flush();
  return { ok: true, date: date, added: added, reactivated: reactivated, archived: archived };
}

// ─── Capacité du jour : calcule ce qui est dispo + déjà affecté ─────────────
function _capaciteDuJour(date) {
  var dispos = listDisponibilites({ date: date }).items;
  var flotte = listFlotte({}).items;
  var equipe = listEquipe({}).items;

  var camionIds = dispos.filter(function(d) { return d.ressourceType === "camion"; }).map(function(d) { return d.ressourceId; });
  var chauffeurIds = dispos.filter(function(d) { return d.ressourceType === "chauffeur"; }).map(function(d) { return d.ressourceId; });
  var chefIds = dispos.filter(function(d) { return d.ressourceType === "chef"; }).map(function(d) { return d.ressourceId; });
  var monteurIds = dispos.filter(function(d) { return d.ressourceType === "monteur"; }).map(function(d) { return d.ressourceId; });

  var camions = flotte.filter(function(c) { return camionIds.indexOf(c.id) >= 0; });
  var chauffeurs = equipe.filter(function(m) { return m.role === "chauffeur" && chauffeurIds.indexOf(m.id) >= 0; });
  var chefs = equipe.filter(function(m) { return m.role === "chef" && chefIds.indexOf(m.id) >= 0; });
  var monteurs = equipe.filter(function(m) { return m.role === "monteur" && monteurIds.indexOf(m.id) >= 0; });

  return {
    camions: camions,
    chauffeurs: chauffeurs,
    chefs: chefs,
    monteurs: monteurs,
    capaciteTotaleVelos: camions.reduce(function(s, c) { return s + (c.capaciteVelos || 0); }, 0)
  };
}

// Identifie si un client est intra-Paris (codePostal commence par 75 + 75001..75020)
function _estParis(client) {
  var cp = String(client.codePostal || "").trim();
  return /^750\d{2}$/.test(cp) && Number(cp) >= 75001 && Number(cp) <= 75020;
}

// Retourne les clients pas encore affectés à une tournée pour la date.
// Règle métier : 1 client = 1 livraison intégrale (pas de split entre
// dates). Donc tout client ayant DÉJÀ une livraison pending (toute date,
// statut non annulé/livré) est totalement exclu — il est déjà couvert.
function _clientsLivrablesPourDate(date) {
  var allClients = getClients({}); // existant
  var clientsParId = {};
  for (var i = 0; i < allClients.length; i++) clientsParId[allClients[i].id] = allClients[i];

  var livrSheet = SS.getSheetByName("Livraisons");
  if (!livrSheet) {
    var dispoSansLivr = [];
    for (var k in clientsParId) if (_clientLivrable(clientsParId[k])) dispoSansLivr.push(clientsParId[k]);
    return { affectes: {}, dispo: dispoSansLivr };
  }
  var lvData = livrSheet.getDataRange().getValues();
  if (lvData.length < 2) {
    var dispoVide = [];
    for (var k2 in clientsParId) if (_clientLivrable(clientsParId[k2])) dispoVide.push(clientsParId[k2]);
    return { affectes: {}, dispo: dispoVide };
  }

  var lvHeaders = lvData[0];
  var iLvClientId = lvHeaders.indexOf("clientId");
  var iLvDate = lvHeaders.indexOf("date");
  var iLvStatus = lvHeaders.indexOf("statut");
  var iLvNbVelos = lvHeaders.indexOf("nbVelos");
  var iLvTourneeId = lvHeaders.indexOf("tourneeId");

  var affectesParTournee = {}; // tourneeId → [{clientId, nbVelos, ...}] pour LA date
  var clientIdsAvecLivraisonPending = {}; // clientId → true si une livraison non annulée/non livrée existe N'IMPORTE OÙ
  var dateDePending = {}; // clientId → date de la pending (la première trouvée), pour info

  for (var li = 1; li < lvData.length; li++) {
    var lvRow = lvData[li];
    var statut = String(lvRow[iLvStatus] || "").toLowerCase();
    if (statut === "annulee" || statut === "annulée" || statut === "livrée" || statut === "livree") continue;
    var lvDate = lvRow[iLvDate];
    var lvDateStr = lvDate instanceof Date ? Utilities.formatDate(lvDate, Session.getScriptTimeZone(), "yyyy-MM-dd") : String(lvDate);
    var cid = String(lvRow[iLvClientId]);
    var tid = String(lvRow[iLvTourneeId] || "");
    var nb = Number(lvRow[iLvNbVelos]) || 0;

    clientIdsAvecLivraisonPending[cid] = true;
    if (!dateDePending[cid]) dateDePending[cid] = lvDateStr;

    if (lvDateStr === date) {
      if (!affectesParTournee[tid]) affectesParTournee[tid] = [];
      affectesParTournee[tid].push({ clientId: cid, nbVelos: nb, client: clientsParId[cid] || null });
    }
  }

  var dispo = [];
  for (var cid2 in clientsParId) {
    if (clientIdsAvecLivraisonPending[cid2]) continue; // déjà couvert par une livraison existante
    var c = clientsParId[cid2];
    if (!_clientLivrable(c)) continue;
    dispo.push(c);
  }
  return { affectes: affectesParTournee, dispo: dispo };
}

function _clientLivrable(c) {
  if (!c) return false;
  var nbCmd = Number(c.nbVelosCommandes || 0);
  var nbLivre = Number(c.nbVelosLivres || 0);
  if (nbCmd <= 0) return false;
  if (nbLivre >= nbCmd) return false;
  if (c.latitude == null || c.longitude == null) return false;
  return true;
}

// Distance Haversine entre deux lat/lng en km
function _distanceKm(lat1, lng1, lat2, lng2) {
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return 9999;
  var R = 6371;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLng = (lng2 - lng1) * Math.PI / 180;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
          Math.sin(dLng / 2) * Math.sin(dLng / 2);
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// AXDIS PRO - Le Blanc-Mesnil
var DEPOT_LAT = 48.9356;
var DEPOT_LNG = 2.4636;

// Endpoint principal : appelle Gemini pour proposer ou compléter la tournée
// payload = { date: "YYYY-MM-DD", mode: "fillGaps" | "fromScratch" }
function proposeTournee(payload) {
  if (!payload || !payload.date) return { error: "date requise" };
  var date = payload.date;
  var mode = payload.mode || "fillGaps";

  var apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!apiKey) return { error: "GEMINI_API_KEY manquante dans Script Properties" };

  var capa = _capaciteDuJour(date);
  if (capa.camions.length === 0) return { error: "Aucun camion déclaré disponible pour le " + date + ". Renseigne les dispos du jour." };

  var ctx = _clientsLivrablesPourDate(date);

  // Capacité restante par camion (tournée existante = somme nbVelos affectés à cette tournée)
  // Note : on ne sait pas encore quel tourneeId correspond à quel camion. Si l'user a déjà
  // assigné un camion à une tournée, on lit ça. Sinon on traite chaque tournée comme ouverte.
  var camionsAvecRestant = capa.camions.map(function(c) {
    return {
      id: c.id,
      nom: c.nom,
      type: c.type,
      capaciteVelos: c.capaciteVelos,
      peutEntrerParis: c.peutEntrerParis,
      restant: c.capaciteVelos
    };
  });

  // Calcul affectation existante : pour fillGaps, on déduit le déjà affecté
  var totalAffecte = 0;
  Object.keys(ctx.affectes).forEach(function(tid) {
    ctx.affectes[tid].forEach(function(a) { totalAffecte += a.nbVelos; });
  });

  // Enrichit les clients avec distance dépôt
  var clientsEnrichis = ctx.dispo.map(function(c) {
    var restant = Math.max(0, Number(c.nbVelosCommandes || 0) - Number(c.nbVelosLivres || 0));
    return {
      id: c.id,
      entreprise: c.entreprise,
      ville: c.ville,
      codePostal: c.codePostal,
      nbVelosRestants: restant,
      estParis: _estParis(c),
      distanceKmDepot: Math.round(_distanceKm(DEPOT_LAT, DEPOT_LNG, c.latitude, c.longitude) * 10) / 10,
      apporteur: c.apporteur || null
    };
  }).filter(function(c) { return c.nbVelosRestants > 0; });

  if (clientsEnrichis.length === 0) {
    return { ok: true, date: date, message: "Aucun client à livrer pour ce jour (déjà tout affecté ou rien à faire).", proposition: { tournees: [] } };
  }

  // Règle : 1 client = 1 livraison intégrale. Donc tout client dont la commande
  // dépasse la capa max d'un seul camion motorisé dispo est livrable uniquement
  // en retrait client. Si pas de retrait dispo → impossible aujourd'hui.
  var camionsMotorises = camionsAvecRestant.filter(function(c) { return c.type !== "retrait"; });
  var capaMaxMotorisee = camionsMotorises.reduce(function(m, c) { return Math.max(m, c.capaciteVelos || 0); }, 0);
  var aRetrait = camionsAvecRestant.some(function(c) { return c.type === "retrait"; });

  var clientsTropGros = [];
  if (!aRetrait) {
    // Filtre les clients > capa max motorisée et les surface
    clientsEnrichis = clientsEnrichis.filter(function(c) {
      if (c.nbVelosRestants > capaMaxMotorisee) {
        clientsTropGros.push({
          clientId: c.id,
          entreprise: c.entreprise,
          ville: c.ville,
          nbVelosRestants: c.nbVelosRestants,
          raison: "Commande de " + c.nbVelosRestants + "v > capacité max camion dispo (" + capaMaxMotorisee + "v) et pas de retrait client. Active un plus gros camion ou le retrait."
        });
        return false;
      }
      return true;
    });
  }

  // Tri par distance dépôt croissante (input sorted pour Gemini)
  clientsEnrichis.sort(function(a, b) { return a.distanceKmDepot - b.distanceKmDepot; });

  var prompt = _buildProposeTourneePrompt(date, camionsAvecRestant, clientsEnrichis, ctx.affectes, mode, capa);

  var url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + apiKey;
  var requestPayload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 32768,
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 0 }
    }
  };

  var retryDelays = [0, 2000, 5000];
  var lastCode = null, lastBody = "";
  for (var attempt = 0; attempt < retryDelays.length; attempt++) {
    if (retryDelays[attempt] > 0) Utilities.sleep(retryDelays[attempt]);
    try {
      var res = UrlFetchApp.fetch(url, {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify(requestPayload),
        muteHttpExceptions: true
      });
      lastCode = res.getResponseCode();
      if (lastCode === 200) {
        var data = JSON.parse(res.getContentText());
        var cand = (data.candidates || [])[0] || {};
        var parts = (cand.content || {}).parts;
        var finishReason = cand.finishReason || null;
        if (!parts || !parts[0] || !parts[0].text) return { error: "Réponse Gemini vide", finishReason: finishReason };
        var raw = parts[0].text;
        var cleaned = raw
          .replace(/^﻿/, "")
          .replace(/^\s*```(?:json)?\s*\n?/i, "")
          .replace(/\n?\s*```\s*$/i, "")
          .trim();
        try {
          var parsed = JSON.parse(cleaned);
          return {
            ok: true,
            date: date,
            mode: mode,
            capacite: {
              camions: camionsAvecRestant,
              chauffeurs: capa.chauffeurs.length,
              chefs: capa.chefs.length,
              monteurs: capa.monteurs.length,
              capaciteTotaleVelos: capa.capaciteTotaleVelos,
              dejaAffecte: totalAffecte
            },
            clientsCandidats: clientsEnrichis.length,
            clientsTropGros: clientsTropGros,
            proposition: parsed
          };
        } catch (parseErr) {
          return {
            error: "Réponse Gemini non-JSON",
            parseError: String(parseErr && parseErr.message || parseErr),
            finishReason: finishReason,
            rawLength: raw.length,
            rawHead: cleaned.slice(0, 400),
            rawTail: cleaned.slice(-400)
          };
        }
      }
      lastBody = res.getContentText();
      if (lastCode !== 503 && lastCode !== 429 && lastCode !== 500) break;
    } catch (err) {
      return { error: "Exception Gemini : " + err.message };
    }
  }
  return { error: "Gemini HTTP " + lastCode, body: lastBody.slice(0, 300) };
}

function _buildProposeTourneePrompt(date, camions, clients, affectesExistants, mode, capa) {
  var camionsStr = camions.map(function(c) {
    var noteRetrait = c.type === "retrait" ? ", RETRAIT CLIENT (le client vient chercher avec son propre véhicule, pas besoin de chauffeur côté nous, mais besoin monteurs+chef pour préparer/assembler avant remise)" : "";
    var capStr = c.type === "retrait" && c.capaciteVelos === 0
      ? "capacité non plafonnée (à toi de mettre un volume raisonnable selon les monteurs dispo)"
      : "capacité " + c.capaciteVelos + " vélos";
    return "- " + c.nom + " (id=" + c.id + ", type=" + c.type + ", " + capStr + ", " + (c.peutEntrerParis ? "PEUT entrer Paris" : "NE PEUT PAS entrer Paris (>3.5T)") + noteRetrait + ")";
  }).join("\n");

  var equipeStr = "ÉQUIPE DISPONIBLE CE JOUR :\n" +
    "- Chauffeurs : " + (capa.chauffeurs.map(function(m) { return m.nom; }).join(", ") || "aucun") + "\n" +
    "- Chefs d'équipe : " + (capa.chefs.map(function(m) { return m.nom; }).join(", ") || "aucun") + "\n" +
    "- Monteurs : " + (capa.monteurs.map(function(m) { return m.nom; }).join(", ") || "aucun");

  var clientsStr = clients.map(function(c) {
    return "- " + c.entreprise + " (id=" + c.id + ", " + c.codePostal + " " + c.ville + ", " + c.nbVelosRestants + " vélos restants, " + c.distanceKmDepot + "km dépôt" + (c.estParis ? ", PARIS intra-muros" : "") + ")";
  }).join("\n");

  var affectesStr = "Aucune affectation existante.";
  var affectesIds = Object.keys(affectesExistants);
  if (affectesIds.length > 0) {
    affectesStr = "Tournées déjà partiellement remplies (à compléter sans modifier l'existant) :\n";
    affectesIds.forEach(function(tid) {
      var lignes = affectesExistants[tid];
      var totalT = lignes.reduce(function(s, l) { return s + l.nbVelos; }, 0);
      affectesStr += "- Tournée " + tid + " : " + lignes.length + " arrêt(s), " + totalT + " vélos\n";
      lignes.forEach(function(l) {
        affectesStr += "    · " + (l.client ? l.client.entreprise : l.clientId) + " (" + l.nbVelos + "v)\n";
      });
    });
  }

  var modeInstr = mode === "fromScratch"
    ? "Mode FROM SCRATCH : ignore les tournées existantes et propose une ventilation complète à partir de zéro."
    : "Mode FILL GAPS : si des tournées existent déjà (cf bloc 'Tournées déjà partiellement remplies'), NE LES MODIFIE PAS. Propose seulement des AJOUTS de clients dans ces tournées si la capacité du camion le permet, ou de nouvelles tournées avec les camions encore non utilisés.";

  return [
    "Tu es un planificateur de tournées de livraison de vélos cargo.",
    "DÉPÔT DE DÉPART : AXDIS PRO, 2 Rue des Frères Lumière, 93150 Le Blanc-Mesnil (lat " + DEPOT_LAT + ", lng " + DEPOT_LNG + ").",
    "DATE DE LIVRAISON : " + date,
    "",
    "RESSOURCES DISPONIBLES — CAMIONS :",
    camionsStr,
    "",
    equipeStr,
    "",
    affectesStr,
    "",
    "CLIENTS À LIVRER (triés par distance dépôt croissante) :",
    clientsStr,
    "",
    "CONTRAINTES STRICTES :",
    "1. Un camion 'NE PEUT PAS entrer Paris' (>3.5T) ne peut PAS livrer un client marqué 'PARIS intra-muros'. Affecte ces clients uniquement aux camions qui PEUVENT entrer Paris.",
    "2. La somme des vélos d'une tournée ≤ capacité du camion (capaciteVelos). NE DÉPASSE JAMAIS la capacité.",
    "3. " + modeInstr,
    "4. Boucle Paris en priorité (vide les arrondissements 75001-75020 d'abord avec les petits camions, libère les chauffeurs vite).",
    "5. Pour chaque tournée, ordonne les clients du PLUS PROCHE au PLUS LOIN du dépôt.",
    "6. Maximise le nombre TOTAL de vélos livrés ce jour, mais SANS sacrifier la cohérence géographique : ne mélange pas un client de Bordeaux avec un client de Lille.",
    "7. INTERDICTION DE SPLITTER UN CLIENT. Chaque client doit recevoir TOUS ses vélos (nbVelosRestants) en UNE SEULE livraison dans UNE SEULE tournée. Si la commande d'un client ne tient pas dans le camion auquel tu l'affectes, choisis un autre camion plus gros, OU laisse ce client dans clientsNonAffectes avec raison='commande trop grosse pour la flotte du jour'. Le nbVelos d'un arrêt doit TOUJOURS = nbVelosRestants du client.",
    "",
    "FORMAT DE RÉPONSE (JSON STRICT, rien d'autre) :",
    "{",
    "  \"tournees\": [",
    "    {",
    "      \"camionId\": \"...\",",
    "      \"camionNom\": \"...\",",
    "      \"totalVelos\": N,",
    "      \"arrets\": [",
    "        { \"clientId\": \"...\", \"entreprise\": \"...\", \"nbVelos\": N, \"distanceKmDepot\": N, \"motif\": \"raison courte\" }",
    "      ],",
    "      \"motifGlobal\": \"pourquoi cette ventilation pour ce camion\"",
    "    }",
    "  ],",
    "  \"clientsNonAffectes\": [",
    "    { \"clientId\": \"...\", \"entreprise\": \"...\", \"nbVelos\": N, \"raison\": \"trop loin / pas de camion adapté / capacité saturée\" }",
    "  ],",
    "  \"resume\": \"phrase courte expliquant la stratégie globale\"",
    "}"
  ].join("\n");
}
