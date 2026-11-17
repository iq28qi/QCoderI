/**
 * Normalize the task envelope before the existing pi-ai wire serializers.
 * The resolved model selects the API. Never infer the protocol from model names.
 */
export function adaptModelTask(options, model) {
  if (options.system !== undefined || typeof model.api !== 'string') return options;
  const leading = [];
  for (const message of options.messages) {
    if (message.role !== 'system' || message.content.some(block => block.type !== 'text')) break;
    leading.push(message);
  }
  if (leading.length < 2) return options;
  // The common serializer otherwise sends the second system message as user text.
  return {
    ...options,
    system: leading.map(message => message.content.map(block => block.text).join('\n')).join('\n\n'),
    messages: options.messages.slice(leading.length),
  };
}

export function terminalProviderRateLimit(failure, responseBody) {
  const message = failure?.message ?? '';
  if (failure?.code !== 'RATE_LIMIT' && failure?.status !== 429 && !/^429\b/.test(message)) return;
  // The SDK can prefix the JSON body with the HTTP status and unwrap "error".
  const body = responseBody === undefined ? responseError(message) : responseBody;
  const errors = [body, body?.error];
  const ipLimit = errors.some(error => error?.code === 'resale_multi_ip_detected');
  if (!ipLimit && !errors.some(error => error?.do_not_auto_retry === true)) return;

  const requestId = safeRequestId(failure.requestId ?? errors.find(error => typeof error?.request_id === 'string' && error.request_id.length)?.request_id);
  return {
    code: 'PROVIDER_NO_RETRY',
    status: 429,
    message: ipLimit
      ? 'Провайдер ограничил ключ из-за использования с нескольких IP-адресов. Проверьте другие клиенты с этим ключом и дождитесь снятия ограничения. Запрос не повторялся автоматически.'
      : 'Провайдер отклонил запрос (429) и запретил автоматический повтор. Проверьте ограничения подключения у провайдера.',
    ...(requestId ? {requestId} : {}),
  };
}

const POLICY_CODES = new Set(['content_policy', 'content_policy_violation', 'content_filter', 'content_filtered',
  'moderation_blocked', 'safety_violation', 'blocked_by_safety_settings']);
const POLICY_MESSAGE = /(?:content safety policy blocked (?:this|the) request|content policy blocked (?:this|the) request|safety filters? blocked (?:this|the) request|^(?:Provider finish_reason:|Response incomplete:) content_filter$)/i;

function responseError(message) {
  const start = message.indexOf('{');
  if (start < 0) return;
  try { return JSON.parse(message.slice(start, message.lastIndexOf('}') + 1)); }
  catch { return undefined; }
}

function policyCode(body) {
  for (const error of [body?.error, body]) {
    for (const value of [error?.code, error?.type]) {
      if (typeof value === 'string' && POLICY_CODES.has(value.toLowerCase())) return value.toLowerCase();
    }
  }
}

function safeRequestId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}

export function observeProviderFailures(onResponse) {
  return async (input, init) => {
    const response = await globalThis.fetch(input, init);
    const info = { status: response.status, requestId: safeRequestId(
      response.headers.get('x-request-id') ?? response.headers.get('request-id')) };
    if (![400, 403, 422, 429].includes(response.status) || !response.body) {
      onResponse(info);
      return response;
    }
    // Preserve the response body for the SDK and cap diagnostic reads.
    const reader = response.clone().body.getReader();
    try {
      const decoder = new TextDecoder();
      let size = 0;
      let text = '';
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16 * 1024) return response;
        text += decoder.decode(value, {stream: true});
      }
      const body = responseError(text + decoder.decode());
      info.requestId ??= safeRequestId(body?.error?.request_id ?? body?.request_id);
      const rateLimit = response.status === 429 ? terminalProviderRateLimit(info, body ?? null) : undefined;
      const code = policyCode(body);
      info.terminal = rateLimit ?? (code && response.status >= 400 && response.status < 500
        ? { code, message: code, status: info.status, requestId: info.requestId }
        : undefined);
    } catch {
      // Unrecognized error bodies retain the SDK's normal handling.
    } finally {
      void reader.cancel().catch(() => {});
      onResponse(info);
    }
    return response;
  };
}

export function providerPolicyFailure(failure, route) {
  const code = policyCode(responseError(failure.message ?? ''))
    ?? (POLICY_CODES.has(failure.code?.toLowerCase()) ? failure.code.toLowerCase() : undefined);
  const requestId = safeRequestId(failure.requestId);
  const status = failure.status ?? Number(/^([45]\d{2})\b/.exec(failure.message ?? '')?.[1]);
  const target = route ? ` (${route.provider} / ${route.model})` : '';
  const detail = [status >= 400 && status < 600 ? `HTTP ${status}` : '',
    code && code !== 'content_policy' ? code : '', requestId ? `ID запроса ${requestId}` : ''].filter(Boolean);
  return {
    code: 'CONTENT_POLICY',
    ...(status >= 400 && status < 600 ? { status } : {}),
    ...(requestId ? { requestId } : {}),
    message: `Провайдер остановил запрос по правилам содержания${target}${detail.length ? ` [${detail.join(', ')}]` : ''}. Файлы и история чата сохранены. По поводу ошибочной блокировки можно обратиться в поддержку провайдера с ID запроса.`,
  };
}

export function classifyTaskFailure(failure) {
  const code = failure?.code ?? '';
  const message = failure?.message ?? '';
  if (POLICY_CODES.has(code.toLowerCase()) || POLICY_MESSAGE.test(message)
      || policyCode(responseError(message))) {
    return 'provider_policy';
  }
  if (/\b(?:400|413)\b/.test(message) &&
      /failed to read request body|failed to buffer the request body|request body too large|payload too large/i.test(message)) {
    return 'request_size';
  }
  if (['AUTH','INVALID_CREDENTIAL','RATE_LIMIT','PROVIDER_NO_RETRY','QUOTA_EXCEEDED','INVALID_REQUEST','UNSUPPORTED_OPTION',
       'UNSUPPORTED_CONTENT','CONTEXT_WINDOW_EXCEEDED'].includes(code)) return 'api_limit';
  if (['TIMEOUT','TRANSPORT','SERVER'].includes(code)) return 'transport';
  return 'provider_error';
}
