import { useQuery } from "@tanstack/react-query";
import { adminExtendedApiRequest } from "./api/adminExtendedApi";
import { AdminExtendedShell } from "./components/AdminExtendedShell";

type PilotAnalyticsPayload = {
  requestsPerDay: Array<{ day: string; requestCount: number }>;
  peakHours: Array<{ hourOfDay: number; requestCount: number }>;
  issueCategoryBreakdown: Array<{ issueCategory: string; requestCount: number }>;
  technicianUtilization: Array<{
    technicianId: number;
    technicianName: string;
    activeRequests: number;
    totalAssigned: number;
    utilizationRate: number;
  }>;
};

export default function AdminExtendedAnalyticsPage() {
  const analyticsQuery = useQuery({
    queryKey: ["adminExtended", "analytics", "pilot"],
    queryFn: () => adminExtendedApiRequest<PilotAnalyticsPayload>("/analytics/pilot"),
  });

  return (
    <AdminExtendedShell title="Pilot Analytics Engine" subtitle="Dynamic operational analytics">
      {analyticsQuery.isPending ? <p>Loading analytics...</p> : null}
      {analyticsQuery.error ? <p>{(analyticsQuery.error as Error).message}</p> : null}
      {analyticsQuery.data ? (
        <div style={{ display: "grid", gap: 16 }}>
          <article>
            <h2>Requests Per Day</h2>
            <pre>{JSON.stringify(analyticsQuery.data.requestsPerDay, null, 2)}</pre>
          </article>
          <article>
            <h2>Peak Hours</h2>
            <pre>{JSON.stringify(analyticsQuery.data.peakHours, null, 2)}</pre>
          </article>
          <article>
            <h2>Issue Category Breakdown</h2>
            <pre>{JSON.stringify(analyticsQuery.data.issueCategoryBreakdown, null, 2)}</pre>
          </article>
          <article>
            <h2>Technician Utilization</h2>
            <pre>{JSON.stringify(analyticsQuery.data.technicianUtilization, null, 2)}</pre>
          </article>
        </div>
      ) : null}
    </AdminExtendedShell>
  );
}

