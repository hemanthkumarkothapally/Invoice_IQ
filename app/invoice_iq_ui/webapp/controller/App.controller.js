sap.ui.define([
  "./BaseController"
], function (BaseController) {
  "use strict";

  return BaseController.extend("invoiceiqui.controller.App", {

    onInit: function () {
      this.getView().addStyleClass(this.getOwnerComponent().getContentDensityClass());

      // Each route declares its own layout in the manifest; apply it centrally
      // so no individual controller has to know about column arrangement.
      this.getRouter().attachRouteMatched(function (oEvent) {
        const sLayout = oEvent.getParameter("config").layout;
        if (sLayout) this.setLayout(sLayout);
      }, this);
    },

    /**
     * Fires when the user drags a column separator or uses the arrow buttons.
     * Keeps the model in step with what the control actually did.
     */
    onStateChange: function (oEvent) {
      if (!oEvent.getParameter("isNavigationArrow")) return;
      this.setLayout(oEvent.getParameter("layout"));
    }
  });
});