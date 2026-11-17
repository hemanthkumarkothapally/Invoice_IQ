sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/UIComponent",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (Controller, UIComponent, MessageToast, MessageBox) {
  "use strict";

  return Controller.extend("invoiceiqui.controller.BaseController", {

    getRouter: function () {
      return UIComponent.getRouterFor(this);
    },

        getModel: function (sName) {
      return this.getView().getModel(sName);
    },

    setModel: function (oModel, sName) {
      this.getView().setModel(oModel, sName);
      return this;
    },

    getUiModel: function () {
      return this.getOwnerComponent().getModel("ui");
    },

    getText: function (sKey, aArgs) {
      return this.getOwnerComponent().getModel("i18n").getResourceBundle().getText(sKey, aArgs);
    },

    setLayout: function (sLayout) {
      this.getUiModel().setProperty("/layout", sLayout);
    },

    /**
     * Invokes an unbound OData V4 action. UI5 renamed execute() to invoke()
     * in 1.132, so call whichever the runtime provides.
     */
    callAction: async function (sName, oParams) {
      const oOperation = this.getModel().bindContext("/" + sName + "(...)");
      Object.keys(oParams || {}).forEach(function (sKey) {
        oOperation.setParameter(sKey, oParams[sKey]);
      });
      if (typeof oOperation.invoke === "function") {
        await oOperation.invoke();
      } else {
        await oOperation.execute();
      }
      const oCtx = oOperation.getBoundContext();
      return oCtx ? oCtx.getObject() : null;
    },

    /** Pulls the readable message out of a V4 error response. */
    showError: function (oError, sFallbackKey) {
      let sMessage = this.getText(sFallbackKey || "errorGeneric");
      try {
        const oBody = JSON.parse(oError.responseText || oError.message);
        sMessage = oBody.error?.message?.value || oBody.error?.message || sMessage;
      } catch (e) {
        if (oError && oError.message) sMessage = oError.message;
      }
      MessageBox.error(sMessage);
    },

    toast: function (sKey, aArgs) {
      MessageToast.show(this.getText(sKey, aArgs));
    }
  });
});