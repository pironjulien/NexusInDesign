/**
 * Comprehensive Document management handlers
 * Merged from documentHandlers.js and documentAdvancedHandlers.js
 */
import { existsSync } from 'fs';
import { pathToFileURL } from 'node:url';
import { ScriptExecutor } from '../core/scriptExecutor.js';
import { formatResponse, formatErrorResponse } from '../utils/stringUtils.js';
import { sessionManager } from '../core/sessionManager.js';

export class DocumentHandlers {
    /**
     * Get information about the active document
     */
    static async getDocumentInfo() {
        const result = await ScriptExecutor.executeViaUXP(`
            if (app.documents.length === 0) {
                return { error: 'No document open' };
            }
            const doc = targetDocument;
            let filePath = 'Unsaved';
            try {
                const fp = await doc.filePath;
                filePath = fp ? (fp.nativePath || fp.url || String(fp) || 'Unsaved') : 'Unsaved';
            } catch (e) {}
            // L3: switch to mm before reading dimensions so sessionManager always gets mm values
            const { MeasurementUnits } = require('indesign');
            const savedH = doc.viewPreferences.horizontalMeasurementUnits;
            const savedV = doc.viewPreferences.verticalMeasurementUnits;
            doc.viewPreferences.horizontalMeasurementUnits = MeasurementUnits.millimeters;
            doc.viewPreferences.verticalMeasurementUnits   = MeasurementUnits.millimeters;
            const info = {
                name: doc.name,
                filePath,
                pages: doc.pages.length,
                spreads: doc.spreads.length,
                layers: doc.layers.length,
                masterSpreads: doc.masterSpreads.length,
                width: doc.documentPreferences.pageWidth,
                height: doc.documentPreferences.pageHeight,
                facingPages: doc.documentPreferences.facingPages,
                bleedTop: doc.documentPreferences.documentBleedTopOffset,
                bleedBottom: doc.documentPreferences.documentBleedBottomOffset,
                bleedInside: doc.documentPreferences.documentBleedInsideOrLeftOffset,
                bleedOutside: doc.documentPreferences.documentBleedOutsideOrRightOffset,
                marginTop: doc.marginPreferences.top,
                marginBottom: doc.marginPreferences.bottom,
                marginLeft: doc.marginPreferences.left,
                marginRight: doc.marginPreferences.right
            };
            doc.viewPreferences.horizontalMeasurementUnits = savedH;
            doc.viewPreferences.verticalMeasurementUnits   = savedV;
            return info;
        `);

        if (result?.error) {
            return formatErrorResponse(result.error, "Get Document Info");
        }

        if (result) {
            sessionManager.setActiveDocument({
                name: result.name,
                path: result.filePath,
                pages: result.pages,
                width: result.width,
                height: result.height
            });
            sessionManager.setPageDimensions({
                width: result.width,
                height: result.height
            });
        }

        return formatResponse(result, "Get Document Info");
    }

    /**
     * Create a new document
     */
    static async createDocument(args) {
        const {
            width = 210,
            height = 297,
            pages = 1,
            facingPages = false,
            pageOrientation = 'PORTRAIT',
            bleedTop = 3,
            bleedBottom = 3,
            bleedInside = 3,
            bleedOutside = 3,
            marginTop = 20,
            marginBottom = 20,
            marginLeft = 20,
            marginRight = 20
        } = args;

        // Convert mm to points (1mm = 2.8346pt) for InDesign UXP API
        const MM_TO_PT = 2.8346;
        const wPt  = Math.round(width  * MM_TO_PT * 100) / 100;
        const hPt  = Math.round(height * MM_TO_PT * 100) / 100;
        const mTPt = Math.round(marginTop    * MM_TO_PT * 100) / 100;
        const mBPt = Math.round(marginBottom * MM_TO_PT * 100) / 100;
        const mLPt = Math.round(marginLeft   * MM_TO_PT * 100) / 100;
        const mRPt = Math.round(marginRight  * MM_TO_PT * 100) / 100;
        const bTPt = Math.round(bleedTop     * MM_TO_PT * 100) / 100;
        const bBPt = Math.round(bleedBottom  * MM_TO_PT * 100) / 100;
        const bIPt = Math.round(bleedInside  * MM_TO_PT * 100) / 100;
        const bOPt = Math.round(bleedOutside * MM_TO_PT * 100) / 100;

        const code = `
            const doc = app.documents.add();
            // Save current units, switch to points so numeric values are unambiguous
            const savedH = doc.viewPreferences.horizontalMeasurementUnits;
            const savedV = doc.viewPreferences.verticalMeasurementUnits;
            const { MeasurementUnits } = require('indesign');
            doc.viewPreferences.horizontalMeasurementUnits = MeasurementUnits.points;
            doc.viewPreferences.verticalMeasurementUnits   = MeasurementUnits.points;
            doc.documentPreferences.pageWidth  = ${wPt};
            doc.documentPreferences.pageHeight = ${hPt};
            doc.documentPreferences.facingPages = ${facingPages};
            doc.documentPreferences.documentBleedTopOffset           = ${bTPt};
            doc.documentPreferences.documentBleedBottomOffset        = ${bBPt};
            doc.documentPreferences.documentBleedInsideOrLeftOffset  = ${bIPt};
            doc.documentPreferences.documentBleedOutsideOrRightOffset = ${bOPt};
            const page = doc.pages.item(0);
            page.marginPreferences.top    = ${mTPt};
            page.marginPreferences.bottom = ${mBPt};
            page.marginPreferences.left   = ${mLPt};
            page.marginPreferences.right  = ${mRPt};
            // Restore original units
            doc.viewPreferences.horizontalMeasurementUnits = savedH;
            doc.viewPreferences.verticalMeasurementUnits   = savedV;
            app.activeDocument = doc;
            return { success: true, name: doc.name, widthPt: ${wPt}, heightPt: ${hPt} };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);

        if (result?.success) {
            sessionManager.setActiveDocument({
                name: result.name || 'New Document',
                path: 'Unsaved',
                pages: pages,
                width: width,
                height: height
            });
            sessionManager.setPageDimensions({ width, height });
            return formatResponse(result, "Create Document");
        }
        return formatErrorResponse(result?.error || 'Failed to create document', "Create Document");
    }

    /**
     * Open an existing document
     */
    static async openDocument(args) {
        const { filePath } = args;

        if (!existsSync(filePath)) {
            return formatErrorResponse(`File not found: ${filePath}`, "Open Document");
        }

        const code = `
            await app.open(${JSON.stringify(filePath)});
            return { success: true, message: 'Document opened: ' + ${JSON.stringify(filePath)} };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Open Document")
            : formatErrorResponse(result?.error || 'Failed to open document', "Open Document");
    }

    /**
     * Save the active document
     */
    static async saveDocument(args) {
        const { filePath } = args;

        // M6: calling doc.save() with no path on a never-saved document opens a system
        // dialog that blocks the UXP event loop until dismissed. Require filePath if unsaved.
        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = targetDocument;
            ${filePath
                ? `await doc.save(${JSON.stringify(filePath)});`
                : `
            let savedPath = null;
            try { const fp = await doc.filePath; savedPath = fp ? String(fp) : null; } catch(e) {}
            if (!savedPath || savedPath === 'null') {
                return { success: false, error: 'Document has never been saved. Provide a filePath to save to a new location.' };
            }
            await doc.save();`
            }
            return { success: true, message: 'Document saved' };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Save Document")
            : formatErrorResponse(result?.error || 'Failed to save document', "Save Document");
    }

    /**
     * Close the active document
     */
    static async closeDocument(args = {}) {
        const { saveOptions = 'ASK' } = args;

        // H6: previous implementation always used SaveOptions.no, silently discarding
        // unsaved changes. Now requires explicit intent via saveOptions parameter.
        // 'ASK' (default) opens InDesign's native save dialog.
        // 'SAVE' saves before closing. 'DISCARD' explicitly discards changes.
        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document to close' };
            }
            const { SaveOptions } = require('indesign');
            let doc = targetDocument;
            if (!doc && app.documents.length > 0) {
                doc = app.documents.item(0);
            }
            if (!doc) {
                return { success: false, error: 'No document to close' };
            }
            const docName = doc.name;
            const optMap = { ASK: SaveOptions.ask, SAVE: SaveOptions.yes, DISCARD: SaveOptions.no };
            const opt = optMap[${JSON.stringify(saveOptions)}] || SaveOptions.ask;
            await doc.close(opt);
            return { success: true, message: 'Document closed: ' + docName };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Close Document")
            : formatErrorResponse(result?.error || 'Failed to close document', "Close Document");
    }

    // =================== DOCUMENT ADVANCED TOOLS ===================

    /**
     * Run preflight on the document
     */
    static async preflightDocument(args) {
        const { profile = 'Basic', includeWarnings = true } = args;

        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = targetDocument;
            await doc.preflight(${JSON.stringify(profile)}, ${includeWarnings});
            return { success: true, message: 'Document preflighted successfully' };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Preflight Document")
            : formatErrorResponse(result?.error || 'Failed to preflight document', "Preflight Document");
    }

    /**
     * Zoom to fit page in view
     */
    static async zoomToPage(args) {
        const { pageIndex, zoomLevel = 100 } = args;

        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = targetDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) {
                return { success: false, error: 'Page index out of range' };
            }
            const page = doc.pages.item(${pageIndex});
            const layoutWindow = doc.layoutWindows && doc.layoutWindows.length > 0
                ? doc.layoutWindows.item(0)
                : null;
            if (!layoutWindow || layoutWindow.isValid === false) {
                return { success: false, error: 'No layout window available' };
            }
            layoutWindow.activePage = page;
            layoutWindow.zoomPercentage = ${zoomLevel};
            return { success: true, message: 'Zoomed to page ${pageIndex} at ${zoomLevel}%' };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Zoom to Page")
            : formatErrorResponse(result?.error || 'Failed to zoom to page', "Zoom to Page");
    }

    /**
     * Perform data merge operation
     */
    static async dataMerge(args) {
        const { dataSource, removeBlankLines = false, linkImages = true } = args;
        const dataSourceUrl = pathToFileURL(dataSource).href;

        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = targetDocument;
            const dataMerge = doc.dataMergeProperties;
            const options = doc.dataMergeOptions;
            if (!dataMerge || dataMerge.isValid === false || !options || options.isValid === false) {
                return { success: false, error: 'Data merge is unavailable for this document' };
            }

            const nativePlaceholderCount =
                (doc.dataMergeTextPlaceholders ? doc.dataMergeTextPlaceholders.length : 0)
                + (doc.dataMergeImagePlaceholders ? doc.dataMergeImagePlaceholders.length : 0)
                + (doc.dataMergeQrcodePlaceholders ? doc.dataMergeQrcodePlaceholders.length : 0);
            if (nativePlaceholderCount === 0) {
                return { success: false, error: 'No native InDesign data merge placeholder exists in the document' };
            }

            const fileSystem = require('uxp').storage.localFileSystem;
            let sourceFile;
            try {
                sourceFile = await fileSystem.getEntryWithUrl(${JSON.stringify(dataSourceUrl)});
            } catch (e) {
                return { success: false, error: 'The authorized data source cannot be opened by UXP' };
            }
            if (!sourceFile || sourceFile.isFile !== true) {
                return { success: false, error: 'The authorized data source is not a file' };
            }

            try {
                await dataMerge.selectDataSource(sourceFile);
            } catch (e) {
                return { success: false, error: 'InDesign rejected the authorized data source' };
            }
            const fieldCount = dataMerge.dataMergeFields ? dataMerge.dataMergeFields.length : 0;
            if (fieldCount === 0) {
                return { success: false, error: 'The selected data source contains no usable field' };
            }

            options.createNewDocument = true;
            options.removeBlankLines = ${JSON.stringify(removeBlankLines)};
            options.linkImages = ${JSON.stringify(linkImages)};
            if (options.createNewDocument !== true
                || options.removeBlankLines !== ${JSON.stringify(removeBlankLines)}
                || options.linkImages !== ${JSON.stringify(linkImages)}) {
                return { success: false, error: 'Data merge options postcondition failed' };
            }

            const openDocumentIds = new Set();
            for (let index = 0; index < app.documents.length; index++) {
                const current = app.documents.item(index);
                if (current && current.isValid !== false) openDocumentIds.add(Number(current.id));
            }
            try {
                await dataMerge.mergeRecords();
            } catch (e) {
                return { success: false, error: 'InDesign data merge failed' };
            }

            const mergedDocuments = [];
            for (let index = 0; index < app.documents.length; index++) {
                const current = app.documents.item(index);
                const currentId = current && current.isValid !== false ? Number(current.id) : NaN;
                if (!Number.isSafeInteger(currentId) || openDocumentIds.has(currentId)) continue;
                const pageCount = current.pages ? current.pages.length : 0;
                if (pageCount > 0) mergedDocuments.push({ documentId: currentId, pageCount });
            }
            if (mergedDocuments.length === 0) {
                return { success: false, error: 'Data merge created no verifiable document' };
            }

            return {
                success: true,
                dataSourceSelected: true,
                fieldCount,
                placeholderCount: nativePlaceholderCount,
                removeBlankLines: options.removeBlankLines,
                linkImages: options.linkImages,
                mergedDocuments
            };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Data Merge")
            : formatErrorResponse(result?.error || 'Failed to perform data merge', "Data Merge");
    }

    // =================== DOCUMENT ELEMENTS & STYLES ===================

    /**
     * Get all elements in the document
     */
    static async getDocumentElements(args) {
        const { elementType = 'all' } = args;

        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = targetDocument;
            const et = ${JSON.stringify(elementType)};
            if (!['all', 'text', 'graphics', 'tables'].includes(et)) {
                return { success: false, error: 'Unknown element type: ' + et };
            }
            const counts = {};
            if (et === 'all' || et === 'text') {
                counts.textFrames = doc.textFrames.length;
                counts.stories = doc.stories.length;
            }
            if (et === 'all' || et === 'graphics') {
                counts.rectangles = doc.rectangles.length;
                counts.ovals = doc.ovals.length;
                counts.polygons = doc.polygons.length;
                counts.graphicLines = doc.graphicLines.length;
                counts.allGraphics = doc.allGraphics.length;
            }
            if (et === 'all' || et === 'tables') {
                let tableCount = 0;
                for (let i = 0; i < doc.textFrames.length; i++) {
                    tableCount += doc.textFrames.item(i).tables.length;
                }
                counts.tables = tableCount;
            }
            if (et === 'all') {
                counts.allPageItems = doc.allPageItems.length;
                counts.groups = doc.groups.length;
                counts.layers = doc.layers.length;
            }
            return { success: true, elementType: et, counts };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Get Document Elements")
            : formatErrorResponse(result?.error || 'Failed to get document elements', "Get Document Elements");
    }

    /**
     * Get all styles in the document
     */
    static async getDocumentStyles(args) {
        const { styleType = 'PARAGRAPH' } = args;

        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = targetDocument;
            const st = ${JSON.stringify(styleType)};
            let collection;
            switch (st) {
                case 'PARAGRAPH': collection = doc.paragraphStyles; break;
                case 'CHARACTER': collection = doc.characterStyles; break;
                case 'OBJECT':    collection = doc.objectStyles; break;
                case 'TABLE':     collection = doc.tableStyles; break;
                case 'CELL':      collection = doc.cellStyles; break;
                default: return { success: false, error: 'Unknown style type: ' + st };
            }
            const styles = [];
            for (let i = 0; i < collection.length; i++) {
                styles.push(collection.item(i).name);
            }
            return { success: true, styleType: st, count: styles.length, styles };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Get Document Styles")
            : formatErrorResponse(result?.error || 'Failed to get document styles', "Get Document Styles");
    }

    /**
     * Get all colors and swatches in the document
     */
    static async getDocumentColors(args) {
        const { includeSwatches = true, includeGradients = true, includeTints = true } = args;

        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = targetDocument;
            const colors = [];
            for (let i = 0; i < doc.colors.length; i++) {
                const c = doc.colors.item(i);
                colors.push({ name: c.name, model: String(c.model) });
            }
            const swatches = ${includeSwatches} ? (() => {
                const s = [];
                for (let i = 0; i < doc.swatches.length; i++) s.push(doc.swatches.item(i).name);
                return s;
            })() : null;
            const gradients = ${includeGradients} ? (() => {
                const g = [];
                for (let i = 0; i < doc.gradients.length; i++) g.push(doc.gradients.item(i).name);
                return g;
            })() : null;
            const tints = ${includeTints} ? (() => {
                const t = [];
                for (let i = 0; i < doc.tints.length; i++) t.push(doc.tints.item(i).name);
                return t;
            })() : null;
            return { success: true, colors, swatches, gradients, tints };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Get Document Colors")
            : formatErrorResponse(result?.error || 'Failed to get document colors', "Get Document Colors");
    }

    // =================== DOCUMENT PREFERENCES ===================

    /**
     * Get document preferences
     */
    static async getDocumentPreferences(args) {
        const { preferenceType = 'GENERAL' } = args;

        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = targetDocument;
            const pt = ${JSON.stringify(preferenceType)};
            const prefs = {};
            const safeGet = (fn) => { try { return fn(); } catch (e) { return null; } };
            switch (pt) {
                case 'GENERAL':
                    prefs.pageWidth = safeGet(() => doc.documentPreferences.pageWidth);
                    prefs.pageHeight = safeGet(() => doc.documentPreferences.pageHeight);
                    prefs.facingPages = safeGet(() => doc.documentPreferences.facingPages);
                    prefs.pageOrientation = safeGet(() => String(doc.documentPreferences.pageOrientation));
                    prefs.pagesPerDocument = safeGet(() => doc.documentPreferences.pagesPerDocument);
                    prefs.startPageNumber = safeGet(() => doc.documentPreferences.startPageNumber);
                    prefs.documentBleedTopOffset = safeGet(() => doc.documentPreferences.documentBleedTopOffset);
                    prefs.documentBleedBottomOffset = safeGet(() => doc.documentPreferences.documentBleedBottomOffset);
                    prefs.documentBleedInsideOrLeftOffset = safeGet(() => doc.documentPreferences.documentBleedInsideOrLeftOffset);
                    prefs.documentBleedOutsideOrRightOffset = safeGet(() => doc.documentPreferences.documentBleedOutsideOrRightOffset);
                    prefs.documentSlugTopOffset = safeGet(() => doc.documentPreferences.documentSlugTopOffset);
                    prefs.documentSlugBottomOffset = safeGet(() => doc.documentPreferences.documentSlugBottomOffset);
                    prefs.documentSlugInsideOrLeftOffset = safeGet(() => doc.documentPreferences.documentSlugInsideOrLeftOffset);
                    prefs.documentSlugOutsideOrRightOffset = safeGet(() => doc.documentPreferences.documentSlugOutsideOrRightOffset);
                    break;
                case 'GRID':
                    prefs.documentGridColor = safeGet(() => String(doc.gridPreferences.documentGridColor));
                    prefs.documentGridIncrement = safeGet(() => doc.gridPreferences.documentGridIncrement);
                    prefs.documentGridSubdivision = safeGet(() => doc.gridPreferences.documentGridSubdivision);
                    prefs.gridViewThreshold = safeGet(() => doc.gridPreferences.gridViewThreshold);
                    prefs.baselineGridColor = safeGet(() => String(doc.gridPreferences.baselineGridColor));
                    prefs.baselineGridIncrement = safeGet(() => doc.gridPreferences.baselineGridIncrement);
                    prefs.baselineGridOffset = safeGet(() => doc.gridPreferences.baselineGridOffset);
                    prefs.baselineGridViewThreshold = safeGet(() => doc.gridPreferences.baselineGridViewThreshold);
                    prefs.gridAlignment = safeGet(() => String(doc.gridPreferences.gridAlignment));
                    break;
                case 'GUIDES':
                    prefs.guidesLocked = safeGet(() => doc.guidePreferences.guidesLocked);
                    prefs.guidesInBack = safeGet(() => doc.guidePreferences.guidesInBack);
                    prefs.guidesSnapToZone = safeGet(() => doc.guidePreferences.guidesSnapToZone);
                    prefs.guidesViewThreshold = safeGet(() => doc.guidePreferences.guidesViewThreshold);
                    break;
                case 'TEXT':
                    prefs.typographersQuotes = safeGet(() => doc.textPreferences.typographersQuotes);
                    prefs.useTypographersQuotes = safeGet(() => doc.textPreferences.useTypographersQuotes);
                    prefs.highlightSubstitutedFonts = safeGet(() => doc.textPreferences.highlightSubstitutedFonts);
                    prefs.highlightSubstitutedGlyphs = safeGet(() => doc.textPreferences.highlightSubstitutedGlyphs);
                    prefs.highlightKeepsViolations = safeGet(() => doc.textPreferences.highlightKeepsViolations);
                    prefs.highlightHjViolations = safeGet(() => doc.textPreferences.highlightHjViolations);
                    prefs.highlightCustomSpacing = safeGet(() => doc.textPreferences.highlightCustomSpacing);
                    prefs.highlightSubstitutedLines = safeGet(() => doc.textPreferences.highlightSubstitutedLines);
                    break;
                case 'MARGINS':
                    prefs.marginTop = safeGet(() => doc.marginPreferences.top);
                    prefs.marginBottom = safeGet(() => doc.marginPreferences.bottom);
                    prefs.marginLeft = safeGet(() => doc.marginPreferences.left);
                    prefs.marginRight = safeGet(() => doc.marginPreferences.right);
                    prefs.columnCount = safeGet(() => doc.marginPreferences.columnCount);
                    prefs.columnGutter = safeGet(() => doc.marginPreferences.columnGutter);
                    break;
                default:
                    return { success: false, error: 'Unknown preference type: ' + pt + '. Available: GENERAL, GRID, GUIDES, TEXT, MARGINS' };
            }
            return { success: true, preferenceType: pt, preferences: prefs };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Get Document Preferences")
            : formatErrorResponse(result?.error || 'Failed to get document preferences', "Get Document Preferences");
    }

    /**
     * Set document preferences
     */
    static async setDocumentPreferences(args) {
        const { preferenceType, preferences } = args;

        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = targetDocument;
            const pt = ${JSON.stringify(preferenceType)};
            const prefs = ${JSON.stringify(preferences)};
            let updatedCount = 0;
            const safeSet = (fn) => { try { fn(); updatedCount++; } catch (e) {} };
            switch (pt) {
                case 'GENERAL':
                    if (prefs.pageWidth !== undefined) safeSet(() => { doc.documentPreferences.pageWidth = prefs.pageWidth; });
                    if (prefs.pageHeight !== undefined) safeSet(() => { doc.documentPreferences.pageHeight = prefs.pageHeight; });
                    if (prefs.facingPages !== undefined) safeSet(() => { doc.documentPreferences.facingPages = prefs.facingPages; });
                    if (prefs.pagesPerDocument !== undefined) safeSet(() => { doc.documentPreferences.pagesPerDocument = prefs.pagesPerDocument; });
                    if (prefs.startPageNumber !== undefined) safeSet(() => { doc.documentPreferences.startPageNumber = prefs.startPageNumber; });
                    if (prefs.documentBleedTopOffset !== undefined) safeSet(() => { doc.documentPreferences.documentBleedTopOffset = prefs.documentBleedTopOffset; });
                    if (prefs.documentBleedBottomOffset !== undefined) safeSet(() => { doc.documentPreferences.documentBleedBottomOffset = prefs.documentBleedBottomOffset; });
                    if (prefs.documentBleedInsideOrLeftOffset !== undefined) safeSet(() => { doc.documentPreferences.documentBleedInsideOrLeftOffset = prefs.documentBleedInsideOrLeftOffset; });
                    if (prefs.documentBleedOutsideOrRightOffset !== undefined) safeSet(() => { doc.documentPreferences.documentBleedOutsideOrRightOffset = prefs.documentBleedOutsideOrRightOffset; });
                    break;
                case 'GRID':
                    if (prefs.documentGridColor !== undefined) safeSet(() => { doc.gridPreferences.documentGridColor = prefs.documentGridColor; });
                    if (prefs.documentGridIncrement !== undefined) safeSet(() => { doc.gridPreferences.documentGridIncrement = prefs.documentGridIncrement; });
                    if (prefs.documentGridSubdivision !== undefined) safeSet(() => { doc.gridPreferences.documentGridSubdivision = prefs.documentGridSubdivision; });
                    if (prefs.gridViewThreshold !== undefined) safeSet(() => { doc.gridPreferences.gridViewThreshold = prefs.gridViewThreshold; });
                    if (prefs.baselineGridColor !== undefined) safeSet(() => { doc.gridPreferences.baselineGridColor = prefs.baselineGridColor; });
                    if (prefs.baselineGridIncrement !== undefined) safeSet(() => { doc.gridPreferences.baselineGridIncrement = prefs.baselineGridIncrement; });
                    if (prefs.baselineGridOffset !== undefined) safeSet(() => { doc.gridPreferences.baselineGridOffset = prefs.baselineGridOffset; });
                    if (prefs.baselineGridViewThreshold !== undefined) safeSet(() => { doc.gridPreferences.baselineGridViewThreshold = prefs.baselineGridViewThreshold; });
                    if (prefs.gridAlignment !== undefined) safeSet(() => { doc.gridPreferences.gridAlignment = prefs.gridAlignment; });
                    break;
                case 'GUIDES':
                    if (prefs.guidesLocked !== undefined) safeSet(() => { doc.guidePreferences.guidesLocked = prefs.guidesLocked; });
                    if (prefs.guidesInBack !== undefined) safeSet(() => { doc.guidePreferences.guidesInBack = prefs.guidesInBack; });
                    if (prefs.guidesSnapToZone !== undefined) safeSet(() => { doc.guidePreferences.guidesSnapToZone = prefs.guidesSnapToZone; });
                    if (prefs.guidesViewThreshold !== undefined) safeSet(() => { doc.guidePreferences.guidesViewThreshold = prefs.guidesViewThreshold; });
                    break;
                case 'TEXT':
                    if (prefs.typographersQuotes !== undefined) safeSet(() => { doc.textPreferences.typographersQuotes = prefs.typographersQuotes; });
                    if (prefs.useTypographersQuotes !== undefined) safeSet(() => { doc.textPreferences.useTypographersQuotes = prefs.useTypographersQuotes; });
                    if (prefs.highlightSubstitutedFonts !== undefined) safeSet(() => { doc.textPreferences.highlightSubstitutedFonts = prefs.highlightSubstitutedFonts; });
                    if (prefs.highlightSubstitutedGlyphs !== undefined) safeSet(() => { doc.textPreferences.highlightSubstitutedGlyphs = prefs.highlightSubstitutedGlyphs; });
                    if (prefs.highlightKeepsViolations !== undefined) safeSet(() => { doc.textPreferences.highlightKeepsViolations = prefs.highlightKeepsViolations; });
                    if (prefs.highlightHjViolations !== undefined) safeSet(() => { doc.textPreferences.highlightHjViolations = prefs.highlightHjViolations; });
                    if (prefs.highlightCustomSpacing !== undefined) safeSet(() => { doc.textPreferences.highlightCustomSpacing = prefs.highlightCustomSpacing; });
                    if (prefs.highlightSubstitutedLines !== undefined) safeSet(() => { doc.textPreferences.highlightSubstitutedLines = prefs.highlightSubstitutedLines; });
                    break;
                case 'MARGINS':
                    if (prefs.marginTop !== undefined) safeSet(() => { doc.marginPreferences.top = prefs.marginTop; });
                    if (prefs.marginBottom !== undefined) safeSet(() => { doc.marginPreferences.bottom = prefs.marginBottom; });
                    if (prefs.marginLeft !== undefined) safeSet(() => { doc.marginPreferences.left = prefs.marginLeft; });
                    if (prefs.marginRight !== undefined) safeSet(() => { doc.marginPreferences.right = prefs.marginRight; });
                    if (prefs.columnCount !== undefined) safeSet(() => { doc.marginPreferences.columnCount = prefs.columnCount; });
                    if (prefs.columnGutter !== undefined) safeSet(() => { doc.marginPreferences.columnGutter = prefs.columnGutter; });
                    break;
                default:
                    return { success: false, error: 'Unknown preference type: ' + pt + '. Available: GENERAL, GRID, GUIDES, TEXT, MARGINS' };
            }
            return { success: true, message: 'Document preferences updated successfully. ' + updatedCount + ' properties updated.', updatedCount };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Set Document Preferences")
            : formatErrorResponse(result?.error || 'Failed to set document preferences', "Set Document Preferences");
    }

    // =================== DOCUMENT STORIES & TEXT ===================

    /**
     * Get all stories in the document
     */
    static async getDocumentStories(args) {
        const { includeOverset = true } = args;

        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = targetDocument;
            const stories = [];
            for (let i = 0; i < doc.stories.length; i++) {
                const story = doc.stories.item(i);
                const overflows = Boolean(story.overflows);
                if (${includeOverset} || !overflows) {
                    stories.push({
                        name: story.name,
                        contents: (story.contents || '').substring(0, 50),
                        overset: overflows,
                        overflows
                    });
                }
            }
            return {
                success: true,
                count: stories.length,
                stories,
                hiddenStoryFilterSupported: false,
                note: 'Adobe Story exposes no hidden flag; no hidden-story filter was applied.'
            };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Get Document Stories")
            : formatErrorResponse(result?.error || 'Failed to get document stories', "Get Document Stories");
    }

    /**
     * Find text across the entire document
     */
    static async findTextInDocument(args) {
        const { searchText, replaceText, caseSensitive = false, wholeWord = false, useRegex = false } = args;
        const hasReplacement = replaceText !== undefined;
        let grepPattern = searchText;
        if (useRegex) {
            if (wholeWord) grepPattern = `\\b(?:${grepPattern})\\b`;
            if (!caseSensitive) grepPattern = `(?i)${grepPattern}`;
        }

        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = targetDocument;
            const { NothingEnum } = require('indesign');
            const useGrep = ${useRegex};
            const findPreferences = useGrep ? 'findGrepPreferences' : 'findTextPreferences';
            const changePreferences = useGrep ? 'changeGrepPreferences' : 'changeTextPreferences';
            app[findPreferences] = NothingEnum.nothing;
            app[changePreferences] = NothingEnum.nothing;
            try {
                app[findPreferences].findWhat = ${JSON.stringify(useRegex ? grepPattern : searchText)};
                if (!useGrep) {
                    app.findTextPreferences.caseSensitive = ${caseSensitive};
                    app.findTextPreferences.wholeWord = ${wholeWord};
                }
                try { app.findChangeTextOptions.includeMasterPages = true; } catch(e) {}
                try { app.findChangeTextOptions.includeLockedLayersForFind = true; } catch(e) {}
                try { app.findChangeTextOptions.includeLockedStoriesForFind = true; } catch(e) {}
                try { app.findChangeTextOptions.includeHiddenLayers = true; } catch(e) {}
                let found;
                if (${hasReplacement}) {
                    app[changePreferences].changeTo = ${JSON.stringify(replaceText ?? '')};
                    found = useGrep ? doc.changeGrep() : doc.changeText();
                } else {
                    found = useGrep ? doc.findGrep() : doc.findText();
                }
                return {
                    success: true,
                    action: ${hasReplacement} ? 'replace' : 'find',
                    mode: useGrep ? 'grep' : 'text',
                    count: found.length,
                    searchText: ${JSON.stringify(searchText)}
                };
            } finally {
                app[findPreferences] = NothingEnum.nothing;
                app[changePreferences] = NothingEnum.nothing;
                try { app.findChangeTextOptions.includeMasterPages = false; } catch(e) {}
                try { app.findChangeTextOptions.includeLockedLayersForFind = false; } catch(e) {}
                try { app.findChangeTextOptions.includeLockedStoriesForFind = false; } catch(e) {}
                try { app.findChangeTextOptions.includeHiddenLayers = false; } catch(e) {}
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Find Text in Document")
            : formatErrorResponse(result?.error || 'Failed to find text in document', "Find Text in Document");
    }

    // =================== DOCUMENT LAYERS & ORGANIZATION ===================

    /**
     * Get all layers in the document
     */
    static async getDocumentLayers(args) {
        const { includeHidden = true, includeLocked = true } = args;

        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = targetDocument;
            const layers = [];
            for (let i = 0; i < doc.layers.length; i++) {
                const layer = doc.layers.item(i);
                if ((${includeHidden} || layer.visible) && (${includeLocked} || !layer.locked)) {
                    layers.push({
                        name: layer.name,
                        visible: layer.visible,
                        locked: layer.locked,
                        pageItemCount: layer.pageItems.length
                    });
                }
            }
            return { success: true, count: layers.length, layers };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Get Document Layers")
            : formatErrorResponse(result?.error || 'Failed to get document layers', "Get Document Layers");
    }

    /**
     * Organize and clean up document layers
     */
    static async organizeDocumentLayers(args) {
        const { deleteEmptyLayers = false, mergeSimilarLayers = false, sortLayers = false } = args;

        // L4: bulk layer ops run in one executeViaUXP call. The payload remains
        // atomic from the MCP point of view and is protected by a fresh backup.
        // InDesign 2026 does not reliably await an async UXP callback passed to
        // app.doScript, so the plugin executes the async payload directly.
        const code = `
            const { LocationOptions } = require('indesign');
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = targetDocument;
            const actions = [];
            if (${deleteEmptyLayers}) {
                for (let i = doc.layers.length - 1; i >= 0; i--) {
                    const layer = doc.layers.item(i);
                    if (layer.pageItems.length === 0) {
                        const layerName = layer.name;
                        layer.remove();
                        actions.push('Deleted empty layer: ' + layerName);
                    }
                }
            }
            if (${mergeSimilarLayers}) {
                const groups = Object.create(null);
                const snapshot = [];
                for (let i = 0; i < doc.layers.length; i++) snapshot.push(doc.layers.item(i));
                for (const layer of snapshot) {
                    if (!layer || layer.isValid === false) continue;
                    const normalizedName = String(layer.name).trim().replace(/\\s+/g, ' ').toLowerCase();
                    if (!normalizedName) continue;
                    if (!groups[normalizedName]) {
                        groups[normalizedName] = layer;
                        continue;
                    }
                    let target = groups[normalizedName];
                    if (!target || target.isValid === false || layer.isValid === false) continue;
                    const targetName = String(target.name).trim().replace(/\\s+/g, ' ');
                    const targetLocked = Boolean(target.locked);
                    const sourceLocked = Boolean(layer.locked);
                    target.locked = false;
                    layer.locked = false;
                    try {
                        const merged = target.merge(layer);
                        target = merged && merged.isValid !== false ? merged : target;
                        target.name = targetName;
                        target.locked = targetLocked || sourceLocked;
                        groups[normalizedName] = target;
                        actions.push('Merged similar layer into: ' + targetName);
                    } catch (error) {
                        if (target && target.isValid !== false) target.locked = targetLocked;
                        if (layer && layer.isValid !== false) layer.locked = sourceLocked;
                        throw error;
                    }
                }
            }
            if (${sortLayers}) {
                const atBeginning = LocationOptions.AT_BEGINNING !== undefined
                    ? LocationOptions.AT_BEGINNING
                    : LocationOptions.atBeginning;
                if (atBeginning === undefined) throw new Error('LocationOptions.AT_BEGINNING is unavailable');
                const orderedLayers = [];
                for (let i = 0; i < doc.layers.length; i++) orderedLayers.push(doc.layers.item(i));
                orderedLayers.sort((left, right) => String(left.name).localeCompare(String(right.name), undefined, { numeric: true, sensitivity: 'base' }));
                for (let i = orderedLayers.length - 1; i >= 0; i--) orderedLayers[i].move(atBeginning);
                actions.push('Sorted layers alphabetically: ' + orderedLayers.length);
            }
            return { success: true, message: 'Layer organization completed.', actions };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Organize Document Layers")
            : formatErrorResponse(result?.error || 'Failed to organize document layers', "Organize Document Layers");
    }

    // =================== DOCUMENT HYPERLINKS & INTERACTIVITY ===================

    /**
     * Get all hyperlinks in the document
     */
    static async getDocumentHyperlinks(args) {
        const { includeDestinations = true, includeSources = true } = args;

        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = targetDocument;
            const hyperlinks = [];
            for (let i = 0; i < doc.hyperlinks.length; i++) {
                const link = doc.hyperlinks.item(i);
                const entry = { name: link.name };
                if (${includeSources}) {
                    try { entry.source = link.source.name; } catch (e) { entry.source = null; }
                }
                if (${includeDestinations}) {
                    try { entry.destination = link.destination.name; } catch (e) { entry.destination = null; }
                }
                hyperlinks.push(entry);
            }
            return { success: true, count: hyperlinks.length, hyperlinks };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Get Document Hyperlinks")
            : formatErrorResponse(result?.error || 'Failed to get document hyperlinks', "Get Document Hyperlinks");
    }

    /**
     * Create a hyperlink in the document
     */
    static async createDocumentHyperlink(args) {
        const { sourceText, destination, linkType = 'URL', pageIndex } = args;

        const code = `
            const { NothingEnum } = require('indesign');
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = targetDocument;
            function findText(value) {
                app.findTextPreferences = NothingEnum.nothing;
                try {
                    app.findTextPreferences.findWhat = value;
                    return doc.findText();
                } finally {
                    app.findTextPreferences = NothingEnum.nothing;
                }
            }
            const sourceRanges = findText(${JSON.stringify(sourceText)});
            if (!sourceRanges.length) return { success: false, error: 'Hyperlink source text not found' };
            const source = doc.hyperlinkTextSources.add(sourceRanges[0]);
            let dest;
            try {
                const linkType = ${JSON.stringify(linkType)};
                if (linkType === 'URL') {
                    dest = doc.hyperlinkURLDestinations.add(${JSON.stringify(destination)});
                } else if (linkType === 'PAGE') {
                    const targetPage = doc.pages.item(${JSON.stringify(pageIndex)});
                    if (!targetPage || targetPage.isValid === false) throw new Error('Hyperlink target page not found');
                    dest = doc.hyperlinkPageDestinations.add(targetPage);
                } else {
                    const destinationRanges = findText(${JSON.stringify(destination)});
                    if (!destinationRanges.length) throw new Error('Hyperlink destination text not found');
                    dest = doc.hyperlinkTextDestinations.add(destinationRanges[0]);
                }
                const hyperlink = doc.hyperlinks.add(source, dest);
                return {
                    success: true,
                    message: 'Hyperlink created successfully: ' + hyperlink.name,
                    name: hyperlink.name,
                    linkType
                };
            } catch (error) {
                try { if (dest && dest.isValid !== false) dest.remove(); } catch (e) {}
                try { if (source && source.isValid !== false) source.remove(); } catch (e) {}
                throw error;
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Create Document Hyperlink")
            : formatErrorResponse(result?.error || 'Failed to create document hyperlink', "Create Document Hyperlink");
    }

    // =================== DOCUMENT SECTIONS & NUMBERING ===================

    /**
     * Get all sections in the document
     */
    static async getDocumentSections() {
        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = targetDocument;
            const sections = [];
            for (let i = 0; i < doc.sections.length; i++) {
                const section = doc.sections.item(i);
                sections.push({ name: section.name, sectionPrefix: section.sectionPrefix });
            }
            return { success: true, count: sections.length, sections };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Get Document Sections")
            : formatErrorResponse(result?.error || 'Failed to get document sections', "Get Document Sections");
    }

    /**
     * Create a new section in the document
     */
    static async createDocumentSection(args) {
        const { startPage, sectionPrefix, startNumber = 1, numberingStyle = 'ARABIC' } = args;

        const code = `
            const { PageNumberStyle } = require('indesign');
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = targetDocument;
            const page = doc.pages.item(${startPage});
            const section = doc.sections.add(page);
            if (${JSON.stringify(sectionPrefix || '')}) {
                section.sectionPrefix = ${JSON.stringify(sectionPrefix || '')};
                section.includeSectionPrefix = true;
            }
            section.continueNumbering = false;
            section.pageNumberStart = ${startNumber};
            const numberingStyles = {
                ARABIC: PageNumberStyle.ARABIC,
                ROMAN_UPPER: PageNumberStyle.UPPER_ROMAN,
                ROMAN_LOWER: PageNumberStyle.LOWER_ROMAN,
                LETTER_UPPER: PageNumberStyle.UPPER_LETTERS,
                LETTER_LOWER: PageNumberStyle.LOWER_LETTERS
            };
            section.pageNumberStyle = numberingStyles[${JSON.stringify(numberingStyle)}];
            return { success: true, message: 'Section created successfully on page ' + page.name };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Create Document Section")
            : formatErrorResponse(result?.error || 'Failed to create document section', "Create Document Section");
    }

    // =================== DOCUMENT XML & STRUCTURE ===================

    /**
     * Get XML structure of the document
     */
    static async getDocumentXmlStructure(args) {
        const { includeTags = true, includeElements = true } = args;

        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = targetDocument;
            const tags = ${includeTags} ? (() => {
                const t = [];
                for (let i = 0; i < doc.xmlTags.length; i++) t.push(doc.xmlTags.item(i).name);
                return t;
            })() : null;
            const elementCount = ${includeElements} ? doc.xmlElements.length : null;
            return { success: true, tags, elementCount };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Get Document XML Structure")
            : formatErrorResponse(result?.error || 'Failed to get document XML structure', "Get Document XML Structure");
    }

    /**
     * Export document as XML
     */
    static async exportDocumentXml(args) {
        const { filePath, includeImages = true, includeStyles = true } = args;

        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const { ExportFormat } = require('indesign');
            const doc = targetDocument;
            if (!${includeStyles}) {
                return {
                    success: false,
                    error: 'Disabling existing XML style/tag mappings is unsupported; no export was written.'
                };
            }
            const preferences = doc.xmlExportPreferences;
            const previous = {
                copyOriginalImages: preferences.copyOriginalImages,
                copyOptimizedImages: preferences.copyOptimizedImages,
                copyFormattedImages: preferences.copyFormattedImages
            };
            try {
                preferences.copyOriginalImages = ${includeImages};
                preferences.copyOptimizedImages = false;
                preferences.copyFormattedImages = false;
                await doc.exportFile(ExportFormat.xmlType, ${JSON.stringify(filePath)}, false);
            } finally {
                preferences.copyOriginalImages = previous.copyOriginalImages;
                preferences.copyOptimizedImages = previous.copyOptimizedImages;
                preferences.copyFormattedImages = previous.copyFormattedImages;
            }
            return {
                success: true,
                message: 'Document exported as XML successfully',
                filePath: ${JSON.stringify(filePath)},
                copiedOriginalImages: ${includeImages},
                styleMappings: 'existing'
            };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Export Document XML")
            : formatErrorResponse(result?.error || 'Failed to export document XML', "Export Document XML");
    }

    // =================== DOCUMENT CLOUD & COLLABORATION ===================

    /**
     * Save document to Adobe Creative Cloud
     */
    static async saveDocumentToCloud(args) {
        const { cloudName, includeAssets = true } = args;

        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const { LinkStatus } = require('indesign');
            const doc = targetDocument;
            const enumEquals = (actual, expected) => {
                if (actual === undefined || actual === null || expected === undefined || expected === null) return false;
                if (actual === expected) return true;
                try { if (actual && typeof actual.equals === 'function') return actual.equals(expected); } catch (e) {}
                try { if (expected && typeof expected.equals === 'function') return expected.equals(actual); } catch (e) {}
                try { return Number(actual) === Number(expected); } catch (e) { return false; }
            };
            const linkStatuses = {
                NORMAL: LinkStatus.NORMAL !== undefined ? LinkStatus.NORMAL : LinkStatus.normal,
                LINK_EMBEDDED: LinkStatus.LINK_EMBEDDED !== undefined ? LinkStatus.LINK_EMBEDDED : LinkStatus.linkEmbedded,
                LINK_OUT_OF_DATE: LinkStatus.LINK_OUT_OF_DATE !== undefined ? LinkStatus.LINK_OUT_OF_DATE : LinkStatus.linkOutOfDate,
                LINK_MISSING: LinkStatus.LINK_MISSING !== undefined ? LinkStatus.LINK_MISSING : LinkStatus.linkMissing,
                LINK_INACCESSIBLE: LinkStatus.LINK_INACCESSIBLE !== undefined ? LinkStatus.LINK_INACCESSIBLE : LinkStatus.linkInaccessible
            };
            const linkStatusName = (status) => {
                if (enumEquals(status, linkStatuses.NORMAL)) return 'NORMAL';
                if (enumEquals(status, linkStatuses.LINK_EMBEDDED)) return 'LINK_EMBEDDED';
                if (enumEquals(status, linkStatuses.LINK_OUT_OF_DATE)) return 'LINK_OUT_OF_DATE';
                if (enumEquals(status, linkStatuses.LINK_MISSING)) return 'LINK_MISSING';
                if (enumEquals(status, linkStatuses.LINK_INACCESSIBLE)) return 'LINK_INACCESSIBLE';
                return 'UNKNOWN';
            };
            let linkedAssetsVerified = 0;
            if (${includeAssets}) {
                for (let i = 0; i < doc.links.length; i++) {
                    const link = doc.links.item(i);
                    if (!link || link.isValid === false) {
                        return { success: false, error: 'Cloud save refused because a linked asset is invalid.' };
                    }
                    const status = link.status;
                    const healthy = enumEquals(status, linkStatuses.NORMAL) || enumEquals(status, linkStatuses.LINK_EMBEDDED);
                    if (!healthy) {
                        return {
                            success: false,
                            error: 'Cloud save refused because linked asset "' + String(link.name || ('#' + i)) + '" has status ' + linkStatusName(status) + '.'
                        };
                    }
                    linkedAssetsVerified += 1;
                }
            }
            if (doc.isCloudDocument) {
                await doc.save();
                return { success: true, message: 'Cloud document saved successfully', linkedAssetsVerified };
            } else {
                await doc.saveACopyCloud(${JSON.stringify(cloudName)});
                return { success: true, message: 'Document saved to cloud as: ' + ${JSON.stringify(cloudName)}, linkedAssetsVerified };
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Save Document to Cloud")
            : formatErrorResponse(result?.error || 'Failed to save document to cloud', "Save Document to Cloud");
    }

    /**
     * Open a document from Adobe Creative Cloud
     */
    static async openCloudDocument(args) {
        const { cloudDocumentId } = args;

        const code = `
            const opened = await app.openCloudDocument(${JSON.stringify(cloudDocumentId)});
            const documentId = opened && opened.isValid !== false
                ? Number(opened.id)
                : Number(app.activeDocument.id);
            return { success: true, message: 'Cloud document opened successfully', documentId };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Open Cloud Document")
            : formatErrorResponse(result?.error || 'Failed to open cloud document', "Open Cloud Document");
    }

    // =================== DOCUMENT GRID & LAYOUT ===================

    /**
     * Get comprehensive grid settings for the document
     */
    static async getDocumentGridSettings() {
        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = targetDocument;
            const safeGet = (fn) => { try { return fn(); } catch (e) { return null; } };
            return {
                success: true,
                grid: {
                    documentGridColor: safeGet(() => String(doc.gridPreferences.documentGridColor)),
                    documentGridIncrement: safeGet(() => doc.gridPreferences.documentGridIncrement),
                    documentGridSubdivision: safeGet(() => doc.gridPreferences.documentGridSubdivision),
                    gridViewThreshold: safeGet(() => doc.gridPreferences.gridViewThreshold),
                    gridAlignment: safeGet(() => String(doc.gridPreferences.gridAlignment))
                },
                baselineGrid: {
                    baselineGridColor: safeGet(() => String(doc.gridPreferences.baselineGridColor)),
                    baselineGridIncrement: safeGet(() => doc.gridPreferences.baselineGridIncrement),
                    baselineGridOffset: safeGet(() => doc.gridPreferences.baselineGridOffset),
                    baselineGridViewThreshold: safeGet(() => doc.gridPreferences.baselineGridViewThreshold)
                }
            };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Get Document Grid Settings")
            : formatErrorResponse(result?.error || 'Failed to get document grid settings', "Get Document Grid Settings");
    }

    /**
     * Set comprehensive grid settings for the document
     */
    static async setDocumentGridSettings(args) {
        const {
            documentGridColor = null,
            documentGridIncrement = null,
            documentGridSubdivision = null,
            baselineGridColor = null,
            baselineGridIncrement = null,
            baselineGridOffset = null,
            baselineGridViewThreshold = null,
            gridViewThreshold = null,
            gridAlignment = null
        } = args;

        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = targetDocument;
            const safeSet = (fn) => { try { fn(); } catch (e) {} };
            if (${JSON.stringify(documentGridColor)} !== null) safeSet(() => { doc.gridPreferences.documentGridColor = ${JSON.stringify(documentGridColor)}; });
            if (${JSON.stringify(documentGridIncrement)} !== null) safeSet(() => { doc.gridPreferences.documentGridIncrement = ${JSON.stringify(documentGridIncrement)}; });
            if (${JSON.stringify(documentGridSubdivision)} !== null) safeSet(() => { doc.gridPreferences.documentGridSubdivision = ${JSON.stringify(documentGridSubdivision)}; });
            if (${JSON.stringify(gridViewThreshold)} !== null) safeSet(() => { doc.gridPreferences.gridViewThreshold = ${JSON.stringify(gridViewThreshold)}; });
            if (${JSON.stringify(baselineGridColor)} !== null) safeSet(() => { doc.gridPreferences.baselineGridColor = ${JSON.stringify(baselineGridColor)}; });
            if (${JSON.stringify(baselineGridIncrement)} !== null) safeSet(() => { doc.gridPreferences.baselineGridIncrement = ${JSON.stringify(baselineGridIncrement)}; });
            if (${JSON.stringify(baselineGridOffset)} !== null) safeSet(() => { doc.gridPreferences.baselineGridOffset = ${JSON.stringify(baselineGridOffset)}; });
            if (${JSON.stringify(baselineGridViewThreshold)} !== null) safeSet(() => { doc.gridPreferences.baselineGridViewThreshold = ${JSON.stringify(baselineGridViewThreshold)}; });
            if (${JSON.stringify(gridAlignment)} !== null) safeSet(() => { doc.gridPreferences.gridAlignment = ${JSON.stringify(gridAlignment)}; });
            return { success: true, message: 'Document grid settings updated successfully' };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Set Document Grid Settings")
            : formatErrorResponse(result?.error || 'Failed to set document grid settings', "Set Document Grid Settings");
    }

    /**
     * Get layout preferences and settings
     */
    static async getDocumentLayoutPreferences() {
        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = targetDocument;
            const safeGet = (fn) => { try { return fn(); } catch (e) { return null; } };
            return {
                success: true,
                adjustLayout: {
                    adjustLayout: safeGet(() => doc.adjustLayoutPreferences.adjustLayout),
                    adjustLayoutMargins: safeGet(() => doc.adjustLayoutPreferences.adjustLayoutMargins),
                    adjustLayoutPageBreaks: safeGet(() => doc.adjustLayoutPreferences.adjustLayoutPageBreaks),
                    adjustLayoutRules: safeGet(() => String(doc.adjustLayoutPreferences.adjustLayoutRules))
                },
                alignDistribute: {
                    alignDistributeBounds: safeGet(() => String(doc.alignDistributePreferences.alignDistributeBounds)),
                    alignDistributeSpacing: safeGet(() => doc.alignDistributePreferences.alignDistributeSpacing)
                },
                smartGuides: {
                    smartGuidePreferences: safeGet(() => doc.smartGuidePreferences.smartGuidePreferences)
                }
            };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Get Document Layout Preferences")
            : formatErrorResponse(result?.error || 'Failed to get document layout preferences', "Get Document Layout Preferences");
    }

    /**
     * Set layout preferences for the document
     */
    static async setDocumentLayoutPreferences(args) {
        const {
            adjustLayout = null,
            adjustLayoutMargins = null,
            adjustLayoutPageBreaks = null,
            adjustLayoutRules = null,
            alignDistributeBounds = null,
            alignDistributeSpacing = null,
            smartGuidePreferences = null
        } = args;

        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = targetDocument;
            const safeSet = (fn) => { try { fn(); } catch (e) {} };
            if (${JSON.stringify(adjustLayout)} !== null) safeSet(() => { doc.adjustLayoutPreferences.adjustLayout = ${JSON.stringify(adjustLayout)}; });
            if (${JSON.stringify(adjustLayoutMargins)} !== null) safeSet(() => { doc.adjustLayoutPreferences.adjustLayoutMargins = ${JSON.stringify(adjustLayoutMargins)}; });
            if (${JSON.stringify(adjustLayoutPageBreaks)} !== null) safeSet(() => { doc.adjustLayoutPreferences.adjustLayoutPageBreaks = ${JSON.stringify(adjustLayoutPageBreaks)}; });
            if (${JSON.stringify(adjustLayoutRules)} !== null) safeSet(() => { doc.adjustLayoutPreferences.adjustLayoutRules = ${JSON.stringify(adjustLayoutRules)}; });
            if (${JSON.stringify(alignDistributeBounds)} !== null) safeSet(() => { doc.alignDistributePreferences.alignDistributeBounds = ${JSON.stringify(alignDistributeBounds)}; });
            if (${JSON.stringify(alignDistributeSpacing)} !== null) safeSet(() => { doc.alignDistributePreferences.alignDistributeSpacing = ${JSON.stringify(alignDistributeSpacing)}; });
            if (${JSON.stringify(smartGuidePreferences)} !== null) safeSet(() => { doc.smartGuidePreferences.smartGuidePreferences = ${JSON.stringify(smartGuidePreferences)}; });
            return { success: true, message: 'Document layout preferences updated successfully' };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Set Document Layout Preferences")
            : formatErrorResponse(result?.error || 'Failed to set document layout preferences', "Set Document Layout Preferences");
    }

    // =================== DOCUMENT VALIDATION & CLEANUP ===================

    /**
     * Validate document structure and content
     */
    static async validateDocument(args) {
        const { checkLinks = true, checkFonts = true, checkImages = true, checkStyles = false } = args;

        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const { LinkStatus, FontStatus } = require('indesign');
            const doc = targetDocument;
            const issues = [];
            let isValid = true;
            const enumEquals = (actual, expected) => {
                if (actual === undefined || actual === null || expected === undefined || expected === null) return false;
                if (actual === expected) return true;
                try { if (actual && typeof actual.equals === 'function') return actual.equals(expected); } catch (e) {}
                try { if (expected && typeof expected.equals === 'function') return expected.equals(actual); } catch (e) {}
                try { return Number(actual) === Number(expected); } catch (e) { return false; }
            };
            const linkStatuses = {
                NORMAL: LinkStatus.NORMAL !== undefined ? LinkStatus.NORMAL : LinkStatus.normal,
                LINK_EMBEDDED: LinkStatus.LINK_EMBEDDED !== undefined ? LinkStatus.LINK_EMBEDDED : LinkStatus.linkEmbedded,
                LINK_OUT_OF_DATE: LinkStatus.LINK_OUT_OF_DATE !== undefined ? LinkStatus.LINK_OUT_OF_DATE : LinkStatus.linkOutOfDate,
                LINK_MISSING: LinkStatus.LINK_MISSING !== undefined ? LinkStatus.LINK_MISSING : LinkStatus.linkMissing,
                LINK_INACCESSIBLE: LinkStatus.LINK_INACCESSIBLE !== undefined ? LinkStatus.LINK_INACCESSIBLE : LinkStatus.linkInaccessible
            };
            const fontStatuses = {
                INSTALLED: FontStatus.INSTALLED !== undefined ? FontStatus.INSTALLED : FontStatus.installed,
                NOT_AVAILABLE: FontStatus.NOT_AVAILABLE !== undefined ? FontStatus.NOT_AVAILABLE : FontStatus.notAvailable,
                FAUXED: FontStatus.FAUXED !== undefined ? FontStatus.FAUXED : FontStatus.fauxed,
                SUBSTITUTED: FontStatus.SUBSTITUTED !== undefined ? FontStatus.SUBSTITUTED : FontStatus.substituted,
                UNKNOWN: FontStatus.UNKNOWN !== undefined ? FontStatus.UNKNOWN : FontStatus.unknown
            };
            const linkStatusName = (status) => {
                if (enumEquals(status, linkStatuses.NORMAL)) return 'NORMAL';
                if (enumEquals(status, linkStatuses.LINK_EMBEDDED)) return 'LINK_EMBEDDED';
                if (enumEquals(status, linkStatuses.LINK_OUT_OF_DATE)) return 'LINK_OUT_OF_DATE';
                if (enumEquals(status, linkStatuses.LINK_MISSING)) return 'LINK_MISSING';
                if (enumEquals(status, linkStatuses.LINK_INACCESSIBLE)) return 'LINK_INACCESSIBLE';
                return 'UNKNOWN';
            };
            const fontStatusName = (status) => {
                if (enumEquals(status, fontStatuses.INSTALLED)) return 'INSTALLED';
                if (enumEquals(status, fontStatuses.NOT_AVAILABLE)) return 'NOT_AVAILABLE';
                if (enumEquals(status, fontStatuses.FAUXED)) return 'FAUXED';
                if (enumEquals(status, fontStatuses.SUBSTITUTED)) return 'SUBSTITUTED';
                if (enumEquals(status, fontStatuses.UNKNOWN)) return 'UNKNOWN';
                return 'UNRECOGNIZED';
            };
            if (${checkLinks}) {
                for (let i = 0; i < doc.links.length; i++) {
                    const link = doc.links.item(i);
                    if (!link || link.isValid === false) {
                        issues.push('Invalid link object at index ' + i);
                        isValid = false;
                        continue;
                    }
                    const status = link.status;
                    const healthy = enumEquals(status, linkStatuses.NORMAL) || enumEquals(status, linkStatuses.LINK_EMBEDDED);
                    if (!healthy) {
                        issues.push('Link status ' + linkStatusName(status) + ': ' + String(link.name || ('#' + i)));
                        isValid = false;
                    }
                }
            }
            if (${checkFonts}) {
                for (let i = 0; i < doc.fonts.length; i++) {
                    const font = doc.fonts.item(i);
                    if (!font || font.isValid === false) {
                        issues.push('Invalid font object at index ' + i);
                        isValid = false;
                        continue;
                    }
                    if (!enumEquals(font.status, fontStatuses.INSTALLED)) {
                        issues.push('Font status ' + fontStatusName(font.status) + ': ' + String(font.name || ('#' + i)));
                        isValid = false;
                    }
                }
            }
            if (${checkImages}) {
                const graphics = doc.allGraphics || [];
                for (let i = 0; i < graphics.length; i++) {
                    const graphic = graphics[i];
                    if (!graphic || graphic.isValid === false) {
                        issues.push('Invalid graphic at index ' + i);
                        isValid = false;
                        continue;
                    }
                    try {
                        const ppi = graphic.effectivePpi;
                        if (Array.isArray(ppi) && ppi.some((value) => !Number.isFinite(Number(value)) || Number(value) <= 0)) {
                            issues.push('Invalid effective resolution for graphic at index ' + i);
                            isValid = false;
                        }
                    } catch (e) {}
                }
            }
            if (${checkStyles}) {
                const collections = [
                    { family: 'paragraph', values: doc.allParagraphStyles || [] },
                    { family: 'character', values: doc.allCharacterStyles || [] },
                    { family: 'object', values: doc.allObjectStyles || [] }
                ];
                for (const { family, values: collection } of collections) {
                    for (let i = 0; i < collection.length; i++) {
                        const style = collection[i];
                        if (!style || style.isValid === false || !String(style.name || '').trim()) {
                            issues.push('Invalid or unnamed ' + family + ' style');
                            isValid = false;
                        }
                    }
                }
            }
            return { success: true, isValid, issues };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Validate Document")
            : formatErrorResponse(result?.error || 'Failed to validate document', "Validate Document");
    }

    /**
     * Clean up document (remove unused elements)
     */
    static async cleanupDocument(args) {
        const { removeUnusedStyles = false, removeUnusedColors = false, removeUnusedLayers = false, removeHiddenElements = false } = args;

        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = targetDocument;
            const actions = [];
            let removedItems = 0;
            if (${removeUnusedStyles}) {
                return {
                    success: false,
                    error: 'Unused style removal is refused because the InDesign DOM exposes no reliable unused-style inventory; no change was made.'
                };
            }
            if (${removeUnusedColors}) {
                const unusedColors = [];
                for (let i = 0; i < doc.unusedSwatches.length; i++) unusedColors.push(doc.unusedSwatches[i]);
                let removedColors = 0;
                for (const swatch of unusedColors) {
                    if (!swatch || swatch.isValid === false || /^\\[.*\\]$/.test(String(swatch.name))) continue;
                    swatch.remove();
                    removedColors += 1;
                }
                removedItems += removedColors;
                actions.push('Removed unused swatches: ' + removedColors);
            }
            if (${removeUnusedLayers}) {
                let removedLayers = 0;
                for (let i = doc.layers.length - 1; i >= 0 && doc.layers.length > 1; i--) {
                    const layer = doc.layers.item(i);
                    if (layer.pageItems.length !== 0) continue;
                    if (layer.locked) layer.locked = false;
                    layer.remove();
                    removedLayers += 1;
                }
                removedItems += removedLayers;
                actions.push('Removed empty layers: ' + removedLayers);
            }
            if (${removeHiddenElements}) {
                const pageItems = [];
                for (let i = 0; i < doc.allPageItems.length; i++) pageItems.push(doc.allPageItems[i]);
                let removedHidden = 0;
                for (let i = pageItems.length - 1; i >= 0; i--) {
                    const item = pageItems[i];
                    if (!item || item.isValid === false) continue;
                    let hidden = item.visible === false;
                    try { hidden = hidden || item.itemLayer.visible === false; } catch (e) {}
                    if (!hidden) continue;
                    try { if (item.locked) item.locked = false; } catch (e) {}
                    item.remove();
                    removedHidden += 1;
                }
                removedItems += removedHidden;
                actions.push('Removed hidden page items: ' + removedHidden);
            }
            return { success: true, actions, removedItems };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Cleanup Document")
            : formatErrorResponse(result?.error || 'Failed to cleanup document', "Cleanup Document");
    }
}
