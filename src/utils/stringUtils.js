/**
 * Utility functions for consistent handler responses.
 */
import { ScriptExecutor } from '../core/scriptExecutor.js';

/**
 * Formats a response with a consistent structure.
 * @param {any} result - The result to format.
 * @param {string} [operation="Operation"] - The operation name.
 * @returns {object} Formatted response object.
 */
export function formatResponse(result, operation = "Operation") {
    const response = {
        success: true,
        operation,
        result,
        timestamp: new Date().toISOString()
    };
    if (result && typeof result === 'object' && !Array.isArray(result)) {
        for (const field of ['safetyBackups', 'documentStates', 'backupId', 'backupPath', 'documentId', 'revision', 'stateToken']) {
            if (result[field] !== undefined) response[field] = result[field];
        }
    }
    const securityMetadata = ScriptExecutor.currentSecurityMetadata();
    if (securityMetadata) {
        for (const field of ['safetyBackups', 'documentStates', 'backupId']) {
            if (securityMetadata[field] !== undefined) response[field] = securityMetadata[field];
        }
    }
    return response;
}

/**
 * Formats an error response with a consistent structure.
 * @param {any} error - The error to format.
 * @param {string} [operation="Operation"] - The operation name.
 * @returns {object} Formatted error response object.
 */
export function formatErrorResponse(error, operation = "Operation") {
    return {
        success: false,
        operation,
        result: error,
        timestamp: new Date().toISOString()
    };
}
