# Schéma Firestore — CRM Vélos Cargo

> Source de vérité pour la structure des collections lors de la migration depuis Google Sheets / GAS.

## Conventions

- **IDs** : auto-générés par Firestore sauf indication contraire
- **Dates** : `Timestamp` Firestore (préféré) ou ISO string
- **Références** : on stocke l'ID en string (`clientId: "abc123"`), pas de `DocumentReference` (plus simple à sérialiser)
- **Relations** : pas de jointures côté Firestore — on requête séparément ou on dénormalise

---

## `equipe/{uid}`

> ⚠️ Le doc ID **doit** être l'`uid` Firebase Auth de l'utilisateur. C'est ce qui permet aux règles Firestore de matcher.

```ts
{
  uid: string,                     // = doc.id, pour pratique
  nom: string,
  email: string,                   // doit matcher Firebase Auth
  role: "superadmin" | "admin" | "chef" | "chauffeur" | "monteur" | "preparateur" | "apporteur",
  telephone: string | null,
  actif: boolean,
  notes: string | null,
  salaireJournalier: number | null,  // EUR/jour
  primeVelo: number | null,          // EUR/vélo
  createdAt: Timestamp,
  updatedAt: Timestamp,
}
```

## `clients/{id}`

```ts
{
  entreprise: string,
  siren: string | null,
  contact: string | null,
  email: string | null,
  telephone: string | null,
  adresse: string | null,
  codePostal: string | null,
  ville: string | null,
  departement: string | null,
  apporteur: string | null,        // nom de l'apporteur (ou ref equipe.id)
  nbVelosCommandes: number,
  operationNumero: string | null,
  referenceOperation: string | null,
  modeLivraison: "gros" | "moyen" | "petit" | "retrait" | null,
  latitude: number | null,
  longitude: number | null,
  notes: string | null,

  // Dossier admin
  docs: {
    devisSignee: boolean,
    kbisRecu: boolean,
    attestationRecue: boolean,
    signatureOk: boolean,
    inscriptionBicycle: boolean,
    parcelleCadastrale: boolean,
  },
  docDates: {
    kbis: string | null,
    engagement: string | null,
    liasseFiscale: string | null,
  },
  docLinks: {
    devis: string | null,
    kbis: string | null,
    attestation: string | null,
    signature: string | null,
    bicycle: string | null,
    parcelleCadastrale: string | null,
  },

  createdAt: Timestamp,
  updatedAt: Timestamp,
}
```

## `velos/{id}`

```ts
{
  reference: string,               // ex: "ENTER-0001"
  qrCode: string | null,           // BicyCode FNUCI
  clientId: string,
  livraisonId: string | null,
  certificatRecu: boolean,
  certificatNumero: string | null,
  photoQrPrise: boolean,
  facturable: boolean,
  facture: boolean,
  dateMontage: Timestamp | null,
  dateAnnulation: Timestamp | null,
  photos: {
    etiquette: string | null,      // URL Storage
    qr: string | null,
    monte: string | null,
  },
  createdAt: Timestamp,
  updatedAt: Timestamp,
}
```

## `livraisons/{id}`

```ts
{
  clientId: string | null,
  tourneeId: string | null,
  datePrevue: Timestamp | null,
  dateEffective: Timestamp | null,
  statut: "planifiee" | "en_cours" | "livree" | "annulee",
  mode: "gros" | "moyen" | "petit" | "retrait" | null,
  chauffeurId: string | null,
  chefEquipeIds: string[],
  monteurIds: string[],
  preparateurIds: string[],
  nbMonteurs: number | null,
  notes: string | null,
  urlBlSigne: string | null,       // URL Storage
  blNumero: string | null,
  createdAt: Timestamp,
  updatedAt: Timestamp,
}
```

## `tournees/{id}`

```ts
{
  numero: number,
  datePrevue: Timestamp,
  mode: "gros" | "moyen" | "petit" | "retrait",
  chauffeurId: string | null,
  chefEquipeIds: string[],
  preparateurIds: string[],
  monteurIds: string[],
  capaciteVelos: number,
  statut: "planifiee" | "en_cours" | "livree" | "annulee",
  createdAt: Timestamp,
  updatedAt: Timestamp,
}
```

## `camions/{id}`

```ts
{
  nom: string,
  type: "gros" | "moyen" | "petit" | "retrait",
  capaciteVelos: number,
  peutEntrerParis: boolean,
  actif: boolean,
  notes: string | null,
  createdAt: Timestamp,
  updatedAt: Timestamp,
}
```

## `bonsEnlevement/{id}`

> Alimenté par `gas-inbox` (traitement emails) qui écrira directement dans Firestore via REST API.

```ts
{
  receivedAt: Timestamp,
  fournisseur: string,
  numeroDoc: string,
  dateDoc: string,
  tourneeId: string | null,
  tourneeRef: string,
  tourneeDate: string,
  tourneeNumero: number | string,
  quantite: number,
  storageUrl: string,              // chemin dans Firebase Storage
  fileName: string,
  fromEmail: string,
  subject: string,
  messageId: string,               // Gmail thread ID, idempotence
}
```

## `verifications/{id}`

> File de traitement Gemini : doc classifié, en attente de validation admin.

```ts
{
  clientId: string | null,         // null si pas matché
  docType: "kbis" | "liasse" | "devis" | "attestation" | "autre",
  storageUrl: string,
  classifiedAt: Timestamp,
  status: "pending" | "validated" | "rejected",
  extractedData: {                 // ce que Gemini a extrait
    clientName?: string,
    siren?: string,
    headcount?: number,
    docDate?: string,
  },
  reviewedBy: string | null,       // uid admin
  reviewedAt: Timestamp | null,
}
```

## `settings/{id}`

> Doc unique `settings/app` pour la config globale.

```ts
{
  id: "app",
  driveLegacyParentId: string,     // pour rester compatible avec GAS pendant migration
  gemini: { defaultModel: string },
  features: { ... },
  updatedAt: Timestamp,
}
```

---

## Storage — arborescence

```
clients/{clientId}/documents/{type}-{timestamp}.{ext}
montage/{livraisonId}/{fnuci}-{stage}.jpg
bl/{livraisonId}/bl-signed-{timestamp}.jpg
preparation/{clientId}/{fnuci}.jpg
bonsEnlevement/{id}/{fileName}
```

---

## Indexes à prévoir (à créer au fur et à mesure)

- `clients` : `departement` ASC + `entreprise` ASC
- `livraisons` : `statut` + `datePrevue` DESC
- `livraisons` : `clientId` + `datePrevue` DESC
- `velos` : `clientId` + `reference` ASC
- `velos` : `qrCode` (égalité, peut être index simple)
- `verifications` : `status` + `classifiedAt` DESC

(Firebase suggère automatiquement un lien dans la console quand une requête manque d'index.)
