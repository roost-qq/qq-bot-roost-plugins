import test from 'node:test';
import assert from 'node:assert/strict';
import { createSignedParams } from '../xiaoheihe-client.js';

const NOW_SECONDS = 1_795_843_000;
const NONCE = '1A36C11EE9CC8D7DDE036E88D841270F';

test('signature checksum keeps the two untouched trailing hash bytes', () => {
  const cases = [
    ['/bbs/app/user/message', 'SPSPW24'],
    ['/chat/stranger_messages/', 'IZITX11'],
    ['/chatroom/v2/msg/user', 'VV10Y50'],
  ];
  for (const [path, hkey] of cases) {
    const signed = createSignedParams(path, { nowSeconds: NOW_SECONDS, nonce: NONCE });
    assert.equal(signed.hkey, hkey, path);
    assert.equal(signed._time, NOW_SECONDS);
    assert.equal(signed.nonce, NONCE);
  }
  assert.notEqual(
    createSignedParams('/bbs/app/user/message', { nowSeconds: NOW_SECONDS, nonce: NONCE }).hkey,
    'SPSPW16',
  );
});
