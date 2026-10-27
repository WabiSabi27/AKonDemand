import React, { useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { recordAdminStripePaymentReview, type AdminStripeManualReview, type AdminStripeManualReviewInput } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";

type Outcome = AdminStripeManualReviewInput["outcome"];
const OPTIONS: { value: Outcome; label: string }[] = [
  { value: "needs_follow_up", label: "Needs follow-up" },
  { value: "no_action_needed", label: "No further action needed" },
  { value: "handled_in_stripe", label: "Handled in Stripe" },
];

export function StripeManualReview({ entryId, reviews, onSaved }: {
  entryId: string; reviews: AdminStripeManualReview[]; onSaved: () => void;
}) {
  const colors = useColors();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    if (!outcome || saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await recordAdminStripePaymentReview(entryId, { outcome, ...(note.trim() ? { note: note.trim() } : {}) });
      setNote("");
      setOutcome(null);
      setSaved(true);
      onSaved();
    } catch {
      setError("Could not confirm the review was saved. Refresh the queue before trying again.");
      onSaved();
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <View style={styles.box}>
      <Text style={[styles.title, { color: colors.foreground }]}>Manual review history</Text>
      {!reviews.length && <Text style={{ color: colors.mutedForeground }}>No manual review recorded. Queue status alone does not confirm review.</Text>}
      {reviews.map(review => (
        <View key={review.id} style={[styles.history, { borderColor: colors.border }]}>
          <Text style={[styles.title, { color: colors.foreground }]}>
            {OPTIONS.find(option => option.value === review.outcome)?.label ?? review.outcome}
          </Text>
          <Text selectable style={{ color: colors.mutedForeground }}>
            Reviewed by {review.reviewerName} ({review.reviewerId}){"\n"}
            {new Date(review.reviewedAt).toLocaleString()}
          </Text>
          {review.note && <Text selectable style={{ color: colors.foreground }}>{review.note}</Text>}
        </View>
      ))}
      <Text style={[styles.title, { color: colors.foreground }]}>Record a review</Text>
      <Text style={{ color: colors.mutedForeground }}>Manual record only — this does not refund a payment or dismiss the event. Previous reviews remain on file.</Text>
      {OPTIONS.map(option => (
        <TouchableOpacity key={option.value} accessibilityRole="radio"
          accessibilityState={{ checked: outcome === option.value, disabled: saving }}
          disabled={saving} onPress={() => { setOutcome(option.value); setSaved(false); }}
          style={[styles.choice, { borderColor: outcome === option.value ? "#FFB300" : colors.border,
            backgroundColor: outcome === option.value ? colors.muted : "transparent" }]}>
          <Text style={{ color: colors.foreground }}>{outcome === option.value ? "● " : "○ "}{option.label}</Text>
        </TouchableOpacity>
      ))}
      <Text style={{ color: colors.mutedForeground }}>Optional note (500 characters). Do not include card details, credentials, or personal information.</Text>
      <TextInput accessibilityLabel="Non-sensitive review note" testID={`review-note-${entryId}`}
        value={note} onChangeText={setNote} editable={!saving} multiline maxLength={500}
        placeholder="Non-sensitive operational note" placeholderTextColor={colors.mutedForeground}
        style={[styles.input, { color: colors.foreground, borderColor: colors.border }]} />
      <TouchableOpacity accessibilityRole="button" testID={`save-review-${entryId}`}
        disabled={!outcome || saving} onPress={save}
        style={[styles.choice, { backgroundColor: "#FFB300", opacity: !outcome || saving ? 0.5 : 1 }]}>
        {saving ? <ActivityIndicator color="#0F1B2D" /> : <Text style={styles.title}>Save review record</Text>}
      </TouchableOpacity>
      {error && <Text accessibilityRole="alert" style={{ color: colors.destructive }}>{error}</Text>}
      {saved && <Text accessibilityRole="alert" style={{ color: colors.foreground }}>Review recorded.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 8 },
  title: { fontSize: 13, fontWeight: "700" },
  history: { borderLeftWidth: 2, paddingLeft: 10, gap: 4, paddingVertical: 6 },
  choice: { padding: 10, borderRadius: 8, borderWidth: 1 },
  input: { minHeight: 76, borderWidth: 1, borderRadius: 8, padding: 10, textAlignVertical: "top" },
});
