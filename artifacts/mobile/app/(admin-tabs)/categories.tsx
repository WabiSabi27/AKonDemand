import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useState } from "react";
import {
  Alert,
  FlatList,
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

import { Category, useApp } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";

const ICON_OPTIONS = [
  "gift", "wind", "sun", "tool", "scissors", "heart", "settings", "package",
  "truck", "pen-tool", "shield", "home", "git-branch", "cloud-snow", "archive",
  "edit-2", "star", "music", "camera", "coffee", "book", "phone", "globe",
  "activity", "zap", "cpu", "database", "layers", "map",
];

const COLOR_OPTIONS = [
  "#E91E63", "#4FC3F7", "#B39DDB", "#78909C", "#F48FB1", "#E91E8C",
  "#EC407A", "#FF7043", "#29B6F6", "#FF8A65", "#BA68C8", "#8D6E63",
  "#5C6BC0", "#26A69A", "#42A5F5", "#FFB300", "#AB47BC",
];

export default function AdminCategoriesTab() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { categories, services, addCategory, removeCategory } = useApp();
  const topInset = Platform.OS === "web" ? 67 : insets.top;
  const bottomInset = Platform.OS === "web" ? 34 : insets.bottom;

  const [modalVisible, setModalVisible] = useState(false);
  const [newName, setNewName] = useState("");
  const [newIcon, setNewIcon] = useState("star");
  const [newColor, setNewColor] = useState("#AB47BC");
  const [saving, setSaving] = useState(false);

  async function handleAdd() {
    if (!newName.trim()) { Alert.alert("Required", "Please enter a category name."); return; }
    setSaving(true);
    const id = newName.trim().toLowerCase().replace(/\s+/g, "_") + "_" + Date.now();
    const cat: Category = { id, name: newName.trim(), icon: newIcon, color: newColor, serviceCount: 0, active: true };
    await addCategory(cat);
    setSaving(false);
    setModalVisible(false);
    setNewName(""); setNewIcon("star"); setNewColor("#AB47BC");
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }

  function handleRemove(cat: Category) {
    Alert.alert("Deactivate Category", `Hide "${cat.name}" from the app? Businesses using this category will still be listed, but the category won't appear for new bookings.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Deactivate", style: "destructive", onPress: async () => { await removeCategory(cat.id); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); } },
    ]);
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topInset + 16, backgroundColor: "#0F1B2D" }]}>
        <Text style={styles.headerTitle}>Categories</Text>
        <Text style={styles.headerSub}>{categories.length} active</Text>
      </View>

      <FlatList
        data={categories}
        keyExtractor={(item) => item.id}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.list, { paddingBottom: bottomInset + 90 }]}
        ListHeaderComponent={
          <TouchableOpacity
            style={[styles.addCard, { backgroundColor: colors.card, borderColor: "#FFB300" }]}
            onPress={() => setModalVisible(true)}
            activeOpacity={0.85}
          >
            <View style={[styles.addIcon, { backgroundColor: "#FFB30018" }]}>
              <Feather name="plus" size={22} color="#FFB300" />
            </View>
            <Text style={[styles.addText, { color: "#FFB300" }]}>Add New Category</Text>
          </TouchableOpacity>
        }
        renderItem={({ item }) => {
          const svcCount = services.filter((s) => s.categoryId === item.id).length;
          return (
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={[styles.catIcon, { backgroundColor: item.color + "20" }]}>
                <Feather name={item.icon as any} size={20} color={item.color} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.catName, { color: colors.foreground }]}>{item.name}</Text>
                <Text style={[styles.catSub, { color: colors.mutedForeground }]}>{svcCount} service{svcCount !== 1 ? "s" : ""} listed</Text>
              </View>
              <TouchableOpacity
                style={[styles.removeBtn, { backgroundColor: colors.destructive + "18" }]}
                onPress={() => handleRemove(item)}
              >
                <Feather name="eye-off" size={15} color={colors.destructive} />
              </TouchableOpacity>
            </View>
          );
        }}
      />

      <Modal visible={modalVisible} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.modalContainer, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
            <TouchableOpacity onPress={() => setModalVisible(false)}><Feather name="x" size={22} color={colors.foreground} /></TouchableOpacity>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>New Category</Text>
            <TouchableOpacity onPress={handleAdd} disabled={saving}><Text style={[styles.modalSave, { color: "#FFB300", opacity: saving ? 0.5 : 1 }]}>{saving ? "Adding..." : "Add"}</Text></TouchableOpacity>
          </View>
          <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
            <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Category Name *</Text>
            <TextInput style={[styles.fieldInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]} placeholder="e.g. Photography" placeholderTextColor={colors.mutedForeground} value={newName} onChangeText={setNewName} autoFocus />

            <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Icon</Text>
            <View style={styles.iconGrid}>
              {ICON_OPTIONS.map((icon) => (
                <TouchableOpacity key={icon} style={[styles.iconBtn, { backgroundColor: newIcon === icon ? newColor + "30" : colors.card, borderColor: newIcon === icon ? newColor : colors.border }]} onPress={() => setNewIcon(icon)}>
                  <Feather name={icon as any} size={18} color={newIcon === icon ? newColor : colors.mutedForeground} />
                </TouchableOpacity>
              ))}
            </View>

            <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Color</Text>
            <View style={styles.colorGrid}>
              {COLOR_OPTIONS.map((c) => (
                <TouchableOpacity key={c} style={[styles.colorBtn, { backgroundColor: c, borderWidth: newColor === c ? 3 : 0, borderColor: "#fff" }]} onPress={() => setNewColor(c)} />
              ))}
            </View>

            <View style={[styles.preview, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.previewLabel, { color: colors.mutedForeground }]}>Preview</Text>
              <View style={styles.previewRow}>
                <View style={[styles.catIcon, { backgroundColor: newColor + "20" }]}>
                  <Feather name={newIcon as any} size={20} color={newColor} />
                </View>
                <Text style={[styles.catName, { color: colors.foreground }]}>{newName || "Category Name"}</Text>
              </View>
            </View>
            <View style={{ height: 40 }} />
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 20, paddingBottom: 20, gap: 4 },
  headerTitle: { color: "#fff", fontSize: 22, fontWeight: "700" },
  headerSub: { color: "rgba(255,255,255,0.55)", fontSize: 12 },
  list: { padding: 16, gap: 10 },
  addCard: { flexDirection: "row", alignItems: "center", gap: 14, padding: 16, borderRadius: 14, borderWidth: 1.5, borderStyle: "dashed", marginBottom: 4 },
  addIcon: { width: 44, height: 44, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  addText: { fontSize: 15, fontWeight: "700" },
  card: { flexDirection: "row", alignItems: "center", gap: 14, padding: 14, borderRadius: 14, borderWidth: 1 },
  catIcon: { width: 44, height: 44, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  catName: { fontSize: 15, fontWeight: "700" },
  catSub: { fontSize: 12, marginTop: 2 },
  removeBtn: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  modalContainer: { flex: 1 },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16, borderBottomWidth: 1 },
  modalTitle: { fontSize: 18, fontWeight: "800" },
  modalSave: { fontSize: 15, fontWeight: "700" },
  modalBody: { flex: 1, padding: 16 },
  fieldLabel: { fontSize: 12, fontWeight: "600", marginBottom: 10, marginTop: 16 },
  fieldInput: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
  iconGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  iconBtn: { width: 46, height: 46, borderRadius: 12, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  colorGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginBottom: 4 },
  colorBtn: { width: 36, height: 36, borderRadius: 18 },
  preview: { borderRadius: 14, borderWidth: 1, padding: 16, marginTop: 16 },
  previewLabel: { fontSize: 12, fontWeight: "600", marginBottom: 10 },
  previewRow: { flexDirection: "row", alignItems: "center", gap: 12 },
});
