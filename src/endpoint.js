export function validateEndpoint(value) {
  const url = new URL(value);
  const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((!localHttp && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
    throw new Error('Endpoint harus HTTPS, atau HTTP khusus localhost/127.0.0.1/::1, tanpa credential/query/fragment.');
  }
  return url.href;
}
