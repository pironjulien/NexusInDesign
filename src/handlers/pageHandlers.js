/**
 * Page management handlers
 */
import { ScriptExecutor } from '../core/scriptExecutor.js';
import { formatResponse, formatErrorResponse } from '../utils/stringUtils.js';

export class PageHandlers {
    /**
     * Add a new page to the document
     */
    static async addPage(args) {
        const { position = 'AT_END', referencePage } = args;

        const code = `
            const { LocationOptions } = require('indesign');
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            const enumMember = (enumeration, upperName, lowerName) => enumeration && (
                enumeration[upperName] !== undefined ? enumeration[upperName] : enumeration[lowerName]
            );
            const locMap = {
                AT_END: enumMember(LocationOptions, 'AT_END', 'atEnd'),
                AT_BEGINNING: enumMember(LocationOptions, 'AT_BEGINNING', 'atBeginning'),
                BEFORE: enumMember(LocationOptions, 'BEFORE', 'before'),
                AFTER: enumMember(LocationOptions, 'AFTER', 'after')
            };
            const requestedPosition = ${JSON.stringify(position)};
            const loc = locMap[requestedPosition];
            if (loc === undefined) return { success: false, error: 'Unsupported page position' };
            const requestedReferencePage = ${JSON.stringify(referencePage)};
            let reference;
            if (requestedPosition === 'BEFORE' || requestedPosition === 'AFTER') {
                if (!Number.isInteger(requestedReferencePage) || requestedReferencePage < 0 || requestedReferencePage >= doc.pages.length) {
                    return { success: false, error: 'Reference page index out of range' };
                }
                reference = doc.pages.item(requestedReferencePage);
                if (!reference || reference.isValid === false) return { success: false, error: 'Reference page is invalid' };
            }
            const beforeCount = doc.pages.length;
            const page = reference ? doc.pages.add(loc, reference) : doc.pages.add(loc);
            const positionVerified = requestedPosition === 'AT_END'
                ? page.documentOffset === doc.pages.length - 1
                : requestedPosition === 'AT_BEGINNING'
                    ? page.documentOffset === 0
                    : requestedPosition === 'BEFORE'
                        ? page.documentOffset + 1 === reference.documentOffset
                        : page.documentOffset === reference.documentOffset + 1;
            if (!page || page.isValid === false || doc.pages.length !== beforeCount + 1 || !positionVerified) {
                return { success: false, error: 'Page creation postcondition failed' };
            }
            return { success: true, pageIndex: page.documentOffset, name: page.name, totalPages: doc.pages.length, postconditionVerified: true };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Add Page")
            : formatErrorResponse(result?.error || 'Failed to add page', "Add Page");
    }

    /**
     * Get detailed information about a specific page
     */
    static async getPageInfo(args) {
        const { pageIndex } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            return {
                success: true,
                index: page.documentOffset,
                name: page.name,
                label: page.label,
                bounds: page.bounds,
                side: String(page.side),
                appliedMaster: page.appliedMaster ? page.appliedMaster.name : 'None',
                pageColor: String(page.pageColor),
                optionalPage: page.optionalPage,
                layoutRule: String(page.layoutRule)
            };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Get Page Info")
            : formatErrorResponse(result?.error || 'Failed to get page info', "Get Page Info");
    }

    /**
     * Navigate to a specific page
     */
    static async navigateToPage(args) {
        const { pageIndex } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            doc.pages.item(${pageIndex}).select();
            return { success: true, pageIndex: ${pageIndex} };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Navigate to Page")
            : formatErrorResponse(result?.error || 'Failed to navigate to page', "Navigate to Page");
    }

    /**
     * Delete a specific page from the document
     */
    static async deletePage(args) {
        const { pageIndex } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            doc.pages.item(${pageIndex}).remove();
            return { success: true, totalPages: doc.pages.length };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Delete Page")
            : formatErrorResponse(result?.error || 'Failed to delete page', "Delete Page");
    }

    /**
     * Duplicate a specific page
     */
    static async duplicatePage(args) {
        const { pageIndex, position = 'AT_END', referencePageIndex } = args;

        const code = `
            const { LocationOptions } = require('indesign');
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const originalPage = doc.pages.item(${pageIndex});
            const enumMember = (enumeration, upperName, lowerName) => enumeration && (
                enumeration[upperName] !== undefined ? enumeration[upperName] : enumeration[lowerName]
            );
            const locMap = {
                AT_END: enumMember(LocationOptions, 'AT_END', 'atEnd'),
                AT_BEGINNING: enumMember(LocationOptions, 'AT_BEGINNING', 'atBeginning'),
                BEFORE: enumMember(LocationOptions, 'BEFORE', 'before'),
                AFTER: enumMember(LocationOptions, 'AFTER', 'after')
            };
            const requestedPosition = ${JSON.stringify(position)};
            const loc = locMap[requestedPosition];
            if (loc === undefined) return { success: false, error: 'Unsupported page position' };
            const requestedReferencePage = ${JSON.stringify(referencePageIndex)};
            let reference;
            if (requestedPosition === 'BEFORE' || requestedPosition === 'AFTER') {
                if (!Number.isInteger(requestedReferencePage) || requestedReferencePage < 0 || requestedReferencePage >= doc.pages.length) {
                    return { success: false, error: 'Reference page index out of range' };
                }
                reference = doc.pages.item(requestedReferencePage);
                if (!reference || reference.isValid === false) return { success: false, error: 'Reference page is invalid' };
            }
            const beforeCount = doc.pages.length;
            const newPage = reference ? originalPage.duplicate(loc, reference) : originalPage.duplicate(loc);
            const positionVerified = requestedPosition === 'AT_END'
                ? newPage.documentOffset === doc.pages.length - 1
                : requestedPosition === 'AT_BEGINNING'
                    ? newPage.documentOffset === 0
                    : requestedPosition === 'BEFORE'
                        ? newPage.documentOffset + 1 === reference.documentOffset
                        : newPage.documentOffset === reference.documentOffset + 1;
            if (!newPage || newPage.isValid === false || doc.pages.length !== beforeCount + 1 || !positionVerified) {
                return { success: false, error: 'Page duplication postcondition failed' };
            }
            return { success: true, newPageIndex: newPage.documentOffset, totalPages: doc.pages.length, postconditionVerified: true };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Duplicate Page")
            : formatErrorResponse(result?.error || 'Failed to duplicate page', "Duplicate Page");
    }

    /**
     * Move a page to a different position
     */
    static async movePage(args) {
        const { pageIndex, position = 'AT_END', referencePageIndex, binding = 'DEFAULT_VALUE' } = args;

        const code = `
            const { LocationOptions, BindingOptions } = require('indesign');
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            const enumMember = (enumeration, upperName, lowerName) => enumeration && (
                enumeration[upperName] !== undefined ? enumeration[upperName] : enumeration[lowerName]
            );
            const locMap = {
                AT_END: enumMember(LocationOptions, 'AT_END', 'atEnd'),
                AT_BEGINNING: enumMember(LocationOptions, 'AT_BEGINNING', 'atBeginning'),
                BEFORE: enumMember(LocationOptions, 'BEFORE', 'before'),
                AFTER: enumMember(LocationOptions, 'AFTER', 'after')
            };
            const bindingMap = {
                DEFAULT_VALUE: enumMember(BindingOptions, 'DEFAULT_VALUE', 'defaultValue'),
                LEFT_ALIGN: enumMember(BindingOptions, 'LEFT_ALIGN', 'leftAlign'),
                RIGHT_ALIGN: enumMember(BindingOptions, 'RIGHT_ALIGN', 'rightAlign')
            };
            const requestedPosition = ${JSON.stringify(position)};
            const requestedBinding = ${JSON.stringify(binding)};
            const loc = locMap[requestedPosition];
            const bindingValue = bindingMap[requestedBinding];
            if (loc === undefined || bindingValue === undefined) return { success: false, error: 'Unsupported page move option' };
            const requestedReferencePage = ${JSON.stringify(referencePageIndex)};
            let reference;
            if (requestedPosition === 'BEFORE' || requestedPosition === 'AFTER') {
                if (!Number.isInteger(requestedReferencePage) || requestedReferencePage < 0 || requestedReferencePage >= doc.pages.length) {
                    return { success: false, error: 'Reference page index out of range' };
                }
                reference = doc.pages.item(requestedReferencePage);
                if (!reference || reference.isValid === false) return { success: false, error: 'Reference page is invalid' };
                if (String(reference.id) === String(page.id)) return { success: false, error: 'A page cannot be moved relative to itself' };
            }
            const beforeCount = doc.pages.length;
            if (reference) page.move(loc, reference, bindingValue);
            else page.move(loc, undefined, bindingValue);
            const positionVerified = requestedPosition === 'AT_END'
                ? page.documentOffset === doc.pages.length - 1
                : requestedPosition === 'AT_BEGINNING'
                    ? page.documentOffset === 0
                    : requestedPosition === 'BEFORE'
                        ? page.documentOffset + 1 === reference.documentOffset
                        : page.documentOffset === reference.documentOffset + 1;
            if (!page || page.isValid === false || doc.pages.length !== beforeCount || !positionVerified) {
                return { success: false, error: 'Page move postcondition failed' };
            }
            return { success: true, pageIndex: page.documentOffset, binding: requestedBinding, postconditionVerified: true };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Move Page")
            : formatErrorResponse(result?.error || 'Failed to move page', "Move Page");
    }

    // =================== ADVANCED PAGE PROPERTIES ===================

    /**
     * Set properties for a page
     */
    static async setPageProperties(args) {
        const { pageIndex, label, pageColor, optionalPage, layoutRule, snapshotBlendingMode, appliedTrapPreset } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            ${label !== undefined ? `page.label = ${JSON.stringify(label)};` : ''}
            ${pageColor !== undefined ? `page.pageColor = ${JSON.stringify(pageColor)};` : ''}
            ${optionalPage !== undefined ? `page.optionalPage = ${optionalPage};` : ''}
            ${layoutRule !== undefined ? `page.layoutRule = ${JSON.stringify(layoutRule)};` : ''}
            ${snapshotBlendingMode !== undefined ? `page.snapshotBlendingMode = ${JSON.stringify(snapshotBlendingMode)};` : ''}
            ${appliedTrapPreset !== undefined ? `page.appliedTrapPreset = ${JSON.stringify(appliedTrapPreset)};` : ''}
            return { success: true };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Set Page Properties")
            : formatErrorResponse(result?.error || 'Failed to set page properties', "Set Page Properties");
    }

    /**
     * Adjust page layout with new dimensions and margins
     */
    static async adjustPageLayout(args) {
        const {
            pageIndex, width, height,
            leftMargin, topMargin, rightMargin, bottomMargin
        } = args;

        const unsupportedBleedFields = ['bleedInside', 'bleedTop', 'bleedOutside', 'bleedBottom']
            .filter((field) => Object.hasOwn(args, field));
        if (unsupportedBleedFields.length > 0) {
            return formatErrorResponse(
                `Adobe ignore les fonds perdus lors d'un ajustement limité à une page (${unsupportedBleedFields.join(', ')}). Utilisez une commande au niveau du document.`,
                "Adjust Page Layout",
            );
        }
        const changes = Object.fromEntries(Object.entries({
            width,
            height,
            leftMargin,
            topMargin,
            rightMargin,
            bottomMargin,
        }).filter(([, entry]) => entry !== undefined));
        if (Object.keys(changes).length === 0) {
            return formatErrorResponse('Au moins une dimension ou une marge est requise.', "Adjust Page Layout");
        }

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            const changes = ${JSON.stringify(changes)};
            page.adjustLayout(changes);
            return { success: true, applied: changes };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Adjust Page Layout")
            : formatErrorResponse(result?.error || 'Failed to adjust page layout', "Adjust Page Layout");
    }

    /**
     * Resize a page
     */
    static async resizePage(args) {
        const {
            pageIndex, width, height,
            resizeMethod = 'REPLACING_CURRENT_DIMENSIONS_WITH',
            anchorPoint = 'CENTER_ANCHOR',
            coordinateSpace = 'PAGE_COORDINATES'
        } = args;

        const code = `
            const { CoordinateSpaces, AnchorPoint, ResizeMethods } = require('indesign');
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            const coordinateSpace = CoordinateSpaces[${JSON.stringify(coordinateSpace)}];
            const anchorPoint = AnchorPoint[${JSON.stringify(anchorPoint)}];
            const resizeMethod = ResizeMethods[${JSON.stringify(resizeMethod)}];
            if (coordinateSpace === undefined || anchorPoint === undefined || resizeMethod === undefined) {
                return { success: false, error: 'Unsupported resize enumeration' };
            }
            page.resize(
                coordinateSpace,
                anchorPoint,
                resizeMethod,
                [${width}, ${height}]
            );
            return { success: true, values: [${width}, ${height}] };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Resize Page")
            : formatErrorResponse(result?.error || 'Failed to resize page', "Resize Page");
    }

    /**
     * Place a file on a page
     */
    static async placeFileOnPage(args) {
        const { pageIndex, filePath, x = 10, y = 10, layerName, showingOptions = false, autoflowing = false } = args;
        const placePoint = [`${x}mm`, `${y}mm`];

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            const layer = ${layerName === undefined ? 'undefined' : `doc.layers.itemByName(${JSON.stringify(layerName)})`};
            if (layer && layer.isValid === false) return { success: false, error: 'Destination layer not found' };
            const placed = await page.place(
                ${JSON.stringify(filePath)},
                ${JSON.stringify(placePoint)},
                layer,
                ${showingOptions},
                ${autoflowing}
            );
            const placedItems = Array.isArray(placed) ? placed : (placed ? [placed] : []);
            return { success: true, itemCount: placedItems.length, itemIds: placedItems.map((item) => String(item.id)) };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Place File on Page")
            : formatErrorResponse(result?.error || 'Failed to place file on page', "Place File on Page");
    }

    /**
     * Place XML content on a page
     */
    static async placeXmlOnPage(args) {
        const { pageIndex, xmlElementName, x = 10, y = 10, autoflowing = false } = args;
        const placePoint = [`${x}mm`, `${y}mm`];

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            const xmlElement = doc.xmlElements.itemByName(${JSON.stringify(xmlElementName)});
            if (!xmlElement || xmlElement.isValid === false) return { success: false, error: 'XML element not found' };
            const placed = await page.placeXML(xmlElement, ${JSON.stringify(placePoint)}, ${autoflowing});
            return { success: true, itemId: placed ? String(placed.id) : undefined };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Place XML on Page")
            : formatErrorResponse(result?.error || 'Failed to place XML on page', "Place XML on Page");
    }

    /**
     * Create a snapshot of the current page layout
     */
    static async snapshotPageLayout(args) {
        const { pageIndex } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            page.snapshotCurrentLayout();
            return { success: true };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Snapshot Page Layout")
            : formatErrorResponse(result?.error || 'Failed to create snapshot', "Snapshot Page Layout");
    }

    /**
     * Delete the layout snapshot for a page
     */
    static async deletePageLayoutSnapshot(args) {
        const { pageIndex } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            page.deleteLayoutSnapshot();
            return { success: true };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Delete Page Layout Snapshot")
            : formatErrorResponse(result?.error || 'Failed to delete snapshot', "Delete Page Layout Snapshot");
    }

    /**
     * Delete all layout snapshots for a page
     */
    static async deleteAllPageLayoutSnapshots(args) {
        const { pageIndex } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            page.deleteAllLayoutSnapshots();
            return { success: true };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Delete All Page Layout Snapshots")
            : formatErrorResponse(result?.error || 'Failed to delete all snapshots', "Delete All Page Layout Snapshots");
    }

    /**
     * Reframe (resize) a page
     */
    static async reframePage(args) {
        const { pageIndex, x1, y1, x2, y2, coordinateSpace = 'pasteboardCoordinates' } = args;

        const code = `
            const { CoordinateSpaces } = require('indesign');
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            page.reframe(CoordinateSpaces[${JSON.stringify(coordinateSpace)}], [${x1}, ${y1}, ${x2}, ${y2}]);
            return { success: true };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Reframe Page")
            : formatErrorResponse(result?.error || 'Failed to reframe page', "Reframe Page");
    }

    /**
     * Create guides on a page
     */
    static async createPageGuides(args) {
        const {
            pageIndex,
            numberOfRows = 0,
            numberOfColumns = 0,
            rowGutter = 5,
            columnGutter = 5,
            guideColor = 'blue',
            fitMargins = true,
            removeExisting = false,
            layerName
        } = args;

        const code = `
            const { GuideColor } = require('indesign');
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            ${removeExisting ? 'page.guides.everyItem().remove();' : ''}
            ${layerName !== undefined ? `const layer = doc.layers.itemByName(${JSON.stringify(layerName)});` : ''}
            const color = GuideColor[${JSON.stringify(guideColor.toLowerCase())}] || GuideColor.blue;
            page.createGuides(${numberOfRows}, ${numberOfColumns}, ${rowGutter}, ${columnGutter}, color, ${fitMargins}${layerName !== undefined ? ', layer' : ''});
            return { success: true };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Create Page Guides")
            : formatErrorResponse(result?.error || 'Failed to create page guides', "Create Page Guides");
    }

    /**
     * Select a page
     */
    static async selectPage(args) {
        const { pageIndex, selectionMode = 'replaceWith' } = args;

        const code = `
            const { SelectionOptions } = require('indesign');
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            page.select(SelectionOptions[${JSON.stringify(selectionMode)}] || SelectionOptions.replaceWith);
            return { success: true };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Select Page")
            : formatErrorResponse(result?.error || 'Failed to select page', "Select Page");
    }

    /**
     * Get a summary of content on a page
     */
    static async getPageContentSummary(args) {
        const { pageIndex } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            return {
                success: true,
                pageName: page.name,
                textFrames: page.textFrames?.length ?? 0,
                rectangles: page.rectangles?.length ?? 0,
                ellipses: page.ovals?.length ?? 0,
                graphics: page.graphics?.length ?? 0,
                groups: page.groups?.length ?? 0,
                totalItems: page.allPageItems ? page.allPageItems.length : (page.pageItems ? page.pageItems.length : 0)
            };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Get Page Content Summary")
            : formatErrorResponse(result?.error || 'Failed to get page content summary', "Get Page Content Summary");
    }

    /**
     * Set page background by creating a full-page rectangle
     */
    static async setPageBackground(args) {
        const { pageIndex = 0, backgroundColor = 'White', opacity = 100 } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            const pageBounds = page.bounds;
            const pageWidth = pageBounds[3] - pageBounds[1];
            const pageHeight = pageBounds[2] - pageBounds[0];
            const backgroundRect = page.rectangles.add();
            backgroundRect.geometricBounds = [0, 0, pageHeight, pageWidth];
            const colorName = ${JSON.stringify(backgroundColor)};
            if (colorName !== 'White') {
                try {
                    const bgColor = doc.colors.itemByName(colorName);
                    backgroundRect.fillColor = bgColor.isValid ? bgColor : doc.colors.itemByName('White');
                } catch (e) {
                    backgroundRect.fillColor = doc.colors.itemByName('White');
                }
            } else {
                backgroundRect.fillColor = doc.colors.itemByName('White');
            }
            backgroundRect.transparencySettings.blendingSettings.opacity = ${opacity};
            backgroundRect.sendToBack();
            return { success: true, backgroundColor: colorName, opacity: ${opacity} };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Set Page Background")
            : formatErrorResponse(result?.error || 'Failed to set page background', "Set Page Background");
    }
}
