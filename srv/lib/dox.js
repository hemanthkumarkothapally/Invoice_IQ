const FormData = require('form-data');
const {executeHttpRequest} = require('@sap-cloud-sdk/http-client');

const DESTINATION = process.env.DOX_DESTINATION || 'Doc_AI';
const CLIENT_ID = process.env.DOX_CLIENT_ID || 'default';
const SCHEMA_NAME = process.env.DOX_SCHEMA_NAME || 'SAP_invoice_schema';
const TENANT_ID = process.env.DOX_TENANT_ID;
const MOCK = process.env.DOX_MOCK === 'true';

// Every DOX call on this landscape needs the tenant explicitly; the token's
// zid claim is not used for tenant resolution.
const Q = TENANT_ID ? `?tenantId=${TENANT_ID}` : '';

const CONFIDENCE_THRESHOLD = Number(process.env.EXTRACT_CONFIDENCE_THRESHOLD || 0.8);

// Fields that must be trustworthy before a document skips review.
const CRITICAL_FIELDS = ['documentNumber', 'documentDate', 'grossAmount', 'currencyCode', 'senderName'];

const HEADER_FIELDS = [
  'documentNumber',
  'documentDate',
  'dueDate',
  'purchaseOrderNumber',
  'senderName',
  'senderAddress',
  'senderCity',
  'senderPostalCode',
  'senderCountryCode',
  'taxId',
  'senderBankAccount',
  'netAmount',
  'taxAmount',
  'grossAmount',
  'currencyCode',
  'paymentTerms'
];

const LINE_ITEM_FIELDS = [
  'description',
  'materialNumber',
  'quantity',
  'unitOfMeasure',
  'unitPrice',
  'netAmount'
];

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Unwraps the DOX error body; axios only surfaces the status code. */
function describe(e) {
  const status = e?.response?.status || e?.cause?.response?.status || e?.status;
  const body = e?.response?.data ?? e?.cause?.response?.data;
  const detail = typeof body === 'string' ? body : JSON.stringify(body);
  return `${status || 'no status'}: ${detail || e.message}`;
}

async function submit(buffer, fileName, mimeType = 'application/pdf') {
  if (MOCK) return `mock-${Date.now()}`;

  const form = new FormData();
  form.append('file', buffer, {filename: fileName || 'document.pdf', contentType: mimeType});
    form.append('options', JSON.stringify({
    schemaName: SCHEMA_NAME,
    clientId: CLIENT_ID,
    documentType: 'invoice',
    receivedDate: new Date().toISOString().slice(0, 10),
    enrichment: {
      sender: {top: 5, type: 'businessEntity', subtype: 'supplier'},
      employee: {type: 'employee'}
    }
  }), {contentType: 'application/json'});

  let res;
  try {
    res = await executeHttpRequest(
      {destinationName: DESTINATION},
      {
        method: 'POST',
        url: `/document/jobs${Q}`,
        headers: form.getHeaders(),
        data: form
      },
      // DOX is plain REST with bearer auth. The Cloud SDK's CSRF probe sends a
      // HEAD first, DOX answers 405, and the real request never goes out.
      {fetchCsrfToken: false}
    );
  } catch (e) {
    throw new Error(`Document AI rejected the job (${describe(e)})`);
  }

  const jobId = res?.data?.id;
  if (!jobId) throw new Error('Document AI accepted the file but returned no job id');
  return jobId;
}

async function getJob(jobId) {
  if (MOCK) return require('./mock-extraction.json');

  try {
    const res = await executeHttpRequest(
      {destinationName: DESTINATION},
      {method: 'GET', url: `/document/jobs/${jobId}${Q}`},
      {fetchCsrfToken: false}
    );
    return res.data;
  } catch (e) {
    throw new Error(`Document AI job read failed (${describe(e)})`);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Polls until the job reaches a terminal state. ~2 minutes of headroom. */
async function poll(jobId, {attempts = 40, intervalMs = 3000} = {}) {
  if (MOCK) {
    await sleep(1500);
    return getJob(jobId);
  }

  for (let i = 0; i < attempts; i++) {
    const job = await getJob(jobId);
    const status = String(job?.status || '').toUpperCase();

    if (status === 'DONE' || status === 'SUCCESS') {
      if (!job.extraction) throw new Error('Document AI reported DONE but returned no extraction');
      return job;
    }
    if (status === 'FAILED' || status === 'ERROR') {
      throw new Error(`Document AI failed: ${job?.error?.message || 'no detail returned'}`);
    }
    await sleep(intervalMs);
  }
  throw new Error(`Document AI did not finish within ${(attempts * intervalMs) / 1000}s`);
}

// ---------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const cleaned = String(v).replace(/[^\d.,-]/g, '');
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  // Whichever separator comes last is the decimal point.
  const normalized = lastComma > lastDot
    ? cleaned.replace(/\./g, '').replace(',', '.')
    : cleaned.replace(/,/g, '');
  const n = Number.parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

function date(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function str(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function mapHeaderFields(headerFields = []) {
  const values = {};
  const confidence = {};
  for (const f of headerFields) {
    if (!f?.name) continue;
    values[f.name] = f.value;
    if (typeof f.confidence === 'number') confidence[f.name] = f.confidence;
  }
  return {values, confidence};
}

function mapLineItems(lineItems = []) {
  return lineItems.map((row, idx) => {
    const obj = {};
    for (const f of row || []) if (f?.name) obj[f.name] = f.value;
    return {
      lineNo: idx + 1,
      description: str(obj.description),
      materialNumber: str(obj.materialNumber),
      quantity: num(obj.quantity),
      uom: str(obj.unitOfMeasure)?.slice(0, 10) || null,   // CEFACT code, e.g. H87
      unitPrice: num(obj.unitPrice),
      lineTotal: num(obj.netAmount)
    };
  });
}


/**
 * Any critical field missing or below threshold sends the document to review.
 * Averaging confidence hides exactly the failures that matter, so the per
 * field map is kept alongside the average.
 */
function assess(values, confidence) {
  const low = [];
  for (const f of CRITICAL_FIELDS) {
    const v = values[f];
    if (v === null || v === undefined || v === '') {
      low.push(f);
      continue;
    }
    const c = confidence[f];
    if (typeof c === 'number' && c < CONFIDENCE_THRESHOLD) low.push(f);
  }
  return low;
}

/** Turns a finished DOX job into the shape the CAP entities expect. */
function toInvoice(job) {
  const extraction = job.extraction || {};
  const {values, confidence} = mapHeaderFields(extraction.headerFields);
  const items = mapLineItems(extraction.lineItems);

  const scores = Object.values(confidence);
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const lowConfidence = assess(values, confidence);

  return {
    header: {
      invoiceNumber: str(values.documentNumber),
      invoiceDate: date(values.documentDate),
      dueDate: date(values.dueDate),
      vendorName: str(values.senderName),
      vendorAddress: str(values.senderAddress),
      vendorPostalCode: str(values.senderPostalCode),
      vendorCountry: str(values.senderCountryCode)?.slice(0, 3) || null,
      taxId: str(values.taxId),
      iban: str(values.senderBankAccount)?.replace(/\s/g, '') || null,
      poNumberRaw: str(values.purchaseOrderNumber)?.replace(/\s/g, '') || null,
      netAmount: num(values.netAmount),
      taxAmount: num(values.taxAmount),
      grossAmount: num(values.grossAmount),
      currency: str(values.currencyCode)?.slice(0, 3) || null,
      paymentTerms: str(values.paymentTerms),
      confidence: avg,
      fieldConfidence: JSON.stringify(confidence),
      lowConfidence: JSON.stringify(lowConfidence)
    },
    items,
    lowConfidence
  };
}

module.exports = {
  submit, getJob, poll, toInvoice,
  mapHeaderFields, mapLineItems,
  num, date, str,
  CONFIDENCE_THRESHOLD, CRITICAL_FIELDS, MOCK
};