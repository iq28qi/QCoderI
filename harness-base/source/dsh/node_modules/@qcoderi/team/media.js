import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { attributionHeaders, isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { installMediaLibrary } from './media-library.js';
import { createMediaOptions } from './media-options.js';

export const name = 'qcoderi-niceai-video';
export const inject = ['llm', 'settings', 'credentials'];
export const isVideoModel = model => /^(?:seedance|kling)(?:[-/]|$)/i.test(model);

export function niceAiBase(profile) {
  try {
    const url = new URL(profile?.baseURL);
    if (url.protocol !== 'https:' || url.hostname !== 'api.niceai.rest' || url.username || url.password || url.search || url.hash) return;
    return url.href.replace(/\/$/, '');
  } catch { return; }
}

export function safeUrls(values) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, 4).flatMap(value => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password ? [url.href.replaceAll('<', '%3C').replaceAll('>', '%3E')] : [];
    } catch { return []; }
  });
}

export function createJournal(directory) {
  return {
    async read(key) {
      try { return JSON.parse(await readFile(join(directory, key + '.json'), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
    },
    async write(key, value) {
      await mkdir(directory, { recursive: true });
      const target = join(directory, key + '.json');
      const temporary = target + '.' + randomUUID() + '.tmp';
      await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
      await rename(temporary, target);
    },
  };
}

// NiceAI documents text and video as separate APIs. Video requests never enter
// the pi-ai chat transport. Only a user-owned AgentLoop turn may create a job.
export function createVideoRouting(ctx, {
  fetchImpl = globalThis.fetch, wait = delay, pollMs = 10000, timeoutMs = 900000,
  journal = createJournal(dshHomePath('media-jobs')), seconds, mediaOptions=createMediaOptions(),
} = {}) {
  const catalogs = new Map();
  const active = new Set();
  async function requestOnce(url, key, signal, body) {
    const response = await fetchImpl(url, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { ...attributionHeaders(), Accept:'application/json', Authorization:'Bearer ' + key, ...(body === undefined ? {} : {'Content-Type':'application/json'}) },
      ...(body === undefined ? {} : { body:JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    });
    let data;
    try { data = await response.json(); } catch { throw Error(`NiceAI вернул некорректный ответ (HTTP ${response.status}).`); }
    if (!response.ok) {
      const detail = String(data.error?.message ?? data.message ?? response.statusText).replaceAll(key, '[ключ скрыт]').slice(0, 800);
      const error = Error(`NiceAI: ${detail} (HTTP ${response.status}).`);
      error.definiteRejection = response.status >= 400 && response.status < 500;
      error.httpStatus = response.status;
      throw error;
    }
    return data;
  }
  async function request(url, key, signal, body) {
    for (let attempt=0;;attempt++) {
      try { return await requestOnce(url,key,signal,body); }
      catch(error) {
        // Only status/catalog reads are retryable. A POST may already be paid.
        if(body!==undefined || signal.aborted || attempt>=3 || (error.definiteRejection && ![408,429].includes(error.httpStatus)))throw error;
        await wait(Math.min(2000 * 2**attempt,10000),undefined,{signal});
      }
    }
  }
  async function catalog(base, key, signal) {
    const cacheKey = base + ':' + createHash('sha256').update(key).digest('hex');
    const cached = catalogs.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.ids;
    const response = await request(base + '/videos/models', key, signal);
    if (!Array.isArray(response.data)) throw Error('NiceAI вернул некорректный каталог видеомоделей.');
    const ids = response.data.map(model => model.id).filter(id => typeof id === 'string');
    catalogs.set(cacheKey, { ids, expires:Date.now() + 60000 });
    return ids;
  }

  async function* generate(options, profile, base) {
    let record, recordKey, ownsLock = false;
    const signal = options.signal ?? new AbortController().signal;
    try {
      if (!isAgentLoopRequest(options)) throw Error('Видеомодель предназначена для генерации видео в диалоге, а не для служебных текстовых запросов.');
      const message = options.messages.findLast(item => item.role === 'user' && item.source?.kind === 'user');
      if (!message || !options.sessionId) throw Error('Для генерации видео нужен запрос пользователя в диалоге.');
      if (message.content.some(block => block.type !== 'text')) throw Error('Сейчас генерация NiceAI принимает текстовое описание. Убери вложения и опиши видео текстом.');
      const prompt = message.content.map(block => block.text).join('\n').trim();
      if (!prompt) throw Error('Напиши описание видео.');
      const duration=seconds??(await mediaOptions.get({sessionId:String(options.sessionId)})).seconds;
      const resolved = await ctx.credentials.resolve(profile.apiKeyEnv);
      const key = resolved?.value;
      if (!key) throw Error('Добавь API-ключ NiceAI в настройках провайдера.');
      const available = await catalog(base, key, signal);
      if (!available.includes(options.model)) throw Error(`Видеомодель «${options.model}» недоступна у NiceAI. Доступны: ${available.join(', ') || 'нет моделей'}.`);
      recordKey = createHash('sha256').update(JSON.stringify([String(options.sessionId), message.id, options.provider, options.model, base])).digest('hex');
      if (active.has(recordKey)) throw Error('Этот запрос видео уже выполняется. Дождись результата.');
      active.add(recordKey);
      ownsLock = true;
      record = await journal.read(recordKey);
      if (record?.state === 'submitting') throw Error('Результат отправки предыдущего запроса неизвестен. Чтобы не списать оплату повторно, новая генерация не запущена. Проверь задачу в NiceAI.');
      if (record?.state === 'rejected' || record?.state === 'failed') throw Error(record.error ?? 'Предыдущая задача NiceAI завершилась ошибкой. Для нового запуска отправь новое описание.');
      yield { type:'text-delta', index:0, text:`Генерирую видео · ${record?.seconds ?? duration} с.\n` };
      if (!record?.id) {
        record = { state:'submitting', sessionId:String(options.sessionId), messageId:message.id, prompt, provider:options.provider, model:options.model, seconds:duration, createdAt:Date.now() };
        // Commit before POST. An ambiguous network failure must never trigger a
        // second paid creation when the model request is retried or resumed.
        await journal.write(recordKey, record);
        let created;
        try { created = await request(base + '/videos', key, signal, { model:options.model, prompt, seconds:duration }); }
        catch (error) {
          if (error.definiteRejection) await journal.write(recordKey, { ...record, state:'rejected', error:error.message });
          throw error;
        }
        if (typeof created.id !== 'string' || !created.id) throw Error('NiceAI принял запрос, но не вернул идентификатор задачи. Повторная отправка остановлена, чтобы избежать двойной оплаты.');
        record = { ...record, state:'created', id:created.id };
        await journal.write(recordKey, record);
      }
      let result = record.state === 'completed' ? record : await request(base + '/videos/' + encodeURIComponent(record.id), key, signal);
      const deadline = Date.now() + timeoutMs;
      let lastStatus, lastProgress;
      while (result.status !== 'completed' && result.status !== 'failed' && result.state !== 'completed') {
        if (!['queued', 'in_progress'].includes(result.status)) throw Error(`NiceAI вернул неизвестный статус задачи: ${String(result.status)}. Задача ${record.id} сохранена; повторная генерация не запускается.`);
        const progress=typeof result.progress==='number'?Math.max(0,Math.min(99,Math.round(result.progress))):undefined;
        record={...record,status:result.status,progress,updatedAt:Date.now()};
        await journal.write(recordKey,record);
        if (result.status !== lastStatus || progress!==lastProgress) {
          lastStatus = result.status;
          lastProgress=progress;
          yield { type:'text-delta', index:0, text:(result.status === 'queued' ? 'В очереди NiceAI…' : 'Создаётся видео…')+(progress===undefined?'':` ${progress}%`)+'\n' };
        }
        if (Date.now() >= deadline) throw Error(`Время ожидания истекло. Задача NiceAI ${record.id} сохранена и может продолжать выполняться. Повтор этого же запроса возобновит проверку статуса.`);
        await wait(pollMs, undefined, { signal });
        result = await request(base + '/videos/' + encodeURIComponent(record.id), key, signal);
      }
      if (result.status === 'failed') {
        const error = `Генерация NiceAI завершилась ошибкой: ${String(result.error?.message ?? result.error ?? 'без подробностей').replaceAll(key, '[ключ скрыт]').slice(0, 800)}`;
        await journal.write(recordKey, { ...record, state:'failed', error });
        throw Error(error);
      }
      const urls = safeUrls(result.urls);
      if (!urls.length) throw Error(`NiceAI завершил задачу ${record.id}, но не вернул ссылку на видео.`);
      await journal.write(recordKey, { ...record, state:'completed', status:'completed', progress:100, updatedAt:Date.now(), urls });
      yield { type:'text-delta', index:0, text:'\nВидео готово.\n\n' + urls.map((url, i) => `[Открыть видео${i ? ' ' + (i + 1) : ''}](<${url}>)`).join('\n\n') };
      yield { type:'finish', reason:{kind:'stop'} };
    } catch (error) {
      yield { type:'finish', reason:{kind:signal.aborted ? 'aborted' : 'error', failure:{code:signal.aborted ? 'ABORTED' : 'NICEAI_VIDEO_ERROR', message:signal.aborted ? 'Ожидание видео остановлено. Созданная задача может продолжать выполняться в NiceAI.' : error.message ?? String(error)}} };
    } finally { if (ownsLock) active.delete(recordKey); }
  }

  return (options, next) => {
    const profile = ctx.settings.get('llm-pi-ai')?.providers?.[options.provider];
    const base = niceAiBase(profile);
    return base && isVideoModel(options.model) ? generate(options, profile, base) : next();
  };
}

export function apply(ctx) {
  ctx.on('llm/stream', createVideoRouting(ctx));
  installMediaLibrary(ctx);
}
