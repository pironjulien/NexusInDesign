const file = (field, access, extensions, kind = 'file', mustNotExist = false) => ({ field, access, extensions, kind, mustNotExist });
const assets = ['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.psd', '.ai', '.pdf', '.svg', '.eps', '.indd', '.idml', '.txt', '.rtf', '.doc', '.docx', '.xlsx', '.csv', '.xml'];

export const LEGACY_PATH_RULES = Object.freeze({
  create_book: [file('filePath', 'write', ['.indb'], 'file', true)],
  open_book: [file('filePath', 'read', ['.indb'])],
  add_document_to_book: [file('bookPath', 'write', ['.indb']), file('documentPath', 'read', ['.indd', '.idml'])],
  synchronize_book: [file('bookPath', 'write', ['.indb'])],
  repaginate_book: [file('bookPath', 'write', ['.indb'])],
  update_all_cross_references: [file('bookPath', 'write', ['.indb'])],
  update_all_numbers: [file('bookPath', 'write', ['.indb'])],
  update_chapter_and_paragraph_numbers: [file('bookPath', 'write', ['.indb'])],
  export_book: [file('bookPath', 'read', ['.indb']), file('outputPath', 'write', ['.pdf', '.epub'], 'file', true)],
  package_book: [file('bookPath', 'read', ['.indb']), file('outputPath', 'write', undefined, 'directory', true)],
  preflight_book: [file('bookPath', 'read', ['.indb']), file('outputPath', 'write', ['.txt', '.json', '.xml'], 'file', true)],
  print_book: [file('bookPath', 'read', ['.indb'])],
  get_book_info: [file('bookPath', 'read', ['.indb'])],
  set_book_properties: [file('bookPath', 'write', ['.indb'])],
  place_image: [file('filePath', 'read', assets)],
  open_document: [file('filePath', 'read', ['.indd', '.idml'])],
  save_document: [file('filePath', 'write', ['.indd'])],
  data_merge: [file('dataSource', 'read', ['.csv', '.txt'])],
  export_document_xml: [file('filePath', 'write', ['.xml'], 'file', true)],
  export_images: [file('outputPath', 'write', undefined, 'directory', true)],
  export_epub: [file('filePath', 'write', ['.epub'], 'file', true)],
  place_file_on_page: [file('filePath', 'read', assets)],
  place_file_on_spread: [file('filePath', 'read', assets)],
});
