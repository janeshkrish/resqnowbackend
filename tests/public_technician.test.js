import assert from 'node:assert/strict';
import test from 'node:test';

import { toPublicNearbyTechnician } from '../services/publicTechnician.js';

const record = {
  id: 42, name: 'Squad Recovery', service_type: 'towing', specialties: ['Towing', 'Winching'],
  vehicle_types: { car: true, truck: true }, experience: 6, rating: 4.9, jobs_completed: 212,
  verification_status: 'verified', latitude: 11.02, longitude: 76.95, distance: 1.4, is_available: true,
  price: 450, base_price: 450, currency: 'INR', score: 101.2, aiRecommended: true,
  documents: { profile_photo: '/uploads/technicians/42/photo.jpg', garage_front: '/uploads/g.jpg' },
  email: 'owner@example.com', phone: '9876543210', aadhaar_number: '1234 5678 9012', pan_number: 'ABCDE1234F',
  gst_number: '33ABCDE1234F1Z5', upi_id: 'owner@upi', payment_details: { account: '0001' }, address: '12 Main Road',
  total_earnings: 90000, whatsapp_number: '9876543210', alternate_phone: '9000000000', settings: {}, resume_url: '/uploads/cv.pdf',
};

test('keeps only what a customer should see, with the profile photo', () => {
  const view = toPublicNearbyTechnician(record);
  assert.deepEqual(Object.keys(view).sort(), [
    'aiRecommended', 'base_price', 'currency', 'distance', 'experience', 'id', 'is_available', 'jobs_completed',
    'latitude', 'longitude', 'name', 'price', 'profile_photo', 'rating', 'score', 'service_type', 'specialties',
    'vehicle_types', 'verification_status',
  ]);
  assert.equal(view.profile_photo, '/uploads/technicians/42/photo.jpg');
  const serialized = JSON.stringify(view);
  for (const secret of ['owner@example.com', '9876543210', '1234 5678 9012', 'ABCDE1234F', 'owner@upi', '90000', '12 Main Road', 'g.jpg', 'cv.pdf']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test('a technician without a photo gets null, not an empty path', () => {
  assert.equal(toPublicNearbyTechnician({ ...record, documents: { profile_photo: '' } }).profile_photo, null);
  assert.equal(toPublicNearbyTechnician({ id: 7, name: 'New partner' }).profile_photo, null);
});
