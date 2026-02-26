import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { adminExtendedApiRequest } from "./api/adminExtendedApi";
import { AdminExtendedShell } from "./components/AdminExtendedShell";

export default function AdminExtendedNotificationsPage() {
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [technicianIds, setTechnicianIds] = useState("");

  const systemMutation = useMutation({
    mutationFn: () =>
      adminExtendedApiRequest("/notifications/system-announcement", {
        method: "POST",
        body: { title, message },
      }),
  });

  const technicianMutation = useMutation({
    mutationFn: () =>
      adminExtendedApiRequest("/notifications/technician-broadcast", {
        method: "POST",
        body: {
          title,
          message,
          technicianIds: technicianIds
            .split(",")
            .map((item) => Number(item.trim()))
            .filter((value) => Number.isInteger(value) && value > 0),
        },
      }),
  });

  const emergencyMutation = useMutation({
    mutationFn: () =>
      adminExtendedApiRequest("/notifications/emergency-message", {
        method: "POST",
        body: { title: title || "Emergency", message },
      }),
  });

  const lastError =
    (systemMutation.error as Error) ||
    (technicianMutation.error as Error) ||
    (emergencyMutation.error as Error);

  return (
    <AdminExtendedShell title="Notification Broadcaster" subtitle="Admin-triggered broadcast channel">
      <div style={{ display: "grid", gap: 8, maxWidth: 540 }}>
        <input placeholder="Title" value={title} onChange={(event) => setTitle(event.target.value)} />
        <textarea placeholder="Message" value={message} onChange={(event) => setMessage(event.target.value)} />
        <input
          placeholder="Technician IDs (comma-separated)"
          value={technicianIds}
          onChange={(event) => setTechnicianIds(event.target.value)}
        />

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={() => systemMutation.mutate()} disabled={systemMutation.isPending}>
            Send System Announcement
          </button>
          <button type="button" onClick={() => technicianMutation.mutate()} disabled={technicianMutation.isPending}>
            Send Technician Broadcast
          </button>
          <button type="button" onClick={() => emergencyMutation.mutate()} disabled={emergencyMutation.isPending}>
            Send Emergency Message
          </button>
        </div>
      </div>

      {lastError ? <p style={{ color: "#b00020" }}>{lastError.message}</p> : null}
      {systemMutation.data ? <pre>{JSON.stringify(systemMutation.data, null, 2)}</pre> : null}
      {technicianMutation.data ? <pre>{JSON.stringify(technicianMutation.data, null, 2)}</pre> : null}
      {emergencyMutation.data ? <pre>{JSON.stringify(emergencyMutation.data, null, 2)}</pre> : null}
    </AdminExtendedShell>
  );
}

