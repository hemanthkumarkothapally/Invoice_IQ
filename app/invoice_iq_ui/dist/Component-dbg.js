sap.ui.define([
  "sap/ui/core/UIComponent",
  "sap/ui/Device",
  "sap/ui/model/json/JSONModel",
  "sap/f/library"
], function (UIComponent, Device, JSONModel, fioriLibrary) {
  "use strict";

  return UIComponent.extend("invoiceiqui.Component", {

    metadata: {
      manifest: "json",
      interfaces: ["sap.ui.core.IAsyncContentCreation"]
    },

    init: function () {
      UIComponent.prototype.init.apply(this, arguments);

      this.setModel(new JSONModel({
        isPhone: Device.system.phone,
        isTouch: Device.support.touch
      }), "device");

      // Every flag the views bind to starts with a real value. A binding that
      // resolves to undefined leaves the control's own default, which is how
      // the footer ended up claiming unsaved changes on a clean document.
      this.setModel(new JSONModel({
        layout: fioriLibrary.LayoutType.OneColumn,
        previewOpen: false,
        busy: false,

        hasChanges: false,
        fullScreen: false,
        fullScreenIcon: "sap-icon://full-screen",
        fullScreenText: "Full screen",

        lineCount: 0,
        lineSum: "",
        lineSumState: "None",

        uploading: false,
        uploadError: "",
        selectedFileName: "",

        // Set this to your S/4HANA launchpad host to enable the
        // "View in S/4HANA" buttons; empty simply disables them.
        s4BaseUrl: ""
      }), "ui");

      this.getRouter().initialize();
    },

    /** Content density matching the user's device, applied by App.view. */
    getContentDensityClass: function () {
      if (this._sContentDensityClass === undefined) {
        this._sContentDensityClass = Device.support.touch ? "sapUiSizeCozy" : "sapUiSizeCompact";
      }
      return this._sContentDensityClass;
    }
  });
});