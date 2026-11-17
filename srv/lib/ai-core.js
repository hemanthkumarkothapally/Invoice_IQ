const cds = require('@sap/cds');

const LOG = cds.log('invoice-iq');


// ============================================================================
// CONFIGURATION
// ============================================================================

const ENABLED = true;
const SERVICE = process.env.AI_CORE_SERVICE || 'GENERATIVE_AI_HUB';
const DEPLOYMENT = process.env.AI_RECOMMENDATION_DEFINITION_ID  || 'dd193bb3c46aea45';
const RESOURCE_GROUP = process.env.AI_CORE_RESOURCE_GROUP || 'default';
const ANTHROPIC_VERSION = process.env.AI_ANTHROPIC_VERSION || 'bedrock-2023-05-31';
const MAX_TOKENS = Number(process.env.AI_MAX_TOKENS || 1024);

// How far the model may move a deterministic score. The arithmetic rests on
// facts; the model adds judgement, and judgement should adjust rather than
// overrule.
const AI_WEIGHT = Number(process.env.AI_WEIGHT || 0.35);


// ============================================================================
// TRANSPORT
// ============================================================================

/**
 * Calls the Bedrock-hosted Anthropic deployment on AI Core.
 *
 * The model is asked for JSON but the endpoint has no structured-output mode,
 * so the reply is steered two ways: the system prompt says JSON only, and the
 * conversation is prefilled with an opening brace. A model continuing from `{`
 * has nowhere to put a preamble.
 */
async function invoke(sSystem, sUser) {
  if (!DEPLOYMENT) throw new Error('AI_RECOMMENDATION_DEFINITION_ID is not set');

  const destination = await cds.connect.to(SERVICE);

  const response = await destination.send({
    method: 'POST',
    path: `/v2/inference/deployments/${DEPLOYMENT}/invoke`,
    headers: {
      'Content-Type': 'application/json',
      'AI-Resource-Group': RESOURCE_GROUP
    },
    data: {
      anthropic_version: ANTHROPIC_VERSION,
      max_tokens: MAX_TOKENS,
      temperature: 0,
      system: sSystem,
      messages: [
        { role: 'user', content: sUser },
        { role: 'assistant', content: '{' }
      ]
    }
  });

  return readText(response);
}


/**
 * Bedrock returns { content: [ { type: 'text', text: '...' } ] }. CAP's remote
 * service hands back the body directly, but a raw HTTP client wraps it in
 * `data`, so both shapes are accepted.
 */
function readText(response) {
  const body = response?.content ? response : response?.data;
  const blocks = body?.content;

  if (!Array.isArray(blocks)) {
    throw new Error('AI Core returned no content blocks');
  }

  const text = blocks
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('');

  if (!text) throw new Error('AI Core returned no text');

  // The prefilled brace is not echoed back, so put it in front again.
  return '{' + text;
}


/** Models wrap JSON in fences no matter how firmly you ask them not to. */
function extractJson(text) {
  if (!text) return null;

  const cleaned = String(text).replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;

  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    LOG.warn('AI Core returned unparseable JSON:', e.message);
    return null;
  }
}


// ============================================================================
// STEP 1 — SEARCH PLAN
// ============================================================================
//
// AI Core cannot query S/4HANA, so it finds nothing directly. What it does is
// read the invoice and decide how to search: which currency, which date
// window, roughly what value, which words are worth matching against purchase
// order item text. Those constraints become the OData filter.
//
// This is where the model earns its place. A fixed pool of recent orders
// misses the right one entirely on a busy system, and no amount of scoring
// recovers from the right answer not being in the pool.
// ============================================================================

const PLAN_PROMPT = `You plan a purchase order search from a supplier invoice.

You never see the purchase orders. You decide how to look for them.

Given the invoice, return the narrowest search that would still contain the
right order. Be generous with the date window: purchase orders precede their
invoices, sometimes by months.

Reply with a single JSON object and nothing else:
{"currency":"USD" or null,
 "dateFrom":"YYYY-MM-DD" or null,
 "dateTo":"YYYY-MM-DD" or null,
 "minNetValue":number or null,
 "maxNetValue":number or null,
 "keywords":["word","word"],
 "rationale":"one short sentence"}

Rules:
- dateFrom should be well before the invoice date; dateTo is usually the
  invoice date itself, allowing a few days for an order raised late.
- minNetValue and maxNetValue bracket the plausible order value. An invoice may
  bill part of a larger order, so maxNetValue should be several times the
  invoice amount, and minNetValue at or below it.
- keywords are distinctive nouns from the line descriptions, lowercase, at most
  six. Skip generic words like service, item, unit, charge.
- Use null wherever the invoice gives you nothing to go on. A null is better
  than a guess that excludes the right order.`;


function buildPlanPrompt(invoice, invoiceItems) {
  return JSON.stringify({
    invoiceDate: invoice.invoiceDate,
    dueDate: invoice.dueDate,
    currency: invoice.currency,
    netAmount: Number(invoice.netAmount) || null,
    grossAmount: Number(invoice.grossAmount) || null,
    paymentTerms: invoice.paymentTerms,
    vendor: invoice.vendorName,
    lines: (invoiceItems || []).map(i => ({
      description: i.description,
      material: i.materialNumber,
      quantity: Number(i.quantity) || null,
      uom: i.uom,
      unitPrice: Number(i.unitPrice) || null,
      netAmount: Number(i.lineTotal) || null
    }))
  }, null, 1);
}


function clampDate(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? s : null;
}


function clampNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}


/**
 * Returns search constraints, or null when the model is off or unavailable.
 * A null means the caller falls back to its own default pool, so a broken
 * model costs accuracy rather than function.
 */
async function plan(invoice, invoiceItems) {
  if (!ENABLED) return null;

  let parsed;
  try {
    parsed = extractJson(await invoke(PLAN_PROMPT, buildPlanPrompt(invoice, invoiceItems)));
  } catch (e) {
    LOG.warn('AI search planning unavailable, using the default pool:', e.message);
    return null;
  }
  if (!parsed) return null;

  const result = {
    currency: typeof parsed.currency === 'string'
      ? parsed.currency.slice(0, 3).toUpperCase()
      : null,
    dateFrom: clampDate(parsed.dateFrom),
    dateTo: clampDate(parsed.dateTo),
    minNetValue: clampNumber(parsed.minNetValue),
    maxNetValue: clampNumber(parsed.maxNetValue),
    keywords: Array.isArray(parsed.keywords)
      ? parsed.keywords
          .filter(k => typeof k === 'string' && k.length > 2)
          .slice(0, 6)
          .map(k => k.toLowerCase())
      : [],
    rationale: typeof parsed.rationale === 'string'
      ? parsed.rationale.slice(0, 200)
      : null
  };

  // A window that ends before it starts would silently return nothing.
  if (result.dateFrom && result.dateTo && result.dateFrom > result.dateTo) {
    result.dateFrom = null;
    result.dateTo = null;
  }

  LOG.info('AI search plan: ' + JSON.stringify({
    currency: result.currency,
    from: result.dateFrom,
    to: result.dateTo,
    keywords: result.keywords.length
  }));

  return result;
}


// ============================================================================
// STEP 2 — JUDGEMENT
// ============================================================================
//
// The deterministic scorer ranks by arithmetic. The model reads the same
// shortlist the way a clerk would and says which one it believes, and why. It
// can only reorder what it was given: anything it names that was not on the
// shortlist is discarded, because a hallucinated purchase order reaching a
// reviewer as a suggestion is the one failure that cannot be tolerated.
// ============================================================================

const JUDGE_PROMPT = `You match supplier invoices to purchase orders in an SAP landscape.

You are given one invoice and a shortlist of candidate purchase orders that a
deterministic scorer already retrieved and ranked. Judge which candidate an
accounts payable clerk would choose, and say why.

Rules you must follow:
- Choose only from the candidate purchase order numbers provided. Never invent one.
- A partial invoice against a larger order is normal and is a good match.
- Freight, handling and rounding can make an invoice slightly exceed an order.
- Vendors describe goods in their own words; wording need not match exactly.
- A supplier's own part number often differs from the buyer's material number.
- If nothing fits, say so rather than forcing a choice.

Reply with a single JSON object and nothing else:
{"ranking":[{"purchaseOrder":"...","confidence":0.0,"rationale":"one short sentence"}],
 "bestMatch":"..." or null,
 "summary":"one sentence for the reviewer"}

confidence is 0 to 1. Order the ranking best first. Keep every rationale under
20 words and state the concrete evidence, not a restatement of the score.`;


function safeParse(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [String(s)];
  } catch (e) {
    return s ? [String(s)] : [];
  }
}


function buildJudgePrompt(invoice, invoiceItems, candidates) {
  const oInvoice = {
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.invoiceDate,
    vendor: invoice.vendorName,
    poReferenceOnInvoice: invoice.poNumberRaw || null,
    currency: invoice.currency,
    netAmount: Number(invoice.netAmount) || null,
    lines: (invoiceItems || []).map(i => ({
      description: i.description,
      material: i.materialNumber,
      quantity: Number(i.quantity) || null,
      uom: i.uom,
      unitPrice: Number(i.unitPrice) || null,
      netAmount: Number(i.lineTotal) || null
    }))
  };

  const aOptions = candidates.map(c => ({
    purchaseOrder: c.purchaseOrder,
    supplier: c.supplier,
    poDate: c.poDate,
    currency: c.currency,
    netValue: Number(c.netValue) || null,
    itemCount: c.itemCount,
    deterministicScore: Number(c.score),
    band: c.band,
    signals: safeParse(c.reasons)
  }));

  return 'INVOICE\n' + JSON.stringify(oInvoice, null, 1)
       + '\n\nCANDIDATE PURCHASE ORDERS\n' + JSON.stringify(aOptions, null, 1);
}


function band(score) {
  if (score >= 0.90) return 'EXACT';
  if (score >= 0.70) return 'CLOSE';
  if (score >= 0.40) return 'POSSIBLE';
  return 'WEAK';
}


/**
 * Blends the model's judgement into the deterministic ranking. Returns the
 * candidates unchanged on any failure, so matching never breaks because the
 * model is unavailable.
 */
async function judge(invoice, invoiceItems, candidates) {
  if (!ENABLED || !candidates?.length) return candidates;

  // One candidate has nothing to reorder.
  if (candidates.length < 2) return candidates;

  let parsed;
  try {
    parsed = extractJson(
      await invoke(JUDGE_PROMPT, buildJudgePrompt(invoice, invoiceItems, candidates))
    );
  } catch (e) {
    LOG.warn('AI judgement unavailable, keeping the deterministic order:', e.message);
    return candidates;
  }

  if (!parsed?.ranking?.length) return candidates;

  const known = new Map(candidates.map(c => [String(c.purchaseOrder), c]));
  const judged = new Map();

  for (const r of parsed.ranking) {
    const po = String(r.purchaseOrder || '');
    if (!known.has(po)) {
      LOG.warn(`AI proposed unknown purchase order ${po}; ignoring`);
      continue;
    }

    const confidence = Number(r.confidence);
    judged.set(po, {
      confidence: Number.isFinite(confidence)
        ? Math.min(Math.max(confidence, 0), 1)
        : null,
      rationale: typeof r.rationale === 'string' ? r.rationale.slice(0, 500) : null
    });
  }

  if (!judged.size) return candidates;

  const blended = candidates.map(c => {
    const j = judged.get(String(c.purchaseOrder));

    if (!j || j.confidence === null) {
      return Object.assign({}, c, { aiRationale: j?.rationale || null });
    }

    const score = Math.round(
      ((1 - AI_WEIGHT) * Number(c.score) + AI_WEIGHT * j.confidence) * 1000
    ) / 1000;

    return Object.assign({}, c, {
      score,
      band: band(score),
      aiScore: j.confidence,
      aiRationale: j.rationale
    });
  });

  blended.sort((a, b) => b.score - a.score);
  blended.forEach((c, i) => { c.rank = i + 1; });

  LOG.info(`AI judged ${judged.size} candidate(s); best is now ${blended[0].purchaseOrder}`);
  return blended;
}


module.exports = { plan, judge, invoke, extractJson, readText, ENABLED };