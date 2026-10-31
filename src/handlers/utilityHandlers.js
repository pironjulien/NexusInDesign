/**
 * Utility handlers for InDesign MCP Server
 */
import { ScriptExecutor } from '../core/scriptExecutor.js';
import { formatResponse, formatErrorResponse } from '../utils/stringUtils.js';
import { sessionManager } from '../core/sessionManager.js';

export class UtilityHandlers {
    /**
     * Execute custom InDesign code via UXP
     */
    static async executeInDesignCode(args) {
        const { code, dangerousConfirmation } = args;

        if (dangerousConfirmation !== 'I understand this executes arbitrary InDesign code') {
            return formatErrorResponse(
                'execute_indesign_code requires dangerousConfirmation: "I understand this executes arbitrary InDesign code"',
                "Execute InDesign Code"
            );
        }

        // Pass user code directly through to UXP — it runs async with app in scope
        const result = await ScriptExecutor.executeViaUXP(code);
        // M5: respect { success: false, error } returned by user code instead of wrapping as success
        if (result && typeof result === 'object' && result.success === false) {
            return formatErrorResponse(result.error || 'Script returned failure', "Execute InDesign Code");
        }
        return formatResponse(result, "Execute InDesign Code");
    }

    /**
     * View document information and current state
     */
    static async viewDocument() {
        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            const layoutWindow = doc.layoutWindows && doc.layoutWindows.length > 0
                ? doc.layoutWindows.item(0)
                : null;
            let zoom = null;
            let viewMode = null;
            try {
                zoom = layoutWindow ? layoutWindow.zoomPercentage : null;
                viewMode = layoutWindow ? (layoutWindow.overprintPreview ?? null) : null;
            } catch(e) {}
            let activePageName = null;
            try { activePageName = doc.activePage ? doc.activePage.name : null; } catch(e) {}
            const pageCount = doc.pages.length;
            let firstPage = null;
            if (pageCount > 0) {
                const page = doc.pages.item(0);
                let pageWidth = null;
                let pageHeight = null;
                try {
                    const b = page.bounds;
                    pageWidth = b[3] - b[1];
                    pageHeight = b[2] - b[0];
                } catch(e) {}
                firstPage = {
                    name: page.name,
                    width: pageWidth,
                    height: pageHeight,
                    textFrames: page.textFrames.length,
                    rectangles: page.rectangles.length,
                    ovals: page.ovals.length,
                    polygons: page.polygons.length
                };
            }
            return {
                success: true,
                documentName: doc.name,
                pages: pageCount,
                activePage: activePageName,
                zoom,
                viewMode,
                firstPage
            };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "View Document")
            : formatErrorResponse(result?.error || 'Failed to view document', "View Document");
    }

    /**
     * Get session information
     */
    static async getSessionInfo() {
        const sessionInfo = sessionManager.getSessionSummary();
        return formatResponse(JSON.stringify(sessionInfo, null, 2), "Get Session Info");
    }

    /**
     * Clear session data
     */
    static async clearSession() {
        sessionManager.clearSession();
        return formatResponse("Session data cleared successfully", "Clear Session");
    }
}
