// What a technician needs to know about the vehicle and the problem, shaped the same
// way for the job alert, the offer screen and the active job.
import { readRequestDetails, summarizeRequestDetails } from "./requestDetails.js";
import { vehicleClassInfo } from "./vehicleClasses.js";

const TRUCK_LABELS = Object.freeze({
  flatbed: "Flatbed",
  "wheel-lift": "Wheel-lift",
  "heavy-duty-wrecker": "Heavy-duty wrecker",
});

const text = (value) => String(value ?? "").trim();

export function buildTechnicianJobDetails(row = {}) {
  const details = readRequestDetails(row.request_details_json ?? row.requestDetails ?? null);
  const brand = text(row.vehicle_brand ?? row.vehicleBrand);
  const model = text(row.vehicle_model ?? row.vehicleModel);
  const subtype = text(row.vehicle_subtype ?? row.vehicleSubtype) || null;
  const subtypeLabel = vehicleClassInfo(subtype)?.label || null;
  // Older requests stored "SUV - Creta" in the model; don't repeat a brand already in it.
  const name = brand && !model.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${model}`.trim() : model;
  const towTruckType = text(row.tow_truck_type ?? row.towTruckType) || null;
  return {
    vehicleBrand: brand || null,
    vehicleName: name || null,
    vehicleSubtype: subtype,
    vehicleSubtypeLabel: subtypeLabel,
    vehicleLine: [name, subtypeLabel].filter(Boolean).join(" · ") || null,
    towTruckType,
    towTruckLabel: towTruckType ? TRUCK_LABELS[towTruckType] || towTruckType : null,
    problem: summarizeRequestDetails(details),
    answers: details.answers,
    landmark: details.landmark || null,
    plate: details.plate || null,
    customerNote: details.note || null,
    urgent: Boolean(details.urgent),
    attachments: details.attachments,
  };
}
