/**
 * Master Spread tool definitions for InDesign MCP Server
 * Master spread template management and functionality
 */

export const masterSpreadToolDefinitions = [
    // =================== MASTER SPREAD MANAGEMENT ===================
    {
        name: 'create_master_spread',
        description: 'Create a new master spread',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', minLength: 1, description: 'Base name used for the master spread when baseName is omitted' },
                baseName: { type: 'string', minLength: 1, description: 'Base name for the master spread' },
                namePrefix: { type: 'string', minLength: 1, description: 'Name prefix for the master spread' },
                pageColor: { type: 'string', description: 'Page color (RGB values as comma-separated string or UI color name)' },
                showMasterItems: { type: 'boolean', description: 'Show master items on document pages', default: true },
            },
            required: ['name'],
        },
    },
    {
        name: 'list_master_spreads',
        description: 'List all master spreads in the document',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'delete_master_spread',
        description: 'Delete a master spread',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', minLength: 1, description: 'Exact master spread name to delete' },
            },
            required: ['name'],
        },
    },
    {
        name: 'duplicate_master_spread',
        description: 'Duplicate a master spread',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', minLength: 1, description: 'Exact master spread name to duplicate' },
                newName: { type: 'string', minLength: 1, description: 'Base name for the duplicated master spread' },
                position: { type: 'string', enum: ['AT_END', 'AT_BEGINNING', 'BEFORE', 'AFTER'], default: 'AT_END' },
                referenceName: { type: 'string', minLength: 1, description: 'Exact reference master spread name; required for BEFORE or AFTER' },
            },
            required: ['name', 'newName'],
            allOf: [
                {
                    if: {
                        properties: { position: { enum: ['BEFORE', 'AFTER'] } },
                        required: ['position'],
                    },
                    then: { required: ['referenceName'] },
                },
            ],
        },
    },
    {
        name: 'apply_master_spread',
        description: 'Apply a master spread to pages',
        inputSchema: {
            type: 'object',
            properties: {
                masterName: { type: 'string', minLength: 1, description: 'Exact master spread name to apply' },
                pageRange: { type: 'string', description: 'Page range (e.g., "1-5", "all")', default: 'all' },
            },
            required: ['masterName'],
        },
    },
    {
        name: 'create_master_text_frame',
        description: 'Create a text frame on a master spread',
        inputSchema: {
            type: 'object',
            properties: {
                masterName: { type: 'string', minLength: 1, description: 'Exact master spread name' },
                content: { type: 'string', description: 'Text content for the frame' },
                x: { type: 'number', description: 'X position in mm', default: 10 },
                y: { type: 'number', description: 'Y position in mm', default: 10 },
                width: { type: 'number', exclusiveMinimum: 0, description: 'Width in mm', default: 100 },
                height: { type: 'number', exclusiveMinimum: 0, description: 'Height in mm', default: 50 },
                fontSize: { type: 'number', exclusiveMinimum: 0, description: 'Font size in points', default: 12 },
                fontFamily: { type: 'string', minLength: 1, description: 'Font family name', default: 'Arial' },
                fontStyle: { type: 'string', minLength: 1, description: 'Exact font style name', default: 'Regular' },
                textColor: { type: 'string', minLength: 1, description: 'Exact text color swatch name', default: 'Black' },
                alignment: { type: 'string', enum: ['LEFT_ALIGN', 'CENTER_ALIGN', 'RIGHT_ALIGN', 'JUSTIFY'], default: 'LEFT_ALIGN' },
                isPrimaryTextFrame: { type: 'boolean', description: 'Set as primary text frame', default: false },
            },
            required: ['masterName', 'content'],
        },
    },
    {
        name: 'create_master_rectangle',
        description: 'Create a rectangle on a master spread',
        inputSchema: {
            type: 'object',
            properties: {
                masterName: { type: 'string', minLength: 1, description: 'Exact master spread name' },
                x: { type: 'number', description: 'X position in mm' },
                y: { type: 'number', description: 'Y position in mm' },
                width: { type: 'number', exclusiveMinimum: 0, description: 'Width in mm' },
                height: { type: 'number', exclusiveMinimum: 0, description: 'Height in mm' },
                fillColor: { type: 'string', minLength: 1, description: 'Exact fill swatch name', default: 'None' },
                strokeColor: { type: 'string', minLength: 1, description: 'Exact stroke swatch name', default: 'Black' },
                strokeWidth: { type: 'number', minimum: 0, description: 'Stroke width in points', default: 1 },
                cornerRadius: { type: 'number', minimum: 0, description: 'Corner radius in mm', default: 0 },
            },
            required: ['masterName', 'x', 'y', 'width', 'height'],
        },
    },
    {
        name: 'create_master_guides',
        description: 'Create guides on a master spread',
        inputSchema: {
            type: 'object',
            properties: {
                masterName: { type: 'string', minLength: 1, description: 'Exact master spread name' },
                numberOfRows: { type: 'integer', minimum: 0, description: 'Number of rows', default: 0 },
                numberOfColumns: { type: 'integer', minimum: 0, description: 'Number of columns', default: 0 },
                rowGutter: { type: 'number', minimum: 0, description: 'Row gutter in mm', default: 5 },
                columnGutter: { type: 'number', minimum: 0, description: 'Column gutter in mm', default: 5 },
                guideColor: { type: 'string', description: 'Guide color (RGB values as comma-separated string or UI color name)', default: 'BLUE' },
                fitMargins: { type: 'boolean', description: 'Fit guides to margins', default: true },
                removeExisting: { type: 'boolean', description: 'Remove existing guides', default: false },
                layerName: { type: 'string', description: 'Layer name to create guides on' },
            },
            required: ['masterName'],
            anyOf: [
                { required: ['numberOfRows'], properties: { numberOfRows: { minimum: 1 } } },
                { required: ['numberOfColumns'], properties: { numberOfColumns: { minimum: 1 } } },
            ],
        },
    },
    {
        name: 'get_master_spread_info',
        description: 'Get detailed information about a master spread',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', minLength: 1, description: 'Exact master spread name' },
            },
            required: ['name'],
        },
    },
    {
        name: 'detach_master_items',
        description: 'Override then detach real master page items from a document page',
        inputSchema: {
            type: 'object',
            properties: {
                pageIndex: { type: 'integer', minimum: 0, description: 'Page index' },
                itemIndex: { type: 'integer', minimum: 0, description: 'Index in page.masterPageItems (optional, detaches all if omitted)' },
            },
            required: ['pageIndex'],
        },
    },
    {
        name: 'remove_master_override',
        description: 'Remove override from a master page item',
        inputSchema: {
            type: 'object',
            properties: {
                pageIndex: { type: 'number', description: 'Page index' },
                itemIndex: { type: 'number', description: 'Master item index to remove override from' },
            },
            required: ['pageIndex', 'itemIndex'],
        },
    },
];
