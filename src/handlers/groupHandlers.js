/**
 * Group management handlers
 */
import { ScriptExecutor } from '../core/scriptExecutor.js';
import { formatResponse, formatErrorResponse } from '../utils/stringUtils.js';

export class GroupHandlers {
    /**
     * Create a group from selected items
     */
    static async createGroup(args) {
        const { pageIndex } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            const layoutWindow = doc.layoutWindows && doc.layoutWindows.length > 0
                ? doc.layoutWindows.item(0)
                : null;
            if (!layoutWindow || layoutWindow.isValid === false) return { success: false, error: 'No layout window available for the requested document' };
            const selection = Array.from(layoutWindow.selection || []);
            if (!selection || selection.length < 2) return { success: false, error: 'Select at least 2 items to create a group' };
            const selectedIds = new Set();
            for (const item of selection) {
                if (!item || item.isValid === false || item.parentPage?.id !== page.id) return { success: false, error: 'Every selected item must belong to the requested page' };
                if (item.locked === true) return { success: false, error: 'A locked item cannot be grouped' };
                if (typeof item.parent?.ungroup === 'function') return { success: false, error: 'Nested items must be ungrouped explicitly before regrouping' };
                if (selectedIds.has(item.id)) return { success: false, error: 'The selection contains the same item more than once' };
                selectedIds.add(item.id);
            }
            let group;
            try { group = page.groups.add(selection); }
            catch(e) { return { success: false, error: 'Failed to create group: ' + e.message }; }
            if (!group || group.isValid === false || group.pageItems.length !== selection.length) return { success: false, error: 'InDesign did not create the expected group' };
            let itemCount = 0;
            try { itemCount = group.pageItems.length; } catch(e) {}
            return { success: true, id: group.id, itemCount };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Create Group")
            : formatErrorResponse(result?.error || 'Failed to create group', "Create Group");
    }

    /**
     * Create a group from specific page items
     */
    static async createGroupFromItems(args) {
        const { pageIndex, itemIndices } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            const indices = ${JSON.stringify(itemIndices)};
            if (indices.length < 2) return { success: false, error: 'Need at least 2 items to create a group' };
            const items = [];
            const itemIds = new Set();
            for (let i = 0; i < indices.length; i++) {
                if (!Number.isInteger(indices[i]) || indices[i] < 0 || indices[i] >= page.allPageItems.length) return { success: false, error: 'Page item index out of range' };
                const item = page.allPageItems[indices[i]];
                if (!item || item.isValid === false || item.parentPage?.id !== page.id) return { success: false, error: 'Page item is invalid or belongs to another page' };
                if (item.locked === true) return { success: false, error: 'A locked item cannot be grouped' };
                if (typeof item.parent?.ungroup === 'function') return { success: false, error: 'Nested items must be ungrouped explicitly before regrouping' };
                if (itemIds.has(item.id)) return { success: false, error: 'Item indices must be unique' };
                itemIds.add(item.id);
                items.push(item);
            }
            let group;
            try { group = page.groups.add(items); }
            catch(e) { return { success: false, error: 'Failed to create group: ' + e.message }; }
            if (!group || group.isValid === false || group.pageItems.length !== items.length) return { success: false, error: 'InDesign did not create the expected group' };
            let itemCount = 0;
            try { itemCount = group.pageItems.length; } catch(e) {}
            return { success: true, id: group.id, itemCount };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Create Group From Items")
            : formatErrorResponse(result?.error || 'Failed to create group from items', "Create Group From Items");
    }

    /**
     * Ungroup a group
     */
    static async ungroup(args) {
        const { pageIndex, groupIndex } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            if (${groupIndex} < 0 || ${groupIndex} >= page.groups.length) return { success: false, error: 'Group index out of range' };
            const item = page.groups.item(${groupIndex});
            if (!item || item.isValid === false || typeof item.ungroup !== 'function') return { success: false, error: 'Selected group is invalid' };
            if (item.locked === true) return { success: false, error: 'A locked group cannot be ungrouped' };
            const groupId = item.id;
            let itemCount = 0;
            try { itemCount = item.pageItems.length; } catch(e) {}
            try {
                item.ungroup();
            } catch(e) {
                return { success: false, error: 'Failed to ungroup: ' + e.message };
            }
            if (doc.groups.itemByID(groupId).isValid) return { success: false, error: 'InDesign kept the group after ungrouping' };
            return { success: true, groupId, releasedItemCount: itemCount };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Ungroup")
            : formatErrorResponse(result?.error || 'Failed to ungroup', "Ungroup");
    }

    /**
     * Get group information
     */
    static async getGroupInfo(args) {
        const { pageIndex, groupIndex } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            if (${groupIndex} < 0 || ${groupIndex} >= page.groups.length) return { success: false, error: 'Group index out of range' };
            const item = page.groups.item(${groupIndex});
            if (!item || item.isValid === false || typeof item.ungroup !== 'function') return { success: false, error: 'Selected group is invalid' };
            const contents = [];
            try {
                for (let i = 0; i < item.pageItems.length; i++) {
                    const groupItem = item.pageItems.item(i);
                    let type = 'Unknown';
                    try { type = groupItem.constructor?.name || 'Unknown'; } catch(e) {}
                    contents.push({ index: i, type, id: groupItem.id });
                }
            } catch(e) {}
            return {
                success: true,
                name: item.name || 'Unnamed',
                id: item.id,
                visible: item.visible,
                locked: item.locked,
                geometricBounds: item.geometricBounds,
                itemCount: contents.length,
                contents
            };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Get Group Info")
            : formatErrorResponse(result?.error || 'Failed to get group info', "Get Group Info");
    }

    /**
     * Add item to group
     */
    static async addItemToGroup(args) {
        const { pageIndex, groupIndex, itemIndex } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            if (${groupIndex} < 0 || ${groupIndex} >= page.groups.length) return { success: false, error: 'Group index out of range' };
            const group = page.groups.item(${groupIndex});
            if (!group || group.isValid === false || typeof group.ungroup !== 'function') return { success: false, error: 'Selected group is invalid' };
            if (group.locked === true) return { success: false, error: 'A locked group cannot receive an item' };
            if (typeof group.parent?.ungroup === 'function') return { success: false, error: 'Adding to a nested group is not supported safely' };
            if (${itemIndex} < 0 || ${itemIndex} >= page.allPageItems.length) return { success: false, error: 'Item index out of range' };
            const item = page.allPageItems[${itemIndex}];
            if (!item || item.isValid === false || item.id === group.id) return { success: false, error: 'Item is invalid or is the group itself' };
            if (item.locked === true) return { success: false, error: 'A locked item cannot be grouped' };
            if (typeof item.parent?.ungroup === 'function') return { success: false, error: 'The item already belongs to a group' };
            const sameContainer = item.parent === group.parent || (
                Number.isInteger(item.parent?.id) && item.parent.id === group.parent?.id && item.parent.constructor?.name === group.parent?.constructor?.name
            );
            if (!sameContainer) return { success: false, error: 'The item and group must share the same container' };
            for (let i = 0; i < group.allPageItems.length; i++) {
                if (group.allPageItems[i].id === item.id) return { success: false, error: 'The item already belongs to this group' };
            }
            const previousGroupId = group.id;
            const itemId = item.id;
            let combined;
            try {
                combined = page.groups.add([group, item]);
            } catch(e) {
                return { success: false, error: 'Failed to add item to group: ' + e.message };
            }
            if (!combined || combined.isValid === false || combined.pageItems.length !== 2) return { success: false, error: 'InDesign did not create the expected combined group' };
            const combinedIds = [combined.pageItems.item(0).id, combined.pageItems.item(1).id];
            if (!combinedIds.includes(previousGroupId) || !combinedIds.includes(itemId)) return { success: false, error: 'The combined group has unexpected members' };
            return { success: true, groupId: combined.id, previousGroupId, itemId, originalGroupPreservedAsSubgroup: true };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Add Item to Group")
            : formatErrorResponse(result?.error || 'Failed to add item to group', "Add Item to Group");
    }

    /**
     * Remove item from group
     */
    static async removeItemFromGroup(args) {
        const { pageIndex, groupIndex, itemIndex } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            if (${groupIndex} < 0 || ${groupIndex} >= page.groups.length) return { success: false, error: 'Group index out of range' };
            const group = page.groups.item(${groupIndex});
            if (!group || group.isValid === false || typeof group.ungroup !== 'function') return { success: false, error: 'Selected group is invalid' };
            if (group.locked === true) return { success: false, error: 'A locked group cannot release an item' };
            if (typeof group.parent?.ungroup === 'function') return { success: false, error: 'Removing from a nested group is not supported safely' };
            const groupItems = group.pageItems;
            if (${itemIndex} < 0 || ${itemIndex} >= groupItems.length) return { success: false, error: 'Item index out of range in group' };
            const item = groupItems.item(${itemIndex});
            if (!item || item.isValid === false || item.locked === true) return { success: false, error: 'The requested group item is invalid or locked' };
            const itemId = item.id;
            const groupId = group.id;
            const beforeCount = groupItems.length;
            if (beforeCount === 2) {
                try { group.ungroup(); }
                catch(e) { return { success: false, error: 'Failed to dissolve two-item group: ' + e.message }; }
                if (doc.groups.itemByID(groupId).isValid) return { success: false, error: 'InDesign kept the two-item group after ungrouping' };
                return { success: true, groupId: null, previousGroupId: groupId, removedItemId: itemId, groupDissolved: true };
            }
            if (beforeCount < 2) return { success: false, error: 'The group does not contain enough direct items' };
            const destination = group.parent;
            try { item.move(destination); }
            catch(e) { return { success: false, error: 'Failed to remove item from group: ' + e.message }; }
            if (!group.isValid || group.pageItems.length !== beforeCount - 1 || typeof item.parent?.ungroup === 'function') return { success: false, error: 'InDesign did not detach the requested item safely' };
            return { success: true, groupId, removedItemId: itemId, groupDissolved: false };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Remove Item from Group")
            : formatErrorResponse(result?.error || 'Failed to remove item from group', "Remove Item from Group");
    }

    /**
     * List all groups on a page
     */
    static async listGroups(args) {
        const { pageIndex } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            const groups = [];
            for (let i = 0; i < page.groups.length; i++) {
                const item = page.groups.item(i);
                let itemCount = 0;
                try { itemCount = item.pageItems.length; } catch(e) {}
                groups.push({
                    groupIndex: i,
                    name: item.name || 'Unnamed',
                    id: item.id,
                    visible: item.visible,
                    locked: item.locked,
                    itemCount,
                    geometricBounds: item.geometricBounds
                });
            }
            return { success: true, groups, count: groups.length };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "List Groups")
            : formatErrorResponse(result?.error || 'Failed to list groups', "List Groups");
    }

    /**
     * Set group properties
     */
    static async setGroupProperties(args) {
        const { pageIndex, groupIndex, visible, locked, name } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = targetDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            if (${groupIndex} < 0 || ${groupIndex} >= page.groups.length) return { success: false, error: 'Group index out of range' };
            const group = page.groups.item(${groupIndex});
            if (!group || group.isValid === false || typeof group.ungroup !== 'function') return { success: false, error: 'Selected group is invalid' };
            if (${JSON.stringify(name)} !== null && ${JSON.stringify(name)} !== undefined) group.name = ${JSON.stringify(name)};
            if (${visible} !== null && ${visible} !== undefined) group.visible = ${visible};
            if (${locked} !== null && ${locked} !== undefined) group.locked = ${locked};
            if (group.visible !== (${visible} ?? group.visible) || group.locked !== (${locked} ?? group.locked) || group.name !== (${JSON.stringify(name)} ?? group.name)) return { success: false, error: 'InDesign did not apply every group property' };
            return { success: true, id: group.id, name: group.name, visible: group.visible, locked: group.locked };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Set Group Properties")
            : formatErrorResponse(result?.error || 'Failed to set group properties', "Set Group Properties");
    }
}
