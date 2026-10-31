/**
 * Master spread management handlers
 */
import { ScriptExecutor } from '../core/scriptExecutor.js';
import { formatResponse, formatErrorResponse } from '../utils/stringUtils.js';

export class MasterSpreadHandlers {
    /**
     * Create a master spread
     */
    static async createMasterSpread(args) {
        const { name, namePrefix, baseName, pageColor, showMasterItems = true } = args;
        const requestedBaseName = baseName ?? name;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            const { UIColors } = require('indesign');
            const beforeCount = doc.masterSpreads.length;
            let resolvedPageColor;
            const requestedPageColor = ${JSON.stringify(pageColor)};
            if (requestedPageColor !== undefined) {
                const rgbText = String(requestedPageColor).trim().replace(/^\\[/, '').replace(/\\]$/, '');
                const rgb = rgbText.split(',').map((part) => Number(part.trim()));
                if (rgb.length === 3 && rgb.every((component) => Number.isFinite(component) && component >= 0 && component <= 255)) {
                    resolvedPageColor = rgb;
                } else {
                    const colorKey = String(requestedPageColor).trim().toUpperCase().replace(/[ -]+/g, '_');
                    resolvedPageColor = UIColors[colorKey];
                    if (resolvedPageColor === undefined) return { success: false, error: 'Unsupported pageColor' };
                }
            }
            const masterSpread = doc.masterSpreads.add();
            masterSpread.showMasterItems = ${showMasterItems};
            masterSpread.baseName = ${JSON.stringify(requestedBaseName)};
            if (${JSON.stringify(namePrefix)} !== undefined) masterSpread.namePrefix = ${JSON.stringify(namePrefix)};
            if (resolvedPageColor !== undefined) masterSpread.pageColor = resolvedPageColor;
            const pageColorVerified = requestedPageColor === undefined || (
                Array.isArray(resolvedPageColor)
                    ? Array.isArray(masterSpread.pageColor) && resolvedPageColor.every((component, index) => Number(masterSpread.pageColor[index]) === component)
                    : masterSpread.pageColor === resolvedPageColor || Boolean(masterSpread.pageColor && masterSpread.pageColor.equals && masterSpread.pageColor.equals(resolvedPageColor))
            );
            if (!masterSpread.isValid || doc.masterSpreads.length !== beforeCount + 1 || masterSpread.baseName !== ${JSON.stringify(requestedBaseName)} || !pageColorVerified) {
                return { success: false, error: 'Master spread creation postcondition failed' };
            }
            return {
                success: true,
                name: masterSpread.name,
                namePrefix: masterSpread.namePrefix,
                baseName: masterSpread.baseName,
                pageColor: masterSpread.pageColor,
                id: masterSpread.id,
                postconditionVerified: true
            };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Create Master Spread")
            : formatErrorResponse(result?.error || 'Failed to create master spread', "Create Master Spread");
    }

    /**
     * List all master spreads
     */
    static async listMasterSpreads(args) {
        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            const spreads = [];
            for (let i = 0; i < doc.masterSpreads.length; i++) {
                const ms = doc.masterSpreads.item(i);
                spreads.push({
                    index: i,
                    name: ms.name,
                    namePrefix: ms.namePrefix,
                    baseName: ms.baseName,
                    showMasterItems: ms.showMasterItems,
                    pages: ms.pages.length,
                    id: ms.id
                });
            }
            return { success: true, masterSpreads: spreads, count: spreads.length };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "List Master Spreads")
            : formatErrorResponse(result?.error || 'Failed to list master spreads', "List Master Spreads");
    }

    /**
     * Delete a master spread
     */
    static async deleteMasterSpread(args) {
        const { name } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            const requestedName = ${JSON.stringify(name)};
            const masterSpread = doc.masterSpreads.itemByName(requestedName);
            if (!masterSpread.isValid) return { success: false, error: 'Master spread not found: ' + requestedName };
            const beforeCount = doc.masterSpreads.length;
            const deletedId = masterSpread.id;
            const deletedName = masterSpread.name;
            masterSpread.remove();
            const remaining = doc.masterSpreads.itemByName(requestedName);
            if (remaining.isValid || doc.masterSpreads.length !== beforeCount - 1) {
                return { success: false, error: 'Master spread deletion postcondition failed' };
            }
            return { success: true, deletedId, deletedName, postconditionVerified: true };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Delete Master Spread")
            : formatErrorResponse(result?.error || 'Failed to delete master spread', "Delete Master Spread");
    }

    /**
     * Duplicate a master spread
     */
    static async duplicateMasterSpread(args) {
        const { name, newName, position = 'AT_END', referenceName } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            const { LocationOptions } = require('indesign');
            const sourceName = ${JSON.stringify(name)};
            const requestedBaseName = ${JSON.stringify(newName)};
            const masterSpread = doc.masterSpreads.itemByName(sourceName);
            if (!masterSpread.isValid) return { success: false, error: 'Master spread not found: ' + sourceName };
            const beforeCount = doc.masterSpreads.length;
            let newMasterSpread;
            let referenceMasterSpread;
            const pos = ${JSON.stringify(position)};
            if (pos === 'AT_END') {
                newMasterSpread = masterSpread.duplicate(LocationOptions.AT_END);
            } else if (pos === 'AT_BEGINNING') {
                newMasterSpread = masterSpread.duplicate(LocationOptions.AT_BEGINNING);
            } else if (pos === 'BEFORE' || pos === 'AFTER') {
                const requestedReferenceName = ${JSON.stringify(referenceName)};
                if (requestedReferenceName === undefined) return { success: false, error: 'referenceName is required for ' + pos };
                referenceMasterSpread = doc.masterSpreads.itemByName(requestedReferenceName);
                if (!referenceMasterSpread.isValid) return { success: false, error: 'Reference master spread not found: ' + requestedReferenceName };
                newMasterSpread = masterSpread.duplicate(
                    pos === 'BEFORE' ? LocationOptions.BEFORE : LocationOptions.AFTER,
                    referenceMasterSpread
                );
            } else {
                return { success: false, error: 'Unsupported duplicate position: ' + pos };
            }
            if (!newMasterSpread || !newMasterSpread.isValid) {
                return { success: false, error: 'Master spread duplication failed' };
            }
            newMasterSpread.baseName = requestedBaseName;
            let positionVerified = false;
            if (pos === 'AT_END') positionVerified = newMasterSpread.index === doc.masterSpreads.length - 1;
            if (pos === 'AT_BEGINNING') positionVerified = newMasterSpread.index === 0;
            if (pos === 'BEFORE') positionVerified = newMasterSpread.index + 1 === referenceMasterSpread.index;
            if (pos === 'AFTER') positionVerified = newMasterSpread.index === referenceMasterSpread.index + 1;
            const createdByName = doc.masterSpreads.itemByName(newMasterSpread.name);
            if (
                doc.masterSpreads.length !== beforeCount + 1
                || newMasterSpread.baseName !== requestedBaseName
                || !positionVerified
                || !createdByName.isValid
                || String(createdByName.id) !== String(newMasterSpread.id)
            ) {
                return { success: false, error: 'Master spread duplication postcondition failed' };
            }
            return {
                success: true,
                name: newMasterSpread.name,
                namePrefix: newMasterSpread.namePrefix,
                baseName: newMasterSpread.baseName,
                id: newMasterSpread.id,
                index: newMasterSpread.index,
                postconditionVerified: true
            };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Duplicate Master Spread")
            : formatErrorResponse(result?.error || 'Failed to duplicate master spread', "Duplicate Master Spread");
    }

    /**
     * Apply a master spread to pages
     */
    static async applyMasterSpread(args) {
        const { masterName, pageRange = 'all' } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            const masterSpread = doc.masterSpreads.itemByName(${JSON.stringify(masterName)});
            if (!masterSpread.isValid) return { success: false, error: 'Master spread not found: ' + ${JSON.stringify(masterName)} };
            const pages = doc.pages;
            const pageRange = ${JSON.stringify(pageRange)};
            const selectedPages = [];
            if (pageRange === 'all') {
                for (let i = 0; i < pages.length; i++) {
                    selectedPages.push(pages.item(i));
                }
            } else if (/^\\d+-\\d+$/.test(pageRange)) {
                const range = pageRange.split('-');
                const start = parseInt(range[0]) - 1;
                const end = parseInt(range[1]) - 1;
                if (start < 0 || end < start || end >= pages.length) return { success: false, error: 'Page range out of bounds' };
                for (let i = start; i <= end; i++) {
                    selectedPages.push(pages.item(i));
                }
            } else if (/^\\d+$/.test(pageRange)) {
                const pageIndex = parseInt(pageRange) - 1;
                if (pageIndex < 0 || pageIndex >= pages.length) return { success: false, error: 'Page index out of bounds' };
                selectedPages.push(pages.item(pageIndex));
            } else {
                return { success: false, error: 'Invalid pageRange' };
            }
            for (const page of selectedPages) page.appliedMaster = masterSpread;
            const applied = selectedPages.every((page) => page.appliedMaster && String(page.appliedMaster.id) === String(masterSpread.id));
            if (!applied) return { success: false, error: 'Apply master spread postcondition failed' };
            return { success: true, masterName: masterSpread.name, appliedCount: selectedPages.length, postconditionVerified: true };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Apply Master Spread")
            : formatErrorResponse(result?.error || 'Failed to apply master spread', "Apply Master Spread");
    }

    /**
     * Create a text frame on a master spread
     */
    static async createMasterTextFrame(args) {
        const {
            masterName,
            content,
            x,
            y,
            width,
            height,
            fontSize = 12,
            fontFamily = "Arial",
            fontStyle = "Regular",
            textColor = "Black",
            alignment = "LEFT_ALIGN",
            isPrimaryTextFrame = false
        } = args;

        const alignmentMap = {
            LEFT_ALIGN: 'LEFT_ALIGN',
            CENTER_ALIGN: 'CENTER_ALIGN',
            RIGHT_ALIGN: 'RIGHT_ALIGN',
            JUSTIFY: 'FULLY_JUSTIFIED'
        };
        const uxpAlignment = alignmentMap[alignment] || 'LEFT_ALIGN';

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            const masterSpread = doc.masterSpreads.itemByName(${JSON.stringify(masterName)});
            if (!masterSpread.isValid) return { success: false, error: 'Master spread not found: ' + ${JSON.stringify(masterName)} };
            const { Justification, MeasurementUnits } = require('indesign');
            const page = masterSpread.pages.item(0);
            if (!page.isValid) return { success: false, error: 'Master spread has no valid page' };
            const swatchAliases = { Black: '[Black]', None: '[None]', Paper: '[Paper]', Registration: '[Registration]' };
            const requestedTextColor = ${JSON.stringify(textColor)};
            let textSwatch = doc.swatches.itemByName(requestedTextColor);
            if (!textSwatch.isValid && swatchAliases[requestedTextColor]) textSwatch = doc.swatches.itemByName(swatchAliases[requestedTextColor]);
            if (!textSwatch.isValid) return { success: false, error: 'Text color swatch not found: ' + requestedTextColor };
            const requestedFontFamily = ${JSON.stringify(fontFamily)};
            const requestedFontStyle = ${JSON.stringify(fontStyle)};
            let selectedFont = app.fonts.itemByName(requestedFontFamily + '\\t' + requestedFontStyle);
            if (!selectedFont.isValid) {
                for (let fontIndex = 0; fontIndex < app.fonts.length; fontIndex++) {
                    const candidate = app.fonts.item(fontIndex);
                    if (candidate.isValid && candidate.fontFamily === requestedFontFamily && candidate.fontStyleName === requestedFontStyle) {
                        selectedFont = candidate;
                        break;
                    }
                }
            }
            if (!selectedFont.isValid) return { success: false, error: 'Font not found: ' + requestedFontFamily + ' / ' + requestedFontStyle };
            const requestedJustification = Justification.${uxpAlignment};
            if (requestedJustification === undefined) return { success: false, error: 'Unsupported text alignment' };
            const millimeters = MeasurementUnits && (
                MeasurementUnits.MILLIMETERS !== undefined ? MeasurementUnits.MILLIMETERS : MeasurementUnits.millimeters
            );
            const viewPreferences = doc.viewPreferences;
            if (millimeters === undefined || !viewPreferences) return { success: false, error: 'Millimeter measurement mode unavailable' };
            const previousHorizontalUnits = viewPreferences.horizontalMeasurementUnits;
            const previousVerticalUnits = viewPreferences.verticalMeasurementUnits;
            try {
                viewPreferences.horizontalMeasurementUnits = millimeters;
                viewPreferences.verticalMeasurementUnits = millimeters;
                const expectedBounds = [${y}, ${x}, ${y + height}, ${x + width}];
                const beforeCount = masterSpread.textFrames.length;
                const textFrame = page.textFrames.add();
                textFrame.geometricBounds = expectedBounds;
                textFrame.contents = ${JSON.stringify(content)};
                const text = textFrame.texts.item(0);
                text.pointSize = ${fontSize};
                text.appliedFont = selectedFont;
                text.fontStyle = requestedFontStyle;
                text.fillColor = textSwatch;
                text.justification = requestedJustification;
                if (${isPrimaryTextFrame}) masterSpread.primaryTextFrame = textFrame;
                const actualBounds = Array.from(textFrame.geometricBounds || []);
                const boundsVerified = actualBounds.length === expectedBounds.length
                    && expectedBounds.every((value, index) => Math.abs(Number(actualBounds[index]) - value) <= 0.001);
                const primaryVerified = !${isPrimaryTextFrame} || (masterSpread.primaryTextFrame && String(masterSpread.primaryTextFrame.id) === String(textFrame.id));
                const appliedTextColor = text.fillColor;
                const colorVerified = typeof appliedTextColor === 'string'
                    ? appliedTextColor === textSwatch.name || appliedTextColor === requestedTextColor
                    : appliedTextColor && String(appliedTextColor.id) === String(textSwatch.id);
                const appliedFont = text.appliedFont;
                const fontFamilyVerified = typeof appliedFont === 'string'
                    ? appliedFont === requestedFontFamily || appliedFont.indexOf(requestedFontFamily + '\\t') === 0
                    : appliedFont && appliedFont.fontFamily === requestedFontFamily;
                const fontVerified = fontFamilyVerified && text.fontStyle === requestedFontStyle;
                const justificationVerified = text.justification === requestedJustification
                    || Boolean(text.justification && text.justification.equals && text.justification.equals(requestedJustification));
                if (
                    !textFrame.isValid
                    || masterSpread.textFrames.length !== beforeCount + 1
                    || !boundsVerified
                    || !primaryVerified
                    || !colorVerified
                    || !fontVerified
                    || !justificationVerified
                ) {
                    return { success: false, error: 'Master text frame creation postcondition failed' };
                }
                return {
                    success: true,
                    id: textFrame.id,
                    geometricBounds: actualBounds,
                    textColor: textSwatch.name,
                    isPrimaryTextFrame: ${isPrimaryTextFrame},
                    postconditionVerified: true
                };
            } finally {
                viewPreferences.horizontalMeasurementUnits = previousHorizontalUnits;
                viewPreferences.verticalMeasurementUnits = previousVerticalUnits;
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Create Master Text Frame")
            : formatErrorResponse(result?.error || 'Failed to create master text frame', "Create Master Text Frame");
    }

    /**
     * Create a rectangle on a master spread
     */
    static async createMasterRectangle(args) {
        const {
            masterName,
            x,
            y,
            width,
            height,
            fillColor = "None",
            strokeColor = "Black",
            strokeWidth = 1,
            cornerRadius = 0
        } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            const masterSpread = doc.masterSpreads.itemByName(${JSON.stringify(masterName)});
            if (!masterSpread.isValid) return { success: false, error: 'Master spread not found: ' + ${JSON.stringify(masterName)} };
            const { CornerOptions, MeasurementUnits } = require('indesign');
            const page = masterSpread.pages.item(0);
            if (!page.isValid) return { success: false, error: 'Master spread has no valid page' };
            const swatchAliases = { Black: '[Black]', None: '[None]', Paper: '[Paper]', Registration: '[Registration]' };
            function resolveSwatch(name) {
                let swatch = doc.swatches.itemByName(name);
                if (!swatch.isValid && swatchAliases[name]) swatch = doc.swatches.itemByName(swatchAliases[name]);
                return swatch;
            }
            const fillSwatch = resolveSwatch(${JSON.stringify(fillColor)});
            if (!fillSwatch.isValid) return { success: false, error: 'Fill color swatch not found: ' + ${JSON.stringify(fillColor)} };
            const strokeSwatch = resolveSwatch(${JSON.stringify(strokeColor)});
            if (!strokeSwatch.isValid) return { success: false, error: 'Stroke color swatch not found: ' + ${JSON.stringify(strokeColor)} };
            const millimeters = MeasurementUnits && (
                MeasurementUnits.MILLIMETERS !== undefined ? MeasurementUnits.MILLIMETERS : MeasurementUnits.millimeters
            );
            const roundedCorner = CornerOptions && (
                CornerOptions.ROUNDED_CORNER !== undefined ? CornerOptions.ROUNDED_CORNER : CornerOptions.roundedCorner
            );
            const viewPreferences = doc.viewPreferences;
            if (millimeters === undefined || !viewPreferences || (${cornerRadius} > 0 && roundedCorner === undefined)) {
                return { success: false, error: 'Required measurement or corner enumeration unavailable' };
            }
            const previousHorizontalUnits = viewPreferences.horizontalMeasurementUnits;
            const previousVerticalUnits = viewPreferences.verticalMeasurementUnits;
            try {
                viewPreferences.horizontalMeasurementUnits = millimeters;
                viewPreferences.verticalMeasurementUnits = millimeters;
                const expectedBounds = [${y}, ${x}, ${y + height}, ${x + width}];
                const beforeCount = masterSpread.rectangles.length;
                const rectangle = page.rectangles.add();
                rectangle.geometricBounds = expectedBounds;
                rectangle.fillColor = fillSwatch;
                rectangle.strokeColor = strokeSwatch;
                rectangle.strokeWeight = ${strokeWidth};
                if (${cornerRadius} > 0) {
                    rectangle.topLeftCornerOption = roundedCorner;
                    rectangle.topRightCornerOption = roundedCorner;
                    rectangle.bottomLeftCornerOption = roundedCorner;
                    rectangle.bottomRightCornerOption = roundedCorner;
                    rectangle.topLeftCornerRadius = ${cornerRadius};
                    rectangle.topRightCornerRadius = ${cornerRadius};
                    rectangle.bottomLeftCornerRadius = ${cornerRadius};
                    rectangle.bottomRightCornerRadius = ${cornerRadius};
                }
                const actualBounds = Array.from(rectangle.geometricBounds || []);
                const boundsVerified = actualBounds.length === expectedBounds.length
                    && expectedBounds.every((value, index) => Math.abs(Number(actualBounds[index]) - value) <= 0.001);
                const colorsVerified = rectangle.fillColor && rectangle.strokeColor
                    && String(rectangle.fillColor.id) === String(fillSwatch.id)
                    && String(rectangle.strokeColor.id) === String(strokeSwatch.id);
                const cornersVerified = ${cornerRadius} <= 0 || (
                    rectangle.topLeftCornerOption === roundedCorner
                    && rectangle.topRightCornerOption === roundedCorner
                    && rectangle.bottomLeftCornerOption === roundedCorner
                    && rectangle.bottomRightCornerOption === roundedCorner
                    && Math.abs(Number(rectangle.topLeftCornerRadius) - ${cornerRadius}) <= 0.001
                    && Math.abs(Number(rectangle.topRightCornerRadius) - ${cornerRadius}) <= 0.001
                    && Math.abs(Number(rectangle.bottomLeftCornerRadius) - ${cornerRadius}) <= 0.001
                    && Math.abs(Number(rectangle.bottomRightCornerRadius) - ${cornerRadius}) <= 0.001
                );
                if (
                    !rectangle.isValid
                    || masterSpread.rectangles.length !== beforeCount + 1
                    || !boundsVerified
                    || Number(rectangle.strokeWeight) !== ${strokeWidth}
                    || !colorsVerified
                    || !cornersVerified
                ) {
                    return { success: false, error: 'Master rectangle creation postcondition failed' };
                }
                return {
                    success: true,
                    id: rectangle.id,
                    geometricBounds: actualBounds,
                    strokeWidth: rectangle.strokeWeight,
                    cornerRadius: ${cornerRadius},
                    postconditionVerified: true
                };
            } finally {
                viewPreferences.horizontalMeasurementUnits = previousHorizontalUnits;
                viewPreferences.verticalMeasurementUnits = previousVerticalUnits;
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Create Master Rectangle")
            : formatErrorResponse(result?.error || 'Failed to create master rectangle', "Create Master Rectangle");
    }

    /**
     * Create guides on a master spread
     */
    static async createMasterGuides(args) {
        const {
            masterName,
            numberOfRows = 0,
            numberOfColumns = 0,
            rowGutter = 5,
            columnGutter = 5,
            guideColor = 'BLUE',
            fitMargins = true,
            removeExisting = false,
            layerName
        } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            const masterSpread = doc.masterSpreads.itemByName(${JSON.stringify(masterName)});
            if (!masterSpread.isValid) return { success: false, error: 'Master spread not found: ' + ${JSON.stringify(masterName)} };
            if (${numberOfRows} < 1 && ${numberOfColumns} < 1) return { success: false, error: 'At least one row or column is required' };
            const { UIColors } = require('indesign');
            const requestedGuideColor = ${JSON.stringify(guideColor)};
            const rgbText = String(requestedGuideColor).trim().replace(/^\\[/, '').replace(/\\]$/, '');
            const rgb = rgbText.split(',').map((part) => Number(part.trim()));
            let resolvedGuideColor;
            if (rgb.length === 3 && rgb.every((component) => Number.isFinite(component) && component >= 0 && component <= 255)) {
                resolvedGuideColor = rgb;
            } else {
                const colorKey = String(requestedGuideColor).trim().toUpperCase().replace(/[ -]+/g, '_');
                resolvedGuideColor = UIColors[colorKey];
                if (resolvedGuideColor === undefined) return { success: false, error: 'Unsupported guideColor' };
            }
            let layer;
            const requestedLayerName = ${JSON.stringify(layerName)};
            if (requestedLayerName !== undefined) {
                layer = doc.layers.itemByName(requestedLayerName);
                if (!layer.isValid) return { success: false, error: 'Layer not found: ' + requestedLayerName };
            }
            const beforeCount = masterSpread.guides.length;
            const beforeGuideIds = [];
            for (let guideIndex = 0; guideIndex < beforeCount; guideIndex++) beforeGuideIds.push(String(masterSpread.guides.item(guideIndex).id));
            if (layer) {
                masterSpread.createGuides(
                    ${numberOfRows},
                    ${numberOfColumns},
                    ${JSON.stringify(`${rowGutter}mm`)},
                    ${JSON.stringify(`${columnGutter}mm`)},
                    resolvedGuideColor,
                    ${fitMargins},
                    ${removeExisting},
                    layer
                );
            } else {
                masterSpread.createGuides(
                    ${numberOfRows},
                    ${numberOfColumns},
                    ${JSON.stringify(`${rowGutter}mm`)},
                    ${JSON.stringify(`${columnGutter}mm`)},
                    resolvedGuideColor,
                    ${fitMargins},
                    ${removeExisting}
                );
            }
            const afterCount = masterSpread.guides.length;
            const createdGuides = [];
            for (let guideIndex = 0; guideIndex < afterCount; guideIndex++) {
                const guide = masterSpread.guides.item(guideIndex);
                if (!beforeGuideIds.includes(String(guide.id))) createdGuides.push(guide);
            }
            const layerVerified = !layer || createdGuides.every((guide) => guide.itemLayer && String(guide.itemLayer.id) === String(layer.id));
            if (createdGuides.length === 0 || !layerVerified) return { success: false, error: 'Master guide creation postcondition failed' };
            return {
                success: true,
                masterName: masterSpread.name,
                rows: ${numberOfRows},
                columns: ${numberOfColumns},
                layerName: layer ? layer.name : null,
                guidesBefore: beforeCount,
                guidesAfter: afterCount,
                createdGuides: createdGuides.length,
                postconditionVerified: true
            };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Create Master Guides")
            : formatErrorResponse(result?.error || 'Failed to create master guides', "Create Master Guides");
    }

    /**
     * Get master spread information
     */
    static async getMasterSpreadInfo(args) {
        const { name } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            const requestedName = ${JSON.stringify(name)};
            const ms = doc.masterSpreads.itemByName(requestedName);
            if (!ms.isValid) return { success: false, error: 'Master spread not found: ' + requestedName };
            return {
                success: true,
                name: ms.name,
                namePrefix: ms.namePrefix,
                baseName: ms.baseName,
                pageColor: ms.pageColor,
                showMasterItems: ms.showMasterItems,
                index: ms.index,
                id: ms.id,
                primaryTextFrameId: ms.primaryTextFrame && ms.primaryTextFrame.isValid ? ms.primaryTextFrame.id : null,
                counts: {
                    pages: ms.pages.length,
                    textFrames: ms.textFrames.length,
                    rectangles: ms.rectangles.length,
                    ovals: ms.ovals.length,
                    polygons: ms.polygons.length,
                    groups: ms.groups.length,
                    guides: ms.guides.length,
                    allPageItems: ms.allPageItems.length
                }
            };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Get Master Spread Info")
            : formatErrorResponse(result?.error || 'Failed to get master spread info', "Get Master Spread Info");
    }
}
