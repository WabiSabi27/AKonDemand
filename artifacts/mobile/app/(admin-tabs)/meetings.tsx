import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, router } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp, type BizAccount } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";

/**
 * Admin Calendar (Meetings tab) — schedule and manage in-person meetings with
 * accepted service providers. Reached directly from the tab bar, or from the
 * "next steps" panel after accepting an application (with ?bizAccountId=…
 * preselecting the provider to schedule).
 *
 * Meetings are stored on the biz_account row (`meetingAt`) — one meeting per
 * application, set via PATCH /biz-accounts/:id (admin only).
 */

const NAVY = "#0F1B2D";
const ACCENT = "#FFB300";

const DURATION_OPTIONS = [30, 45, 60, 90, 120] as const;

function fmtDuration(min: number): string {
  if (min % 60 === 0) return min === 60 ? "1 hr" : `${min / 60} hrs`;
  return min > 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min} min`;
}

const DAY_COUNT = 30;
const SLOT_START_HOUR = 9;
const SLOT_END_HOUR = 17; // last slot starts 16:30

function buildDays(): Date[] {
  const days: Date[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i < DAY_COUNT; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  return days;
}

function buildSlots(day: Date): Date[] {
  const slots: Date[] = [];
  const now = Date.now();
  for (let h = SLOT_START_HOUR; h < SLOT_END_HOUR; h++) {
    for (const m of [0, 30]) {
      const t = new Date(day);
      t.setHours(h, m, 0, 0);
      if (t.getTime() > now) slots.push(t);
    }
  }
  return slots;
}

function fmtDay(d: Date): { dow: string; day: string; mon: string } {
  return {
    dow: d.toLocaleDateString("en-US", { weekday: "short" }),
    day: d.toLocaleDateString("en-US", { day: "numeric" }),
    mon: d.toLocaleDateString("en-US", { month: "short" }),
  };
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function fmtMeeting(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} · ${fmtTime(d)}`;
}

export default function AdminMeetingsTab() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === "web" ? 67 : insets.top;
  const { bizAccounts, scheduleMeeting } = useApp();
  const params = useLocalSearchParams<{ bizAccountId?: string }>();

  // Provider currently being scheduled (param from the accept flow, or picked
  // from a card's Schedule/Reschedule button).
  const [schedulingId, setSchedulingId] = useState<string | null>(
    typeof params.bizAccountId === "string" ? params.bizAccountId : null,
  );
  // Tab screens stay mounted — re-read the deep-link param on every navigation
  // from the Businesses tab so "Schedule meeting" always preselects the provider.
  useEffect(() => {
    if (typeof params.bizAccountId === "string" && params.bizAccountId) {
      setSchedulingId(params.bizAccountId);
      setSelectedSlot(null);
      setError(null);
      const app = bizAccounts.find((a) => a.id === params.bizAccountId);
      setLocation(app?.meetingLocation ?? "");
      setDurationMinutes(app?.meetingDurationMinutes || 60);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.bizAccountId]);
  const [selectedDayIdx, setSelectedDayIdx] = useState(0);
  const [selectedSlot, setSelectedSlot] = useState<Date | null>(null);
  const [location, setLocation] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const days = useMemo(buildDays, []);
  const slots = useMemo(() => buildSlots(days[selectedDayIdx]), [days, selectedDayIdx]);

  const schedulingApp = schedulingId ? bizAccounts.find((a) => a.id === schedulingId) : null;

  // Providers eligible for a meeting: accepted (post-interview, pre-payment)
  // and pending (paid, awaiting interview) — the admin may want to meet either.
  const eligible = bizAccounts.filter((a) => a.status === "accepted" || a.status === "pending");
  const upcoming = bizAccounts
    .filter((a) => a.meetingAt && new Date(a.meetingAt).getTime() >= Date.now() - 60 * 60 * 1000)
    .sort((a, b) => new Date(a.meetingAt!).getTime() - new Date(b.meetingAt!).getTime());
  const unscheduled = eligible.filter((a) => !a.meetingAt);

  function startScheduling(id: string) {
    setSchedulingId(id);
    setSelectedSlot(null);
    setError(null);
    // Prefill location/length from the existing meeting when rescheduling.
    const app = bizAccounts.find((a) => a.id === id);
    setLocation(app?.meetingLocation ?? "");
    setDurationMinutes(app?.meetingDurationMinutes || 60);
  }

  async function confirmMeeting() {
    if (!schedulingApp || !selectedSlot) return;
    setSaving(true);
    setError(null);
    try {
      await scheduleMeeting(schedulingApp.id, selectedSlot.toISOString(), {
        location: location.trim(),
        durationMinutes,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSchedulingId(null);
      setSelectedSlot(null);
      // Clear the deep-link param so re-visiting the tab starts clean.
      router.setParams({ bizAccountId: undefined });
    } catch (e) {
      setError("Could not save the meeting. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function removeMeeting(id: string) {
    try {
      await scheduleMeeting(id, "");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } catch {
      // list refresh will reflect reality
    }
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topInset + 16, backgroundColor: NAVY }]}>
        <Text style={styles.headerTitle}>Admin Calendar</Text>
        <Text style={styles.headerSub}>
          {upcoming.length} upcoming meeting{upcoming.length === 1 ? "" : "s"} · {unscheduled.length} to schedule
        </Text>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.list, { paddingBottom: Platform.OS === "web" ? 100 : insets.bottom + 100 }]}
      >
        {/* ── Scheduling panel ── */}
        {schedulingApp && (
          <View style={[styles.scheduleCard, { backgroundColor: colors.card, borderColor: ACCENT + "50" }]}>
            <View style={styles.scheduleTop}>
              <View style={[styles.avatar, { backgroundColor: ACCENT + "20" }]}>
                <Feather name="calendar" size={16} color={ACCENT} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.scheduleTitle, { color: colors.foreground }]}>
                  {schedulingApp.meetingAt ? "Reschedule meeting" : "Schedule in-person meeting"}
                </Text>
                <Text style={[styles.scheduleSub, { color: colors.mutedForeground }]}>
                  {schedulingApp.businessName} · {schedulingApp.ownerName}
                </Text>
              </View>
              <TouchableOpacity onPress={() => { setSchedulingId(null); router.setParams({ bizAccountId: undefined }); }} hitSlop={10}>
                <Feather name="x" size={18} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>

            {/* Day picker */}
            <Text style={[styles.pickLabel, { color: colors.mutedForeground }]}>PICK A DAY</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.dayRow}>
              {days.map((d, i) => {
                const f = fmtDay(d);
                const sel = i === selectedDayIdx;
                return (
                  <TouchableOpacity
                    key={d.toISOString()}
                    style={[styles.dayChip, { backgroundColor: sel ? ACCENT : colors.secondary, borderColor: sel ? ACCENT : colors.border }]}
                    onPress={() => { setSelectedDayIdx(i); setSelectedSlot(null); }}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.dayDow, { color: sel ? NAVY : colors.mutedForeground }]}>{f.dow}</Text>
                    <Text style={[styles.dayNum, { color: sel ? NAVY : colors.foreground }]}>{f.day}</Text>
                    <Text style={[styles.dayDow, { color: sel ? NAVY : colors.mutedForeground }]}>{f.mon}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            {/* Time slots */}
            <Text style={[styles.pickLabel, { color: colors.mutedForeground }]}>PICK A TIME</Text>
            {slots.length === 0 ? (
              <Text style={[styles.noSlots, { color: colors.mutedForeground }]}>
                No times left today — pick another day.
              </Text>
            ) : (
              <View style={styles.slotWrap}>
                {slots.map((s) => {
                  const sel = selectedSlot?.getTime() === s.getTime();
                  return (
                    <TouchableOpacity
                      key={s.toISOString()}
                      style={[styles.slotChip, { backgroundColor: sel ? ACCENT : colors.secondary, borderColor: sel ? ACCENT : colors.border }]}
                      onPress={() => setSelectedSlot(s)}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.slotText, { color: sel ? NAVY : colors.foreground }]}>{fmtTime(s)}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {/* Meeting length */}
            <Text style={[styles.pickLabel, { color: colors.mutedForeground }]}>MEETING LENGTH</Text>
            <View style={styles.slotWrap}>
              {DURATION_OPTIONS.map((min) => {
                const sel = durationMinutes === min;
                return (
                  <TouchableOpacity
                    key={min}
                    style={[styles.slotChip, { backgroundColor: sel ? ACCENT : colors.secondary, borderColor: sel ? ACCENT : colors.border }]}
                    onPress={() => setDurationMinutes(min)}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.slotText, { color: sel ? NAVY : colors.foreground }]}>{fmtDuration(min)}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Location */}
            <Text style={[styles.pickLabel, { color: colors.mutedForeground }]}>LOCATION (GOES IN THE CALENDAR INVITE)</Text>
            <TextInput
              style={[styles.locationInput, { backgroundColor: colors.secondary, borderColor: colors.border, color: colors.foreground }]}
              value={location}
              onChangeText={setLocation}
              placeholder="e.g. AK On Demand office, 123 Main St, Anchorage"
              placeholderTextColor={colors.mutedForeground}
              multiline
            />

            {error && <Text style={styles.errorText}>{error}</Text>}

            <TouchableOpacity
              style={[styles.confirmBtn, { backgroundColor: selectedSlot ? ACCENT : colors.secondary }]}
              disabled={!selectedSlot || saving}
              onPress={confirmMeeting}
              activeOpacity={0.85}
            >
              {saving ? (
                <ActivityIndicator size="small" color={NAVY} />
              ) : (
                <>
                  <Feather name="check" size={15} color={selectedSlot ? NAVY : colors.mutedForeground} />
                  <Text style={[styles.confirmBtnText, { color: selectedSlot ? NAVY : colors.mutedForeground }]}>
                    {selectedSlot ? `Confirm · ${fmtMeeting(selectedSlot.toISOString())}` : "Pick a day and time"}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        )}

        {/* ── Upcoming meetings ── */}
        <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
          UPCOMING MEETINGS · {upcoming.length}
        </Text>
        {upcoming.length === 0 ? (
          <View style={styles.emptyBox}>
            <View style={[styles.emptyIcon, { backgroundColor: ACCENT + "18" }]}>
              <Feather name="coffee" size={30} color={ACCENT} />
            </View>
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No meetings booked</Text>
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              Accept an application in the Businesses tab, then schedule the in-person meeting here.
            </Text>
          </View>
        ) : (
          upcoming.map((app) => (
            <MeetingCard
              key={app.id}
              app={app}
              colors={colors}
              onReschedule={() => startScheduling(app.id)}
              onRemove={() => removeMeeting(app.id)}
            />
          ))
        )}

        {/* ── Needs scheduling ── */}
        {unscheduled.length > 0 && (
          <>
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground, marginTop: 20 }]}>
              NEEDS SCHEDULING · {unscheduled.length}
            </Text>
            {unscheduled.map((app) => (
              <View key={app.id} style={[styles.pendingCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.cardName, { color: colors.foreground }]}>{app.businessName}</Text>
                  <Text style={[styles.cardSub, { color: colors.mutedForeground }]}>
                    {app.ownerName} · {app.status === "accepted" ? "Accepted" : "Awaiting interview"}
                  </Text>
                </View>
                <TouchableOpacity
                  style={[styles.smallBtn, { backgroundColor: ACCENT }]}
                  onPress={() => startScheduling(app.id)}
                  activeOpacity={0.85}
                >
                  <Feather name="calendar" size={13} color={NAVY} />
                  <Text style={[styles.smallBtnText, { color: NAVY }]}>Schedule</Text>
                </TouchableOpacity>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function MeetingCard({ app, colors, onReschedule, onRemove }: {
  app: BizAccount;
  colors: ReturnType<typeof useColors>;
  onReschedule: () => void;
  onRemove: () => void;
}) {
  return (
    <View style={[styles.meetingCard, { backgroundColor: colors.card, borderColor: ACCENT + "40" }]}>
      <View style={styles.meetingTop}>
        <View style={[styles.avatar, { backgroundColor: ACCENT + "20" }]}>
          <Text style={[styles.avatarText, { color: ACCENT }]}>
            {app.businessName.charAt(0).toUpperCase()}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.cardName, { color: colors.foreground }]}>{app.businessName}</Text>
          <Text style={[styles.cardSub, { color: colors.mutedForeground }]}>{app.ownerName} · {app.email}</Text>
        </View>
      </View>
      <View style={[styles.meetingWhen, { backgroundColor: ACCENT + "14" }]}>
        <Feather name="clock" size={13} color={ACCENT} />
        <Text style={[styles.meetingWhenText, { color: ACCENT }]}>
          {fmtMeeting(app.meetingAt!)} · {fmtDuration(app.meetingDurationMinutes || 60)}
        </Text>
      </View>
      {!!app.meetingLocation && (
        <View style={[styles.meetingWhen, { backgroundColor: ACCENT + "0D" }]}>
          <Feather name="map-pin" size={13} color={ACCENT} />
          <Text style={[styles.meetingLocText, { color: colors.foreground }]} numberOfLines={2}>
            {app.meetingLocation}
          </Text>
        </View>
      )}
      <View style={styles.meetingActions}>
        <TouchableOpacity style={[styles.smallBtnGhost, { borderColor: colors.border }]} onPress={onRemove} activeOpacity={0.8}>
          <Feather name="x" size={13} color={colors.mutedForeground} />
          <Text style={[styles.smallBtnText, { color: colors.mutedForeground }]}>Remove</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.smallBtnGhost, { borderColor: ACCENT + "60" }]} onPress={onReschedule} activeOpacity={0.8}>
          <Feather name="edit-2" size={13} color={ACCENT} />
          <Text style={[styles.smallBtnText, { color: ACCENT }]}>Reschedule</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 20, paddingBottom: 16, gap: 4 },
  headerTitle: { color: "#fff", fontSize: 22, fontWeight: "700" },
  headerSub: { color: "rgba(255,255,255,0.55)", fontSize: 12 },
  list: { padding: 16, gap: 10 },
  sectionLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 0.6, marginTop: 4, marginBottom: 2 },

  scheduleCard: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 10, marginBottom: 8 },
  scheduleTop: { flexDirection: "row", alignItems: "center", gap: 10 },
  scheduleTitle: { fontSize: 15, fontWeight: "700" },
  scheduleSub: { fontSize: 12, marginTop: 1 },
  pickLabel: { fontSize: 10, fontWeight: "700", letterSpacing: 0.6, marginTop: 6 },
  dayRow: { gap: 8, paddingVertical: 2 },
  dayChip: { width: 52, borderRadius: 12, borderWidth: 1, alignItems: "center", paddingVertical: 8, gap: 1 },
  dayDow: { fontSize: 10, fontWeight: "600" },
  dayNum: { fontSize: 16, fontWeight: "700" },
  slotWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  slotChip: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  slotText: { fontSize: 12.5, fontWeight: "600" },
  noSlots: { fontSize: 12.5, paddingVertical: 6 },
  errorText: { color: "#F44336", fontSize: 12.5, fontWeight: "600" },
  confirmBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, borderRadius: 12, paddingVertical: 13, marginTop: 4 },
  confirmBtnText: { fontSize: 14, fontWeight: "700" },

  meetingCard: { borderRadius: 16, borderWidth: 1, padding: 14, gap: 10 },
  meetingTop: { flexDirection: "row", alignItems: "center", gap: 10 },
  avatar: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  avatarText: { fontSize: 15, fontWeight: "700" },
  cardName: { fontSize: 14.5, fontWeight: "700" },
  cardSub: { fontSize: 12, marginTop: 1 },
  meetingWhen: { flexDirection: "row", alignItems: "center", gap: 7, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 },
  meetingWhenText: { fontSize: 13, fontWeight: "700" },
  meetingLocText: { fontSize: 12.5, fontWeight: "500", flex: 1 },
  locationInput: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, fontSize: 13, minHeight: 44, textAlignVertical: "top" },
  meetingActions: { flexDirection: "row", gap: 8, justifyContent: "flex-end" },
  smallBtn: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  smallBtnGhost: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  smallBtnText: { fontSize: 12.5, fontWeight: "700" },

  pendingCard: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 14, borderWidth: 1, padding: 14 },

  emptyBox: { alignItems: "center", paddingVertical: 28, gap: 8 },
  emptyIcon: { width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center" },
  emptyTitle: { fontSize: 15, fontWeight: "700" },
  emptyText: { fontSize: 12.5, textAlign: "center", lineHeight: 18, maxWidth: 260 },
});
