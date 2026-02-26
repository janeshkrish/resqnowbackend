import { NavLink, Outlet } from "react-router-dom";

const adminExtendedNavItems = [
  { to: "/admin/extended/dashboard", label: "Dashboard" },
  { to: "/admin/extended/requests", label: "Requests" },
  { to: "/admin/extended/technicians", label: "Technicians" },
  { to: "/admin/extended/finance", label: "Finance" },
  { to: "/admin/extended/analytics", label: "Analytics" },
  { to: "/admin/extended/complaints", label: "Complaints" },
  { to: "/admin/extended/notifications", label: "Notifications" },
];

export default function AdminExtendedLayout() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", minHeight: "100vh" }}>
      <aside style={{ borderRight: "1px solid #ddd", padding: 12 }}>
        <h2 style={{ marginTop: 0 }}>Admin Tools (Extended)</h2>
        <nav style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {adminExtendedNavItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              style={({ isActive }) => ({
                textDecoration: "none",
                padding: "8px 10px",
                borderRadius: 6,
                background: isActive ? "#e5eefc" : "transparent",
              })}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

