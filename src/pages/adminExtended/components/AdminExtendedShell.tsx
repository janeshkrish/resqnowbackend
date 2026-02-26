import { PropsWithChildren } from "react";

type AdminExtendedShellProps = PropsWithChildren<{
  title: string;
  subtitle?: string;
}>;

export function AdminExtendedShell({ title, subtitle, children }: AdminExtendedShellProps) {
  return (
    <section style={{ padding: 16 }}>
      <header style={{ marginBottom: 12 }}>
        <h1 style={{ margin: "0 0 8px 0" }}>{title}</h1>
        {subtitle ? <p style={{ margin: 0, opacity: 0.8 }}>{subtitle}</p> : null}
      </header>
      <div>{children}</div>
    </section>
  );
}

