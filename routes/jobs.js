import { Router } from "express";
import { verifyTechnician } from "../middleware/auth.js";
import { jobDispatchService } from "../services/jobDispatchService.js";

const router = Router();

router.get("/:id/acceptance", verifyTechnician, async (req, res) => {
    try {
        res.set("Cache-Control", "no-store");
        const result = await jobDispatchService.getAcceptanceOutcome(req.technicianId, req.params.id);
        if (result.code === "not_found") return res.status(404).json({ state: "closed", code: result.code });
        return res.json(result);
    } catch (error) {
        console.error("[Jobs Acceptance] Error:", error);
        return res.status(503).json({ error: "Unable to confirm job acceptance. Please reconnect and check again." });
    }
});

/**
 * POST /api/jobs/accept
 * Accept a job offer using body payload: { jobId } or { requestId }.
 */
router.post("/accept", verifyTechnician, async (req, res) => {
    try {
        const technicianId = req.technicianId;
        const requestId = String(
            req.body?.jobId || req.body?.requestId || req.body?.id || ""
        ).trim();

        if (!requestId) {
            return res.status(400).json({ error: "jobId or requestId is required." });
        }

        const result = await jobDispatchService.acceptJob(technicianId, requestId);
        if (!result.success) {
            if (result.code === "not_found") {
                return res.status(404).json({ error: result.reason || "Job not found." });
            }
            if (result.code === "technician_not_found") {
                return res.status(404).json({ error: result.reason || "Technician not found." });
            }
            return res.status(409).json({ success: false, code: result.code, error: result.reason || "Job already taken." });
        }

        const responseJob =
            result?.job && typeof result.job === "object"
                ? result.job
                : {
                    id: String(requestId),
                    technician_id: technicianId,
                    status: "accepted",
                };

        return res.json({
            success: true,
            idempotent: !!result.idempotent,
            request: responseJob,
            job: responseJob,
        });
    } catch (error) {
        console.error("[Jobs Accept] Error:", error);
        return res.status(500).json({ error: "Failed to accept job." });
    }
});

export default router;

