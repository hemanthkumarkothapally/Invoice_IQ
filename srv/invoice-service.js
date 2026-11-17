const cds = require('@sap/cds');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

const dox = require('./lib/dox');
const matcher = require('./lib/matcher');

const LOG = cds.log('invoice-iq');
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 20);


module.exports = class InvoiceService extends cds.ApplicationService {

  async init() {
    const {Documents, ExtractedInvoices, LineItems, PoCandidates} = this.entities;

    // -----------------------------------------------------------------------
    // uploadDocument — the UI dialog and the API both land here
    // -----------------------------------------------------------------------
    this.on('uploadDocument', async req => {
      const {fileName, content, mimeType, source} = req.data;
      if (!content || !fileName) return req.error(400, 'fileName and content are required');

      let buffer;
      try {
        buffer = Buffer.from(content, 'base64');
      } catch {
        return req.error(400, 'content is not valid base64');
      }
      if (!buffer.length) return req.error(400, 'content decoded to an empty file');
      if (buffer.length > MAX_FILE_MB * 1024 * 1024) {
        return req.error(413, `File exceeds the ${MAX_FILE_MB} MB limit`);
      }

      const ID = cds.utils.uuid();

      // Best effort. Gives us searchable text even when extraction later fails.
      let rawText = '';
      try {
        const parsed = await pdfParse(buffer);
        rawText = (parsed.text || '').trim();
      } catch (e) {
        LOG.warn('pdf-parse failed, continuing without raw text:', e.message);
      }

      await INSERT.into(Documents).entries({
        ID,
        fileName,
        contentBase64: content,
        fileSize: buffer.length,
        mimeType: mimeType || 'application/pdf',
        source: source || 'UI',
        rawText,
        status: 'PENDING',
        uploadedBy: req.user?.id || 'anonymous',
        uploadedAt: new Date()
      });

      let jobId;
      try {
        jobId = await dox.submit(buffer, fileName, mimeType);
      } catch (e) {
        LOG.error('Document AI submit failed:', e.message);
        await UPDATE(Documents, ID).with({
          status: 'FAILED',
          statusText: `Upload to Document AI failed: ${e.message}`.slice(0, 500)
        });
        return req.error(502, 'Document AI upload failed');
      }

      await UPDATE(Documents, ID).with({jobId, status: 'PROCESSING'});

      // Detached so the HTTP request returns immediately.
      cds.spawn({tenant: req.tenant, user: req.user}, tx => runPipeline(tx, ID, jobId));

      return {documentId: ID, jobId, status: 'PROCESSING'};
    });


    // -----------------------------------------------------------------------
    // processDocument — retry extraction for an already submitted job
    // -----------------------------------------------------------------------
    this.on('processDocument', async req => {
      const {documentId} = req.data;
      const doc = await SELECT.one.from(Documents).where({ID: documentId});
      if (!doc) return req.error(404, `Document ${documentId} not found`);
      if (!doc.jobId) return req.error(400, 'Document was never submitted to Document AI');

      await UPDATE(Documents, documentId).with({status: 'PROCESSING', statusText: null});
      cds.spawn({tenant: req.tenant, user: req.user}, tx => runPipeline(tx, documentId, doc.jobId));

      return {documentId, status: 'PROCESSING', message: 'Extraction restarted'};
    });


    // -----------------------------------------------------------------------
    // findCandidates — re-rank after a field correction
    // -----------------------------------------------------------------------
    this.on('findCandidates', async req => {
      const {documentId} = req.data;
      const inv = await SELECT.one.from(ExtractedInvoices).where({document_ID: documentId});
      if (!inv) return req.error(404, 'No extracted invoice for that document');

      await UPDATE(Documents, documentId).with({status: 'MATCHING'});
      const items = await SELECT.from(LineItems).where({invoice_ID: inv.ID}).orderBy('lineNo');

      let result;
      try {
        result = await matcher.rank(inv, items);
      } catch (e) {
        LOG.error('Candidate search failed:', e.message);
        await UPDATE(Documents, documentId).with({
          status: 'NEEDS_REVIEW',
          statusText: `Purchase order search failed: ${e.message}`.slice(0, 500)
        });
        return req.error(502, 'Could not reach S/4HANA');
      }

      await DELETE.from(PoCandidates).where({invoice_ID: inv.ID});
      if (result.candidates.length) {
        await INSERT.into(PoCandidates).entries(
          result.candidates.map(c => ({...c, invoice_ID: inv.ID}))
        );
      }

      await UPDATE(Documents, documentId).with(matchStatus(result.candidates));
      return result.candidates;
    });


    // -----------------------------------------------------------------------
    // confirmMatch — re-read from S/4 before committing
    // -----------------------------------------------------------------------
    this.on('confirmMatch', async req => {
      const {documentId, purchaseOrder} = req.data;
      const inv = await SELECT.one.from(ExtractedInvoices).where({document_ID: documentId});
      if (!inv) return req.error(404, 'No extracted invoice for that document');

      let po;
      try {
        po = await matcher.readPO(purchaseOrder);
      } catch (e) {
        return req.error(502, `Could not read purchase order ${purchaseOrder}: ${e.message}`);
      }
      if (!po) return req.error(404, `Purchase order ${purchaseOrder} not found in S/4HANA`);
      if (po.PurchaseOrderDeletionCode) {
        return req.error(409, `Purchase order ${purchaseOrder} is flagged for deletion`);
      }

      const candidate = await SELECT.one.from(PoCandidates)
        .where({invoice_ID: inv.ID, purchaseOrder});

      await UPDATE(ExtractedInvoices, inv.ID).with({
        matchedPO: purchaseOrder,
        matchedSupplier: po.Supplier,
        matchScore: candidate?.score ?? null,
        matchSummary: candidate ? summarize(candidate) : null,
        matchedAt: new Date(),
        matchedBy: req.user?.id || 'system'
      });
      await UPDATE(Documents, documentId).with({status: 'MATCHED', statusText: null});

      return {documentId, status: 'MATCHED', message: `Matched to purchase order ${purchaseOrder}`};
    });


    // -----------------------------------------------------------------------
    // addCandidate — the reviewer already knows the purchase order
    // -----------------------------------------------------------------------
    this.on('addCandidate', async req => {
      const {documentId, purchaseOrder} = req.data;
      const inv = await SELECT.one.from(ExtractedInvoices).where({document_ID: documentId});
      if (!inv) return req.error(404, 'No extracted invoice for that document');

      const existing = await SELECT.one.from(PoCandidates)
        .where({invoice_ID: inv.ID, purchaseOrder});
      if (existing) return existing;

      let po;
      try {
        po = await matcher.readPO(purchaseOrder);
      } catch (e) {
        return req.error(502, `Could not read purchase order ${purchaseOrder}: ${e.message}`);
      }
      if (!po) return req.error(404, `Purchase order ${purchaseOrder} not found`);

      const items = await SELECT.from(LineItems).where({invoice_ID: inv.ID}).orderBy('lineNo');
      const {score, reasons, details} = matcher.scoreCandidate(inv, items, po);

      // Added by hand, so it goes to the top regardless of what it scores.
      const entry = matcher.toCandidate(
        po, score, ['added by the reviewer', ...reasons], 0, undefined, details
      );
      await INSERT.into(PoCandidates).entries({
        ...entry, ID: cds.utils.uuid(), invoice_ID: inv.ID
      });

      LOG.info(`Reviewer added candidate ${purchaseOrder} to document ${documentId}`);
      return entry;
    });


    this.on('clearMatch', async req => {
      const {documentId} = req.data;
      const inv = await SELECT.one.from(ExtractedInvoices).where({document_ID: documentId});
      if (!inv) return req.error(404, 'No extracted invoice for that document');

      await UPDATE(ExtractedInvoices, inv.ID).with({
        matchedPO: null, matchedSupplier: null, matchScore: null,
        matchSummary: null, matchedAt: null, matchedBy: null
      });
      await UPDATE(Documents, documentId).with({status: 'NEEDS_REVIEW', statusText: null});
      return {documentId, status: 'NEEDS_REVIEW', message: 'Match cleared'};
    });


    // -----------------------------------------------------------------------
    // confirmExtraction / rejectDocument
    // -----------------------------------------------------------------------
    this.on('confirmExtraction', async req => {
      const {documentId} = req.data;
      const inv = await SELECT.one.from(ExtractedInvoices).where({document_ID: documentId});
      if (!inv) return req.error(404, 'No extracted invoice for that document');

      if (!inv.invoiceNumber || !inv.grossAmount || !inv.currency) {
        return req.error(400,
          'Invoice number, gross amount and currency must be filled before confirming');
      }

      await UPDATE(ExtractedInvoices, inv.ID).with({
        reviewedBy: req.user?.id || 'system',
        reviewedAt: new Date()
      });
      await UPDATE(Documents, documentId).with({status: 'CONFIRMED', statusText: null});

      return {documentId, status: 'CONFIRMED', message: 'Extraction confirmed'};
    });


    this.on('rejectDocument', async req => {
      const {documentId, reason} = req.data;
      const doc = await SELECT.one.from(Documents).where({ID: documentId});
      if (!doc) return req.error(404, `Document ${documentId} not found`);

      await UPDATE(Documents, documentId).with({status: 'REJECTED', statusText: reason});
      await UPDATE(ExtractedInvoices)
        .set({reviewNote: reason, reviewedBy: req.user?.id || 'system', reviewedAt: new Date()})
        .where({document_ID: documentId});

      return {documentId, status: 'REJECTED', message: 'Document rejected'};
    });


    // -----------------------------------------------------------------------
    // getAllPOs — every purchase order with its items, straight from S/4HANA
    // -----------------------------------------------------------------------
    this.on('getAllPOs', async () => {
      try {
        const pos = await matcher.listAll();

        const rows = pos.map(po => ({
          purchaseOrder: po.PurchaseOrder,
          supplier: po.Supplier,
          companyCode: po.CompanyCode,
          purchasingOrg: po.PurchasingOrganization,
          purchasingGroup: po.PurchasingGroup,
          poDate: po.PurchaseOrderDate,
          paymentTerms: po.PaymentTerms,
          currency: po.DocumentCurrency,
          netValue: po.netValue,
          itemCount: po.items.length,
          items: po.items.map(i => ({
            item: i.PurchaseOrderItem,
            material: i.Material,
            text: i.PurchaseOrderItemText,
            quantity: Number(i.OrderQuantity) || null,
            uom: i.PurchaseOrderQuantityUnit,
            unitPrice: Number(i.NetPriceAmount) || null,
            netAmount: Number(i.NetAmount) || null
          }))
        }));

        LOG.info(`getAllPOs returned ${rows.length} order(s)`);
        return JSON.stringify({count: rows.length, purchaseOrders: rows}, null, 2);

      } catch (e) {
        LOG.error('getAllPOs failed:', e.message);
        return JSON.stringify({
          error: e.message,
          status: e?.response?.status ?? e?.cause?.response?.status,
          body: e?.response?.data ?? e?.cause?.response?.data
        }, null, 2);
      }
    });


    return super.init();
  }
};


// ---------------------------------------------------------------------------
// Background extraction and matching
// ---------------------------------------------------------------------------

/** Decides whether a document can skip review, based on the top candidate. */
function matchStatus(candidates) {
  const top = candidates[0];
  if (!top) return {status: 'NEEDS_REVIEW', statusText: 'No purchase order candidates found'};
  if (Number(top.score) >= matcher.AUTO_MATCH_SCORE) {
    return {status: 'EXTRACTED', statusText: `Strong candidate ${top.purchaseOrder}`};
  }
  return {
    status: 'NEEDS_REVIEW',
    statusText: `Best candidate ${top.purchaseOrder} scored ${Math.round(top.score * 100)}%`
  };
}


/** One line a reviewer can read in a list, without opening the document. */
function summarize(candidate) {
  try {
    const reasons = JSON.parse(candidate.reasons || '[]');
    return Array.isArray(reasons) ? reasons.slice(0, 2).join(' · ').slice(0, 500) : null;
  } catch (e) {
    return null;
  }
}


async function runPipeline(tx, documentId, jobId) {
  const {Documents, ExtractedInvoices, LineItems, PoCandidates} = cds.entities('com.invoiceiq');

  try {
    const job = await dox.poll(jobId);
    const {header, items, lowConfidence} = dox.toInvoice(job);

    // Replace any previous extraction for this document.
    const existing = await tx.run(
      SELECT.one.from(ExtractedInvoices).where({document_ID: documentId})
    );
    if (existing) await tx.run(DELETE.from(ExtractedInvoices).where({ID: existing.ID}));

    const invoiceId = cds.utils.uuid();
    await tx.run(INSERT.into(ExtractedInvoices).entries({
      ID: invoiceId,
      document_ID: documentId,
      ...header
    }));

    if (items.length) {
      await tx.run(INSERT.into(LineItems).entries(
        items.map(i => ({...i, invoice_ID: invoiceId}))
      ));
    }

    await tx.run(UPDATE(Documents, documentId).with({
      status: 'MATCHING',
      doxRawResult: JSON.stringify(job.extraction)
    }));
    LOG.info(`Document ${documentId} extracted, ${items.length} line(s), ` +
             `${lowConfidence.length} field(s) flagged`);

    // Matching is best effort: a broken S/4 connection must not lose the
    // extraction we already have.
    let candidates = [];
    try {
      const result = await matcher.rank({ID: invoiceId, ...header}, items);
      candidates = result.candidates;
    } catch (e) {
      LOG.warn(`Purchase order search failed for ${documentId}:`, e.message);
    }

    if (candidates.length) {
      await tx.run(INSERT.into(PoCandidates).entries(
        candidates.map(c => ({...c, invoice_ID: invoiceId}))
      ));
    }

    const clean = lowConfidence.length === 0;
    await tx.run(UPDATE(Documents, documentId).with(
      clean
        ? matchStatus(candidates)
        : {status: 'NEEDS_REVIEW', statusText: `Check: ${lowConfidence.join(', ')}`}
    ));
    LOG.info(`Document ${documentId}: ${candidates.length} PO candidate(s)`);

  } catch (e) {
    LOG.error(`Pipeline failed for document ${documentId}:`, e.message);
    await cds.tx(async t => {
      await t.run(UPDATE(cds.entities('com.invoiceiq').Documents, documentId)
        .with({status: 'FAILED', statusText: String(e.message).slice(0, 500)}));
    }).catch(err => LOG.error('Could not persist failure state:', err.message));
  }
}