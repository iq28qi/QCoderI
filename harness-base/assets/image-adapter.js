// QCODERI_IMAGE_ADAPTER_BEGIN
let qcImageCatalogIndex;
function qcCatalogInput(id) {
  if(!qcImageCatalogIndex) {
    qcImageCatalogIndex=new Map();
    const preferred=['openai','anthropic','moonshotai','google','deepseek','zai'];
    for(const provider of [...new Set([...preferred,...getBuiltinProviders()])]) {
      for(const model of getBuiltinModels(provider)) {
        const key=qcImageModelKey(model.id);
        if(!qcImageCatalogIndex.has(key))qcImageCatalogIndex.set(key,model.input);
      }
    }
  }
  return qcImageCatalogIndex.get(qcImageModelKey(id));
}
// QCODERI_IMAGE_ADAPTER_END
