/**
 * Document tool definitions for InDesign MCP Server
 * Document management and advanced functionality
 */

export const documentToolDefinitions = [
    // =================== DOCUMENT MANAGEMENT ===================
    {
        name: 'get_document_info',
        description: 'Get information about the active document',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'create_document',
        description: 'Create a new document',
        inputSchema: {
            type: 'object',
            properties: {
                width: { type: 'number', description: 'Document width in mm', default: 210 },
                height: { type: 'number', description: 'Document height in mm', default: 297 },
                pages: { type: 'number', description: 'Number of pages', default: 1 },
                facingPages: { type: 'boolean', description: 'Enable facing pages', default: false },
                pageOrientation: { type: 'string', enum: ['PORTRAIT', 'LANDSCAPE'], default: 'PORTRAIT' },
                bleedTop: { type: 'number', description: 'Top bleed in mm', default: 3 },
                bleedBottom: { type: 'number', description: 'Bottom bleed in mm', default: 3 },
                bleedInside: { type: 'number', description: 'Inside bleed in mm', default: 3 },
                bleedOutside: { type: 'number', description: 'Outside bleed in mm', default: 3 },
                marginTop: { type: 'number', description: 'Top margin in mm', default: 20 },
                marginBottom: { type: 'number', description: 'Bottom margin in mm', default: 20 },
                marginLeft: { type: 'number', description: 'Left margin in mm', default: 20 },
                marginRight: { type: 'number', description: 'Right margin in mm', default: 20 },
            },
        },
    },
    {
        name: 'open_document',
        description: 'Open an existing document',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: 'Path to the document file' },
            },
            required: ['filePath'],
        },
    },
    {
        name: 'save_document',
        description: 'Save the active document',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: 'Path where to save the document' },
            },
            required: ['filePath'],
        },
    },
    {
        name: 'close_document',
        description: 'Close the active document. Use saveOptions to control unsaved-changes behavior.',
        inputSchema: {
            type: 'object',
            properties: {
                saveOptions: {
                    type: 'string',
                    enum: ['ASK', 'SAVE', 'DISCARD'],
                    description: 'What to do with unsaved changes. ASK (default) opens InDesign save dialog. SAVE saves first. DISCARD throws away changes.',
                    default: 'ASK',
                },
            },
        },
    },

    // =================== DOCUMENT ADVANCED TOOLS ===================
    {
        name: 'preflight_document',
        description: 'Run preflight on the document',
        inputSchema: {
            type: 'object',
            properties: {
                profile: { type: 'string', description: 'Preflight profile name', default: 'Basic' },
                includeWarnings: { type: 'boolean', description: 'Include warnings in report', default: true },
            },
        },
    },
    {
        name: 'zoom_to_page',
        description: 'Display a specific page in the active layout window at an exact zoom percentage',
        inputSchema: {
            type: 'object',
            properties: {
                pageIndex: { type: 'integer', minimum: 0, description: 'Page index to display' },
                zoomLevel: { type: 'number', minimum: 5, maximum: 4000, description: 'Zoom level in percent (Adobe range: 5 to 4000)', default: 100 },
            },
            required: ['pageIndex'],
        },
    },
    {
        name: 'data_merge',
        description: 'Merge an authorized data source through native InDesign data merge placeholders into a new document',
        inputSchema: {
            type: 'object',
            properties: {
                dataSource: { type: 'string', description: 'Authorized path to the CSV or delimited text data source' },
                removeBlankLines: { type: 'boolean', description: 'Remove blank lines caused by empty fields', default: false },
                linkImages: { type: 'boolean', description: 'Link images in the merged document instead of embedding them', default: true },
            },
            required: ['dataSource'],
        },
    },

    // =================== DOCUMENT ELEMENTS & STYLES ===================
    {
        name: 'get_document_elements',
        description: 'Get all elements in the document',
        inputSchema: {
            type: 'object',
            properties: {
                elementType: { type: 'string', enum: ['all', 'text', 'graphics', 'tables'], description: 'Type of elements to get', default: 'all' },
            },
        },
    },
    {
        name: 'get_document_styles',
        description: 'Get all styles in the document',
        inputSchema: {
            type: 'object',
            properties: {
                styleType: { type: 'string', enum: ['PARAGRAPH', 'CHARACTER', 'OBJECT', 'TABLE', 'CELL'], description: 'Type of styles to get', default: 'PARAGRAPH' },
            },
        },
    },
    {
        name: 'get_document_colors',
        description: 'Get all colors and swatches in the document',
        inputSchema: {
            type: 'object',
            properties: {
                includeSwatches: { type: 'boolean', description: 'Include swatches', default: true },
                includeGradients: { type: 'boolean', description: 'Include gradients', default: true },
                includeTints: { type: 'boolean', description: 'Include tints', default: true },
            },
        },
    },

    // =================== DOCUMENT PREFERENCES ===================
    {
        name: 'get_document_preferences',
        description: 'Get document preferences and settings',
        inputSchema: {
            type: 'object',
            properties: {
                preferenceType: { type: 'string', enum: ['GENERAL', 'GRID', 'GUIDES', 'TEXT', 'MARGINS'], description: 'Type of preferences to get', default: 'GENERAL' },
            },
        },
    },
    {
        name: 'set_document_preferences',
        description: 'Set document preferences',
        inputSchema: {
            type: 'object',
            properties: {
                preferenceType: { type: 'string', enum: ['GENERAL', 'GRID', 'GUIDES', 'TEXT', 'MARGINS'], description: 'Type of preferences to set' },
                preferences: { type: 'object', description: 'Preference values to set' },
            },
            required: ['preferenceType', 'preferences'],
        },
    },

    // =================== DOCUMENT STORIES & TEXT ===================
    {
        name: 'get_document_stories',
        description: 'Get all stories in the document',
        inputSchema: {
            type: 'object',
            properties: {
                includeOverset: { type: 'boolean', description: 'Include overset text', default: true },
            },
        },
    },
    {
        name: 'find_text_in_document',
        description: 'Find text across the entire document',
        inputSchema: {
            type: 'object',
            properties: {
                searchText: { type: 'string', description: 'Text to search for' },
                replaceText: { type: 'string', description: 'Text to replace with (optional)' },
                caseSensitive: { type: 'boolean', description: 'Case sensitive search', default: false },
                wholeWord: { type: 'boolean', description: 'Whole word search', default: false },
                useRegex: { type: 'boolean', description: 'Use regular expressions', default: false },
            },
            required: ['searchText'],
        },
    },

    // =================== DOCUMENT LAYERS & ORGANIZATION ===================
    {
        name: 'get_document_layers',
        description: 'Get all layers in the document',
        inputSchema: {
            type: 'object',
            properties: {
                includeHidden: { type: 'boolean', description: 'Include hidden layers', default: true },
                includeLocked: { type: 'boolean', description: 'Include locked layers', default: true },
            },
        },
    },
    {
        name: 'organize_document_layers',
        description: 'Organize and clean up document layers',
        inputSchema: {
            type: 'object',
            properties: {
                deleteEmptyLayers: { type: 'boolean', description: 'Delete empty layers', default: false },
                mergeSimilarLayers: { type: 'boolean', description: 'Merge layers whose names differ only by case or whitespace', default: false },
                sortLayers: { type: 'boolean', description: 'Sort layers alphabetically', default: false },
            },
        },
    },

    // =================== DOCUMENT HYPERLINKS & INTERACTIVITY ===================
    {
        name: 'get_document_hyperlinks',
        description: 'Get all hyperlinks in the document',
        inputSchema: {
            type: 'object',
            properties: {
                includeDestinations: { type: 'boolean', description: 'Include link destinations', default: true },
                includeSources: { type: 'boolean', description: 'Include link sources', default: true },
            },
        },
    },
    {
        name: 'create_document_hyperlink',
        description: 'Create a hyperlink in the document',
        inputSchema: {
            type: 'object',
            properties: {
                sourceText: { type: 'string', description: 'Text to link' },
                destination: { type: 'string', description: 'URL or destination text (required except for page links)' },
                linkType: { type: 'string', enum: ['URL', 'PAGE', 'TEXT'], description: 'Type of hyperlink', default: 'URL' },
                pageIndex: { type: 'integer', minimum: 0, description: 'Zero-based target page index (required for page links)' },
            },
            required: ['sourceText'],
            allOf: [
                {
                    if: { properties: { linkType: { const: 'PAGE' } }, required: ['linkType'] },
                    then: { required: ['pageIndex'] },
                    else: { required: ['destination'] },
                },
            ],
        },
    },

    // =================== DOCUMENT SECTIONS & NUMBERING ===================
    {
        name: 'get_document_sections',
        description: 'Get all sections in the document',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'create_document_section',
        description: 'Create a new section in the document',
        inputSchema: {
            type: 'object',
            properties: {
                startPage: { type: 'number', description: 'Page to start section on' },
                sectionPrefix: { type: 'string', description: 'Section prefix' },
                startNumber: { type: 'number', description: 'Starting page number', default: 1 },
                numberingStyle: { type: 'string', enum: ['ARABIC', 'ROMAN_UPPER', 'ROMAN_LOWER', 'LETTER_UPPER', 'LETTER_LOWER'], description: 'Numbering style', default: 'ARABIC' },
            },
            required: ['startPage'],
        },
    },

    // =================== DOCUMENT XML & STRUCTURE ===================
    {
        name: 'get_document_xml_structure',
        description: 'Get XML structure of the document',
        inputSchema: {
            type: 'object',
            properties: {
                includeTags: { type: 'boolean', description: 'Include XML tags', default: true },
                includeElements: { type: 'boolean', description: 'Include XML elements', default: true },
            },
        },
    },
    {
        name: 'export_document_xml',
        description: 'Export document as XML',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: 'Path to save XML file' },
                includeImages: { type: 'boolean', description: 'Include images in export', default: true },
                includeStyles: { type: 'boolean', description: 'Preserve existing XML style/tag mappings; false is refused because Adobe provides no safe toggle to strip them', default: true },
            },
            required: ['filePath'],
        },
    },

    // =================== DOCUMENT CLOUD & COLLABORATION ===================
    {
        name: 'save_document_to_cloud',
        description: 'Save document to Adobe Creative Cloud',
        inputSchema: {
            type: 'object',
            properties: {
                cloudName: { type: 'string', description: 'Name for the cloud document' },
                includeAssets: { type: 'boolean', description: 'Verify every linked asset before the Creative Cloud save', default: true },
            },
            required: ['cloudName'],
        },
    },
    {
        name: 'open_cloud_document',
        description: 'Open a document from Adobe Creative Cloud',
        inputSchema: {
            type: 'object',
            properties: {
                cloudDocumentId: { type: 'string', description: 'Cloud document ID' },
            },
            required: ['cloudDocumentId'],
        },
    },

    // =================== DOCUMENT GRID & LAYOUT ===================
    {
        name: 'get_document_grid_settings',
        description: 'Get comprehensive grid settings for the document',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'set_document_grid_settings',
        description: 'Set comprehensive grid settings for the document',
        inputSchema: {
            type: 'object',
            properties: {
                documentGrid: { type: 'boolean', description: 'Enable/disable document grid' },
                documentGridColor: { type: 'string', description: 'Document grid color' },
                documentGridIncrement: { type: 'string', description: 'Document grid increment (e.g., "12pt")' },
                documentGridSubdivision: { type: 'number', description: 'Document grid subdivision' },
                baselineGrid: { type: 'boolean', description: 'Enable/disable baseline grid' },
                baselineGridColor: { type: 'string', description: 'Baseline grid color' },
                baselineGridIncrement: { type: 'string', description: 'Baseline grid increment (e.g., "12pt")' },
                baselineGridOffset: { type: 'string', description: 'Baseline grid offset (e.g., "0pt")' },
                baselineGridViewThreshold: { type: 'number', description: 'Baseline grid view threshold' },
                gridViewThreshold: { type: 'number', description: 'Grid view threshold' },
                gridAlignment: { type: 'string', enum: ['ALIGN_TO_GRID', 'ALIGN_TO_BASELINE_GRID', 'ALIGN_TO_DOCUMENT_GRID'], description: 'Grid alignment option' },
            },
        },
    },
    {
        name: 'get_document_layout_preferences',
        description: 'Get layout preferences and settings for the document',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'set_document_layout_preferences',
        description: 'Set layout preferences for the document',
        inputSchema: {
            type: 'object',
            properties: {
                adjustLayout: { type: 'boolean', description: 'Enable/disable adjust layout' },
                adjustLayoutMargins: { type: 'boolean', description: 'Enable/disable adjust layout margins' },
                adjustLayoutPageBreaks: { type: 'boolean', description: 'Enable/disable adjust layout page breaks' },
                adjustLayoutRules: { type: 'string', description: 'Adjust layout rules' },
                alignDistributeBounds: { type: 'string', enum: ['ALIGN_TO_SELECTION', 'ALIGN_TO_MARGINS', 'ALIGN_TO_PAGE'], description: 'Align distribute bounds' },
                alignDistributeSpacing: { type: 'string', enum: ['DISTRIBUTE_SPACE_BETWEEN', 'DISTRIBUTE_SPACE_AROUND'], description: 'Align distribute spacing' },
                smartGuidePreferences: { type: 'boolean', description: 'Enable/disable smart guide preferences' },
            },
        },
    },

    // =================== DOCUMENT VALIDATION & CLEANUP ===================
    {
        name: 'validate_document',
        description: 'Validate document structure and content',
        inputSchema: {
            type: 'object',
            properties: {
                checkLinks: { type: 'boolean', description: 'Check for broken links', default: true },
                checkFonts: { type: 'boolean', description: 'Check for missing fonts', default: true },
                checkImages: { type: 'boolean', description: 'Check for missing images', default: true },
                checkStyles: { type: 'boolean', description: 'Check for unused styles', default: false },
            },
        },
    },
    {
        name: 'cleanup_document',
        description: 'Clean up document (remove unused elements)',
        inputSchema: {
            type: 'object',
            properties: {
                removeUnusedStyles: { type: 'boolean', description: 'Requested unused-style deletion; currently refused without modifying the document because Adobe exposes no reliable unused-style inventory', default: false },
                removeUnusedColors: { type: 'boolean', description: 'Remove unused colors', default: false },
                removeUnusedLayers: { type: 'boolean', description: 'Remove unused layers', default: false },
                removeHiddenElements: { type: 'boolean', description: 'Remove hidden elements', default: false },
            },
        },
    },
];
