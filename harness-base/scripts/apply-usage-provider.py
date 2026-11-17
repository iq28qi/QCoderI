"""Bind native budget admission to one prepared real SDK wire contract.
Isolated archive only; fail on changed upstream anchors; no live deployment.
"""
from pathlib import Path
import argparse
import os

BASE=Path(__file__).resolve().parents[1]
MARKER='// QCODERI_PROVIDER_BUDGET_WIRE_V1'


def changed(source,old,new):
    if new in source:
        return source
    if source.count(old)!=1:
        raise RuntimeError('Provider budget anchor changed: '+old[:90])
    return source.replace(old,new,1)


def apply(archive):
    archive=Path(archive).resolve(strict=True)
    live=(BASE/'source').resolve()
    staged=os.environ.get('QCODERI_STAGED_ROOT')
    staged=bool(staged and Path(staged).resolve()==BASE.parent.resolve() and (BASE.parent/'staging-context.json').is_file())
    if (archive==live or live in archive.parents) and not staged:
        raise RuntimeError('Refusing live source: pass an isolated staged archive')
    llm=archive/'dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js'
    pi=archive/'dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'
    files={llm:llm.read_text(encoding='utf-8'),pi:pi.read_text(encoding='utf-8')}
    s=files[llm]
    if '// QCODERI_USAGE_BUDGET_BOUNDARY_V1' not in s:
        raise RuntimeError('Install final usage budget boundary before provider contract')
    s=changed(s,'\t\t\t\t\t\tdispatch: (options) => adapterCall.stream(options)','\t\t\t\t\t\tproviderBudgetCall: adapterCall.providerBudgetCall,\n\t\t\t\t\t\tdispatch: (options) => adapterCall.stream(options)')
    s=changed(s,'\t\t\t\tlet dispatch;','\t\t\t\tlet dispatch;\n\t\t\t\tlet providerBudgetCall;')
    s=changed(s,'\t\t\t\t\tdispatch = (options) => adapterCall.stream(options);','\t\t\t\t\tproviderBudgetCall = adapterCall.providerBudgetCall;\n\t\t\t\t\tdispatch = (options) => adapterCall.stream(options);')
    s=changed(s,'\t\t\t\t\tdispatch = prepared.dispatch;','\t\t\t\t\tproviderBudgetCall = prepared.providerBudgetCall;\n\t\t\t\t\tdispatch = prepared.dispatch;')
    s=changed(s,'Object.freeze({ llm: this, modelInfo })','Object.freeze({ llm: this, modelInfo, providerBudgetCall })')
    files[llm]=s
    s=files[pi]
    anchor='import { qcRecoverRequest } from "./qcoderi-request-recovery.js";'
    s=changed(s,anchor,anchor+'\n'+MARKER+'\nimport {createProviderBudgetCall} from "@qcoderi/team/usage-provider-contract";')
    old='''        return {
            model: this.modelInfo(snapshot, provider, model),
            stream: options => this.qcRecovery(options, snapshot)
        };'''
    new='''        const providerBudgetCall=createProviderBudgetCall(this.modelOf(snapshot,provider,model),this.profileOf(snapshot,provider));
        return {
            model: this.modelInfo(snapshot, provider, model),
            providerBudgetCall,
            stream: options => providerBudgetCall.armed ? this.streamWithSnapshot(options,snapshot,providerBudgetCall) : this.qcRecovery(options,snapshot)
        };'''
    s=changed(s,old,new)
    s=changed(s,'\tasync *streamWithSnapshot(options, snapshot) {','\tasync *streamWithSnapshot(options, snapshot, providerBudgetCall) {')
    old='''				const iterator = toStreamChunks(snapshot.models.streamSimple(model, context, {
					fetch: observeProviderFailures(info => { providerResponse = info; }),
					...profileOptions(profile, reasoning, apiKey),'''
    new='''				const observedFetch=observeProviderFailures(info => { providerResponse = info; });
				const budgetFetch=providerBudgetCall?.begin(options,observedFetch);
				const iterator = toStreamChunks(snapshot.models.streamSimple(model, context, {
					fetch: budgetFetch ?? observedFetch,
					...profileOptions(profile, reasoning, apiKey),
					...(budgetFetch ? {maxRetries:0,maxRetryDelayMs:0} : {}),'''
    s=changed(s,old,new);files[pi]=s
    contract=(BASE/'assets/team/usage-provider-contract.js').read_text(encoding='utf-8')
    target=archive/'dsh/node_modules/@qcoderi/team/usage-provider-contract.js'
    package=target.parent/'package.json'
    import json
    metadata=json.loads(package.read_text(encoding='utf-8'))
    metadata.setdefault('exports',{})['./usage-provider-contract']='./usage-provider-contract.js'
    files[target]=contract;files[package]=json.dumps(metadata,indent=2)+'\n'
    count=0
    for path,text in files.items():
        if not path.exists() or path.read_text(encoding='utf-8')!=text:
            path.parent.mkdir(parents=True,exist_ok=True)
            path.write_text(text,encoding='utf-8',newline='\n');count+=1
    print('Provider budget wire contract:',count,'changed files; isolated archive',archive)
    return count


if __name__=='__main__':
    cli=argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--archive',required=True,type=Path)
    apply(cli.parse_args().archive)
