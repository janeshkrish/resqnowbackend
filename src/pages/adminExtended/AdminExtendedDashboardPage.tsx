import { useQuery } from "@tanstack/react-query";
import { adminExtendedApiRequest } from "./api/adminExtendedApi";
import { AdminExtendedShell } from "./components/AdminExtendedShell";

type DashboardMetrics = {
  activeRequestsCount: number;
  availableTechniciansCount: number;
  completedToday: number;
  avgResponseTime: number;
  todayRevenue: number;
  pendingPayments: number;
};

const metricLabels: Record<keyof DashboardMetrics, string> = {
  activeRequestsCount: "Active Requests",
  availableTechniciansCount: "Available Technicians",
  completedToday: "Completed Today",
  avgResponseTime: "Avg Response (min)",
  todayRevenue: "Today Revenue",
  pendingPayments: "Pending Payments",
};

export default function AdminExtendedDashboardPage() {
  const metricsQuery = useQuery({
    queryKey: ["adminExtended", "dashboard"],
    queryFn: () => adminExtendedApiRequest<DashboardMetrics>("/dashboard"),
  });

  return (
    <AdminExtendedShell title="Admin Extended Dashboard" subtitle="Read-only pilot metrics">
      {metricsQuery.isPending ? <p>Loading dashboard metrics...</p> : null}
      {metricsQuery.error ? <p>{(metricsQuery.error as Error).message}</p> : null}

      {metricsQuery.data ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
          {Object.entries(metricsQuery.data).map(([key, value]) => (
            <article key={key} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
              <h3 style={{ marginTop: 0 }}>{metricLabels[key as keyof DashboardMetrics]}</h3>
              <p style={{ fontSize: 24, margin: 0 }}>{Number(value)}</p>
            </article>
          ))}
        </div>
      ) : null}
    </AdminExtendedShell>
  );
}

