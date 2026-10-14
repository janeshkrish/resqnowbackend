import * as db from "../db.js";
import { jobDispatchService } from "./jobDispatchService.js";
import { loadTechnicianFleetVehicles } from "./towTruckCapability.js";
import { isTowingServiceType } from "./towingServiceType.js";

export const jobMatcher = {
    async findBestMatch(jobRequest, excludeTechnicianIds = [], { pool: suppliedPool } = {}) {
        try {
            const pool = suppliedPool || await db.getPool();
            let [rows] = await pool.query("SELECT * FROM technicians");
            if (isTowingServiceType(jobRequest.service_type)) rows = await loadTechnicianFleetVehicles(pool, rows);
            const { analysis } = jobDispatchService.analyzeTechnicians(jobRequest, rows, null);
            const excluded = new Set((excludeTechnicianIds || []).map((id) => String(id)));

            const eligible = analysis
                .filter((a) => a.eligible && !excluded.has(String(a.technicianId)))
                .sort((a, b) => (a.distanceKm || Number.POSITIVE_INFINITY) - (b.distanceKm || Number.POSITIVE_INFINITY));

            if (eligible.length === 0) return null;
            const best = eligible[0];
            const raw = rows.find((r) => String(r.id) === String(best.technicianId));
            if (!raw) return null;
            return { ...raw, distance: best.distanceKm };
        } catch (error) {
            console.error("[JobMatcher] Error finding match:", error);
            return null;
        }
    }
};
