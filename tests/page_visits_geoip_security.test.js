import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolveLocationFromIp } from '../utils/geoLookup.js';

// Resolve the parser that GeoIP actually consumes, not an unrelated root copy.
const require = createRequire(import.meta.url);
const geoipRequire = createRequire(require.resolve('geoip-lite'));
const { Address4 } = geoipRequire('ip-address');
const geoip = require('geoip-lite');

test('the GeoIP dependency supports the backend release Node runtime', () => {
  const semver = require('semver');
  const backend = require('../package.json');
  const dependency = require('geoip-lite/package.json');
  assert.ok(semver.satisfies(process.versions.node, backend.engines.node));
  assert.ok(semver.satisfies(process.versions.node, dependency.engines.node), `GeoIP requires ${dependency.engines.node}, backend checks use ${process.versions.node}`);
});

test('the GeoIP parser rejects ambiguous leading-zero addresses rather than decoding them as decimal', () => {
  for (const host of ['012.0.0.1', '012.012.012.012', '010.0.0.1']) {
    assert.throws(() => new Address4(host));
  }
});

test('page-visit location lookup keeps its synchronous IPv4 and IPv6 contract with bundled data', () => {
  for (const host of ['8.8.8.8', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
    const value = geoip.lookup(host);
    assert.match(value.country, /^[A-Z]{2}$/);
    const location = resolveLocationFromIp(host);
    assert.equal(typeof location, 'string');
    assert.ok(location.endsWith(value.country));
  }
  assert.equal(resolveLocationFromIp('127.0.0.1'), 'Local/Unknown');
});
