const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const ai = require('./ai-core');

const LOG = cds.log('invoice-iq');


// ============================================================================
// CONFIGURATION
// ============================================================================

const DEST = process.env.S4_DESTINATION || 'S4HanaCloud';

const BASE =
  process.env.S4_PO_BASE ||
  '/sap/opu/odata4/sap/api_purchaseorder_2/srvd_a2x/sap/purchaseorder/0001';

const PO_HEADER_PATH = `${BASE}/PurchaseOrder`;
const PO_ITEM_PATH = `${BASE}/PurchaseOrderItem`;

// Navigation property from a purchase order to its items. Confirm against your
// metadata: GET /PurchaseOrder?$top=1&$expand=_PurchaseOrderItem
const ITEM_NAV = process.env.S4_PO_ITEM_NAV || '_PurchaseOrderItem';

const AMOUNT_TOLERANCE = Number(process.env.MATCH_AMOUNT_TOLERANCE || 0.02);
const AUTO_MATCH_SCORE = Number(process.env.MATCH_AUTO_THRESHOLD || 0.90);
const MAX_CANDIDATES = Number(process.env.MATCH_MAX_CANDIDATES || 50);
const TOP_N = Number(process.env.MATCH_TOP_N || 5);
const MIN_SCORE = Number(process.env.MATCH_MIN_SCORE || 0.05);

// Once a candidate reaches this, the search stops widening. Set at CLOSE:
// below it the pool is probably missing the right order rather than containing
// a poor one.
const SEARCH_SATISFIED = Number(process.env.MATCH_SEARCH_SATISFIED || 0.70);


// ============================================================================
// WEIGHTS
// ============================================================================
//
// Header 20%, lines 80%. Nothing is looked up by key: an invoice is matched on
// the fields the two documents have in common. A purchase order reference
// printed on the invoice is one of those fields, scored like any other — it
// corroborates a content match, it cannot create one.
// ============================================================================

const HEADER_WEIGHTS = {
  poReference: 0.07,
  paymentTerms: 0.03,
  documentDate: 0.06,
  currency: 0.04
};

const LINE_WEIGHTS = {
  material: 0.20,
  description: 0.10,
  quantity: 0.10,
  uom: 0.05,
  unitPrice: 0.10,
  netAmount: 0.30
};

// Applied when pairing one invoice line against one purchase order line.
const PAIR_WEIGHTS = {
  material: 0.30,
  description: 0.20,
  quantity: 0.10,
  uom: 0.05,
  unitPrice: 0.15,
  netAmount: 0.20
};


// ============================================================================
// HTTP
// ============================================================================

async function get(path) {
  const response = await executeHttpRequest(
    { destinationName: DEST },
    { method: 'GET', url: path, headers: { Accept: 'application/json' } },
    { fetchCsrfToken: false }
  );

  // OData V4 returns { value: [...] }; V2 returns { d: { results: [...] } }.
  if (Array.isArray(response.data?.value)) return response.data.value;

  return (
    response.data?.d?.results ??
    (response.data?.d ? [response.data.d] : [])
  );
}


function odataString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}


// ============================================================================
// HELPERS
// ============================================================================

function normalize(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}


function normalizeText(value) {
  return normalize(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}


function decay(delta, halfLife) {
  return Math.exp(-Math.LN2 * (delta / halfLife));
}


function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : (pluralForm || singular + 's')}`;
}


function round(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}


// ============================================================================
// FIELD RESOLUTION
// ============================================================================
//
// Property casing varies between the V4 CE service, the older A2X service and
// hand-built Z services, so every read goes through a fallback list.
// ============================================================================

function field(item, ...names) {
  for (const name of names) {
    if (item?.[name] !== undefined && item?.[name] !== null) return item[name];
  }
  return null;
}

const getPurchaseOrder     = h => field(h, 'PurchaseOrder', 'PurchaseOrderNumber', 'Ebeln');
const getSupplier          = h => field(h, 'Supplier', 'Lifnr');
const getCompanyCode       = h => field(h, 'CompanyCode', 'Bukrs');
const getPurchasingOrg     = h => field(h, 'PurchasingOrganization', 'Ekorg');
const getPurchasingGroup   = h => field(h, 'PurchasingGroup', 'Ekgrp');
const getPaymentTerms      = h => field(h, 'PaymentTerms', 'Zterm');
const getPurchaseOrderDate = h => field(h, 'PurchaseOrderDate', 'CreationDate', 'Bedat');
const getCurrency          = h => field(h, 'DocumentCurrency', 'Currency', 'Waers');
const getDeletionCode      = h => field(h, 'PurchaseOrderDeletionCode', 'DeletionCode', 'Loekz');

const getMaterial    = i => field(i, 'Material', 'ManufacturerMaterial', 'MaterialNumber');
const getDescription = i => field(i, 'PurchaseOrderItemText', 'ItemText', 'Description', 'ShortText');
const getQuantity    = i => field(i, 'OrderQuantity', 'Quantity', 'Menge');
const getUOM         = i => field(i, 'PurchaseOrderQuantityUnit', 'BaseUnit', 'OrderPriceUnit', 'Meins');
const getUnitPrice   = i => field(i, 'NetPriceAmount', 'NetPrice', 'Netpr');
const getNetAmount   = i => field(i, 'NetAmount', 'NetValue', 'Netwr');


// ============================================================================
// UNIT OF MEASURE
// ============================================================================
//
// Document AI returns UN/CEFACT codes (H87, KGM) while SAP stores its own short
// units (PC, KG). Comparing them raw fails on every line.
// ============================================================================

const UOM_ALIASES = {
  H87: 'PC', C62: 'EA', NAR: 'EA', PCE: 'PC', ST: 'PC', STK: 'PC', PCS: 'PC',
  KGM: 'KG', GRM: 'G', TNE: 'TO', LBR: 'LB', ONZ: 'OZ',
  MTR: 'M', KMT: 'KM', CMT: 'CM', MMT: 'MM', FOT: 'FT', INH: 'IN',
  MTK: 'M2', MTQ: 'M3', LTR: 'L', MLT: 'ML', GLL: 'GAL',
  HUR: 'H', DAY: 'DAY', WEE: 'WK', MON: 'MON', ANN: 'YR'
};


function normalizeUom(value) {
  if (!value) return null;
  const s = String(value).trim().toUpperCase();
  return UOM_ALIASES[s] || s;
}


function uomEqual(a, b) {
  const na = normalizeUom(a);
  const nb = normalizeUom(b);
  if (!na || !nb) return true;   // absence is not disagreement
  return na === nb;
}


// ============================================================================
// SHAPE
// ============================================================================

function shape(header, items = []) {
  const normalized = items.map(item => ({
    ...item,
    PurchaseOrderItem: field(item, 'PurchaseOrderItem', 'PurchaseOrderItemNumber', 'Ebelp'),
    Material: getMaterial(item),
    PurchaseOrderItemText: getDescription(item),
    OrderQuantity: getQuantity(item),
    PurchaseOrderQuantityUnit: getUOM(item),
    NetPriceAmount: getUnitPrice(item),
    NetAmount: getNetAmount(item)
  }));

  return {
    PurchaseOrder: getPurchaseOrder(header),
    Supplier: getSupplier(header),
    CompanyCode: getCompanyCode(header),
    PurchasingOrganization: getPurchasingOrg(header),
    PurchasingGroup: getPurchasingGroup(header),
    PaymentTerms: getPaymentTerms(header),
    PurchaseOrderDate: getPurchaseOrderDate(header),
    DocumentCurrency: getCurrency(header),
    PurchaseOrderDeletionCode: getDeletionCode(header),

    items: normalized,

    netValue: normalized.reduce(
      (sum, item) => sum + (safeNumber(item.NetAmount) || 0), 0
    )
  };
}


// ============================================================================
// READ ONE
// ============================================================================
//
// Used by confirmMatch and addCandidate, where a human has named the order.
// Matching itself never calls this.
// ============================================================================

async function readPO(purchaseOrder) {
  const filter = `PurchaseOrder eq ${odataString(purchaseOrder)}`;

  LOG.info(`Reading purchase order ${purchaseOrder}`);

  const headers = await get(
    `${PO_HEADER_PATH}?$filter=${encodeURIComponent(filter)}&$top=1`
  );

  const header = headers[0];
  if (!header) {
    LOG.warn(`Purchase order ${purchaseOrder} not found`);
    return null;
  }

  const items = await get(`${PO_ITEM_PATH}?$filter=${encodeURIComponent(filter)}`);
  return shape(header, items);
}


// ============================================================================
// SEARCH
// ============================================================================
//
// Items arrive through $expand, so the pool costs one request rather than one
// per order. An AI Core search plan, when available, becomes the filter — that
// is where the model does the finding: it never sees a purchase order, it
// decides which slice of them is worth looking at.
//
// Every part of the plan is optional, and every narrowing step has a floor. A
// plan that excludes everything is worse than no plan, so the search widens
// rather than returning nothing.
// ============================================================================

function buildFilter(parts) {
  return parts.filter(Boolean).join(' and ');
}


function poolUrl(filter, top) {
  return `${PO_HEADER_PATH}?$expand=${ITEM_NAV}`
       + (filter ? `&$filter=${encodeURIComponent(filter)}` : '')
       + `&$orderby=PurchaseOrderDate desc&$top=${top || MAX_CANDIDATES}`;
}


function shiftDate(iso, months) {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}


/**
 * The search widens in stages. Each stage gives up one constraint, so the
 * first that finds a convincing order is also the narrowest that could.
 *
 *   1  everything the plan asked for
 *   2  same window, any currency      — the extractor may have misread it
 *   3  window widened either way      — the order may predate the plan's guess
 *   4  no filter at all               — most recent orders
 *
 * A stage that produces nothing, or produces only weak candidates, falls
 * through to the next. Exact and partial are not separate code paths: the
 * filter decides plausibility, the score decides agreement, and widening
 * simply enlarges what gets scored.
 */
function buildTiers(plan) {
  if (!plan) {
    return [{ label: 'recent orders', filter: '' }];
  }

  const currency = plan.currency
    ? `DocumentCurrency eq ${odataString(plan.currency)}`
    : null;

  const from = plan.dateFrom ? `PurchaseOrderDate ge ${plan.dateFrom}` : null;
  const to = plan.dateTo ? `PurchaseOrderDate le ${plan.dateTo}` : null;

  const wideFrom = shiftDate(plan.dateFrom, -12);
  const wideTo = shiftDate(plan.dateTo, 3);

  const tiers = [];

  if (currency || from || to) {
    tiers.push({ label: 'planned filter', filter: buildFilter([currency, from, to]) });
  }

  if (currency && (from || to)) {
    tiers.push({ label: 'any currency', filter: buildFilter([from, to]) });
  }

  if (wideFrom || wideTo) {
    tiers.push({
      label: 'wider date window',
      filter: buildFilter([
        wideFrom ? `PurchaseOrderDate ge ${wideFrom}` : null,
        wideTo ? `PurchaseOrderDate le ${wideTo}` : null
      ])
    });
  }

  tiers.push({ label: 'recent orders', filter: '' });

  // Two tiers with the same filter would fetch the same rows twice.
  const seen = new Set();
  return tiers.filter(t => {
    if (seen.has(t.filter)) return false;
    seen.add(t.filter);
    return true;
  });
}


/**
 * Applies the parts of the plan OData cannot express: the value bracket, which
 * needs the item sum, and keywords, which need a contains() per word.
 *
 * Both are hints, not rules. If either would empty the pool it is dropped,
 * because a shortlist a reviewer can reject beats no shortlist at all.
 */
function narrow(pool, plan) {
  if (!plan || !pool.length) return pool;

  let result = pool;

  if (plan.minNetValue || plan.maxNetValue) {
    const byValue = result.filter(po => {
      const value = po.netValue;
      if (!value) return true;                       // unknown, keep it
      if (plan.minNetValue && value < plan.minNetValue) return false;
      if (plan.maxNetValue && value > plan.maxNetValue) return false;
      return true;
    });

    if (byValue.length) result = byValue;
    else LOG.info('Value bracket excluded every order; ignoring it');
  }

  if (plan.keywords?.length) {
    const byKeyword = result.filter(po =>
      po.items.some(item => {
        const text = String(item.PurchaseOrderItemText || '').toLowerCase();
        return plan.keywords.some(k => text.includes(k));
      })
    );

    if (byKeyword.length) result = byKeyword;
    else LOG.info('No order matched the plan keywords; ignoring them');
  }

  return result;
}


async function fetchTier(filter) {
  let headers;
  try {
    headers = await get(poolUrl(filter));
  } catch (error) {
    // A plan can produce a filter the service rejects.
    LOG.warn(`Filtered search failed (${error.message})`);
    return [];
  }

  return headers
    .filter(h => !getDeletionCode(h))
    .map(h => shape(h, h[ITEM_NAV] || []))
    .filter(po => po.items.length > 0);
}


async function fetchPool(plan) {
  const pool = await fetchTier(buildFilter([
    plan?.currency ? `DocumentCurrency eq ${odataString(plan.currency)}` : null,
    plan?.dateFrom ? `PurchaseOrderDate ge ${plan.dateFrom}` : null,
    plan?.dateTo ? `PurchaseOrderDate le ${plan.dateTo}` : null
  ]));

  return narrow(pool, plan);
}


/** Every open purchase order with its items. No arguments, no filters. */
async function listAll() {
  return fetchTier('');
}


// ============================================================================
// HEADER SIGNALS
// ============================================================================

/**
 * A purchase order reference printed on the invoice, compared against the
 * candidate's own number. Leading zeros and separators differ between what a
 * vendor prints and what SAP stores, so both sides are reduced to digits.
 *
 * This is a comparison, not a lookup. It cannot fetch anything and at 8% of
 * the total it cannot crown an order whose content disagrees.
 */
function scorePoReference(invoice, po) {
  const printed = invoice.poNumberRaw;
  const actual = po.PurchaseOrder;

  if (!printed || !actual) {
    return { score: 0.5, reason: 'no purchase order reference on the invoice' };
  }

  const digits = v => String(v).replace(/\D/g, '').replace(/^0+/, '');
  const a = digits(printed);
  const b = digits(actual);

  if (!a || !b) {
    return { score: 0.5, reason: 'purchase order reference not comparable' };
  }

  if (a === b) {
    return { score: 1, reason: `invoice quotes purchase order ${actual}` };
  }

  // Vendors sometimes print a shortened or extended form of the number.
  if (a.endsWith(b) || b.endsWith(a)) {
    return { score: 0.8, reason: `invoice reference resembles ${actual}` };
  }

  return { score: 0, reason: `invoice quotes a different reference (${printed})` };
}


// SAP stores a four-digit key; invoices print the human form. Only a handful
// of keys are standard, and a landscape adds a few more, so this is a lookup
// rather than anything clever.
const TERMS_DAYS = Object.assign({
  '0001': 0, '0002': 14, '0003': 14, '0004': 30, '0005': 14,
  '0006': 0, '0007': 30, '0008': 10, '0009': 30, 'NT30': 30
}, JSON.parse(process.env.PAYMENT_TERMS_DAYS || '{}'));


function extractPaymentDays(value) {
  if (!value) return null;

  const text = String(value);

  // "Net 30", "30 days", "payable within 45 days"
  const written = text.match(/(\d+)\s*(?:day|days)/i);
  if (written) return Number(written[1]);

  const net = text.match(/\bnet\s*(\d+)\b/i);
  if (net) return Number(net[1]);

  // A bare SAP key, or one printed alongside its description.
  for (const code of text.match(/\b\d{4}\b/g) || []) {
    if (TERMS_DAYS[code] !== undefined) return TERMS_DAYS[code];
  }

  return null;
}


function scorePaymentTerms(invoice, po) {
  const invoiceTerms = invoice.paymentTerms;
  const poTerms = po.PaymentTerms;

  if (!invoiceTerms || !poTerms) {
    return { score: 0.5, reason: 'payment terms unavailable' };
  }

  // An invoice may print "0002 / Net 30" where S/4 stores "0002". Compare the
  // codes first, then fall back to the day count.
  const invoiceCodes = String(invoiceTerms).match(/\b\d{4}\b/g) || [];
  if (invoiceCodes.includes(String(poTerms).trim())) {
    return { score: 1, reason: `payment terms match (${poTerms})` };
  }

  if (normalizeText(invoiceTerms) === normalizeText(poTerms)) {
    return { score: 1, reason: 'payment terms match' };
  }

  const invoiceDays = extractPaymentDays(invoiceTerms);
  const poDays = extractPaymentDays(poTerms);

  if (invoiceDays !== null && poDays !== null) {
    return invoiceDays === poDays
      ? { score: 1, reason: `payment terms match (${invoiceDays} days)` }
      : { score: 0, reason: `payment terms differ (${invoiceDays} vs ${poDays} days)` };
  }

  return { score: 0.5, reason: 'payment terms not directly comparable' };
}


function scoreDocumentDate(invoice, po) {
  if (!invoice.invoiceDate || !po.PurchaseOrderDate) {
    return { score: 0.5, reason: 'document date unavailable' };
  }

  const invoiceTime = new Date(invoice.invoiceDate).getTime();
  const poTime = new Date(po.PurchaseOrderDate).getTime();

  if (!Number.isFinite(invoiceTime) || !Number.isFinite(poTime)) {
    return { score: 0.5, reason: 'document date not comparable' };
  }

  const days = Math.abs(invoiceTime - poTime) / 86400000;

  return {
    score: decay(days, 30),
    reason: `PO and invoice dates ${plural(Math.round(days), 'day')} apart`
  };
}


function scoreCurrency(invoice, po) {
  if (!invoice.currency || !po.DocumentCurrency) {
    return { score: 0.5, reason: 'currency unavailable' };
  }

  return normalize(invoice.currency) === normalize(po.DocumentCurrency)
    ? { score: 1, reason: `currency matches (${po.DocumentCurrency})` }
    : { score: 0, reason: `currency differs (${invoice.currency} vs ${po.DocumentCurrency})` };
}


// ============================================================================
// TEXT SIMILARITY
// ============================================================================

function textSimilarity(a, b) {
  const aa = normalizeText(a);
  const bb = normalizeText(b);

  if (!aa || !bb) return 0;
  if (aa === bb) return 1;

  const aWords = new Set(aa.split(' '));
  const bWords = new Set(bb.split(' '));

  const intersection = [...aWords].filter(w => bWords.has(w)).length;
  const union = new Set([...aWords, ...bWords]).size;

  return union ? intersection / union : 0;
}


// ============================================================================
// AGGREGATE LINE SIGNALS
// ============================================================================
//
// These are what the reviewer reads: "material agreement 100%" explains a
// score where a single number does not.
// ============================================================================

/**
 * A short delivery is not a disagreement. When the invoice bills fewer units
 * than the order at the same unit price, and the line total is what that
 * quantity costs, the two documents agree completely — the vendor simply has
 * not shipped everything yet.
 *
 * Without this, a genuine partial delivery scores worse on quantity than an
 * unrelated order that happens to have a similar figure.
 */
function isPartialDelivery(invoiceLine, poLine) {
  const invoiceQty = safeNumber(invoiceLine.quantity);
  const poQty = safeNumber(getQuantity(poLine));
  if (invoiceQty === null || poQty === null || invoiceQty >= poQty) return false;

  const invoicePrice = safeNumber(invoiceLine.unitPrice);
  const poPrice = safeNumber(getUnitPrice(poLine));
  if (invoicePrice === null || poPrice === null || poPrice === 0) return false;

  // Prices must agree, or the shortfall is a repricing rather than a delivery.
  if (Math.abs(invoicePrice - poPrice) / Math.abs(poPrice) > AMOUNT_TOLERANCE) {
    return false;
  }

  // And the invoice must charge for what it says it shipped.
  const invoiceTotal = safeNumber(invoiceLine.lineTotal);
  if (invoiceTotal === null) return true;            // nothing to contradict it

  const expected = invoiceQty * invoicePrice;
  return Math.abs(invoiceTotal - expected) / Math.abs(expected) <= AMOUNT_TOLERANCE;
}


function scoreMaterial(invoiceItems, poItems) {
  if (!invoiceItems?.length || !poItems?.length) {
    return { score: 0.5, reason: 'material unavailable' };
  }

  const withMaterial = invoiceItems.filter(i => !!i.materialNumber);
  if (!withMaterial.length) {
    return { score: 0.5, reason: 'invoice material unavailable' };
  }

  const matched = withMaterial.filter(invoiceItem =>
    poItems.some(poItem =>
      normalize(invoiceItem.materialNumber) === normalize(getMaterial(poItem))
    )
  ).length;

  const score = matched / withMaterial.length;
  return { score, reason: `material agreement ${Math.round(score * 100)}%` };
}


function scoreDescription(invoiceItems, poItems) {
  if (!invoiceItems?.length || !poItems?.length) {
    return { score: 0.5, reason: 'description unavailable' };
  }

  let total = 0;
  let compared = 0;

  for (const invoiceItem of invoiceItems) {
    if (!invoiceItem.description) continue;

    let best = 0;
    for (const poItem of poItems) {
      const poDescription = getDescription(poItem);
      if (!poDescription) continue;
      const similarity = textSimilarity(invoiceItem.description, poDescription);
      if (similarity > best) best = similarity;
    }

    total += best;
    compared++;
  }

  if (!compared) return { score: 0.5, reason: 'invoice description unavailable' };

  const score = total / compared;
  return { score, reason: `description agreement ${Math.round(score * 100)}%` };
}


function scoreQuantity(invoiceItems, poItems) {
  if (!invoiceItems?.length || !poItems?.length) {
    return { score: 0.5, reason: 'quantity unavailable' };
  }

  let total = 0;
  let compared = 0;
  let partialLines = 0;

  for (const invoiceItem of invoiceItems) {
    const invoiceQty = safeNumber(invoiceItem.quantity);
    if (invoiceQty === null) continue;

    let best = 0;
    let partial = false;

    for (const poItem of poItems) {
      const poQty = safeNumber(getQuantity(poItem));
      if (poQty === null || poQty === 0) continue;

      const delta = Math.abs(invoiceQty - poQty) / Math.abs(poQty);

      // A consistent short delivery is agreement, not drift.
      const score = delta <= 0.001
        ? 1
        : isPartialDelivery(invoiceItem, poItem) ? 0.95 : decay(delta, 0.5);

      if (score > best) {
        best = score;
        partial = score === 0.95;
      }
    }

    if (partial) partialLines++;

    total += best;
    compared++;
  }

  if (!compared) return { score: 0.5, reason: 'quantity could not be compared' };

  const score = total / compared;

  return {
    score,
    reason: partialLines
      ? `quantity agreement ${Math.round(score * 100)}% (${partialLines} short delivery)`
      : `quantity agreement ${Math.round(score * 100)}%`
  };
}


function scoreUOM(invoiceItems, poItems) {
  if (!invoiceItems?.length || !poItems?.length) {
    return { score: 0.5, reason: 'unit of measure unavailable' };
  }

  let matched = 0;
  let compared = 0;

  for (const invoiceItem of invoiceItems) {
    if (!invoiceItem.uom) continue;
    compared++;

    const hit = poItems.some(poItem => {
      const poUom = getUOM(poItem);
      return poUom && uomEqual(invoiceItem.uom, poUom);
    });

    if (hit) matched++;
  }

  if (!compared) return { score: 0.5, reason: 'unit of measure unavailable' };

  const score = matched / compared;
  return { score, reason: `unit of measure agreement ${Math.round(score * 100)}%` };
}


function scoreUnitPrice(invoiceItems, poItems) {
  if (!invoiceItems?.length || !poItems?.length) {
    return { score: 0.5, reason: 'unit price unavailable' };
  }

  let total = 0;
  let compared = 0;

  for (const invoiceItem of invoiceItems) {
    const invoicePrice = safeNumber(invoiceItem.unitPrice);
    if (invoicePrice === null) continue;

    let best = 0;
    for (const poItem of poItems) {
      const poPrice = safeNumber(getUnitPrice(poItem));
      if (poPrice === null || poPrice === 0) continue;

      const delta = Math.abs(invoicePrice - poPrice) / Math.abs(poPrice);
      const score = delta <= AMOUNT_TOLERANCE ? 1 : decay(delta, 0.10);
      if (score > best) best = score;
    }

    total += best;
    compared++;
  }

  if (!compared) return { score: 0.5, reason: 'unit price unavailable' };

  const score = total / compared;
  return { score, reason: `unit price agreement ${Math.round(score * 100)}%` };
}


// ============================================================================
// NET AMOUNT
// ============================================================================

/**
 * Finds a subset of purchase order lines summing to the invoice total. Billing
 * part of an order is routine; scoring it as a 90% mismatch loses matches a
 * human would spot immediately.
 */
function subsetMatches(target, values, tolerance, maxPicks) {
  if (!target || !values.length || values.length > 16) return null;

  const limit = maxPicks || values.length;
  const best = { diff: Infinity, picks: null, count: 0 };
  const n = values.length;

  for (let mask = 1; mask < (1 << n); mask++) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) { sum += values[i]; count++; }
    }

    // A subset larger than the invoice has lines cannot be what was billed.
    if (count > limit) continue;

    const diff = Math.abs(sum - target) / target;
    if (diff < best.diff) {
      best.diff = diff;
      best.picks = mask;
      best.count = count;
      if (diff <= tolerance) break;
    }
  }

  if (best.diff > tolerance) return null;
  return { count: best.count, total: n };
}


/**
 * How much a subset hit is worth. With many purchase order lines there are
 * hundreds of subsets, so one landing near the invoice total is unremarkable
 * and must not be read as evidence.
 *
 *   2^total  is how many subsets existed
 *   picks    is how many the winner used
 *
 * A single line matching a single line is near certain to be real. Three lines
 * chosen from nine is a coincidence waiting to happen.
 */
function subsetConfidence(picks, total) {
  if (picks === total) return 1;          // the whole order was billed
  if (picks === 1 && total <= 4) return 0.95;
  if (picks === 1) return 0.85;

  // Each extra line drawn from a larger pool weakens the claim.
  const spread = Math.pow(0.7, picks - 1) * Math.pow(0.92, Math.max(0, total - picks));
  return Math.max(0.3, Math.min(0.85, spread));
}


function scoreNetAmount(invoice, po) {
  const invoiceNet = safeNumber(invoice.netAmount);

  if (invoiceNet === null || !po.items.length) {
    return { score: 0.5, reason: 'net amount unavailable' };
  }

  const poNet = po.netValue;
  if (!poNet) return { score: 0.5, reason: 'PO net value unavailable' };

  const delta = Math.abs(invoiceNet - poNet) / Math.abs(poNet);
  const pct = (delta * 100).toFixed(1);

  if (delta <= AMOUNT_TOLERANCE) {
    return { score: 1, reason: 'invoice amount matches PO amount' };
  }

  if (invoiceNet < poNet) {
    const values = po.items
      .map(item => safeNumber(getNetAmount(item)))
      .filter(value => value !== null && value > 0);

    // An invoice cannot bill more purchase order lines than it has lines of
    // its own, give or take one for a combined charge.
    const maxPicks = Math.max(1, (invoice.lineCount || 1) + 1);

    const subset = subsetMatches(invoiceNet, values, AMOUNT_TOLERANCE, maxPicks);
    if (subset) {
      const confidence = subsetConfidence(subset.count, subset.total);
      return {
        score: 0.95 * confidence,
        reason: confidence >= 0.8
          ? `partial invoice: covers ${subset.count} of ${subset.total} PO lines`
          : `possible partial invoice: ${subset.count} of ${subset.total} PO lines could sum to this`
      };
    }
  }

  return {
    score: Math.max(0.05, decay(delta, 0.12)),
    reason: `invoice amount off by ${pct}%`
  };
}


// ============================================================================
// LINE PAIRING
// ============================================================================
//
// Each invoice line is paired with its strongest purchase order line before
// scoring, so a quantity matching on one line and a material matching on
// another cannot inflate the result between them.
// ============================================================================

function scoreLinePair(invoiceLine, poLine) {
  const scores = [];

  if (invoiceLine.materialNumber && getMaterial(poLine)) {
    scores.push({
      name: 'material',
      score: normalize(invoiceLine.materialNumber) === normalize(getMaterial(poLine)) ? 1 : 0
    });
  }

  if (invoiceLine.description && getDescription(poLine)) {
    scores.push({
      name: 'description',
      score: textSimilarity(invoiceLine.description, getDescription(poLine))
    });
  }

  const invoiceQty = safeNumber(invoiceLine.quantity);
  const poQty = safeNumber(getQuantity(poLine));
  if (invoiceQty !== null && poQty !== null && poQty !== 0) {
    const delta = Math.abs(invoiceQty - poQty) / Math.abs(poQty);
    scores.push({
      name: 'quantity',
      score: delta <= 0.001
        ? 1
        : isPartialDelivery(invoiceLine, poLine) ? 0.95 : decay(delta, 0.5)
    });
  }

  if (invoiceLine.uom && getUOM(poLine)) {
    scores.push({
      name: 'uom',
      score: uomEqual(invoiceLine.uom, getUOM(poLine)) ? 1 : 0
    });
  }

  const invoicePrice = safeNumber(invoiceLine.unitPrice);
  const poPrice = safeNumber(getUnitPrice(poLine));
  if (invoicePrice !== null && poPrice !== null && poPrice !== 0) {
    const delta = Math.abs(invoicePrice - poPrice) / Math.abs(poPrice);
    scores.push({
      name: 'unitPrice',
      score: delta <= AMOUNT_TOLERANCE ? 1 : decay(delta, 0.10)
    });
  }

  const invoiceAmount = safeNumber(invoiceLine.lineTotal);
  const poAmount = safeNumber(getNetAmount(poLine));
  if (invoiceAmount !== null && poAmount !== null && poAmount !== 0) {
    const delta = Math.abs(invoiceAmount - poAmount) / Math.abs(poAmount);
    scores.push({
      name: 'netAmount',
      score: delta <= AMOUNT_TOLERANCE
        ? 1
        : isPartialDelivery(invoiceLine, poLine) ? 0.95 : decay(delta, 0.12)
    });
  }

  if (!scores.length) return { score: 0.5, matchedFields: [] };

  let weighted = 0;
  let totalWeight = 0;

  for (const entry of scores) {
    const weight = PAIR_WEIGHTS[entry.name] ?? 0;
    weighted += entry.score * weight;
    totalWeight += weight;
  }

  return {
    score: totalWeight ? weighted / totalWeight : 0.5,
    matchedFields: scores.filter(e => e.score >= 0.8).map(e => e.name)
  };
}


function matchInvoiceLines(invoiceItems, poItems) {
  if (!invoiceItems?.length || !poItems?.length) {
    return { score: 0.5, matches: [], matchedCount: 0 };
  }

  const matches = [];

  for (let i = 0; i < invoiceItems.length; i++) {
    let best = null;

    for (let j = 0; j < poItems.length; j++) {
      const result = scoreLinePair(invoiceItems[i], poItems[j]);
      if (!best || result.score > best.score) {
        best = {
          lineNo: invoiceItems[i].lineNo,
          poItem: poItems[j].PurchaseOrderItem,
          score: result.score,
          matchedFields: result.matchedFields
        };
      }
    }

    if (best) matches.push(best);
  }

  if (!matches.length) return { score: 0.5, matches: [], matchedCount: 0 };

  const score = matches.reduce((sum, m) => sum + m.score, 0) / matches.length;
  const matchedCount = matches.filter(m => m.score >= 0.7).length;

  return { score, matches, matchedCount };
}


// ============================================================================
// CANDIDATE SCORE
// ============================================================================

/**
 * Pairs a reason with a verdict, so the interface can show a disagreement as a
 * disagreement. Previously every reason was rendered with the same tick, which
 * made "payment terms differ" read as confirmation.
 *
 *   good     the signal supports this candidate
 *   neutral  nothing to compare, or genuinely ambivalent
 *   bad      the two documents disagree
 */
function reason(text, score) {
  if (!Number.isFinite(score)) return { text, kind: 'neutral' };
  if (score >= 0.80) return { text, kind: 'good' };
  if (score >= 0.40) return { text, kind: 'neutral' };
  return { text, kind: 'bad' };
}


function band(score) {
  if (score >= 0.90) return 'EXACT';
  if (score >= 0.70) return 'CLOSE';
  if (score >= 0.40) return 'POSSIBLE';
  return 'WEAK';
}


function weightedAverage(entries, weights) {
  let total = 0;
  let sum = 0;

  for (const [name, value] of Object.entries(entries)) {
    const weight = weights[name] ?? 0;
    total += value * weight;
    sum += weight;
  }

  return sum ? total / sum : 0.5;
}


function scoreCandidate(invoice, invoiceItems, po) {
  const reference = scorePoReference(invoice, po);
  const paymentTerms = scorePaymentTerms(invoice, po);
  const documentDate = scoreDocumentDate(invoice, po);
  const currency = scoreCurrency(invoice, po);

  const material = scoreMaterial(invoiceItems, po.items);
  const description = scoreDescription(invoiceItems, po.items);
  const quantity = scoreQuantity(invoiceItems, po.items);
  const uom = scoreUOM(invoiceItems, po.items);
  const unitPrice = scoreUnitPrice(invoiceItems, po.items);
  const netAmount = scoreNetAmount(
    { ...invoice, lineCount: (invoiceItems || []).length }, po
  );

  const pairing = matchInvoiceLines(invoiceItems, po.items);

  const lineCount = (invoiceItems || []).length;
  const pairingRatio = lineCount ? pairing.matchedCount / lineCount : 0;

  // Written for a reviewer, strongest evidence first, each carrying whether it
  // supports the candidate or argues against it.
  const reasons = [
    reason(netAmount.reason, netAmount.score),
    reason(
      `${pairing.matchedCount} of ${plural(lineCount, 'line item')} matched`,
      pairingRatio
    ),
    reason(material.reason, material.score),
    reason(description.reason, description.score),
    reason(quantity.reason, quantity.score),
    reason(unitPrice.reason, unitPrice.score),
    reason(uom.reason, uom.score),
    reason(currency.reason, currency.score),
    reason(reference.reason, reference.score),
    reason(paymentTerms.reason, paymentTerms.score),
    reason(documentDate.reason, documentDate.score)
  ];

  const headerScore = weightedAverage({
    poReference: reference.score,
    paymentTerms: paymentTerms.score,
    documentDate: documentDate.score,
    currency: currency.score
  }, HEADER_WEIGHTS);

  const aggregateLineScore = weightedAverage({
    material: material.score,
    description: description.score,
    quantity: quantity.score,
    uom: uom.score,
    unitPrice: unitPrice.score,
    netAmount: netAmount.score
  }, LINE_WEIGHTS);

  const lineScore = aggregateLineScore * 0.60 + pairing.score * 0.40;
  const score = Math.round((headerScore * 0.20 + lineScore * 0.80) * 1000) / 1000;

  return {
    score,
    band: band(score),
    reasons,
    details: {
      headerScore,
      lineScore: pairing.score,
      netAmountScore: netAmount.score,
      quantityScore: quantity.score,
      materialScore: material.score,
      descriptionScore: description.score,
      uomScore: uom.score,
      unitPriceScore: unitPrice.score,
      referenceScore: reference.score,
      lineMatches: pairing.matches
    }
  };
}


function toCandidate(po, score, reasons, rank, matchBand, details) {
  const d = details || {};

  return {
    rank,
    band: matchBand || band(score),

    purchaseOrder: po.PurchaseOrder,
    supplier: po.Supplier,
    companyCode: po.CompanyCode,
    purchasingOrg: po.PurchasingOrganization,
    purchasingGroup: po.PurchasingGroup,
    poDate: po.PurchaseOrderDate ?? null,
    paymentTerms: po.PaymentTerms ?? null,
    netValue: po.netValue,
    currency: po.DocumentCurrency ?? null,
    itemCount: po.items.length,

    score,

    // Persisted so the summary can show which signals carried the match,
    // rather than only the number they produced.
    headerScore:      round(d.headerScore),
    lineScore:        round(d.lineScore),
    amountScore:      round(d.netAmountScore),
    quantityScore:    round(d.quantityScore),
    materialScore:    round(d.materialScore),
    descriptionScore: round(d.descriptionScore),
    uomScore:         round(d.uomScore),
    unitPriceScore:   round(d.unitPriceScore),

    reasons: JSON.stringify(reasons),
    lineMatches: JSON.stringify(d.lineMatches || [])
  };
}


// ============================================================================
// RANK
// ============================================================================

/**
 * Scores every purchase order in the pool against the invoice and returns the
 * best few. There is no fast path and no lookup by key: an invoice quoting a
 * purchase order number goes through the same scoring as one that quotes
 * nothing, so the number is corroborated by the content rather than trusted
 * on sight.
 */
async function rank(invoice, invoiceItems) {

  // Step 1: the model reads the invoice and decides how to search.
  const plan = await ai.plan(invoice, invoiceItems);

  const tiers = buildTiers(plan);
  const seen = new Set();
  const scored = [];

  // Step 2: widen until something convincing turns up.
  for (const tier of tiers) {
    const fetched = await fetchTier(tier.filter);
    const pool = narrow(fetched, plan).filter(po => {
      if (seen.has(po.PurchaseOrder)) return false;
      seen.add(po.PurchaseOrder);
      return true;
    });

    LOG.info(`Tier "${tier.label}": ${pool.length} new order(s)`);
    if (!pool.length) continue;

    for (const po of pool) {
      const result = scoreCandidate(invoice, invoiceItems, po);
      if (result.score >= MIN_SCORE) scored.push({ po, ...result, tier: tier.label });
    }

    const best = scored.reduce((m, c) => Math.max(m, c.score), 0);
    if (best >= SEARCH_SATISFIED) {
      LOG.info(`Stopping at "${tier.label}": best score ${best}`);
      break;
    }

    LOG.info(`Best so far ${best.toFixed(3)}, below ${SEARCH_SATISFIED}; widening`);
  }

  if (!scored.length) {
    LOG.info('No purchase order scored above the floor');
    return { candidates: [], plan };
  }

  let candidates = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_N)
    .map((c, index) => {
      const candidate = toCandidate(
        c.po, c.score, c.reasons, index + 1, c.band, c.details
      );
      // Worth telling the reviewer how hard we had to look.
      if (c.tier !== 'planned filter') {
        const reasons = JSON.parse(candidate.reasons);
        reasons.push({
          text: `found by widening the search to ${c.tier}`,
          kind: 'neutral'
        });
        candidate.reasons = JSON.stringify(reasons);
      }
      return candidate;
    });

  // Step 3: the model judges the shortlist it cannot add to.
  candidates = await ai.judge(invoice, invoiceItems, candidates);

  LOG.info(`Scored ${scored.length} order(s), returning ${candidates.length}`);
  if (plan?.rationale) LOG.info(`Search rationale: ${plan.rationale}`);

  return { candidates, plan };
}


module.exports = {
  rank,
  readPO,
  listAll,
  fetchPool,
  fetchTier,
  buildTiers,
  subsetMatches,
  isPartialDelivery,
  subsetConfidence,
  scoreCandidate,
  scorePoReference,
  toCandidate,
  band,
  buildFilter,
  AUTO_MATCH_SCORE
};