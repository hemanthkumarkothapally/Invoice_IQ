namespace com.invoiceiq;

using {
    cuid,
    managed
} from '@sap/cds/common';

type DocStatus : String(20) enum {
    PENDING;
    PROCESSING;
    EXTRACTED;
    MATCHING;
    NEEDS_REVIEW;
    MATCHED;
    CONFIRMED;
    REJECTED;
    FAILED;
}

entity Documents : cuid, managed {
    fileName     : String(255) @mandatory;
    mimeType     : String(100) default 'application/pdf';
    fileSize     : Integer;

    // Base64 of the original file. Kept as a plain string rather than a media
    // stream so the client can build a blob URL without a dedicated route.
    contentBase64: LargeString;
    source       : String(10)  default 'UI'; // UI | API
    jobId        : String(100);
    status       : DocStatus   default 'PENDING';
    statusText   : String(500);
    rawText      : LargeString;
    doxRawResult : LargeString;
    uploadedBy   : String(100);
    uploadedAt   : Timestamp;
    invoice      : Composition of one ExtractedInvoices
                       on invoice.document = $self;
}

entity ExtractedInvoices : cuid, managed {
    document        : Association to Documents @mandatory;

    // --- Document -------------------------------------------------------
    invoiceNumber   : String(100);
    invoiceDate     : Date;
    dueDate         : Date;
    deliveryDate    : Date;
    poNumberRaw     : String(20);
    deliveryNote    : String(60);
    barcode         : String(500);

    // --- Sender (the supplier) -------------------------------------------
    vendorName      : String(255);
    vendorAddress   : String(500);
    vendorStreet    : String(120);
    vendorHouseNo   : String(20);
    vendorCity      : String(80);
    vendorPostalCode: String(20);
    vendorState     : String(80);
    vendorDistrict  : String(80);
    vendorCountry   : String(3);
    vendorExtraAddr : String(200);
    taxId           : String(30);
    iban            : String(40);

    // --- Receiver (us) ---------------------------------------------------
    buyerName       : String(255);
    buyerAddress    : String(500);
    buyerStreet     : String(120);
    buyerHouseNo    : String(20);
    buyerCity       : String(80);
    buyerPostalCode : String(20);
    buyerState      : String(80);
    buyerDistrict   : String(80);
    buyerCountry    : String(3);
    buyerExtraAddr  : String(200);
    buyerTaxId      : String(30);
    buyerContact    : String(200);

    // --- Amounts ---------------------------------------------------------
    netAmount       : Decimal(15, 2);
    taxAmount       : Decimal(15, 2);
    taxRate         : Decimal(6, 3);
    taxName         : String(120);
    shippingAmount  : Decimal(15, 2);
    discount        : String(60);
    grossAmount     : Decimal(15, 2);
    currency        : String(3);

    // --- Payment ---------------------------------------------------------
    paymentTerms    : String(200);

    // --- Extraction quality ----------------------------------------------
    confidence      : Decimal(4, 3);
    fieldConfidence : LargeString;
    lowConfidence   : LargeString;

    // --- Match -----------------------------------------------------------
    matchedPO       : String(10);
    matchedSupplier : String(10);
    matchScore      : Decimal(4, 3);
    matchSummary    : String(500);
    matchedAt       : Timestamp;
    matchedBy       : String(100);

    reviewedBy      : String(100);
    reviewedAt      : Timestamp;
    reviewNote      : String(1000);

    lineItems       : Composition of many LineItems
                          on lineItems.invoice = $self;
    candidates      : Composition of many PoCandidates
                          on candidates.invoice = $self;
}

entity PoCandidates : cuid {
    invoice       : Association to ExtractedInvoices @mandatory;
    rank          : Integer;
    purchaseOrder : String(10);
    supplier      : String(10);
    supplierName  : String(255);
    companyCode   : String(4);
    purchasingOrg : String(4);
    purchasingGroup : String(3);
    poDate        : Date;
    netValue      : Decimal(15, 2);
    currency      : String(3);
    itemCount     : Integer;
    // Retrieval score: how this order was shortlisted for the model to judge.
    score         : Decimal(4, 3);
    band          : String(10);   // EXACT | CLOSE | POSSIBLE | WEAK
    reasons       : LargeString;
    lineMatches   : LargeString;   // JSON: which PO line each invoice line hit

    // Sub-scores, so the reviewer can see which signals carried the match
    // rather than only the number it produced.
    headerScore      : Decimal(4, 3);
    lineScore        : Decimal(4, 3);
    amountScore      : Decimal(4, 3);
    quantityScore    : Decimal(4, 3);
    materialScore    : Decimal(4, 3);
    descriptionScore : Decimal(4, 3);
    uomScore         : Decimal(4, 3);
    unitPriceScore   : Decimal(4, 3);

    paymentTerms     : String(60);

    // The model's verdict, when AI ranking is switched on.
    aiScore       : Decimal(4, 3);
    aiRationale   : String(500);
}

entity LineItems : cuid {
    invoice        : Association to ExtractedInvoices @mandatory;
    lineNo         : Integer;
    description    : String(500);
    materialNumber : String(40);
    quantity       : Decimal(13, 3);
    uom            : String(10);   // CEFACT code as extracted, e.g. H87
    unitPrice      : Decimal(15, 2);
    lineTotal      : Decimal(15, 2);
}
