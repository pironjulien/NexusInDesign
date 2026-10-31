@@AUDIT_FUNCTIONS@@
  const openPaths = [];
  let pathsReadable = true;
  for (let index = 0; index < app.documents.length; index += 1) {
    const doc = app.documents.item(index);
    try {
      const nativePath = await auditNativePath(doc);
      if (!nativePath) pathsReadable = false;
      else openPaths.push(String(nativePath));
    } catch (_) { pathsReadable = false; }
  }
  await __writeResult({ ok: true, pathsReadable, openPaths, operationId: __operationId });
