import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import {
  FlatList,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useListServices } from "@workspace/api-client-react";

import { CategoryPill } from "@/components/CategoryPill";
import { ServiceCard } from "@/components/ServiceCard";
import { mapService, useApp } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";
import { BRAND } from "@/constants/colors";

type SortKey = "relevance" | "rating" | "price_asc" | "price_desc";
type MinRating = 0 | 3 | 4 | 4.5;

const SORT_LABELS: Record<SortKey, string> = {
  relevance: "Relevance",
  rating: "Rating",
  price_asc: "Price: Low to High",
  price_desc: "Price: High to Low",
};

export default function SearchScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { categories, services: cachedServices } = useApp();

  // ── Filter state ────────────────────────────────────────────────────
  const [queryInput, setQueryInput] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [minRating, setMinRating] = useState<MinRating>(0);
  const [minPriceText, setMinPriceText] = useState("");
  const [maxPriceText, setMaxPriceText] = useState("");
  const [sort, setSort] = useState<SortKey>("relevance");
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Draft state inside the modal — only committed when "Apply" is tapped so
  // changing a chip doesn't refetch on every tap while the sheet is open.
  const [draftMinRating, setDraftMinRating] = useState<MinRating>(0);
  const [draftMinPrice, setDraftMinPrice] = useState("");
  const [draftMaxPrice, setDraftMaxPrice] = useState("");
  const [draftSort, setDraftSort] = useState<SortKey>("relevance");

  // 300ms debounce on text input. Without it every keystroke would fire a
  // network roundtrip; Juneau dataset is small but the UX still feels jumpy.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(queryInput.trim()), 300);
    return () => clearTimeout(t);
  }, [queryInput]);

  const minPrice = minPriceText.trim() === "" ? undefined : Number(minPriceText);
  const maxPrice = maxPriceText.trim() === "" ? undefined : Number(maxPriceText);

  // Drive the list straight off the server hook so price/rating/sort are
  // applied DB-side. We still feed `cachedServices` through `mapService`-like
  // logic for typing consistency.
  const params = useMemo(
    () => ({
      ...(debouncedQuery ? { q: debouncedQuery } : {}),
      ...(activeCategory ? { categoryId: activeCategory } : {}),
      ...(minRating > 0 ? { minRating } : {}),
      ...(typeof minPrice === "number" && !Number.isNaN(minPrice) ? { minPrice } : {}),
      ...(typeof maxPrice === "number" && !Number.isNaN(maxPrice) ? { maxPrice } : {}),
      ...(sort !== "relevance" ? { sort } : {}),
    }),
    [debouncedQuery, activeCategory, minRating, minPrice, maxPrice, sort],
  );

  // Inherits the global 30s staleTime from QueryClient defaults
  // (`app/_layout.tsx`), so no per-call options needed.
  const servicesQ = useListServices(params);

  const results = useMemo(
    () => (servicesQ.data ?? []).map((s) => mapService(s)),
    [servicesQ.data],
  );

  // ── Active filter chips (commit-state only) ─────────────────────────
  const activeChips: { key: string; label: string; clear: () => void }[] = [];
  if (activeCategory) {
    const cat = categories.find((c) => c.id === activeCategory);
    activeChips.push({
      key: "cat",
      label: cat?.name ?? "Category",
      clear: () => setActiveCategory(null),
    });
  }
  if (minRating > 0) {
    activeChips.push({
      key: "rating",
      label: `${minRating}+ stars`,
      clear: () => setMinRating(0),
    });
  }
  if (typeof minPrice === "number" && !Number.isNaN(minPrice)) {
    activeChips.push({
      key: "minPrice",
      label: `From $${minPrice}`,
      clear: () => setMinPriceText(""),
    });
  }
  if (typeof maxPrice === "number" && !Number.isNaN(maxPrice)) {
    activeChips.push({
      key: "maxPrice",
      label: `Up to $${maxPrice}`,
      clear: () => setMaxPriceText(""),
    });
  }
  if (sort !== "relevance") {
    activeChips.push({
      key: "sort",
      label: SORT_LABELS[sort],
      clear: () => setSort("relevance"),
    });
  }

  function openFilters() {
    setDraftMinRating(minRating);
    setDraftMinPrice(minPriceText);
    setDraftMaxPrice(maxPriceText);
    setDraftSort(sort);
    setFiltersOpen(true);
  }
  function applyFilters() {
    setMinRating(draftMinRating);
    setMinPriceText(draftMinPrice);
    setMaxPriceText(draftMaxPrice);
    setSort(draftSort);
    setFiltersOpen(false);
  }
  function resetDraft() {
    setDraftMinRating(0);
    setDraftMinPrice("");
    setDraftMaxPrice("");
    setDraftSort("relevance");
  }

  const topInset = Platform.OS === "web" ? 67 : insets.top;
  // Keep the cached count for the "All" pill — it's just a hint; not affected
  // by the active filters.
  const allCount = cachedServices.length;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.topBar,
          {
            paddingTop: topInset + 12,
            backgroundColor: colors.card,
            borderBottomColor: colors.border,
          },
        ]}
      >
        <Text style={[styles.title, { color: colors.foreground }]}>Search</Text>
        <View style={styles.searchRow}>
          <View
            style={[
              styles.searchBox,
              { backgroundColor: colors.secondary, borderColor: colors.border },
            ]}
          >
            <Feather name="search" size={16} color={colors.mutedForeground} />
            <TextInput
              style={[styles.input, { color: colors.foreground }]}
              placeholder="Search services, businesses…"
              placeholderTextColor={colors.mutedForeground}
              value={queryInput}
              onChangeText={setQueryInput}
              autoCorrect={false}
            />
            {queryInput.length > 0 && (
              <TouchableOpacity onPress={() => setQueryInput("")}>
                <Feather name="x" size={16} color={colors.mutedForeground} />
              </TouchableOpacity>
            )}
          </View>
          <TouchableOpacity
            onPress={openFilters}
            style={[
              styles.filterBtn,
              {
                backgroundColor: activeChips.length ? BRAND.redViolet : colors.secondary,
                borderColor: colors.border,
              },
            ]}
            activeOpacity={0.85}
          >
            <Feather
              name="sliders"
              size={16}
              color={activeChips.length ? "#fff" : colors.foreground}
            />
            {activeChips.length > 0 && (
              <Text style={styles.filterCount}>{activeChips.length}</Text>
            )}
          </TouchableOpacity>
        </View>
        <FlatList
          data={[
            { id: "all", name: "All", icon: "grid", color: BRAND.redViolet, serviceCount: allCount, active: true },
            ...categories,
          ]}
          keyExtractor={(item) => item.id}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.catRow}
          renderItem={({ item }) => (
            <CategoryPill
              category={item}
              selected={item.id === "all" ? activeCategory === null : activeCategory === item.id}
              onPress={() => setActiveCategory(item.id === "all" ? null : item.id)}
            />
          )}
        />
        {activeChips.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipRow}
          >
            {activeChips.map((c) => (
              <TouchableOpacity
                key={c.key}
                onPress={c.clear}
                style={[styles.chip, { backgroundColor: BRAND.redViolet + "20", borderColor: BRAND.redViolet }]}
                activeOpacity={0.8}
              >
                <Text style={[styles.chipText, { color: BRAND.redViolet }]}>{c.label}</Text>
                <Feather name="x" size={12} color={BRAND.redViolet} />
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
      </View>

      {servicesQ.isLoading ? (
        <View style={styles.empty}>
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>Searching…</Text>
        </View>
      ) : results.length === 0 ? (
        <View style={styles.empty}>
          <Feather name="search" size={40} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No results found</Text>
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
            Try a different search or clear some filters.
          </Text>
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <ServiceCard
              service={item}
              horizontal
              onPress={() =>
                router.push({ pathname: "/service/[id]", params: { id: item.id } })
              }
            />
          )}
          contentContainerStyle={[
            styles.list,
            { paddingBottom: Platform.OS === "web" ? 108 : insets.bottom + 80 },
          ]}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={
            <Text style={[styles.resultsCount, { color: colors.mutedForeground }]}>
              {results.length} {results.length === 1 ? "result" : "results"}
            </Text>
          }
        />
      )}

      <Modal visible={filtersOpen} transparent animationType="slide" onRequestClose={() => setFiltersOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setFiltersOpen(false)}>
          <Pressable
            style={[styles.modalSheet, { backgroundColor: colors.card, paddingBottom: insets.bottom + 16 }]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.modalHandle} />
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>Filters</Text>

            <Text style={[styles.modalLabel, { color: colors.foreground }]}>Minimum rating</Text>
            <View style={styles.modalRow}>
              {([0, 3, 4, 4.5] as MinRating[]).map((r) => (
                <TouchableOpacity
                  key={r}
                  onPress={() => setDraftMinRating(r)}
                  style={[
                    styles.optionChip,
                    {
                      backgroundColor: draftMinRating === r ? BRAND.redViolet : colors.secondary,
                      borderColor: draftMinRating === r ? BRAND.redViolet : colors.border,
                    },
                  ]}
                  activeOpacity={0.85}
                >
                  <Text
                    style={[
                      styles.optionChipText,
                      { color: draftMinRating === r ? "#fff" : colors.foreground },
                    ]}
                  >
                    {r === 0 ? "Any" : `${r}+ ★`}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={[styles.modalLabel, { color: colors.foreground }]}>Price range</Text>
            <View style={styles.priceRow}>
              <View style={[styles.priceInputWrap, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
                <Text style={[styles.priceDollar, { color: colors.mutedForeground }]}>$</Text>
                <TextInput
                  value={draftMinPrice}
                  onChangeText={setDraftMinPrice}
                  placeholder="Min"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="decimal-pad"
                  style={[styles.priceInput, { color: colors.foreground }]}
                />
              </View>
              <Text style={{ color: colors.mutedForeground }}>to</Text>
              <View style={[styles.priceInputWrap, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
                <Text style={[styles.priceDollar, { color: colors.mutedForeground }]}>$</Text>
                <TextInput
                  value={draftMaxPrice}
                  onChangeText={setDraftMaxPrice}
                  placeholder="Max"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="decimal-pad"
                  style={[styles.priceInput, { color: colors.foreground }]}
                />
              </View>
            </View>

            <Text style={[styles.modalLabel, { color: colors.foreground }]}>Sort by</Text>
            <View style={styles.sortCol}>
              {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                <TouchableOpacity
                  key={key}
                  onPress={() => setDraftSort(key)}
                  style={styles.sortRow}
                  activeOpacity={0.85}
                >
                  <View
                    style={[
                      styles.radioOuter,
                      { borderColor: draftSort === key ? BRAND.redViolet : colors.border },
                    ]}
                  >
                    {draftSort === key && <View style={[styles.radioInner, { backgroundColor: BRAND.redViolet }]} />}
                  </View>
                  <Text style={[styles.sortLabel, { color: colors.foreground }]}>{SORT_LABELS[key]}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={styles.modalActions}>
              <TouchableOpacity
                onPress={resetDraft}
                style={[styles.actionBtn, { borderColor: colors.border, backgroundColor: colors.secondary }]}
                activeOpacity={0.85}
              >
                <Text style={[styles.actionBtnText, { color: colors.foreground }]}>Reset</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={applyFilters}
                style={[styles.actionBtn, { backgroundColor: BRAND.redViolet, borderColor: BRAND.redViolet }]}
                activeOpacity={0.85}
              >
                <Text style={[styles.actionBtnText, { color: "#fff" }]}>Apply filters</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  title: {
    fontSize: 28,
    fontWeight: "800",
    marginBottom: 14,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 12,
  },
  searchBox: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 1,
  },
  input: {
    flex: 1,
    fontSize: 15,
    padding: 0,
  },
  filterBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 1,
  },
  filterCount: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "800",
    minWidth: 14,
    textAlign: "center",
  },
  catRow: {
    paddingRight: 20,
    paddingBottom: 4,
  },
  chipRow: {
    paddingTop: 8,
    paddingRight: 20,
    gap: 6,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
    marginRight: 6,
  },
  chipText: { fontSize: 12, fontWeight: "700" },
  list: {
    paddingHorizontal: 20,
    paddingTop: 16,
  },
  resultsCount: {
    fontSize: 12,
    marginBottom: 10,
    fontWeight: "500",
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 40,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "700",
  },
  emptyText: {
    fontSize: 15,
    textAlign: "center",
    lineHeight: 20,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    paddingHorizontal: 20,
    paddingTop: 8,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
  },
  modalHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(0,0,0,0.18)",
    alignSelf: "center",
    marginBottom: 14,
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: "800",
    marginBottom: 18,
  },
  modalLabel: {
    fontSize: 15,
    fontWeight: "700",
    marginBottom: 10,
    marginTop: 4,
  },
  modalRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 18,
  },
  optionChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    borderWidth: 1,
  },
  optionChipText: { fontSize: 12, fontWeight: "700" },
  priceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 18,
  },
  priceInputWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
  },
  priceDollar: { fontSize: 15 },
  priceInput: { flex: 1, fontSize: 15, padding: 0 },
  sortCol: { gap: 10, marginBottom: 18 },
  sortRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 4 },
  radioOuter: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  radioInner: { width: 10, height: 10, borderRadius: 5 },
  sortLabel: { fontSize: 15, fontWeight: "600" },
  modalActions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: "center",
  },
  actionBtnText: { fontSize: 15, fontWeight: "800" },
});
