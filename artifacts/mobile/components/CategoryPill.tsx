import { Feather } from "@expo/vector-icons";
import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useColors } from "@/hooks/useColors";
import type { Category } from "@/context/AppContext";

interface CategoryPillProps {
  category: Category;
  selected?: boolean;
  onPress: () => void;
  showCount?: boolean;
}

export function CategoryPill({ category, selected, onPress, showCount }: CategoryPillProps) {
  const colors = useColors();

  return (
    <TouchableOpacity
      style={[
        styles.pill,
        {
          backgroundColor: selected ? colors.primary : colors.card,
          borderColor: selected ? colors.primary : colors.border,
        },
      ]}
      onPress={onPress}
      activeOpacity={0.8}
    >
      <Feather
        name={category.icon as any}
        size={15}
        color={selected ? "#fff" : category.color}
      />
      <Text
        style={[
          styles.label,
          { color: selected ? "#fff" : colors.foreground },
        ]}
      >
        {category.name}
      </Text>
      {showCount && (
        <View
          style={[
            styles.count,
            { backgroundColor: selected ? "rgba(255,255,255,0.2)" : colors.secondary },
          ]}
        >
          <Text
            style={[styles.countText, { color: selected ? "#fff" : colors.mutedForeground }]}
          >
            {category.serviceCount}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 24,
    borderWidth: 1,
    gap: 6,
    marginRight: 8,
  },
  label: {
    fontSize: 12,
    fontWeight: "600",
  },
  count: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 10,
  },
  countText: {
    fontSize: 12,
    fontWeight: "600",
  },
});
