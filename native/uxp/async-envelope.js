const indesign = require("indesign");
const { app } = indesign;
const uxp = require("uxp");
const fs = require("fs");
@@STATE_FUNCTION@@
const __resultPath = @@resultPath@@;
const __operationId = @@operationId@@;
async function __writeResult(value) {
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch (error) { serialized = JSON.stringify({ ok: false, code: "RESULT_NOT_SERIALIZABLE", message: String(error.message || error), operationId: __operationId, requiresInspection: true }); }
  let byteLength = 0;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    if (code < 128) byteLength += 1;
    else if (code < 2048) byteLength += 2;
    else if (code >= 55296 && code <= 56319 && index + 1 < serialized.length && serialized.charCodeAt(index + 1) >= 56320 && serialized.charCodeAt(index + 1) <= 57343) { byteLength += 4; index += 1; }
    else byteLength += 3;
  }
  if (byteLength > @@maxResultBytes@@) serialized = JSON.stringify({ ok: false, code: "RESULT_TOO_LARGE_AFTER_MUTATION", message: "Le résultat dépasse la limite MCP; relisez le document.", operationId: __operationId, requiresInspection: true });
  await fs.writeFile(__resultPath, serialized, { encoding: "utf8" });
}
try {
@@body@@
} catch (error) {
  await __writeResult({ ok: false, code: error.code || "UXP_ERROR", message: String(error.message || error), operationId: __operationId, requiresInspection: Boolean(error.requiresInspection) });
}
