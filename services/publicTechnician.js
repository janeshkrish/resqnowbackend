// What customers may see about a nearby technician (radar, technician picker).
// Everything else on the technician record (contact details, government IDs,
// payment details, earnings, documents, login activity) stays server-side.

const text = (value) => (typeof value === "string" ? value : "");

const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function toPublicNearbyTechnician(technician = {}) {
  const photo = text(technician.documents?.profile_photo).trim();
  return {
    id: String(technician.id ?? ""),
    name: text(technician.name),
    service_type: text(technician.service_type),
    specialties: Array.isArray(technician.specialties) ? technician.specialties.map(String) : [],
    vehicle_types: technician.vehicle_types && typeof technician.vehicle_types === "object" ? technician.vehicle_types : {},
    experience: number(technician.experience) ?? 0,
    rating: number(technician.rating) ?? 0,
    jobs_completed: number(technician.jobs_completed) ?? 0,
    verification_status: text(technician.verification_status),
    profile_photo: photo || null,
    latitude: number(technician.latitude),
    longitude: number(technician.longitude),
    distance: number(technician.distance) ?? 0,
    is_available: Boolean(technician.is_available),
    price: number(technician.price),
    base_price: number(technician.base_price),
    currency: text(technician.currency) || "INR",
    score: number(technician.score),
    aiRecommended: Boolean(technician.aiRecommended),
  };
}
