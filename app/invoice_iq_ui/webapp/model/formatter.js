sap.ui.define([], function () {
  "use strict";

  const STATUS = {
    PENDING:      {text: "Pending",      state: "None",        icon: "sap-icon://pending"},
    PROCESSING:   {text: "Processing",   state: "Information", icon: "sap-icon://process"},
    MATCHING:     {text: "Matching",     state: "Information", icon: "sap-icon://process"},
    EXTRACTED:    {text: "Extracted",    state: "Success",     icon: "sap-icon://accept"},
    NEEDS_REVIEW: {text: "Needs review", state: "Warning",     icon: "sap-icon://alert"},
    MATCHED:      {text: "Matched",      state: "Success",     icon: "sap-icon://accept"},
    CONFIRMED:    {text: "Confirmed",    state: "Success",     icon: "sap-icon://complete"},
    REJECTED:     {text: "Rejected",     state: "Error",       icon: "sap-icon://decline"},
    FAILED:       {text: "Failed",       state: "Error",       icon: "sap-icon://error"}
  };

  // Mirrors EXTRACT_CONFIDENCE_THRESHOLD on the server.
  const THRESHOLD = 0.8;
  const WEAK = 0.9;

  // Which PO line each invoice line paired with. UI5 invokes formatters with
  // the *controller* as `this`, so both the state and the helper below live in
  // module scope — a formatter that calls this.something silently renders blank.
  let mLineMatches = {};
  let bAllMatched = false;

  function isLineMatched(iLineNo) {
    const m = mLineMatches[iLineNo];
    if (m) return m.score >= 0.7;
    return bAllMatched;
  }

  // Donut geometry, drawn as inline SVG rather than a CSS variable set from
  // JavaScript: tab content renders lazily and the element often did not exist
  // when the score arrived.
  const RING_R = 52;
  const RING_C = 2 * Math.PI * RING_R;

  return {

    setLineMatches: function (mMatches, bAll) {
      mLineMatches = mMatches || {};
      bAllMatched = !!bAll;
    },

    statusText:  function (s) { return (STATUS[s] || {}).text  || ""; },
    statusState: function (s) { return (STATUS[s] || {}).state || "None"; },
    statusIcon:  function (s) { return (STATUS[s] || {}).icon  || ""; },

    /** Only a genuine failure gets the red banner. */
    isFailed: function (s) {
      return s === "FAILED";
    },

    /**
     * Bars were all green regardless of value, which made a weak signal look
     * like a strong one at a glance.
     */
    signalState: function (v) {
      const f = parseFloat(v);
      if (isNaN(f)) return "None";
      if (f >= 0.80) return "Success";
      if (f >= 0.50) return "Warning";
      return "Error";
    },

    /**
     * CAP Timestamps arrive as ISO strings. sap.ui.model.odata.type.DateTimeOffset
     * expects a Date unless told it is V4, so those bindings silently rendered
     * nothing — which is why "Uploaded on" and "Matched on" were blank while
     * the text fields beside them were fine.
     */
    dateTime: function (v) {
      if (!v) return "";
      const d = v instanceof Date ? v : new Date(v);
      if (isNaN(d.getTime())) return "";
      return d.toLocaleString(undefined, {
        year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit"
      });
    },

    date: function (v) {
      if (!v) return "";
      const d = v instanceof Date ? v : new Date(v);
      if (isNaN(d.getTime())) return "";
      return d.toLocaleDateString(undefined, {
        year: "numeric", month: "short", day: "numeric"
      });
    },

    percent: function (v) {
      const f = parseFloat(v);
      return isNaN(f) ? "" : Math.round(f * 100) + "%";
    },

    /**
     * Error below the server threshold, Warning in the grey zone above it,
     * None once the extractor was clearly confident.
     */
    confidenceState: function (v) {
      const f = parseFloat(v);
      if (isNaN(f)) return "None";
      if (f < THRESHOLD) return "Error";
      if (f < WEAK) return "Warning";
      return "None";
    },

    /** EXACT | CLOSE | POSSIBLE | WEAK, set by the scorer. */
    bandText: function (s) {
      const M = {EXACT: "EXACT", CLOSE: "CLOSE", POSSIBLE: "POSSIBLE", WEAK: "WEAK"};
      return M[s] || "";
    },

    bandState: function (s) {
      const M = {EXACT: "Success", CLOSE: "Success", POSSIBLE: "Warning", WEAK: "Error"};
      return M[s] || "None";
    },

    /**
     * The candidates table shows the reasons as one line. Older rows hold
     * plain strings; newer ones hold {text, kind}, so both are flattened.
     */
    reasons: function (sJson) {
      if (!sJson) return "";
      try {
        const a = JSON.parse(sJson);
        if (!Array.isArray(a)) return String(sJson);
        return a
          .map(function (r) { return typeof r === "string" ? r : r && r.text; })
          .filter(Boolean)
          .join(" · ");
      } catch (e) {
        return String(sJson);
      }
    },

    lineMatchText:  function (n) { return isLineMatched(n) ? "Matched" : "Unmatched"; },
    lineMatchState: function (n) { return isLineMatched(n) ? "Success" : "None"; },
    lineMatchIcon:  function (n) { return isLineMatched(n) ? "sap-icon://accept" : ""; },

    /**
     * The match score as a donut. Colours come from Horizon tokens so the
     * chart follows the launchpad theme.
     */
    ringSvg: function (fScore) {
      const f = parseFloat(fScore);
      const iPct = isNaN(f) ? 0 : Math.max(0, Math.min(100, Math.round(f * 100)));
      const fDash = (iPct / 100) * RING_C;

      const sColour = iPct >= 90 ? "var(--sapPositiveElementColor)"
                    : iPct >= 70 ? "var(--sapPositiveElementColor)"
                    : iPct >= 40 ? "var(--sapCriticalElementColor)"
                    : "var(--sapNegativeElementColor)";

      return [
        '<svg viewBox="0 0 120 120" class="iqRingSvg" role="img" aria-label="',
        iPct, ' percent match">',
        '<circle cx="60" cy="60" r="', RING_R, '" fill="none" stroke-width="12" ',
        'stroke="var(--sapGroup_ContentBorderColor)"/>',
        '<circle cx="60" cy="60" r="', RING_R, '" fill="none" stroke-width="12" ',
        'stroke-linecap="round" stroke="', sColour, '" ',
        'stroke-dasharray="', fDash.toFixed(2), ' ', RING_C.toFixed(2), '" ',
        'transform="rotate(-90 60 60)"/>',
        '<text x="60" y="58" text-anchor="middle" dominant-baseline="middle" ',
        'class="iqRingSvgPct">', isNaN(f) ? "–" : iPct + "%", '</text>',
        '<text x="60" y="78" text-anchor="middle" dominant-baseline="middle" ',
        'class="iqRingSvgLabel">Match Score</text>',
        '</svg>'
      ].join("");
    }
  };
});