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

function getClients(params) {
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
    ["devisSignee","kbisRecu","attestationRecue","signatureOk","inscriptionBicycle","parcelleCadastrale"
    ].forEach(function(f) {
      c[f] = c[f] === true || c[f] === "TRUE";
    });

    var clientVelos = velosRows.filter(function(v) {
      return v[velosHeaders.indexOf("clientId")] === c.id;
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

  ["devisSignee","kbisRecu","attestationRecue","signatureOk","inscriptionBicycle","parcelleCadastrale"
  ].forEach(function(f) {
    client[f] = client[f] === true || client[f] === "TRUE";
  });

  var velosSheet = SS.getSheetByName("Velos");
  var velosData = velosSheet.getDataRange().getValues();
  var velosHeaders = velosData[0];
  var velosRows = velosData.slice(1);

  client.velos = velosRows
    .filter(function(v) { return v[velosHeaders.indexOf("clientId")] === id; })
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
  var totalVelos = vRows.length;

  var isBool = function(val) { return val === true || val === "TRUE"; };

  var velosLivres = vRows.filter(function(v) { return isBool(v[vHeaders.indexOf("photoQrPrise")]); }).length;
  var certificatsRecus = vRows.filter(function(v) { return isBool(v[vHeaders.indexOf("certificatRecu")]); }).length;
  var velosFacturables = vRows.filter(function(v) { return isBool(v[vHeaders.indexOf("facturable")]); }).length;
  var velosFactures = vRows.filter(function(v) { return isBool(v[vHeaders.indexOf("facture")]); }).length;

  var docFields = ["devisSignee","kbisRecu","attestationRecue","signatureOk","inscriptionBicycle","parcelleCadastrale"];
  var clientsDocsComplets = cRows.filter(function(c) {
    return docFields.every(function(f) { return isBool(c[cHeaders.indexOf(f)]); });
  }).length;

  var progression = totalVelos > 0 ? Math.round((velosLivres / totalVelos) * 100) : 0;

  return {
    totalClients: totalClients,
    totalVelos: totalVelos,
    velosLivres: velosLivres,
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
    sheet.getRange(1, 1, 1, 9).setValues([[
      "id","clientId","datePrevue","dateEffective","statut","notes",
      "nbVelos","tourneeId","mode"
    ]]);
    return { sheet: sheet, headers: ["id","clientId","datePrevue","dateEffective","statut","notes","nbVelos","tourneeId","mode"] };
  }

  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var needed = ["nbVelos","tourneeId","mode"];
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

  var capacite = 54;
  maxDistance = maxDistance || 50;

  // Reste = commandé - livré - déjà planifié (livraisons "planifiee" ou "en_cours")
  var velosTarget = target.nbVelos - target.velosLivres - (target.velosPlanifies || 0);
  if (velosTarget <= 0) {
    return { error: "Aucun vélo à planifier pour ce client (tout livré ou déjà planifié)." };
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
      departement: clientRow[cHeaders.indexOf("departement")]
    } : { entreprise: "?", ville: "", adresse: "" };
    var nbVelos = Number(liv.nbVelos) || 0;
    if (!nbVelos && liv.notes) {
      var m = String(liv.notes).match(/(\d+)\s+vélos?/);
      if (m) nbVelos = parseInt(m[1], 10);
    }
    liv._count = { velos: nbVelos };
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

  // 2) Requête cadastre via apicarto.ign.fr
  var cadastreUrl = "https://apicarto.ign.fr/api/cadastre/parcelle?geom=" +
    encodeURIComponent('{"type":"Point","coordinates":[' + lng + ',' + lat + ']}') +
    "&_limit=1";
  var cadRes = UrlFetchApp.fetch(cadastreUrl, { muteHttpExceptions: true });
  if (cadRes.getResponseCode() !== 200) return { error: "Erreur API cadastre : HTTP " + cadRes.getResponseCode() };

  var cadData = JSON.parse(cadRes.getContentText());
  if (!cadData.features || cadData.features.length === 0) return { error: "Aucune parcelle trouvée pour ces coordonnées." };

  var props = cadData.features[0].properties;
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
