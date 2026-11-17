	async detectReasoning(snapshot, provider) {
		const profile=this.profileOf(snapshot,provider);
		const models=snapshot.models.getModels(provider);
		let apiKey;
		try {apiKey=await this.config.resolveApiKey(provider,profile);} catch {return snapshot;}
		const groups=new Map();
		for(const model of models)groups.set(JSON.stringify([model.api,model.baseUrl]),model);
		const catalogs=new Map(await Promise.all([...groups].map(async([key,model])=>[key,await qcDiscoverReasoning(model,apiKey,profile.headers)])));
		const detectedModels=new Map();
		for(const model of models) {
			const rows=catalogs.get(JSON.stringify([model.api,model.baseUrl])) ?? [];
			const detected=qcReasoningFromMetadata(model,rows,qcCatalogReasoning);
			const input=profile.configuredInput.has(model.id) ? model.input : qcImageInputFromMetadata(model,rows,qcCatalogInput) ?? model.input;
			const upstreamModel=qcUpstreamModel(model.id,rows);
			detectedModels.set(`${provider}\0${model.id}`,{...model,input,upstreamModel,...detected.reasoningEfforts === undefined ? {} : {...resolveModelReasoning(provider,{id:model.id,reasoningEfforts:detected.reasoningEfforts},model),compat:{...model.compat,...detected.compat}}});
		}
		return {...snapshot,detectedModels};
	}
