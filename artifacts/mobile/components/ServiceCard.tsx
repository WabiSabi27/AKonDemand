import { Feather } from "@expo/vector-icons";
import React from "react";
import {
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useColors } from "@/hooks/useColors";
import type { Service } from "@/context/AppContext";

interface ServiceCardProps {
  service: Service;
  onPress: () => void;
  horizontal?: boolean;
}

export function ServiceCard({ service, onPress, horizontal }: ServiceCardProps) {
  const colors = useColors();

  if (horizontal) {
    return (
      <TouchableOpacity
        style={[styles.hCard, { backgroundColor: colors.card, borderColor: colors.border }]}
        onPress={onPress}
        activeOpacity={0.85}
      >
        <View style={[styles.hImagePlaceholder, { backgroundColor: colors.secondary }]}>
          <Feather name="briefcase" size={28} color={colors.accent} />
        </View>
        <View style={styles.hContent}>
          <Text style={[styles.hBusiness, { color: colors.mutedForeground }]} numberOfLines={1}>
            {service.businessName}
          </Text>
          <Text style={[styles.hTitle, { color: colors.foreground }]} numberOfLines={2}>
            {service.title}
          </Text>
          <View style={styles.hMeta}>
            <Feather name="star" size={12} color={colors.star} />
            <Text style={[styles.hRating, { color: colors.foreground }]}>
              {service.rating.toFixed(1)}
            </Text>
            <Text style={[styles.hReviews, { color: colors.mutedForeground }]}>
              ({service.reviewCount})
            </Text>
          </View>
          <Text style={[styles.hPrice, { color: colors.accent }]}>
            From ${service.startingPrice}
          </Text>
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
      onPress={onPress}
      activeOpacity={0.85}
    >
      <View style={[styles.imagePlaceholder, { backgroundColor: colors.secondary }]}>
        <Feather name="briefcase" size={36} color={colors.accent} />
        {service.featured && (
          <View style={[styles.featuredBadge, { backgroundColor: colors.accent }]}>
            <Text style={styles.featuredText}>Featured</Text>
          </View>
        )}
      </View>
      <View style={styles.content}>
        <Text style={[styles.business, { color: colors.mutedForeground }]} numberOfLines={1}>
          {service.businessName}
        </Text>
        <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={2}>
          {service.title}
        </Text>
        <View style={styles.meta}>
          <Feather name="star" size={13} color={colors.star} />
          <Text style={[styles.rating, { color: colors.foreground }]}>
            {service.rating.toFixed(1)}
          </Text>
          <Text style={[styles.reviews, { color: colors.mutedForeground }]}>
            ({service.reviewCount} reviews)
          </Text>
        </View>
        <View style={styles.footer}>
          <Text style={[styles.price, { color: colors.accent }]}>
            From ${service.startingPrice}
          </Text>
          <View style={[styles.bookBtn, { backgroundColor: colors.primary }]}>
            <Text style={[styles.bookBtnText, { color: colors.primaryForeground }]}>Book</Text>
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    borderWidth: 1,
    overflow: "hidden",
    marginBottom: 14,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 8,
    elevation: 2,
  },
  imagePlaceholder: {
    height: 140,
    alignItems: "center",
    justifyContent: "center",
  },
  featuredBadge: {
    position: "absolute",
    top: 12,
    left: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
  },
  featuredText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
  },
  content: {
    padding: 14,
    gap: 4,
  },
  business: {
    fontSize: 12,
    fontWeight: "500",
  },
  title: {
    fontSize: 15,
    fontWeight: "700",
    lineHeight: 20,
  },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 2,
  },
  rating: {
    fontSize: 12,
    fontWeight: "600",
  },
  reviews: {
    fontSize: 12,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 6,
  },
  price: {
    fontSize: 15,
    fontWeight: "700",
  },
  bookBtn: {
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 20,
  },
  bookBtnText: {
    fontSize: 12,
    fontWeight: "700",
  },

  hCard: {
    flexDirection: "row",
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
    marginBottom: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  hImagePlaceholder: {
    width: 90,
    alignItems: "center",
    justifyContent: "center",
  },
  hContent: {
    flex: 1,
    padding: 12,
    gap: 3,
  },
  hBusiness: {
    fontSize: 12,
    fontWeight: "500",
  },
  hTitle: {
    fontSize: 15,
    fontWeight: "700",
    lineHeight: 19,
  },
  hMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  hRating: {
    fontSize: 12,
    fontWeight: "600",
  },
  hReviews: {
    fontSize: 12,
  },
  hPrice: {
    fontSize: 15,
    fontWeight: "700",
    marginTop: 2,
  },
});
