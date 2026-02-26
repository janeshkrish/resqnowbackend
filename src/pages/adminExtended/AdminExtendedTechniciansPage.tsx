import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { adminExtendedApiRequest } from "./api/adminExtendedApi";
import { AdminExtendedShell } from "./components/AdminExtendedShell";

type TechnicianSummary = {
  technicianId: number;
  technicianName: string;
  status: string;
  isVisible: boolean;
  totalRequests: number;
  completedRequests: number;
  activeRequests: number;
  avgResponseMinutes: number;
  totalRevenue: number;
};

export default function AdminExtendedTechniciansPage() {
  const [technicianId, setTechnicianId] = useState("");
  const [note, setNote] = useState("");
  const queryClient = useQueryClient();

  const summaryQuery = useQuery({
    queryKey: ["adminExtended", "technicians", "performanceSummary"],
    queryFn: async () =>
      adminExtendedApiRequest<{ technicianPerformanceSummary: TechnicianSummary[] }>(
        "/technicians/performance-summary"
      ),
  });

  const toggleMutation = useMutation({
    mutationFn: () =>
      adminExtendedApiRequest(`/technicians/${Number(technicianId)}/toggle-visibility`, {
        method: "POST",
        body: {},
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["adminExtended", "technicians", "performanceSummary"] });
    },
  });

  const noteMutation = useMutation({
    mutationFn: () =>
      adminExtendedApiRequest(`/technicians/${Number(technicianId)}/admin-note`, {
        method: "POST",
        body: { note },
      }),
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
  };

  return (
    <AdminExtendedShell title="Technician Oversight" subtitle="Monitoring-only oversight actions">
      <form onSubmit={onSubmit} style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <input
          placeholder="Technician ID"
          value={technicianId}
          onChange={(event) => setTechnicianId(event.target.value)}
        />
        <input placeholder="Admin note" value={note} onChange={(event) => setNote(event.target.value)} />
        <button type="button" onClick={() => toggleMutation.mutate()} disabled={toggleMutation.isPending}>
          Toggle Visibility
        </button>
        <button type="button" onClick={() => noteMutation.mutate()} disabled={noteMutation.isPending}>
          Add Note
        </button>
      </form>

      {toggleMutation.error ? <p>{(toggleMutation.error as Error).message}</p> : null}
      {noteMutation.error ? <p>{(noteMutation.error as Error).message}</p> : null}

      {summaryQuery.isPending ? <p>Loading performance summary...</p> : null}
      {summaryQuery.error ? <p>{(summaryQuery.error as Error).message}</p> : null}

      {summaryQuery.data?.technicianPerformanceSummary ? (
        <table width="100%" cellPadding={8} style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th align="left">Technician</th>
              <th align="right">Assigned</th>
              <th align="right">Completed</th>
              <th align="right">Active</th>
              <th align="right">Avg Response</th>
              <th align="right">Revenue</th>
              <th align="center">Visible</th>
            </tr>
          </thead>
          <tbody>
            {summaryQuery.data.technicianPerformanceSummary.map((row) => (
              <tr key={row.technicianId} style={{ borderTop: "1px solid #ddd" }}>
                <td>{row.technicianName}</td>
                <td align="right">{row.totalRequests}</td>
                <td align="right">{row.completedRequests}</td>
                <td align="right">{row.activeRequests}</td>
                <td align="right">{row.avgResponseMinutes}</td>
                <td align="right">{row.totalRevenue}</td>
                <td align="center">{row.isVisible ? "Yes" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </AdminExtendedShell>
  );
}

