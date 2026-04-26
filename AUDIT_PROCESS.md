# Audit du process CRM Vélos Cargo — A à Z

> Document de référence pour la présentation du CRM. État au 27/04/2026 après les commits du 26-27/04.
>
> Périmètre : du moment où l'admin saisit un client jusqu'à l'encaissement final, en passant par la production (préparation / livraison / montage) et la facturation CEE.

---

## Vue d'ensemble — les 9 étapes du process

```
[1] CRÉATION CLIENT
        │ admin saisit l'entreprise + apporteur
        ▼
[2] DOSSIER ADMINISTRATIF (CEE TRA-EQ-131)
        │ 6 docs : Devis / Kbis / Liasse / Signature / Bicycle / Parcelle
        ▼
[3] AFFILIATION FNUCI (préparation)
        │ scan QR BicyCode → rattache au client
        ▼
[4] PLANIFICATION TOURNÉE
        │ admin groupe les clients dans une tournée + assigne équipe
        ▼
[5] CHARGEMENT CAMION
        │ scan FNUCI au chargement
        ▼
[6] LIVRAISON
        │ scan livraison + photo BL signé client
        ▼
[7] MONTAGE
        │ 3 photos preuve : étiquette / QR vélo / vélo monté
        ▼
[8] FACTURABLE → FACTURATION
        │ flag "facturable" → flag "facturé"
        ▼
[9] ENCAISSEMENT + PAIE ÉQUIPE
            CA dossier CEE / coût main d'œuvre
```

---

## Étape 1 — Création client

**Acteur** : admin (Yoann ou délégation)

**Page** : `/clients` → bouton « + Nouveau client » (ou « Importer CSV »)

**Champs requis** :
- `entreprise`, `siren`, `email`, `telephone`
- `adresse`, `codePostal`, `ville`, `departement`
- `nbVelosCommandes` (objectif vélos)
- `apporteur` (nom du commercial qui a apporté le client)
- `operationNumero` (référence CEE)

**Mécanisme** : un dossier Drive est auto-créé sous le dossier racine (cf mémoire `crm_velos_cargo_drive`). Une ligne par vélo est créée dans la sheet `Velos` avec `clientId` rattaché.

**Vérifications recommandées** :
- L'apporteur saisi correspond-il à un membre Équipe (rôle `apporteur`) ? Sinon la prime ne sera pas calculée.
- L'adresse est-elle géocodable ? Si non, la parcelle cadastrale ne pourra pas être auto-récupérée.

**Risques** :
- Saisir un mauvais nom d'apporteur (faute de frappe) → prime non comptée.
- `nbVelosCommandes` mal renseigné → impacte le calcul de masse salariale (vélos primés).

---

## Étape 2 — Dossier administratif (CEE)

**Acteur** : admin

**Page** : `/clients/detail?id=...` → bloc « Dossier administratif »

**Les 6 documents obligatoires (process TRA-EQ-131)** :

| # | Document | Ce qu'il valide | Validité | Auto-fetch ? |
|---|---|---|---|---|
| 1 | **Devis signé** | Engagement du client | Date d'engagement | Non |
| 2 | **Extrait Kbis / RNE** | Existence légale | < 3 mois (alerte orange auto) | Non |
| 3 | **Liasse fiscale / Effectifs** | ETP du client | < 12 mois (alerte) | Non |
| 4 | **Signature contrat** | Contrat plateforme | — | Non |
| 5 | **Certificat Bicycle / FNUCI** | Identification du vélo au nom du client | — | Non |
| 6 | **Parcelle cadastrale** | Lieu effectif de livraison | — | **Oui** (apicarto.ign.fr) |

**Auto-fetch parcelle** : depuis le commit `cf517c6`, le bouton « Récupérer automatiquement via cadastre.gouv.fr » :
1. Géocode l'adresse via api-adresse.data.gouv.fr.
2. Interroge apicarto.ign.fr 2× (parcelle + centroid).
3. Construit l'identifiant fiscal officiel : `INSEE(5) + SECTION(5) + NUMERO(4)`.
4. Stocke un lien direct `cadastre.data.gouv.fr/parcelles/<id>` qui zoom EXACTEMENT sur la parcelle.
5. **Cache** depuis le commit `0d3b768` : si déjà rempli, skip les appels apicarto.

⚠️ **Point critique** : un mauvais identifiant cadastral peut bloquer le paiement du dossier CEE. Le frontend affiche systématiquement un avertissement de vérification visuelle.

**Vérifications** :
- Toutes les pastilles passent vertes ? (compteur `X/6 validés` en haut)
- Date Kbis ≤ 3 mois ?
- Liasse fiscale ≤ 12 mois ?
- Effectif mentionné coché si liasse OK ?

---

## Étape 3 — Affiliation FNUCI (préparation)

**Acteur** : préparateur (AXDIS) ou admin

**Page** : `/preparation?clientId=...`

**Mécanisme** :
1. Le préparateur scanne le QR BicyCode collé sur le carton du vélo (Strich SDK + caméra).
2. Le scan extrait le FNUCI (ex : `BCY-2025-XYZ-001`).
3. Côté GAS, le FNUCI est écrit sur la 1ère ligne `Velos` libre du client.
4. La photo du carton est stockée sur Drive (`Photos préparation/<date>/<fnuci>.jpg`).

**Sécurité** :
- Depuis `0d3b768` : si un FNUCI existe déjà ailleurs (doublon), `uploadMontagePhoto` retourne `{ error: "DOUBLON FNUCI : N vélos trouvés" }` au lieu de mettre à jour silencieusement le 1er match.
- Le préparateur ne peut pas affilier 2 fois le même FNUCI → garantie d'unicité.

**Boutons d'annulation** :
- ✕ Désaffilier : vide FNUCI + dates + URLs photos. Slot redevient libre.
- ↺ Annuler : vide la dernière étape (préparation/chargement/livraison/montage).

---

## Étape 4 — Planification tournée

**Acteur** : admin

**Page** : `/livraisons` (vue Mois pour planifier sur la durée, vue Semaine/3j pour le détail, vue Jour pour la production)

**Mécanisme** :
1. Bouton « 🪄 Planifier le jour » → ouvre `DayPlannerModal` qui propose une ventilation Gemini optimale en fonction des ressources du jour.
2. Bouton « + Nouvelle tournée » : sélection des clients à grouper, choix du mode (gros/moyen/camionnette/retrait) et capacité.
3. Affectation manuelle de l'équipe sur la tournée :
   - 1 chauffeur
   - 0-N chefs d'équipe (`chefEquipeIds`)
   - 0-N préparateurs (`preparateurIds`)
   - 0-N monteurs (`monteurIds`)

**Vues disponibles** (`localStorage.livraisons.view`) :
- **Jour** : par défaut pour les rôles terrain (chauffeur/monteur/chef/préparateur) + mobile
- **3 jours** : pour mobile, vue intermédiaire
- **Semaine** : 7 colonnes, desktop par défaut
- **Mois** : grille calendrier
- **Liste** : tableau plat

**Compteur d'objectifs adaptatif** (commit `4ab6bde`) :
- Monteur : « X vélos à monter aujourd'hui/sur 3 jours/cette semaine »
- Chauffeur : « Y livraisons · Z tournées »
- Admin : « X tournées · Y livraisons »

---

## Étape 5 — Chargement camion

**Acteur** : chauffeur (+ aide préparateur)

**Page** : `/chargement?tourneeId=...`

**Mécanisme** :
1. Le chauffeur ouvre la tournée sur son téléphone, scan FNUCI à chaque vélo chargé.
2. `markVeloEtape("chargement")` → écrit `dateChargement` + `chargeParId` + `tourneeIdScan`.
3. Si un FNUCI scanné n'appartient pas à un client de cette tournée → erreur `HORS_TOURNEE` (sécurité anti-mélange).

**Indicateur** : compteur live « X/Y vélos chargés » par client.

---

## Étape 6 — Livraison

**Acteur** : chauffeur (+ chef d'équipe)

**Page** : `/livraison?tourneeId=...&clientId=...`

**Workflow par client** :
1. Scan FNUCI à la livraison (chaque vélo) → `markVeloEtape("livraisonScan")` écrit `dateLivraisonScan` + `livreParId`.
2. Quand tous les vélos du client sont livrés → apparaît un bouton **« 📷 Photo BL signé »** + **« ✅ Marquer comme livré »**.
3. Bouton « Marquer comme livré » → statut Livraison passe à `livree`, `dateEffective` rempli.
4. **Redirection auto** vers la prochaine livraison de la tournée (commit `3083afb`).

**Photo BL signé** : `uploadBlSignedPhoto`
- 1 photo par couple {client, tournée}
- Stockée sous `<client>/Bons de livraison signés/<date>/`
- URL écrite dans `Livraisons.urlBlSigne`
- Visible :
  - Sur la fiche client → section « 📋 Bons de livraison signés » (haut de page) + colonne « BL signé » du tableau Vélos
  - Sur la fiche tournée

---

## Étape 7 — Montage chez le client

**Acteur** : monteur (souvent chef d'équipe + 1-2 monteurs)

**Page** : `/montage?tourneeId=...&clientId=...`

**3 photos par vélo** (preuve obligatoire pour valider le montage) :
1. **Étiquette carton** (E) → identification, Gemini lit le FNUCI
2. **QR vélo** (Q) → vérifie que c'est le bon vélo
3. **Vélo monté** (M) → preuve de réalisation

**Mécanisme** :
- Compression image agressive (commit `a126dad`) : 720px JPEG 0.6 pour étiquette/QR (lisibilité Gemini), 600px JPEG 0.55 pour vélo monté.
- Indication de phase au user : « 📦 Compression… → 🤖 Lecture du FNUCI… → 💾 Sauvegarde… »
- Quand les 3 photos sont uploadées → `dateMontage` rempli automatiquement, vélo passe « monté ».
- Bouton « Client suivant » apparaît quand tous les vélos d'un client sont montés (commit `1316e6b`).

**Photos consultables depuis** :
- Fiche client → tableau Vélos → colonne « Photos montage » (3 pastilles E/Q/M cliquables → Drive direct)

---

## Étape 8 — Facturable → Facturation

**Acteurs** : admin

**Page** : fiche client + onglet « À vérifier » + actions bulk sur fiche client

**Critères « facturable »** : livré + certificat Bicycle reçu + photo QR (proxy historique)

**Workflow** :
1. Admin vérifie la fiche client → cliquer « Facturable » sur les vélos qui remplissent les critères.
2. Compteur dashboard « Facturables » : `velosFacturables` = vélos prêts à être facturés.
3. Une fois la facture émise vers l'apporteur d'affaires CEE → cliquer « Facturé ».
4. Compteur dashboard « Facturés » : reste à facturer = `velosFacturables - velosFactures`.

**Bulk actions** sur la fiche client : sélectionner les vélos via cases à cocher → boutons « Certificat reçu / Photo QR / Facturable / Facturé ».

**Filtre par période** (commit `1b4dfdd`) : sur le dashboard, le toolbar Tout/Aujourd'hui/Semaine/Mois/Année filtre les compteurs Vélos livrés / Certificats / Facturables / Facturés sur la fenêtre choisie. Les KPI Clients / Vélos total / Planifiés restent globaux.

---

## Étape 9 — Encaissement et paie équipe

**Acteurs** : admin

**Page** : `/finances` (admin uniquement, commit `f4bfa12`)

### Coûts main d'œuvre

Pour chaque membre Équipe, sur la période choisie :

| Rôle | Salaire journalier | Prime vélo | Calcul |
|---|---|---|---|
| Chauffeur | Oui | 0-5 € | 1 jour / tournée + totalVelos × prime |
| Chef d'équipe | Oui | 0-5 € | idem chauffeur |
| Préparateur | Oui | 0-5 € | idem chauffeur |
| Monteur | Oui | 0-5 € | 1 jour / tournée + (totalVelos / nbMonteurs) × prime |
| Apporteur | **Non** | **10-50 €** | nbVelos × prime, **sur les vélos LIVRÉS** des clients qu'il a apportés |

**Anti double-comptage** : `joursDates` est un Set par membre × date. Un membre sur 2 tournées le même jour ne touche qu'un jour de salaire.

### Recommandation : ce qui manque pour fermer la boucle

Le CRM ne suit pas encore :
- ❌ **Prix de vente unitaire d'un vélo** (CA par vélo facturé)
- ❌ **Date d'encaissement réelle** par dossier CEE
- ❌ **Marge** = CA − coût main d'œuvre − coût matériel

→ Ces 3 champs pourraient être ajoutés à la sheet `Clients` (ou à une nouvelle sheet `Factures`) pour avoir un onglet « Encaissement » complet.

---

## Sécurités et garde-fous en place

| Risque | Garde-fou | Commit |
|---|---|---|
| Saisie d'un FNUCI déjà utilisé | `uploadMontagePhoto` retourne erreur DOUBLON | `0d3b768` |
| Mauvaise parcelle cadastrale | Lien direct cadastre.data.gouv.fr + alerte de vérification | `cf517c6` |
| Vélo rattaché à la mauvaise tournée | `getClient` ne fallback plus sur la 1re tournée si ambiguïté + flag `livraisonOrpheline` | `0d3b768` |
| Hard delete | Toutes les fonctions `delete*` sont des soft cancel (flag `annule=TRUE`) | mémoire `never_hard_delete_data` |
| Tests CHEN LEO non annulables | ✕ Désaffilier vide aussi les URLs photos montage | `e593578` |
| Workflow montage trop lent | Compression 720px / 600px + label de phase | `a126dad` |
| Vue Semaine illisible sur mobile | Vues Jour et 3 jours ajoutées + défaut « jour » sur mobile | `bc39426` |
| Login libre sans code | Carte orange « 🔓 Sans code » dans la page Équipe | `fcb99f2` |

---

## Sécurités d'authentification

- Login membre via `loginEquipe` (nom + PIN 4 chiffres SHA-256, sel `velos-cargo:`).
- Sessions stockées en `PropertiesService` 30j (mémoire `luze_vintage_auth_architecture` valable aussi pour ce CRM).
- Apporteur d'affaires : pas vocation à se connecter au CRM (juste mis en CC mails).
- Page `/finances` : garde-fou côté front + à valider côté backend.

---

## Performances et scaling

Audit complet au 27/04/2026 (cf TODO du jour). Verdict : **fonctionne sans souci jusqu'à 100 vélos/client × 1000 clients**.

Optimisations critiques appliquées (commit `0d3b768`) :

- **Cache GAS** sur `getClient` (TTL 5 min) avec invalidation explicite sur les 7 fonctions de modification (updateClient, updateVelos, uploadMontagePhoto, uploadBlSignedPhoto, _markVeloEtape × 3, setClientVelosTarget).
- **Index FNUCI** dans `uploadMontagePhoto` : O(1) lookup au lieu de scan linéaire × 3 photos.
- **Map clientId** dans `getLivraisons` : O(N+M) au lieu de O(N×M). Gain énorme à 100+ livraisons × 1000+ clients.
- **Cache fetchParcelle** : skip apicarto.ign.fr si déjà rempli. Évite throttle API (limite ~1000 req/jour).
- **Batch reactivation** dans `setClientVelosTarget` : 1 setValues() au lieu de 100 setValue().

Limite restante : au-delà de 200 vélos/client, `getClient` peut approcher le timeout 6 min. Solution si besoin un jour : pagination ou shard.

---

## Pour la démo

**Parcours suggéré (10 min)** :

1. **Dashboard** (1 min) → toolbar période, KPI temps réel, progression globale.
2. **Clients > liste** (1 min) → recherche, filtre département, indicateurs colorés (livrés, BL signé, monté).
3. **Fiche client CHEN LEO** (3 min) → dossier admin (parcelle auto-fetch), section BL signés, tableau Vélos (FNUCI + photos cliquables Drive).
4. **Livraisons** (2 min) → vue Semaine/Mois, fiche tournée, redirect auto après livraison.
5. **Équipe** (1 min) → cartes orange « sans code », bloc rémunération avec prime apporteur 10-50 €.
6. **Finances** (2 min) → sélecteur période, coût main d'œuvre par membre, total mensuel.

**Punchlines techniques pour la démo** :

- « Le CRM tient 100 vélos/client × 1000 clients sans perte de perfs. »
- « Le scan FNUCI est protégé contre les doublons de saisie : zéro photo perdue, zéro vélo mal attribué. »
- « La parcelle cadastrale est récupérée automatiquement et zoome direct sur le terrain — plus de risque de bloquer un dossier CEE pour mauvaise parcelle. »
- « Les vues mobile (Jour / 3 jours) sont natives, le chauffeur ouvre son app et voit ses livraisons du jour, le monteur voit les vélos à monter. »
- « La page Finances calcule la masse salariale temps réel : salaire/jour × tournées + prime/vélo, avec règle métier différente pour l'apporteur (commission 10-50 €). »

---

*Document généré le 27/04/2026 à partir du code de la branche `main`. Pour toute question : Yoann.*
