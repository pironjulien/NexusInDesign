/**
 * Export handlers
 */
import fs from 'node:fs/promises';
import { ScriptExecutor } from '../core/scriptExecutor.js';
import { formatResponse, formatErrorResponse } from '../utils/stringUtils.js';

export function normalizeExportImagesArgs(args) {
    const outputPath = args.outputPath;
    const format = args.format ?? 'JPEG';
    const quality = args.quality ?? 80;
    const resolution = args.resolution ?? 300;
    const pages = args.pages ?? 'all';
    if (typeof outputPath !== 'string' || outputPath.length === 0) throw new Error('outputPath est obligatoire.');
    if (!['JPEG', 'PNG'].includes(format)) throw new Error('format doit valoir JPEG ou PNG.');
    if (!Number.isFinite(resolution) || resolution < 1 || resolution > 2400) throw new Error('resolution doit être comprise entre 1 et 2400 ppp.');
    if (!Number.isFinite(quality) || quality < 1 || quality > 100) throw new Error('quality doit être comprise entre 1 et 100.');
    if (typeof pages !== 'string' || pages.length < 1 || pages.length > 128) throw new Error('pages est invalide.');
    if (pages.toLowerCase() === 'all') return { outputPath, format, quality, resolution, pages: 'all', requestedPages: null };

    const selected = new Set();
    for (const part of pages.split(',')) {
        const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
        if (!match) throw new Error(`Plage de pages invalide: ${part.trim() || '(vide)'}.`);
        const start = Number(match[1]);
        const end = match[2] ? Number(match[2]) : start;
        if (start < 1 || end < start || end > 10000) throw new Error(`Plage de pages hors limites: ${part.trim()}.`);
        for (let page = start; page <= end; page += 1) {
            selected.add(page);
            if (selected.size > 5000) throw new Error('La sélection dépasse 5000 pages.');
        }
    }
    return { outputPath, format, quality, resolution, pages, requestedPages: [...selected].sort((left, right) => left - right) };
}

export class ExportHandlers {
    /**
     * Export document to PDF
     */
    static async exportPDF(args) {
        const {
            filePath,
            preset = 'High Quality Print',
        } = args;

        const code = `
            const { ExportFormat } = require('indesign');
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = targetDocument;
            try {
                await doc.exportFile(ExportFormat.pdfType, ${JSON.stringify(filePath)}, false, ${JSON.stringify(preset)});
                return { success: true, message: 'PDF exported to ' + ${JSON.stringify(filePath)} };
            } catch(e) {
                return { success: false, error: 'Export failed: ' + e.message };
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success ?
            formatResponse(result.message, "Export PDF") :
            formatErrorResponse(result?.error || 'Failed to export PDF', "Export PDF");
    }

    /**
     * Export pages as images
     */
    static async exportImages(args) {
        let normalized;
        try {
            normalized = normalizeExportImagesArgs(args);
        } catch (error) {
            return formatErrorResponse(error.message, 'Export Images');
        }
        const { outputPath, format, quality, resolution, pages, requestedPages } = normalized;
        const extension = format === 'JPEG' ? 'jpg' : 'png';

        try {
            await fs.mkdir(outputPath, { recursive: false });
        } catch (error) {
            return formatErrorResponse(
                error.code === 'EEXIST' ? 'Le dossier de sortie existe déjà.' : `Impossible de créer le dossier de sortie: ${error.message}`,
                'Export Images',
            );
        }

        const code = `
            const { ExportFormat, ExportRangeOrAllPages, JPEGOptionsQuality, PNGExportRangeEnum } = require('indesign');
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = targetDocument;
            const folder = ${JSON.stringify(outputPath)};
            const formatStr = ${JSON.stringify(format)};

            let preferences = null;
            let oldResolution;
            let oldQuality;
            let oldRange;
            let oldPageString;
            let oldExportingSpread;
            let preferencesCaptured = false;
            try {
                let exportFormat;
                let exportRange;
                let rangeProperty;
                let qualityValue;
                if (formatStr === 'JPEG') {
                    exportFormat = ExportFormat.JPG !== undefined ? ExportFormat.JPG : (ExportFormat.jpg !== undefined ? ExportFormat.jpg : ExportFormat.jpegType);
                    preferences = app.jpegExportPreferences;
                    rangeProperty = 'jpegExportRange';
                    exportRange = ExportRangeOrAllPages && (
                        ExportRangeOrAllPages.EXPORT_RANGE !== undefined
                            ? ExportRangeOrAllPages.EXPORT_RANGE
                            : ExportRangeOrAllPages.exportRange
                    );
                    const qualityName = ${JSON.stringify(quality)} <= 25 ? 'LOW' : (${JSON.stringify(quality)} <= 50 ? 'MEDIUM' : (${JSON.stringify(quality)} <= 75 ? 'HIGH' : 'MAXIMUM'));
                    const lowerQualityName = qualityName.toLowerCase();
                    qualityValue = JPEGOptionsQuality && JPEGOptionsQuality[qualityName] !== undefined
                        ? JPEGOptionsQuality[qualityName]
                        : (JPEGOptionsQuality ? JPEGOptionsQuality[lowerQualityName] : undefined);
                    if (qualityValue === undefined) return { success: false, error: 'JPEG quality enum unavailable' };
                } else if (formatStr === 'PNG') {
                    exportFormat = ExportFormat.PNG_FORMAT !== undefined ? ExportFormat.PNG_FORMAT : ExportFormat.pngFormat;
                    preferences = app.pngExportPreferences;
                    rangeProperty = 'pngExportRange';
                    const pngRange = PNGExportRangeEnum || ExportRangeOrAllPages;
                    exportRange = pngRange && (
                        pngRange.EXPORT_RANGE !== undefined ? pngRange.EXPORT_RANGE : pngRange.exportRange
                    );
                } else {
                    return { success: false, error: 'Unsupported image format' };
                }
                if (exportFormat === undefined) return { success: false, error: 'Export format unavailable' };
                if (exportRange === undefined) return { success: false, error: 'Image export range unavailable' };
                oldResolution = preferences.exportResolution;
                oldQuality = formatStr === 'JPEG' ? preferences.jpegQuality : undefined;
                oldRange = preferences[rangeProperty];
                oldPageString = preferences.pageString;
                oldExportingSpread = preferences.exportingSpread;
                preferencesCaptured = true;
                preferences.exportResolution = ${JSON.stringify(resolution)};
                if (formatStr === 'JPEG') preferences.jpegQuality = qualityValue;
                preferences.exportingSpread = false;
                preferences[rangeProperty] = exportRange;

                const ext = ${JSON.stringify(extension)};
                const requestedPages = ${JSON.stringify(requestedPages)};
                let exportedCount = 0;
                if (requestedPages !== null) {
                    for (let i = 0; i < requestedPages.length; i++) {
                        if (requestedPages[i] > doc.pages.length) return { success: false, error: 'Requested page is outside the document' };
                    }
                    for (let i = 0; i < requestedPages.length; i++) {
                        const pageNum = requestedPages[i] - 1;
                        const fileName = folder + '/page_' + (pageNum + 1) + '.' + ext;
                        preferences.pageString = '+' + String(pageNum + 1);
                        await doc.exportFile(exportFormat, fileName, false);
                        exportedCount++;
                    }
                } else {
                    for (let i = 0; i < doc.pages.length; i++) {
                        const fileName = folder + '/page_' + (i + 1) + '.' + ext;
                        preferences.pageString = '+' + String(i + 1);
                        await doc.exportFile(exportFormat, fileName, false);
                        exportedCount++;
                    }
                }

                return { success: true, count: exportedCount };
            } catch(e) {
                return { success: false, error: 'Error exporting images: ' + e.message };
            } finally {
                if (preferences && preferencesCaptured) {
                    try { preferences.exportResolution = oldResolution; } catch (_) {}
                    try { preferences.exportingSpread = oldExportingSpread; } catch (_) {}
                    try { preferences.pageString = oldPageString; } catch (_) {}
                    try { preferences[formatStr === 'JPEG' ? 'jpegExportRange' : 'pngExportRange'] = oldRange; } catch (_) {}
                    if (formatStr === 'JPEG') {
                        try { preferences.jpegQuality = oldQuality; } catch (_) {}
                    }
                }
            }
        `;

        let result;
        try {
            result = await ScriptExecutor.executeViaUXP(code);
        } catch (error) {
            await fs.rmdir(outputPath).catch(() => {});
            throw error;
        }
        if (!result?.success) {
            await fs.rm(outputPath, { recursive: true, force: true }).catch(() => {});
            return formatErrorResponse(result?.error || 'Failed to export images', 'Export Images');
        }
        return formatResponse(`${result.count} pages exported as ${format} images to: ${outputPath}`, 'Export Images');
    }

    /**
     * Package document for printing
     */
    static async packageDocument(args) {
        const { folderPath, includeFonts = true, includeLinks = true, includeProfiles = true } = args;

        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = targetDocument;

            try {
                doc.packageForPrint(
                    ${JSON.stringify(folderPath)},
                    ${includeFonts},
                    ${includeLinks},
                    ${includeProfiles},
                    false,
                    false,
                    true
                );
                return { success: true };
            } catch(e) {
                return { success: false, error: 'Error packaging document: ' + e.message };
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success ?
            formatResponse(`Document packaged successfully to: ${folderPath}`, "Package Document") :
            formatErrorResponse(result?.error || 'Failed to package document', "Package Document");
    }
}
