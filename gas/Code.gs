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
      case "updateLivraison":
        var bodyUL = getBody();
        result = updateLivraison(bodyUL.id || e.parameter.id, bodyUL.data || bodyUL);
        break;
      case "deleteLivraison":
        result = deleteLivraison(e.parameter.id);
        break;
      case "updateVelos":
        var bodyUV = getBody();
        result = updateVelos(bodyUV);
        break;
      case "uploadDoc":
        var bodyUD = getBody();
        result = uploadDoc(bodyUD);
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

  var clients = rows.map(function(row) {
    var c = {};
    headers.forEach(function(h, i) { c[h] = row[i]; });
    c.devisSignee = c.devisSignee === true || c.devisSignee === "TRUE";
    c.kbisRecu = c.kbisRecu === true || c.kbisRecu === "TRUE";
    c.attestationRecue = c.attestationRecue === true || c.attestationRecue === "TRUE";
    c.signatureOk = c.signatureOk === true || c.signatureOk === "TRUE";
    c.inscriptionBicycle = c.inscriptionBicycle === true || c.inscriptionBicycle === "TRUE";

    var clientVelos = velosRows.filter(function(v) {
      return v[velosHeaders.indexOf("clientId")] === c.id;
    });

    c.stats = {
      totalVelos: clientVelos.length,
      livres: clientVelos.filter(function(v) { return v[velosHeaders.indexOf("photoQrPrise")] === true || v[velosHeaders.indexOf("photoQrPrise")] === "TRUE"; }).length,
      certificats: clientVelos.filter(function(v) { return v[velosHeaders.indexOf("certificatRecu")] === true || v[velosHeaders.indexOf("certificatRecu")] === "TRUE"; }).length,
      facturables: clientVelos.filter(function(v) { return v[velosHeaders.indexOf("facturable")] === true || v[velosHeaders.indexOf("facturable")] === "TRUE"; }).length,
      factures: clientVelos.filter(function(v) { return v[velosHeaders.indexOf("facture")] === true || v[velosHeaders.indexOf("facture")] === "TRUE"; }).length,
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

  ["devisSignee","kbisRecu","attestationRecue","signatureOk","inscriptionBicycle"].forEach(function(f) {
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

  var clientsDocsComplets = cRows.filter(function(c) {
    return isBool(c[cHeaders.indexOf("kbisRecu")]) &&
           isBool(c[cHeaders.indexOf("attestationRecue")]) &&
           isBool(c[cHeaders.indexOf("signatureOk")]);
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
      };
    });
}

function suggestTournee(clientId, mode, maxDistance) {
  var points = getCarte();
  var target = null;
  for (var i = 0; i < points.length; i++) {
    if (points[i].id === clientId) { target = points[i]; break; }
  }
  if (!target) return { error: "Client non trouvé" };

  var capacite = mode === "sursite" ? 54 : 6;
  maxDistance = maxDistance || 50;

  var nearby = points
    .filter(function(c) { return c.id !== clientId; })
    .map(function(c) {
      c.distance = haversineKm(target.lat, target.lng, c.lat, c.lng);
      c.velosRestants = c.nbVelos - c.velosLivres;
      return c;
    })
    .filter(function(c) { return c.distance <= maxDistance && c.velosRestants > 0; })
    .sort(function(a, b) { return a.distance - b.distance; });

  var velosTarget = target.nbVelos - target.velosLivres;
  var resteCamion = capacite - velosTarget;
  var tournee = [{
    id: target.id,
    entreprise: target.entreprise,
    ville: target.ville,
    lat: target.lat,
    lng: target.lng,
    nbVelos: velosTarget,
    distance: 0
  }];

  for (var j = 0; j < nearby.length; j++) {
    if (resteCamion <= 0) break;
    var c = nearby[j];
    var nb = Math.min(c.velosRestants, resteCamion);
    tournee.push({
      id: c.id,
      entreprise: c.entreprise,
      ville: c.ville,
      lat: c.lat,
      lng: c.lng,
      nbVelos: nb,
      distance: Math.round(c.distance * 10) / 10
    });
    resteCamion -= nb;
  }

  return {
    mode: mode,
    capacite: capacite,
    tournee: tournee,
    totalVelos: tournee.reduce(function(s, t) { return s + t.nbVelos; }, 0),
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
  var sheet = SS.getSheetByName("Livraisons");
  if (!sheet) return [];
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
      adresse: clientRow[cHeaders.indexOf("adresse")]
    } : { entreprise: "?", ville: "", adresse: "" };
    liv._count = { velos: 0 };
    return liv;
  });
}

function createLivraison(body) {
  var sheet = SS.getSheetByName("Livraisons");
  if (!sheet) {
    sheet = SS.insertSheet("Livraisons");
    sheet.getRange(1, 1, 1, 6).setValues([["id","clientId","datePrevue","dateEffective","statut","notes"]]);
  }
  var id = Utilities.getUuid();
  sheet.appendRow([id, body.clientId, body.datePrevue || "", "", "planifiee", body.notes || ""]);
  return { id: id };
}

function updateLivraison(id, data) {
  var sheet = SS.getSheetByName("Livraisons");
  if (!sheet) return { error: "Pas de feuille Livraisons" };
  var all = sheet.getDataRange().getValues();
  var headers = all[0];
  for (var i = 1; i < all.length; i++) {
    if (all[i][0] === id) {
      for (var key in data) {
        var col = headers.indexOf(key);
        if (col > -1) sheet.getRange(i + 1, col + 1).setValue(data[key]);
      }
      return { ok: true };
    }
  }
  return { error: "Livraison non trouvée" };
}

function deleteLivraison(id) {
  var sheet = SS.getSheetByName("Livraisons");
  if (!sheet) return { error: "Pas de feuille Livraisons" };
  var all = sheet.getDataRange().getValues();
  for (var i = 1; i < all.length; i++) {
    if (all[i][0] === id) {
      sheet.deleteRow(i + 1);
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
    attestationRecue: "Attestation",
    signatureOk: "Signature",
    inscriptionBicycle: "Bicycle"
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
    inscriptionBicycle: "bicycleLien"
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
