using {com.invoiceiq as iq} from '../db/schema';

service InvoiceService @(path: '/invoice') {

    @cds.redirection.target
    entity Documents         as projection on iq.Documents;

    entity ExtractedInvoices as projection on iq.ExtractedInvoices;
    entity LineItems         as projection on iq.LineItems;

    @readonly
    entity PoCandidates      as projection on iq.PoCandidates;

    type UploadResult {
        documentId : UUID;
        jobId      : String(100);
        status     : String(20);
    }

    type ActionResult {
        documentId : UUID;
        status     : String(20);
        message    : String(500);
    }

    /**
     * Ingestion. Same entry point for the UI upload dialog and for
     * system-to-system posts. `content` is the base64 encoded file.
     * Returns immediately; extraction continues in the background.
     */
    action uploadDocument(fileName : String(255),
                          mimeType : String(100),
                          content : LargeString,
                          source : String(10))       returns UploadResult;

    /** Re-runs extraction for a document already submitted to Document AI. */
    action processDocument(documentId : UUID)        returns ActionResult;

    /** Re-runs the purchase order search, e.g. after a field correction. */
    action findCandidates(documentId : UUID)         returns array of PoCandidates;

    /** Commits the chosen purchase order after re-reading it from S/4HANA. */
    action confirmMatch(documentId : UUID,
                        purchaseOrder : String(10))  returns ActionResult;

    /** Pulls a purchase order into the list by number. */
    action addCandidate(documentId : UUID,
                        purchaseOrder : String(10))  returns PoCandidates;

    /** Clears a confirmed match so the reviewer can pick again. */
    action clearMatch(documentId : UUID)             returns ActionResult;

    /** Reviewer signs off on the extracted values. */
    action confirmExtraction(documentId : UUID)      returns ActionResult;

    action rejectDocument(documentId : UUID,
                          reason : String(1000))     returns ActionResult;

    /** Every purchase order with its items, straight from S/4HANA. */
    function getAllPOs()                             returns LargeString;
}
