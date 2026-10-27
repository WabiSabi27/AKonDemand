import { Feather } from "@expo/vector-icons";
import React from "react";
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";

interface MenuItemProps {
  icon: string;
  label: string;
  value?: string;
  onPress: () => void;
  danger?: boolean;
}

function MenuItem({ icon, label, value, onPress, danger }: MenuItemProps) {
  const colors = useColors();
  return (
    <TouchableOpacity
      style={[styles.menuItem, { borderBottomColor: colors.border }]}
      onPress={onPress}
      activeOpacity={0.8}
    >
      <View style={[styles.menuIcon, { backgroundColor: danger ? colors.destructive + "18" : colors.secondary }]}>
        <Feather name={icon as any} size={17} color={danger ? colors.destructive : colors.foreground} />
      </View>
      <Text style={[styles.menuLabel, { color: danger ? colors.destructive : colors.foreground }]}>
        {label}
      </Text>
      {value && <Text style={[styles.menuValue, { color: colors.mutedForeground }]}>{value}</Text>}
      {!danger && <Feather name="chevron-right" size={16} color={colors.mutedForeground} />}
    </TouchableOpacity>
  );
}

export default function ProfileScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user, bookings, logout } = useApp();
  const topInset = Platform.OS === "web" ? 67 : insets.top;

  const completedCount = bookings.filter((b) => b.status === "completed").length;
  const totalSpent = bookings
    .filter((b) => b.status !== "cancelled")
    .reduce((sum, b) => sum + b.total, 0);

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={{ paddingBottom: Platform.OS === "web" ? 108 : insets.bottom + 80 }}
      showsVerticalScrollIndicator={false}
    >
      <View style={[styles.hero, { paddingTop: topInset + 16, backgroundColor: colors.primary }]}>
        <View style={styles.avatarCircle}>
          <Text style={styles.avatarText}>
            {user?.name?.split(" ").map((n) => n[0]).join("") ?? "?"}
          </Text>
        </View>
        <Text style={styles.heroName}>{user?.name ?? "Guest"}</Text>
        <Text style={styles.heroEmail}>{user?.email ?? ""}</Text>

        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <Text style={styles.statNum}>{bookings.length}</Text>
            <Text style={styles.statLabel}>Bookings</Text>
          </View>
          <View style={[styles.statDivider, { backgroundColor: "rgba(255,255,255,0.2)" }]} />
          <View style={styles.stat}>
            <Text style={styles.statNum}>{completedCount}</Text>
            <Text style={styles.statLabel}>Completed</Text>
          </View>
          <View style={[styles.statDivider, { backgroundColor: "rgba(255,255,255,0.2)" }]} />
          <View style={styles.stat}>
            <Text style={styles.statNum}>${totalSpent.toFixed(0)}</Text>
            <Text style={styles.statLabel}>Spent</Text>
          </View>
        </View>
      </View>

      <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>ACCOUNT</Text>
        <MenuItem icon="user" label="Edit Profile" onPress={() => {}} />
        <MenuItem icon="bell" label="Notifications" onPress={() => {}} />
        <MenuItem icon="map-pin" label="Saved Addresses" onPress={() => {}} />
      </View>

      <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>SUPPORT</Text>
        <MenuItem icon="help-circle" label="Help Center" onPress={() => {}} />
        <MenuItem icon="shield" label="Privacy Policy" onPress={() => {}} />
        <MenuItem icon="file-text" label="Terms of Service" onPress={() => {}} />
      </View>

      <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <MenuItem icon="log-out" label="Sign Out" onPress={logout} danger />
      </View>

      <Text style={[styles.footer, { color: colors.mutedForeground }]}>
        AK On Demand LLC · v1.0.0
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  hero: { alignItems: "center", paddingBottom: 28, paddingHorizontal: 20 },
  avatarCircle: { width: 76, height: 76, borderRadius: 38, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center", marginBottom: 12 },
  avatarText: { color: "#fff", fontSize: 28, fontWeight: "800" },
  heroName: { color: "#fff", fontSize: 22, fontWeight: "800", marginBottom: 3 },
  heroEmail: { color: "rgba(255,255,255,0.65)", fontSize: 15, marginBottom: 20 },
  statsRow: { flexDirection: "row", alignItems: "center", backgroundColor: "rgba(255,255,255,0.12)", borderRadius: 16, paddingHorizontal: 20, paddingVertical: 14, width: "100%" },
  stat: { flex: 1, alignItems: "center" },
  statNum: { color: "#fff", fontSize: 22, fontWeight: "800" },
  statLabel: { color: "rgba(255,255,255,0.6)", fontSize: 12, marginTop: 2 },
  statDivider: { width: 1, height: 30 },
  section: { marginHorizontal: 16, marginTop: 16, borderRadius: 16, borderWidth: 1, overflow: "hidden" },
  sectionLabel: { fontSize: 12, fontWeight: "700", paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4, letterSpacing: 0.8 },
  menuItem: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14, gap: 12, borderBottomWidth: 1 },
  menuIcon: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  menuLabel: { flex: 1, fontSize: 15, fontWeight: "600" },
  menuValue: { fontSize: 12, marginRight: 4 },
  footer: { textAlign: "center", fontSize: 12, marginTop: 24, marginBottom: 8 },
});
