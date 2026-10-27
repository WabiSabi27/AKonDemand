import React, { type ReactElement } from "react";
import { act, render } from "@testing-library/react";
import { focusManager, notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setAuthTokenGetter, setBaseUrl } from "@workspace/api-client-react";
import { vi } from "vitest";

export function renderDashboard(screen: ReactElement) {
  setBaseUrl("https://api.example.test");
  setAuthTokenGetter(() => "synthetic-test-session");
  focusManager.setFocused(true);
  // Flush real query observer updates inside act without an extra timer tick
  // shifting the exact 60-second polling boundary under fake timers.
  notifyManager.setScheduler(queueMicrotask);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return {
    client,
    ...render(<QueryClientProvider client={client}>{screen}</QueryClientProvider>),
  };
}

export function mockApi(path: string, getPayload: () => unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) !== `https://api.example.test${path}`) {
      throw new Error(`Unexpected test request: ${String(input)}`);
    }
    return new Response(JSON.stringify(getPayload()), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export async function advance(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  // React Query batches observer notifications through a zero-delay timeout.
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}
