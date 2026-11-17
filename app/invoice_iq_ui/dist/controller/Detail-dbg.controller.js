sap.ui.define([
  "./BaseController",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Sorter",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/f/library",
  "sap/m/MessageBox",
  "../model/formatter"
], function (BaseController, JSONModel, Sorter, Filter, FilterOperator,
             fioriLibrary, MessageBox, formatter) {
  "use strict";

  const LayoutType = fioriLibrary.LayoutType;
  const POLL_INTERVAL = 3000;
  const IN_FLIGHT = ["PENDING", "PROCESSING", "MATCHING"];

  // Maps our field names onto the Document AI field names that carry the
  // confidence scores, so the form can flag exactly what to re-check.
  const CONFIDENCE_MAP = {
    invoiceNumber: "documentNumber",
    invoiceDate: "documentDate",
    dueDate: "dueDate",
    poNumberRaw: "purchaseOrderNumber",
    vendorName: "senderName",
    vendorAddress: "senderAddress",
    taxId: "taxId",
    iban: "senderBankAccount",
    netAmount: "netAmount",
    taxAmount: "taxAmount",
    grossAmount: "grossAmount",
    currency: "currencyCode"
  };

  return BaseController.extend("invoiceiqui.controller.Detail", {

    formatter: formatter,

    onInit: function () {
      this.setModel(new JSONModel({}), "conf");
      this.setModel(new JSONModel(this._emptyMatch()), "match");

      ["detail", "preview"].forEach(function (sRoute) {
        this.getRouter().getRoute(sRoute).attachPatternMatched(this._onMatched, this);
      }, this);
    },

    onExit: function () {
      this._stopPolling();
    },

    _onMatched: function (oEvent) {
      const sId = oEvent.getParameter("arguments").documentId;
      this._sDocumentId = sId;
      this.getUiModel().setProperty("/previewOpen", oEvent.getParameter("name") === "preview");
      this._syncFullScreen();

      this.getView().bindElement({
        path: "/Documents(" + sId + ")",
        parameters: {
          // autoExpandSelect only asks for properties bound at the moment the
          // binding is created. Tab content renders lazily, so History's
          // fields were never requested and came back empty.
          $select: "ID,fileName,mimeType,fileSize,source,status,statusText,"
                 + "uploadedBy,uploadedAt,createdAt,modifiedAt",
          $expand: {
            invoice: {
              // autoExpandSelect only requests what the view binds, and the
              // match model reads fields nothing binds directly.
              $select: "ID,invoiceNumber,invoiceDate,dueDate,poNumberRaw,vendorName,"
                     + "vendorAddress,vendorPostalCode,vendorCountry,taxId,iban,"
                     + "netAmount,taxAmount,grossAmount,currency,paymentTerms,"
                     + "confidence,fieldConfidence,lowConfidence,reviewNote,reviewedBy,"
                     + "matchedPO,matchedSupplier,matchScore,matchSummary,matchedAt,matchedBy",
              $expand: {lineItems: {$orderby: "lineNo"}}
            }
          }
        },
        events: {
          dataRequested: function () { this.getUiModel().setProperty("/busy", true); }.bind(this),
          dataReceived: this._onDataReceived.bind(this),
          change: this._onBindingChange.bind(this)
        }
      });
    },

    _onDataReceived: function () {
      this.getUiModel().setProperty("/busy", false);
      this._syncDirty();
      this._syncFullScreen();
      this._applyConfidence();
      this._buildMatchModel();
      this._recalcLineSum();
      this._checkPolling();
    },

    _onBindingChange: function () {
      const oCtx = this.getView().getBindingContext();
      if (!oCtx) {
        this.getUiModel().setProperty("/busy", false);
        this.getRouter().getTargets().display("notFound");
      }
    },

    // -----------------------------------------------------------------------
    // Confidence
    // -----------------------------------------------------------------------

    /**
     * Turns the stored per-field confidence JSON into value states, so the
     * reviewer's eye lands on the fields the extractor was unsure about
     * instead of reading all of them.
     */
    _applyConfidence: function () {
      const oCtx = this.getView().getBindingContext();
      const oOut = {};
      if (!oCtx) return this.getModel("conf").setData(oOut);

      let oScores = {};
      try {
        oScores = JSON.parse(oCtx.getProperty("invoice/fieldConfidence") || "{}");
      } catch (e) {
        oScores = {};
      }

      Object.keys(CONFIDENCE_MAP).forEach(function (sField) {
        oOut[sField] = formatter.confidenceState(oScores[CONFIDENCE_MAP[sField]]);
      });

      this.getModel("conf").setData(oOut);
    },

    // -----------------------------------------------------------------------
    // The match
    // -----------------------------------------------------------------------

    /**
     * The Overview describes one purchase order: the confirmed match when
     * there is one, otherwise the strongest candidate, so a reviewer can see
     * what is being proposed before committing to it.
     */
    _buildMatchModel: async function () {
      const oCtx = this.getView().getBindingContext();
      const oModel = this.getModel("match");
      if (!oCtx) return oModel.setData(this._emptyMatch());

      const sInvoiceId = oCtx.getProperty("invoice/ID");
      const sMatched = oCtx.getProperty("invoice/matchedPO");

      // A to-many nested inside a to-one expand is not reliably readable from
      // the context, so the candidates are requested directly.
      let aCandidates = [];
      if (sInvoiceId) {
        try {
          const oBinding = this.getModel().bindList(
            "/PoCandidates", null,
            [new Sorter("rank")],
            [new Filter("invoice_ID", FilterOperator.EQ, sInvoiceId)]
          );
          const aCtxs = await oBinding.requestContexts(0, 20);
          aCandidates = aCtxs.map(function (c) { return c.getObject(); });
        } catch (e) {
          aCandidates = [];
        }
      }

      const oPick = aCandidates.find(function (c) {
        return c.purchaseOrder === sMatched;
      }) || aCandidates[0];

      const oState = this._bannerState(oCtx);

      const num = function (v) {
        const f = parseFloat(v);
        return isNaN(f) ? 0 : f;
      };
      const pct = function (v) { return Math.round(num(v) * 100); };

      if (!oPick) {
        formatter.setLineMatches({}, false);
        oModel.setData(Object.assign(this._emptyMatch(), oState));
        this._paintRing(0);
        return;
      }

      // Which invoice line hit which PO line, so the table can mark each row.
      const mLines = {};
      try {
        (JSON.parse(oPick.lineMatches || "[]") || []).forEach(function (m) {
          if (m && m.lineNo !== undefined) mLines[m.lineNo] = m;
        });
      } catch (e) { /* no pairing recorded */ }

      // Older candidates carry no per-line pairing. Rather than marking every
      // row unmatched, fall back to the aggregate line score.
      const bAllMatched = Object.keys(mLines).length === 0
        && num(oPick.lineScore) >= 0.7;

      formatter.setLineMatches(mLines, bAllMatched);

      const aReasons = this._readReasons(oPick.reasons);

      // Concerns first. A reviewer scanning eleven green ticks will not notice
      // the one line that disagrees, so the ones worth checking lead.
      const ORDER = {bad: 0, neutral: 1, good: 2};
      aReasons.sort(function (a, b) {
        return (ORDER[a.kind] ?? 1) - (ORDER[b.kind] ?? 1);
      });

      const iConcerns = aReasons.filter(function (r) { return r.kind === "bad"; }).length;
      const iSupport = aReasons.filter(function (r) { return r.kind === "good"; }).length;

      const oDate = oPick.poDate ? new Date(oPick.poDate) : null;

      oModel.setData(Object.assign({}, oState, {
        hasPo: true,
        noPo: false,
        purchaseOrder: oPick.purchaseOrder,
        supplier: oPick.supplier,
        companyCode: oPick.companyCode,
        purchasingOrg: oPick.purchasingOrg,
        purchasingGroup: oPick.purchasingGroup,
        poDate: oPick.poDate,
        poDateText: oDate && !isNaN(oDate)
          ? oDate.toLocaleDateString(undefined, {year: "numeric", month: "short", day: "numeric"})
          : "",
        paymentTerms: oPick.paymentTerms,
        currency: oPick.currency,
        netValue: oPick.netValue,
        netValueText: num(oPick.netValue).toLocaleString(undefined, {
          minimumFractionDigits: 2, maximumFractionDigits: 2
        }) + " " + (oPick.currency || ""),
        itemCount: oPick.itemCount,

        band: oPick.band,
        score: oPick.score,

        headerScore: oPick.headerScore,
        lineScore: oPick.lineScore,
        amountScore: oPick.amountScore,
        quantityScore: oPick.quantityScore,
        materialScore: oPick.materialScore,
        descriptionScore: oPick.descriptionScore,
        uomScore: oPick.uomScore,
        unitPriceScore: oPick.unitPriceScore,

        // ProgressIndicator wants 0-100.
        headerPct: pct(oPick.headerScore),
        linePct: pct(oPick.lineScore),
        amountPct: pct(oPick.amountScore),
        quantityPct: pct(oPick.quantityScore),
        materialPct: pct(oPick.materialScore),
        descriptionPct: pct(oPick.descriptionScore),
        uomPct: pct(oPick.uomScore),
        unitPricePct: pct(oPick.unitPriceScore),

        reasons: aReasons,
        reasonSummary: iConcerns
          ? this.getText("reasonsMixed", [iSupport, iConcerns])
          : this.getText("reasonsAllGood", [iSupport])
      }));

      this._paintRing(pct(oPick.score));
    },

    /**
     * Reasons were plain strings before the matcher started tagging them, and
     * stored candidates may still hold either shape.
     */
    _readReasons: function (sJson) {
      if (!sJson) return [];

      let aRaw;
      try {
        aRaw = JSON.parse(sJson);
      } catch (e) {
        return [{text: String(sJson), kind: "neutral", icon: "sap-icon://information", state: "None"}];
      }

      if (!Array.isArray(aRaw)) aRaw = [aRaw];

      const ICON = {
        good: "sap-icon://sys-enter-2",
        bad: "sap-icon://alert",
        neutral: "sap-icon://circle-task-2"
      };
      const STATE = {good: "Success", bad: "Warning", neutral: "None"};

      return aRaw
        .filter(Boolean)
        .map(function (r) {
          const oReason = typeof r === "string" ? {text: r, kind: "neutral"} : r;
          const sKind = ICON[oReason.kind] ? oReason.kind : "neutral";
          return {
            text: oReason.text,
            kind: sKind,
            icon: ICON[sKind],
            state: STATE[sKind]
          };
        })
        .filter(function (r) { return !!r.text; });
    },

    /**
     * refresh() returns before the new data arrives, so anything reading the
     * context straight after it sees the old values — which is why the status
     * only changed on a manual reload. requestRefresh resolves when the data
     * is actually there.
     */
    _refresh: async function () {
      const oBinding = this.getView().getElementBinding();
      if (!oBinding) return;

      try {
        await oBinding.requestRefresh();
      } catch (e) {
        oBinding.refresh();
      }

      this._applyConfidence();
      await this._buildMatchModel();
      this._recalcLineSum();

      // The worklist shows the same status in its own binding.
      this.getOwnerComponent().getEventBus()
        .publish("invoiceiq", "documentChanged", {documentId: this._sDocumentId});
    },

    _emptyMatch: function () {
      return {
        purchaseOrder: null, band: null, score: null, reasons: [], reasonSummary: null,
        hasPo: false, noPo: true,
        showMatched: false, showFailed: false, showOpen: true
      };
    },

    /**
     * Exactly one banner is shown. Expression bindings evaluate unpredictably
     * inside tab content, so the decision is made here and bound as a plain
     * boolean.
     */
    _bannerState: function (oCtx) {
      const sStatus = oCtx ? oCtx.getProperty("status") : null;
      const sMatched = oCtx ? oCtx.getProperty("invoice/matchedPO") : null;

      const bFailed = sStatus === "FAILED";
      const bMatched = !bFailed && !!sMatched;

      return {
        showMatched: bMatched,
        showFailed: bFailed,
        showOpen: !bFailed && !bMatched
      };
    },

    /**
     * The ring sweep comes from a style class rather than an inline CSS
     * variable. Tab content renders lazily, and addStyleClass applies to the
     * control whether or not its DOM exists yet, so there is no timing race.
     */
    _paintRing: function (iPercent) {
      const oRing = this.byId("scoreRing");
      if (!oRing) return;

      // Nearest 5% keeps the class list short and is indistinguishable at
      // this size.
      const iStep = Math.min(100, Math.max(0, Math.round((iPercent || 0) / 5) * 5));

      if (this._sRingClass) oRing.removeStyleClass(this._sRingClass);
      this._sRingClass = "iqRing" + iStep;
      oRing.addStyleClass(this._sRingClass);
    },

    // -----------------------------------------------------------------------
    // Line totals
    // -----------------------------------------------------------------------

    /**
     * A mismatch between the summed lines and the extracted net amount is the
     * most reliable sign the extraction dropped or duplicated a row.
     */
    _recalcLineSum: function () {
      const oUi = this.getUiModel();
      const oTable = this.byId("lineItemTable");
      const aItems = oTable ? oTable.getItems() : [];

      const fSum = aItems.reduce(function (fAcc, oItem) {
        const oCtx = oItem.getBindingContext();
        return fAcc + (oCtx ? parseFloat(oCtx.getProperty("lineTotal")) || 0 : 0);
      }, 0);

      const oCtx = this.getView().getBindingContext();
      const fNet = oCtx ? parseFloat(oCtx.getProperty("invoice/netAmount")) : NaN;
      const sCurrency = (oCtx && oCtx.getProperty("invoice/currency")) || "";

      oUi.setProperty("/lineCount", aItems.length);
      oUi.setProperty("/lineSum", fSum.toFixed(2) + " " + sCurrency);
      oUi.setProperty("/lineSumState",
        !aItems.length || isNaN(fNet) ? "None"
          : Math.abs(fSum - fNet) < 0.01 ? "Success" : "Warning");
    },

    onLineItemsUpdated: function () {
      this._recalcLineSum();
    },

    // -----------------------------------------------------------------------
    // Polling while extraction and matching are still running
    // -----------------------------------------------------------------------

    _checkPolling: function () {
      const oCtx = this.getView().getBindingContext();
      const sStatus = oCtx && oCtx.getProperty("status");
      if (IN_FLIGHT.indexOf(sStatus) > -1) this._startPolling();
      else this._stopPolling();
    },

    _startPolling: function () {
      if (this._iPoll) return;
      this._iPoll = setInterval(function () {
        const oBinding = this.getView().getElementBinding();
        if (!oBinding) return this._stopPolling();
        oBinding.refresh();
        this._applyConfidence();
        this._buildMatchModel();
        this._recalcLineSum();
        this._checkPolling();
      }.bind(this), POLL_INTERVAL);
    },

    _stopPolling: function () {
      if (!this._iPoll) return;
      clearInterval(this._iPoll);
      this._iPoll = null;
    },

    // -----------------------------------------------------------------------
    // Column control
    // -----------------------------------------------------------------------

    onTogglePreview: function () {
      const bOpen = this.getUiModel().getProperty("/previewOpen");
      this.getRouter().navTo(bOpen ? "detail" : "preview", {documentId: this._sDocumentId});
    },

    /**
     * Expands the detail over the whole window and back. The button's icon
     * carries the state, so a reviewer reading a long invoice never has to
     * guess which way it will go.
     */
    onToggleFullScreen: function () {
      const oUi = this.getUiModel();
      const bFull = oUi.getProperty("/layout") === LayoutType.MidColumnFullScreen;

      this.setLayout(bFull
        ? (oUi.getProperty("/previewOpen")
            ? LayoutType.ThreeColumnsMidExpanded
            : LayoutType.TwoColumnsMidExpanded)
        : LayoutType.MidColumnFullScreen);

      this._syncFullScreen();
    },

    /** Keeps the button in step, including when the layout changes elsewhere. */
    _syncFullScreen: function () {
      const oUi = this.getUiModel();
      const bFull = oUi.getProperty("/layout") === LayoutType.MidColumnFullScreen;

      oUi.setProperty("/fullScreen", bFull);
      oUi.setProperty("/fullScreenIcon",
        bFull ? "sap-icon://exit-full-screen" : "sap-icon://full-screen");
      oUi.setProperty("/fullScreenText",
        this.getText(bFull ? "exitFullScreen" : "fullScreen"));
    },

    onClose: function () {
      const oUi = this.getUiModel();
      oUi.setProperty("/previewOpen", false);
      if (oUi.getProperty("/layout") === LayoutType.MidColumnFullScreen) {
        this.setLayout(LayoutType.OneColumn);
      }
      this.getRouter().navTo("worklist");
    },

    onDownload: function () {
      this.getRouter().navTo("preview", {documentId: this._sDocumentId});
    },

    onOpenPoInS4: function () {
      const sPO = this.getModel("match").getProperty("/purchaseOrder");
      if (!sPO) return;

      const sBase = this.getUiModel().getProperty("/s4BaseUrl");
      if (!sBase) return MessageBox.information(this.getText("s4LinkUnavailable", [sPO]));

      window.open(sBase + "#PurchaseOrder-display&/PurchaseOrder(" + sPO + ")", "_blank");
    },

    // -----------------------------------------------------------------------
    // Editing
    // -----------------------------------------------------------------------

    /**
     * The V4 model fires no global dirty event, so each editable field reports
     * its own change and the footer reads one plain flag.
     */
    onFieldChange: function () {
      this._syncDirty();
      this._recalcLineSum();
    },

    _syncDirty: function () {
      this.getUiModel().setProperty("/hasChanges", this.getModel().hasPendingChanges());
    },

    onSave: async function () {
      const oModel = this.getModel();
      try {
        await oModel.submitBatch(oModel.getUpdateGroupId());
        this.getUiModel().setProperty("/hasChanges", false);
        this._recalcLineSum();
        this.toast("saved");
      } catch (oError) {
        this.showError(oError, "errorSave");
      }
    },

    onDiscard: function () {
      const oModel = this.getModel();
      oModel.resetChanges(oModel.getUpdateGroupId());
      this.getUiModel().setProperty("/hasChanges", false);
      this._recalcLineSum();
    },

    // -----------------------------------------------------------------------
    // Matching actions
    // -----------------------------------------------------------------------

    onFindCandidates: async function () {
      if (this.getModel().hasPendingChanges()) {
        return MessageBox.warning(this.getText("saveFirst"));
      }
      this.getUiModel().setProperty("/busy", true);
      try {
        const aCandidates = await this.callAction("findCandidates", {
          documentId: this._sDocumentId
        });
        await this._refresh();
        this.toast(aCandidates && aCandidates.length ? "candidatesFound" : "noCandidatesFound",
                   [aCandidates ? aCandidates.length : 0]);
      } catch (oError) {
        this.showError(oError, "errorSearch");
      } finally {
        this.getUiModel().setProperty("/busy", false);
      }
    },

    onSelectCandidate: function (oEvent) {
      const oCtx = oEvent.getSource().getBindingContext();
      const sPO = oCtx.getProperty("purchaseOrder");
      const fScore = parseFloat(oCtx.getProperty("score"));

      // Anything the scorer did not rate CLOSE or better deserves a look.
      if (fScore < 0.7) {
        MessageBox.confirm(this.getText("lowScoreConfirm", [sPO, Math.round(fScore * 100)]), {
          onClose: function (sAction) {
            if (sAction === MessageBox.Action.OK) this._confirmMatch(sPO);
          }.bind(this)
        });
        return;
      }
      this._confirmMatch(sPO);
    },

    _confirmMatch: async function (sPO) {
      this.getUiModel().setProperty("/busy", true);
      try {
        await this.callAction("confirmMatch", {
          documentId: this._sDocumentId,
          purchaseOrder: sPO
        });
        await this._refresh();
        this.toast("matched", [sPO]);
      } catch (oError) {
        this.showError(oError, "errorMatch");
      } finally {
        this.getUiModel().setProperty("/busy", false);
      }
    },

    /** A reviewer who already knows the purchase order can name it directly. */
    onAddCandidate: function () {
      const oInput = new sap.m.Input({
        width: "100%",
        placeholder: this.getText("addPOPlaceholder")
      });

      const oDialog = new sap.m.Dialog({
        title: this.getText("addPO"),
        contentWidth: "22rem",
        content: [new sap.m.VBox({
          items: [
            new sap.m.Text({text: this.getText("addPOPrompt")}),
            oInput
          ]
        }).addStyleClass("sapUiSmallMargin")],
        beginButton: new sap.m.Button({
          text: this.getText("addPO"),
          type: "Emphasized",
          press: function () {
            const sPO = (oInput.getValue() || "").trim();
            oDialog.close();
            if (sPO) this._addCandidate(sPO);
          }.bind(this)
        }),
        endButton: new sap.m.Button({
          text: this.getText("cancel"),
          press: function () { oDialog.close(); }
        }),
        afterClose: function () { oDialog.destroy(); }
      });

      this.getView().addDependent(oDialog);
      oDialog.open();
    },

    _addCandidate: async function (sPO) {
      this.getUiModel().setProperty("/busy", true);
      try {
        await this.callAction("addCandidate", {
          documentId: this._sDocumentId,
          purchaseOrder: sPO
        });
        await this._refresh();
        this.toast("candidateAdded", [sPO]);
      } catch (oError) {
        this.showError(oError, "errorAddCandidate");
      } finally {
        this.getUiModel().setProperty("/busy", false);
      }
    },

    onClearMatch: async function () {
      try {
        await this.callAction("clearMatch", {documentId: this._sDocumentId});
        await this._refresh();
        this.toast("matchCleared");
      } catch (oError) {
        this.showError(oError, "errorMatch");
      }
    },

    // -----------------------------------------------------------------------
    // Review actions
    // -----------------------------------------------------------------------

    onConfirm: async function () {
      if (this.getModel().hasPendingChanges()) {
        return MessageBox.warning(this.getText("saveFirst"));
      }
      try {
        await this.callAction("confirmExtraction", {documentId: this._sDocumentId});
        await this._refresh();
        this.toast("confirmed");
      } catch (oError) {
        this.showError(oError, "errorConfirm");
      }
    },

    onReject: function () {
      MessageBox.confirm(this.getText("rejectPrompt"), {
        onClose: async function (sAction) {
          if (sAction !== MessageBox.Action.OK) return;
          try {
            await this.callAction("rejectDocument", {
              documentId: this._sDocumentId,
              reason: this.getText("rejectedByUser")
            });
            await this._refresh();
            this.toast("rejected");
          } catch (oError) {
            this.showError(oError, "errorReject");
          }
        }.bind(this)
      });
    },

    onReprocess: async function () {
      try {
        await this.callAction("processDocument", {documentId: this._sDocumentId});
        await this._refresh();
        this._startPolling();
        this.toast("reprocessing");
      } catch (oError) {
        this.showError(oError, "errorReprocess");
      }
    }
  });
});