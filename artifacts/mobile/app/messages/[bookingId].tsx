/**
 * Per-booking chat thread (Phase 3 #6).
 *
 * Both sides of a booking (customer and SP) hit the same screen — the server
 * derives the caller's role from auth and the booking row, and tags each
 * message with `senderRole` so we can render bubbles on the correct side.
 *
 * Polling: refetch every 4s while the screen is focused (React Query
 * `refetchInterval`). On every successful fetch we mark incoming messages
 * read so the inbox unread badge clears as soon as the other party opens
 * the thread.
 */
import { Feather } from "@expo/vector-icons";
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";

import {
  useListBookingMessages,
  useSendBookingMessage,
  useMarkBookingMessagesRead,
  getListBookingMessagesQueryKey,
  getListMyConversationsQueryKey,
  type Message,
} from "@workspace/api-client-react";

import { useApp } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";
import { ScreenHeader } from "@/components/ScreenHeader";

const MAX_LEN = 2000;

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatDayHeader(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return "Today";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/** Inject `{kind:"day", id, label}` separator items between messages from
 *  different calendar days. The FlatList is rendered top-down, oldest first. */
type Row = { kind: "msg"; msg: Message } | { kind: "day"; id: string; label: string };

function buildRows(messages: Message[]): Row[] {
  const rows: Row[] = [];
  let lastDayKey = "";
  for (const m of messages) {
    const d = new Date(m.createdAt);
    const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (dayKey !== lastDayKey) {
      rows.push({ kind: "day", id: `day_${dayKey}`, label: formatDayHeader(m.createdAt) });
      lastDayKey = dayKey;
    }
    rows.push({ kind: "msg", msg: m });
  }
  return rows;
}

export default function MessagesThreadScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const { user } = useApp();
  const params = useLocalSearchParams<{ bookingId: string; title?: string }>();
  const bookingId = String(params.bookingId);
  const headerTitle = typeof params.title === "string" && params.title ? params.title : "Messages";

  // The caller's role on this booking — used to right-align our own bubbles.
  // Falls back to "customer" until user loads (the server still authorises by token).
  const myRole: "customer" | "business" = user?.role === "business" ? "business" : "customer";

  // Only poll while this screen is actually focused — Expo Router keeps
  // previous screens mounted, and we don't want to silently mark messages
  // read or burn the network/battery in the background.
  const [isFocused, setIsFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      return () => setIsFocused(false);
    }, []),
  );
  const messagesQ = useListBookingMessages(bookingId, {
    query: {
      queryKey: getListBookingMessagesQueryKey(bookingId),
      refetchInterval: isFocused ? 4000 : false,
      refetchOnWindowFocus: true,
      enabled: isFocused,
    },
  });
  const sendMut = useSendBookingMessage();
  const markReadMut = useMarkBookingMessagesRead();

  const messages = messagesQ.data ?? [];
  const rows = useMemo(() => buildRows(messages), [messages]);

  const [draft, setDraft] = useState("");
  const listRef = useRef<FlatList<Row>>(null);
  // Track the last unread-from-other count we marked read on, so we don't
  // re-call read every 4 s when there's nothing new.
  const lastMarkedAt = useRef<string | null>(null);

  // Whenever new messages from the other side arrive (and the screen is
  // focused), mark them read. We key off the timestamp of the newest unread
  // from the other side, and only advance the guard ON SUCCESS — so a
  // transient network failure can be retried by the next poll cycle instead
  // of silently leaving the badge stuck.
  useEffect(() => {
    if (!isFocused) return;
    const newestFromOther = [...messages]
      .reverse()
      .find((m) => m.senderRole !== myRole && !m.readAt);
    if (!newestFromOther) return;
    const target = newestFromOther.createdAt;
    if (lastMarkedAt.current === target) return;
    if (markReadMut.isPending) return;
    markReadMut.mutate(
      { id: bookingId },
      {
        onSuccess: () => {
          lastMarkedAt.current = target;
          // Refresh inbox badge on the (tabs) and (business-tabs) screens.
          qc.invalidateQueries({ queryKey: getListMyConversationsQueryKey() });
        },
        // onError: leave lastMarkedAt unchanged so the next poll retries.
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, isFocused]);

  // Auto-scroll to bottom on new content.
  useEffect(() => {
    if (rows.length === 0) return;
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: true });
    });
  }, [rows.length]);

  const trimmed = draft.trim();
  const canSend = trimmed.length > 0 && trimmed.length <= MAX_LEN && !sendMut.isPending;

  function handleSend() {
    if (!canSend) return;
    const body = trimmed;
    setDraft("");
    sendMut.mutate(
      { id: bookingId, data: { body } },
      {
        onSuccess: (created) => {
          // Optimistically append; the next poll will reconcile.
          qc.setQueryData<Message[]>(
            getListBookingMessagesQueryKey(bookingId),
            (prev) => (prev ? [...prev, created] : [created]),
          );
          qc.invalidateQueries({ queryKey: getListMyConversationsQueryKey() });
        },
        onError: () => {
          // Restore the draft so the user doesn't lose their text.
          setDraft(body);
        },
      },
    );
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: colors.background }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 0}
      >
        {/* Header */}
        <ScreenHeader title={headerTitle} subtitle="Booking chat" />

        {/* Body */}
        {messagesQ.isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : messagesQ.isError ? (
          <View style={styles.center}>
            <Feather name="alert-triangle" size={32} color={colors.destructive} />
            <Text style={[styles.errText, { color: colors.foreground }]}>
              Could not load messages.
            </Text>
            <TouchableOpacity
              style={[styles.retryBtn, { backgroundColor: colors.primary }]}
              onPress={() => messagesQ.refetch()}
            >
              <Text style={styles.retryText}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={rows}
            keyExtractor={(r) => (r.kind === "day" ? r.id : r.msg.id)}
            contentContainerStyle={[
              styles.list,
              {
                paddingBottom: 12,
                paddingTop: 12,
              },
            ]}
            renderItem={({ item }) => {
              if (item.kind === "day") {
                return (
                  <View style={styles.dayRow}>
                    <View style={[styles.dayLine, { backgroundColor: colors.border }]} />
                    <Text style={[styles.dayLabel, { color: colors.mutedForeground }]}>
                      {item.label}
                    </Text>
                    <View style={[styles.dayLine, { backgroundColor: colors.border }]} />
                  </View>
                );
              }
              const m = item.msg;
              const mine = m.senderRole === myRole;
              return (
                <View
                  style={[
                    styles.bubbleRow,
                    { justifyContent: mine ? "flex-end" : "flex-start" },
                  ]}
                >
                  <View
                    style={[
                      styles.bubble,
                      mine
                        ? { backgroundColor: colors.primary, borderTopRightRadius: 4 }
                        : { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderTopLeftRadius: 4 },
                    ]}
                  >
                    <Text style={[styles.bubbleText, { color: mine ? "#fff" : colors.foreground }]}>
                      {m.body}
                    </Text>
                    <Text
                      style={[
                        styles.bubbleTime,
                        { color: mine ? "rgba(255,255,255,0.75)" : colors.mutedForeground },
                      ]}
                    >
                      {formatTime(m.createdAt)}
                      {mine && m.readAt ? " · Read" : ""}
                    </Text>
                  </View>
                </View>
              );
            }}
            ListEmptyComponent={
              <View style={styles.emptyWrap}>
                <Feather name="message-circle" size={36} color={colors.mutedForeground} />
                <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                  No messages yet. Say hello!
                </Text>
              </View>
            }
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          />
        )}

        {/* Composer */}
        <View
          style={[
            styles.composer,
            {
              backgroundColor: colors.card,
              borderTopColor: colors.border,
              paddingBottom: Math.max(insets.bottom, 8),
            },
          ]}
        >
          <TextInput
            value={draft}
            onChangeText={(t) => setDraft(t.length > MAX_LEN ? t.slice(0, MAX_LEN) : t)}
            placeholder="Type a message…"
            placeholderTextColor={colors.mutedForeground}
            style={[styles.input, { color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border }]}
            multiline
            maxLength={MAX_LEN}
            editable={!sendMut.isPending}
          />
          <TouchableOpacity
            onPress={handleSend}
            disabled={!canSend}
            style={[
              styles.sendBtn,
              { backgroundColor: canSend ? colors.primary : colors.secondary },
            ]}
            activeOpacity={0.85}
          >
            {sendMut.isPending ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Feather name="send" size={18} color={canSend ? "#fff" : colors.mutedForeground} />
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingBottom: 12,
    gap: 8,
    borderBottomWidth: 1,
  },
  backBtn: { padding: 4 },
  headerTitle: { fontSize: 18, fontWeight: "800" },
  headerSub: { fontSize: 12, marginTop: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  errText: { fontSize: 15, fontWeight: "600" },
  retryBtn: { paddingHorizontal: 18, paddingVertical: 9, borderRadius: 10 },
  retryText: { color: "#fff", fontWeight: "700" },
  list: { paddingHorizontal: 12, gap: 6 },
  dayRow: { flexDirection: "row", alignItems: "center", gap: 8, marginVertical: 8 },
  dayLine: { flex: 1, height: 1 },
  dayLabel: { fontSize: 12, fontWeight: "600" },
  bubbleRow: { flexDirection: "row", marginBottom: 6 },
  bubble: { maxWidth: "78%", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 },
  bubbleText: { fontSize: 15, lineHeight: 19 },
  bubbleTime: { fontSize: 12, marginTop: 4, textAlign: "right" },
  emptyWrap: { alignItems: "center", justifyContent: "center", paddingVertical: 60, gap: 10 },
  emptyText: { fontSize: 15 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: 1,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === "ios" ? 10 : 8,
    fontSize: 15,
    maxHeight: 110,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
});
