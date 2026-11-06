let count = 0;
globalThis.fetch = async () => {
  count++;
  if (count > 1) throw new Error('Неочікуваний повторний запит');
  throw new TypeError('fetch failed', { cause: Object.assign(new Error('certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) });
};
