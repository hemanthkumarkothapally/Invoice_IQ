sap.ui.define([
  "./BaseController",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/ui/model/Sorter",
  "sap/ui/core/Fragment",
  "../model/formatter"
], function (BaseController, JSONModel, Filter, FilterOperator, Sorter,
             Fragment, formatter) {
  "use strict";

  const POLL_INTERVAL = 3000;
  const IN_FLIGHT = ["PENDING", "PROCESSING", "MATCHING"];

  return BaseController.extend("invoiceiqui.controller.Worklist", {

    formatter: formatter,

    onInit: function () {
      this.setModel(new JSONModel({statusKey: "ALL", searchTerm: ""}), "worklist");

      // Counts sit beside the tab labels, so they are fetched separately from
      // the list itself and refreshed whenever it changes.
      this.setModel(new JSONModel({
        ALL: 0, PROCESSING: 0, NEEDS_REVIEW: 0, MATCHED: 0, FAILED: 0
      }), "counts");

      this.getRouter().getRoute("worklist").attachPatternMatched(this._onMatched, this);
      this.getRouter().getRoute("detail").attachPatternMatched(this._syncSelection, this);
      this.getRouter().getRoute("preview").attachPatternMatched(this._syncSelection, this);

      this._oList = this.byId("documentList");
      this._oList.attachUpdateFinished(this._onListUpdated, this);

      // The detail page changes a document's status; the list binds the same
      // row and would otherwise show the old pill until the next poll.
      this.getOwnerComponent().getEventBus().subscribe(
        "invoiceiq", "documentChanged", this._onDocumentChanged, this
      );
    },

    onExit: function () {
      this._stopPolling();
      this.getOwnerComponent().getEventBus().unsubscribe(
        "invoiceiq", "documentChanged", this._onDocumentChanged, this
      );
    },

    _onDocumentChanged: function () {
      const oBinding = this._oList.getBinding("items");
      if (oBinding && !oBinding.hasPendingChanges()) oBinding.refresh();
      this._refreshCounts();
    },

    _onMatched: function () {
      this._sSelectedId = null;
      this._oList.removeSelections(true);
    },

    /** Keeps the list highlight in step when a detail route is opened directly. */
    _syncSelection: function (oEvent) {
      const sId = oEvent.getParameter("arguments").documentId;
      this._sSelectedId = sId;
      this._highlight(sId);
    },

    _highlight: function (sId) {
      if (!sId) return;
      const oItem = this._oList.getItems().find(function (oListItem) {
        const oCtx = oListItem.getBindingContext();
        return oCtx && oCtx.getProperty("ID") === sId;
      });
      if (oItem) this._oList.setSelectedItem(oItem);
    },

    // -----------------------------------------------------------------------
    // Filtering and sorting
    // -----------------------------------------------------------------------

    onFilterSelect: function (oEvent) {
      this.getModel("worklist").setProperty("/statusKey", oEvent.getParameter("key"));
      this._applyFilters();
    },

    onSearch: function (oEvent) {
      this.getModel("worklist").setProperty("/searchTerm",
        oEvent.getParameter("newValue") || oEvent.getParameter("query") || "");
      this._applyFilters();
    },

    _applyFilters: function () {
      const oData = this.getModel("worklist").getData();
      const aFilters = [];

      if (oData.statusKey && oData.statusKey !== "ALL") {
        if (oData.statusKey === "PROCESSING") {
          // Anything still working is one bucket to a reviewer.
          aFilters.push(new Filter({
            filters: IN_FLIGHT.map(function (s) {
              return new Filter("status", FilterOperator.EQ, s);
            }),
            and: false
          }));
        } else {
          aFilters.push(new Filter("status", FilterOperator.EQ, oData.statusKey));
        }
      }

      if (oData.searchTerm) {
        aFilters.push(new Filter({
          filters: [
            new Filter("fileName", FilterOperator.Contains, oData.searchTerm),
            new Filter("invoice/vendorName", FilterOperator.Contains, oData.searchTerm),
            new Filter("invoice/invoiceNumber", FilterOperator.Contains, oData.searchTerm)
          ],
          and: false
        }));
      }

      this._oList.getBinding("items").filter(
        aFilters.length ? new Filter({filters: aFilters, and: true}) : []
      );
    },

    onOpenSort: function (oEvent) {
      const oBinding = this._oList.getBinding("items");
      const bAsc = !!this._bSortAsc;
      this._bSortAsc = !bAsc;
      oBinding.sort(new Sorter("uploadedAt", !this._bSortAsc));
      this.toast(this._bSortAsc ? "sortedOldest" : "sortedNewest");
    },

    // -----------------------------------------------------------------------
    // Navigation
    // -----------------------------------------------------------------------

    onSelect: function (oEvent) {
      const oItem = oEvent.getParameter("listItem") || oEvent.getSource();
      const sId = oItem.getBindingContext().getProperty("ID");
      this._sSelectedId = sId;

      // Stay in the third column if the reviewer already opened the PDF.
      const bPreview = this.getUiModel().getProperty("/previewOpen");
      this.getRouter().navTo(bPreview ? "preview" : "detail", {documentId: sId});
    },

    onRefresh: function () {
      this._oList.getBinding("items").refresh();
      this._refreshCounts();
    },

    // -----------------------------------------------------------------------
    // Counts and polling
    // -----------------------------------------------------------------------

    /**
     * One grouped request rather than five counting requests. Failure is quiet:
     * the tabs simply keep their previous numbers.
     */
    _refreshCounts: async function () {
      try {
        const oBinding = this.getModel().bindList("/Documents", null, null, null, {
          $apply: "groupby((status),aggregate($count as cnt))"
        });
        const aCtx = await oBinding.requestContexts(0, 50);

        const oNext = {ALL: 0, PROCESSING: 0, NEEDS_REVIEW: 0, MATCHED: 0, FAILED: 0};
        aCtx.forEach(function (oCtx) {
          const sStatus = oCtx.getProperty("status");
          const iCount = parseInt(oCtx.getProperty("cnt"), 10) || 0;
          oNext.ALL += iCount;
          if (IN_FLIGHT.indexOf(sStatus) > -1) oNext.PROCESSING += iCount;
          else if (oNext[sStatus] !== undefined) oNext[sStatus] += iCount;
        });

        this.getModel("counts").setData(oNext);
      } catch (e) {
        // Counts are decoration; the list is the thing that matters.
      }
    },

    _onListUpdated: function () {
      this._highlight(this._sSelectedId);
      this._refreshCounts();

      const bAnyRunning = this._oList.getItems().some(function (oItem) {
        const oCtx = oItem.getBindingContext();
        return oCtx && IN_FLIGHT.indexOf(oCtx.getProperty("status")) > -1;
      });

      if (bAnyRunning) this._startPolling();
      else this._stopPolling();
    },

    _startPolling: function () {
      if (this._iPoll) return;
      this._iPoll = setInterval(function () {
        const oBinding = this._oList.getBinding("items");
        if (oBinding && !oBinding.hasPendingChanges()) oBinding.refresh();
      }.bind(this), POLL_INTERVAL);
    },

    _stopPolling: function () {
      if (!this._iPoll) return;
      clearInterval(this._iPoll);
      this._iPoll = null;
    },

    // -----------------------------------------------------------------------
    // Upload
    // -----------------------------------------------------------------------

    onOpenUpload: async function () {
      const oUi = this.getUiModel();
      oUi.setProperty("/uploading", false);
      oUi.setProperty("/uploadError", "");
      oUi.setProperty("/selectedFileName", "");
      this._oFile = null;

      if (!this._pDialog) {
        this._pDialog = Fragment.load({
          id: this.getView().getId(),
          name: "invoiceiqui.view.fragments.UploadDialog",
          controller: this
        }).then(function (oDialog) {
          this.getView().addDependent(oDialog);
          return oDialog;
        }.bind(this));
      }

      const oDialog = await this._pDialog;
      const oUploader = this.byId("fileUploader");
      if (oUploader) oUploader.clear();
      oDialog.open();
    },

    onFileSelected: function (oEvent) {
      const aFiles = oEvent.getParameter("files");
      this._oFile = aFiles && aFiles.length ? aFiles[0] : null;
      this.getUiModel().setProperty("/selectedFileName", this._oFile ? this._oFile.name : "");
      this.getUiModel().setProperty("/uploadError", "");
    },

    onTypeMismatch: function () {
      this.getUiModel().setProperty("/uploadError", this.getText("errorFileType"));
    },

    onFileSizeExceed: function () {
      this.getUiModel().setProperty("/uploadError", this.getText("errorFileSize"));
    },

    onUploadConfirm: async function () {
      if (!this._oFile) return;

      const oUi = this.getUiModel();
      oUi.setProperty("/uploading", true);
      oUi.setProperty("/uploadError", "");

      try {
        const sBase64 = await this._readAsBase64(this._oFile);
        const oResult = await this.callAction("uploadDocument", {
          fileName: this._oFile.name,
          mimeType: this._oFile.type || "application/pdf",
          content: sBase64,
          source: "UI"
        });

        (await this._pDialog).close();
        this.toast("uploadStarted", [this._oFile.name]);

        this._oList.getBinding("items").refresh();
        this._startPolling();

        if (oResult && oResult.documentId) {
          this._sSelectedId = oResult.documentId;
          this.getRouter().navTo("detail", {documentId: oResult.documentId});
        }
      } catch (oError) {
        oUi.setProperty("/uploadError", oError.message || this.getText("errorUpload"));
      } finally {
        oUi.setProperty("/uploading", false);
      }
    },

    onUploadCancel: async function () {
      (await this._pDialog).close();
    },

    /** FileReader gives a data URL; the action wants the payload only. */
    _readAsBase64: function (oFile) {
      return new Promise(function (resolve, reject) {
        const oReader = new FileReader();
        oReader.onload = function () {
          const sResult = String(oReader.result);
          const iComma = sResult.indexOf(",");
          resolve(iComma > -1 ? sResult.slice(iComma + 1) : sResult);
        };
        oReader.onerror = function () {
          reject(new Error("Could not read the selected file"));
        };
        oReader.readAsDataURL(oFile);
      });
    }
  });
});