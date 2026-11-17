sap.ui.define([
  "./BaseController"
], function (BaseController) {
  "use strict";

  return BaseController.extend("invoiceiqui.controller.Preview", {

    onInit: function () {
      this.getRouter().getRoute("preview").attachPatternMatched(this._onMatched, this);
    },

    onExit: function () {
      this._revoke();
    },

    _onMatched: function (oEvent) {
      this._sDocumentId = oEvent.getParameter("arguments").documentId;
      this._revoke();

      const oViewer = this.byId("pdfViewer");
      oViewer.setSource("");

      this.getView().bindElement({
        path: "/Documents(" + this._sDocumentId + ")",
        parameters: {$select: "ID,fileName,mimeType,fileSize,contentBase64"},
        events: {
          dataReceived: this._render.bind(this)
        }
      });
    },

    /**
     * The file is stored base64 rather than as an OData media stream, so build
     * a blob here. Avoids a dedicated content route and works the same locally
     * and behind the app router.
     */
    _render: function () {
      const oCtx = this.getView().getBindingContext();
      if (!oCtx) return;

      const sBase64 = oCtx.getProperty("contentBase64");
      const sType = oCtx.getProperty("mimeType") || "application/pdf";
      if (!sBase64) {
        this.byId("pdfViewer").setErrorPlaceholderMessage(this.getText("noFileStored"));
        return;
      }

      try {
        const sBinary = atob(sBase64);
        const aBytes = new Uint8Array(sBinary.length);
        for (let i = 0; i < sBinary.length; i++) aBytes[i] = sBinary.charCodeAt(i);

        this._sBlobUrl = URL.createObjectURL(new Blob([aBytes], {type: sType}));
        this.byId("pdfViewer").setSource(this._sBlobUrl);
      } catch (e) {
        this.byId("pdfViewer").setErrorPlaceholderMessage(this.getText("errorPdf"));
      }
    },

    _revoke: function () {
      if (!this._sBlobUrl) return;
      URL.revokeObjectURL(this._sBlobUrl);
      this._sBlobUrl = null;
    },

    onDownload: function () {
      if (!this._sBlobUrl) return;
      const oLink = document.createElement("a");
      oLink.href = this._sBlobUrl;
      oLink.download = this.getView().getBindingContext()?.getProperty("fileName") || "invoice.pdf";
      oLink.click();
    },

    onClose: function () {
      this.getUiModel().setProperty("/previewOpen", false);
      this.getRouter().navTo("detail", {documentId: this._sDocumentId});
    }
  });
});