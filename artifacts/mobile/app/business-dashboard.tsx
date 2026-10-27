import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import React, { useState } from "react";
import {
  Alert,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp } from "@/context/AppContext";
import type { Service, ServiceOption } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";
import { ScreenHeader } from "@/components/ScreenHeader";

const PLAN_COLORS: Record<string, string> = {
  starter_gigger: "#5C6BC0",
  pro_business: "#FFB300",
};

function StatCard({ label, value, icon, color }: { label: string; value: string; icon: string; color: string }) {
  const colors = useColors();
  return (
    <View style={[statStyles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={[statStyles.icon, { backgroundColor: color + "18" }]}>
        <Feather name={icon as any} size={18} color={color} />
      </View>
      <Text style={[statStyles.value, { color: colors.foreground }]}>{value}</Text>
      <Text style={[statStyles.label, { color: colors.mutedForeground }]}>{label}</Text>
    </View>
  );
}

const statStyles = StyleSheet.create({
  card: { flex: 1, borderRadius: 14, borderWidth: 1, padding: 14, alignItems: "center", gap: 6 },
  icon: { width: 38, height: 38, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  value: { fontSize: 22, fontWeight: "800" },
  label: { fontSize: 12, fontWeight: "600", textAlign: "center" },
});

interface ServiceFormOption {
  name: string;
  description: string;
  price: string;
  duration: string;
}

const emptyOption = (): ServiceFormOption => ({ name: "", description: "", price: "", duration: "" });

export default function BusinessDashboardScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user, updateUser, services, bookings, businesses, categories, addService, updateService, deleteService, addBusiness } = useApp();
  const topInset = Platform.OS === "web" ? 67 : insets.top;
  const bottomInset = Platform.OS === "web" ? 34 : insets.bottom;

  const myBusiness = businesses.find((b) => b.ownerId === user?.id);
  const myServices = services.filter((s) => s.businessId === myBusiness?.id);
  const myBookings = bookings.filter((b) => b.businessId === myBusiness?.id);

  const totalRevenue = myBookings
    .filter((b) => b.status !== "cancelled")
    .reduce((sum, b) => sum + (b.price - b.platformFee), 0);

  const pendingBookings = myBookings.filter((b) => b.status === "pending" || b.status === "confirmed");

  // --- Add/Edit Service Modal ---
  const [modalVisible, setModalVisible] = useState(false);
  const [editingService, setEditingService] = useState<Service | null>(null);
  const [formTitle, setFormTitle] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formCategoryId, setFormCategoryId] = useState(categories[0]?.id ?? "");
  const [formOptions, setFormOptions] = useState<ServiceFormOption[]>([emptyOption()]);
  const [saving, setSaving] = useState(false);

  // --- Setup Business Modal ---
  const [setupVisible, setSetupVisible] = useState(false);
  const [bizName, setBizName] = useState("");
  const [bizDesc, setBizDesc] = useState("");
  const [bizPhone, setBizPhone] = useState("");
  const [bizLocation, setBizLocation] = useState("");
  const [settingUp, setSettingUp] = useState(false);

  function openAddModal() {
    setEditingService(null);
    setFormTitle("");
    setFormDescription("");
    setFormCategoryId(categories[0]?.id ?? "");
    setFormOptions([emptyOption()]);
    setModalVisible(true);
  }

  function openEditModal(service: Service) {
    setEditingService(service);
    setFormTitle(service.title);
    setFormDescription(service.description);
    setFormCategoryId(service.categoryId);
    setFormOptions(
      service.options.map((o) => ({
        name: o.name,
        description: o.description,
        price: String(o.price),
        duration: o.duration,
      }))
    );
    setModalVisible(true);
    Haptics.selectionAsync();
  }

  function addOption() {
    setFormOptions([...formOptions, emptyOption()]);
  }

  function removeOption(idx: number) {
    if (formOptions.length === 1) return;
    setFormOptions(formOptions.filter((_, i) => i !== idx));
  }

  function updateOption(idx: number, field: keyof ServiceFormOption, value: string) {
    setFormOptions(formOptions.map((o, i) => (i === idx ? { ...o, [field]: value } : o)));
  }

  async function handleSave() {
    if (!formTitle.trim()) {
      Alert.alert("Required", "Please enter a service title.");
      return;
    }
    if (!myBusiness) return;
    const validOptions = formOptions.filter((o) => o.name.trim() && o.price.trim());
    if (validOptions.length === 0) {
      Alert.alert("Required", "Add at least one pricing option with a name and price.");
      return;
    }

    setSaving(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    const options: ServiceOption[] = validOptions.map((o, i) => ({
      id: editingService?.options[i]?.id ?? `${Date.now()}_${i}`,
      name: o.name.trim(),
      description: o.description.trim(),
      price: parseFloat(o.price) || 0,
      duration: o.duration.trim() || "TBD",
    }));

    const startingPrice = Math.min(...options.map((o) => o.price));

    if (editingService) {
      await updateService({
        ...editingService,
        title: formTitle.trim(),
        description: formDescription.trim(),
        categoryId: formCategoryId,
        options,
        startingPrice,
      });
    } else {
      const newService: Service = {
        id: `svc_${Date.now()}`,
        businessId: myBusiness.id,
        businessName: myBusiness.name,
        categoryId: formCategoryId,
        title: formTitle.trim(),
        description: formDescription.trim(),
        rating: 0,
        reviewCount: 0,
        startingPrice,
        options,
        tags: [],
        featured: false,
        reviews: [],
      };
      await addService(newService);
    }

    setSaving(false);
    setModalVisible(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }

  function handleDelete(service: Service) {
    Alert.alert(
      "Delete Service",
      `Are you sure you want to delete "${service.title}"? This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            await deleteService(service.id);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          },
        },
      ]
    );
  }

  async function handleSetupBusiness() {
    if (!bizName.trim()) {
      Alert.alert("Required", "Please enter your business name.");
      return;
    }
    if (!user) return;
    setSettingUp(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    const newBusiness = {
      id: `biz_${Date.now()}`,
      ownerId: user.id,
      name: bizName.trim(),
      description: bizDesc.trim(),
      categoryId: categories[0]?.id ?? "cleaning",
      rating: 0,
      reviewCount: 0,
      subscriptionActive: true,
      subscriptionPlan: "starter_gigger" as const,
      phone: bizPhone.trim(),
      location: bizLocation.trim(),
      joinedDate: new Date().toISOString().split("T")[0],
      serviceCount: 0,
      stripeAccountStatus: "none" as const,
      stripePayoutsEnabled: false,
      cancellationFullRefundHours: 24,
      cancellationPartialRefundHours: 2,
      cancellationPartialRefundPercent: 50,
    };

    await addBusiness(newBusiness);
    // updateUser merges into existing User; equivalent to the old setUser(full) call.
    await updateUser({ role: "business", businessId: newBusiness.id });
    setSettingUp(false);
    setSetupVisible(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }

  // If not a business user yet, show setup prompt
  if (!myBusiness) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <ScreenHeader title="Business Dashboard" />
        <View style={styles.emptyCenter}>
          <View style={[styles.emptyIcon, { backgroundColor: colors.accent + "18" }]}>
            <Feather name="briefcase" size={40} color={colors.accent} />
          </View>
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Set Up Your Business</Text>
          <Text style={[styles.emptyDesc, { color: colors.mutedForeground }]}>
            Create your business profile to start adding services and accepting bookings.
          </Text>
          <TouchableOpacity
            style={[styles.setupBtn, { backgroundColor: colors.primary }]}
            onPress={() => setSetupVisible(true)}
            activeOpacity={0.85}
          >
            <Text style={[styles.setupBtnText, { color: colors.primaryForeground }]}>Create Business Profile</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.portalBtn, { borderColor: colors.border }]}
            onPress={() => router.push("/business-portal")}
            activeOpacity={0.85}
          >
            <Text style={[styles.portalBtnText, { color: colors.accent }]}>View Subscription Plans</Text>
          </TouchableOpacity>
        </View>

        {/* Setup Modal */}
        <Modal visible={setupVisible} animationType="slide" presentationStyle="pageSheet">
          <View style={[styles.modalContainer, { backgroundColor: colors.background }]}>
            <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
              <TouchableOpacity onPress={() => setSetupVisible(false)}>
                <Feather name="x" size={22} color={colors.foreground} />
              </TouchableOpacity>
              <Text style={[styles.modalTitle, { color: colors.foreground }]}>Create Business Profile</Text>
              <TouchableOpacity onPress={handleSetupBusiness} disabled={settingUp}>
                <Text style={[styles.modalSave, { color: colors.accent, opacity: settingUp ? 0.5 : 1 }]}>
                  {settingUp ? "Saving..." : "Create"}
                </Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Business Name *</Text>
              <TextInput
                style={[styles.fieldInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
                placeholder="e.g. ABC Cleaning Co."
                placeholderTextColor={colors.mutedForeground}
                value={bizName}
                onChangeText={setBizName}
              />
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Description</Text>
              <TextInput
                style={[styles.fieldInput, styles.textArea, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
                placeholder="Tell customers what makes your business special..."
                placeholderTextColor={colors.mutedForeground}
                value={bizDesc}
                onChangeText={setBizDesc}
                multiline
                numberOfLines={3}
              />
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Phone Number</Text>
              <TextInput
                style={[styles.fieldInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
                placeholder="+1 555-0100"
                placeholderTextColor={colors.mutedForeground}
                value={bizPhone}
                onChangeText={setBizPhone}
                keyboardType="phone-pad"
              />
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Service Area / Location</Text>
              <TextInput
                style={[styles.fieldInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
                placeholder="e.g. Downtown, Metro area"
                placeholderTextColor={colors.mutedForeground}
                value={bizLocation}
                onChangeText={setBizLocation}
              />
            </ScrollView>
          </View>
        </Modal>
      </View>
    );
  }

  const planColor = PLAN_COLORS[myBusiness.subscriptionPlan] ?? colors.accent;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: bottomInset + 24 }}
      >
        {/* Header */}
        <ScreenHeader title={myBusiness.name} subtitle={`${myBusiness.subscriptionPlan.toUpperCase()} plan`} />
        <View style={styles.subActionRow}>
          <TouchableOpacity
            style={[styles.subActionBtn, { borderColor: colors.border, backgroundColor: colors.card }]}
            onPress={() => router.push("/business-portal")}
            activeOpacity={0.85}
          >
            <Feather name="settings" size={14} color={colors.foreground} />
            <Text style={[styles.subActionText, { color: colors.foreground }]}>Subscription</Text>
          </TouchableOpacity>
        </View>

        {/* Stats */}
        <View style={styles.statsRow}>
          <StatCard label="Services" value={String(myServices.length)} icon="list" color={colors.accent} />
          <StatCard label="Bookings" value={String(myBookings.length)} icon="calendar" color="#5C6BC0" />
          <StatCard label="Earned" value={`$${totalRevenue.toFixed(0)}`} icon="dollar-sign" color="#FFB300" />
        </View>

        {/* Pending Bookings */}
        {pendingBookings.length > 0 && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>
              Pending Bookings
              <Text style={{ color: colors.accent }}> ({pendingBookings.length})</Text>
            </Text>
            {pendingBookings.map((booking) => (
              <View
                key={booking.id}
                style={[styles.bookingCard, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <View style={styles.bookingRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.bookingTitle, { color: colors.foreground }]}>{booking.serviceTitle}</Text>
                    <Text style={[styles.bookingMeta, { color: colors.mutedForeground }]}>
                      {booking.optionName} · {new Date(booking.scheduledDate).toLocaleDateString()}
                    </Text>
                  </View>
                  <View style={{ alignItems: "flex-end", gap: 6 }}>
                    <Text style={[styles.bookingPrice, { color: colors.foreground }]}>
                      ${booking.price.toFixed(2)}
                    </Text>
                    <View style={[styles.statusBadge, { backgroundColor: booking.status === "confirmed" ? colors.accent + "20" : "#FFB30020" }]}>
                      <Text style={[styles.statusText, { color: booking.status === "confirmed" ? colors.accent : "#FFB300" }]}>
                        {booking.status}
                      </Text>
                    </View>
                  </View>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* Services */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>My Services</Text>
            <TouchableOpacity
              style={[styles.addBtn, { backgroundColor: colors.accent }]}
              onPress={openAddModal}
              activeOpacity={0.85}
            >
              <Feather name="plus" size={15} color="#fff" />
              <Text style={styles.addBtnText}>Add Service</Text>
            </TouchableOpacity>
          </View>

          {myServices.length === 0 ? (
            <TouchableOpacity
              style={[styles.emptyServices, { backgroundColor: colors.card, borderColor: colors.border }]}
              onPress={openAddModal}
              activeOpacity={0.85}
            >
              <Feather name="plus-circle" size={32} color={colors.accent} />
              <Text style={[styles.emptyServicesTitle, { color: colors.foreground }]}>Add Your First Service</Text>
              <Text style={[styles.emptyServicesDesc, { color: colors.mutedForeground }]}>
                Customers will be able to find and book your services directly in the app.
              </Text>
            </TouchableOpacity>
          ) : (
            myServices.map((service) => (
              <View
                key={service.id}
                style={[styles.serviceCard, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <View style={styles.serviceRow}>
                  <View style={[styles.serviceIcon, { backgroundColor: colors.accent + "18" }]}>
                    <Feather name="briefcase" size={18} color={colors.accent} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.serviceTitle, { color: colors.foreground }]}>{service.title}</Text>
                    <Text style={[styles.serviceMeta, { color: colors.mutedForeground }]}>
                      {service.options.length} option{service.options.length !== 1 ? "s" : ""} · from ${service.startingPrice}
                    </Text>
                  </View>
                  <View style={styles.serviceActions}>
                    <TouchableOpacity
                      style={[styles.actionBtn, { backgroundColor: colors.secondary }]}
                      onPress={() => openEditModal(service)}
                    >
                      <Feather name="edit-2" size={14} color={colors.foreground} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.actionBtn, { backgroundColor: colors.destructive + "18" }]}
                      onPress={() => handleDelete(service)}
                    >
                      <Feather name="trash-2" size={14} color={colors.destructive} />
                    </TouchableOpacity>
                  </View>
                </View>
                {service.options.slice(0, 2).map((opt) => (
                  <View key={opt.id} style={[styles.optionPill, { backgroundColor: colors.secondary }]}>
                    <Text style={[styles.optionPillText, { color: colors.mutedForeground }]}>
                      {opt.name} — ${opt.price} · {opt.duration}
                    </Text>
                  </View>
                ))}
                {service.options.length > 2 && (
                  <Text style={[styles.moreOptions, { color: colors.mutedForeground }]}>
                    +{service.options.length - 2} more option{service.options.length - 2 !== 1 ? "s" : ""}
                  </Text>
                )}
              </View>
            ))
          )}
        </View>

        {/* All Bookings */}
        {myBookings.length > 0 && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>All Bookings</Text>
            {myBookings.slice(0, 10).map((booking) => (
              <View
                key={booking.id}
                style={[styles.bookingCard, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <View style={styles.bookingRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.bookingTitle, { color: colors.foreground }]}>{booking.serviceTitle}</Text>
                    <Text style={[styles.bookingMeta, { color: colors.mutedForeground }]}>
                      {new Date(booking.scheduledDate).toLocaleDateString()} · You earn ${(booking.price - booking.platformFee).toFixed(2)}
                    </Text>
                  </View>
                  <View style={[styles.statusBadge, {
                    backgroundColor:
                      booking.status === "completed" ? "#B39DDB20" :
                      booking.status === "cancelled" ? colors.destructive + "20" :
                      colors.accent + "20"
                  }]}>
                    <Text style={[styles.statusText, {
                      color:
                        booking.status === "completed" ? "#B39DDB" :
                        booking.status === "cancelled" ? colors.destructive :
                        colors.accent
                    }]}>
                      {booking.status}
                    </Text>
                  </View>
                </View>
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {/* Add / Edit Service Modal */}
      <Modal visible={modalVisible} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.modalContainer, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
            <TouchableOpacity onPress={() => setModalVisible(false)}>
              <Feather name="x" size={22} color={colors.foreground} />
            </TouchableOpacity>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>
              {editingService ? "Edit Service" : "Add Service"}
            </Text>
            <TouchableOpacity onPress={handleSave} disabled={saving}>
              <Text style={[styles.modalSave, { color: colors.accent, opacity: saving ? 0.5 : 1 }]}>
                {saving ? "Saving..." : "Save"}
              </Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
            <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Service Title *</Text>
            <TextInput
              style={[styles.fieldInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
              placeholder="e.g. Deep Home Cleaning"
              placeholderTextColor={colors.mutedForeground}
              value={formTitle}
              onChangeText={setFormTitle}
            />

            <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Description</Text>
            <TextInput
              style={[styles.fieldInput, styles.textArea, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
              placeholder="Describe what's included in this service..."
              placeholderTextColor={colors.mutedForeground}
              value={formDescription}
              onChangeText={setFormDescription}
              multiline
              numberOfLines={3}
            />

            <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Category</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.categoryScroll}>
              {categories.map((cat) => (
                <TouchableOpacity
                  key={cat.id}
                  style={[
                    styles.categoryChip,
                    {
                      backgroundColor: formCategoryId === cat.id ? colors.accent : colors.card,
                      borderColor: formCategoryId === cat.id ? colors.accent : colors.border,
                    },
                  ]}
                  onPress={() => {
                    setFormCategoryId(cat.id);
                    Haptics.selectionAsync();
                  }}
                >
                  <Text style={[styles.categoryChipText, { color: formCategoryId === cat.id ? "#fff" : colors.foreground }]}>
                    {cat.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <View style={styles.optionsSectionHeader}>
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground, marginBottom: 0 }]}>Pricing Options *</Text>
              <TouchableOpacity onPress={addOption}>
                <Text style={[styles.addOptionText, { color: colors.accent }]}>+ Add Option</Text>
              </TouchableOpacity>
            </View>

            {formOptions.map((opt, idx) => (
              <View key={idx} style={[styles.optionBlock, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.optionBlockHeader}>
                  <Text style={[styles.optionBlockTitle, { color: colors.foreground }]}>Option {idx + 1}</Text>
                  {formOptions.length > 1 && (
                    <TouchableOpacity onPress={() => removeOption(idx)}>
                      <Feather name="trash-2" size={15} color={colors.destructive} />
                    </TouchableOpacity>
                  )}
                </View>
                <TextInput
                  style={[styles.optionInput, { borderColor: colors.border, color: colors.foreground }]}
                  placeholder="Option name (e.g. Small, Basic, 1-2 Bedroom)"
                  placeholderTextColor={colors.mutedForeground}
                  value={opt.name}
                  onChangeText={(v) => updateOption(idx, "name", v)}
                />
                <TextInput
                  style={[styles.optionInput, { borderColor: colors.border, color: colors.foreground }]}
                  placeholder="Short description (optional)"
                  placeholderTextColor={colors.mutedForeground}
                  value={opt.description}
                  onChangeText={(v) => updateOption(idx, "description", v)}
                />
                <View style={styles.optionRow}>
                  <View style={{ flex: 1 }}>
                    <TextInput
                      style={[styles.optionInput, { borderColor: colors.border, color: colors.foreground }]}
                      placeholder="Price ($)"
                      placeholderTextColor={colors.mutedForeground}
                      value={opt.price}
                      onChangeText={(v) => updateOption(idx, "price", v)}
                      keyboardType="decimal-pad"
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <TextInput
                      style={[styles.optionInput, { borderColor: colors.border, color: colors.foreground }]}
                      placeholder="Duration (e.g. 2 hrs)"
                      placeholderTextColor={colors.mutedForeground}
                      value={opt.duration}
                      onChangeText={(v) => updateOption(idx, "duration", v)}
                    />
                  </View>
                </View>
              </View>
            ))}

            <View style={{ height: 40 }} />
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  subActionRow: { flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: 16, paddingTop: 12 },
  subActionBtn: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  subActionText: { fontSize: 13, fontWeight: "600" },
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 20,
    gap: 12,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  headerMeta: { flex: 1, gap: 4 },
  headerTitle: { color: "#fff", fontSize: 18, fontWeight: "800" },
  planBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  planBadgeText: { color: "#fff", fontSize: 12, fontWeight: "800", letterSpacing: 0.5 },
  statsRow: { flexDirection: "row", gap: 10, padding: 16 },
  section: { paddingHorizontal: 16, marginBottom: 8 },
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  sectionTitle: { fontSize: 18, fontWeight: "800", marginBottom: 12 },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 10,
  },
  addBtnText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  emptyServices: {
    borderRadius: 16,
    borderWidth: 1.5,
    borderStyle: "dashed",
    padding: 32,
    alignItems: "center",
    gap: 10,
  },
  emptyServicesTitle: { fontSize: 15, fontWeight: "700" },
  emptyServicesDesc: { fontSize: 12, textAlign: "center", lineHeight: 19 },
  serviceCard: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    marginBottom: 10,
    gap: 8,
  },
  serviceRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  serviceIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  serviceTitle: { fontSize: 15, fontWeight: "700" },
  serviceMeta: { fontSize: 12, marginTop: 2 },
  serviceActions: { flexDirection: "row", gap: 8 },
  actionBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  optionPill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    alignSelf: "flex-start",
  },
  optionPillText: { fontSize: 12 },
  moreOptions: { fontSize: 12, marginTop: 2 },
  bookingCard: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    marginBottom: 8,
  },
  bookingRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  bookingTitle: { fontSize: 15, fontWeight: "700" },
  bookingMeta: { fontSize: 12, marginTop: 2 },
  bookingPrice: { fontSize: 15, fontWeight: "700" },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  statusText: { fontSize: 12, fontWeight: "700", textTransform: "capitalize" },
  emptyCenter: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 12 },
  emptyIcon: { width: 80, height: 80, borderRadius: 24, alignItems: "center", justifyContent: "center" },
  emptyTitle: { fontSize: 22, fontWeight: "800" },
  emptyDesc: { fontSize: 15, textAlign: "center", lineHeight: 21 },
  setupBtn: { paddingHorizontal: 28, paddingVertical: 14, borderRadius: 14, marginTop: 8 },
  setupBtnText: { fontSize: 15, fontWeight: "800" },
  portalBtn: { paddingHorizontal: 28, paddingVertical: 12, borderRadius: 14, borderWidth: 1 },
  portalBtnText: { fontSize: 15, fontWeight: "700" },
  // Modal
  modalContainer: { flex: 1 },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    borderBottomWidth: 1,
  },
  modalTitle: { fontSize: 18, fontWeight: "800" },
  modalSave: { fontSize: 15, fontWeight: "700" },
  modalBody: { flex: 1, padding: 16 },
  fieldLabel: { fontSize: 12, fontWeight: "600", marginBottom: 6, marginTop: 14, letterSpacing: 0.3 },
  fieldInput: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  textArea: { height: 80, textAlignVertical: "top" },
  categoryScroll: { marginBottom: 4 },
  categoryChip: {
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 7,
    marginRight: 8,
  },
  categoryChipText: { fontSize: 12, fontWeight: "600" },
  optionsSectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 14,
    marginBottom: 8,
  },
  addOptionText: { fontSize: 15, fontWeight: "700" },
  optionBlock: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    marginBottom: 10,
    gap: 8,
  },
  optionBlockHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  optionBlockTitle: { fontSize: 12, fontWeight: "700" },
  optionInput: {
    borderBottomWidth: 1,
    paddingVertical: 8,
    fontSize: 15,
  },
  optionRow: { flexDirection: "row", gap: 12 },
});
