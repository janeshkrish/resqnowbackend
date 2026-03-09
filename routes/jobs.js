import { Router } from "express";
import { verifyTechnician } from "../middleware/auth.js";
import { jobDispatchService } from "../services/jobDispatchService.js";

const router = Router();

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
            return res.status(409).json({ error: result.reason || "Job already taken." });
        }

        return res.json({
            success: true,
            idempotent: !!result.idempotent,
            request: result.job,
            job: result.job,
        });
    } catch (error) {
        console.error("[Jobs Accept] Error:", error);
        return res.status(500).json({ error: "Failed to accept job." });
    }
});

export default router;

