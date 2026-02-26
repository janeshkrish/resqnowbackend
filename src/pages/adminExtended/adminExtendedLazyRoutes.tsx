import { lazy } from "react";
import { Navigate, type RouteObject } from "react-router-dom";

const AdminExtendedLayout = lazy(() => import("./AdminExtendedLayout"));
const AdminExtendedDashboardPage = lazy(() => import("./AdminExtendedDashboardPage"));
const AdminExtendedRequestsPage = lazy(() => import("./AdminExtendedRequestsPage"));
const AdminExtendedTechniciansPage = lazy(() => import("./AdminExtendedTechniciansPage"));
const AdminExtendedFinancePage = lazy(() => import("./AdminExtendedFinancePage"));
const AdminExtendedAnalyticsPage = lazy(() => import("./AdminExtendedAnalyticsPage"));
const AdminExtendedComplaintsPage = lazy(() => import("./AdminExtendedComplaintsPage"));
const AdminExtendedNotificationsPage = lazy(() => import("./AdminExtendedNotificationsPage"));

export const adminExtendedLazyRoutes: RouteObject[] = [
  {
    path: "/admin/extended",
    element: <AdminExtendedLayout />,
    children: [
      { index: true, element: <Navigate to="/admin/extended/dashboard" replace /> },
      { path: "dashboard", element: <AdminExtendedDashboardPage /> },
      { path: "requests", element: <AdminExtendedRequestsPage /> },
      { path: "technicians", element: <AdminExtendedTechniciansPage /> },
      { path: "finance", element: <AdminExtendedFinancePage /> },
      { path: "analytics", element: <AdminExtendedAnalyticsPage /> },
      { path: "complaints", element: <AdminExtendedComplaintsPage /> },
      { path: "notifications", element: <AdminExtendedNotificationsPage /> },
    ],
  },
];

