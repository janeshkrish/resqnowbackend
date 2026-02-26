import { useMutation, useQuery } from "@tanstack/react-query";
import {
  adminExtendedApiBase,
  adminExtendedApiRequest,
  getAdminExtendedAuthToken,
} from "./api/adminExtendedApi";
import { AdminExtendedShell } from "./components/AdminExtendedShell";

type PaymentRow = {
  payment_id: number;
  service_request_id: number;
  payment_method: string;
  status: string;
  amount: number;
  created_at: string;
};

export default function AdminExtendedFinancePage() {
  const exportMutation = useMutation({
    mutationFn: async () => {
      const token = getAdminExtendedAuthToken();
      const response = await fetch(`${adminExtendedApiBase}/finance/export-payments-csv`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) {
        throw new Error("Failed to export payments CSV.");
      }
      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = `adminExtended_payments_${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(downloadUrl);
      return true;
    },
  });

  const transactionsQuery = useQuery({
    queryKey: ["adminExtended", "finance", "transactions"],
    queryFn: () =>
      adminExtendedApiRequest<{ transactionAuditList: PaymentRow[] }>("/finance/transaction-audit-list?limit=50"),
  });

  const flaggedQuery = useQuery({
    queryKey: ["adminExtended", "finance", "flagged"],
    queryFn: () => adminExtendedApiRequest<{ flaggedPayments: Array<PaymentRow & { flag_reason: string }> }>("/finance/flagged-payments"),
  });

  return (
    <AdminExtendedShell title="Payment Monitoring" subtitle="Read-only financial monitoring layer">
      <p>
        <button type="button" onClick={() => exportMutation.mutate()} disabled={exportMutation.isPending}>
          Export Payments CSV
        </button>
      </p>
      {exportMutation.error ? <p>{(exportMutation.error as Error).message}</p> : null}

      <h2>Flagged Payments</h2>
      {flaggedQuery.isPending ? <p>Loading flagged payments...</p> : null}
      {flaggedQuery.error ? <p>{(flaggedQuery.error as Error).message}</p> : null}
      <ul>
        {(flaggedQuery.data?.flaggedPayments || []).map((row) => (
          <li key={`flag-${row.payment_id}`}>
            #{row.payment_id} request #{row.service_request_id} - {row.flag_reason}
          </li>
        ))}
      </ul>

      <h2>Transaction Audit List</h2>
      {transactionsQuery.isPending ? <p>Loading transactions...</p> : null}
      {transactionsQuery.error ? <p>{(transactionsQuery.error as Error).message}</p> : null}
      <ul>
        {(transactionsQuery.data?.transactionAuditList || []).map((row) => (
          <li key={row.payment_id}>
            #{row.payment_id} - request #{row.service_request_id} - {row.payment_method} - {row.status} - {row.amount}
          </li>
        ))}
      </ul>
    </AdminExtendedShell>
  );
}
