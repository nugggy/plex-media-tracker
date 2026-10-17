import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refuseRequest } from '../src/origin.ts';

const PORT = 7000;
const JSON_TYPE = 'application/json';

test('the dashboard on either loopback name gets through', () => {
  assert.equal(refuseRequest('GET', { host: 'localhost:7000' }, PORT), null);
  assert.equal(refuseRequest('GET', { host: '127.0.0.1:7000' }, PORT), null);
  assert.equal(
    refuseRequest(
      'POST',
      { host: 'localhost:7000', origin: 'http://localhost:7000', 'content-type': 'application/json' },
      PORT,
    ),
    null,
  );
  assert.equal(
    refuseRequest(
      'POST',
      { host: '127.0.0.1:7000', origin: 'http://127.0.0.1:7000', 'content-type': 'application/json; charset=utf-8' },
      PORT,
    ),
    null,
  );
});

test('a rebound name pointing at this PC is refused, even for a read', () => {
  assert.ok(refuseRequest('GET', { host: 'evil.example:7000' }, PORT));
  assert.ok(refuseRequest('GET', { host: 'localhost' }, PORT));
  assert.ok(refuseRequest('GET', { host: 'localhost:7001' }, PORT));
  assert.ok(refuseRequest('GET', {}, PORT));
});

test('a POST from another website is refused', () => {
  const host = 'localhost:7000';
  assert.ok(refuseRequest('POST', { host, origin: 'https://evil.example', 'content-type': JSON_TYPE }, PORT));
  assert.ok(refuseRequest('POST', { host, origin: 'null', 'content-type': JSON_TYPE }, PORT));
  // The right name but the wrong scheme or port is still another site.
  assert.ok(refuseRequest('POST', { host, origin: 'https://localhost:7000', 'content-type': JSON_TYPE }, PORT));
  assert.ok(refuseRequest('POST', { host, origin: 'http://localhost:8080', 'content-type': JSON_TYPE }, PORT));
});

test('a POST that is not JSON is refused, since a plain form can send those', () => {
  const host = 'localhost:7000';
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', undefined]) {
    assert.ok(refuseRequest('POST', { host, 'content-type': type }, PORT), String(type));
  }
});

test('a POST with no Origin, from a tool rather than a page, is fine when it is JSON', () => {
  assert.equal(refuseRequest('POST', { host: 'localhost:7000', 'content-type': JSON_TYPE }, PORT), null);
});

test('a GET carrying a foreign Origin is still allowed, since reading needs the Host check only', () => {
  assert.equal(refuseRequest('GET', { host: 'localhost:7000', origin: 'https://evil.example' }, PORT), null);
});

test('other changing methods are checked for Origin too', () => {
  assert.ok(refuseRequest('DELETE', { host: 'localhost:7000', origin: 'https://evil.example' }, PORT));
  assert.equal(refuseRequest('DELETE', { host: 'localhost:7000', origin: 'http://localhost:7000' }, PORT), null);
});

test('the Host check follows the configured port', () => {
  assert.equal(refuseRequest('GET', { host: 'localhost:7123' }, 7123), null);
  assert.ok(refuseRequest('GET', { host: 'localhost:7000' }, 7123));
});

test('on the NAS any host name will do, since every call needs a session', () => {
  const opts = { signedIn: true };
  assert.equal(refuseRequest('GET', { host: 'pmt.example.org' }, PORT, opts), null);
  assert.equal(
    refuseRequest(
      'POST',
      { host: 'pmt.example.org', origin: 'https://pmt.example.org', 'content-type': JSON_TYPE },
      PORT,
      opts,
    ),
    null,
  );
  assert.equal(
    refuseRequest(
      'POST',
      { host: '192.168.0.162:7000', origin: 'http://192.168.0.162:7000', 'content-type': JSON_TYPE },
      PORT,
      opts,
    ),
    null,
  );
});

test('on the NAS a browser POST from another site is still refused', () => {
  assert.ok(
    refuseRequest(
      'POST',
      { host: 'pmt.example.org', origin: 'https://evil.example', 'content-type': JSON_TYPE },
      PORT,
      { signedIn: true },
    ),
  );
});

test("the phone's bearer requests come from its own web view and are let through", () => {
  assert.equal(
    refuseRequest(
      'POST',
      { host: 'pmt.example.org', origin: 'https://localhost', 'content-type': JSON_TYPE },
      PORT,
      { signedIn: true, bearer: true },
    ),
    null,
  );
});

test('on the NAS, once its names are known, a rebound name is refused', () => {
  const hosts = new Set(['music.example.org', 'music.example.org:443', '192.168.0.162:7000', '127.0.0.1:7000']);
  const opts = { signedIn: true, hosts };
  assert.equal(refuseRequest('GET', { host: 'music.example.org' }, PORT, opts), null);
  assert.equal(refuseRequest('GET', { host: '192.168.0.162:7000' }, PORT, opts), null);
  assert.ok(refuseRequest('GET', { host: 'attacker.example:7000' }, PORT, opts));
  assert.ok(
    refuseRequest('POST', { host: 'attacker.example:7000', 'content-type': JSON_TYPE }, PORT, opts),
  );
});
