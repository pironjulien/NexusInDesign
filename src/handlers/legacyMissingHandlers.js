import { ScriptExecutor } from '../core/scriptExecutor.js';

const value = (input) => JSON.stringify(input);

export async function handleLegacyMissing(name, args) {
  const snippets = {
    list_spreads: `if(!app.documents.length)return {success:false,error:'No document open'};const d=targetDocument;return {success:true,spreads:Array.from({length:d.spreads.length},(_,i)=>{const s=d.spreads.item(i);return {index:i,id:String(s.id),name:s.name,pages:s.pages.length};})};`,
    get_spread_info: `const s=targetDocument.spreads.item(${value(args.spreadIndex)});return {success:true,index:${value(args.spreadIndex)},id:String(s.id),name:s.name,pages:s.pages.length,pageItems:s.pageItems.length};`,
    duplicate_spread: `const {LocationOptions}=require('indesign'),d=targetDocument,s=d.spreads.item(${value(args.spreadIndex)}),m={AT_END:LocationOptions.atEnd,AT_BEGINNING:LocationOptions.atBeginning,BEFORE:LocationOptions.before,AFTER:LocationOptions.after},loc=m[${value(args.position ?? 'AT_END')}],ref=${args.referenceSpreadIndex === undefined ? 'undefined' : `d.spreads.item(${value(args.referenceSpreadIndex)})`},n=s.duplicate(loc,ref);return {success:true,id:Number(n.id),index:n.index};`,
    move_spread: `const {LocationOptions}=require('indesign'),d=targetDocument,s=d.spreads.item(${value(args.spreadIndex)}),m={AT_END:LocationOptions.atEnd,AT_BEGINNING:LocationOptions.atBeginning,BEFORE:LocationOptions.before,AFTER:LocationOptions.after},loc=m[${value(args.position ?? 'AT_END')}],ref=${args.referenceSpreadIndex === undefined ? 'undefined' : `d.spreads.item(${value(args.referenceSpreadIndex)})`};s.move(loc,ref);return {success:true,index:s.index};`,
    delete_spread: `const s=targetDocument.spreads.item(${value(args.spreadIndex)});s.remove();return {success:true};`,
    set_spread_properties: `const s=targetDocument.spreads.item(${value(args.spreadIndex)});const p=${value(args)};for(const k of ['name','allowPageShuffle','showMasterItems','spreadHidden','pageTransitionType','pageTransitionDirection','pageTransitionDuration'])if(p[k]!==undefined)s[k]=p[k];return {success:true,id:String(s.id)};`,
    create_spread_guides: `
      const {UIColors}=require('indesign'),d=targetDocument,s=d.spreads.item(${value(args.spreadIndex)});
      const rawColor=${value(args.guideColor ?? 'BLUE')},colorName=String(rawColor).trim().toUpperCase().replace(/[ -]+/g,'_');
      let guideColor=UIColors[colorName];
      if(guideColor===undefined){
        const rgb=String(rawColor).split(',').map((entry)=>Number(entry.trim()));
        if(rgb.length!==3||rgb.some((entry)=>!Number.isFinite(entry)||entry<0||entry>255))return {success:false,error:'Unsupported guide color'};
        guideColor=rgb;
      }
      const layer=${args.layerName === undefined ? 'undefined' : `d.layers.itemByName(${value(args.layerName)})`};
      if(layer&&layer.isValid===false)return {success:false,error:'Destination layer not found'};
      s.createGuides(
        ${Number(args.numberOfRows ?? 0)},
        ${Number(args.numberOfColumns ?? 0)},
        ${value(`${Number(args.rowGutter ?? 5)}mm`)},
        ${value(`${Number(args.columnGutter ?? 5)}mm`)},
        guideColor,
        ${Boolean(args.fitMargins ?? true)},
        ${Boolean(args.removeExisting ?? false)},
        layer
      );
      return {success:true};
    `,
    place_file_on_spread: `
      const d=targetDocument,s=d.spreads.item(${value(args.spreadIndex)});
      const layer=${args.layerName === undefined ? 'undefined' : `d.layers.itemByName(${value(args.layerName)})`};
      if(layer&&layer.isValid===false)return {success:false,error:'Destination layer not found'};
      const placed=await s.place(
        ${value(args.filePath)},
        [${value(`${Number(args.x ?? 10)}mm`)},${value(`${Number(args.y ?? 10)}mm`)}],
        layer,
        ${Boolean(args.showingOptions ?? false)},
        ${Boolean(args.autoflowing ?? false)}
      );
      const items=Array.isArray(placed)?placed:(placed?[placed]:[]);
      return {success:true,count:items.length,itemIds:items.map((item)=>String(item.id))};
    `,
    place_xml_on_spread: `
      const d=targetDocument,s=d.spreads.item(${value(args.spreadIndex)}),e=d.xmlElements.itemByName(${value(args.xmlElementName)});
      if(!e||e.isValid===false)return {success:false,error:'XML element not found'};
      const placed=await s.placeXML(
        e,
        [${value(`${Number(args.x ?? 10)}mm`)},${value(`${Number(args.y ?? 10)}mm`)}],
        ${Boolean(args.autoflowing ?? false)}
      );
      return {success:true,itemId:placed?String(placed.id):undefined};
    `,
    select_spread: `const d=targetDocument,w=d.layoutWindows&&d.layoutWindows.length>0?d.layoutWindows.item(0):null,s=d.spreads.item(${value(args.spreadIndex)});if(!w||w.isValid===false)return {success:false,error:'No layout window available for the requested document'};w.activeSpread=s;return {success:true,id:String(s.id)};`,
    get_spread_content_summary: `const s=targetDocument.spreads.item(${value(args.spreadIndex)});return {success:true,pages:s.pages.length,pageItems:s.pageItems.length,textFrames:s.textFrames.length,rectangles:s.rectangles.length,ovals:s.ovals.length,polygons:s.polygons.length};`,
    create_layer: `const d=targetDocument,p=${value(args)},l=d.layers.add({name:p.name,visible:p.visible??true,locked:p.locked??false});return {success:true,id:String(l.id),name:l.name};`,
    set_active_layer: `const d=targetDocument,l=d.layers.itemByName(${value(args.layerName)});d.activeLayer=l;return {success:true,id:String(l.id),name:l.name};`,
    list_layers: `const d=targetDocument;return {success:true,layers:Array.from({length:d.layers.length},(_,i)=>{const l=d.layers.item(i);return {id:String(l.id),name:l.name,visible:l.visible,locked:l.locked,printable:l.printable};})};`,
    detach_master_items: `
      const p=targetDocument.pages.item(${value(args.pageIndex)}),source=p.masterPageItems||[],requestedIndex=${args.itemIndex === undefined ? 'undefined' : Number(args.itemIndex)};
      const count=Number(source.length||0);
      if(requestedIndex!==undefined&&(requestedIndex<0||requestedIndex>=count))return {success:false,error:'Master item index out of range'};
      const originals=[];
      for(let i=0;i<count;i++){
        if(requestedIndex===undefined||i===requestedIndex)originals.push(source[i]??source.item(i));
      }
      const itemIds=[];
      for(const original of originals){
        const overridden=original.override(p),created=Array.isArray(overridden)?overridden:[overridden];
        for(const item of created){
          if(!item||typeof item.detach!=='function')throw new Error('Adobe did not return a detachable master item override');
          const id=String(item.id);
          item.detach();
          itemIds.push(id);
        }
      }
      return {success:true,itemIds,count:itemIds.length};
    `,
    remove_master_override: `const p=targetDocument.pages.item(${value(args.pageIndex)}),item=p.pageItems.item(${value(args.itemIndex)});item.removeOverride();return {success:true};`,
    export_epub: `
      const {ExportFormat}=require('indesign'),d=targetDocument;
      if(${args.includeImages === false})return {success:false,error:'Adobe exposes no reliable option to omit every image from EPUB export'};
      const preferences=d.epubExportPreferences;
      if(!preferences||preferences.isValid===false)return {success:false,error:'EPUB export preferences unavailable'};
      const previousGenerateCascadeStyleSheet=preferences.generateCascadeStyleSheet;
      try{
        preferences.generateCascadeStyleSheet=${args.includeStyles !== false};
        await d.exportFile(ExportFormat.EPUB,${value(args.filePath)},false);
        return {success:true,path:${value(args.filePath)}};
      }finally{
        preferences.generateCascadeStyleSheet=previousGenerateCascadeStyleSheet;
      }
    `,
  };
  const code = snippets[name];
  if (!code) return undefined;
  return ScriptExecutor.executeViaUXP(code);
}

export const LEGACY_MISSING_NAMES = new Set([
  'list_spreads', 'get_spread_info', 'duplicate_spread', 'move_spread', 'delete_spread', 'set_spread_properties',
  'create_spread_guides', 'place_file_on_spread', 'place_xml_on_spread', 'select_spread', 'get_spread_content_summary',
  'create_layer', 'set_active_layer', 'list_layers', 'detach_master_items', 'remove_master_override', 'export_epub',
]);
