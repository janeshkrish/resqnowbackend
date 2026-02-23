import * as db from "../db.js";
import { jobDispatchService } from "./jobDispatchService.js";

export const jobMatcher = {
    async findBestMatch(jobRequest, excludeTechnicianIds = []) {
        try {
            const rows = await db.query("SELECT * FROM technicians");
            const { analysis } = jobDispatchService.analyzeTechnicians(jobRequest, rows, null);

            const eligible = analysis
                .filter((a) => a.eligible && !excludeTechnicianIds.includes(a.technicianId))
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
