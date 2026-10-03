import assert from 'node:assert/strict';
import test from 'node:test';

import { handleTechnicianLiveEta } from '../routes/technicians.js';
import { trafficEtaReadiness } from '../services/trafficEtaService.js';

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

const NOW = Date.parse('2026-10-03T10:00:00.000Z');
const job = {
  id: 7201,
  status: 'en-route',
  service_type: 'car-lockout',
  vehicle_type: 'car',
  location_lat: 11.0092,
  location_lng: 76.9605,
};
const cachedEta = {
  requestId: '7201',
  technicianLat: 11.0168,
  technicianLng: 76.9558,
  destinationLat: 11.0092,
  destinationLng: 76.9605,
  etaSeconds: 1260,
  distanceMeters: 3900,
  trafficAware: true,
  provider: 'mappls',
  calculatedAt: '2026-10-03T09:59:40.000Z',
};

/** The handler's surroundings: the technician's job, their last position and the ETA service. */
function setup({ enabled = true, foundJob = job, location = { lat: 11.0168, lng: 76.9558, jobId: '7201' }, eta = cachedEta } = {}) {
  const asked = { jobs: [], locations: [], resolved: [] };
  const deps = {
    now: () => NOW,
    findJob: async (technicianId, requestId) => {
      asked.jobs.push({ technicianId, requestId });
      return foundJob;
    },
    getRuntime: () => ({
      trafficEta: {
        enabled,
        resolve: async (input) => {
          asked.resolved.push(input);
          if (eta instanceof Error) throw eta;
          return { eta, refreshed: false };
        },
      },
      store: {
        getForRequest: async (technicianId, requestId) => {
          asked.locations.push({ technicianId, requestId });
          if (location instanceof Error) throw location;
          return location;
        },
      },
    }),
  };
  return { asked, deps };
}

const request = (query = {}) => ({ technicianId: 7, query });

test('the technician gets the same traffic-aware ETA the customer is shown', async () => {
  const { asked, deps } = setup();
  const response = createResponse();

  await handleTechnicianLiveEta(request({ requestId: '7201' }), response, deps);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.eta, {
    requestId: '7201',
    technicianLat: 11.0168,
    technicianLng: 76.9558,
    destinationLat: 11.0092,
    destinationLng: 76.9605,
    etaSeconds: 1260,
    distanceMeters: 3900,
    trafficAware: true,
    provider: 'mappls',
    calculatedAt: '2026-10-03T09:59:40.000Z',
  });
  // The server's clock goes along, so the app can tell how old the ETA already is.
  assert.equal(response.body.serverTime, '2026-10-03T10:00:00.000Z');

  // Their own job, measured from their last shared position to the customer.
  assert.deepEqual(asked.jobs, [{ technicianId: 7, requestId: '7201' }]);
  assert.deepEqual(asked.locations, [{ technicianId: '7', requestId: '7201' }]);
  assert.deepEqual(asked.resolved, [{
    requestId: '7201',
    origin: { lat: 11.0168, lng: 76.9558 },
    destination: { lat: 11.0092, lng: 76.9605 },
    vehicleMode: 'car',
    status: 'en-route',
  }]);
});

test('a loaded tow is measured to the drop point, as a tow truck', async () => {
  const tow = {
    id: 7202, status: 'enroute_drop', service_type: 'car-towing', vehicle_type: 'car',
    location_lat: 11.0005, location_lng: 76.9665, drop_latitude: 11.0351, drop_longitude: 76.9712,
  };
  const { asked, deps } = setup({ foundJob: tow, location: { lat: 11.01, lng: 76.96, jobId: '7202' } });
  const response = createResponse();

  await handleTechnicianLiveEta(request(), response, deps);

  assert.deepEqual(asked.resolved[0].destination, { lat: 11.0351, lng: 76.9712 });
  assert.equal(asked.resolved[0].vehicleMode, 'commercial-tow');
  assert.equal(asked.resolved[0].requestId, '7202');
});

test('with the traffic ETA switched off nothing is looked up and the app keeps its own estimate', async () => {
  const { asked, deps } = setup({ enabled: false });
  const response = createResponse();

  await handleTechnicianLiveEta(request({ requestId: '7201' }), response, deps);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.eta, null);
  assert.equal(response.body.reason, 'disabled');
  assert.deepEqual(asked, { jobs: [], locations: [], resolved: [] });
});

test('there is no ETA without a live job of their own, a journey under way, or a recent position', async () => {
  const cases = [
    [{ foundJob: null }, 'no_active_job'],
    [{ foundJob: { ...job, status: 'arrived' } }, 'not_travelling'],
    [{ foundJob: { ...job, location_lat: null, location_lng: null } }, 'no_destination'],
    [{ location: null }, 'no_recent_location'],
    [{ eta: null }, 'unavailable'],
  ];
  for (const [options, reason] of cases) {
    const { asked, deps } = setup(options);
    const response = createResponse();
    await handleTechnicianLiveEta(request({ requestId: '7201' }), response, deps);

    assert.equal(response.statusCode, 200, reason);
    assert.equal(response.body.eta, null, reason);
    assert.equal(response.body.reason, reason);
    // No provider is asked unless everything needed is there.
    if (reason !== 'unavailable') assert.deepEqual(asked.resolved, [], reason);
  }
});

test('a Redis or provider failure answers "no ETA", never an error the screen has to handle', async () => {
  for (const options of [{ location: new Error('redis down') }, { eta: new Error('provider down') }]) {
    const { deps } = setup(options);
    const response = createResponse();
    const logged = console.error;
    console.error = () => {};
    try {
      await handleTechnicianLiveEta(request({ requestId: '7201' }), response, deps);
    } finally {
      console.error = logged;
    }

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { eta: null, reason: 'unavailable', serverTime: '2026-10-03T10:00:00.000Z' });
  }
});

test('the readiness report says whether ETAs include live traffic, without the key', () => {
  assert.deepEqual(trafficEtaReadiness({}), { enabled: false, liveTraffic: false, provider: 'mappls' });
  assert.deepEqual(
    trafficEtaReadiness({ TRAFFIC_ETA_ENABLED: 'true', MAPPLS_REST_API_KEY: 'secret-key' }),
    { enabled: true, liveTraffic: true, provider: 'mappls' },
  );
  // Switched on but with no Mappls key, or set to OSRM: road ETAs, not traffic-aware.
  assert.deepEqual(trafficEtaReadiness({ TRAFFIC_ETA_ENABLED: 'true' }), { enabled: true, liveTraffic: false, provider: 'mappls' });
  assert.deepEqual(
    trafficEtaReadiness({ TRAFFIC_ETA_ENABLED: 'true', TRAFFIC_ETA_PROVIDER: 'osrm', MAPPLS_REST_API_KEY: 'secret-key' }),
    { enabled: true, liveTraffic: false, provider: 'osrm' },
  );
  assert.equal(JSON.stringify(trafficEtaReadiness({ TRAFFIC_ETA_ENABLED: 'true', MAPPLS_REST_API_KEY: 'secret-key' })).includes('secret-key'), false);
});
