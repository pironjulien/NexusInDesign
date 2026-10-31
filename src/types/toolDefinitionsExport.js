/**
 * Export tool definitions for InDesign MCP Server
 * Export, packaging, and production functionality
 */

export const exportToolDefinitions = [
    // =================== EXPORT MANAGEMENT ===================
    {
        name: 'export_pdf',
        description: 'Export document to PDF',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: 'Output PDF file path' },
                quality: { type: 'string', enum: ['PRESS', 'PRINT', 'SCREEN', 'DIGITAL'], default: 'PRINT' },
                includeMarks: { type: 'boolean', description: 'Include printer marks', default: false },
                includeBleed: { type: 'boolean', description: 'Include bleed', default: false },
                pages: { type: 'string', description: 'Page range (e.g., "1-5", "all")', default: 'all' },
            },
            required: ['filePath'],
        },
    },
    {
        name: 'export_images',
        description: 'Export pages as images',
        inputSchema: {
            type: 'object',
            properties: {
                outputPath: { type: 'string', description: 'Output directory path' },
                format: { type: 'string', enum: ['JPEG', 'PNG'], default: 'JPEG' },
                resolution: { type: 'number', minimum: 1, maximum: 2400, description: 'Resolution in DPI', default: 300 },
                pages: { type: 'string', minLength: 1, maxLength: 128, description: 'Page range (e.g., "1-5", "all")', default: 'all' },
                quality: { type: 'number', minimum: 1, maximum: 100, description: 'Quality (1-100 for JPEG, mapped to the four InDesign quality levels)', default: 80 },
            },
            required: ['outputPath'],
        },
    },
    {
        name: 'export_epub',
        description: 'Export a reflowable EPUB with Adobe ExportFormat.EPUB',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: 'Output EPUB file path' },
                includeImages: { type: 'boolean', const: true, description: 'Must remain true: Adobe exposes no reliable option to omit every image', default: true },
                includeStyles: { type: 'boolean', description: 'Generate the EPUB cascade style sheet', default: true },
            },
            required: ['filePath'],
        },
    },
    {
        name: 'package_document',
        description: 'Package document for printing',
        inputSchema: {
            type: 'object',
            properties: {
                outputPath: { type: 'string', description: 'Output directory path' },
                includeFonts: { type: 'boolean', description: 'Include fonts', default: true },
                includeLinks: { type: 'boolean', description: 'Include linked files', default: true },
                includeProfiles: { type: 'boolean', description: 'Include color profiles', default: true },
            },
            required: ['outputPath'],
        },
    },
];
