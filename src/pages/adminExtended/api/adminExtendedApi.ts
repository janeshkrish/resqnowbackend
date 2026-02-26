export const adminExtendedApiBase = "/api/admin-extended";

type AdminExtendedRequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
};

export function getAdminExtendedAuthToken(): string {
  return (
    window.localStorage.getItem("adminToken") ||
    window.localStorage.getItem("token") ||
    ""
  );
}

export async function adminExtendedApiRequest<TResponse>(
  path: string,
  options: AdminExtendedRequestOptions = {}
): Promise<TResponse> {
  const token = getAdminExtendedAuthToken();
  const response = await fetch(`${adminExtendedApiBase}${path}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: options.body == null ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  if (!response.ok) {
    const fallbackText = await response.text();
    let message = fallbackText || `Request failed with status ${response.status}`;
    try {
      const parsed = JSON.parse(fallbackText);
      message = parsed?.error || message;
    } catch {
      // plain text fallback already set
    }
    throw new Error(message);
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json() as Promise<TResponse>;
  }
  return (response.text() as unknown) as TResponse;
}

