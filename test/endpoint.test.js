import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEndpoint } from '../src/endpoint.js';

test('HTTP is permitted only on loopback; public endpoints require HTTPS', () => {
  for (const url of ['http://127.0.0.1:5062/api/egg-counter-ai/sessions',
    'http://localhost:5062/api/egg-counter-ai/sessions', 'http://[::1]:5062/api/egg-counter-ai/sessions',
    'https://example.com/api/egg-counter-ai/sessions']) assert.equal(validateEndpoint(url), url);
  for (const url of ['http://93.127.214.77:5062/api', 'http://192.168.10.47/api',
    'http://localhost.example.com/api', 'http://127.0.0.1@example.com/api', 'ftp://localhost/api',
    'http://localhost/api?credential=secret', 'https://user:password@example.com/api', 'https://example.com/api#token']) {
    assert.throws(() => validateEndpoint(url));
  }
});
