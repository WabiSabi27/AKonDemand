import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  type AuthUser,
  type BizAccount as ApiBizAccount,
  type BlockedSlot as ApiBlockedSlot,
  type Booking as ApiBooking,
  type Business as ApiBusiness,
  type MySubscriptionResponse,
  type PlanTier,
  type Service as ApiService,
  type ServiceOption as ApiServiceOption,
  type CreateServiceOptionRequest,
  type Notification as ApiNotification,
  createBooking as apiCreateBooking,
  createMySubscriptionCheckout,
  createReview as apiCreateReview,
  createService as apiCreateService,
  decideBookingRefundRequest as apiDecideRefundRequest,
  deleteService as apiDeleteService,
  getCurrentUser,
  getGetMySubscriptionQueryKey,
  getGetServiceQueryKey,
  getListBizAccountsQueryKey,
  getGetAvailabilityQueryKey,
  getListBlockedSlotsQueryKey,
  getListBookingsQueryKey,
  getListBusinessesQueryKey,
  getListCategoriesQueryKey,
  getListNotificationsQueryKey,
  getListServicesQueryKey,
  listPendingRefundRequests as apiListPendingRefundRequests,
  getListPendingRefundRequestsQueryKey,
  loginAdmin as apiLoginAdmin,
  requestBookingRefund as apiRequestBookingRefund,
  loginBusiness as apiLoginBusiness,
  loginCustomer as apiLoginCustomer,
  approveBizAccount as apiApproveBizAccount,
  acceptBizAccount as apiAcceptBizAccount,
  updateBizAccount as apiUpdateBizAccount,
  rejectBizAccount as apiRejectBizAccount,
  createBlockedSlot as apiCreateBlockedSlot,
  deleteBlockedSlot as apiDeleteBlockedSlot,
  updateMyBusiness as apiUpdateMyBusiness,
  markAllNotificationsRead as apiMarkAllRead,
  markNotificationRead as apiMarkRead,
  updateBookingStatus as apiUpdateBookingStatus,
  updateService as apiUpdateService,
  useGetMySubscription,
  useListBizAccounts,
  useListBlockedSlots,
  useListBookings,
  useListBusinesses,
  useListCategories,
  useListNotifications,
  useListPendingRefundRequests,
  useListServices,
} from "@workspace/api-client-react";
import * as WebBrowser from "expo-web-browser";
import React, { createContext, useContext, useEffect, useState } from "react";

import { getToken, setToken } from "@/utils/authStorage";
import {
  clearPushTokenOnServer,
  registerForPushNotificationsAsync,
} from "@/utils/pushNotifications";

export type UserRole = "customer" | "business" | "admin";

/**
 * Status returned to login.tsx when an SP attempts to sign in but their account
 * is not yet approved. Lets the UI route to the right "pending"/"rejected" screen
 * without inspecting raw HTTP errors.
 */
export type BusinessLoginResult =
  | { ok: true }
  | { ok: false; reason: "invalid"; message: string }
  | { ok: false; reason: "pending" | "rejected" | "awaiting_payment" | "accepted"; message: string; bizAccountId?: string };

const ACCOUNT_STATUS_PREFIX = "Account status: ";

// ── Mobile-side type definitions (kept stable so screens don't change) ──
// At the boundary we map server shapes (decimal-as-string, nullable fields) into
// these mobile shapes; see the `map*` helpers below.

export interface ServiceEntry {
  id: string;
  name: string;
  description?: string;
  cost: string;
}

export interface BizAccount {
  id: string;
  name: string;             // kept for display compat — set to businessName
  businessName: string;
  ownerName: string;
  phone: string;
  email: string;
  password: string;         // legacy field; never re-read post T006c (server is source of truth)
  businessType: "brick-and-mortar" | "home-based";
  yearsInBusiness: string;  // "New Business" or a number string
  alaskaLicenseNumber: string;
  businessDescription: string;
  services: ServiceEntry[]; // legacy SP-application proposed-services list; not surfaced
  status: "awaiting_payment" | "pending" | "accepted" | "approved" | "rejected";
  appliedAt: string;
  expiresAt: string;
  stripeSessionId?: string;
  ownerId?: string;
  /** In-person meeting time (ISO string) scheduled by the admin after acceptance. */
  meetingAt?: string;
  /** Where the in-person meeting takes place (address or notes). */
  meetingLocation?: string;
  /** Meeting length in minutes (default 60). */
  meetingDurationMinutes?: number;
}

export interface BlockedSlot {
  id: string;
  businessId: string;
  date: string;       // YYYY-MM-DD
  allDay: boolean;
  startTime?: string; // HH:MM (24-hour)
  endTime?: string;   // HH:MM (24-hour)
  label?: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  businessId?: string;
}

export interface Review {
  id: string;
  authorName: string;
  rating: number;
  comment: string;
  date: string;
}

export interface ServiceOption {
  id: string;
  name: string;
  description: string;
  price: number;
  duration: string;
  /** SP-pinned HH:MM 24h start time for long-duration options. Undefined = no override. */
  defaultStartTime?: string;
}

export interface Service {
  id: string;
  businessId: string;
  businessName: string;
  categoryId: string;
  title: string;
  description: string;
  rating: number;
  reviewCount: number;
  startingPrice: number;
  options: ServiceOption[];
  tags: string[];
  featured: boolean;
  /** Empty on list-derived Services; populated only via `useGetService(id)`. */
  reviews: Review[];
  requiredSpecialty?: string;  // optional — limits which employees can perform
}

export interface BusinessHours {
  workDays: number[];  // 0=Sun, 1=Mon … 6=Sat
  startHour: number;  // 0–23
  endHour: number;    // 0–23 (must be > startHour)
}

export interface Business {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  categoryId: string;
  logoUrl?: string;
  coverUrl?: string;
  rating: number;
  reviewCount: number;
  subscriptionActive: boolean;
  subscriptionPlan: PlanTier;
  phone: string;
  location: string;
  joinedDate: string;
  serviceCount: number;
  hours?: BusinessHours;
  employees?: { specialty?: string }[];
  /** Stripe Connect account state, mirrored from /me/stripe/connect/account
   *  webhooks. Drives the customer-facing "Book Now" gate. */
  stripeAccountStatus: "none" | "pending" | "active" | "restricted";
  stripePayoutsEnabled: boolean;
  /** Phase 3 #7 — Cancellation policy. SP-editable; defaults are 24h full /
   *  2h partial / 50%. Snapshot is taken onto each booking at creation, but
   *  the live values here drive the customer-facing policy summary on the
   *  service detail and checkout screens. */
  cancellationFullRefundHours: number;
  cancellationPartialRefundHours: number;
  cancellationPartialRefundPercent: number;
  /** Phase 3 #3 — Vacation/OOO window. Both dates set together (YYYY-MM-DD,
   *  inclusive) when SP is on vacation, both undefined when not. The optional
   *  message is shown verbatim on customer-facing OOO banners. */
  vacationFrom?: string;
  vacationUntil?: string;
  vacationMessage?: string;
}

export interface Booking {
  id: string;
  customerId: string;
  customerName: string;
  serviceId: string;
  businessId: string;
  businessName: string;
  serviceTitle: string;
  optionName: string;
  price: number;
  platformFee: number;
  total: number;
  status: "pending" | "confirmed" | "completed" | "cancelled";
  scheduledDate: string;
  scheduledTime?: string;     // "HH:MM" 24-hour, optional for legacy bookings
  durationMinutes?: number;   // booking duration for capacity overlap checks
  createdAt: string;
  /** True once the customer has left a review for this booking. */
  reviewed: boolean;
  /** Stripe PaymentIntent that funded this booking; undefined for legacy/free bookings. */
  paymentIntentId?: string;
  /** Stripe Refund id, set when the booking has been refunded. */
  refundId?: string;
  refundedAt?: string;
  // Phase 3 #2 — refund request lifecycle. `refundRequestedAt` set means the
  // customer asked. `refundDecision` flips to "approved"/"denied" when admin
  // arbitrates; for "approved" the refundId/refundedAt above also get filled
  // and status flips to "cancelled".
  refundRequestedAt?: string;
  refundReason?: string;
  refundDecision?: "approved" | "denied";
  refundDecidedAt?: string;
  refundDecisionReason?: string;
  // Phase 3 #2 — Stripe dispute (chargeback) tracking
  disputeId?: string;
  disputeStatus?: string;
  disputeCreatedAt?: string;
  // Phase 3 #7 — Cancellation policy snapshot + applied refund.
  // Snapshot fields are taken at booking creation; null on legacy bookings.
  // `cancellationRefundCents` is set by the customer-cancel flow:
  //   number > 0 → partial/full refund issued under policy
  //   0           → policy applied but inside no-refund window
  //   undefined   → cancelled by SP/admin (separate refund flow) or not cancelled
  cancellationFullRefundHours?: number;
  cancellationPartialRefundHours?: number;
  cancellationPartialRefundPercent?: number;
  cancellationRefundCents?: number;
}

export type NotificationKind =
  | "booking_created"
  | "booking_confirmed"
  | "booking_completed"
  | "booking_cancelled"
  | "booking_payment_failed"
  | "booking_refunded"
  | "refund_requested"
  | "refund_approved"
  | "refund_denied"
  | "dispute_opened"
  | "dispute_closed"
  | "message_received";

export interface Notification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  bookingId?: string;
  read: boolean;
  createdAt: string;
}

export interface CreateBookingInput {
  serviceId: string;
  optionId: string;
  scheduledDate: string;        // YYYY-MM-DD
  scheduledTime?: string | null; // HH:MM 24h, omit for ongoing services
}

export interface CreateReviewInput {
  bookingId: string;
  rating: number;            // 1–5
  comment?: string;
}

export interface Category {
  id: string;
  name: string;
  icon: string;
  color: string;
  serviceCount: number;
  active: boolean;
}

interface AppContextType {
  user: User | null;
  /** Frictionless email+name customer signup-or-login. Throws on network error. */
  loginCustomer: (email: string, name: string) => Promise<void>;
  /**
   * SP login. Returns a discriminated result so the UI can show the right
   * pending/rejected screen without parsing raw errors. Network failures still
   * throw so the caller can show a generic error.
   */
  loginBusiness: (email: string, password: string) => Promise<BusinessLoginResult>;
  /**
   * Admin login via email + bcrypt password (+ optional TOTP code).
   * Throws ApiError(401) on bad credentials, ApiError(423) on lockout
   * (`data.retryAfterSeconds` carries the wait time), or rethrows network errors.
   */
  loginAdmin: (args: { email: string; password: string; totpCode?: string }) => Promise<void>;
  logout: () => Promise<void>;
  updateUser: (updates: Partial<User>) => Promise<void>;
  bookings: Booking[];
  /** Server-backed booking creation. Returns the persisted booking. */
  createBooking: (input: CreateBookingInput) => Promise<Booking>;
  cancelBooking: (bookingId: string) => Promise<void>;
  updateBookingStatus: (bookingId: string, status: Booking["status"]) => Promise<void>;
  /**
   * Phase 3 #2 — customer asks for a refund. Throws ApiError(409) if a
   * request is already on file, ApiError(400) if not eligible.
   */
  requestRefund: (bookingId: string, reason: string) => Promise<void>;
  /** Phase 3 #2 — admin approves or denies. Approval triggers the Stripe refund. */
  decideRefundRequest: (
    bookingId: string,
    decision: "approved" | "denied",
    reason?: string,
  ) => Promise<void>;
  /** Phase 3 #2 — admin queue of pending refund requests. */
  pendingRefundRequests: Booking[];
  /**
   * Customer leaves a 1–5 star review for a completed booking.
   * Throws ApiError(409) if a review already exists for the booking.
   */
  createReview: (input: CreateReviewInput) => Promise<void>;
  notifications: Notification[];
  unreadNotificationCount: number;
  markNotificationRead: (notificationId: string) => Promise<void>;
  markAllNotificationsRead: () => Promise<void>;
  categories: Category[];
  addCategory: (category: Category) => Promise<void>;
  removeCategory: (categoryId: string) => Promise<void>;
  services: Service[];
  addService: (service: Service) => Promise<void>;
  updateService: (service: Service) => Promise<void>;
  deleteService: (serviceId: string) => Promise<void>;
  businesses: Business[];
  addBusiness: (business: Business) => Promise<void>;
  updateBusiness: (id: string, updates: Partial<Business>) => Promise<void>;
  bizAccounts: BizAccount[];
  acceptProvider: (id: string) => Promise<void>;
  approveProvider: (id: string) => Promise<void>;
  /** Admin schedules/reschedules the in-person meeting (ISO string; "" clears it). */
  scheduleMeeting: (
    id: string,
    meetingAt: string,
    opts?: { location?: string; durationMinutes?: number },
  ) => Promise<void>;
  rejectProvider: (id: string, reason?: string) => Promise<void>;
  blockedSlots: BlockedSlot[];
  addBlockedSlot: (slot: BlockedSlot) => Promise<void>;
  addBlockedSlots: (slots: BlockedSlot[]) => Promise<void>;
  removeBlockedSlot: (slotId: string) => Promise<void>;
  /** Live SP plan + usage snapshot. Null while loading or for non-business roles. */
  subscription: MySubscriptionResponse | null;
  /** Opens Stripe Checkout for the chosen plan in an in-app browser, then refetches subscription/businesses on return. */
  openSubscriptionCheckout: (plan: PlanTier) => Promise<void>;
  isLoading: boolean;
}

const AppContext = createContext<AppContextType | null>(null);

const PLATFORM_FEE_PERCENT = 0.08;
// Server uses integer-cent math (Math.round(priceCents * 800 / 10_000)). We
// mirror that here so the total displayed at checkout matches what Stripe
// actually charges down to the penny — float math like price * 0.08 rounds
// off-by-1¢ at certain price points (e.g. $10.06).
export const PLATFORM_FEE_PERCENT_DISPLAY = 8;

export function calculateFees(price: number) {
  const priceCents = Math.round(price * 100);
  const platformFeeCents = Math.round((priceCents * 800) / 10_000);
  const platformFee = platformFeeCents / 100;
  const total = (priceCents + platformFeeCents) / 100;
  return { platformFee, total };
}

// ── Server → mobile mappers ─────────────────────────────────────────────
// Server uses decimal-as-string for money/ratings and `string | null` for
// optional fields; mobile screens want `number` and `undefined`. Keep the
// mapping centralised so changes to the API contract show up in one place.

function mapServiceOption(o: ApiServiceOption): ServiceOption {
  return {
    id: o.id,
    name: o.name,
    description: o.description,
    price: parseFloat(o.price),
    duration: o.duration,
    defaultStartTime: o.defaultStartTime ?? undefined,
  };
}

export function mapService(s: ApiService, reviews: Review[] = []): Service {
  return {
    id: s.id,
    businessId: s.businessId,
    businessName: s.businessName,
    categoryId: s.categoryId,
    title: s.title,
    description: s.description,
    rating: parseFloat(s.rating),
    reviewCount: s.reviewCount,
    startingPrice: parseFloat(s.startingPrice),
    options: s.options.map(mapServiceOption),
    tags: s.tags,
    featured: s.featured,
    reviews,
    requiredSpecialty: s.requiredSpecialty ?? undefined,
  };
}

export function mapBusiness(b: ApiBusiness): Business {
  return {
    id: b.id,
    ownerId: b.ownerId,
    name: b.name,
    description: b.description,
    categoryId: b.categoryId,
    logoUrl: b.logoUrl ?? undefined,
    coverUrl: b.coverUrl ?? undefined,
    rating: parseFloat(b.rating),
    reviewCount: b.reviewCount,
    subscriptionActive: b.subscriptionActive,
    subscriptionPlan: b.subscriptionPlan,
    phone: b.phone,
    location: b.location,
    joinedDate: b.joinedDate,
    serviceCount: b.serviceCount,
    hours: b.hours ?? undefined,
    employees: b.employees.map((e) => ({ specialty: e.specialty ?? undefined })),
    stripeAccountStatus: b.stripeAccountStatus,
    stripePayoutsEnabled: b.stripePayoutsEnabled,
    vacationFrom: b.vacationFrom ?? undefined,
    vacationUntil: b.vacationUntil ?? undefined,
    vacationMessage: b.vacationMessage ?? undefined,
    cancellationFullRefundHours: b.cancellationFullRefundHours,
    cancellationPartialRefundHours: b.cancellationPartialRefundHours,
    cancellationPartialRefundPercent: b.cancellationPartialRefundPercent,
  };
}

/**
 * Phase 3 #3 — true if the business is on vacation as of `date` (default
 * today, in the device's local time). Used by customer screens to gate
 * booking and render OOO banners.
 */
export function isOnVacation(
  biz: Pick<Business, "vacationFrom" | "vacationUntil"> | null | undefined,
  date?: string,
): boolean {
  if (!biz?.vacationFrom || !biz?.vacationUntil) return false;
  const d = date ?? (() => {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  })();
  return d >= biz.vacationFrom && d <= biz.vacationUntil;
}

function mapNotification(n: ApiNotification): Notification {
  return {
    id: n.id,
    kind: n.kind,
    title: n.title,
    body: n.body,
    bookingId: n.bookingId ?? undefined,
    read: !!n.readAt,
    createdAt: n.createdAt,
  };
}

function mapBooking(b: ApiBooking): Booking {
  return {
    id: b.id,
    customerId: b.customerId,
    customerName: b.customerName,
    serviceId: b.serviceId,
    businessId: b.businessId,
    businessName: b.businessName,
    serviceTitle: b.serviceTitle,
    optionName: b.optionName,
    price: parseFloat(b.price),
    platformFee: parseFloat(b.platformFee),
    total: parseFloat(b.total),
    status: b.status,
    scheduledDate: b.scheduledDate,
    scheduledTime: b.scheduledTime ?? undefined,
    durationMinutes: b.durationMinutes ?? undefined,
    createdAt: b.createdAt,
    reviewed: b.reviewed,
    paymentIntentId: b.paymentIntentId ?? undefined,
    refundId: b.refundId ?? undefined,
    refundedAt: b.refundedAt ?? undefined,
    refundRequestedAt: b.refundRequestedAt ?? undefined,
    refundReason: b.refundReason ?? undefined,
    refundDecision: b.refundDecision ?? undefined,
    refundDecidedAt: b.refundDecidedAt ?? undefined,
    refundDecisionReason: b.refundDecisionReason ?? undefined,
    disputeId: b.disputeId ?? undefined,
    disputeStatus: b.disputeStatus ?? undefined,
    disputeCreatedAt: b.disputeCreatedAt ?? undefined,
    cancellationFullRefundHours: b.cancellationFullRefundHours ?? undefined,
    cancellationPartialRefundHours: b.cancellationPartialRefundHours ?? undefined,
    cancellationPartialRefundPercent: b.cancellationPartialRefundPercent ?? undefined,
    cancellationRefundCents: b.cancellationRefundCents ?? undefined,
  };
}

export function mapBlockedSlot(s: ApiBlockedSlot): BlockedSlot {
  return {
    id: s.id,
    businessId: s.businessId,
    date: s.date,
    allDay: s.allDay,
    startTime: s.startTime ?? undefined,
    endTime: s.endTime ?? undefined,
    label: s.label ?? undefined,
  };
}

function mapBizAccount(a: ApiBizAccount): BizAccount {
  // Server intentionally omits `password` (security) and `name`/`services`
  // (legacy display alias + SP-application proposed-services list). No screen
  // reads those fields post-T006c; defaults preserve the type contract.
  return {
    id: a.id,
    name: a.businessName,
    businessName: a.businessName,
    ownerName: a.ownerName,
    phone: a.phone,
    email: a.email,
    password: "",
    businessType: a.businessType,
    yearsInBusiness: a.yearsInBusiness,
    alaskaLicenseNumber: a.alaskaLicenseNumber,
    businessDescription: a.businessDescription,
    services: [],
    status: a.status,
    appliedAt: a.appliedAt,
    expiresAt: a.expiresAt,
    stripeSessionId: a.stripeSessionId ?? undefined,
    ownerId: a.ownerId ?? undefined,
    meetingAt: a.meetingAt ?? undefined,
    meetingLocation: a.meetingLocation || undefined,
    meetingDurationMinutes: a.meetingDurationMinutes,
  };
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [user, setUserState] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const queryClient = useQueryClient();

  const role = user?.role;
  const userId = user?.id;
  const businessId = user?.businessId;

  // ── Read paths via React Query ────────────────────────────────────────
  // Public catalog: always fetched. Auth-gated lists (bookings, blockedSlots,
  // bizAccounts) use `enabled` so they only fire after a matching login.
  const categoriesQ = useListCategories();
  const businessesQ = useListBusinesses();
  const servicesQ = useListServices();

  // Customer: their own bookings. SP: every booking for their business.
  // Two queries (with mutually exclusive `enabled` flags) so each user sees
  // exactly one slice of the bookings table; we then merge into one array.
  // The orval-generated `query` option requires `queryKey` even though the
  // function would derive a sensible default; we mirror the helper's key.
  const customerBookingParams = { customerId: userId ?? "" };
  const customerBookingsQ = useListBookings(customerBookingParams, {
    query: {
      queryKey: getListBookingsQueryKey(customerBookingParams),
      enabled: role === "customer" && !!userId,
    },
  });
  const businessBookingParams = { businessId: businessId ?? "" };
  const businessBookingsQ = useListBookings(businessBookingParams, {
    query: {
      queryKey: getListBookingsQueryKey(businessBookingParams),
      enabled: role === "business" && !!businessId,
    },
  });
  const blockedSlotsParams = { businessId: businessId ?? "" };
  const blockedSlotsQ = useListBlockedSlots(blockedSlotsParams, {
    query: {
      queryKey: getListBlockedSlotsQueryKey(blockedSlotsParams),
      enabled: role === "business" && !!businessId,
    },
  });
  // Admin queue: pending applications need review. Keep filterless so the
  // admin screen can client-side-filter; we'll move filtering server-side
  // when the screen UX demands it.
  const bizAccountsQ = useListBizAccounts(undefined, {
    query: {
      queryKey: getListBizAccountsQueryKey(),
      enabled: role === "admin",
    },
  });
  // Phase 3 #2: admin refund queue. Polled the same as notifications so the
  // tab badge stays roughly fresh without manual pull-to-refresh.
  const pendingRefundsQ = useListPendingRefundRequests({
    query: {
      queryKey: getListPendingRefundRequestsQueryKey(),
      enabled: role === "admin",
      refetchInterval: 30_000,
    },
  });
  // Notifications: enabled for any logged-in user. Refetch on a short interval
  // so the bell badge updates without manual pull-to-refresh.
  const notificationsQ = useListNotifications({
    query: {
      queryKey: getListNotificationsQueryKey(),
      enabled: !!userId,
      refetchInterval: 30_000,
    },
  });
  // Subscription snapshot for SPs only — drives the dashboard plan card and
  // the upgrade gate when they hit the listing cap.
  const subscriptionQ = useGetMySubscription({
    query: {
      queryKey: getGetMySubscriptionQueryKey(),
      enabled: role === "business",
    },
  });

  // Map server shapes → mobile shapes at the boundary.
  const categories = (categoriesQ.data ?? []).filter((c) => c.active);
  const services = (servicesQ.data ?? []).map((s) => mapService(s));
  const businesses = (businessesQ.data ?? []).map(mapBusiness);
  const bookings = [
    ...(customerBookingsQ.data ?? []),
    ...(businessBookingsQ.data ?? []),
  ].map(mapBooking);
  const blockedSlots = (blockedSlotsQ.data ?? []).map(mapBlockedSlot);
  const bizAccounts = (bizAccountsQ.data ?? []).map(mapBizAccount);
  const pendingRefundRequests = (pendingRefundsQ.data ?? []).map(mapBooking);
  const notifications = (notificationsQ.data ?? []).map(mapNotification);
  const unreadNotificationCount = notifications.reduce((acc, n) => acc + (n.read ? 0 : 1), 0);

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadData() {
    // Restore session via /auth/me. On 401 (token revoked / user deleted) we
    // clear the token and proceed unauthenticated. If no token exists at all
    // we skip the network call entirely and stay logged out — restoring a
    // cached user without a token would leave role-gated queries firing with
    // no Authorization header. On a transient network failure we leave the
    // user null; the next launch will retry. We deliberately do NOT cache the
    // user object locally: the app is fully server-driven so an offline launch
    // is unusable anyway, and a stale cached user would mask a deletion.
    const token = await getToken().catch(() => null);
    if (!token) {
      setIsLoading(false);
      return;
    }
    try {
      const { user: meUser } = await getCurrentUser();
      setUserState({
        id: meUser.id,
        name: meUser.name,
        email: meUser.email,
        role: meUser.role,
        businessId: meUser.businessId ?? undefined,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        await setToken(null);
      }
      // Other errors (network, 5xx): leave user null, next launch retries.
    }
    setIsLoading(false);
  }

  /** Persist token + user, set state, invalidate cached queries. Used by all three login flows. */
  async function applyAuth(token: string, serverUser: AuthUser) {
    await setToken(token);
    const newUser: User = {
      id: serverUser.id,
      name: serverUser.name,
      email: serverUser.email,
      role: serverUser.role as UserRole,
      businessId: serverUser.businessId ?? undefined,
    };
    setUserState(newUser);
    // Drop any stale cached read so the next render fires fresh queries with
    // the new identity (auth-gated reads also flip from disabled → enabled).
    await queryClient.invalidateQueries();
    // Best-effort: ask permission and register an Expo push token. Wrapped in
    // its own try/catch so a denied permission can't fail the login.
    void registerForPushNotificationsAsync();
  }

  async function loginCustomer(email: string, name: string) {
    const { token, user: u } = await apiLoginCustomer({ email, name });
    await applyAuth(token, u);
  }

  async function loginBusiness(email: string, password: string): Promise<BusinessLoginResult> {
    try {
      const { token, user: u } = await apiLoginBusiness({ email, password });
      await applyAuth(token, u);
      return { ok: true };
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          return { ok: false, reason: "invalid", message: "Invalid email or password" };
        }
        if (err.status === 403) {
          // Server returns `{ error: "Account status: pending" }` etc. Parse the
          // suffix back into our typed reason so the UI can branch cleanly.
          const data = err.data as { error?: string; bizAccountId?: string } | null;
          const raw = data?.error ?? "";
          const status = raw.startsWith(ACCOUNT_STATUS_PREFIX) ? raw.slice(ACCOUNT_STATUS_PREFIX.length).trim() : "";
          if (status === "pending" || status === "rejected" || status === "awaiting_payment" || status === "accepted") {
            return { ok: false, reason: status, message: raw, bizAccountId: data?.bizAccountId };
          }
        }
      }
      throw err;
    }
  }

  async function loginAdmin(args: { email: string; password: string; totpCode?: string }) {
    const body: { email: string; password: string; totpCode?: string } = {
      email: args.email.trim().toLowerCase(),
      password: args.password,
    };
    if (args.totpCode && args.totpCode.trim().length > 0) {
      body.totpCode = args.totpCode.trim();
    }
    const { token, user: u } = await apiLoginAdmin(body);
    await applyAuth(token, u);
  }

  async function logout() {
    // Best-effort clear of the server-side push token BEFORE we drop the auth
    // header so the request still goes out authenticated. Failure is fine —
    // the token will be replaced on the next login.
    await clearPushTokenOnServer();
    setUserState(null);
    await setToken(null);
    // Drop every cached query so the next session starts clean.
    queryClient.clear();
  }

  async function updateUser(updates: Partial<User>) {
    if (!user) return;
    const updated = { ...user, ...updates };
    setUserState(updated);
  }

  // ── Write paths: T006d STUBS ──────────────────────────────────────────
  // The legacy local-state slices are gone. Each write logs and invalidates
  // the matching query so the cache re-fetches authoritative server data on
  // the next render. T007 replaces these with proper mutation calls (the
  // generated `createBooking`/`updateBookingStatus`/etc. exist; the screens
  // need refactoring to pass server-shape bodies).
  function deferredWrite(name: string) {
    return (queryKey: readonly unknown[]) => {
      console.warn(`[T007] ${name} not yet wired to server mutation; invalidating ${String(queryKey[0])}`);
      return queryClient.invalidateQueries({ queryKey });
    };
  }

  async function createBooking(input: CreateBookingInput): Promise<Booking> {
    // POST /bookings — server denormalises every field (price, fee, total,
    // businessId, businessName, optionName, durationMinutes) so we just send
    // the IDs + scheduling info.
    const created = await apiCreateBooking({
      serviceId: input.serviceId,
      optionId: input.optionId,
      scheduledDate: input.scheduledDate,
      scheduledTime: input.scheduledTime ?? null,
    });
    // Refresh the customer's bookings list AND the SP's notification feed (the
    // SP just got a "new booking request" notification).
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getListBookingsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getListNotificationsQueryKey() }),
    ]);
    return mapBooking(created);
  }
  async function cancelBooking(bookingId: string): Promise<void> {
    await apiUpdateBookingStatus(bookingId, { status: "cancelled" });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getListBookingsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getListNotificationsQueryKey() }),
    ]);
  }

  // ── Phase 3 #2 — refund request flow ──────────────────────────────────
  async function requestRefund(bookingId: string, reason: string): Promise<void> {
    await apiRequestBookingRefund(bookingId, { reason });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getListBookingsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getListNotificationsQueryKey() }),
    ]);
  }
  async function decideRefundRequest(
    bookingId: string,
    decision: "approved" | "denied",
    reason?: string,
  ): Promise<void> {
    // Server enforces that `reason` is required for denials. We pass it
    // through verbatim — the form layer should already have asked for it.
    await apiDecideRefundRequest(
      bookingId,
      decision === "denied"
        ? { decision: "denied", reason: reason ?? "" }
        : { decision: "approved", ...(reason ? { reason } : {}) },
    );
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getListBookingsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getListNotificationsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getListPendingRefundRequestsQueryKey() }),
    ]);
  }
  async function updateBookingStatus(bookingId: string, status: Booking["status"]): Promise<void> {
    await apiUpdateBookingStatus(bookingId, { status });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getListBookingsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getListNotificationsQueryKey() }),
    ]);
  }

  async function createReview(input: CreateReviewInput): Promise<void> {
    // POST /reviews — server validates booking ownership + completed status,
    // and atomically recomputes services.rating + businesses.rating denorm
    // counters. We then invalidate bookings (so `reviewed` flips), services
    // (rating/count + service detail reviews list), and businesses (rating).
    const created = await apiCreateReview({
      bookingId: input.bookingId,
      rating: input.rating,
      comment: input.comment ?? null,
    });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getListBookingsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getListServicesQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getListBusinessesQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetServiceQueryKey(created.serviceId) }),
    ]);
  }
  async function markNotificationRead(notificationId: string): Promise<void> {
    await apiMarkRead(notificationId);
    await queryClient.invalidateQueries({ queryKey: getListNotificationsQueryKey() });
  }
  async function markAllNotificationsRead(): Promise<void> {
    await apiMarkAllRead();
    await queryClient.invalidateQueries({ queryKey: getListNotificationsQueryKey() });
  }
  async function addCategory(_category: Category) {
    await deferredWrite("addCategory")(getListCategoriesQueryKey());
  }
  async function removeCategory(_categoryId: string) {
    await deferredWrite("removeCategory")(getListCategoriesQueryKey());
  }
  // Helper: convert mobile ServiceOption[] → server CreateServiceOptionRequest[].
  function toApiOptions(options: ServiceOption[]): CreateServiceOptionRequest[] {
    return options.map((o) => ({
      name: o.name,
      description: o.description,
      price: o.price.toFixed(2),
      duration: o.duration,
      defaultStartTime: o.defaultStartTime ?? null,
    }));
  }

  async function addService(service: Service) {
    // POST /services accepts inline options; server inserts them atomically and
    // recomputes startingPrice. The mobile-generated `id`/`businessId` fields
    // are ignored — the server assigns its own.
    await apiCreateService({
      categoryId: service.categoryId,
      title: service.title,
      description: service.description,
      tags: service.tags,
      requiredSpecialty: service.requiredSpecialty ?? null,
      featured: service.featured,
      options: toApiOptions(service.options),
    });
    await queryClient.invalidateQueries({ queryKey: getListServicesQueryKey() });
  }

  async function updateService(service: Service) {
    // PATCH /services/:id with `options` performs a full replace inside one tx.
    await apiUpdateService(service.id, {
      categoryId: service.categoryId,
      title: service.title,
      description: service.description,
      tags: service.tags,
      requiredSpecialty: service.requiredSpecialty ?? null,
      featured: service.featured,
      options: toApiOptions(service.options),
    });
    await queryClient.invalidateQueries({ queryKey: getListServicesQueryKey() });
  }

  async function deleteService(serviceId: string) {
    await apiDeleteService(serviceId);
    await queryClient.invalidateQueries({ queryKey: getListServicesQueryKey() });
  }
  async function addBusiness(_business: Business) {
    await deferredWrite("addBusiness")(getListBusinessesQueryKey());
  }
  /**
   * Phase 3 #3 — wired to PATCH /me/business. The `id` is ignored because the
   * server uses `auth.businessId` (an SP can only ever edit their own row).
   * Translates `undefined` fields to "don't touch" by omitting them; passes
   * `null` through verbatim (used to clear vacation dates / message).
   */
  async function updateBusiness(_id: string, updates: Partial<Business>) {
    const body: Record<string, unknown> = {};
    if ("hours" in updates) body.hours = updates.hours ?? null;
    if ("phone" in updates) body.phone = updates.phone ?? null;
    if ("location" in updates) body.location = updates.location ?? null;
    if ("description" in updates) body.description = updates.description ?? null;
    if ("vacationFrom" in updates) body.vacationFrom = updates.vacationFrom ?? null;
    if ("vacationUntil" in updates) body.vacationUntil = updates.vacationUntil ?? null;
    if ("vacationMessage" in updates) body.vacationMessage = updates.vacationMessage ?? null;
    // Phase 3 #7 — cancellation policy fields are integers; pass-through
    // when present (the server validates ranges and the partH ≤ fullH invariant).
    if ("cancellationFullRefundHours" in updates) body.cancellationFullRefundHours = updates.cancellationFullRefundHours;
    if ("cancellationPartialRefundHours" in updates) body.cancellationPartialRefundHours = updates.cancellationPartialRefundHours;
    if ("cancellationPartialRefundPercent" in updates) body.cancellationPartialRefundPercent = updates.cancellationPartialRefundPercent;
    await apiUpdateMyBusiness(body as Parameters<typeof apiUpdateMyBusiness>[0]);
    // Vacation/hours changes alter what every customer sees on the per-day
    // availability picker — invalidate the (parameterized) query family too,
    // not just the business list.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getListBusinessesQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetAvailabilityQueryKey({ serviceId: "", date: "" }).slice(0, 1) }),
    ]);
  }
  /**
   * Phase 2 #7: admin approves a paid application. The server re-verifies the
   * Stripe Checkout Session, creates the public `businesses` row, and flips
   * the biz_account to `approved` in a single transaction. We invalidate both
   * the biz_accounts list (so the application leaves the pending tray) and
   * the businesses list (so the new SP appears in the active tab).
   */
  /**
   * Admin accepts an application after the interview, moving it from `pending`
   * to `accepted`. This does NOT create a business yet — the applicant must
   * still pay the $2 onboarding fee, after which the webhook finalizes the
   * account to `approved` and inserts the business row.
   */
  async function acceptProvider(id: string) {
    await apiAcceptBizAccount(id, {});
    await queryClient.invalidateQueries({ queryKey: getListBizAccountsQueryKey() });
  }
  /** Admin schedules the in-person meeting via PATCH /biz-accounts/:id ("" clears it). */
  async function scheduleMeeting(
    id: string,
    meetingAt: string,
    opts?: { location?: string; durationMinutes?: number },
  ) {
    await apiUpdateBizAccount(id, {
      meetingAt: meetingAt === "" ? null : meetingAt,
      ...(meetingAt !== "" && opts?.location !== undefined
        ? { meetingLocation: opts.location }
        : {}),
      ...(meetingAt !== "" && opts?.durationMinutes !== undefined
        ? { meetingDurationMinutes: opts.durationMinutes }
        : {}),
    });
    await queryClient.invalidateQueries({ queryKey: getListBizAccountsQueryKey() });
  }
  async function approveProvider(id: string) {
    await apiApproveBizAccount(id, {});
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getListBizAccountsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getListBusinessesQueryKey() }),
    ]);
  }
  /**
   * Admin rejects an application. The $1 application fee is non-refundable
   * per project policy; the server stamps `rejectedAt` + optional reason.
   */
  async function rejectProvider(id: string, reason?: string) {
    await apiRejectBizAccount(id, { reason: reason ?? null });
    await queryClient.invalidateQueries({ queryKey: getListBizAccountsQueryKey() });
  }
  /**
   * Phase 3 #3 — wired to POST /blocked-slots. The server stamps the
   * canonical `id` and `businessId` (from `auth`); the client-side `id`
   * placeholder on the input is ignored. We also invalidate the per-business
   * list so the customer-facing month calendar refreshes.
   */
  async function addBlockedSlot(slot: BlockedSlot) {
    await apiCreateBlockedSlot({
      date: slot.date,
      allDay: slot.allDay,
      startTime: slot.startTime ?? null,
      endTime: slot.endTime ?? null,
      label: slot.label ?? null,
    });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getListBlockedSlotsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetAvailabilityQueryKey({ serviceId: "", date: "" }).slice(0, 1) }),
    ]);
  }
  async function addBlockedSlots(slots: BlockedSlot[]) {
    // No bulk endpoint — fire all in parallel. POST /blocked-slots is cheap
    // (single insert) and the SP rarely creates more than ~30 days at once.
    await Promise.all(
      slots.map((slot) =>
        apiCreateBlockedSlot({
          date: slot.date,
          allDay: slot.allDay,
          startTime: slot.startTime ?? null,
          endTime: slot.endTime ?? null,
          label: slot.label ?? null,
        }),
      ),
    );
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getListBlockedSlotsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetAvailabilityQueryKey({ serviceId: "", date: "" }).slice(0, 1) }),
    ]);
  }
  async function removeBlockedSlot(slotId: string) {
    await apiDeleteBlockedSlot(slotId);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getListBlockedSlotsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetAvailabilityQueryKey({ serviceId: "", date: "" }).slice(0, 1) }),
    ]);
  }

  async function openSubscriptionCheckout(plan: PlanTier) {
    // Server signs the JWT-bound checkout session; we just open its URL in the
    // in-app browser. On dismissal we refetch both the subscription snapshot
    // and the businesses list so any plan/active flips made by the webhook
    // show up immediately on the dashboard.
    const result = await createMySubscriptionCheckout({ plan });
    if (result.url) {
      await WebBrowser.openBrowserAsync(result.url);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetMySubscriptionQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getListBusinessesQueryKey() }),
      ]);
    }
  }

  return (
    <AppContext.Provider
      value={{
        user,
        loginCustomer,
        loginBusiness,
        loginAdmin,
        logout,
        updateUser,
        bookings,
        createBooking,
        cancelBooking,
        updateBookingStatus,
        requestRefund,
        decideRefundRequest,
        pendingRefundRequests,
        createReview,
        notifications,
        unreadNotificationCount,
        markNotificationRead,
        markAllNotificationsRead,
        categories,
        addCategory,
        removeCategory,
        services,
        addService,
        updateService,
        deleteService,
        businesses,
        addBusiness,
        updateBusiness,
        bizAccounts,
        acceptProvider,
        approveProvider,
        scheduleMeeting,
        rejectProvider,
        blockedSlots,
        addBlockedSlot,
        addBlockedSlots,
        removeBlockedSlot,
        subscription: subscriptionQ.data ?? null,
        openSubscriptionCheckout,
        isLoading,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
