import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const FREE_CODE_TOOLS = new Set(['execute_uxp', 'execute_uxp_silent', 'execute_indesign_code']);

function filteredErrorCode(event) {
  if (!['error', 'validation_error'].includes(event.outcome)) return undefined;
  if (event.event === 'execute_uxp' || FREE_CODE_TOOLS.has(event.toolName)) return undefined;
  if (typeof event.errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(event.errorCode)) return undefined;
  return event.errorCode;
}

export class AuditLogger {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async write(event) {
    const backupIds = [...new Set([
      event.backupId,
      ...(Array.isArray(event.backupIds) ? event.backupIds : []),
    ].filter((value) => typeof value === 'string' && /^[a-f0-9-]{24,80}$/i.test(value)))].slice(0, 200);
    const safe = {
      timestamp: new Date().toISOString(),
      event: event.event,
      toolName: event.toolName,
      documentId: event.documentId,
      expectedRevision: event.expectedRevision,
      outcome: event.outcome,
      errorCode: filteredErrorCode(event),
      durationMs: event.durationMs,
      backupId: backupIds[0],
      backupIds: backupIds.length > 0 ? backupIds : undefined,
      operationId: typeof event.operationId === 'string' && /^[a-f0-9-]{36}$/i.test(event.operationId) ? event.operationId : undefined,
      requiresInspection: event.requiresInspection === true ? true : undefined,
      reasonHash: event.reason ? createHash('sha256').update(event.reason, 'utf8').digest('hex') : undefined,
      sourceCodeSha256: typeof event.sourceCodeSha256 === 'string' && /^[a-f0-9]{64}$/.test(event.sourceCodeSha256) ? event.sourceCodeSha256 : undefined,
      payloadCodeSha256: typeof event.payloadCodeSha256 === 'string' && /^[a-f0-9]{64}$/.test(event.payloadCodeSha256) ? event.payloadCodeSha256 : undefined,
      rewriteApplied: typeof event.rewriteApplied === 'boolean' ? event.rewriteApplied : undefined,
      payloadHasActiveDocument: typeof event.payloadHasActiveDocument === 'boolean' ? event.payloadHasActiveDocument : undefined,
      payloadHasTargetDocument: typeof event.payloadHasTargetDocument === 'boolean' ? event.payloadHasTargetDocument : undefined,
      requestedDocumentId: Number.isSafeInteger(event.requestedDocumentId) ? event.requestedDocumentId : undefined,
      resolvedTargetDocumentId: Number.isSafeInteger(event.resolvedTargetDocumentId) ? event.resolvedTargetDocumentId : undefined,
      activeDocumentIdBefore: Number.isSafeInteger(event.activeDocumentIdBefore) ? event.activeDocumentIdBefore : undefined,
      activeDocumentIdAfter: Number.isSafeInteger(event.activeDocumentIdAfter) ? event.activeDocumentIdAfter : undefined,
      resolutionMethod: typeof event.resolutionMethod === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(event.resolutionMethod) ? event.resolutionMethod : undefined,
      usedUndoTransaction: typeof event.usedUndoTransaction === 'boolean' ? event.usedUndoTransaction : undefined,
    };
    const line = `${JSON.stringify(safe)}\n`;
    if (!this.filePath) {
      process.stderr.write(`[audit] ${line}`);
      return;
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, line, { encoding: 'utf8', mode: 0o600 });
  }
}
