/**
 * Style management handlers
 */
import { ScriptExecutor } from '../core/scriptExecutor.js';
import { formatResponse, formatErrorResponse } from '../utils/stringUtils.js';

export class StyleHandlers {
    /**
     * Create a paragraph style
     */
    static async createParagraphStyle(args) {
        const {
            name,
            fontFamily = 'Arial\tRegular',
            fontSize = 12,
            textColor = 'Black',
            alignment = 'LEFT_ALIGN',
            leading,
            spaceBefore,
            spaceAfter
        } = args;

        const code = `
            const { Justification } = require('indesign');
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            const style = doc.paragraphStyles.add({ name: ${JSON.stringify(name)} });
            try {
                style.appliedFont = app.fonts.itemByName(${JSON.stringify(fontFamily)});
            } catch (e) {
                style.appliedFont = app.fonts.itemByName('Arial\\tRegular');
            }
            style.pointSize = ${fontSize};
            if (${JSON.stringify(textColor)} !== 'Black') {
                try {
                    const color = doc.colors.itemByName(${JSON.stringify(textColor)});
                    if (color.isValid) style.fillColor = color;
                } catch (e) {}
            }
            const alignMap = {
                CENTER_ALIGN: Justification.centerAlign,
                RIGHT_ALIGN: Justification.rightAlign,
                JUSTIFY: Justification.fullyJustified,
                LEFT_ALIGN: Justification.leftAlign
            };
            style.justification = alignMap[${JSON.stringify(alignment)}] || Justification.leftAlign;
            ${leading !== undefined ? `style.leading = ${leading};` : ''}
            ${spaceBefore !== undefined ? `style.spaceBefore = ${spaceBefore};` : ''}
            ${spaceAfter !== undefined ? `style.spaceAfter = ${spaceAfter};` : ''}
            return {
                success: true,
                name: style.name,
                font: style.appliedFont.name,
                size: style.pointSize
            };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Create Paragraph Style")
            : formatErrorResponse(result?.error || 'Failed to create paragraph style', "Create Paragraph Style");
    }

    /**
     * Create a character style
     */
    static async createCharacterStyle(args) {
        const {
            name,
            fontFamily = 'Arial\tRegular',
            fontSize = 12,
            textColor = 'Black',
            bold = false,
            italic = false,
            underline = false
        } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            const style = doc.characterStyles.add({ name: ${JSON.stringify(name)} });
            try {
                style.appliedFont = app.fonts.itemByName(${JSON.stringify(fontFamily)});
            } catch (e) {
                style.appliedFont = app.fonts.itemByName('Arial\\tRegular');
            }
            style.pointSize = ${fontSize};
            if (${JSON.stringify(textColor)} !== 'Black') {
                try {
                    const color = doc.colors.itemByName(${JSON.stringify(textColor)});
                    if (color.isValid) style.fillColor = color;
                } catch (e) {}
            }
            style.fontStyle = ${JSON.stringify(bold && italic ? 'Bold Italic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular')};
            style.underline = ${underline};
            style.underlineOffset = ${underline ? 1 : 0};
            style.underlineWeight = ${underline ? 1 : 0};
            return {
                success: true,
                name: style.name,
                font: style.appliedFont.name,
                size: style.pointSize,
                fontStyle: style.fontStyle
            };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Create Character Style")
            : formatErrorResponse(result?.error || 'Failed to create character style', "Create Character Style");
    }

    /**
     * Apply a paragraph style to text
     */
    static async applyParagraphStyle(args) {
        const { styleName, pageIndex, objectIndex } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            const requestedPageIndex = ${JSON.stringify(pageIndex)};
            const requestedObjectIndex = ${JSON.stringify(objectIndex)};
            if (!Number.isInteger(requestedPageIndex) || requestedPageIndex < 0 || requestedPageIndex >= doc.pages.length) {
                return { success: false, error: 'Page index out of range' };
            }
            const page = doc.pages.item(requestedPageIndex);
            if (!page || page.isValid === false) return { success: false, error: 'Target page is invalid' };
            if (!Number.isInteger(requestedObjectIndex) || requestedObjectIndex < 0 || requestedObjectIndex >= page.pageItems.length) {
                return { success: false, error: 'Page item index out of range' };
            }
            const textFrame = page.pageItems.item(requestedObjectIndex);
            if (!textFrame || textFrame.isValid === false || !textFrame.paragraphs || textFrame.paragraphs.length === 0) {
                return { success: false, error: 'Target page item is not a non-empty text frame' };
            }
            const style = doc.paragraphStyles.itemByName(${JSON.stringify(styleName)});
            if (!style.isValid) return { success: false, error: 'Paragraph style not found: ' + ${JSON.stringify(styleName)} };
            const paragraph = textFrame.paragraphs.item(0);
            if (!paragraph || paragraph.isValid === false || typeof paragraph.applyParagraphStyle !== 'function') {
                return { success: false, error: 'Target paragraph is invalid' };
            }
            paragraph.applyParagraphStyle(style, false);

            const applied = paragraph.appliedParagraphStyle;
            let matches = applied === style;
            try {
                if (!matches && applied && typeof applied.equals === 'function') matches = applied.equals(style);
                if (!matches && style && typeof style.equals === 'function') matches = style.equals(applied);
            } catch (e) {}
            if (!matches && applied && applied.isValid !== false && applied.name === style.name) matches = true;
            if (!matches) return { success: false, error: 'Paragraph style postcondition failed' };

            return {
                success: true,
                styleName: style.name,
                pageIndex: requestedPageIndex,
                objectIndex: requestedObjectIndex,
                pageItemId: Number(textFrame.id),
                paragraphIndex: 0
            };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Apply Paragraph Style")
            : formatErrorResponse(result?.error || 'Failed to apply paragraph style', "Apply Paragraph Style");
    }

    /**
     * Apply a character style to text
     */
    static async applyCharacterStyle(args) {
        const { styleName, pageIndex, objectIndex, startIndex = 0, endIndex = -1 } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            const requestedPageIndex = ${JSON.stringify(pageIndex)};
            const requestedObjectIndex = ${JSON.stringify(objectIndex)};
            if (!Number.isInteger(requestedPageIndex) || requestedPageIndex < 0 || requestedPageIndex >= doc.pages.length) {
                return { success: false, error: 'Page index out of range' };
            }
            const page = doc.pages.item(requestedPageIndex);
            if (!page || page.isValid === false) return { success: false, error: 'Target page is invalid' };
            if (!Number.isInteger(requestedObjectIndex) || requestedObjectIndex < 0 || requestedObjectIndex >= page.pageItems.length) {
                return { success: false, error: 'Page item index out of range' };
            }
            const textFrame = page.pageItems.item(requestedObjectIndex);
            if (!textFrame || textFrame.isValid === false || !textFrame.texts || textFrame.texts.length === 0) {
                return { success: false, error: 'Target page item is not a non-empty text frame' };
            }
            const style = doc.characterStyles.itemByName(${JSON.stringify(styleName)});
            if (!style.isValid) return { success: false, error: 'Character style not found: ' + ${JSON.stringify(styleName)} };

            const text = textFrame.texts.item(0);
            const characterCount = text && text.characters ? text.characters.length : 0;
            const requestedStartIndex = ${JSON.stringify(startIndex)};
            const requestedEndIndex = ${JSON.stringify(endIndex)};
            const resolvedEndIndex = requestedEndIndex === -1 ? characterCount - 1 : requestedEndIndex;
            if (!Number.isInteger(requestedStartIndex) || !Number.isInteger(requestedEndIndex)
                || requestedStartIndex < 0 || resolvedEndIndex < requestedStartIndex || resolvedEndIndex >= characterCount) {
                return { success: false, error: 'Character range is invalid' };
            }
            const range = text.characters.itemByRange(requestedStartIndex, resolvedEndIndex);
            if (!range || range.isValid === false || typeof range.applyCharacterStyle !== 'function') {
                return { success: false, error: 'Target character range is invalid' };
            }
            range.applyCharacterStyle(style);

            const applied = range.appliedCharacterStyle;
            let matches = applied === style;
            try {
                if (!matches && applied && typeof applied.equals === 'function') matches = applied.equals(style);
                if (!matches && style && typeof style.equals === 'function') matches = style.equals(applied);
            } catch (e) {}
            if (!matches && applied && applied.isValid !== false && applied.name === style.name) matches = true;
            if (!matches) return { success: false, error: 'Character style postcondition failed' };

            return {
                success: true,
                styleName: style.name,
                pageIndex: requestedPageIndex,
                objectIndex: requestedObjectIndex,
                pageItemId: Number(textFrame.id),
                startIndex: requestedStartIndex,
                endIndex: resolvedEndIndex
            };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Apply Character Style")
            : formatErrorResponse(result?.error || 'Failed to apply character style', "Apply Character Style");
    }

    /**
     * List all styles in the document
     */
    static async listStyles(args) {
        const { styleType = 'ALL' } = args;

        const code = `
            const { Justification } = require('indesign');
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            const result = { success: true, styleType: ${JSON.stringify(styleType)} };

            function enumEquals(value, expected) {
                try {
                    if (value && typeof value.equals === 'function') return value.equals(expected);
                    if (expected && typeof expected.equals === 'function') return expected.equals(value);
                } catch (e) {}
                return value === expected;
            }

            function getAlignmentName(alignment) {
                if (enumEquals(alignment, Justification.leftAlign)) return 'LEFT_ALIGN';
                if (enumEquals(alignment, Justification.centerAlign)) return 'CENTER_ALIGN';
                if (enumEquals(alignment, Justification.rightAlign)) return 'RIGHT_ALIGN';
                if (enumEquals(alignment, Justification.fullyJustified)) return 'FULLY_JUSTIFIED';
                return 'UNKNOWN';
            }

            if (${JSON.stringify(styleType)} === 'PARAGRAPH' || ${JSON.stringify(styleType)} === 'ALL') {
                const paraStyles = [];
                for (let i = 0; i < doc.paragraphStyles.length; i++) {
                    const style = doc.paragraphStyles.item(i);
                    if (style.isValid) {
                        paraStyles.push({
                            name: style.name,
                            font: (style.appliedFont && style.appliedFont.isValid) ? style.appliedFont.name : '[Not set]',
                            size: style.pointSize,
                            alignment: getAlignmentName(style.justification),
                            color: (style.fillColor && style.fillColor.isValid) ? style.fillColor.name : null
                        });
                    }
                }
                result.paragraphStyles = paraStyles;
            }

            if (${JSON.stringify(styleType)} === 'CHARACTER' || ${JSON.stringify(styleType)} === 'ALL') {
                const charStyles = [];
                for (let i = 0; i < doc.characterStyles.length; i++) {
                    const style = doc.characterStyles.item(i);
                    if (style.isValid) {
                        charStyles.push({
                            name: style.name,
                            font: (style.appliedFont && style.appliedFont.isValid) ? style.appliedFont.name : '[Not set]',
                            size: style.pointSize,
                            fontStyle: style.fontStyle,
                            color: (style.fillColor && style.fillColor.isValid) ? style.fillColor.name : null
                        });
                    }
                }
                result.characterStyles = charStyles;
            }

            return result;
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "List Styles")
            : formatErrorResponse(result?.error || 'Failed to list styles', "List Styles");
    }

    /**
     * Create a color swatch
     */
    static async createColorSwatch(args) {
        const {
            name,
            colorType = 'PROCESS',
            red,
            green,
            blue
        } = args;

        // Convert RGB to CMYK using proper formula (done in Node.js, values embedded in UXP code)
        const r = red / 255;
        const g = green / 255;
        const b = blue / 255;

        const max = Math.max(r, g, b);
        const k = 1 - max;
        const c = max === 0 ? 0 : (max - r) / max;
        const m = max === 0 ? 0 : (max - g) / max;
        const y = max === 0 ? 0 : (max - b) / max;

        const cyan = Math.round(c * 100);
        const magenta = Math.round(m * 100);
        const yellow = Math.round(y * 100);
        const black = Math.round(k * 100);

        const code = `
            const { ColorModel, ColorSpace } = require('indesign');
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            const requestedModel = ${JSON.stringify(colorType)} === 'SPOT'
                ? (ColorModel.SPOT !== undefined ? ColorModel.SPOT : ColorModel.spot)
                : (ColorModel.PROCESS !== undefined ? ColorModel.PROCESS : ColorModel.process);
            const cmykSpace = ColorSpace.CMYK !== undefined ? ColorSpace.CMYK : ColorSpace.cmyk;
            const requestedValues = [${cyan}, ${magenta}, ${yellow}, ${black}];
            const color = doc.colors.add({
                name: ${JSON.stringify(name)},
                model: requestedModel,
                space: cmykSpace,
                colorValue: requestedValues
            });

            function enumEquals(value, expected) {
                try {
                    if (value && typeof value.equals === 'function') return value.equals(expected);
                    if (expected && typeof expected.equals === 'function') return expected.equals(value);
                } catch (e) {}
                return value === expected;
            }

            const actualValues = color.colorValue;
            const valuesMatch = actualValues && actualValues.length === requestedValues.length
                && requestedValues.every((value, index) => Number(actualValues[index]) === value);
            if (!color.isValid || color.name !== ${JSON.stringify(name)}
                || !enumEquals(color.model, requestedModel)
                || !enumEquals(color.space, cmykSpace)
                || !valuesMatch) {
                return { success: false, error: 'Color swatch postcondition failed' };
            }
            return {
                success: true,
                name: color.name,
                colorType: ${JSON.stringify(colorType)},
                cmyk: actualValues,
                sourceRgb: [${red}, ${green}, ${blue}]
            };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Create Color Swatch")
            : formatErrorResponse(result?.error || 'Failed to create color swatch', "Create Color Swatch");
    }

    /**
     * List all color swatches
     */
    static async listColorSwatches() {
        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            const swatches = [];
            for (let i = 0; i < doc.colors.length; i++) {
                const color = doc.colors.item(i);
                if (color && color.isValid) {
                    const entry = { name: color.name };
                    if (color.colorValue && color.colorValue.length >= 4) {
                        entry.cmyk = color.colorValue;
                    } else if (color.colorValue && color.colorValue.length >= 3) {
                        entry.rgb = color.colorValue;
                    }
                    swatches.push(entry);
                }
            }
            return { success: true, swatches };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "List Color Swatches")
            : formatErrorResponse(result?.error || 'Failed to list color swatches', "List Color Swatches");
    }

    /**
     * Apply a fill or stroke swatch to an exact page item
     */
    static async applyColor(args) {
        const { pageIndex, objectIndex, colorName, colorType = 'FILL' } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            const requestedPageIndex = ${JSON.stringify(pageIndex)};
            const requestedObjectIndex = ${JSON.stringify(objectIndex)};
            if (!Number.isInteger(requestedPageIndex) || requestedPageIndex < 0 || requestedPageIndex >= doc.pages.length) {
                return { success: false, error: 'Page index out of range' };
            }
            const page = doc.pages.item(requestedPageIndex);
            if (!page || page.isValid === false) return { success: false, error: 'Target page is invalid' };
            if (!Number.isInteger(requestedObjectIndex) || requestedObjectIndex < 0 || requestedObjectIndex >= page.pageItems.length) {
                return { success: false, error: 'Page item index out of range' };
            }
            const pageItem = page.pageItems.item(requestedObjectIndex);
            if (!pageItem || pageItem.isValid === false) return { success: false, error: 'Target page item is invalid' };
            const color = doc.swatches.itemByName(${JSON.stringify(colorName)});
            if (!color.isValid) return { success: false, error: 'Color not found: ' + ${JSON.stringify(colorName)} };

            const requestedColorType = ${JSON.stringify(colorType)};
            const propertyName = requestedColorType === 'STROKE' ? 'strokeColor' : 'fillColor';
            pageItem[propertyName] = color;

            const applied = pageItem[propertyName];
            let matches = applied === color;
            try {
                if (!matches && applied && typeof applied.equals === 'function') matches = applied.equals(color);
                if (!matches && color && typeof color.equals === 'function') matches = color.equals(applied);
            } catch (e) {}
            if (!matches && applied && applied.isValid !== false && applied.name === color.name) matches = true;
            if (!matches) {
                return { success: false, error: 'Color application postcondition failed' };
            }

            return {
                success: true,
                colorName: color.name,
                colorType: requestedColorType,
                pageIndex: requestedPageIndex,
                objectIndex: requestedObjectIndex,
                pageItemId: Number(pageItem.id)
            };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Apply Color")
            : formatErrorResponse(result?.error || 'Failed to apply color', "Apply Color");
    }
}
