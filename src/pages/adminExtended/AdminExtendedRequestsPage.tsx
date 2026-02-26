import { FormEvent, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { adminExtendedApiRequest } from "./api/adminExtendedApi";
import { AdminExtendedShell } from "./components/AdminExtendedShell";

export default function AdminExtendedRequestsPage() {
  const [requestId, setRequestId] = useState("");
  const [technicianId, setTechnicianId] = useState("");
  const [radiusKm, setRadiusKm] = useState("35");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState("cancelled");

  const manualAssignMutation = useMutation({
    mutationFn: () =>
      adminExtendedApiRequest("/requests/manual-assign", {
        method: "POST",
        body: { requestId: Number(requestId), technicianId: Number(technicianId) },
      }),
  });

  const escalateMutation = useMutation({
    mutationFn: () =>
      adminExtendedApiRequest("/requests/escalate", {
        method: "POST",
        body: { requestId: Number(requestId), radiusKm: Number(radiusKm), reason: note || null },
      }),
  });

  const highPriorityMutation = useMutation({
    mutationFn: () =>
      adminExtendedApiRequest("/requests/high-priority", {
        method: "POST",
        body: { requestId: Number(requestId), note: note || null },
      }),
  });

  const closeMutation = useMutation({
    mutationFn: () =>
      adminExtendedApiRequest("/dispatch/manual-close", {
        method: "POST",
        body: { requestId: Number(requestId), status, reason: note || null },
      }),
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
  };

  const lastResult =
    manualAssignMutation.data ||
    escalateMutation.data ||
    highPriorityMutation.data ||
    closeMutation.data;
  const lastError =
    (manualAssignMutation.error as Error) ||
    (escalateMutation.error as Error) ||
    (highPriorityMutation.error as Error) ||
    (closeMutation.error as Error);

  return (
    <AdminExtendedShell title="Request Control" subtitle="Manual override tools for dispatch operations">
      <form onSubmit={onSubmit} style={{ display: "grid", gap: 8, maxWidth: 540 }}>
        <label>
          Request ID
          <input value={requestId} onChange={(event) => setRequestId(event.target.value)} required />
        </label>
        <label>
          Technician ID
          <input value={technicianId} onChange={(event) => setTechnicianId(event.target.value)} />
        </label>
        <label>
          Reroute Radius (km)
          <input value={radiusKm} onChange={(event) => setRadiusKm(event.target.value)} />
        </label>
        <label>
          Note / Reason
          <textarea value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
        <label>
          Close Status
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="cancelled">cancelled</option>
            <option value="completed">completed</option>
          </select>
        </label>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={() => manualAssignMutation.mutate()} disabled={manualAssignMutation.isPending}>
            Manual Assign
          </button>
          <button type="button" onClick={() => escalateMutation.mutate()} disabled={escalateMutation.isPending}>
            Escalate
          </button>
          <button type="button" onClick={() => highPriorityMutation.mutate()} disabled={highPriorityMutation.isPending}>
            Mark High Priority
          </button>
          <button type="button" onClick={() => closeMutation.mutate()} disabled={closeMutation.isPending}>
            Manual Close
          </button>
        </div>
      </form>

      {lastError ? <p style={{ color: "#b00020" }}>{lastError.message}</p> : null}
      {lastResult ? <pre>{JSON.stringify(lastResult, null, 2)}</pre> : null}
    </AdminExtendedShell>
  );
}

