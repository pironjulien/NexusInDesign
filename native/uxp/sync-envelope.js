const indesign = require("indesign");
const { app } = indesign;
const { script } = require("uxp");
@@STATE_FUNCTION@@
try {
@@body@@
} catch (error) {
  script.setResult(JSON.stringify({ ok: false, code: error.code || "UXP_ERROR", message: String(error.message || error), requiresInspection: Boolean(error.requiresInspection) }));
}
