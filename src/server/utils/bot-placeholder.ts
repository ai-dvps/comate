export const ACKNOWLEDGMENT_POOL = [
  '好嘞，我先想想…',
  '收到，马上处理。',
  '来了，让我看看…',
  '稍等，正在响应中…',
  '已收到，正在为你处理…',
];

export function getRandomAcknowledgment(randomFn: () => number = Math.random): string {
  const index = Math.floor(randomFn() * ACKNOWLEDGMENT_POOL.length);
  return ACKNOWLEDGMENT_POOL[index];
}
