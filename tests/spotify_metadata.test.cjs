const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHmac } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../sources/spotify-web/index.js'), 'utf8');
const albumID = '0000000000000000000001';
const trackID = '0000000000000000000002';

function varint(value) {
  const bytes = [];
  do {
    const low = value % 128;
    value = Math.floor(value / 128);
    bytes.push(low | (value ? 0x80 : 0));
  } while (value);
  return bytes;
}

function sint(field, value) {
  return [...varint(field * 8), ...varint(value < 0 ? -value * 2 - 1 : value * 2)];
}

function message(field, value) {
  const bytes = typeof value === 'string' ? Array.from(Buffer.from(value)) : value;
  return [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes];
}

function album(year = 2025, month = 5, day = 8) {
  return [
    ...message(1, [0x80, 0xff, ...Array(13).fill(0), 0xd2]),
    ...message(2, 'Été 東京 🎵'),
    ...message(6, [...sint(1, year), ...sint(2, month), ...sint(3, day)]),
  ];
}

const binary = bytes => ({
  status: 200,
  arrayBuffer: () => Array.from(bytes), // The extension host returns an array of bytes.
  text() { throw new Error('Binary metadata must not be read as UTF-8 text'); },
});

function runtime(respond = () => binary(album())) {
  const calls = [];
  const saved = new Map([['client_state', JSON.stringify({
    accessToken: 'cached-access', clientToken: 'cached-client',
    clientVersion: 'test-version', deviceID: 'test-device', clientID: 'test-client-id',
  })]]);
  const context = vm.createContext({
    registerExtension() {},
    log: { info() {}, debug() {}, warn() {}, error() {} },
    storage: { get: key => saved.get(key), set: (key, value) => saved.set(key, value) },
    utils: {
      randomUserAgent: () => 'Test',
      hmacSHA1: (key, data) => Array.from(createHmac('sha1', Buffer.from(key)).update(Buffer.from(data)).digest()),
    },
    fetch(url, options) {
      calls.push({ url, options });
      return respond(url, options, calls.length);
    },
    http: {
      get(url) {
        assert.match(url, /\/api\/token/, 'Protobuf requests must use the binary host API');
        return { statusCode: 200, body: JSON.stringify({ accessToken: 'fresh-access', clientId: 'test-client-id' }) };
      },
      post(url) {
        assert.match(url, /clienttoken/);
        return { statusCode: 200, body: JSON.stringify({
          response_type: 'RESPONSE_GRANTED_TOKEN_RESPONSE', granted_token: { token: 'fresh-client' },
        }) };
      },
    },
  });
  vm.runInContext(source, context);
  context.initialize({});
  return { context, calls };
}

test('binary metadata preserves the release date from the negative-year bug report', () => {
  const { context, calls } = runtime();
  const metadata = context.getSpotifyNativeAlbumMetadata(albumID);
  assert.equal(metadata.release_date, '2025-05-08');
  assert.equal(metadata.album_name, 'Été 東京 🎵');
  assert.equal(context.spotifyIDToHexGID(metadata.album_id), '80ff00000000000000000000000000d2');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer cached-access');
  assert.equal(context.getSpotifyNativeAlbumMetadata(albumID), metadata);
  assert.equal(calls.length, 1, 'Cache the correctly decoded metadata');
});

test('the fixture reproduces the old UTF-8 corruption exactly', () => {
  const { context } = runtime();
  const dateOnly = message(6, [...sint(1, 2025), ...sint(2, 5), ...sint(3, 8)]);
  const corrupted = Buffer.from(dateOnly).toString('utf8');
  assert.equal(context.parseSpotifyProtoAlbum(corrupted).release_date, '-2047-05-08');
});

for (const [year, month, day, expected] of [
  [1969, 12, 31, '1969-12-31'], [2019, 1, 2, '2019-01-02'],
  [2024, 2, 29, '2024-02-29'], [2026, 0, 0, '2026'], [2026, 10, 0, '2026-10'],
]) {
  test(`binary release dates retain their precision: ${expected}`, () => {
    const { context } = runtime(() => binary(album(year, month, day)));
    assert.equal(context.getSpotifyNativeAlbumMetadata(albumID).release_date, expected);
  });
}

test('track enrichment preserves binary duration, ISRC and album metadata', () => {
  const track = [
    ...message(3, album()), ...sint(5, 3), ...sint(6, 2), ...sint(7, 234567),
    ...message(10, [...message(1, 'isrc'), ...message(2, 'usaaa2500001')]),
  ];
  const { context } = runtime(url => binary(url.includes('/track/') ? track : album()));
  const metadata = context.getSpotifyNativeTrackMetadata(trackID, albumID);
  assert.equal(metadata.release_date, '2025-05-08');
  assert.equal(metadata.album_name, 'Été 東京 🎵');
  assert.equal(metadata.isrc, 'USAAA2500001');
  assert.equal(metadata.track_number, 3);
  assert.equal(metadata.disc_number, 2);
  assert.equal(metadata.duration_ms, 234567);
});

test('the ISRC fallback still reads byte responses', () => {
  const { context } = runtime(() => binary([0xe0, ...Buffer.from('isrc\x12\x0cusaaa2500001')]));
  assert.equal(context.getSpotifyNativeTrackMetadata(trackID).isrc, 'USAAA2500001');
});

test('a rejected binary request refreshes authentication and retries once', () => {
  const { context, calls } = runtime((url, options, count) => count === 1 ? { status: 401 } : binary(album()));
  assert.equal(context.getSpotifyNativeAlbumMetadata(albumID).release_date, '2025-05-08');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer fresh-access');
  assert.equal(calls[1].options.headers['Client-Token'], 'fresh-client');
});

test('a persistent authentication rejection cannot loop', () => {
  const { context, calls } = runtime(() => ({ status: 401 }));
  assert.equal(context.getSpotifyNativeAlbumMetadata(albumID), null);
  assert.equal(calls.length, 2);
});

for (const response of [{ status: 404 }, { status: 500 }, { error: 'request cancelled' }, binary([])]) {
  test(`unavailable binary metadata is not cached: ${JSON.stringify(response)}`, () => {
    const { context, calls } = runtime((url, options, count) => count === 1 ? response : binary(album()));
    assert.equal(context.getSpotifyNativeAlbumMetadata(albumID), null);
    assert.equal(context.getSpotifyNativeAlbumMetadata(albumID).release_date, '2025-05-08');
    assert.equal(calls.length, 2);
  });
}
