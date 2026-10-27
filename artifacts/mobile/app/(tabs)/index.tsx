import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useState } from "react";
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ServiceCard } from "@/components/ServiceCard";
import { useApp } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";
import { BRAND } from "@/constants/colors";

export default function HomeScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { categories, services, businesses, user } = useApp();
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  const topInset = Platform.OS === "web" ? 67 : insets.top;

  const activeBusinessIds = new Set(
    businesses.filter((b) => b.subscriptionActive).map((b) => b.id)
  );
  const activeServices = services.filter((s) => activeBusinessIds.has(s.businessId));

  const activeCategoryIds = new Set(activeServices.map((s) => s.categoryId));
  // Show every service area as a browse tile — even ones without a provider yet —
  // so customers see the full catalog of services the marketplace covers.
  // Areas that already have providers are surfaced first.
  const browseCategories = [...categories].sort(
    (a, b) => (activeCategoryIds.has(a.id) ? 0 : 1) - (activeCategoryIds.has(b.id) ? 0 : 1)
  );

  const filteredServices = selectedCategory
    ? activeServices.filter((s) => s.categoryId === selectedCategory)
    : [];

  const selectedCat = browseCategories.find((c) => c.id === selectedCategory);

  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={{ paddingBottom: Platform.OS === "web" ? 108 : insets.bottom + 80 }}
      showsVerticalScrollIndicator={false}
    >
      {/* ── Header ── */}
      <View style={[styles.header, { paddingTop: topInset + 16, backgroundColor: colors.primary }]}>
        <View style={styles.headerTop}>
          <View>
            <Text style={styles.greeting}>{user ? `${greeting},` : "Welcome to"}</Text>
            <Text style={styles.userName}>
              {user ? `${user.name.split(" ")[0]} 👋` : "AK On Demand"}
            </Text>
          </View>
          {user ? (
            <TouchableOpacity
              style={[styles.notifBtn, { backgroundColor: "rgba(255,255,255,0.15)" }]}
              onPress={() => {}}
            >
              <Feather name="bell" size={20} color="#fff" />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.signInBtn}
              onPress={() => router.push("/login")}
              activeOpacity={0.85}
            >
              <Feather name="home" size={14} color="#fff" />
              <Text style={styles.signInBtnText}>Home</Text>
            </TouchableOpacity>
          )}
        </View>

        <TouchableOpacity
          style={styles.searchBar}
          onPress={() => router.push("/(tabs)/search")}
          activeOpacity={0.85}
        >
          <Feather name="search" size={16} color="rgba(255,255,255,0.6)" />
          <Text style={styles.searchBarText}>Search services…</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.body}>
        {/* ── Category selected: back + service list ── */}
        {selectedCategory ? (
          <>
            <TouchableOpacity
              style={[styles.backRow, { borderColor: colors.border }]}
              onPress={() => setSelectedCategory(null)}
              activeOpacity={0.8}
            >
              <Feather name="arrow-left" size={16} color={BRAND.redViolet} />
              <Text style={[styles.backText, { color: BRAND.redViolet }]}>All Categories</Text>
            </TouchableOpacity>

            <View style={styles.sectionHeader}>
              <View style={[styles.catIconWrap, { backgroundColor: (selectedCat?.color ?? BRAND.redViolet) + "20" }]}>
                <Feather name={(selectedCat?.icon as any) ?? "grid"} size={18} color={selectedCat?.color ?? BRAND.redViolet} />
              </View>
              <Text style={[styles.sectionTitle, { color: colors.foreground }]}>
                {selectedCat?.name ?? "Services"}
              </Text>
              <View style={[styles.countBadge, { backgroundColor: BRAND.redViolet + "20" }]}>
                <Text style={[styles.countText, { color: BRAND.redViolet }]}>{filteredServices.length}</Text>
              </View>
            </View>

            {filteredServices.length === 0 ? (
              <View style={[styles.empty, { borderColor: colors.border }]}>
                <Feather name="inbox" size={36} color={colors.mutedForeground} />
                <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                  No services in this category yet.
                </Text>
              </View>
            ) : (
              filteredServices.map((service) => (
                <ServiceCard
                  key={service.id}
                  service={service}
                  onPress={() =>
                    router.push({ pathname: "/service/[id]", params: { id: service.id } })
                  }
                />
              ))
            )}
          </>
        ) : (
          <>
            {/* ── Category grid ── */}
            <Text style={[styles.browseTitle, { color: colors.foreground }]}>Browse by Category</Text>

            {browseCategories.length === 0 ? (
              <View style={[styles.empty, { borderColor: colors.border }]}>
                <Feather name="inbox" size={36} color={colors.mutedForeground} />
                <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                  No services available yet.
                </Text>
              </View>
            ) : (
              <View style={styles.categoryGrid}>
                {browseCategories.map((cat) => {
                  const catServices = activeServices.filter((s) => s.categoryId === cat.id);
                  const count = catServices.length;
                  const preview = catServices.slice(0, 3);
                  const extra = count - preview.length;
                  return (
                    <TouchableOpacity
                      key={cat.id}
                      style={[styles.categoryCard, { backgroundColor: colors.card, borderColor: colors.border }]}
                      onPress={() => setSelectedCategory(cat.id)}
                      activeOpacity={0.82}
                    >
                      <View style={[styles.categoryCardIcon, { backgroundColor: (cat.color ?? BRAND.redViolet) + "20" }]}>
                        <Feather name={(cat.icon as any) ?? "grid"} size={24} color={cat.color ?? BRAND.redViolet} />
                      </View>
                      <Text style={[styles.categoryCardName, { color: colors.foreground }]} numberOfLines={2}>
                        {cat.name}
                      </Text>
                      <View style={styles.serviceNameList}>
                        {count === 0 ? (
                          <Text style={[styles.serviceNameItem, { color: colors.mutedForeground }]} numberOfLines={1}>
                            Tap to explore
                          </Text>
                        ) : (
                          <>
                            {preview.map((s) => (
                              <Text key={s.id} style={[styles.serviceNameItem, { color: colors.mutedForeground }]} numberOfLines={1}>
                                · {s.title}
                              </Text>
                            ))}
                            {extra > 0 && (
                              <Text style={[styles.serviceNameExtra, { color: cat.color ?? BRAND.redViolet }]}>
                                +{extra} more
                              </Text>
                            )}
                          </>
                        )}
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 20, paddingBottom: 20 },
  headerTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  greeting: { color: "rgba(255,255,255,0.7)", fontSize: 15 },
  userName: { color: "#fff", fontSize: 22, fontWeight: "800" },
  notifBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: "center", justifyContent: "center",
  },
  signInBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.18)",
  },
  signInBtnText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  searchBar: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: "rgba(255,255,255,0.15)",
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
  },
  searchBarText: { color: "rgba(255,255,255,0.6)", fontSize: 15 },
  body: { paddingHorizontal: 16, paddingTop: 20 },
  browseTitle: { fontSize: 22, fontWeight: "800", marginBottom: 12 },
  categoryGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  categoryCard: {
    width: "47%",
    borderRadius: 16,
    borderWidth: 1,
    padding: 18,
    alignItems: "center",
    gap: 10,
  },
  categoryCardIcon: {
    width: 60, height: 60, borderRadius: 18,
    alignItems: "center", justifyContent: "center",
  },
  categoryCardName: { fontSize: 15, fontWeight: "700", textAlign: "center" },
  serviceNameList: { alignSelf: "stretch", gap: 2, marginTop: 2 },
  serviceNameItem: { fontSize: 12, lineHeight: 16 },
  serviceNameExtra: { fontSize: 12, fontWeight: "700", marginTop: 2 },
  backRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    marginBottom: 18, paddingBottom: 16, borderBottomWidth: 1,
  },
  backText: { fontSize: 15, fontWeight: "700" },
  sectionHeader: {
    flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 16,
  },
  catIconWrap: {
    width: 34, height: 34, borderRadius: 10,
    alignItems: "center", justifyContent: "center",
  },
  sectionTitle: { fontSize: 18, fontWeight: "800", flex: 1 },
  countBadge: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 20 },
  countText: { fontSize: 12, fontWeight: "800" },
  empty: {
    alignItems: "center", gap: 12, paddingVertical: 48,
    borderRadius: 16, borderWidth: 1, borderStyle: "dashed",
  },
  emptyText: { fontSize: 15 },
});
