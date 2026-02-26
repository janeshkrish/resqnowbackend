import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { adminExtendedApiRequest } from "./api/adminExtendedApi";
import { AdminExtendedShell } from "./components/AdminExtendedShell";

type ComplaintRow = {
  id: number;
  title: string;
  severity: string;
  status: string;
  assigned_admin_id: string | null;
};

export default function AdminExtendedComplaintsPage() {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [complaintId, setComplaintId] = useState("");
  const [assignedAdminId, setAssignedAdminId] = useState("");
  const [note, setNote] = useState("");
  const queryClient = useQueryClient();

  const complaintsQuery = useQuery({
    queryKey: ["adminExtended", "complaints", "list"],
    queryFn: () => adminExtendedApiRequest<{ complaints: ComplaintRow[] }>("/complaints?limit=50"),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      adminExtendedApiRequest("/complaints", {
        method: "POST",
        body: { title, description, severity: "medium" },
      }),
    onSuccess: () => {
      setTitle("");
      setDescription("");
      void queryClient.invalidateQueries({ queryKey: ["adminExtended", "complaints", "list"] });
    },
  });

  const assignMutation = useMutation({
    mutationFn: () =>
      adminExtendedApiRequest(`/complaints/${Number(complaintId)}/assign`, {
        method: "POST",
        body: { assignedAdminId, note },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["adminExtended", "complaints", "list"] });
    },
  });

  const resolveMutation = useMutation({
    mutationFn: () =>
      adminExtendedApiRequest(`/complaints/${Number(complaintId)}/resolve`, {
        method: "POST",
        body: { resolutionNote: note },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["adminExtended", "complaints", "list"] });
    },
  });

  const noteMutation = useMutation({
    mutationFn: () =>
      adminExtendedApiRequest(`/complaints/${Number(complaintId)}/internal-note`, {
        method: "POST",
        body: { note },
      }),
  });

  const onCreateSubmit = (event: FormEvent) => {
    event.preventDefault();
  };

  return (
    <AdminExtendedShell title="Complaint / Incident Module" subtitle="Standalone complaint workflow">
      <form onSubmit={onCreateSubmit} style={{ display: "grid", gap: 8, maxWidth: 540 }}>
        <input
          placeholder="Complaint title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
        />
        <textarea
          placeholder="Description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <button type="button" onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>
          Create Complaint
        </button>
      </form>

      <hr />

      <div style={{ display: "grid", gap: 8, maxWidth: 540 }}>
        <input
          placeholder="Complaint ID"
          value={complaintId}
          onChange={(event) => setComplaintId(event.target.value)}
        />
        <input
          placeholder="Assigned Admin ID"
          value={assignedAdminId}
          onChange={(event) => setAssignedAdminId(event.target.value)}
        />
        <textarea placeholder="Note" value={note} onChange={(event) => setNote(event.target.value)} />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={() => assignMutation.mutate()} disabled={assignMutation.isPending}>
            Assign
          </button>
          <button type="button" onClick={() => resolveMutation.mutate()} disabled={resolveMutation.isPending}>
            Resolve
          </button>
          <button type="button" onClick={() => noteMutation.mutate()} disabled={noteMutation.isPending}>
            Add Internal Note
          </button>
        </div>
      </div>

      {createMutation.error ? <p>{(createMutation.error as Error).message}</p> : null}
      {assignMutation.error ? <p>{(assignMutation.error as Error).message}</p> : null}
      {resolveMutation.error ? <p>{(resolveMutation.error as Error).message}</p> : null}
      {noteMutation.error ? <p>{(noteMutation.error as Error).message}</p> : null}

      <h2>Complaints</h2>
      {complaintsQuery.isPending ? <p>Loading complaints...</p> : null}
      {complaintsQuery.error ? <p>{(complaintsQuery.error as Error).message}</p> : null}
      <ul>
        {(complaintsQuery.data?.complaints || []).map((item) => (
          <li key={item.id}>
            #{item.id} - {item.title} - {item.severity} - {item.status}
            {item.assigned_admin_id ? ` (assigned to ${item.assigned_admin_id})` : ""}
          </li>
        ))}
      </ul>
    </AdminExtendedShell>
  );
}

