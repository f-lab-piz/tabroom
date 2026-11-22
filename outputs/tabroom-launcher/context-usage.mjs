// App Server의 누적값(total) 대신 최근 모델 호출(last)의 컨텍스트만 표시한다.
export function contextUsage(usage,estimate) {
  const valid = value => Number.isSafeInteger(value) && value >= 0;
  const last = usage?.last;
  if (!valid(last?.totalTokens)) return null;
  const window = valid(usage.modelContextWindow) && usage.modelContextWindow > 0 ? usage.modelContextWindow : null;
  return {
    used:last.totalTokens,window,
    input:valid(last.inputTokens) ? last.inputTokens : null,
    cached:valid(last.cachedInputTokens) ? last.cachedInputTokens : null,
    output:valid(last.outputTokens) ? last.outputTokens : null,
    reasoning:valid(last.reasoningOutputTokens) ? last.reasoningOutputTokens : null,
    estimate:estimate ? Object.fromEntries(Object.entries(estimate).map(([key,bytes])=>[key,Math.ceil(bytes/4)])) : null,
  };
}

export function trackText(session,key,text) {
  if (session.contextText && typeof text === 'string') session.contextText[key] += Buffer.byteLength(text);
}
