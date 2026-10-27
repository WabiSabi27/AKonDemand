import { vi } from "vitest";

vi.mock("@expo/vector-icons", () => ({ Feather: () => null }));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn() }));
vi.mock("expo-router", () => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#fff", foreground: "#111", mutedForeground: "#555",
    card: "#fff", border: "#ddd", accent: "#a60", destructive: "#c00",
  }),
}));
vi.mock("@/context/AppContext", () => ({
  // Authentication is a boundary fixture, not a replacement query hook.
  // Screens still execute their real generated API hooks and React Query.
  useApp: () => ({
    user: { id: "test-provider", role: "business", name: "Test Provider" },
    businesses: [{
      id: "test-business", ownerId: "test-provider", name: "Test Business",
      employees: [], subscriptionPlan: "starter_gigger", subscriptionActive: true,
    }],
    services: [], bookings: [], categories: [], subscription: null,
    logout: vi.fn(), updateUser: vi.fn(), addService: vi.fn(), updateService: vi.fn(),
    deleteService: vi.fn(), addBusiness: vi.fn(), openSubscriptionCheckout: vi.fn(),
  }),
}));
