import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanModelName, createVehiclePhotoService, pickArticle, searchQueries } from '../services/vehiclePhotoService.js';

const article = (title, description, image, index = 1) => ({ title, description, index, pageprops: image ? { page_image_free: image } : {} });

function harness(results, { imageinfo, fail } = {}) {
  const calls = [];
  const clock = { now: 1_000 };
  const http = {
    get: async (url, options) => {
      calls.push({ url, params: options.params, headers: options.headers });
      if (fail) throw Object.assign(new Error('boom'), { code: 'ECONNRESET' });
      if (url.includes('en.wikipedia.org')) return { data: { query: { pages: results[options.params.gsrsearch] || [] } } };
      return {
        data: {
          query: {
            pages: [{
              imageinfo: [imageinfo || {
                thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Nexon.jpg/960px-Nexon.jpg?utm_source=x',
                thumbwidth: 960, thumbheight: 600,
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:Nexon.jpg',
                extmetadata: { Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Someone">Some&nbsp;One</a>' }, LicenseShortName: { value: 'CC BY-SA 4.0' } },
              }],
            }],
          },
        },
      };
    },
  };
  const service = createVehiclePhotoService({ http, now: () => clock.now, warn: () => {} });
  return { service, calls, clock };
}

test('names models the way Wikipedia titles them', () => {
  assert.equal(cleanModelName('Activa 3G/4G/5G/6G'), 'Activa 3G');
  assert.equal(cleanModelName('Swift (1st Gen)'), 'Swift');
  assert.deepEqual(searchQueries('Maruti Suzuki', 'Swift'), ['Maruti Suzuki Swift', 'Suzuki Swift']);
  assert.deepEqual(searchQueries('Tata Motors', 'Nexon'), ['Tata Nexon']);
  assert.deepEqual(searchQueries('Jawa / Yezdi', 'Yezdi Roadster'), ['Jawa Yezdi Roadster']);
  assert.deepEqual(searchQueries('Jawa / Yezdi', 'Jawa 42'), ['Jawa 42']);
});

test("picks the model's own article, never the brand's or an unrelated page", () => {
  const pages = [
    article('Tata Motors', 'Indian automotive manufacturer', 'Tata_logo.svg', 1),
    article('Plug-in electric vehicles in India', '', 'EV.jpg', 2),
    article('Tata Nexon', 'Subcompact crossover SUV', 'Nexon.jpg', 3),
  ];
  assert.equal(pickArticle(pages, 'Nexon').title, 'Tata Nexon');
  assert.equal(pickArticle([article('Splendor (motorcycle)', 'Motorcycle', null)], 'Splendor'), null, 'no free image, no photo');
  assert.equal(pickArticle([article('Nexon (company)', 'Software company', 'Logo.png')], 'Nexon'), null, 'not a vehicle');
});

test('returns the photo with its credit and remembers it', async () => {
  const { service, calls } = harness({ 'Tata Nexon': [article('Tata Nexon', 'Subcompact crossover SUV', 'Nexon.jpg')] });
  const photo = await service.findPhoto({ make: 'Tata Motors', model: 'Nexon' });
  assert.deepEqual(photo, {
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Nexon.jpg/960px-Nexon.jpg',
    width: 960, height: 600, article: 'Tata Nexon',
    credit: { author: 'Some One', license: 'CC BY-SA 4.0', source: 'https://commons.wikimedia.org/wiki/File:Nexon.jpg' },
  });
  assert.match(calls[0].headers['User-Agent'], /ResQNow/);
  assert.equal(calls[1].params.titles, 'File:Nexon.jpg');

  await service.findPhoto({ make: 'tata motors', model: 'nexon' });
  assert.equal(calls.length, 2, 'the second request is served from memory');
});

test('falls back to the model family when the exact variant has no article', async () => {
  const { service, calls } = harness({ 'Honda Activa': [article('Honda Activa', 'Scooter', 'Activa.jpg')] });
  const photo = await service.findPhoto({ make: 'Honda Motorcycles', model: 'Activa 3G/4G/5G/6G' });
  assert.equal(photo.article, 'Honda Activa');
  assert.deepEqual(calls.map((c) => c.params.gsrsearch).filter(Boolean), ['Honda Activa 3G', 'Honda Activa']);
});

test('answers null, not an error, when Wikipedia has nothing or is down', async () => {
  const empty = harness({});
  assert.equal(await empty.service.findPhoto({ make: 'Ather Energy', model: '450X' }), null);

  const down = harness({}, { fail: true });
  assert.equal(await down.service.findPhoto({ make: 'Tata Motors', model: 'Nexon' }), null);
  down.clock.now += 11 * 60_000;
  await down.service.findPhoto({ make: 'Tata Motors', model: 'Nexon' });
  assert.equal(down.calls.length, 2, 'a failed lookup is tried again after ten minutes');
});
