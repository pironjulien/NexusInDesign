/**
 * Book management handlers
 */
import { ScriptExecutor } from '../core/scriptExecutor.js';
import { formatResponse, formatErrorResponse } from '../utils/stringUtils.js';

export class BookHandlers {
    /**
     * Create a book
     */
    static async createBook(args) {
        const { filePath } = args;

        const code = `
            try {
                const book = await app.books.add(${JSON.stringify(filePath)});
                await book.save();
                return { success: true, message: 'Book created: ' + ${JSON.stringify(filePath)} };
            } catch(e) {
                return { success: false, error: 'Error creating book: ' + e.message };
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success ?
            formatResponse(result.message, "Create Book") :
            formatErrorResponse(result?.error || 'Failed to create book', "Create Book");
    }

    /**
     * Open a book
     */
    static async openBook(args) {
        const { filePath } = args;

        const code = `
            try {
                const book = await app.open(${JSON.stringify(filePath)});
                return { success: true, message: 'Book opened: ' + book.name, name: book.name };
            } catch(e) {
                return { success: false, error: 'Error opening book: ' + e.message };
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success ?
            formatResponse(result.message, "Open Book") :
            formatErrorResponse(result?.error || 'Failed to open book', "Open Book");
    }

    /**
     * Add a document to a book
     */
    static async addDocumentToBook(args) {
        const { bookPath, documentPath } = args;

        const code = `
            try {
                const book = await app.open(${JSON.stringify(bookPath)});
                book.bookContents.add(${JSON.stringify(documentPath)});
                await book.save();
                await book.close();
                return { success: true, message: 'Document added to book successfully' };
            } catch(e) {
                return { success: false, error: 'Error adding document to book: ' + e.message };
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success ?
            formatResponse(result.message, "Add Document to Book") :
            formatErrorResponse(result?.error || 'Failed to add document to book', "Add Document to Book");
    }

    /**
     * Synchronize a book
     */
    static async synchronizeBook(args) {
        const { bookPath } = args;

        const code = `
            try {
                const book = await app.open(${JSON.stringify(bookPath)});
                book.synchronize();
                await book.save();
                await book.close();
                return { success: true, message: 'Book synchronized successfully' };
            } catch(e) {
                return { success: false, error: 'Error synchronizing book: ' + e.message };
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success ?
            formatResponse(result.message, "Synchronize Book") :
            formatErrorResponse(result?.error || 'Failed to synchronize book', "Synchronize Book");
    }

    /**
     * Export a book
     */
    static async exportBook(args) {
        const { bookPath, format = 'PDF', outputPath } = args;

        const code = `
            const { ExportFormat } = require('indesign');
            try {
                const book = await app.open(${JSON.stringify(bookPath)});
                const fmt = ${JSON.stringify(format)};
                let exportFormat;
                if (fmt === 'PDF') {
                    exportFormat = ExportFormat.pdfType;
                } else if (fmt === 'EPUB') {
                    exportFormat = ExportFormat.epub;
                } else if (fmt === 'HTML') {
                    exportFormat = ExportFormat.html;
                } else {
                    await book.close();
                    return { success: false, error: 'Unsupported format: ' + fmt };
                }
                await book.exportFile(exportFormat, ${JSON.stringify(outputPath)});
                await book.close();
                return { success: true, message: 'Book exported successfully' };
            } catch(e) {
                return { success: false, error: 'Error exporting book: ' + e.message };
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success ?
            formatResponse(result.message, "Export Book") :
            formatErrorResponse(result?.error || 'Failed to export book', "Export Book");
    }

    /**
     * Package a book for print
     */
    static async packageBook(args) {
        const {
            bookPath,
            outputPath,
            copyingFonts = true,
            copyingLinkedGraphics = true,
            copyingProfiles = true,
            updatingGraphics = true,
            includingHiddenLayers = false,
            ignorePreflightErrors = false,
            creatingReport = true,
            includeIdml = false,
            includePdf = false
        } = args;

        const code = `
            try {
                const book = await app.open(${JSON.stringify(bookPath)});
                await book.packageForPrint(
                    ${JSON.stringify(outputPath)},
                    ${copyingFonts},
                    ${copyingLinkedGraphics},
                    ${copyingProfiles},
                    ${updatingGraphics},
                    ${includingHiddenLayers},
                    ${ignorePreflightErrors},
                    ${creatingReport},
                    ${includeIdml},
                    ${includePdf}
                );
                await book.close();
                return { success: true, message: 'Book packaged successfully' };
            } catch(e) {
                return { success: false, error: 'Error packaging book: ' + e.message };
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success ?
            formatResponse(result.message, "Package Book") :
            formatErrorResponse(result?.error || 'Failed to package book', "Package Book");
    }

    /**
     * Get book information
     */
    static async getBookInfo(args) {
        const { bookPath } = args;

        const code = `
            try {
                const book = await app.open(${JSON.stringify(bookPath)});
                const contents = [];
                for (let i = 0; i < book.bookContents.length; i++) {
                    const item = book.bookContents.item(i);
                    contents.push({
                        name: item.name,
                        status: String(item.status),
                        pageCount: item.pageCount
                    });
                }
                const info = {
                    name: book.name,
                    modified: book.modified,
                    saved: book.saved,
                    automaticPagination: book.automaticPagination,
                    documentCount: book.bookContents.length,
                    contents: contents
                };
                await book.close();
                return { success: true, info: info };
            } catch(e) {
                return { success: false, error: 'Error getting book info: ' + e.message };
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        if (result?.success) {
            const info = result.info;
            let text = `=== BOOK INFORMATION ===\n`;
            text += `Name: ${info.name}\n`;
            text += `Modified: ${info.modified}\n`;
            text += `Saved: ${info.saved}\n`;
            text += `Automatic Pagination: ${info.automaticPagination}\n`;
            text += `\n=== BOOK CONTENTS ===\n`;
            text += `Number of Documents: ${info.documentCount}\n`;
            for (let i = 0; i < info.contents.length; i++) {
                const c = info.contents[i];
                text += `Document ${i + 1}: ${c.name}\n  Status: ${c.status}\n  Page Count: ${c.pageCount}\n`;
            }
            return formatResponse(text, "Get Book Info");
        }
        return formatErrorResponse(result?.error || 'Failed to get book info', "Get Book Info");
    }

    /**
     * List all books
     */
    static async listBooks(args) {
        const code = `
            try {
                const books = [];
                for (let i = 0; i < app.books.length; i++) {
                    const book = app.books.item(i);
                    books.push({
                        name: book.name,
                        modified: book.modified,
                        saved: book.saved,
                        documentCount: book.bookContents.length
                    });
                }
                return { success: true, books: books };
            } catch(e) {
                return { success: false, error: 'Error listing books: ' + e.message };
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        if (result?.success) {
            let text = `=== ALL BOOKS ===\nTotal books: ${result.books.length}\n\n`;
            for (let i = 0; i < result.books.length; i++) {
                const b = result.books[i];
                text += `Book ${i}:\n  Name: ${b.name}\n  Modified: ${b.modified}\n  Saved: ${b.saved}\n  Document Count: ${b.documentCount}\n\n`;
            }
            return formatResponse(text, "List Books");
        }
        return formatErrorResponse(result?.error || 'Failed to list books', "List Books");
    }

    /**
     * Repaginate a book
     */
    static async repaginateBook(args) {
        const { bookPath } = args;

        const code = `
            try {
                const book = await app.open(${JSON.stringify(bookPath)});
                book.repaginate();
                await book.save();
                await book.close();
                return { success: true, message: 'Book repaginated successfully' };
            } catch(e) {
                return { success: false, error: 'Error repaginating book: ' + e.message };
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success ?
            formatResponse(result.message, "Repaginate Book") :
            formatErrorResponse(result?.error || 'Failed to repaginate book', "Repaginate Book");
    }

    /**
     * Update all cross references in a book
     */
    static async updateAllCrossReferences(args) {
        const { bookPath } = args;

        const code = `
            try {
                const book = await app.open(${JSON.stringify(bookPath)});
                book.updateAllCrossReferences();
                await book.save();
                await book.close();
                return { success: true, message: 'All cross references updated successfully' };
            } catch(e) {
                return { success: false, error: 'Error updating cross references: ' + e.message };
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success ?
            formatResponse(result.message, "Update All Cross References") :
            formatErrorResponse(result?.error || 'Failed to update cross references', "Update All Cross References");
    }

    /**
     * Update all numbers in a book
     */
    static async updateAllNumbers(args) {
        const { bookPath } = args;

        const code = `
            try {
                const book = await app.open(${JSON.stringify(bookPath)});
                book.updateAllNumbers();
                await book.save();
                await book.close();
                return { success: true, message: 'All numbers updated successfully' };
            } catch(e) {
                return { success: false, error: 'Error updating numbers: ' + e.message };
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success ?
            formatResponse(result.message, "Update All Numbers") :
            formatErrorResponse(result?.error || 'Failed to update numbers', "Update All Numbers");
    }

    /**
     * Update chapter and paragraph numbers in a book
     */
    static async updateChapterAndParagraphNumbers(args) {
        const { bookPath } = args;

        const code = `
            try {
                const book = await app.open(${JSON.stringify(bookPath)});
                book.updateChapterAndParagraphNumbers();
                await book.save();
                await book.close();
                return { success: true, message: 'Chapter and paragraph numbers updated successfully' };
            } catch(e) {
                return { success: false, error: 'Error updating chapter/paragraph numbers: ' + e.message };
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success ?
            formatResponse(result.message, "Update Chapter and Paragraph Numbers") :
            formatErrorResponse(result?.error || 'Failed to update chapter/paragraph numbers', "Update Chapter and Paragraph Numbers");
    }

    /**
     * Preflight a book
     */
    static async preflightBook(args) {
        const { bookPath, outputPath, autoOpen = false } = args;

        const code = `
            try {
                const book = await app.open(${JSON.stringify(bookPath)});
                ${outputPath
                    ? `book.preflight(${JSON.stringify(outputPath)}, ${autoOpen});`
                    : `book.preflight();`
                }
                await book.close();
                return { success: true, message: 'Book preflighted successfully' };
            } catch(e) {
                return { success: false, error: 'Error preflighting book: ' + e.message };
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success ?
            formatResponse(result.message, "Preflight Book") :
            formatErrorResponse(result?.error || 'Failed to preflight book', "Preflight Book");
    }

    /**
     * Print a book
     */
    static async printBook(args) {
        const { bookPath, printDialog = true, printerPreset = 'DEFAULT_VALUE' } = args;

        const code = `
            const { PrinterPresetTypes } = require('indesign');
            try {
                const book = await app.open(${JSON.stringify(bookPath)});
                await book.print(${printDialog}, PrinterPresetTypes[${JSON.stringify(printerPreset)}]);
                await book.close();
                return { success: true, message: 'Book print job sent successfully' };
            } catch(e) {
                return { success: false, error: 'Error printing book: ' + e.message };
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success ?
            formatResponse(result.message, "Print Book") :
            formatErrorResponse(result?.error || 'Failed to print book', "Print Book");
    }

    /**
     * Set book properties
     */
    static async setBookProperties(args) {
        const {
            bookPath,
            automaticPagination,
            automaticDocumentConversion,
            insertBlankPage,
            mergeIdenticalLayers,
            synchronizeBulletNumberingList,
            synchronizeCellStyle,
            synchronizeCharacterStyle,
            synchronizeConditionalText,
            synchronizeCrossReferenceFormat,
            synchronizeMasterPage,
            synchronizeObjectStyle,
            synchronizeParagraphStyle,
            synchronizeSwatch,
            synchronizeTableOfContentStyle,
            synchronizeTableStyle,
            synchronizeTextVariable,
            synchronizeTrapStyle
        } = args;

        const props = {
            automaticPagination,
            automaticDocumentConversion,
            insertBlankPage,
            mergeIdenticalLayers,
            synchronizeBulletNumberingList,
            synchronizeCellStyle,
            synchronizeCharacterStyle,
            synchronizeConditionalText,
            synchronizeCrossReferenceFormat,
            synchronizeMasterPage,
            synchronizeObjectStyle,
            synchronizeParagraphStyle,
            synchronizeSwatch,
            synchronizeTableOfContentStyle,
            synchronizeTableStyle,
            synchronizeTextVariable,
            synchronizeTrapStyle
        };
        // Remove undefined values
        Object.keys(props).forEach(k => props[k] === undefined && delete props[k]);

        if (Object.keys(props).length === 0) {
            return formatErrorResponse('At least one book property must be provided', "Set Book Properties");
        }

        const code = `
            const { SaveOptions } = require('indesign');
            let book = null;
            try {
                book = await app.open(${JSON.stringify(bookPath)});
                const props = ${JSON.stringify(props)};
                const propertyNames = Object.keys(props);

                for (const key of propertyNames) {
                    book[key] = props[key];
                }

                const beforeSaveMismatches = propertyNames.filter(key => book[key] !== props[key]);
                if (beforeSaveMismatches.length > 0) {
                    throw new Error('Book property postcondition failed before save: ' + beforeSaveMismatches.join(', '));
                }

                await book.save();

                const afterSaveMismatches = propertyNames.filter(key => book[key] !== props[key]);
                if (afterSaveMismatches.length > 0) {
                    throw new Error('Book property postcondition failed after save: ' + afterSaveMismatches.join(', '));
                }

                await book.close(SaveOptions.NO);
                book = null;
                return {
                    success: true,
                    message: 'Book properties updated successfully',
                    updatedProperties: propertyNames,
                    postconditionVerified: true
                };
            } catch(e) {
                let cleanupError = null;
                if (book && book.isValid !== false) {
                    try {
                        await book.close(SaveOptions.NO);
                    } catch(closeError) {
                        cleanupError = closeError;
                    }
                }
                const cleanupMessage = cleanupError ? '; cleanup failed: ' + cleanupError.message : '';
                return { success: false, error: 'Error updating book properties: ' + e.message + cleanupMessage };
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success ?
            formatResponse({
                message: result.message,
                updatedProperties: result.updatedProperties,
                postconditionVerified: result.postconditionVerified
            }, "Set Book Properties") :
            formatErrorResponse(result?.error || 'Failed to set book properties', "Set Book Properties");
    }
}
